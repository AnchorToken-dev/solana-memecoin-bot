/**
 * Paper fill pricing that matches Jupiter Swap API economics:
 * no Jupiter swap fee, no PumpPortal fee, route AMM fee + price impact
 * from a live quote when we have one, otherwise a documented offline model.
 *
 * LIVE dry-run does not call this. It still uses computeBuyCosts / computeSellCosts.
 */

import {
  slippageBps,
  type FeeBreakdown,
  type PaperFeeSettings,
  type PaperVenue,
} from "./paperFees.js";
import type { JupiterRouteQuote } from "./jupiterQuote.js";

export const JUPITER_FALLBACK_FEE_BPS_DEFAULT = 25;

export interface JupiterPriceInput {
  notionalUsd?: number;
  qty?: number;
  markPrice: number;
  solUsd?: number | null;
  venue?: PaperVenue;
  liquidityUsd?: number;
  flatSlippageBps: number;
  /** AMM fee used only when `quote` is absent. Default 25 bps (Raydium-class LP fee). */
  fallbackFeeBps?: number;
  quote?: JupiterRouteQuote | null;
  fallbackReason?: string;
  /** Prior when the quote's raw outAmount doesn't reveal decimals. Pump.fun tokens are 6. */
  tokenDecimals?: number;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function solUsdOf(s: PaperFeeSettings, given: number | null | undefined): number {
  return given != null && given > 0 ? given : s.solUsdFallback;
}

export function jupiterNetworkUsd(s: PaperFeeSettings, solUsd: number): number {
  return (s.baseFeeSol + s.priorityFeeSol) * solUsd;
}

export function jupiterRentUsd(s: PaperFeeSettings, solUsd: number): number {
  return s.tokenAccountRentSol * solUsd;
}

/**
 * SOL lamports to send as Jupiter exact-in. Network + token-account rent come
 * out of the paper trade size first (same cash identity as the curve model:
 * the whole notional leaves the wallet).
 */
export function solLamportsForBuy(
  s: PaperFeeSettings,
  notionalUsd: number,
  solUsd: number,
): { amountRaw: string; spendableUsd: number; overheadUsd: number } | null {
  if (!(solUsd > 0) || !(notionalUsd > 0)) return null;
  const overheadUsd = jupiterNetworkUsd(s, solUsd) + jupiterRentUsd(s, solUsd);
  const spendableUsd = notionalUsd - overheadUsd;
  if (!(spendableUsd > 0)) return null;
  const lamports = Math.floor((spendableUsd / solUsd) * 1e9);
  if (!(lamports > 0)) return null;
  return { amountRaw: String(lamports), spendableUsd, overheadUsd };
}

export function tokenRawAmount(qty: number, decimals: number): string {
  if (!(qty > 0) || !Number.isInteger(decimals) || decimals < 0 || decimals > 12) return "0";
  const raw = Math.round(qty * 10 ** decimals);
  if (!Number.isFinite(raw) || raw <= 0) return "0";
  return String(Math.min(raw, Number.MAX_SAFE_INTEGER));
}

/**
 * Pick token decimals so the quoted raw amount lands near the mark.
 * A wrong decimal is ~10× off; a real AMM fee is not.
 */
export function inferTokenDecimals(
  outRaw: number,
  valueUsd: number,
  markPrice: number,
  prior = 6,
): number {
  if (!(outRaw > 0) || !(valueUsd > 0) || !(markPrice > 0)) return prior;
  let best = prior;
  let bestErr = Infinity;
  for (let d = 0; d <= 12; d++) {
    const qty = outRaw / 10 ** d;
    if (!(qty > 0)) continue;
    const px = valueUsd / qty;
    const err = Math.abs(Math.log(px / markPrice));
    if (err < bestErr) {
      bestErr = err;
      best = d;
    }
  }
  if (bestErr < Math.log(5)) return best;
  return prior;
}

function dragSplit(
  markValueUsd: number,
  executedValueUsd: number,
  impactRatio: number,
): { slippageUsd: number; venueFeeUsd: number; slippageBps: number } {
  const drag = Math.max(0, markValueUsd - executedValueUsd);
  const impact = Math.max(0, impactRatio);
  const slipUsd = Math.min(drag, (markValueUsd * impact) / (1 + impact));
  return {
    slippageUsd: round6(slipUsd),
    venueFeeUsd: round6(Math.max(0, drag - slipUsd)),
    slippageBps: Math.round(impact * 10_000 * 100) / 100,
  };
}

function rawToNumber(raw: string): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function priceJupiterBuy(
  s: PaperFeeSettings,
  i: JupiterPriceInput,
): { fillPrice: number; qty: number; tokenDecimals: number; breakdown: FeeBreakdown } {
  const solUsd = solUsdOf(s, i.solUsd);
  const notional = i.notionalUsd ?? 0;
  const venue = i.venue ?? "pumpswap";
  const prior = i.tokenDecimals ?? 6;
  const overhead = jupiterNetworkUsd(s, solUsd) + jupiterRentUsd(s, solUsd);
  const spendable = Math.max(0, notional - overhead);
  const quote = i.quote ?? null;

  if (quote && spendable > 0 && i.markPrice > 0) {
    const outRaw = rawToNumber(quote.outAmountRaw);
    const decimals = inferTokenDecimals(outRaw, spendable, i.markPrice, prior);
    const qty = outRaw / 10 ** decimals;
    const fillPrice = qty > 0 ? spendable / qty : i.markPrice;
    const executed = qty * i.markPrice;
    const drag = dragSplit(spendable, executed, quote.priceImpactPct);
    const venueFeeUsd = drag.venueFeeUsd;
    const totalFeesUsd = Math.min(notional, overhead + venueFeeUsd);
    return {
      fillPrice,
      qty: qty > 0 ? qty : 0,
      tokenDecimals: decimals,
      breakdown: breakdown({
        side: "buy",
        venue,
        venueFeeBps: notional > 0 ? (venueFeeUsd / notional) * 10_000 : 0,
        venueFeeUsd,
        pumpPortalFeeUsd: 0,
        networkFeeUsd: jupiterNetworkUsd(s, solUsd),
        rentUsd: jupiterRentUsd(s, solUsd),
        totalFeesUsd,
        slippageBps: drag.slippageBps,
        slippageUsd: drag.slippageUsd,
        solUsd,
        fillSource: quote.source,
        route: quote.route,
        jupiterFeeBps: quote.jupiterFeeBps,
      }),
    };
  }

  const ammBps = i.fallbackFeeBps ?? JUPITER_FALLBACK_FEE_BPS_DEFAULT;
  const venueFeeUsd = notional * (ammBps / 10_000);
  const networkFeeUsd = jupiterNetworkUsd(s, solUsd);
  const rentUsd = jupiterRentUsd(s, solUsd);
  const totalFeesUsd = Math.min(notional, venueFeeUsd + networkFeeUsd + rentUsd);
  const spend = Math.max(0, notional - totalFeesUsd);
  const slip = slippageBps(s, notional, i.liquidityUsd, i.flatSlippageBps);
  const fillPrice = i.markPrice * (1 + slip / 10_000);
  const qty = fillPrice > 0 ? spend / fillPrice : 0;
  const slippageUsd = spend - spend / (1 + slip / 10_000);
  return {
    fillPrice,
    qty,
    tokenDecimals: prior,
    breakdown: breakdown({
      side: "buy",
      venue,
      venueFeeBps: ammBps,
      venueFeeUsd,
      pumpPortalFeeUsd: 0,
      networkFeeUsd,
      rentUsd,
      totalFeesUsd,
      slippageBps: Math.round(slip * 100) / 100,
      slippageUsd,
      solUsd,
      fillSource: "fallback",
      route: "offline_fallback",
      jupiterFeeBps: 0,
      ...(i.fallbackReason ? { fallbackReason: i.fallbackReason } : {}),
    }),
  };
}

export function priceJupiterSell(
  s: PaperFeeSettings,
  i: JupiterPriceInput,
): { fillPrice: number; grossUsd: number; proceedsUsd: number; breakdown: FeeBreakdown } {
  const solUsd = solUsdOf(s, i.solUsd);
  const qty = i.qty ?? 0;
  const venue = i.venue ?? "pumpswap";
  const markValue = qty * i.markPrice;
  const quote = i.quote ?? null;
  const networkFeeUsd = jupiterNetworkUsd(s, solUsd);

  if (quote && markValue > 0) {
    const outLamports = rawToNumber(quote.outAmountRaw);
    const quotedUsd = (outLamports / 1e9) * solUsd;
    const drag = dragSplit(markValue, quotedUsd, quote.priceImpactPct);
    const rawFees = drag.venueFeeUsd + networkFeeUsd;
    const totalFeesUsd = Math.min(rawFees, Math.max(quotedUsd, 0));
    const proceedsUsd = Math.max(0, quotedUsd - networkFeeUsd);
    const fillPrice = qty > 0 ? quotedUsd / qty : 0;
    return {
      fillPrice,
      grossUsd: quotedUsd,
      proceedsUsd,
      breakdown: breakdown({
        side: "sell",
        venue,
        venueFeeBps: markValue > 0 ? (drag.venueFeeUsd / markValue) * 10_000 : 0,
        venueFeeUsd: drag.venueFeeUsd,
        pumpPortalFeeUsd: 0,
        networkFeeUsd,
        rentUsd: 0,
        totalFeesUsd,
        slippageBps: drag.slippageBps,
        slippageUsd: drag.slippageUsd,
        solUsd,
        fillSource: quote.source,
        route: quote.route,
        jupiterFeeBps: quote.jupiterFeeBps,
      }),
    };
  }

  const ammBps = i.fallbackFeeBps ?? JUPITER_FALLBACK_FEE_BPS_DEFAULT;
  const slip = slippageBps(s, markValue, i.liquidityUsd, i.flatSlippageBps);
  const fillPrice = i.markPrice * Math.max(0, 1 - slip / 10_000);
  const grossUsd = qty * fillPrice;
  const venueFeeUsd = grossUsd * (ammBps / 10_000);
  const rawFees = venueFeeUsd + networkFeeUsd;
  const totalFeesUsd = Math.min(rawFees, grossUsd);
  const proceedsUsd = grossUsd - totalFeesUsd;
  const slippageUsd = markValue - grossUsd;
  return {
    fillPrice,
    grossUsd,
    proceedsUsd,
    breakdown: breakdown({
      side: "sell",
      venue,
      venueFeeBps: ammBps,
      venueFeeUsd,
      pumpPortalFeeUsd: 0,
      networkFeeUsd,
      rentUsd: 0,
      totalFeesUsd,
      slippageBps: Math.round(slip * 100) / 100,
      slippageUsd,
      solUsd,
      fillSource: "fallback",
      route: "offline_fallback",
      jupiterFeeBps: 0,
      ...(i.fallbackReason ? { fallbackReason: i.fallbackReason } : {}),
    }),
  };
}

function breakdown(b: FeeBreakdown): FeeBreakdown {
  return {
    ...b,
    venueFeeBps: Math.round(b.venueFeeBps * 100) / 100,
    venueFeeUsd: round6(b.venueFeeUsd),
    pumpPortalFeeUsd: round6(b.pumpPortalFeeUsd),
    networkFeeUsd: round6(b.networkFeeUsd),
    rentUsd: round6(b.rentUsd),
    totalFeesUsd: round6(b.totalFeesUsd),
    slippageUsd: round6(b.slippageUsd),
    solUsd: b.solUsd,
  };
}

export interface PaperJupiterSettings {
  timeoutMs: number;
  slippageBps: number;
  fallbackFeeBps: number;
  tokenDecimals: number;
  quoteAttempts: number;
  taker?: string;
}

export interface PaperExecutionSettings {
  fillVenue: "jupiter" | "curve";
  discovery: "broad" | "pump";
  jupiter: PaperJupiterSettings;
}

type Env = Record<string, string | undefined>;

function numEnv(env: Env, key: string, fallback: number, min: number, max: number): number {
  const v = env[key];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for env ${key}: ${v}`);
  if (n < min || n > max) throw new Error(`env ${key}=${v} out of range [${min}, ${max}]`);
  return n;
}

/** PAPER_FILL_VENUE / PAPER_DISCOVERY and the Jupiter quote knobs. No secrets. */
export function loadPaperExecutionSettings(env: Env = process.env): PaperExecutionSettings {
  const venueRaw = (env.PAPER_FILL_VENUE ?? "").trim().toLowerCase();
  if (venueRaw && venueRaw !== "jupiter" && venueRaw !== "curve") {
    throw new Error(`Invalid PAPER_FILL_VENUE=${venueRaw}; allowed: jupiter, curve`);
  }
  const fillVenue = venueRaw === "curve" ? "curve" : "jupiter";
  const discRaw = (env.PAPER_DISCOVERY ?? "").trim().toLowerCase();
  if (discRaw && discRaw !== "broad" && discRaw !== "pump") {
    throw new Error(`Invalid PAPER_DISCOVERY=${discRaw}; allowed: broad, pump`);
  }
  const discovery: PaperExecutionSettings["discovery"] =
    discRaw === "broad" || discRaw === "pump" ? discRaw : fillVenue === "jupiter" ? "broad" : "pump";
  const taker = (env.PAPER_JUPITER_TAKER ?? "").trim();
  if (taker && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(taker)) {
    throw new Error("Invalid PAPER_JUPITER_TAKER (expected a Solana public key; paper never signs it)");
  }
  const jupiter: PaperJupiterSettings = {
    timeoutMs: numEnv(env, "PAPER_JUPITER_TIMEOUT_MS", 2_500, 250, 20_000),
    slippageBps: numEnv(env, "PAPER_JUPITER_SLIPPAGE_BPS", 50, 0, 5_000),
    fallbackFeeBps: numEnv(env, "PAPER_JUPITER_FALLBACK_FEE_BPS", JUPITER_FALLBACK_FEE_BPS_DEFAULT, 0, 1_000),
    tokenDecimals: Math.round(numEnv(env, "PAPER_JUPITER_TOKEN_DECIMALS", 6, 0, 12)),
    quoteAttempts: Math.round(numEnv(env, "PAPER_JUPITER_QUOTE_ATTEMPTS", 5, 1, 8)),
    ...(taker ? { taker } : {}),
  };
  return { fillVenue, discovery, jupiter };
}

export function describePaperFill(
  side: "BUY" | "SELL",
  symbol: string,
  b: FeeBreakdown,
): string {
  const source = b.fillSource ?? "curve";
  const route = b.route ?? b.venue;
  const why = b.fallbackReason ? ` (${b.fallbackReason})` : "";
  return (
    `Paper fill ${side} ${symbol}: source=${source} route=${route} ` +
    `jupiterFee=${b.jupiterFeeBps ?? 0}bps ammFee=${b.venueFeeBps}bps ` +
    `slippage=${b.slippageBps}bps fees=$${b.totalFeesUsd.toFixed(4)} ` +
    `slippageUsd=$${b.slippageUsd.toFixed(4)}${why}`
  );
}
