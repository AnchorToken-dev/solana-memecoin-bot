/**
 * Realistic paper trading costs for pump.fun coins.
 *
 * Every number here is a documented, current rate (see docs/paper-fees.md for
 * sources). All of them can be changed from env — see .env.example
 * "Paper trading costs".
 *
 * Per BUY  : pump.fun (or PumpSwap) trading fee + PumpPortal fee
 *            + network base fee + priority fee + token-account rent
 *            + entry slippage (price only, never also counted as a fee)
 * Per SELL : pump.fun (or PumpSwap) trading fee + PumpPortal fee
 *            + network base fee + priority fee
 *            + exit slippage
 *
 * Token-account rent is a cost because sells don't close the account, so the
 * rent deposit (0.00148844 SOL on mainnet today) is never refunded.
 */

/** realistic = the itemised model below. legacy = the old flat FEE_BPS + SLIPPAGE_BPS. */
export type PaperFeeModelName = "realistic" | "legacy";
/** Where the coin trades: still on the pump.fun bonding curve, or graduated to PumpSwap. */
export type PaperVenue = "bonding_curve" | "pumpswap";
export type PaperSlippageModel = "liquidity" | "flat";

export interface PaperFeeSettings {
  model: PaperFeeModelName;
  /** pump.fun bonding-curve total trading fee per side (bps). Doc: 1.25%. */
  pumpCurveFeeBps: number;
  /**
   * PumpSwap (graduated) fee per side (bps). null = use pump.fun's official
   * market-cap tier table for canonical pools (1.25% → 0.30%).
   */
  pumpSwapFeeBps: number | null;
  /** PumpPortal Local Transaction API fee per side (bps). Doc: 0.5%. 0 = off. */
  pumpPortalFeeBps: number;
  /** Solana base fee per transaction, SOL (5,000 lamports per signature). */
  baseFeeSol: number;
  /** Priority fee per transaction, SOL (bot's LIVE_PRIORITY_FEE_SOL default). */
  priorityFeeSol: number;
  /**
   * Rent for the new token account on the first buy of a coin, SOL.
   * 165-byte SPL account × current lamports_per_byte (5,080 after SIMD-0437
   * step 2 → 1,488,440 lamports). Drops again when steps 3–5 activate.
   */
  tokenAccountRentSol: number;
  /** liquidity = base + size/liquidity impact; flat = SLIPPAGE_BPS every trade. */
  slippageModel: PaperSlippageModel;
  /** Always-on slippage per side in the liquidity model (other bots, latency). */
  slippageBaseBps: number;
  /** Cap on slippage per side (bps). */
  slippageMaxBps: number;
  /** Venue to assume when the market data doesn't say. */
  defaultVenue: PaperVenue;
  /** SOL/USD used for SOL-denominated costs when no live rate is available. */
  solUsdFallback: number;
}

export const PAPER_FEE_DEFAULTS: Readonly<PaperFeeSettings> = Object.freeze({
  model: "realistic",
  pumpCurveFeeBps: 125,
  pumpSwapFeeBps: null,
  pumpPortalFeeBps: 50,
  baseFeeSol: 0.000005,
  priorityFeeSol: 0.0002,
  tokenAccountRentSol: 0.00148844,
  slippageModel: "liquidity",
  slippageBaseBps: 25,
  slippageMaxBps: 300,
  defaultVenue: "bonding_curve",
  solUsdFallback: 150,
});

/** pump.fun supply is a fixed 1 billion tokens (market cap = price × 1B). */
export const PUMP_TOKEN_SUPPLY = 1_000_000_000;

/**
 * PumpSwap canonical-pool total fee by market cap in SOL (pump.fun/docs/fees).
 * [lower bound in SOL, total fee bps]. Sorted ascending.
 */
export const PUMPSWAP_SOL_FEE_TIERS: ReadonlyArray<readonly [number, number]> = [
  [0, 125],
  [420, 120],
  [1_470, 115],
  [2_460, 110],
  [3_440, 105],
  [4_420, 100],
  [9_820, 95],
  [14_740, 90],
  [19_650, 85],
  [24_560, 80],
  [29_470, 75],
  [34_380, 70],
  [39_300, 65],
  [44_210, 60],
  [49_120, 55],
  [54_030, 52.5],
  [58_940, 50],
  [63_860, 47.5],
  [68_770, 45],
  [73_681, 42.5],
  [78_590, 40],
  [83_500, 37.5],
  [88_400, 35],
  [93_330, 32.5],
  [98_240, 30],
];

export function pumpSwapTierFeeBps(marketCapSol: number): number {
  let bps = PUMPSWAP_SOL_FEE_TIERS[0]![1];
  if (!(marketCapSol > 0)) return bps;
  for (const [floor, tierBps] of PUMPSWAP_SOL_FEE_TIERS) {
    if (marketCapSol >= floor) bps = tierBps;
    else break;
  }
  return bps;
}

/** pump.fun / PumpSwap trading fee per side, in bps. */
export function venueFeeBps(
  s: PaperFeeSettings,
  venue: PaperVenue,
  priceUsd: number,
  solUsd: number,
): number {
  if (venue === "bonding_curve") return s.pumpCurveFeeBps;
  if (s.pumpSwapFeeBps != null) return s.pumpSwapFeeBps;
  const mcapSol = solUsd > 0 ? (priceUsd * PUMP_TOKEN_SUPPLY) / solUsd : 0;
  return pumpSwapTierFeeBps(mcapSol);
}

/**
 * Slippage per side in bps. Liquidity model: base + constant-product price
 * impact (trade size ÷ pool liquidity), capped. Unknown liquidity or the flat
 * model → `flatBps` (SLIPPAGE_BPS). Applied to the fill price only.
 */
export function slippageBps(
  s: PaperFeeSettings,
  notionalUsd: number,
  liquidityUsd: number | undefined,
  flatBps: number,
): number {
  const cap = Math.max(0, s.slippageMaxBps);
  if (s.slippageModel === "flat" || !(typeof liquidityUsd === "number" && liquidityUsd > 0)) {
    return Math.min(cap, Math.max(0, flatBps));
  }
  const impact = (Math.max(0, notionalUsd) / liquidityUsd) * 10_000;
  return Math.min(cap, Math.max(0, s.slippageBaseBps) + impact);
}

export interface FeeBreakdown {
  side: "buy" | "sell";
  venue: PaperVenue;
  /** pump.fun / PumpSwap fee rate used (bps). */
  venueFeeBps: number;
  /** pump.fun / PumpSwap trading fee (USD). */
  venueFeeUsd: number;
  pumpPortalFeeUsd: number;
  /** Base + priority fee (USD). */
  networkFeeUsd: number;
  /** Token-account rent (buy only; 0 on sells). */
  rentUsd: number;
  /** Sum of the fees above (USD). Slippage is NOT included. */
  totalFeesUsd: number;
  /** Price slippage applied to the fill (bps / USD). */
  slippageBps: number;
  slippageUsd: number;
  /** SOL/USD used to price SOL costs. */
  solUsd: number;
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export interface BuyCostInput {
  notionalUsd: number;
  markPrice: number;
  solUsd?: number | null;
  venue?: PaperVenue;
  liquidityUsd?: number;
  /** SLIPPAGE_BPS fallback (unknown liquidity / flat model). */
  flatSlippageBps: number;
}

/**
 * Buy: the whole trade size leaves the wallet; fees and rent come out of it,
 * the rest buys tokens at the slipped price.
 */
export function computeBuyCosts(s: PaperFeeSettings, i: BuyCostInput): {
  fillPrice: number;
  qty: number;
  breakdown: FeeBreakdown;
} {
  const solUsd = i.solUsd != null && i.solUsd > 0 ? i.solUsd : s.solUsdFallback;
  const venue = i.venue ?? s.defaultVenue;
  const vBps = venueFeeBps(s, venue, i.markPrice, solUsd);
  const venueFeeUsd = i.notionalUsd * (vBps / 10_000);
  const pumpPortalFeeUsd = i.notionalUsd * (s.pumpPortalFeeBps / 10_000);
  const networkFeeUsd = (s.baseFeeSol + s.priorityFeeSol) * solUsd;
  const rentUsd = s.tokenAccountRentSol * solUsd;
  const totalFeesUsd = venueFeeUsd + pumpPortalFeeUsd + networkFeeUsd + rentUsd;
  const spendable = Math.max(0, i.notionalUsd - totalFeesUsd);
  const slip = slippageBps(s, i.notionalUsd, i.liquidityUsd, i.flatSlippageBps);
  const fillPrice = i.markPrice * (1 + slip / 10_000);
  const qty = fillPrice > 0 ? spendable / fillPrice : 0;
  const slippageUsd = spendable - spendable / (1 + slip / 10_000);
  return {
    fillPrice,
    qty,
    breakdown: {
      side: "buy",
      venue,
      venueFeeBps: vBps,
      venueFeeUsd: round6(venueFeeUsd),
      pumpPortalFeeUsd: round6(pumpPortalFeeUsd),
      networkFeeUsd: round6(networkFeeUsd),
      rentUsd: round6(rentUsd),
      totalFeesUsd: round6(Math.min(totalFeesUsd, i.notionalUsd)),
      slippageBps: Math.round(slip * 100) / 100,
      slippageUsd: round6(slippageUsd),
      solUsd,
    },
  };
}

export interface SellCostInput {
  qty: number;
  markPrice: number;
  solUsd?: number | null;
  venue?: PaperVenue;
  /** Pool liquidity at exit (USD), if known. */
  liquidityUsd?: number;
  flatSlippageBps: number;
}

/** Sell: tokens go out at the slipped price; fees come out of the SOL received. */
export function computeSellCosts(s: PaperFeeSettings, i: SellCostInput): {
  fillPrice: number;
  grossUsd: number;
  proceedsUsd: number;
  breakdown: FeeBreakdown;
} {
  const solUsd = i.solUsd != null && i.solUsd > 0 ? i.solUsd : s.solUsdFallback;
  const venue = i.venue ?? s.defaultVenue;
  const markValue = i.qty * i.markPrice;
  const slip = slippageBps(s, markValue, i.liquidityUsd, i.flatSlippageBps);
  const fillPrice = i.markPrice * Math.max(0, 1 - slip / 10_000);
  const grossUsd = i.qty * fillPrice;
  const vBps = venueFeeBps(s, venue, i.markPrice, solUsd);
  const venueFeeUsd = grossUsd * (vBps / 10_000);
  const pumpPortalFeeUsd = grossUsd * (s.pumpPortalFeeBps / 10_000);
  const networkFeeUsd = (s.baseFeeSol + s.priorityFeeSol) * solUsd;
  const rawFees = venueFeeUsd + pumpPortalFeeUsd + networkFeeUsd;
  // Dust: never "pay" more than the sale brings in (you'd just abandon it).
  const totalFeesUsd = Math.min(rawFees, grossUsd);
  const proceedsUsd = grossUsd - totalFeesUsd;
  return {
    fillPrice,
    grossUsd,
    proceedsUsd,
    breakdown: {
      side: "sell",
      venue,
      venueFeeBps: vBps,
      venueFeeUsd: round6(venueFeeUsd),
      pumpPortalFeeUsd: round6(pumpPortalFeeUsd),
      networkFeeUsd: round6(networkFeeUsd),
      rentUsd: 0,
      totalFeesUsd: round6(totalFeesUsd),
      slippageBps: Math.round(slip * 100) / 100,
      slippageUsd: round6(markValue - grossUsd),
      solUsd,
    },
  };
}

/**
 * Pool liquidity at exit, approximated from entry liquidity. In a
 * constant-product pool the SOL side moves with √price.
 */
export function exitLiquidityUsd(
  entryLiquidityUsd: number | undefined,
  entryPrice: number,
  markPrice: number,
): number | undefined {
  if (!(typeof entryLiquidityUsd === "number" && entryLiquidityUsd > 0)) return undefined;
  if (!(entryPrice > 0) || !(markPrice > 0)) return undefined;
  return entryLiquidityUsd * Math.sqrt(markPrice / entryPrice);
}

/** Expected round-trip fees (excl. slippage) for a flat trade — used in docs/tests. */
export function estimateRoundTripFeesUsd(
  s: PaperFeeSettings,
  notionalUsd: number,
  solUsd: number,
  venue: PaperVenue = s.defaultVenue,
): number {
  const b = computeBuyCosts(s, { notionalUsd, markPrice: 1, solUsd, venue, flatSlippageBps: 0 });
  const sell = computeSellCosts(s, {
    qty: b.qty,
    markPrice: 1,
    solUsd,
    venue,
    flatSlippageBps: 0,
  });
  return b.breakdown.totalFeesUsd + sell.breakdown.totalFeesUsd;
}

// ---------------------------------------------------------------- env loading

type Env = Record<string, string | undefined>;

function numEnv(env: Env, key: string, fallback: number, min: number, max: number): number {
  const v = env[key];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid number for env ${key}: ${v}`);
  if (n < min || n > max) throw new Error(`env ${key}=${v} out of range [${min}, ${max}]`);
  return n;
}

/** Read the paper cost model from env (documented in .env.example). */
export function loadPaperFeeSettings(env: Env = process.env): PaperFeeSettings {
  const d = PAPER_FEE_DEFAULTS;
  const modelRaw = (env.PAPER_FEE_MODEL ?? "").trim().toLowerCase();
  const model: PaperFeeModelName = modelRaw === "legacy" ? "legacy" : "realistic";
  if (modelRaw && modelRaw !== "legacy" && modelRaw !== "realistic") {
    throw new Error(`Invalid PAPER_FEE_MODEL=${modelRaw}; allowed: realistic, legacy`);
  }
  const slipRaw = (env.PAPER_SLIPPAGE_MODEL ?? "").trim().toLowerCase();
  if (slipRaw && slipRaw !== "liquidity" && slipRaw !== "flat") {
    throw new Error(`Invalid PAPER_SLIPPAGE_MODEL=${slipRaw}; allowed: liquidity, flat`);
  }
  const venueRaw = (env.PAPER_DEFAULT_VENUE ?? "").trim().toLowerCase();
  if (venueRaw && venueRaw !== "bonding_curve" && venueRaw !== "pumpswap") {
    throw new Error(`Invalid PAPER_DEFAULT_VENUE=${venueRaw}; allowed: bonding_curve, pumpswap`);
  }
  const swapRaw = env.PAPER_PUMPSWAP_FEE_BPS;
  const pumpSwapFeeBps =
    swapRaw === undefined || swapRaw.trim() === "" || swapRaw.trim().toLowerCase() === "tiered"
      ? null
      : numEnv(env, "PAPER_PUMPSWAP_FEE_BPS", 0, 0, 1000);
  // Priority fee: explicit paper value, else the live default so paper ≈ live.
  const prioFallback =
    env.LIVE_PRIORITY_FEE_SOL !== undefined && env.LIVE_PRIORITY_FEE_SOL.trim() !== ""
      ? numEnv(env, "LIVE_PRIORITY_FEE_SOL", d.priorityFeeSol, 0, 0.01)
      : d.priorityFeeSol;
  return {
    model,
    pumpCurveFeeBps: numEnv(env, "PAPER_PUMP_FEE_BPS", d.pumpCurveFeeBps, 0, 1000),
    pumpSwapFeeBps,
    pumpPortalFeeBps: numEnv(env, "PAPER_PUMPPORTAL_FEE_BPS", d.pumpPortalFeeBps, 0, 1000),
    baseFeeSol: numEnv(env, "PAPER_BASE_FEE_SOL", d.baseFeeSol, 0, 0.01),
    priorityFeeSol: numEnv(env, "PAPER_PRIORITY_FEE_SOL", prioFallback, 0, 0.05),
    tokenAccountRentSol: numEnv(env, "PAPER_TOKEN_ACCOUNT_RENT_SOL", d.tokenAccountRentSol, 0, 0.05),
    slippageModel: slipRaw === "flat" ? "flat" : "liquidity",
    slippageBaseBps: numEnv(env, "PAPER_SLIPPAGE_BASE_BPS", d.slippageBaseBps, 0, 5000),
    slippageMaxBps: numEnv(env, "PAPER_SLIPPAGE_MAX_BPS", d.slippageMaxBps, 0, 5000),
    defaultVenue: venueRaw === "pumpswap" ? "pumpswap" : "bonding_curve",
    solUsdFallback: numEnv(env, "PAPER_SOL_USD_FALLBACK", d.solUsdFallback, 1, 100_000),
  };
}
