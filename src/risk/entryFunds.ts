/**
 * Full-size-or-nothing entry funding checks.
 *
 * A new position is ALWAYS the selected trade size (tradeSize.effectiveUsd —
 * the $15/$30/$60 button, already clamped to the active cap). If the money
 * isn't there for the full size plus the costs charged on top of it, the buy
 * is skipped — it is never shrunk to whatever cash is left. Tiny positions
 * (e.g. $3 after a vault skim) can't cover the fixed costs (~$0.23 rent +
 * network) and are near-guaranteed losers.
 *
 * Pure functions, no I/O.
 */

export type BuyingPausedReason = "insufficient_cash" | "insufficient_sol" | "size_above_cap";

export interface BuyingPausedStatus {
  reason: BuyingPausedReason;
  /** Plain-English, safe to show on screen / in an alert. */
  message: string;
  /** Trade size the bot is waiting to be able to afford. */
  sizeUsd: number;
  /** Tradable cash (or spendable wallet SOL in USD) at the last check. */
  availableUsd: number | null;
  /** What a full-size buy needs (size + costs charged on top). */
  neededUsd: number | null;
  /** When buying was paused (ms). */
  since: number;
}

export type EntryFundsCheck =
  | { ok: true }
  | { ok: false; reason: BuyingPausedReason; message: string; availableUsd: number | null; neededUsd: number | null };

/** "$15" for whole dollars, "$15.25" otherwise. */
export function fmtUsd(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? `$${r}` : `$${r.toFixed(2)}`;
}

const EPS = 1e-9;

/**
 * Tradable cash (paper / dry-run ledger, live bookkeeping) vs the full size.
 * extraCostsUsd = costs charged ON TOP of the size by the active cost model
 * (0 when fees come out of the size, as in the realistic paper model).
 * capUsd/capName: a cap that would otherwise have shrunk the buy.
 */
export function checkEntryCash(args: {
  sizeUsd: number;
  cashUsd: number;
  extraCostsUsd?: number;
  capUsd?: number | null;
  capName?: string;
}): EntryFundsCheck {
  const size = args.sizeUsd;
  if (args.capUsd != null && args.capUsd > 0 && size > args.capUsd + EPS) {
    const cap = args.capName ?? "the position cap";
    return {
      ok: false,
      reason: "size_above_cap",
      message: `Trade size ${fmtUsd(size)} is above ${cap} (${fmtUsd(args.capUsd)}) — buying paused; pick a smaller trade size or raise ${cap} (the bot never buys smaller than the selected size)`,
      availableUsd: null,
      neededUsd: null,
    };
  }
  const extra = Math.max(0, args.extraCostsUsd ?? 0);
  const needed = size + extra;
  const cash = Number.isFinite(args.cashUsd) ? args.cashUsd : 0;
  if (cash + EPS >= needed) return { ok: true };
  const needs = extra >= 0.005 ? `needs ${fmtUsd(needed)} incl. costs, ` : "";
  return {
    ok: false,
    reason: "insufficient_cash",
    message: `Not enough cash for a ${fmtUsd(size)} trade (${needs}$${Math.max(0, cash).toFixed(2)} available) — buying paused until cash is added or the vault is moved back`,
    availableUsd: Math.max(0, cash),
    neededUsd: needed,
  };
}

/** Rent for the new token account (Token-2022 ATA ≈ 0.00207 SOL; rounded up). */
export const LIVE_BUY_RENT_SOL = 0.0021;
/** Base network fee per signature. */
export const LIVE_BUY_BASE_FEE_SOL = 0.000005;
/** pump.fun / PumpSwap + PumpPortal fees may be charged on top of the SOL amount. */
export const LIVE_BUY_FEE_BUFFER_PCT = 2;

/** SOL a live buy may cost on top of the trade amount (priority cap + rent + base fee + venue fees). */
export function liveBuyOverheadSol(solAmount: number, priorityFeeMaxSol: number): number {
  return priorityFeeMaxSol + LIVE_BUY_RENT_SOL + LIVE_BUY_BASE_FEE_SOL + solAmount * (LIVE_BUY_FEE_BUFFER_PCT / 100);
}

/**
 * Live wallet: spendable SOL = balance − min reserve − priority-fee cap − rent − fees.
 * Must cover the FULL trade amount; never shrinks the buy.
 */
export function checkLiveWalletFunds(args: {
  balanceSol: number;
  sizeUsd: number;
  solUsd: number;
  minSolReserve: number;
  priorityFeeMaxSol: number;
}): EntryFundsCheck & { neededSol: number; spendableSol: number } {
  const solAmount = args.sizeUsd / args.solUsd;
  const overhead = liveBuyOverheadSol(solAmount, args.priorityFeeMaxSol);
  const neededSol = solAmount + overhead + args.minSolReserve;
  // Spendable for the trade itself, after the reserve and every cost charged on top.
  const spendableSol = Math.max(0, args.balanceSol - args.minSolReserve - overhead);
  if (args.balanceSol + EPS >= neededSol) return { ok: true, neededSol, spendableSol };
  const spendableUsd = spendableSol * args.solUsd;
  return {
    ok: false,
    reason: "insufficient_sol",
    message: `Not enough SOL in the wallet for a ${fmtUsd(args.sizeUsd)} trade ($${spendableUsd.toFixed(2)} spendable after the ${args.minSolReserve} SOL reserve, fees and rent) — buying paused until SOL is added or the vault is moved back`,
    availableUsd: spendableUsd,
    neededUsd: args.sizeUsd,
    neededSol,
    spendableSol,
  };
}
