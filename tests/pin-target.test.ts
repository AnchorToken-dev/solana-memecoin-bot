import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { createControlApp } from "../src/api/server.js";
import { isSolanaMint, parseSolanaMintInput } from "../src/target/solanaMint.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";
import type { Server } from "node:http";

const WSOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function baseCfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true,
    bankrollUsd: 100,
    maxOpenTrades: 1,
    stopLossPct: 10,
    takeProfitPct: 25,
    positionSizePct: 0.5,
    maxPositionUsd: 25,
    momentum: {
      minPct: 8,
      windowMinutes: 5,
      volumeSpikeMult: 2,
      minLiquidityUsd: 15_000,
      minVolume24hUsd: 25_000,
      minAgeMinutes: 3,
    },
    trailingTakeProfit: { activatePct: 15, distancePct: 5 },
    paperBroker: { slippageBps: 50, feeBps: 30 },
    runner: { pollIntervalMs: 30, scanLimit: 5, maxCycles: 1 },
    maxHoldMinutes: 0,
    dailyLossUsd: 0,
    chaseLockoutHours: 0,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "custom",
    requireChecklistGo: false,
    ...over,
  };
}

function snap(mint: string, symbol: string, price = 0.001): TokenSnapshot {
  const now = Date.now();
  return {
    mint,
    symbol,
    name: symbol,
    priceUsd: price,
    changeWindowPct: 20,
    volumeWindowUsd: 10_000,
    volumeAvgUsd: 1_000,
    volume24hUsd: 100_000,
    liquidityUsd: 50_000,
    timestamp: now,
    createdAt: now - 60 * 60_000,
  };
}

class BoardMarket implements MarketDataProvider {
  scanCalls = 0;
  lookupCalls = 0;
  constructor(
    private readonly board: TokenSnapshot[],
    private readonly pinned: TokenSnapshot | null,
    private readonly marks: Record<string, number> = {},
  ) {}
  async scan(_limit: number): Promise<TokenSnapshot[]> {
    this.scanCalls += 1;
    return this.board;
  }
  async lookup(mint: string): Promise<TokenSnapshot | null> {
    this.lookupCalls += 1;
    if (!this.pinned || this.pinned.mint !== mint) return null;
    return this.pinned;
  }
  async getPrice(mint: string): Promise<number | null> {
    if (mint in this.marks) return this.marks[mint]!;
    if (this.pinned?.mint === mint) return this.pinned.priceUsd;
    return this.board.find((s) => s.mint === mint)?.priceUsd ?? null;
  }
}

async function waitStopped(engine: BotEngine, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (engine.getStatus().state === "stopped") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`runner did not stop; state=${engine.getStatus().state}`);
}

describe("solana mint parse", () => {
  it("accepts real mints and rejects junk", () => {
    assert.equal(isSolanaMint(WSOL), true);
    assert.equal(isSolanaMint(USDC), true);
    assert.equal(isSolanaMint("hello"), false);
    assert.equal(isSolanaMint("0OIl"), false);
    assert.equal(parseSolanaMintInput("  " + WSOL + "  ").ok, true);
    const link = parseSolanaMintInput(
      `https://pump.fun/coin/${USDC}`,
    );
    assert.equal(link.ok, true);
    if (link.ok) assert.equal(link.mint, USDC);
    const junk = parseSolanaMintInput("not a coin please");
    assert.equal(junk.ok, false);
    if (!junk.ok) assert.match(junk.message, /doesn't look like a Solana coin address/);
  });
});

describe("single-coin pin", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "pin-target-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("valid pin, invalid rejected, clear returns to hunt", async () => {
    const sub = join(dir, "api");
    const cfg = baseCfg({ ledgerDir: sub, runner: { pollIntervalMs: 50, scanLimit: 5, maxCycles: 0 } });
    const hunt = snap("HuntMintNotARealAddressButSelectorOnly000", "HUNT");
    const market = new BoardMarket([hunt], snap(WSOL, "WSOL"));
    const engine = new BotEngine(cfg, {
      ledger: new PaperLedger(cfg.bankrollUsd, sub),
      broker: new PaperBroker(cfg),
      market,
    });
    const app = createControlApp(engine);
    const server: Server = await new Promise((resolve, reject) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
      s.on("error", reject);
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const bad = await fetch(`${base}/target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mint: "hello world" }),
      });
      assert.equal(bad.status, 400);
      const badBody = (await bad.json()) as { ok: boolean; message: string };
      assert.equal(badBody.ok, false);
      assert.match(badBody.message, /doesn't look like a Solana coin address/);
      assert.equal(engine.getStatus().pinnedMint, null);

      const good = await fetch(`${base}/target`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mint: `  ${WSOL}  ` }),
      });
      assert.equal(good.status, 200);
      const goodBody = (await good.json()) as { ok: boolean; mint: string; mode: string };
      assert.equal(goodBody.ok, true);
      assert.equal(goodBody.mint, WSOL);
      assert.equal(goodBody.mode, "pinned");
      assert.equal(engine.getStatus().pinnedMint, WSOL);

      const snaps = await engine.selectEntrySnapshots();
      assert.equal(snaps.length, 1);
      assert.equal(snaps[0]!.mint, WSOL);
      assert.equal(market.scanCalls, 0);
      assert.equal(market.lookupCalls, 1);

      const cleared = await fetch(`${base}/target`, { method: "DELETE" });
      assert.equal(cleared.status, 200);
      const clearedBody = (await cleared.json()) as { ok: boolean; mode: string; message: string };
      assert.equal(clearedBody.ok, true);
      assert.equal(clearedBody.mode, "hunt");
      assert.match(clearedBody.message, /hunting/i);
      assert.equal(engine.getStatus().pinnedMint, null);

      const hunted = await engine.selectEntrySnapshots();
      assert.equal(hunted.length, 1);
      assert.equal(hunted[0]!.symbol, "HUNT");
      assert.equal(market.scanCalls, 1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
      });
    }
  });

  it("cycle trades the pinned mint, not the hunt board", async () => {
    const sub = join(dir, "cycle");
    const cfg = baseCfg({ ledgerDir: sub, maxOpenTrades: 1 });
    const hunt = snap(USDC, "HUNT", 0.002);
    const pinned = snap(WSOL, "PIN", 0.001);
    const market = new BoardMarket([hunt, pinned], pinned);
    const ledger = new PaperLedger(cfg.bankrollUsd, sub);
    const engine = new BotEngine(cfg, {
      ledger,
      broker: new PaperBroker(cfg),
      market,
    });
    const set = engine.setPinnedMint({ mint: WSOL });
    assert.equal(set.ok, true);

    const started = await engine.start();
    assert.equal(started.ok, true);
    await waitStopped(engine);

    assert.equal(ledger.openPositions.length, 1);
    assert.equal(ledger.openPositions[0]!.mint, WSOL);
    assert.equal(ledger.openPositions[0]!.symbol, "PIN");
    assert.equal(market.scanCalls, 0, "pin must not scan the board");
    assert.ok(market.lookupCalls >= 1);
  });

  it("does not force-close a different open coin when pinning", async () => {
    const sub = join(dir, "open");
    const cfg = baseCfg({
      ledgerDir: sub,
      maxOpenTrades: 2,
      maxHoldMinutes: 0,
    });
    const otherMint = USDC;
    const pinned = snap(WSOL, "PIN", 0.001);
    const hunt = snap("DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", "HUNT", 0.004);
    const market = new BoardMarket([hunt], pinned, { [otherMint]: 1 });
    const ledger = new PaperLedger(cfg.bankrollUsd, sub);
    const broker = new PaperBroker(cfg);
    const engine = new BotEngine(cfg, { ledger, broker, market });
    const { fill, position } = broker.applyBuy({
      mint: otherMint,
      symbol: "OPEN",
      markPrice: 1,
      notionalUsd: 10,
    });
    ledger.recordBuy(fill, position);

    const set = engine.setPinnedMint({ mint: WSOL });
    assert.equal(set.ok, true);
    assert.match(set.message, /stays open/i);
    assert.equal(ledger.openPositions.some((p) => p.mint === otherMint), true);

    const started = await engine.start();
    assert.equal(started.ok, true);
    await waitStopped(engine);

    const mints = ledger.openPositions.map((p) => p.mint).sort();
    assert.deepEqual(mints, [WSOL, otherMint].sort());
    assert.equal(market.scanCalls, 0);
    assert.equal(
      ledger.openPositions.find((p) => p.mint === otherMint)!.symbol,
      "OPEN",
    );
  });

  it("reloads the pin from disk and drops it on clear", () => {
    const sub = join(dir, "disk");
    const cfg = baseCfg({ ledgerDir: sub });
    const engine = new BotEngine(cfg, {
      ledger: new PaperLedger(cfg.bankrollUsd, sub),
      broker: new PaperBroker(cfg),
      market: new BoardMarket([], null),
    });
    assert.equal(engine.setPinnedMint({ mint: WSOL }).ok, true);
    const path = engine.pinnedMintPath();
    assert.equal(existsSync(path), true);
    const disk = JSON.parse(readFileSync(path, "utf8")) as { mint: string };
    assert.equal(disk.mint, WSOL);

    const again = new BotEngine(cfg, {
      ledger: new PaperLedger(cfg.bankrollUsd, sub),
      broker: new PaperBroker(cfg),
      market: new BoardMarket([], null),
    });
    assert.equal(again.getStatus().pinnedMint, WSOL);
    assert.equal(again.clearPinnedMint().ok, true);
    assert.equal(existsSync(path), false);
    assert.equal(again.getStatus().pinnedMint, null);
  });
});
