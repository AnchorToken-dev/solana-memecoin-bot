/**
 * Expected-cost gate (COST_GATE, default OFF).
 *
 * Skip a buy when the move similar past trades actually gave us (median best
 * mark while held, from memory) is smaller than what the round trip costs at
 * this size and pool depth (venue + PumpPortal + network + rent + slippage both
 * ways, from the real paper fee model). A coin that typically never even gets
 * back to break-even is not worth the fees.
 *
 * Replay on the Oct 10–12 tape (walk-forward, scripts/cost-gate-replay.ts) did
 * NOT support it: the trades it skipped lost no more than the ones it kept,
 * so it ships off.
 */
import type { MemoryFeatures, MemoryTrade } from "./memory.js";
import { nearest } from "./memory.js";
import { computeBuyCosts, computeSellCosts, type PaperFeeSettings, type PaperVenue } from "../broker/paperFees.js";

export interface CostGateParams {
  enabled: boolean;
  /** Need this many past trades with a recorded best move. */
  minTrades: number;
  neighbors: number;
  /** Which neighbour percentile is "the expected move" (0.5 = median). */
  quantile: number;
  /** Required margin: expected move must beat cost × this. */
  marginMult: number;
}

export const DEFAULT_COST_GATE: CostGateParams = {
  enabled: false,
  minTrades: 40,
  neighbors: 15,
  quantile: 0.5,
  marginMult: 1,
};

/** Round-trip cost as % of trade size at a flat price (fees + slippage both ways). */
export function roundTripCostPct(
  s: PaperFeeSettings,
  a: { notionalUsd: number; solUsd: number | null; venue?: PaperVenue; liquidityUsd?: number; flatSlippageBps: number },
): number {
  if (!(a.notionalUsd > 0)) return 0;
  const b = computeBuyCosts(s, { notionalUsd: a.notionalUsd, markPrice: 1, solUsd: a.solUsd, venue: a.venue, liquidityUsd: a.liquidityUsd, flatSlippageBps: a.flatSlippageBps });
  const sell = computeSellCosts(s, { qty: b.qty, markPrice: 1, solUsd: a.solUsd, venue: a.venue, liquidityUsd: a.liquidityUsd, flatSlippageBps: a.flatSlippageBps });
  return ((a.notionalUsd - sell.proceedsUsd) / a.notionalUsd) * 100;
}

/** Move needed above the entry FILL to break even (fill already includes buy slippage). */
export function breakEvenMovePct(costPct: number): number {
  return costPct >= 100 ? Infinity : (costPct / (100 - costPct)) * 100;
}

export interface CostGateVerdict {
  skip: boolean;
  expectedMovePct: number | null;
  costPct: number;
  needPct: number;
  detail: string;
}

export function evaluateCostGate(
  history: readonly MemoryTrade[],
  f: MemoryFeatures,
  costPct: number,
  p: CostGateParams,
): CostGateVerdict {
  const needPct = breakEvenMovePct(costPct) * p.marginMult;
  const base = { costPct, needPct };
  if (!p.enabled) return { ...base, skip: false, expectedMovePct: null, detail: "cost gate off" };
  const withMfe = history.filter((h) => h.mfePct != null && Number.isFinite(h.mfePct));
  if (withMfe.length < p.minTrades) {
    return { ...base, skip: false, expectedMovePct: null, detail: `learning (${withMfe.length}/${p.minTrades})` };
  }
  const nb = nearest(withMfe, f, p.neighbors);
  if (nb.length < Math.min(5, p.neighbors)) return { ...base, skip: false, expectedMovePct: null, detail: "not enough comparable trades" };
  const m = nb.map((h) => h.mfePct!).sort((a, b) => a - b);
  const q = Math.min(1, Math.max(0, p.quantile));
  const exp = m[Math.min(m.length - 1, Math.floor(m.length * q))]!;
  const skip = exp < needPct;
  return {
    ...base,
    skip,
    expectedMovePct: exp,
    detail: `similar trades' typical best move +${exp.toFixed(1)}% vs +${needPct.toFixed(1)}% needed to cover ${costPct.toFixed(1)}% round-trip costs`,
  };
}
