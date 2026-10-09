/**
 * Real-time mark for a HELD coin, read straight from the chain over the
 * configured HTTPS RPC (read-only; no WSS subscription is added).
 *
 * - Still on pump.fun: the bonding-curve account's virtual reserves.
 * - Graduated: the canonical PumpSwap SOL pool — base vault, quote vault and
 *   the pool's virtual quote reserves (the price the program actually trades at).
 *
 * One getMultipleAccounts call per read. DexScreener's priceUsd can trail the
 * chain by 10-60s, which is how +40% spikes were missed while holding.
 */
import type { AccountInfo, RpcResult } from "../solana/rpc.js";
import { findProgramAddress, toBytes32 } from "../solana/pda.js";
import {
  PUMP_CURVE_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  WSOL_MINT,
  canonicalPumpSwapPool,
  parsePumpSwapPool,
  parseTokenAccountAmount,
} from "../live/pumpswapPool.js";

export interface OnchainPriceRpc {
  getAccountInfo(pubkey: string): Promise<RpcResult<AccountInfo | null>>;
  getMultipleAccounts?(pubkeys: string[]): Promise<RpcResult<(AccountInfo | null)[]>>;
}

export type OnchainVenue = "bonding_curve" | "pumpswap";

export interface OnchainMark {
  /** SOL per whole token. */
  priceSol: number;
  venue: OnchainVenue;
}

const CURVE_DISCRIMINATOR = [23, 183, 248, 55, 96, 216, 172, 96];
// BondingCurve (pump IDL): 8 disc | virtual_token u64 | virtual_sol u64 |
// real_token u64 | real_sol u64 | token_total_supply u64 | complete bool | …
const OFF_VTOKEN = 8;
const OFF_VSOL = 16;
const OFF_COMPLETE = 48;

export function bondingCurvePda(mint: string): string {
  return findProgramAddress([Buffer.from("bonding-curve"), toBytes32(mint)], PUMP_CURVE_PROGRAM_ID).address;
}

export interface ParsedCurve {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  complete: boolean;
}

export function parseBondingCurve(data: Uint8Array): ParsedCurve | null {
  if (data.length < OFF_COMPLETE + 1) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== CURVE_DISCRIMINATOR[i]) return null;
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return {
    virtualTokenReserves: b.readBigUInt64LE(OFF_VTOKEN),
    virtualSolReserves: b.readBigUInt64LE(OFF_VSOL),
    complete: data[OFF_COMPLETE] === 1,
  };
}

/** SOL per whole token from reserves (lamports / base units). */
export function reservesPriceSol(solLamports: bigint, tokenUnits: bigint, decimals: number): number | null {
  if (tokenUnits <= 0n || solLamports <= 0n) return null;
  const p = (Number(solLamports) / 1e9) / (Number(tokenUnits) / 10 ** decimals);
  return Number.isFinite(p) && p > 0 ? p : null;
}

type Source =
  | { kind: "curve"; curve: string; decimals: number }
  | { kind: "pool"; pool: string; baseVault: string; quoteVault: string; decimals: number };

export class OnchainPriceReader {
  private readonly sources = new Map<string, Source>();

  constructor(private readonly rpc: OnchainPriceRpc) {}

  private async many(keys: string[]): Promise<(AccountInfo | null)[] | null> {
    if (this.rpc.getMultipleAccounts) {
      const r = await this.rpc.getMultipleAccounts(keys);
      return r.ok ? r.value : null;
    }
    const out: (AccountInfo | null)[] = [];
    for (const k of keys) {
      const r = await this.rpc.getAccountInfo(k);
      if (!r.ok) return null;
      out.push(r.value);
    }
    return out;
  }

  /** Forget a mint (position closed). */
  drop(mint: string): void {
    this.sources.delete(mint);
  }

  /** Current on-chain mark, or null when it can't be read (caller falls back). */
  async read(mint: string): Promise<OnchainMark | null> {
    let src = this.sources.get(mint);
    if (!src) {
      src = (await this.resolve(mint)) ?? undefined;
      if (!src) return null;
      this.sources.set(mint, src);
    }
    if (src.kind === "curve") {
      const accs = await this.many([src.curve]);
      const data = accs?.[0];
      if (!data || data.owner !== PUMP_CURVE_PROGRAM_ID) return null;
      const c = parseBondingCurve(data.data);
      if (!c) return null;
      if (c.complete) {
        // Graduated while we held it: switch to the pool next read.
        this.sources.delete(mint);
        return this.read(mint);
      }
      const p = reservesPriceSol(c.virtualSolReserves, c.virtualTokenReserves, src.decimals);
      return p == null ? null : { priceSol: p, venue: "bonding_curve" };
    }
    const accs = await this.many([src.pool, src.baseVault, src.quoteVault]);
    if (!accs || !accs[0] || !accs[1] || !accs[2]) return null;
    const info = accs[0].owner === PUMPSWAP_PROGRAM_ID ? parsePumpSwapPool(accs[0].data) : null;
    if (!info || info.baseMint !== mint) return null;
    const base = parseTokenAccountAmount(accs[1].data);
    const quote = parseTokenAccountAmount(accs[2].data);
    if (base == null || quote == null) return null;
    const virt = info.virtualQuoteLamports > 0n ? info.virtualQuoteLamports : 0n;
    const p = reservesPriceSol(quote + virt, base, src.decimals);
    return p == null ? null : { priceSol: p, venue: "pumpswap" };
  }

  private async resolve(mint: string): Promise<Source | null> {
    let curve: string;
    let pool: string;
    try {
      curve = bondingCurvePda(mint);
      pool = canonicalPumpSwapPool(mint);
    } catch {
      return null;
    }
    const accs = await this.many([mint, curve, pool]);
    if (!accs || !accs[0]) return null;
    const mintData = accs[0].data;
    if (mintData.length < 82) return null;
    const decimals = mintData[44]!;
    const curveAcc = accs[1];
    if (curveAcc && curveAcc.owner === PUMP_CURVE_PROGRAM_ID) {
      const c = parseBondingCurve(curveAcc.data);
      if (c && !c.complete && c.virtualTokenReserves > 0n) {
        return { kind: "curve", curve, decimals };
      }
    }
    const poolAcc = accs[2];
    if (poolAcc && poolAcc.owner === PUMPSWAP_PROGRAM_ID) {
      const info = parsePumpSwapPool(poolAcc.data);
      if (info && info.baseMint === mint && info.quoteMint === WSOL_MINT) {
        return {
          kind: "pool",
          pool,
          baseVault: info.poolBaseAccount,
          quoteVault: info.poolQuoteAccount,
          decimals,
        };
      }
    }
    return null;
  }
}
