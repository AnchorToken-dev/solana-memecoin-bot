/**
 * LIVE startup reconciliation (pure planning; the engine executes the plan).
 *
 * Compares positions restored from disk with the wallet's SPL balances
 * (Token + Token-2022) and with the bot's own buy records:
 *  - restored position, ~0 tokens in wallet → "missing": closed in the journal
 *    as reconciled_missing, NO sell attempted
 *  - restored position, fewer tokens than recorded → qty lowered to the wallet
 *  - wallet holds a mint the BOT bought (confirmed live buy fill with a
 *    signature, or an unconfirmed-buy event with a signature) in the lookback
 *    window, with no later bot sell, and no open position → "adopt"
 *  - any other wallet token (coins Mark already held, dust) → ignored, never touched
 */
import type { Fill, Position } from "../types.js";

export const RECONCILE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
/** ≤ 0.1% of the recorded qty left = the tokens are gone. */
export const MISSING_FRACTION = 0.001;
/** Wallet below 98% of the recorded qty → track the wallet amount. */
export const ADJUST_FRACTION = 0.98;
/** Orphan smaller than 5% of what the bot bought = dust; not adopted. */
export const ADOPT_MIN_FRACTION = 0.05;

export interface BotBuyEvent {
  kind: string;
  mint: string;
  symbol: string;
  signature?: string | null;
  timestamp: number;
}

export interface OrphanCandidate {
  mint: string;
  symbol: string;
  walletQty: number;
  programIds: string[];
  /** Last confirmed live buy fill (entry price source), if any. */
  fill: Fill | null;
  /** Unconfirmed-buy event (sent, outcome unknown), used when there's no fill. */
  event: BotBuyEvent | null;
}

export interface ReconcilePlan {
  missing: Position[];
  adjusted: Array<{ position: Position; walletQty: number }>;
  adopt: OrphanCandidate[];
  /** Bot-bought mints still in the wallet that were NOT adopted, with why. */
  skipped: Array<{ mint: string; symbol: string; why: string }>;
  /** Wallet mints the bot never bought (left alone). */
  ignoredUnrelated: number;
}

function isBotLiveBuy(f: Fill): boolean {
  return f.side === "buy" && f.paper === false && f.mode === "live" && typeof f.signature === "string" && f.signature.length > 0;
}

export function planReconciliation(input: {
  now: number;
  positions: Position[];
  wallet: Map<string, { qty: number; programIds: string[] }>;
  fills: Fill[];
  events: BotBuyEvent[];
  lookbackMs?: number;
}): ReconcilePlan {
  const since = input.now - (input.lookbackMs ?? RECONCILE_LOOKBACK_MS);
  const plan: ReconcilePlan = { missing: [], adjusted: [], adopt: [], skipped: [], ignoredUnrelated: 0 };

  for (const pos of input.positions) {
    const w = input.wallet.get(pos.mint)?.qty ?? 0;
    if (w <= pos.qty * MISSING_FRACTION) plan.missing.push(pos);
    else if (w < pos.qty * ADJUST_FRACTION) plan.adjusted.push({ position: pos, walletQty: w });
  }

  // Bot's own buy evidence + last bot sell per mint (any age).
  const lastBuyFill = new Map<string, Fill>();
  const lastSellTs = new Map<string, number>();
  for (const f of input.fills) {
    if (f.mode !== "live" || f.paper !== false) continue;
    if (f.side === "sell") lastSellTs.set(f.mint, Math.max(lastSellTs.get(f.mint) ?? 0, f.timestamp));
    else if (isBotLiveBuy(f) && f.timestamp >= since) {
      const prev = lastBuyFill.get(f.mint);
      if (!prev || f.timestamp >= prev.timestamp) lastBuyFill.set(f.mint, f);
    }
  }
  const lastEvent = new Map<string, BotBuyEvent>();
  for (const e of input.events) {
    if (e.kind !== "live_buy_unconfirmed" || !e.signature || e.timestamp < since) continue;
    const prev = lastEvent.get(e.mint);
    if (!prev || e.timestamp >= prev.timestamp) lastEvent.set(e.mint, e);
  }

  const open = new Set(input.positions.map((p) => p.mint));
  for (const [mint, w] of input.wallet) {
    if (open.has(mint) || !(w.qty > 0)) continue;
    const fill = lastBuyFill.get(mint) ?? null;
    const event = lastEvent.get(mint) ?? null;
    if (!fill && !event) {
      plan.ignoredUnrelated++;
      continue;
    }
    const symbol = fill?.symbol ?? event?.symbol ?? mint.slice(0, 6);
    const buyTs = Math.max(fill?.timestamp ?? 0, event?.timestamp ?? 0);
    if (buyTs <= (lastSellTs.get(mint) ?? 0)) {
      plan.skipped.push({ mint, symbol, why: "the bot already sold this coin after its last buy (leftover tokens left alone)" });
      continue;
    }
    if (fill && w.qty < fill.qty * ADOPT_MIN_FRACTION) {
      plan.skipped.push({ mint, symbol, why: `only dust left (${w.qty} of ${fill.qty} bought)` });
      continue;
    }
    // Prefer the confirmed fill unless a newer unconfirmed buy exists.
    const useFill = fill && (!event || fill.timestamp >= event.timestamp) ? fill : null;
    plan.adopt.push({ mint, symbol, walletQty: w.qty, programIds: w.programIds, fill: useFill, event: useFill ? null : event });
  }
  return plan;
}
