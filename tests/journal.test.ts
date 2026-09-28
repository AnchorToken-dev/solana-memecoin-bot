import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { TradeJournal } from "../src/journal/journal.js";
import { createControlApp } from "../src/api/server.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";
import type { Server } from "node:http";

function baseCfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true,
    bankrollUsd: 100,
    maxOpenTrades: 1,
    stopLossPct: 10,
    takeProfitPct: 25,
    positionSizePct: 0.95,
    maxPositionUsd: 25,
    momentum: {
      minPct: 1,
      windowMinutes: 5,
      volumeSpikeMult: 1,
      minLiquidityUsd: 0,
      minVolume24hUsd: 0,
      minAgeMinutes: 0,
    },
    trailingTakeProfit: { activatePct: 50, distancePct: 5 },
    paperBroker: { slippageBps: 0, feeBps: 0 },
    runner: { pollIntervalMs: 50, scanLimit: 5, maxCycles: 0 },
    maxHoldMinutes: 0,
    dailyLossUsd: 25,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "custom",
    requireChecklistGo: false,
    ...over,
  };
}

function mockMarket(priceByMint: Map<string, number>): MarketDataProvider {
  return {
    async scan(): Promise<TokenSnapshot[]> {
      return [...priceByMint.entries()].map(([mint, priceUsd]) => ({
        mint,
        symbol: mint.slice(0, 4).toUpperCase(),
        name: mint,
        priceUsd,
        changeWindowPct: 20,
        volumeWindowUsd: 10_000,
        volumeAvgUsd: 1_000,
        volume24hUsd: 50_000,
        liquidityUsd: 50_000,
        timestamp: Date.now(),
        createdAt: Date.now() - 60_000,
      }));
    },
    async getPrice(mint: string) {
      return priceByMint.get(mint) ?? null;
    },
  };
}

describe("TradeJournal unit", () => {
  it("appends close, updates note, persists to disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-unit-"));
    try {
      const j = new TradeJournal(dir);
      const entry = j.appendClose({
        position: {
          id: "pos1",
          mint: "MintAAA",
          symbol: "AAA",
          side: "long",
          qty: 10,
          entryPrice: 1,
          entryNotionalUsd: 10,
          entryFeesUsd: 0,
          highWaterPrice: 1.2,
          trailArmed: false,
          openedAt: 1_000,
        },
        exitPrice: 1.25,
        pnlUsd: 2.5,
        exitReason: "take_profit",
        fillId: "fill1",
        timestamp: 2_000,
      });
      assert.equal(entry.symbol, "AAA");
      assert.equal(entry.pnlPct, 25);
      assert.equal(entry.note, "");
      assert.equal(existsSync(join(dir, "journal.json")), true);

      const upd = j.updateNote(entry.id, "caught the pump");
      assert.equal(upd.ok, true);
      if (upd.ok) assert.equal(upd.entry.note, "caught the pump");

      const listed = j.list({ limit: 10 });
      assert.equal(listed.total, 1);
      assert.equal(listed.entries[0]!.note, "caught the pump");

      const reloaded = new TradeJournal(dir);
      assert.equal(reloaded.list().total, 1);
      assert.equal(reloaded.list().entries[0]!.note, "caught the pump");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("journal append on close + survives reset", () => {
  let dir: string;
  let engine: BotEngine;
  let prices: Map<string, number>;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "journal-eng-"));
    prices = new Map([["mint1", 1.0]]);
    const cfg = baseCfg({ ledgerDir: dir });
    engine = new BotEngine(cfg, {
      ledger: new PaperLedger(cfg.bankrollUsd, dir),
      broker: new PaperBroker(cfg),
      journal: new TradeJournal(dir),
      market: mockMarket(prices),
    });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records journal entry on manual exit and keeps it after reset", async () => {
    // Seed an open position via broker buy
    const { fill, position } = engine.broker.applyBuy({
      mint: "mint1",
      symbol: "AAA",
      markPrice: 1.0,
      notionalUsd: 50,
    });
    engine.ledger.recordBuy(fill, position);
    prices.set("mint1", 1.2);

    const exited = await engine.exitNow();
    assert.equal(exited.ok, true);
    const before = engine.getJournal({ limit: 10 });
    assert.equal(before.total, 1);
    assert.equal(before.entries[0]!.exitReason, "manual_exit");
    assert.ok(before.entries[0]!.pnlUsd > 0);

    const noteRes = engine.updateJournalNote(
      before.entries[0]!.id,
      "good trail setup",
    );
    assert.equal(noteRes.ok, true);

    const reset = await engine.reset();
    assert.equal(reset.ok, true);
    assert.equal(reset.portfolio.tradeCount, 0);

    const after = engine.getJournal({ limit: 10 });
    assert.equal(after.total, 1, "journal must survive /runner/reset");
    assert.equal(after.entries[0]!.note, "good trail setup");

    // Session ledger file cleared but journal.json remains
    const journalDisk = JSON.parse(
      readFileSync(join(dir, "journal.json"), "utf8"),
    ) as unknown[];
    assert.equal(journalDisk.length, 1);
  });
});

describe("journal HTTP API", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let engine: BotEngine;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "journal-api-"));
    const cfg = baseCfg({ ledgerDir: dir });
    engine = new BotEngine(cfg, {
      ledger: new PaperLedger(cfg.bankrollUsd, dir),
      broker: new PaperBroker(cfg),
      journal: new TradeJournal(dir),
      market: mockMarket(new Map([["mint1", 1]])),
    });
    const { fill, position } = engine.broker.applyBuy({
      mint: "mint1",
      symbol: "BBB",
      markPrice: 1,
      notionalUsd: 40,
    });
    engine.ledger.recordBuy(fill, position);
    await engine.exitNow();

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

  it("GET /journal lists newest first", async () => {
    const res = await fetch(`${base}/journal?limit=10`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      total: number;
      entries: Array<{ symbol: string; id: string }>;
    };
    assert.equal(body.total, 1);
    assert.equal(body.entries[0]!.symbol, "BBB");
  });

  it("PATCH /journal/:id updates note", async () => {
    const listed = (await (
      await fetch(`${base}/journal`)
    ).json()) as { entries: Array<{ id: string }> };
    const id = listed.entries[0]!.id;
    const res = await fetch(`${base}/journal/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ note: "review later" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      entry: { note: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.entry.note, "review later");
  });

  it("DELETE /journal clears explicitly", async () => {
    const res = await fetch(`${base}/journal`, { method: "DELETE" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { cleared: number };
    assert.equal(body.cleared, 1);
    const listed = (await (await fetch(`${base}/journal`)).json()) as {
      total: number;
    };
    assert.equal(listed.total, 0);
  });
});
