/**
 * Evaluate shadow-logged KOL signals: "if the bot had bought when it SAW the KOL buy, what would
 * have happened, after the same trading costs as paper?"
 *
 * Pure functions (no I/O) used by scripts/kol-eval.ts.
 *
 * Method, per signal:
 *  - Entry = the first on-chain sample at or after `entryDelayMs` (default 3 s: roughly how long
 *    the bot needs to decide and fill). The KOL's own price is only used to measure how far the
 *    price had already run ("chase").
 *  - Gross return at each horizon = price at (entry + horizon) / entry price - 1.
 *  - Net return = gross - estimated round-trip cost (same fee/slippage model as paper, at the
 *    chosen trade size and the coin's reserve proxy).
 *  - Strategy return = walk the samples after entry; first sample at or below -stop% or at or above
 *    +tp% ends the trade (at that sampled price, not at the threshold); otherwise exit at the end
 *    of the hold window. Samples are sparse, so a spike that came and went between two samples is
 *    invisible: this is a rough check, not an exact replay.
 */
import { PAPER_FEE_DEFAULTS, type PaperFeeSettings, type PaperVenue } from "../broker/paperFees.js";
import { groupStats, type AnalysisRow, type GroupStats } from "../journal/analysis.js";
import { roundTripCostPct } from "../strategy/costGate.js";
import type { KolSignalRecord } from "./shadowLog.js";

export interface EvalOptions {
  sizeUsd: number;
  entryDelayMs: number;
  horizonsMs: readonly number[];
  stopPct: number;
  tpPct: number;
  maxHoldMs: number;
  fees: PaperFeeSettings;
  flatSlippageBps: number;
  solUsdFallback: number;
}

export const DEFAULT_EVAL: EvalOptions = {
  sizeUsd: 15,
  entryDelayMs: 3_000,
  horizonsMs: [10_000, 30_000, 60_000, 120_000, 240_000],
  stopPct: 12,
  tpPct: 15,
  maxHoldMs: 300_000,
  fees: { ...PAPER_FEE_DEFAULTS },
  flatSlippageBps: 25,
  solUsdFallback: 116,
};

export interface SignalEval {
  sig: KolSignalRecord;
  entryMs: number;
  entryPriceSol: number;
  costPct: number;
  /** How far above the KOL's own fill price our entry would have been, %. */
  chasePct: number | null;
  /** Gross % per horizon (key = horizon ms); null when no sample covers it. */
  gross: Map<number, number | null>;
  strat: { grossPct: number; reason: "stop" | "tp" | "time"; holdMs: number } | null;
}

const ENTRY_TOLERANCE_MS = 20_000;

export function evaluateSignal(sig: KolSignalRecord, o: EvalOptions): SignalEval | null {
  const s = [...sig.samples].filter((r) => r[1] > 0).sort((a, b) => a[0] - b[0]);
  const entry = s.find((r) => r[0] >= o.entryDelayMs);
  if (!entry || entry[0] > o.entryDelayMs + ENTRY_TOLERANCE_MS) return null;
  const [entryMs, pe, reserve] = entry;

  const solUsd = sig.solUsd && sig.solUsd > 0 ? sig.solUsd : o.solUsdFallback;
  const venue: PaperVenue = sig.venue === "pumpswap" ? "pumpswap" : "bonding_curve";
  // Same convention as the bot's paper fills: DexScreener-style liquidity = both sides ≈ 2 × SOL reserve.
  const cost = roundTripCostPct(o.fees, {
    notionalUsd: o.sizeUsd,
    solUsd,
    venue,
    ...(reserve != null && reserve > 0 ? { liquidityUsd: 2 * reserve * solUsd } : {}),
    flatSlippageBps: o.flatSlippageBps,
  });
  if (!Number.isFinite(cost)) return null;

  const kolSol = sig.kolPriceUsd && sig.kolPriceUsd > 0 ? sig.kolPriceUsd / solUsd : null;
  const chasePct = kolSol ? (pe / kolSol - 1) * 100 : null;

  const gross = new Map<number, number | null>();
  for (const h of o.horizonsMs) {
    const target = entryMs + h;
    const hit = s.find((r) => r[0] >= target);
    gross.set(h, hit && hit[0] <= target + Math.max(5_000, h * 0.25) ? (hit[1] / pe - 1) * 100 : null);
  }

  let strat: SignalEval["strat"] = null;
  const end = entryMs + o.maxHoldMs;
  let last: [number, number] | null = null;
  for (const r of s) {
    if (r[0] <= entryMs) continue;
    if (r[0] > end + 10_000) break;
    const ret = (r[1] / pe - 1) * 100;
    last = [r[0], ret];
    if (ret <= -o.stopPct) {
      strat = { grossPct: ret, reason: "stop", holdMs: r[0] - entryMs };
      break;
    }
    if (ret >= o.tpPct) {
      strat = { grossPct: ret, reason: "tp", holdMs: r[0] - entryMs };
      break;
    }
  }
  // Time exit only counts when the samples really cover (most of) the hold window.
  if (!strat && last && last[0] >= entryMs + o.maxHoldMs * 0.9) {
    strat = { grossPct: last[1], reason: "time", holdMs: last[0] - entryMs };
  }
  return { sig, entryMs, entryPriceSol: pe, costPct: cost, chasePct, gross, strat };
}

function row(pnlPct: number, size: number, reason: string): AnalysisRow {
  return { sizeUsd: size, pnlUsd: (pnlPct / 100) * size, pnlPct, exitReason: reason };
}

export function lagBucket(lagMs: number): string {
  return lagMs < 5_000 ? "lag <5s" : lagMs < 15_000 ? "lag 5-15s" : lagMs < 60_000 ? "lag 15-60s" : "lag >60s";
}

export function chaseBucket(c: number | null): string {
  if (c == null) return "chase unknown";
  return c <= 0 ? "chase <=0%" : c <= 10 ? "chase 0-10%" : c <= 30 ? "chase 10-30%" : "chase >30%";
}

export interface KolReport {
  signalsRead: number;
  signalsUsable: number;
  skippedNoEntrySample: number;
  avgCostPct: number | null;
  medianLagMs: number | null;
  medianChasePct: number | null;
  horizons: { horizonS: number; gross: GroupStats; net: GroupStats }[];
  strategy: { overall: GroupStats; byReason: Record<string, number>; byLag: Record<string, GroupStats>; byChase: Record<string, GroupStats>; byVenue: Record<string, GroupStats>; byWallet: { wallet: string; kol: string | null; stats: GroupStats }[] };
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m]! : (a[m - 1]! + a[m]!) / 2;
};

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const a = m.get(k);
    if (a) a.push(it);
    else m.set(k, [it]);
  }
  return m;
}

export function buildReport(signals: readonly KolSignalRecord[], o: EvalOptions = DEFAULT_EVAL, minWalletN = 5): KolReport {
  // A signal can appear twice (restart: a partial line plus a later full one). Keep the one with most samples.
  const best = new Map<string, KolSignalRecord>();
  for (const s of signals) {
    const k = `${s.tx}:${s.wallet}`;
    const cur = best.get(k);
    if (!cur || s.samples.length > cur.samples.length) best.set(k, s);
  }
  const all = [...best.values()];
  const evals = all.map((s) => evaluateSignal(s, o)).filter((e): e is SignalEval => e !== null);

  const horizons = o.horizonsMs.map((h) => {
    const rows = evals.filter((e) => e.gross.get(h) != null);
    return {
      horizonS: h / 1000,
      gross: groupStats(rows.map((e) => row(e.gross.get(h)!, o.sizeUsd, "horizon"))),
      net: groupStats(rows.map((e) => row(e.gross.get(h)! - e.costPct, o.sizeUsd, "horizon"))),
    };
  });

  const st = evals.filter((e) => e.strat);
  const stRows = st.map((e) => ({ e, r: row(e.strat!.grossPct - e.costPct, o.sizeUsd, e.strat!.reason) }));
  const statsOf = (items: { e: SignalEval; r: AnalysisRow }[]) => groupStats(items.map((x) => x.r));
  const grouped = (key: (e: SignalEval) => string) =>
    Object.fromEntries([...groupBy(stRows, (x) => key(x.e))].map(([k, v]) => [k, statsOf(v)]));
  const byReason: Record<string, number> = {};
  for (const x of stRows) byReason[x.r.exitReason] = (byReason[x.r.exitReason] ?? 0) + 1;
  const byWallet = [...groupBy(stRows, (x) => x.e.sig.wallet)]
    .filter(([, v]) => v.length >= minWalletN)
    .map(([wallet, v]) => ({ wallet, kol: v[0]!.e.sig.kol, stats: statsOf(v) }))
    .sort((a, b) => b.stats.avgPnlPct - a.stats.avgPnlPct);

  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return {
    signalsRead: all.length,
    signalsUsable: evals.length,
    skippedNoEntrySample: all.length - evals.length,
    avgCostPct: mean(evals.map((e) => e.costPct)),
    medianLagMs: median(evals.map((e) => e.sig.lagMs)),
    medianChasePct: median(evals.map((e) => e.chasePct).filter((c): c is number => c != null)),
    horizons,
    strategy: {
      overall: statsOf(stRows),
      byReason,
      byLag: grouped((e) => lagBucket(e.sig.lagMs)),
      byChase: grouped((e) => chaseBucket(e.chasePct)),
      byVenue: grouped((e) => e.sig.venue),
      byWallet,
    },
  };
}
