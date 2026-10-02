import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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
    chaseLockoutHours: 12,
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
  it("stores checklist snapshot fields on appendClose", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-cl-fields-"));
    try {
      const j = new TradeJournal(dir);
      const entry = j.appendClose({
        position: {
          id: "posCl",
          mint: "MintCl",
          symbol: "CL",
          side: "long",
          qty: 5,
          entryPrice: 1,
          entryNotionalUsd: 5,
          entryFeesUsd: 0,
          highWaterPrice: 1,
          trailArmed: false,
          openedAt: 1_000,
        },
        exitPrice: 1.1,
        pnlUsd: 0.5,
        exitReason: "manual_exit",
        fillId: "fillCl",
        timestamp: 2_000,
        checklistId: "cl-uuid-1",
        checklistVerdict: "GO",
        checklistThesis: "strength hold",
      });
      assert.equal(entry.checklistId, "cl-uuid-1");
      assert.equal(entry.checklistVerdict, "GO");
      assert.equal(entry.checklistThesis, "strength hold");
      const again = new TradeJournal(dir);
      const listed = again.list({ limit: 5 });
      assert.equal(listed.entries[0]!.checklistId, "cl-uuid-1");
      assert.equal(listed.entries[0]!.checklistVerdict, "GO");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
      assert.equal(entry.quoteAsset, "SOL");
      assert.equal(entry.quoteBasis, "usd_only");
      assert.equal(entry.checklistId, null);
      assert.equal(entry.checklistVerdict, null);
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
    const before = await engine.getJournal({ limit: 10 });
    assert.equal(before.total, 1);
    assert.equal(before.entries[0]!.exitReason, "manual_exit");
    assert.equal(before.entries[0]!.mint, "mint1");
    assert.ok(before.entries[0]!.pnlUsd > 0);

    const noteRes = engine.updateJournalNote(
      before.entries[0]!.id,
      "good trail setup",
    );
    assert.equal(noteRes.ok, true);

    const reset = await engine.reset();
    assert.equal(reset.ok, true);
    assert.equal(reset.portfolio.tradeCount, 0);

    const after = await engine.getJournal({ limit: 10 });
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
      summary: {
        timezone: string;
        quoteAsset: string;
        periods: Array<{ period: string; tradeCount: number; pnlUsd: number }>;
      };
    };
    assert.equal(body.total, 1);
    assert.equal(body.entries[0]!.symbol, "BBB");
    assert.equal(body.summary.timezone, "America/New_York");
    assert.equal(body.summary.quoteAsset, "SOL");
    assert.equal(body.summary.periods.length, 4);
    const overall = body.summary.periods.find((p) => p.period === "overall");
    assert.ok(overall);
    assert.equal(overall!.tradeCount, 1);
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

describe("journal mint / CA backfill", () => {
  it("stores mint on appendClose", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-mint-"));
    try {
      const j = new TradeJournal(dir);
      const entry = j.appendClose({
        position: {
          id: "pos1",
          mint: "So11111111111111111111111111111111111111112",
          symbol: "WSOL",
          side: "long",
          qty: 1,
          entryPrice: 1,
          entryNotionalUsd: 10,
          entryFeesUsd: 0,
          highWaterPrice: 1,
          trailArmed: false,
          openedAt: 1_000,
        },
        exitPrice: 1.1,
        pnlUsd: 1,
        exitReason: "take_profit",
        fillId: "fill1",
        timestamp: 2_000,
      });
      assert.equal(entry.mint, "So11111111111111111111111111111111111111112");
      assert.equal(j.list().entries[0]!.mint, entry.mint);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills missing mint from fills by fillId then positionId", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-bf-"));
    try {
      writeFileSync(
        join(dir, "journal.json"),
        JSON.stringify(
          [
            {
              id: "j1",
              timestamp: 3_000,
              openedAt: 1_000,
              mint: "",
              symbol: "PEPE",
              side: "long",
              sizeUsd: 10,
              entryPrice: 1,
              exitPrice: 1.2,
              pnlUsd: 2,
              pnlPct: 20,
              exitReason: "take_profit",
              note: "",
              positionId: "posA",
              fillId: "fillA",
            },
            {
              id: "j2",
              timestamp: 4_000,
              openedAt: 2_000,
              // mint omitted entirely (legacy row)
              symbol: "PEPE",
              side: "long",
              sizeUsd: 5,
              entryPrice: 1,
              exitPrice: 0.9,
              pnlUsd: -0.5,
              pnlPct: -10,
              exitReason: "stop_loss",
              note: "",
              positionId: "posB",
              fillId: "fillB",
            },
          ],
          null,
          2,
        ) + "\n",
      );
      const j = new TradeJournal(dir);
      assert.equal(j.list().total, 2);
      // Both missing before backfill from explicit fills
      const n = j.backfillMissingMints([
        {
          id: "fillA",
          positionId: "posA",
          mint: "MintAAA1111111111111111111111111111111111",
        },
        {
          id: "fillOther",
          positionId: "posB",
          mint: "MintBBB2222222222222222222222222222222222",
        },
      ]);
      assert.equal(n, 2);
      const byId = Object.fromEntries(
        j.list({ limit: 10 }).entries.map((e) => [e.id, e.mint]),
      );
      assert.equal(byId.j1, "MintAAA1111111111111111111111111111111111");
      assert.equal(byId.j2, "MintBBB2222222222222222222222222222222222");

      // Idempotent
      assert.equal(
        j.backfillMissingMints([
          {
            id: "fillA",
            positionId: "posA",
            mint: "MintAAA1111111111111111111111111111111111",
          },
        ]),
        0,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("backfills from sibling trades.json on construct", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-disk-bf-"));
    try {
      writeFileSync(
        join(dir, "journal.json"),
        JSON.stringify([
          {
            id: "jOld",
            timestamp: 5_000,
            openedAt: 4_000,
            mint: "",
            symbol: "DOGE",
            side: "long",
            sizeUsd: 8,
            entryPrice: 1,
            exitPrice: 1.5,
            pnlUsd: 4,
            pnlPct: 50,
            exitReason: "manual_exit",
            note: "",
            positionId: "posDisk",
            fillId: "fillDisk",
          },
        ]) + "\n",
      );
      writeFileSync(
        join(dir, "trades.json"),
        JSON.stringify([
          {
            fill: {
              id: "fillDisk",
              positionId: "posDisk",
              mint: "DiskMint99999999999999999999999999999999",
              symbol: "DOGE",
              side: "sell",
              qty: 8,
              price: 1.5,
              notionalUsd: 12,
              feesUsd: 0,
              slippageUsd: 0,
              reason: "manual_exit",
              timestamp: 5_000,
              paper: true,
            },
            realizedPnlUsd: 4,
            cashAfter: 104,
          },
        ]) + "\n",
      );
      const j = new TradeJournal(dir);
      assert.equal(
        j.list().entries[0]!.mint,
        "DiskMint99999999999999999999999999999999",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("journal P&L summary + quote asset", () => {
  it("records SOL amounts when quoteUsdRate is provided", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-sol-"));
    try {
      const j = new TradeJournal(dir);
      const entry = j.appendClose({
        position: {
          id: "pos1",
          mint: "MintSOL",
          symbol: "AAA",
          side: "long",
          qty: 10,
          entryPrice: 1,
          entryNotionalUsd: 100,
          entryFeesUsd: 0,
          highWaterPrice: 1.2,
          trailArmed: false,
          openedAt: 1_000,
        },
        exitPrice: 1.25,
        pnlUsd: 25,
        exitReason: "take_profit",
        fillId: "fill1",
        timestamp: 2_000,
        quoteUsdRate: 200, // $200 / SOL
      });
      assert.equal(entry.quoteAsset, "SOL");
      assert.equal(entry.quoteBasis, "recorded");
      assert.equal(entry.quoteUsdRate, 200);
      assert.equal(entry.sizeQuote, 0.5);
      assert.equal(entry.pnlQuote, 0.125);

      const listed = j.list({ estimateQuoteUsdRate: 200 });
      const overall = listed.summary.periods.find((p) => p.period === "overall")!;
      assert.equal(overall.pnlUsd, 25);
      assert.equal(overall.pnlQuote, 0.125);
      assert.equal(overall.quoteBasis, "recorded");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("estimates SOL for usd_only legacy rows using estimateQuoteUsdRate", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-est-"));
    try {
      writeFileSync(
        join(dir, "journal.json"),
        JSON.stringify([
          {
            id: "jLegacy",
            timestamp: Date.now(),
            openedAt: Date.now() - 1000,
            mint: "MintX",
            symbol: "LEG",
            side: "long",
            sizeUsd: 50,
            entryPrice: 1,
            exitPrice: 1.1,
            pnlUsd: 5,
            pnlPct: 10,
            exitReason: "take_profit",
            note: "",
            positionId: "p1",
            fillId: "f1",
          },
        ]) + "\n",
      );
      const j = new TradeJournal(dir);
      const e = j.list().entries[0]!;
      assert.equal(e.quoteBasis, "usd_only");
      assert.equal(e.pnlQuote, null);

      const withEst = j.list({ estimateQuoteUsdRate: 100 });
      const overall = withEst.summary.periods.find((p) => p.period === "overall")!;
      assert.equal(overall.pnlUsd, 5);
      assert.equal(overall.pnlQuote, 0.05);
      assert.equal(overall.quoteBasis, "estimated");
      assert.equal(withEst.summary.estimateQuoteUsdRate, 100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls up daily / weekly / monthly / overall in America/New_York", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-roll-"));
    try {
      const j = new TradeJournal(dir);
      // Fixed "now": Wednesday 2026-09-23 15:00 America/New_York = 19:00 UTC
      // (EDT, UTC-4)
      const nowMs = Date.parse("2026-09-23T19:00:00.000Z");
      // Today (Wed) close
      j.appendClose({
        position: {
          id: "pToday",
          mint: "m1",
          symbol: "T",
          side: "long",
          qty: 1,
          entryPrice: 1,
          entryNotionalUsd: 10,
          entryFeesUsd: 0,
          highWaterPrice: 1,
          trailArmed: false,
          openedAt: nowMs - 60_000,
        },
        exitPrice: 1.1,
        pnlUsd: 1,
        exitReason: "take_profit",
        fillId: "fToday",
        timestamp: nowMs - 30_000,
        quoteUsdRate: 100,
      });
      // Earlier this week (Monday) — still in Mon-week window
      const mondayClose = Date.parse("2026-09-21T16:00:00.000Z"); // Mon 12:00 ET
      j.appendClose({
        position: {
          id: "pMon",
          mint: "m2",
          symbol: "M",
          side: "long",
          qty: 1,
          entryPrice: 1,
          entryNotionalUsd: 20,
          entryFeesUsd: 0,
          highWaterPrice: 1,
          trailArmed: false,
          openedAt: mondayClose - 60_000,
        },
        exitPrice: 0.9,
        pnlUsd: -2,
        exitReason: "stop_loss",
        fillId: "fMon",
        timestamp: mondayClose,
        quoteUsdRate: 100,
      });
      // Prior month (August) — overall only
      const augClose = Date.parse("2026-08-15T16:00:00.000Z");
      j.appendClose({
        position: {
          id: "pAug",
          mint: "m3",
          symbol: "A",
          side: "long",
          qty: 1,
          entryPrice: 1,
          entryNotionalUsd: 30,
          entryFeesUsd: 0,
          highWaterPrice: 1,
          trailArmed: false,
          openedAt: augClose - 60_000,
        },
        exitPrice: 1.2,
        pnlUsd: 6,
        exitReason: "manual_exit",
        fillId: "fAug",
        timestamp: augClose,
        quoteUsdRate: 100,
      });

      const { summary } = j.list({ nowMs, timeZone: "America/New_York" });
      const by = Object.fromEntries(summary.periods.map((p) => [p.period, p]));
      assert.equal(by.daily!.tradeCount, 1);
      assert.equal(by.daily!.pnlUsd, 1);
      assert.equal(by.weekly!.tradeCount, 2); // Mon + Wed
      assert.equal(by.weekly!.pnlUsd, -1);
      assert.equal(by.monthly!.tradeCount, 2); // Sep only
      assert.equal(by.monthly!.pnlUsd, -1);
      assert.equal(by.overall!.tradeCount, 3);
      assert.equal(by.overall!.pnlUsd, 5);
      assert.ok(Math.abs((by.overall!.pnlQuote ?? 0) - 0.05) < 1e-9);
      assert.equal(summary.timezone, "America/New_York");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("winPct is null with zero decided closes and wins/(wins+losses) otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-winpct-"));
    try {
      const j = new TradeJournal(dir);
      const nowMs = Date.parse("2026-09-23T19:00:00.000Z");
      const empty = j.list({ nowMs, timeZone: "America/New_York" });
      assert.equal(empty.summary.periods.length, 4);
      for (const period of empty.summary.periods) {
        assert.equal(period.tradeCount, 0);
        assert.equal(period.winCount, 0);
        assert.equal(period.lossCount, 0);
        assert.equal(period.winPct, null);
      }

      const close = (id: string, pnlUsd: number) => {
        j.appendClose({
          position: {
            id,
            mint: id,
            symbol: id,
            side: "long",
            qty: 1,
            entryPrice: 1,
            entryNotionalUsd: 10,
            entryFeesUsd: 0,
            highWaterPrice: 1,
            trailArmed: false,
            openedAt: nowMs - 120_000,
          },
          exitPrice: 1,
          pnlUsd,
          exitReason: pnlUsd >= 0 ? "take_profit" : "stop_loss",
          fillId: id,
          timestamp: nowMs - 60_000,
          quoteUsdRate: 100,
        });
      };
      close("winA", 4);
      close("winB", 1);
      close("lossA", -3);
      close("flat", 0); // breakeven: counted as a trade, not a win or a loss

      const { summary } = j.list({ nowMs, timeZone: "America/New_York" });
      const by = Object.fromEntries(summary.periods.map((period) => [period.period, period]));
      for (const key of ["daily", "weekly", "monthly", "overall"] as const) {
        const period = by[key]!;
        assert.equal(period.tradeCount, 4);
        assert.equal(period.winCount, 2);
        assert.equal(period.lossCount, 1);
        assert.ok(period.winPct != null);
        assert.ok(Math.abs(period.winPct - (2 / 3) * 100) < 1e-9);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("engine records quote rate from market.getQuoteUsdRate on close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-eng-sol-"));
    try {
      const prices = new Map([["mint1", 1.0]]);
      const cfg = baseCfg({ ledgerDir: dir });
      const market: MarketDataProvider = {
        ...mockMarket(prices),
        async getQuoteUsdRate() {
          return 250;
        },
      };
      const engine = new BotEngine(cfg, {
        ledger: new PaperLedger(cfg.bankrollUsd, dir),
        broker: new PaperBroker(cfg),
        journal: new TradeJournal(dir),
        market,
      });
      const { fill, position } = engine.broker.applyBuy({
        mint: "mint1",
        symbol: "SOLY",
        markPrice: 1.0,
        notionalUsd: 50,
      });
      engine.ledger.recordBuy(fill, position);
      prices.set("mint1", 1.2);
      await engine.exitNow();
      const listed = await engine.getJournal({ limit: 5 });
      assert.equal(listed.total, 1);
      assert.equal(listed.entries[0]!.quoteBasis, "recorded");
      assert.equal(listed.entries[0]!.quoteUsdRate, 250);
      assert.ok(listed.entries[0]!.pnlQuote != null);
      assert.ok(listed.entries[0]!.sizeQuote != null);
      assert.equal(listed.summary.periods.find((p) => p.period === "overall")!.tradeCount, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
