/**
 * Oct 9 live review fixes:
 *  - RPC "Too many inputs provided; max 5" → batch getMultipleAccounts
 *  - honest exit labels (Neura: take_profit decision filled at -82%)
 *  - entry guard (don't buy the top / brand-new coins)
 *  - early-warning exits (off by default)
 *  - live vs dry-run ledger split (stale "vault=$250")
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "../src/market/http.js";
import { ReadOnlySolanaRpc, parseMaxInputs, resetLearnedRpcLimits } from "../src/solana/rpc.js";
import { ScanPriceHistory, entryGuardActive, evaluateEntryGuard, DEFAULT_ENTRY_GUARD } from "../src/strategy/entryGuard.js";
import { PositionMarkHistory, earlyExitActive, evaluateEarlyExit, DEFAULT_EARLY_EXIT } from "../src/strategy/earlyExit.js";
import { exitFillWarning } from "../src/strategy/exitFill.js";
import { exitTitle } from "../src/alerts/sessionEvents.js";
import { BotEngine, liveLedgerDir } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { TradeJournal } from "../src/journal/journal.js";
import type { OnchainMark } from "../src/market/onchainPrice.js";
import type { MarketDataProvider } from "../src/market/data.js";
import type { BotConfig, EarlyExitParams, EntryGuardParams, Position, TokenSnapshot } from "../src/types.js";
import { loadConfig } from "../src/config.js";

const MINT = "CcFkwi8H7zD1bDLwyQacwK8ntoms1a2Bs4SunhL3pump";

// ---------------------------------------------------------------- RPC batching
describe("RPC: getMultipleAccounts batches to the provider's limit", () => {
  const accountJson = { lamports: 1, owner: "11111111111111111111111111111111", executable: false, data: ["", "base64"] };

  function capped(max: number, seen: number[]): FetchLike {
    return async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { params: [string[]] };
      const keys = body.params[0];
      seen.push(keys.length);
      if (keys.length > max) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: `Too many inputs provided; max ${max}` } }));
      }
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { context: { slot: 1 }, value: keys.map(() => accountJson) } }));
    };
  }

  it("parses the provider's cap", () => {
    assert.equal(parseMaxInputs("Too many inputs provided; max 5"), 5);
    assert.equal(parseMaxInputs("RPC response error -32602: Too many inputs provided; max 10"), 10);
    assert.equal(parseMaxInputs("HTTP 429"), null);
    assert.equal(parseMaxInputs(undefined), null);
  });

  it("21 accounts (pool vault + top 20 holders) succeed on a max-5 RPC and the cap is remembered", async () => {
    resetLearnedRpcLimits();
    const seen: number[] = [];
    const rpc = new ReadOnlySolanaRpc("https://rpc.example/key-a", capped(5, seen));
    const keys = Array.from({ length: 21 }, (_, i) => `k${i}`);
    const r = await rpc.getMultipleAccounts(keys);
    assert.equal(r.ok, true);
    assert.equal(r.ok && r.value.length, 21);
    assert.deepEqual(seen, [21, 5, 5, 5, 5, 1]);
    assert.equal(rpc.multiAccountBatchSize, 5);
    // A fresh client (the engine makes one per rug check) goes straight to 5.
    const seen2: number[] = [];
    const rpc2 = new ReadOnlySolanaRpc("https://rpc.example/key-a", capped(5, seen2));
    assert.equal((await rpc2.getMultipleAccounts(keys.slice(0, 7))).ok, true);
    assert.deepEqual(seen2, [5, 2]);
    resetLearnedRpcLimits();
  });

  it("other errors still fail (rug filter stays fail-closed)", async () => {
    resetLearnedRpcLimits();
    const fail: FetchLike = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "node is behind" } }));
    const r = await new ReadOnlySolanaRpc("https://rpc.example/key-b", fail).getMultipleAccounts(["a", "b"]);
    assert.equal(r.ok, false);
  });
});

// ---------------------------------------------------------------- exit labels
describe("exit fill warning (Neura case)", () => {
  it("take_profit decided at +19% but filled at -82% is flagged as a LOSS", () => {
    const w = exitFillWarning({ reason: "take_profit", decisionMarkPrice: 0.0000373660, fillPrice: 0.00000551833, realizedPnlUsd: -12.77 });
    assert.ok(w && /LOSS/.test(w) && /-85\.2%/.test(w), String(w));
  });
  it("stop_loss that filled green (ALEJO, stale mark) is flagged", () => {
    const w = exitFillWarning({ reason: "stop_loss", decisionMarkPrice: 1.6e-5, fillPrice: 2.532e-5, realizedPnlUsd: 6.35 });
    assert.ok(w && /PROFIT/.test(w));
  });
  it("normal fills (≈1% fee gap) are not flagged", () => {
    assert.equal(exitFillWarning({ reason: "take_profit", decisionMarkPrice: 1.0, fillPrice: 0.99, realizedPnlUsd: 2.5 }), null);
    assert.equal(exitFillWarning({ reason: "stop_loss", decisionMarkPrice: 1.0, fillPrice: 0.97, realizedPnlUsd: -1.4 }), null);
  });
});

// ---------------------------------------------------------------- entry guard
const snap = (over: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  mint: MINT, symbol: "Neura", name: "Neura", priceUsd: 3.1e-5, changeWindowPct: 20,
  volumeWindowUsd: 5_000, volumeAvgUsd: 1_000, volume24hUsd: 100_000, liquidityUsd: 20_000, timestamp: 0, ...over,
});
const guard = (over: Partial<EntryGuardParams>): EntryGuardParams => ({ ...DEFAULT_ENTRY_GUARD, ...over });

describe("entry guard", () => {
  const now = 1_791_570_104_000;
  it("is off by default", () => {
    assert.equal(entryGuardActive(DEFAULT_ENTRY_GUARD), false);
    assert.equal(evaluateEntryGuard(snap({ changeWindowPct: 912 }), [], DEFAULT_ENTRY_GUARD, now).ok, true);
  });
  it("blocks a +912% run (Neura) with ENTRY_MAX_RUNUP_PCT=150", () => {
    const v = evaluateEntryGuard(snap({ changeWindowPct: 912 }), [], guard({ maxRunupPct: 150 }), now);
    assert.equal(v.reason, "run_too_far");
    assert.equal(evaluateEntryGuard(snap({ changeWindowPct: 90 }), [], guard({ maxRunupPct: 150 }), now).ok, true);
  });
  it("blocks a 4-minute-old coin by createdAt, and by volume share when age is unknown", () => {
    const g = guard({ minCoinAgeMinutes: 10 });
    assert.equal(evaluateEntryGuard(snap({ createdAt: now - 4 * 60_000 }), [], g, now).reason, "brand_new");
    assert.equal(evaluateEntryGuard(snap({ createdAt: now - 30 * 60_000 }), [], g, now).ok, true);
    // volSpike 288x = all 24h volume inside the 5-min window.
    assert.equal(evaluateEntryGuard(snap({ volumeWindowUsd: 50_000, volume24hUsd: 50_000 }), [], g, now).reason, "brand_new");
    assert.equal(evaluateEntryGuard(snap(), [], g, now).ok, true);
  });
  it("ENTRY_MAX_WINDOW_VOLUME_SHARE_PCT blocks coins whose volume is nearly all recent", () => {
    const g = guard({ maxWindowVolumeSharePct: 80 });
    assert.equal(evaluateEntryGuard(snap({ volumeWindowUsd: 90_000 }), [], g, now).reason, "brand_new");
    assert.equal(evaluateEntryGuard(snap({ volumeWindowUsd: 10_000 }), [], g, now).ok, true);
  });
  it("blocks when the price is fading off its recent high / after red ticks", () => {
    const h = new ScanPriceHistory();
    h.record([{ mint: MINT, priceUsd: 4.0e-5 }], now - 30_000);
    h.record([{ mint: MINT, priceUsd: 3.6e-5 }], now - 20_000);
    h.record([{ mint: MINT, priceUsd: 3.4e-5 }], now - 10_000);
    h.record([{ mint: MINT, priceUsd: 3.1e-5 }], now);
    const pb = evaluateEntryGuard(snap(), h.get(MINT), guard({ maxPullbackPct: 15 }), now);
    assert.equal(pb.reason, "fading");
    const red = evaluateEntryGuard(snap(), h.get(MINT), guard({ maxDownTicks: 3 }), now);
    assert.equal(red.reason, "fading");
    assert.equal(evaluateEntryGuard(snap(), h.get(MINT), guard({ maxPullbackPct: 30 }), now).ok, true);
  });
});

// ---------------------------------------------------------------- early exits
const pos = (over: Partial<Position> = {}): Position => ({
  id: "p1", mint: MINT, symbol: "X", side: "long", qty: 1000, entryPrice: 1, entryNotionalUsd: 1000,
  entryFeesUsd: 0, highWaterPrice: 1, trailArmed: false, openedAt: 0, ...over,
});
const ee = (over: Partial<EarlyExitParams>): EarlyExitParams => ({ ...DEFAULT_EARLY_EXIT, ...over });

describe("early-warning exits", () => {
  it("off by default", () => {
    assert.equal(earlyExitActive(DEFAULT_EARLY_EXIT), false);
  });
  it("fast drop: -7% inside 3 s", () => {
    const h = new PositionMarkHistory();
    h.record("p1", 1.10, 1_000);
    h.record("p1", 1.02, 3_000);
    const s = evaluateEarlyExit(pos(), 1.02, h, ee({ fastDropPct: 6 }), 3_000);
    assert.equal(s?.reason, "early_fast_drop");
    assert.equal(evaluateEarlyExit(pos(), 1.02, h, ee({ fastDropPct: 6 }), 9_000), null, "older high is outside the window");
  });
  it("red ticks: 4 lower reads in a row totalling ≥3%", () => {
    const h = new PositionMarkHistory();
    [1.05, 1.04, 1.03, 1.02, 1.01].forEach((p, i) => h.record("p1", p, i * 1000));
    assert.equal(evaluateEarlyExit(pos(), 1.01, h, ee({ redTicks: 4 }), 4000)?.reason, "early_red_ticks");
    assert.equal(evaluateEarlyExit(pos(), 1.01, h, ee({ redTicks: 4, redTicksMinDropPct: 10 }), 4000), null);
  });
  it("giveback: peaked +20%, back to +9% = gave back 55%", () => {
    const h = new PositionMarkHistory();
    h.record("p1", 1.2, 1000);
    h.record("p1", 1.09, 2000);
    const s = evaluateEarlyExit(pos({ highWaterPrice: 1.2 }), 1.09, h, ee({ givebackArmPct: 12, givebackPct: 50 }), 2000);
    assert.equal(s?.reason, "early_giveback");
    assert.equal(evaluateEarlyExit(pos({ highWaterPrice: 1.08 }), 1.04, h, ee({ givebackArmPct: 25 }), 2000), null);
  });
  it("stall: no new high for 90 s and below entry", () => {
    const h = new PositionMarkHistory();
    h.record("p1", 1.01, 0);
    h.record("p1", 0.98, 95_000);
    assert.equal(evaluateEarlyExit(pos(), 0.98, h, ee({ stallSeconds: 90 }), 95_000)?.reason, "early_stall");
    assert.equal(evaluateEarlyExit(pos(), 1.0, h, ee({ stallSeconds: 90 }), 95_000), null, "not below entry");
  });
  it("alert titles exist for early exits", () => {
    assert.equal(exitTitle("early_fast_drop"), "Early exit: fast drop");
  });
});

// ---------------------------------------------------------------- engine wiring
function baseCfg(dir: string, over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true, bankrollUsd: 100, maxOpenTrades: 1, stopLossPct: 10, takeProfitPct: 25,
    positionSizePct: 0.5, maxPositionUsd: 50,
    momentum: { minPct: 1, windowMinutes: 5, volumeSpikeMult: 1, minLiquidityUsd: 0, minVolume24hUsd: 0, minAgeMinutes: 0 },
    trailingTakeProfit: { activatePct: 15, distancePct: 5 },
    paperBroker: { slippageBps: 0, feeBps: 0 },
    runner: { pollIntervalMs: 10_000, scanLimit: 5, maxCycles: 0 },
    maxHoldMinutes: 0, dailyLossUsd: 0, chaseLockoutHours: 0, marketDataSource: "mock",
    ledgerDir: dir, activePreset: "custom", requireChecklistGo: false, fastExitPollMs: 1000, ...over,
  };
}

class SeqReader {
  reads = 0;
  constructor(private readonly seq: number[]) {}
  async read(): Promise<OnchainMark | null> {
    const v = this.seq[Math.min(this.reads++, this.seq.length - 1)]!;
    return { priceSol: v, venue: "bonding_curve" };
  }
  drop() {}
}

function market(snaps: TokenSnapshot[]): MarketDataProvider & { getQuoteUsdRate(): Promise<number> } {
  return { async scan() { return snaps; }, async getPrice() { return 1; }, async getQuoteUsdRate() { return 100; } };
}

describe("engine wiring", () => {
  it("early fast-drop exit fires on the fast tick only when enabled", async () => {
    for (const enabled of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "early-"));
      try {
        const c = baseCfg(dir, enabled ? { earlyExit: ee({ fastDropPct: 5 }) } : {});
        const ledger = new PaperLedger(c.bankrollUsd, dir);
        const broker = new PaperBroker(c);
        // $1.04 then $0.97 (-6.7% in one read; stop is -10% so the normal rules don't fire)
        const engine = new BotEngine(c, { ledger, broker, journal: new TradeJournal(dir), market: market([]), solanaRpc: null, solanaWs: null, onchainPrice: new SeqReader([0.0104, 0.0097]) as never });
        const { fill, position } = broker.applyBuy({ mint: MINT, symbol: "X", markPrice: 1, notionalUsd: 15 });
        ledger.recordBuy(fill, position);
        assert.equal(await engine.fastExitTick(), 0);
        assert.equal(await engine.fastExitTick(), enabled ? 1 : 0);
        if (enabled) assert.equal(ledger.getTrades(1).at(-1)!.fill.reason, "early_fast_drop");
        if (enabled) assert.equal(ledger.getTrades(1).at(-1)!.fill.decisionMarkPrice, 0.97);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("entry guard skips a +912% coin that the momentum rules would buy", async () => {
    for (const enabled of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "guard-"));
      try {
        const c = baseCfg(dir, enabled ? { entryGuard: { ...DEFAULT_ENTRY_GUARD, maxRunupPct: 150 } } : {});
        const ledger = new PaperLedger(c.bankrollUsd, dir);
        const engine = new BotEngine(c, { ledger, broker: new PaperBroker(c), journal: new TradeJournal(dir), market: market([snap({ priceUsd: 1, changeWindowPct: 912 })]), solanaRpc: null, solanaWs: null, onchainPrice: null });
        await (engine as unknown as { tick(n: number): Promise<boolean> }).tick(1);
        assert.equal(ledger.openPositions.length, enabled ? 0 : 1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("live and dry-run ledgers live in separate folders", () => {
    const c = baseCfg("/x");
    assert.equal(liveLedgerDir({ ...c, tradingMode: "live" }), join("/x", "live"));
    assert.equal(liveLedgerDir({ ...c, tradingMode: "live_dry_run" }), join("/x", "live-dry-run"));
  });

  it("config: env flags load, all off by default", () => {
    const keys = ["ENTRY_MAX_RUNUP_PCT", "EXIT_FAST_DROP_PCT"];
    const saved = keys.map((k) => process.env[k]);
    try {
      for (const k of keys) delete process.env[k];
      const off = loadConfig({ skipRuntimeOverlay: true } as never);
      assert.equal(entryGuardActive(off.entryGuard), false);
      assert.equal(earlyExitActive(off.earlyExit), false);
      process.env.ENTRY_MAX_RUNUP_PCT = "150";
      process.env.EXIT_FAST_DROP_PCT = "6";
      const on = loadConfig({ skipRuntimeOverlay: true } as never);
      assert.equal(on.entryGuard?.maxRunupPct, 150);
      assert.equal(on.earlyExit?.fastDropPct, 6);
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });
});
