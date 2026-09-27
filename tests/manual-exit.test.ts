import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { createControlApp } from "../src/api/server.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";
import type { Server } from "node:http";

function baseCfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true,
    bankrollUsd: 20,
    maxOpenTrades: 1,
    stopLossPct: 10,
    takeProfitPct: 25,
    positionSizePct: 0.95,
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
    runner: { pollIntervalMs: 50, scanLimit: 5, maxCycles: 0 },
    maxHoldMinutes: 20,
    dailyLossUsd: 5,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "custom",
    ...over,
  };
}

class FixedMarkMarket implements MarketDataProvider {
  constructor(
    private readonly mint: string,
    private price: number,
  ) {}
  setPrice(p: number) {
    this.price = p;
  }
  async scan(_limit: number): Promise<TokenSnapshot[]> {
    const now = Date.now();
    return [
      {
        mint: this.mint,
        symbol: "TST",
        name: "Test",
        priceUsd: this.price,
        changeWindowPct: 0,
        volumeWindowUsd: 0,
        volumeAvgUsd: 1,
        volume24hUsd: 0,
        liquidityUsd: 0,
        timestamp: now,
        createdAt: now - 60 * 60_000,
      },
    ];
  }
  async getPrice(mint: string): Promise<number | null> {
    return mint === this.mint ? this.price : null;
  }
}

describe("manual exit flattens open paper position", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "paper-exit-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exitNow sells at mark with reason=manual_exit", async () => {
    const mint = "MintExit1";
    const cfg = baseCfg({ ledgerDir: dir });
    const market = new FixedMarkMarket(mint, 1.0);
    const ledger = new PaperLedger(cfg.bankrollUsd, dir);
    const broker = new PaperBroker(cfg);
    const engine = new BotEngine(cfg, { ledger, broker, market });

    const { fill: buy, position } = broker.applyBuy({
      mint,
      symbol: "TST",
      markPrice: 1.0,
      notionalUsd: 19,
    });
    ledger.recordBuy(buy, position);
    assert.equal(ledger.openPositions.length, 1);

    market.setPrice(1.1);
    const result = await engine.exitNow();
    assert.equal(result.ok, true);
    assert.equal(ledger.openPositions.length, 0);
    assert.equal(result.fills?.length, 1);
    assert.equal(result.fills![0]!.reason, "manual_exit");
    assert.equal(result.portfolio.openPositions.length, 0);
    assert.match(result.message, /Manual exit/i);
  });

  it("exitNow returns error when flat", async () => {
    const sub = join(dir, "flat");
    const cfg = baseCfg({ ledgerDir: sub });
    const engine = new BotEngine(cfg, {
      ledger: new PaperLedger(cfg.bankrollUsd, sub),
      broker: new PaperBroker(cfg),
      market: new FixedMarkMarket("x", 1),
    });
    const result = await engine.exitNow();
    assert.equal(result.ok, false);
    assert.match(result.message, /no open paper position/i);
  });
});

describe("POST /runner/exit and /position/exit", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let engine: BotEngine;
  let market: FixedMarkMarket;
  let ledger: PaperLedger;
  let broker: PaperBroker;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "paper-api-exit-"));
    const cfg = baseCfg({ ledgerDir: dir });
    market = new FixedMarkMarket("MintApiExit", 1.0);
    ledger = new PaperLedger(cfg.bankrollUsd, dir);
    broker = new PaperBroker(cfg);
    engine = new BotEngine(cfg, { ledger, broker, market });
    const app = createControlApp(engine);
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((e) => (e ? reject(e) : resolve()));
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("400 when no open position", async () => {
    const res = await fetch(`${base}/runner/exit`, { method: "POST" });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { ok: boolean; message: string };
    assert.equal(body.ok, false);
    assert.match(body.message, /no open paper position/i);
  });

  it("flattens via /position/exit alias", async () => {
    const { fill, position } = broker.applyBuy({
      mint: "MintApiExit",
      symbol: "TST",
      markPrice: 1.0,
      notionalUsd: 18,
    });
    ledger.recordBuy(fill, position);
    market.setPrice(1.05);

    const res = await fetch(`${base}/position/exit`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      fills: Array<{ reason: string }>;
      portfolio: { openPositions: unknown[] };
    };
    assert.equal(body.ok, true);
    assert.equal(body.fills[0]!.reason, "manual_exit");
    assert.equal(body.portfolio.openPositions.length, 0);
    assert.equal(ledger.openPositions.length, 0);
  });
});
