/**
 * Entry price sanity check: compare the scan quote (DexScreener / pump.fun API)
 * with a fresh on-chain read right before a buy.
 *
 * Oct 11 paper, Nike (F4UPAU…pump): PumpSwap pool showed a 32-minute
 * "staircase" (+2,500%, ~$1.5k/min of steady buys). At 06:47:15 ET one wallet
 * pulled 336.6 SOL out of the pool in a single sell, followed by ~170 small
 * bundled sells over the next 4s; price fell 0.00119 → 0.0000019 (-99.8%).
 * The bot's scan at 06:47:17 still had DexScreener's pre-dump price
 * (0.00119417) and the dump's own sell volume as a "30x volume spike", so it
 * bought at 06:47:19 — 4.7s after the rug — and paper filled at the stale
 * quote. The on-chain pool already said 0.000024 (50x lower). The same cached
 * scan bought it again 4s later. Not a units/decimals bug and not a wrong pool:
 * the quote was stale.
 */
import type { EntryPriceCheckParams } from "../types.js";

export const DEFAULT_ENTRY_PRICE_CHECK: EntryPriceCheckParams = {
  enabled: true,
  maxGapPct: 25,
  mismatchSkipMinutes: 10,
  fillAtOnchain: true,
};

export type EntryPriceVerdict =
  | { ok: true; onchainUsd: number; gapPct: number }
  | { ok: false; reason: "price_mismatch"; detail: string; onchainUsd: number | null; gapPct: number | null };

/**
 * `gapPct` = how far the quote is from on-chain, as % of the on-chain price
 * (quote 0.00119 vs chain 0.000024 → +4,875%). Either direction counts.
 */
export function checkEntryPrice(args: {
  quoteUsd: number;
  onchainUsd: number | null;
  params: EntryPriceCheckParams;
  /** Why the on-chain read is missing (for the log). */
  readError?: string;
}): EntryPriceVerdict {
  const { quoteUsd, onchainUsd, params } = args;
  if (onchainUsd == null || !(onchainUsd > 0) || !Number.isFinite(onchainUsd)) {
    return {
      ok: false,
      reason: "price_mismatch",
      detail: `on-chain price read failed${args.readError ? ` (${args.readError})` : ""} — can't confirm the quote, not buying`,
      onchainUsd: null,
      gapPct: null,
    };
  }
  if (!(quoteUsd > 0) || !Number.isFinite(quoteUsd)) {
    return { ok: false, reason: "price_mismatch", detail: "no usable quote price", onchainUsd, gapPct: null };
  }
  const gapPct = (quoteUsd / onchainUsd - 1) * 100;
  // Symmetric: a 50x-too-high quote and a 50x-too-low quote are both wrong.
  const ratio = Math.max(quoteUsd / onchainUsd, onchainUsd / quoteUsd);
  const symGapPct = (ratio - 1) * 100;
  if (symGapPct > params.maxGapPct) {
    return {
      ok: false,
      reason: "price_mismatch",
      detail: `quote $${fmt(quoteUsd)} vs on-chain $${fmt(onchainUsd)} (${gapPct >= 0 ? "+" : ""}${gapPct.toFixed(1)}%, max ±${params.maxGapPct}%) — quote is stale or the pool just moved`,
      onchainUsd,
      gapPct,
    };
  }
  return { ok: true, onchainUsd, gapPct };
}

function fmt(n: number): string {
  return n >= 0.01 ? n.toFixed(4) : n.toPrecision(4);
}
