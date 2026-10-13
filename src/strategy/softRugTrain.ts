/**
 * Offline training + honest evaluation for the soft-rug model (src/strategy/softRug.ts).
 * Used by scripts/softrug-train.ts and the tests. Reads the price-tape JSONL files.
 *
 * Evaluation is chronological: train on the earliest trades, test on the
 * latest. A random split would leak (samples from one trade look alike).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  FEATURES,
  type Sample,
  type SoftRugModel,
  type TapeTradeLike,
  auc,
  predictProba,
  samplesFromTrade,
  trainStumps,
  tradePnlPct,
} from "./softRug.js";

/** Read every *.jsonl under `dir` (price-tape files) and pair entry + exit by tradeId. */
export function loadTapeTrades(dir: string): TapeTradeLike[] {
  const files = statSync(dir).isDirectory()
    ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(dir, f))
    : [dir];
  const entries = new Map<string, { at: number; notionalUsd: number; fillPrice: number }>();
  const exits: { tradeId: string; marks: unknown[][]; realizedPnlUsd: number; fillPrice: number }[] = [];
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (r.kind === "entry") {
        entries.set(String(r.tradeId), { at: Number(r.at), notionalUsd: Number(r.notionalUsd), fillPrice: Number(r.fillPrice) });
      } else if (r.kind === "exit" && Array.isArray(r.marks)) {
        exits.push({ tradeId: String(r.tradeId), marks: r.marks as unknown[][], realizedPnlUsd: Number(r.realizedPnlUsd), fillPrice: Number(r.fillPrice) });
      }
    }
  }
  const out: TapeTradeLike[] = [];
  for (const x of exits) {
    const e = entries.get(x.tradeId);
    if (!e || !(e.fillPrice > 0) || !(e.notionalUsd > 0) || !Number.isFinite(x.realizedPnlUsd)) continue;
    out.push({ tradeId: x.tradeId, entryAt: e.at, entryPrice: e.fillPrice, notionalUsd: e.notionalUsd, marks: x.marks, realizedPnlUsd: x.realizedPnlUsd, exitFillPrice: x.fillPrice });
  }
  return out.sort((a, b) => a.entryAt - b.entryAt);
}

function meanCi(xs: number[]): { n: number; mean: number; lo: number; hi: number } {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: 0, lo: 0, hi: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { n, mean, lo: mean, hi: mean };
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1));
  const h = (1.96 * sd) / Math.sqrt(n);
  return { n, mean, lo: mean - h, hi: mean + h };
}

export interface TrainConfig {
  labelPct: number;
  minHoldSec: number;
  everySec: number;
  nStumps: number;
  lr: number;
  minLeaf: number;
}
export const DEFAULT_TRAIN: TrainConfig = { labelPct: -10, minHoldSec: 3, everySec: 2, nStumps: 40, lr: 0.2, minLeaf: 25 };

export function buildSamples(trades: TapeTradeLike[], c: TrainConfig): { samples: Sample[]; weights: number[] } {
  const samples: Sample[] = [];
  const weights: number[] = [];
  for (const t of trades) {
    const s = samplesFromTrade(t, c.labelPct, c.minHoldSec, c.everySec);
    // Each trade counts once, however long it was held.
    for (const x of s) {
      samples.push(x);
      weights.push(1 / s.length);
    }
  }
  return { samples, weights };
}

export function fitModel(trades: TapeTradeLike[], c: TrainConfig = DEFAULT_TRAIN): SoftRugModel {
  const { samples, weights } = buildSamples(trades, c);
  const base = trainStumps(samples.map((s) => s.x), samples.map((s) => s.y), weights, { nStumps: c.nStumps, lr: c.lr, minLeaf: c.minLeaf });
  const posRate = samples.length ? samples.reduce((a, s) => a + s.y, 0) / samples.length : 0;
  return { ...base, trainedAt: Date.now(), trainedOn: { trades: trades.length, samples: samples.length, positiveRate: posRate, labelPct: c.labelPct } };
}

export interface ThresholdResult {
  threshold: number;
  triggered: number;
  /** Average % per trade over ALL test trades with the rule applied. */
  avg: { mean: number; lo: number; hi: number };
  /** Average change vs no rule, over all test trades. */
  delta: { mean: number; lo: number; hi: number };
  /** Of the triggered trades: how many would have ended a loss tail anyway. */
  triggeredWereLossTail: number;
}

export interface EvalReport {
  trainTrades: number;
  testTrades: number;
  testSamples: number;
  sampleAuc: number | null;
  tradeAuc: number | null;
  baselineAvg: { mean: number; lo: number; hi: number };
  lossTailRate: number;
  rows: ThresholdResult[];
  /** Same test trades with a plain tighter stop instead: sell at the first read this far below entry. */
  tighterStops: { stopPct: number; triggered: number; delta: { mean: number; lo: number; hi: number } }[];
}

/**
 * Chronological hold-out: fit on the first (1-holdout) of trades, then replay
 * "sell at the first read whose score >= threshold" on the rest.
 * New result = old net % + price move between the trigger mark and the actual
 * exit fill (as % of entry). Fees/slippage on the sell are treated as unchanged,
 * which is a small approximation.
 */
export function evaluateHoldout(trades: TapeTradeLike[], c: TrainConfig = DEFAULT_TRAIN, holdout = 0.3, thresholds = [0.4, 0.5, 0.6, 0.7, 0.8]): EvalReport {
  const cut = Math.floor(trades.length * (1 - holdout));
  const train = trades.slice(0, cut);
  const test = trades.slice(cut);
  const model = fitModel(train, c);
  const { samples } = buildSamples(test, c);
  const scores = samples.map((s) => predictProba(model, s.x));
  const baseline = test.map(tradePnlPct);
  const byTrade = new Map<string, { s: Sample; p: number }[]>();
  samples.forEach((s, i) => {
    const arr = byTrade.get(s.tradeId) ?? [];
    arr.push({ s, p: scores[i]! });
    byTrade.set(s.tradeId, arr);
  });
  const tradeMax = test.map((t) => Math.max(0, ...(byTrade.get(t.tradeId) ?? []).map((x) => x.p)));
  const tradeLabel: number[] = test.map((t) => (tradePnlPct(t) <= c.labelPct ? 1 : 0));
  const rows: ThresholdResult[] = thresholds.map((thr) => {
    const results: number[] = [];
    const deltas: number[] = [];
    let triggered = 0;
    let tail = 0;
    test.forEach((t, i) => {
      const hit = (byTrade.get(t.tradeId) ?? []).find((x) => x.p >= thr);
      if (!hit) {
        results.push(baseline[i]!);
        deltas.push(0);
        return;
      }
      triggered++;
      if (tradeLabel[i] === 1) tail++;
      const d = ((hit.s.mark - t.exitFillPrice) / t.entryPrice) * 100;
      results.push(baseline[i]! + d);
      deltas.push(d);
    });
    const a = meanCi(results);
    const dd = meanCi(deltas);
    return { threshold: thr, triggered, avg: a, delta: dd, triggeredWereLossTail: tail };
  });
  const tighterStops = [2, 3, 4, 5, 6].map((k) => {
    const deltas: number[] = [];
    let triggered = 0;
    for (const t of test) {
      const hit = (byTrade.get(t.tradeId) ?? []).find((x) => x.s.x[1]! <= -k);
      if (!hit) { deltas.push(0); continue; }
      triggered++;
      deltas.push(((hit.s.mark - t.exitFillPrice) / t.entryPrice) * 100);
    }
    return { stopPct: k, triggered, delta: meanCi(deltas) };
  });
  return {
    tighterStops,
    trainTrades: train.length,
    testTrades: test.length,
    testSamples: samples.length,
    sampleAuc: auc(scores, samples.map((s) => s.y)),
    tradeAuc: auc(tradeMax, tradeLabel),
    baselineAvg: meanCi(baseline),
    lossTailRate: tradeLabel.reduce((a, b) => a + b, 0) / Math.max(1, tradeLabel.length),
    rows,
  };
}

/** Top features by how often / how strongly the stumps use them (rough, for the report). */
export function featureUse(m: SoftRugModel): { name: string; stumps: number }[] {
  const c = new Array<number>(FEATURES.length).fill(0);
  for (const s of m.stumps) c[s.f]!++;
  return FEATURES.map((name, i) => ({ name, stumps: c[i]! })).sort((a, b) => b.stumps - a.stumps);
}
