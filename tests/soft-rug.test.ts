import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PAPER_FEE_DEFAULTS } from "../src/broker/paperFees.js";
import { loadConfig } from "../src/config.js";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import type { MarketDataProvider } from "../src/market/data.js";
import {
  FEATURES, PathTracker, SoftRugMonitor, auc, loadModel, predictProba, samplesFromTrade, saveModel, trainStumps, type SoftRugModel, type TapeTradeLike,
} from "../src/strategy/softRug.js";
import { evaluateHoldout, fitModel, loadTapeTrades } from "../src/strategy/softRugTrain.js";
import type { BotConfig, SoftRugParams, TokenSnapshot } from "../src/types.js";

const IDX = Object.fromEntries(FEATURES.map((f, i) => [f, i])) as Record<(typeof FEATURES)[number], number>;

describe("PathTracker features", () => {
  it("computes entry drawdown, drop from peak, short changes, red share and reserve change", () => {
    const t = new PathTracker(100);
    t.push(1, 102, 50);
    t.push(2, 104, 50);
    t.push(3, 100, 49);
    t.push(4, 98, 48);
    t.push(5, 95, 47.5);
    const x = t.features()!;
    assert.equal(x[IDX.holdS], 5);
    assert.ok(Math.abs(x[IDX.ddEntryPct]! - -5) < 1e-9);
    assert.ok(Math.abs(x[IDX.fromPeakPct]! - (95 / 104 - 1) * 100) < 1e-9);
    assert.ok(Math.abs(x[IDX.chg3sPct]! - (95 / 104 - 1) * 100) < 1e-9, "3s back is t=2");
    assert.ok(Math.abs(x[IDX.resChgEntryPct]! - -5) < 1e-9);
    assert.ok(Math.abs(x[IDX.redShare10]! - 3 / 4) < 1e-9, "3 of 4 moves were down");
  });
  it("needs two reads, ignores bad numbers and non-increasing time, tolerates missing reserve", () => {
    const t = new PathTracker(100);
    assert.equal(t.features(), null);
    t.push(1, 100, null);
    assert.equal(t.features(), null);
    t.push(2, Number.NaN, null);
    t.push(2, -1, null);
    t.push(1, 99, null);
    assert.equal(t.size, 1);
    t.push(2, 99, null);
    const x = t.features()!;
    assert.equal(x[IDX.resChgEntryPct], 0);
    assert.equal(x[IDX.resChg5sPct], 0);
  });
});

describe("stump model", () => {
  const rng = (() => { let s = 7; return () => ((s = (s * 16807) % 2147483647) / 2147483647); })();
  it("learns a simple rule, ranks well, and survives a save/load round trip", () => {
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 400; i++) {
      const dd = -10 + rng() * 12; // -10..2
      const row = FEATURES.map(() => rng());
      row[IDX.ddEntryPct] = dd;
      X.push(row);
      y.push(dd < -4 ? 1 : 0);
    }
    const m: SoftRugModel = { ...trainStumps(X, y, undefined, { nStumps: 20, minLeaf: 10 }), trainedAt: 1, trainedOn: { trades: 0, samples: X.length, positiveRate: 0.5, labelPct: -10 } };
    const scores = X.map((r) => predictProba(m, r));
    assert.ok((auc(scores, y) ?? 0) > 0.97);
    const d = mkdtempSync(join(tmpdir(), "sr-"));
    try {
      saveModel(join(d, "sub", "m.json"), m);
      const back = loadModel(join(d, "sub", "m.json"))!;
      assert.deepEqual(back.stumps, m.stumps);
      assert.equal(predictProba(back, X[3]!), predictProba(m, X[3]!));
      writeFileSync(join(d, "bad.json"), "{nope");
      assert.equal(loadModel(join(d, "bad.json")), null);
      assert.equal(loadModel(join(d, "missing.json")), null);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("refuses to train on too little data; auc handles ties and one-class input", () => {
    assert.throws(() => trainStumps([[0, 0, 0, 0, 0, 0, 0, 0]], [1]));
    assert.equal(auc([0.5, 0.5, 0.5, 0.5], [1, 0, 1, 0]), 0.5);
    assert.equal(auc([0.1, 0.9], [1, 1]), null);
    assert.equal(auc([0.1, 0.9], [0, 1]), 1);
  });
});

// A synthetic tape: losers bleed steadily, winners drift up. Marks every 1s for 20s.
function synthTrade(i: number, loser: boolean): TapeTradeLike {
  const entry = 0.0001;
  const marks: unknown[][] = [];
  for (let s = 1; s <= 20; s++) {
    const wob = 1 + ((i * 7 + s * 3) % 5) / 1000;
    const drift = loser ? 1 - 0.006 * s : 1 + 0.004 * s;
    marks.push([s * 1000, entry * drift * wob, "chain", loser ? 100 - 0.2 * s : 100 + 0.1 * s]);
  }
  const last = marks[marks.length - 1]![1] as number;
  return { tradeId: `t${i}`, entryAt: 1_000 + i, entryPrice: entry, notionalUsd: 15, marks, realizedPnlUsd: loser ? -2 : 1, exitFillPrice: last };
}

describe("training samples and hold-out evaluation", () => {
  it("labels by the trade's final result and samples only inside the hold", () => {
    const s = samplesFromTrade(synthTrade(1, true), -10, 3, 2);
    assert.ok(s.length >= 6 && s.length <= 10);
    assert.ok(s.every((x) => x.y === 1 && x.tSec >= 3 && x.tSec <= 20));
    assert.ok(samplesFromTrade(synthTrade(2, false), -10).every((x) => x.y === 0));
  });
  it("loads a tape file, learns the synthetic pattern on the later trades, and beats no rule", () => {
    const d = mkdtempSync(join(tmpdir(), "srt-"));
    try {
      const lines: string[] = [];
      for (let i = 0; i < 80; i++) {
        const t = synthTrade(i, i % 2 === 0);
        lines.push(JSON.stringify({ kind: "entry", tradeId: t.tradeId, at: t.entryAt, notionalUsd: 15, fillPrice: t.entryPrice }));
        lines.push(JSON.stringify({ kind: "exit", tradeId: t.tradeId, marks: t.marks, realizedPnlUsd: t.realizedPnlUsd, fillPrice: t.exitFillPrice }));
      }
      lines.push("not json");
      writeFileSync(join(d, "2026-10-01.jsonl"), lines.join("\n"));
      const trades = loadTapeTrades(d);
      assert.equal(trades.length, 80);
      assert.ok(trades[0]!.entryAt <= trades[79]!.entryAt);
      const r = evaluateHoldout(trades);
      assert.equal(r.trainTrades, 56);
      assert.equal(r.testTrades, 24);
      assert.ok((r.sampleAuc ?? 0) > 0.9, `auc ${r.sampleAuc}`);
      const mid = r.rows.find((x) => x.threshold === 0.6)!;
      assert.ok(mid.delta.mean > 0, "selling the bleeders early helps on this synthetic tape");
      assert.ok(fitModel(trades).stumps.length > 0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

// A hand-made model: "price 3% or more below entry" => high score.
const ruleModel = (): SoftRugModel => ({
  v: 1, features: [...FEATURES], init: -2, lr: 1,
  stumps: [{ f: IDX.ddEntryPct, thr: -3, left: 4, right: -1 }],
  trainedAt: 0, trainedOn: { trades: 0, samples: 0, positiveRate: 0, labelPct: -10 },
});
const params = (mode: SoftRugParams["mode"], minHoldSec = 0): SoftRugParams => ({ mode, threshold: 0.6, minHoldSec, modelPath: "x" });
const pos = { id: "p1", mint: "M", symbol: "S", entryPrice: 100, openedAt: 0 };

describe("SoftRugMonitor", () => {
  it("scores, fires past the threshold, logs the first crossing once, and respects the minimum hold", () => {
    const d = mkdtempSync(join(tmpdir(), "srm-"));
    const file = join(d, "shadow.jsonl");
    try {
      const m = new SoftRugMonitor(params("shadow", 5), ruleModel(), file);
      assert.equal(m.observe(pos, 100, null, 1000).fire, false);
      const early = m.observe(pos, 95, null, 2000); // -5% but only 2s in
      assert.ok(early.p! > 0.6);
      assert.equal(early.fire, false);
      assert.equal(existsSync(file), false);
      const v = m.observe(pos, 95, null, 6000);
      assert.equal(v.fire, true);
      m.observe(pos, 94, null, 7000);
      const rows = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].symbol, "S");
      assert.equal(rows[0].mode, "shadow");
      assert.ok(rows[0].p > 0.6 && rows[0].features.ddEntryPct < -3);
      assert.equal(m.stats.crossed, 1);
      m.retain(new Set());
      assert.equal(m.maxScore("p1"), undefined);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("is inert when off or without a model", () => {
    assert.equal(new SoftRugMonitor(params("off"), ruleModel()).observe(pos, 90, null, 9000).p, null);
    assert.equal(new SoftRugMonitor(params("exit"), null).active, false);
  });
});

describe("soft-rug env wiring", () => {
  it("off unless SOFT_RUG_SHADOW=true; only ever shadow", () => {
    const keys = ["SOFT_RUG_SHADOW", "SOFT_RUG_THRESHOLD", "SOFT_RUG_MIN_HOLD_S", "SOFT_RUG_MODEL", "SOFT_RUG_MODE"] as const;
    const keep = keys.map((k) => process.env[k]);
    try {
      keys.forEach((k) => delete process.env[k]);
      assert.deepEqual(loadConfig({ skipRuntimeOverlay: true }).softRug, { mode: "off", threshold: 0.6, minHoldSec: 3, modelPath: "models/softrug-model.json" });
      process.env.SOFT_RUG_MODE = "exit"; // ignored in this repo
      process.env.SOFT_RUG_SHADOW = "true"; process.env.SOFT_RUG_THRESHOLD = "0.7"; process.env.SOFT_RUG_MIN_HOLD_S = "5"; process.env.SOFT_RUG_MODEL = "m/x.json";
      assert.deepEqual(loadConfig({ skipRuntimeOverlay: true }).softRug, { mode: "shadow", threshold: 0.7, minHoldSec: 5, modelPath: "m/x.json" });
    } finally {
      keys.forEach((k, i) => { if (keep[i] === undefined) delete process.env[k]; else process.env[k] = keep[i]!; });
    }
  });
  it("the shipped model file loads and scores", () => {
    const m = loadModel("models/softrug-model.json");
    assert.ok(m && m.stumps.length > 0);
    const p = predictProba(m!, [10, -7, -7, -3, -3, 0.9, -2, -1]);
    assert.ok(p >= 0 && p <= 1);
  });
});

// ---------- engine ----------
const MINT = "SoftRug111111111111111111111111111111111111";
const snap = (): TokenSnapshot => ({
  mint: MINT, symbol: "SRUG", name: "SoftRug", priceUsd: 0.0001, changeWindowPct: 50, volumeWindowUsd: 100_000,
  volumeAvgUsd: 1000, volume24hUsd: 1_000_000, liquidityUsd: 1_000_000, timestamp: Date.now(), createdAt: Date.now() - 3_600_000,
});
class OneCoin implements MarketDataProvider {
  async scan(): Promise<TokenSnapshot[]> { return [snap()]; }
  async getPrice() { return 0.0001; }
  async getQuoteUsdRate() { return 100; }
}
class MovingReader {
  priceSol = 0.000001;
  async read(_mint: string) { return { priceSol: this.priceSol, venue: "pumpswap" as const }; }
  drop() {}
}
const cfg = (ledgerDir: string, sr: SoftRugParams): BotConfig => ({
  paperMode: true, bankrollUsd: 200, maxOpenTrades: 1, stopLossPct: 8, takeProfitPct: 15, positionSizePct: 0.95, maxPositionUsd: 50,
  momentum: { minPct: 1, windowMinutes: 5, volumeSpikeMult: 1, minLiquidityUsd: 0, minVolume24hUsd: 0, minAgeMinutes: 0 },
  trailingTakeProfit: { activatePct: 10, distancePct: 5 },
  paperBroker: { slippageBps: 50, feeBps: 30, fees: { ...PAPER_FEE_DEFAULTS } },
  runner: { pollIntervalMs: 20, scanLimit: 5, maxCycles: 0 }, maxHoldMinutes: 0, dailyLossUsd: 0, chaseLockoutHours: 0,
  marketDataSource: "mock", ledgerDir, activePreset: "custom", requireChecklistGo: false,
  solanaRpcConfigured: false, solanaRpcWssConfigured: false, rugFilterEnabled: false, rugFilterMaxTopHolderPct: 30, rugFilterMaxSameSlotBuys: 3,
  memory: { enabled: false, minTrades: 40, neighbors: 15, skipAvgPnlPct: -8, maxTrades: 2000 },
  fastExitPollMs: 250,
  reentryCooldown: { minutes: 30, afterLossMinutes: 120 },
  softRug: sr,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withEngine(mode: SoftRugParams["mode"], withModel: boolean, body: (e: BotEngine, r: MovingReader, dir: string) => Promise<void>) {
  const d = mkdtempSync(join(tmpdir(), "srE-"));
  const modelPath = join(d, "m.json");
  if (withModel) saveModel(modelPath, ruleModel());
  const reader = new MovingReader();
  const e = new BotEngine(cfg(d, { mode, threshold: 0.6, minHoldSec: 0, modelPath }), { market: new OneCoin(), solanaWs: null, solanaRpc: null, ledger: new PaperLedger(200, join(d, "paper")), onchainPrice: reader as never });
  try {
    assert.ok((await e.start()).ok);
    await body(e, reader, d);
  } finally {
    await e.stop(); await e.stop(); await e.dispose();
    rmSync(d, { recursive: true, force: true });
  }
}

describe("soft-rug in the paper engine", () => {
  it("a config that says exit still only shadows: never sells, journals the crossing", async () => {
    await withEngine("exit", true, async (e, r) => {
      await sleep(500);
      assert.equal(e.ledger.openPositions.length, 1);
      r.priceSol = 0.00000095; // about -5.5% from the fill
      await sleep(1200);
      assert.equal(e.ledger.openPositions.length, 1, "soft-rug must never sell here");
      const s = e.getStatus().softRug;
      assert.equal(s.mode, "shadow");
      assert.ok(s.crossed >= 1);
    });
  });
  it("shadow mode: scores and logs the crossing but keeps the position", async () => {
    await withEngine("shadow", true, async (e, r, dir) => {
      await sleep(500);
      r.priceSol = 0.00000095;
      await sleep(1200);
      assert.equal(e.ledger.openPositions.length, 1, "shadow must never sell");
      const s = e.getStatus().softRug;
      assert.ok(s.crossed >= 1);
      assert.ok(existsSync(join(dir, "paper", "softrug-shadow.jsonl")));
    });
  });
  it("exit mode with no model file does nothing (and says so in status)", async () => {
    await withEngine("exit", false, async (e, r) => {
      await sleep(500);
      r.priceSol = 0.00000095;
      await sleep(1000);
      assert.equal(e.ledger.openPositions.length, 1);
      assert.equal(e.getStatus().softRug.modelLoaded, false);
    });
  });
  it("off: no scoring", async () => {
    await withEngine("off", true, async (e, r) => {
      await sleep(500);
      r.priceSol = 0.00000095;
      await sleep(1000);
      assert.equal(e.ledger.openPositions.length, 1);
      assert.equal(e.getStatus().softRug.scored, 0);
    });
  });
});
