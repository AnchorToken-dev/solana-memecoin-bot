/**
 * Honest exit labels. The exit reason is the DECISION (what the mark said);
 * the fill is what the chain paid. On Oct 9, Neura was sold for take_profit
 * at an on-chain mark of +19% but filled at -82%: three wallets pulled 60.7
 * SOL out of the curve in the slot right before our sell landed (~3.5s after
 * the decision). TRUMPSI (take_profit, -$15.08) and ALEJO (stop_loss,
 * +$6.35) were the same mismatch with the old DexScreener mark.
 *
 * This doesn't change what the bot does; it records the gap so the journal
 * and logs stop calling a -82% sale a "take profit".
 */
import type { ExitReason } from "../types.js";

/** Fill this far below/above the decision mark gets flagged. */
export const EXIT_FILL_GAP_WARN_PCT = 15;

const PROFIT_REASONS: ReadonlySet<ExitReason> = new Set(["take_profit", "trailing_take_profit"]);

export function exitFillWarning(args: {
  reason: ExitReason;
  decisionMarkPrice: number;
  fillPrice: number;
  realizedPnlUsd: number;
}): string | null {
  const { reason, decisionMarkPrice: mark, fillPrice: fill, realizedPnlUsd: pnl } = args;
  if (!(mark > 0) || !(fill >= 0) || !Number.isFinite(mark) || !Number.isFinite(fill)) return null;
  const gapPct = (fill / mark - 1) * 100;
  const gap = `${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(1)}%`;
  if (PROFIT_REASONS.has(reason) && pnl < 0) {
    return `${reason} decision filled at a LOSS ($${pnl.toFixed(2)}): fill ${gap} vs the mark that triggered it — price moved before the sell landed`;
  }
  if (reason === "stop_loss" && pnl > 0) {
    return `stop_loss decision filled at a PROFIT (+$${pnl.toFixed(2)}): fill ${gap} vs the mark — the mark was stale`;
  }
  if (Math.abs(gapPct) >= EXIT_FILL_GAP_WARN_PCT) {
    return `fill ${gap} vs the exit mark — price moved a lot between decision and fill`;
  }
  return null;
}
