/**
 * Soft-rug early warning: a small learned model that watches an OPEN position
 * and estimates the chance it ends as a loss tail (stop-out or worse), so the
 * bot can leave before the full drop.
 *
 * Idea borrowed from AFKmoney/pumpfun-agent (analysis/soft_rug.py: boosted
 * one-split trees). That version trains on proxy columns (one is a constant)
 * and labels a rug as -50%, which our stops never allow, so this one is
 * rebuilt around what v2 actually records: the per-read price and pool-SOL
 * reserve path of the position (the same numbers the price tape stores).
 * Training and live scoring use the SAME feature code, so what the model
 * learned from the tape is what it sees live.
 *
 * Honest status (Oct 13 tape, 162 trades): replaying simple early-exit rules
 * on the tape moved the average by +0.1..+0.4 points with a 95% range that
 * includes zero. Nothing here is proven. Modes:
 *   off     - nothing runs.
 *   shadow  - scores every open position, logs the first time it would have
 *             sold (data/ledger .../softrug-shadow.jsonl). Never sells. DEFAULT.
 *   exit    - sells when the score is at or above the threshold. Paper /
 *             dry-run only; live forces shadow.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SoftRugParams } from "../types.js";

export const DEFAULT_SOFT_RUG: SoftRugParams = {
  mode: "shadow",
  threshold: 0.6,
  minHoldSec: 3,
  modelPath: "models/softrug-model.json",
};

export const FEATURES = [
  "holdS",
  "ddEntryPct",
  "fromPeakPct",
  "chg3sPct",
  "chg10sPct",
  "redShare10",
  "resChgEntryPct",
  "resChg5sPct",
] as const;
export type FeatureName = (typeof FEATURES)[number];
export type FeatureVector = number[];

// --------------------------------------------------------------------------
// Feature extraction (shared by training and live scoring)
// --------------------------------------------------------------------------

interface Pt {
  t: number; // seconds since entry
  p: number; // price
  r: number | null; // pool SOL reserve (null = unknown)
}

/** Incrementally built view of one position's price / reserve path. */
export class PathTracker {
  private readonly pts: Pt[] = [];
  private peak: number;
  private firstReserve: number | null = null;

  constructor(readonly entryPrice: number, private readonly maxPts = 600) {
    this.peak = entryPrice;
  }

  get size(): number {
    return this.pts.length;
  }

  push(tSec: number, price: number, reserve: number | null): void {
    if (!(price > 0) || !Number.isFinite(price) || !Number.isFinite(tSec)) return;
    const last = this.pts[this.pts.length - 1];
    if (last && tSec <= last.t) return;
    const r = reserve != null && reserve > 0 && Number.isFinite(reserve) ? reserve : null;
    if (r != null && this.firstReserve == null) this.firstReserve = r;
    if (price > this.peak) this.peak = price;
    this.pts.push({ t: tSec, p: price, r });
    if (this.pts.length > this.maxPts) this.pts.splice(0, this.pts.length - this.maxPts);
  }

  /** Price at or just before `t` seconds ago (null when the path is shorter). */
  private at(tSec: number): Pt | null {
    for (let i = this.pts.length - 1; i >= 0; i--) if (this.pts[i]!.t <= tSec) return this.pts[i]!;
    return null;
  }

  features(): FeatureVector | null {
    const n = this.pts.length;
    if (n < 2 || !(this.entryPrice > 0)) return null;
    const cur = this.pts[n - 1]!;
    const pct = (a: number, b: number): number => (b > 0 ? (a / b - 1) * 100 : 0);
    const back = (s: number): number => {
      const ref = this.at(cur.t - s) ?? this.pts[0]!;
      return pct(cur.p, ref.p);
    };
    // Share of the last 10 reads (non-flat moves only) that were down.
    const tail = this.pts.slice(-11);
    let down = 0;
    let moves = 0;
    for (let i = 1; i < tail.length; i++) {
      if (tail[i]!.p === tail[i - 1]!.p) continue;
      moves++;
      if (tail[i]!.p < tail[i - 1]!.p) down++;
    }
    const redShare = moves > 0 ? down / moves : 0.5;
    const rRef5 = this.at(cur.t - 5);
    const resEntry = cur.r != null && this.firstReserve != null ? pct(cur.r, this.firstReserve) : 0;
    const res5 = cur.r != null && rRef5?.r != null ? pct(cur.r, rRef5.r) : 0;
    return [cur.t, pct(cur.p, this.entryPrice), pct(cur.p, this.peak), back(3), back(10), redShare, resEntry, res5];
  }
}

// --------------------------------------------------------------------------
// Model: gradient-boosted one-split trees (stumps), numpy-free
// --------------------------------------------------------------------------

export interface Stump {
  f: number;
  thr: number;
  left: number;
  right: number;
}

export interface SoftRugModel {
  v: 1;
  features: string[];
  init: number;
  lr: number;
  stumps: Stump[];
  trainedAt: number;
  trainedOn: { trades: number; samples: number; positiveRate: number; labelPct: number };
}

const sigmoid = (x: number): number => 1 / (1 + Math.exp(-x));

export function predictProba(m: SoftRugModel, x: FeatureVector): number {
  let raw = m.init;
  for (const s of m.stumps) raw += m.lr * (x[s.f]! > s.thr ? s.right : s.left);
  return sigmoid(raw);
}

export interface TrainOptions {
  nStumps?: number;
  lr?: number;
  minLeaf?: number;
}

/** Fit stumps to the logistic-loss gradient. `w` weights samples (e.g. 1/samples-per-trade). */
export function trainStumps(X: FeatureVector[], y: number[], w?: number[], o: TrainOptions = {}): Omit<SoftRugModel, "trainedAt" | "trainedOn"> {
  const nStumps = o.nStumps ?? 50;
  const lr = o.lr ?? 0.2;
  const minLeaf = o.minLeaf ?? 20;
  const n = X.length;
  if (n < 2 * minLeaf) throw new Error(`need at least ${2 * minLeaf} samples, got ${n}`);
  const wt = w ?? new Array<number>(n).fill(1);
  const sw = wt.reduce((a, b) => a + b, 0);
  const pos = Math.min(1 - 1e-4, Math.max(1e-4, y.reduce((a, v, i) => a + v * wt[i]!, 0) / sw));
  const init = Math.log(pos / (1 - pos));
  const raw = new Array<number>(n).fill(init);
  const d = FEATURES.length;
  // Candidate thresholds per feature: up to 30 quantiles.
  const cands: number[][] = [];
  for (let f = 0; f < d; f++) {
    const col = X.map((r) => r[f]!).sort((a, b) => a - b);
    const set = new Set<number>();
    for (let q = 1; q <= 30; q++) set.add(col[Math.min(n - 1, Math.floor((q / 31) * n))]!);
    cands.push([...set]);
  }
  const stumps: Stump[] = [];
  for (let it = 0; it < nStumps; it++) {
    const g = raw.map((r, i) => y[i]! - sigmoid(r)); // negative gradient
    let best: Stump | null = null;
    let bestGain = 1e-9;
    for (let f = 0; f < d; f++) {
      for (const thr of cands[f]!) {
        let wl = 0, sl = 0, wr = 0, sr = 0, nl = 0;
        for (let i = 0; i < n; i++) {
          if (X[i]![f]! <= thr) { wl += wt[i]!; sl += wt[i]! * g[i]!; nl++; }
          else { wr += wt[i]!; sr += wt[i]! * g[i]!; }
        }
        if (nl < minLeaf || n - nl < minLeaf || wl <= 0 || wr <= 0) continue;
        // Squared-error gain of a two-leaf split.
        const gain = (sl * sl) / wl + (sr * sr) / wr - ((sl + sr) ** 2) / (wl + wr);
        if (gain > bestGain) {
          bestGain = gain;
          best = { f, thr, left: sl / wl, right: sr / wr };
        }
      }
    }
    if (!best) break;
    stumps.push(best);
    for (let i = 0; i < n; i++) raw[i]! += lr * (X[i]![best.f]! > best.thr ? best.right : best.left);
  }
  return { v: 1, features: [...FEATURES], init, lr, stumps };
}

/** Area under the ROC curve (ties count half). null when one class is missing. */
export function auc(scores: number[], labels: number[]): number | null {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[a]! - scores[b]!);
  let rankSumPos = 0;
  let nPos = 0;
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && scores[idx[j + 1]!] === scores[idx[i]!]) j++;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) if (labels[idx[k]!] === 1) { rankSumPos += rank; nPos++; }
    i = j + 1;
  }
  const nNeg = labels.length - nPos;
  if (nPos === 0 || nNeg === 0) return null;
  return (rankSumPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
}

export function loadModel(path: string): SoftRugModel | null {
  try {
    if (!existsSync(path)) return null;
    const m = JSON.parse(readFileSync(path, "utf8")) as SoftRugModel;
    if (m.v !== 1 || !Array.isArray(m.stumps) || m.features?.length !== FEATURES.length) return null;
    return m;
  } catch {
    return null;
  }
}

export function saveModel(path: string, m: SoftRugModel): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(m));
}

// --------------------------------------------------------------------------
// Training samples from the price tape
// --------------------------------------------------------------------------

export interface TapeTradeLike {
  tradeId: string;
  entryAt: number;
  entryPrice: number;
  notionalUsd: number;
  /** [msSinceEntry, price, src, reserve?] */
  marks: (readonly unknown[])[];
  realizedPnlUsd: number;
  exitFillPrice: number;
}

export interface Sample {
  tradeId: string;
  entryAt: number;
  tSec: number;
  mark: number;
  x: FeatureVector;
  y: number;
}

/** Net result of the trade as % of its size. */
export function tradePnlPct(t: TapeTradeLike): number {
  return t.notionalUsd > 0 ? (t.realizedPnlUsd / t.notionalUsd) * 100 : 0;
}

/**
 * One sample about every `everySec` seconds of the hold (after `minHoldSec`).
 * Label 1 = the trade finished at or below `labelPct` (net, fees included).
 */
export function samplesFromTrade(t: TapeTradeLike, labelPct: number, minHoldSec = 3, everySec = 2): Sample[] {
  const out: Sample[] = [];
  const tr = new PathTracker(t.entryPrice);
  const y = tradePnlPct(t) <= labelPct ? 1 : 0;
  let lastKept = -Infinity;
  for (const m of t.marks) {
    const ms = Number(m[0]);
    const price = Number(m[1]);
    const res = m.length > 3 && m[3] != null ? Number(m[3]) : null;
    tr.push(ms / 1000, price, res);
    const tSec = ms / 1000;
    if (tSec < minHoldSec || tSec - lastKept < everySec) continue;
    const x = tr.features();
    if (!x) continue;
    lastKept = tSec;
    out.push({ tradeId: t.tradeId, entryAt: t.entryAt, tSec, mark: price, x, y });
  }
  return out;
}

// --------------------------------------------------------------------------
// Live monitor
// --------------------------------------------------------------------------

export interface SoftRugVerdict {
  /** Score 0..1, or null when no model / not enough path yet. */
  p: number | null;
  /** True when p >= threshold and the minimum hold has passed. */
  fire: boolean;
  tSec: number;
}

export interface ShadowRecord {
  at: number;
  mode: string;
  positionId: string;
  mint: string;
  symbol: string;
  tSec: number;
  p: number;
  threshold: number;
  mark: number;
  entryPrice: number;
  features: Record<string, number>;
}

export class SoftRugMonitor {
  private readonly tracks = new Map<string, PathTracker>();
  private readonly crossed = new Set<string>();
  private readonly maxP = new Map<string, number>();
  readonly model: SoftRugModel | null;
  /** Counts for status / tests. */
  stats = { scored: 0, crossed: 0, fired: 0 };

  constructor(
    readonly params: SoftRugParams,
    model: SoftRugModel | null,
    /** Where shadow lines go (null = don't write). */
    private readonly shadowFile: string | null = null,
    private readonly now: () => number = Date.now,
  ) {
    this.model = model;
  }

  get active(): boolean {
    return this.params.mode !== "off" && this.model != null;
  }

  /**
   * Feed one read of an open position. `effectiveMode` lets the engine force
   * shadow (live). Returns a verdict; the caller decides what to do with `fire`.
   */
  observe(
    pos: { id: string; mint: string; symbol: string; entryPrice: number; openedAt: number },
    mark: number,
    reserve: number | null,
    nowMs: number,
  ): SoftRugVerdict {
    const tSec = Math.max(0, (nowMs - pos.openedAt) / 1000);
    if (!this.active) return { p: null, fire: false, tSec };
    let tr = this.tracks.get(pos.id);
    if (!tr) {
      tr = new PathTracker(pos.entryPrice);
      this.tracks.set(pos.id, tr);
    }
    tr.push(tSec, mark, reserve);
    const x = tr.features();
    if (!x) return { p: null, fire: false, tSec };
    const p = predictProba(this.model!, x);
    this.stats.scored++;
    if (p > (this.maxP.get(pos.id) ?? 0)) this.maxP.set(pos.id, p);
    const fire = p >= this.params.threshold && tSec >= this.params.minHoldSec;
    if (fire && !this.crossed.has(pos.id)) {
      this.crossed.add(pos.id);
      this.stats.crossed++;
      this.writeShadow({
        at: this.now(),
        mode: this.params.mode,
        positionId: pos.id,
        mint: pos.mint,
        symbol: pos.symbol,
        tSec,
        p,
        threshold: this.params.threshold,
        mark,
        entryPrice: pos.entryPrice,
        features: Object.fromEntries(FEATURES.map((k, i) => [k, Math.round(x[i]! * 1000) / 1000])),
      });
    }
    return { p, fire, tSec };
  }

  maxScore(positionId: string): number | undefined {
    return this.maxP.get(positionId);
  }

  /** Drop state for positions that are no longer open. */
  retain(openIds: Set<string>): void {
    for (const k of [...this.tracks.keys()]) {
      if (!openIds.has(k)) {
        this.tracks.delete(k);
        this.crossed.delete(k);
        this.maxP.delete(k);
      }
    }
  }

  private writeShadow(r: ShadowRecord): void {
    if (!this.shadowFile) return;
    try {
      mkdirSync(dirname(this.shadowFile), { recursive: true });
      appendFileSync(this.shadowFile, JSON.stringify(r) + "\n");
    } catch {
      // Shadow logging must never affect trading.
    }
  }
}
