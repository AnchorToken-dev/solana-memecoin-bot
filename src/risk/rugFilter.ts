/**
 * Pre-buy rug / manipulation filter. Paper only.
 *
 * Default OFF. When OFF, this module is not called and no RPC is used.
 * When ON without a read-only RPC, the buy is skipped (fail closed).
 * Never sends a transaction and never invents a price.
 *
 * Not implemented (logged, not a silent pass):
 * - dev rug history: pump.fun coin payloads can include `creator`, but this
 *   bot has no source that lists that creator's earlier coins.
 * - wash volume: scans only have aggregate volume, not a trade tape.
 */
import type { BotConfig, TokenSnapshot } from "../types.js";
import {
  parseTokenAccountHolder,
  type AccountInfo,
  type LargestTokenAccount,
  type ParsedMint,
  type RpcResult,
  type SignatureInfo,
} from "../solana/rpc.js";

/** Pump.fun bonding-curve program. Token accounts it owns are the curve, not a wallet. */
export const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export const DEFAULT_RUG_FILTER_MAX_TOP_HOLDER_PCT = 30;
export const DEFAULT_RUG_FILTER_MAX_SAME_SLOT_BUYS = 3;
/** getSignaturesForAddress page size. A full page means we may not see creation. */
export const SAME_SLOT_SIGNATURE_LIMIT = 1000;

/** Stable strings safe to store on a skip log. */
export const RUG_FILTER_REASONS = {
  noRpc: "rug_filter_no_rpc",
  rpcError: "rug_filter_rpc_error",
  mintUnreadable: "mint_account_unreadable",
  mintSupplyZero: "mint_supply_zero",
  freeze: "mint_freeze_authority",
  topHolder: "top_holder_concentration",
  holdersUnavailable: "top_holder_unavailable",
  sameSlot: "same_slot_snipe",
  sameSlotUnavailable: "same_slot_unavailable",
} as const;

export const RUG_FILTER_SKIPPED = {
  devRug: "dev_rug_history_not_implemented",
  wash: "wash_volume_not_implemented",
  sameSlotTruncated: "same_slot_snipe_truncated",
} as const;

export interface RugFilterRpc {
  getMintAccount(mint: string): Promise<RpcResult<ParsedMint | null>>;
  getTokenLargestAccounts(
    mint: string,
  ): Promise<RpcResult<LargestTokenAccount[]>>;
  getAccountInfo(pubkey: string): Promise<RpcResult<AccountInfo | null>>;
  getSignaturesForAddress(
    address: string,
    opts?: { limit?: number },
  ): Promise<RpcResult<SignatureInfo[]>>;
}

export interface RugFilterDecision {
  /** False = do not paper-buy. */
  allow: boolean;
  /** Stable reject code, or null when the buy may proceed. */
  reason: string | null;
  detail: string;
  /** Checks we did not run. Never treated as a pass. */
  skipped: string[];
}

export interface RugFilterInput {
  enabled: boolean;
  rpc: RugFilterRpc | null;
  mint: string;
  symbol: string;
  maxTopHolderPct: number;
  maxSameSlotBuys: number;
  /** Bonding-curve token account and curve PDA, when the pump payload has them. */
  ignoreAddresses?: string[];
  /** Present only for the skip log. Not used to query prior coins. */
  creator?: string | null;
}

function reject(
  reason: string,
  detail: string,
  skipped: string[],
): RugFilterDecision {
  return { allow: false, reason, detail, skipped };
}

function unimplementedSkips(creator?: string | null): string[] {
  // Always named, even when creator is on the payload — we still cannot
  // see that wallet's earlier coins with the sources this bot already uses.
  void creator;
  return [RUG_FILTER_SKIPPED.devRug, RUG_FILTER_SKIPPED.wash];
}

/**
 * Strictly above `pct` percent of supply. Exactly `pct` is allowed
 * ("reject above").
 */
export function holderExceedsPct(
  amount: bigint,
  supply: bigint,
  pct: number,
): boolean {
  if (supply <= 0n) return true;
  const hundredths = BigInt(Math.round(pct * 100));
  return amount * 10000n > supply * hundredths;
}

export async function runRugFilter(
  input: RugFilterInput,
): Promise<RugFilterDecision> {
  if (!input.enabled) {
    return {
      allow: true,
      reason: null,
      detail: "rug filter off",
      skipped: [],
    };
  }

  const skipped = unimplementedSkips(input.creator);
  if (!input.rpc) {
    return reject(
      RUG_FILTER_REASONS.noRpc,
      "RUG_FILTER_ENABLED is on but SOLANA_RPC_URL is not set — skipping this paper buy",
      skipped,
    );
  }

  const mintRes = await input.rpc.getMintAccount(input.mint);
  if (!mintRes.ok) {
    return reject(
      RUG_FILTER_REASONS.rpcError,
      `mint read failed: ${mintRes.error}`,
      skipped,
    );
  }
  if (!mintRes.value) {
    return reject(
      RUG_FILTER_REASONS.mintUnreadable,
      "mint account missing",
      skipped,
    );
  }
  const mint = mintRes.value;
  if (mint.freezeAuthority) {
    return reject(
      RUG_FILTER_REASONS.freeze,
      "mint freeze authority is set (sell can be blocked)",
      skipped,
    );
  }
  if (mint.supply <= 0n) {
    return reject(
      RUG_FILTER_REASONS.mintSupplyZero,
      "mint supply is zero",
      skipped,
    );
  }

  const holders = await checkTopHolder(input, mint.supply);
  if (!holders.ok) return reject(holders.reason, holders.detail, skipped);

  const slot = await checkSameSlot(input);
  if (!slot.ok) return reject(slot.reason, slot.detail, skipped);
  if (slot.truncated) skipped.push(RUG_FILTER_SKIPPED.sameSlotTruncated);

  return {
    allow: true,
    reason: null,
    detail: "rug filter passed",
    skipped,
  };
}

export function rugFilterInputFromConfig(
  cfg: BotConfig,
  snap: TokenSnapshot,
  rpc: RugFilterRpc | null,
): RugFilterInput {
  const ignore = [snap.bondingCurve, snap.associatedBondingCurve].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return {
    enabled: cfg.rugFilterEnabled === true,
    rpc,
    mint: snap.mint,
    symbol: snap.symbol,
    maxTopHolderPct:
      cfg.rugFilterMaxTopHolderPct ?? DEFAULT_RUG_FILTER_MAX_TOP_HOLDER_PCT,
    maxSameSlotBuys:
      cfg.rugFilterMaxSameSlotBuys ?? DEFAULT_RUG_FILTER_MAX_SAME_SLOT_BUYS,
    ignoreAddresses: ignore,
    creator: snap.creator ?? null,
  };
}

type CheckOk = { ok: true; truncated?: boolean };
type CheckBad = { ok: false; reason: string; detail: string };

async function checkTopHolder(
  input: RugFilterInput,
  supply: bigint,
): Promise<CheckOk | CheckBad> {
  const res = await input.rpc!.getTokenLargestAccounts(input.mint);
  if (!res.ok) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.rpcError,
      detail: `largest accounts failed: ${res.error}`,
    };
  }
  if (res.value.length === 0) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.holdersUnavailable,
      detail: "getTokenLargestAccounts returned no accounts",
    };
  }
  const ignore = new Set(input.ignoreAddresses ?? []);
  let top: bigint | null = null;
  for (const row of res.value) {
    if (ignore.has(row.address)) continue;
    const curve = await isPumpCurveHolding(input.rpc!, row, ignore);
    if (curve === "error") {
      return {
        ok: false,
        reason: RUG_FILTER_REASONS.rpcError,
        detail: `could not tell if ${row.address} is the bonding curve`,
      };
    }
    if (curve === "curve") continue;
    if (top == null || row.amount > top) top = row.amount;
  }
  if (top == null) return { ok: true };
  if (holderExceedsPct(top, supply, input.maxTopHolderPct)) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.topHolder,
      detail: `top non-curve holder is above ${input.maxTopHolderPct}% of supply`,
    };
  }
  return { ok: true };
}

/**
 * "curve" = bonding-curve / program-owned token account.
 * "wallet" = count it.
 * "error" = could not tell (caller fail-closes).
 */
async function isPumpCurveHolding(
  rpc: RugFilterRpc,
  row: LargestTokenAccount,
  ignore: Set<string>,
): Promise<"curve" | "wallet" | "error"> {
  if (ignore.has(row.address)) return "curve";
  const info = await rpc.getAccountInfo(row.address);
  if (!info.ok || !info.value) return "error";
  const holder = parseTokenAccountHolder(info.value.data);
  if (!holder) return "error";
  if (ignore.has(holder)) return "curve";
  const ownerAcc = await rpc.getAccountInfo(holder);
  if (!ownerAcc.ok || !ownerAcc.value) return "error";
  if (ownerAcc.value.owner === PUMP_FUN_PROGRAM_ID) return "curve";
  return "wallet";
}

async function checkSameSlot(
  input: RugFilterInput,
): Promise<CheckOk | CheckBad> {
  const res = await input.rpc!.getSignaturesForAddress(input.mint, {
    limit: SAME_SLOT_SIGNATURE_LIMIT,
  });
  if (!res.ok) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.rpcError,
      detail: `signatures failed: ${res.error}`,
    };
  }
  if (res.value.length === 0) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.sameSlotUnavailable,
      detail: "no signatures for mint — cannot see the creation slot",
    };
  }
  if (res.value.length >= SAME_SLOT_SIGNATURE_LIMIT) {
    // History is truncated. We must not guess the creation slot.
    return { ok: true, truncated: true };
  }
  let creationSlot = res.value[0]!.slot;
  for (const sig of res.value) {
    if (sig.slot < creationSlot) creationSlot = sig.slot;
  }
  const successful = res.value.filter(
    (s) => s.slot === creationSlot && s.err == null,
  );
  // Oldest successful tx is treated as creation. The rest in that slot are the burst.
  const buys = Math.max(0, successful.length - 1);
  if (buys > input.maxSameSlotBuys) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.sameSlot,
      detail: `${buys} txs share creation slot ${creationSlot} (limit ${input.maxSameSlotBuys})`,
    };
  }
  return { ok: true };
}
