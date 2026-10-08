/**
 * Paper realism: would LIVE be able to buy this coin at all? Paper fills
 * anything, so without this paper results include coins live always fails on
 * (see PR #28). Uses only fields the market scan already has — no RPC, no
 * PumpPortal, no extra requests.
 */
import { isSolQuoteMint, PUMPSWAP_THIN_POOL_FLOOR_SOL } from "../live/pumpswapPool.js";
import type { BuyFailureKind } from "../live/pumpErrors.js";
import type { TokenSnapshot } from "../types.js";

export type PaperBuyableResult =
  | { ok: true }
  | { ok: false; kind: Extract<BuyFailureKind, "unsupported_quote" | "pool_too_thin">; reason: string; detail: string };

export function checkPaperBuyable(
  snap: Pick<TokenSnapshot, "quoteMint" | "venue" | "poolQuoteSol"> | undefined,
): PaperBuyableResult {
  if (!snap) return { ok: true };
  if (!isSolQuoteMint(snap.quoteMint)) {
    return {
      ok: false,
      kind: "unsupported_quote",
      reason: "paper_unbuyable_non_sol_pair",
      detail: `paired with ${String(snap.quoteMint).slice(0, 6)}…, not SOL — live can't buy it with SOL`,
    };
  }
  if (
    snap.venue === "pumpswap" &&
    typeof snap.poolQuoteSol === "number" &&
    snap.poolQuoteSol < PUMPSWAP_THIN_POOL_FLOOR_SOL
  ) {
    return {
      ok: false,
      kind: "pool_too_thin",
      reason: "paper_unbuyable_thin_pool",
      detail: `PumpSwap pool ~${snap.poolQuoteSol.toFixed(1)} SOL real (< ${PUMPSWAP_THIN_POOL_FLOOR_SOL.toFixed(1)}) — live skips pools this thin`,
    };
  }
  return { ok: true };
}
