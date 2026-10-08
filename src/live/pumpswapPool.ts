/**
 * PumpSwap (pump.fun AMM) canonical pool reader — read-only, used to correct
 * PumpPortal's buy quote on "boost" pools.
 *
 * Why: since PumpSwap's boost upgrade every pool carries a pricing-only
 * `virtual_quote_reserves` (~17.6 SOL on graduated pump.fun coins). The
 * program prices buys off real + virtual SOL, but PumpPortal's trade-local
 * builder still quotes off the real SOL in the vault. So it asks for
 * (real+virtual)/real too many tokens per SOL and caps the spend at
 * amount × (1 + slippage). On young pools (real SOL under ~117) that gap is
 * bigger than 15% and the buy fails every time with ExceededSlippage (6004),
 * no matter how calm the price is. Verified 2026-10-08 by simulation: the
 * "needed vs allowed" numbers matched (real+virtual)/real to 3 decimals.
 *
 * Correction: request amount ÷ gap with slippage widened so the SOL cap stays
 * exactly amount × (1 + slippage). Max spend never goes up; if PumpPortal
 * fixes its quote we just buy slightly less.
 */
import { base58Encode } from "../solana/base58.js";
import { findProgramAddress, toBytes32 } from "../solana/pda.js";

export const PUMP_CURVE_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMPSWAP_PROGRAM_ID = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";
/** pump.fun API reports SOL-quoted coins with the System Program id. */
const SOL_QUOTE_ALIASES = new Set([WSOL_MINT, "11111111111111111111111111111111"]);

const POOL_DISCRIMINATOR = [241, 154, 109, 4, 17, 177, 109, 188];
// Pool layout (pump_amm IDL): 8 disc | u8 bump | u16 index | creator | base_mint |
// quote_mint | lp_mint | pool_base_token_account | pool_quote_token_account |
// u64 lp_supply | coin_creator | bool mayhem | bool cashback | i128 virtual_quote_reserves | …
const OFF_BASE_MINT = 43;
const OFF_QUOTE_MINT = 75;
const OFF_POOL_QUOTE_ACCOUNT = 171;
const OFF_VIRTUAL_QUOTE = 245;

/** Above this gap (pool real SOL under ~29) we skip: too thin to trust. */
export const MAX_PUMPSWAP_QUOTE_GAP = 1.6;
/** Virtual SOL on graduated pump.fun pools (observed 17.58 SOL, Oct 2026). */
export const TYPICAL_PUMPSWAP_VIRTUAL_QUOTE_SOL = 17.6;
/**
 * Real SOL below which live skips a PumpSwap pool as too thin (gap > MAX):
 * virtual / (MAX − 1) ≈ 29.3 SOL. Paper uses this as an estimate (live reads
 * the pool's actual virtual reserves on-chain).
 */
export const PUMPSWAP_THIN_POOL_FLOOR_SOL = TYPICAL_PUMPSWAP_VIRTUAL_QUOTE_SOL / (MAX_PUMPSWAP_QUOTE_GAP - 1);

export function isSolQuoteMint(mint: string | null | undefined): boolean {
  return mint == null || mint === "" || SOL_QUOTE_ALIASES.has(mint);
}

/** Canonical PumpSwap pool a graduated pump.fun coin migrates into (SOL quote, index 0). */
export function canonicalPumpSwapPool(mint: string): string {
  const m = toBytes32(mint);
  const auth = findProgramAddress([Buffer.from("pool-authority"), m], PUMP_CURVE_PROGRAM_ID).address;
  return findProgramAddress(
    [Buffer.from("pool"), new Uint8Array(2), toBytes32(auth), m, toBytes32(WSOL_MINT)],
    PUMPSWAP_PROGRAM_ID,
  ).address;
}

export interface PumpSwapPoolInfo {
  baseMint: string;
  quoteMint: string;
  poolQuoteAccount: string;
  /** Lamports; 0 for legacy (non-boost) pools. */
  virtualQuoteLamports: bigint;
}

export function parsePumpSwapPool(data: Uint8Array): PumpSwapPoolInfo | null {
  if (data.length < OFF_POOL_QUOTE_ACCOUNT + 32) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== POOL_DISCRIMINATOR[i]) return null;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  let virtualQuoteLamports = 0n;
  if (data.length >= OFF_VIRTUAL_QUOTE + 16) {
    const lo = buf.readBigUInt64LE(OFF_VIRTUAL_QUOTE);
    const hi = buf.readBigInt64LE(OFF_VIRTUAL_QUOTE + 8);
    virtualQuoteLamports = (hi << 64n) + lo;
  }
  return {
    baseMint: base58Encode(data.subarray(OFF_BASE_MINT, OFF_BASE_MINT + 32)),
    quoteMint: base58Encode(data.subarray(OFF_QUOTE_MINT, OFF_QUOTE_MINT + 32)),
    poolQuoteAccount: base58Encode(data.subarray(OFF_POOL_QUOTE_ACCOUNT, OFF_POOL_QUOTE_ACCOUNT + 32)),
    virtualQuoteLamports,
  };
}

/** SPL token account amount (u64 at offset 64; same for Token-2022). */
export function parseTokenAccountAmount(data: Uint8Array): bigint | null {
  if (data.length < 72) return null;
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).readBigUInt64LE(64);
}

export interface QuoteGap {
  pool: string;
  realQuoteSol: number;
  virtualQuoteSol: number;
  /** (real + virtual) / real, ≥ 1. 1 = PumpPortal's quote is right. */
  ratio: number;
}

export type AccountReader = (pubkey: string) => Promise<Uint8Array | null>;

/**
 * Read the coin's canonical SOL pool and compute PumpPortal's quote gap.
 * null = no canonical SOL pool (not graduated yet, non-SOL pair, or unreadable).
 */
export async function readPumpSwapQuoteGap(read: AccountReader, mint: string): Promise<QuoteGap | null> {
  let pool: string;
  try {
    pool = canonicalPumpSwapPool(mint);
  } catch {
    return null;
  }
  const poolData = await read(pool);
  if (!poolData) return null;
  const info = parsePumpSwapPool(poolData);
  if (!info || info.baseMint !== mint || info.quoteMint !== WSOL_MINT) return null;
  const vault = await read(info.poolQuoteAccount);
  const real = vault ? parseTokenAccountAmount(vault) : null;
  if (real == null) return null;
  const realQuoteSol = Number(real) / 1e9;
  const virtualQuoteSol = Math.max(0, Number(info.virtualQuoteLamports) / 1e9);
  if (!(realQuoteSol > 0)) return { pool, realQuoteSol: 0, virtualQuoteSol, ratio: Number.POSITIVE_INFINITY };
  return { pool, realQuoteSol, virtualQuoteSol, ratio: (realQuoteSol + virtualQuoteSol) / realQuoteSol };
}

/**
 * Buy request that spends ~`solAmount` at the pool's real price while keeping
 * the SOL cap at solAmount × (1 + slippage). PumpPortal caps at
 * amount × (1 + slippage%), so: amount' = solAmount / ratio and
 * (1 + slip') = ratio × (1 + slip).
 */
export function compensateBuy(solAmount: number, slippageBps: number, ratio: number): { amount: number; slippageBps: number } {
  if (!(ratio > 1.0005)) return { amount: solAmount, slippageBps };
  const amount = Math.floor((solAmount / ratio) * 1e6) / 1e6;
  const slip = Math.ceil(((1 + slippageBps / 10_000) * ratio - 1) * 10_000);
  // Floor the amount and ceil the slip, then pull the slip back so the cap never exceeds the original.
  const capSol = solAmount * (1 + slippageBps / 10_000);
  let s = slip;
  while (s > slippageBps && amount * (1 + s / 10_000) > capSol + 1e-12) s--;
  return { amount, slippageBps: s };
}
