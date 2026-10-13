/**
 * Pullback entry (opt-in, PAPER ONLY, default off).
 *
 * Why: the momentum rule buys after a rise, so about half the buys saw the price drop 2%+ within 30 s
 * and a median best price of only +3.7% afterwards. Replaying "buy only if the price falls X% below
 * the signal price within W seconds" on the Oct 11-12 tape gave -4.5% to -5.5% per trade for
 * X = 3-5% versus -6.5% for buying at the signal. A 1-3 point improvement inside the noise, so this
 * ships as an experiment: one clean paper test of a few hundred trades with nothing else changed.
 *
 * How: when a coin passes every entry check, the bot records the signal price and WAITS. A once-a-second
 * on-chain read fills the buy at the dipped price the first time it is at least `pct`% below the signal
 * price, and cancels the wait after `windowSec` seconds (that coin is then skipped for the usual re-entry
 * cooldown). Stop / take-profit / trailing levels are measured from the dipped fill.
 */
export interface PullbackParams {
  /** Buy only after the price is this many % below the signal price. 0 = off. ENTRY_PULLBACK_PCT. */
  pct: number;
  /** Give up after this many seconds. ENTRY_PULLBACK_WINDOW_S. */
  windowSec: number;
}

/** Most coins waited on at once (each costs one on-chain read per second). */
export const MAX_PENDING_PULLBACKS = 3;

export function pullbackActive(p: PullbackParams | undefined): p is PullbackParams {
  return !!p && Number.isFinite(p.pct) && p.pct > 0 && Number.isFinite(p.windowSec) && p.windowSec > 0;
}

export type PullbackVerdict = "wait" | "fill" | "expired";

/** Expiry is checked first, so a price that dips only after the window never fills. */
export function checkPullback(
  refUsd: number,
  curUsd: number | null | undefined,
  armedAt: number,
  now: number,
  p: PullbackParams,
): PullbackVerdict {
  if (now - armedAt > p.windowSec * 1000) return "expired";
  if (curUsd == null || !Number.isFinite(curUsd) || curUsd <= 0 || !(refUsd > 0)) return "wait";
  return curUsd <= refUsd * (1 - p.pct / 100) ? "fill" : "wait";
}
