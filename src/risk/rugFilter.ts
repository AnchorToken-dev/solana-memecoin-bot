/**
 * Pre-buy rug / manipulation filter. Optional in paper, mandatory in live.
 *
 * Default OFF in paper. When OFF, this module is not called and no RPC is used.
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
import {
  PUMPSWAP_PROGRAM_ID,
  WSOL_MINT,
  canonicalPumpSwapPool,
  parsePumpSwapPool,
  parseTokenAccountAmount,
} from "../live/pumpswapPool.js";

/** Pump.fun bonding-curve program. Token accounts it owns are the curve, not a wallet. */
export const PUMP_FUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

export const DEFAULT_RUG_FILTER_MAX_TOP_HOLDER_PCT = 30;
export const DEFAULT_RUG_FILTER_MAX_SAME_SLOT_BUYS = 3;
/**
 * Graduated (PumpSwap) coins. Incidents 2026-10-09: TRUMPSI's pool held 5.4%
 * and BUNKER's 4.2% of supply at our buy; one wallet held 13.5% and ~600
 * bundled wallets another ~27% — all dumped within 31s-4min. The old 30%
 * single-holder check passed them.
 * Pool share falls as price rises after graduation (~20% at migration), so the
 * floor is a tradeoff: 10% blocked both incidents with 2x margin; on 52 live
 * graduated pump coins (Oct 9) 11 passed at 10%, 7 at 15%, 49 with no floor.
 */
export const DEFAULT_RUG_FILTER_GRAD_MIN_POOL_PCT = 10;
export const DEFAULT_RUG_FILTER_GRAD_MAX_HOLDER_PCT = 10;
export const DEFAULT_RUG_FILTER_GRAD_MAX_TOP10_PCT = 35;
/** A failed verdict sticks to the mint this long so a retry can't flip it to pass. */
export const DEFAULT_RUG_FILTER_FAIL_COOLDOWN_MINUTES = 60;
/** Solana incinerator: tokens sent here are burned for good. */
export const INCINERATOR_ADDRESS = "1nc1nerator11111111111111111111111111111111";
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
  /** Graduated coin but its PumpSwap pool/vault could not be read. Fail closed. */
  gradPoolUnavailable: "graduated_pool_unavailable",
  /** Pool token vault holds too little of the supply (price far above graduation / overhang). */
  gradPoolThin: "graduated_pool_share_low",
  gradHolder: "graduated_holder_concentration",
  gradTop10: "graduated_top10_concentration",
  /** Earlier fail for this mint is still within the cooldown. */
  cachedFail: "rug_filter_cached_fail",
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
  /** Optional batch read (one request). Falls back to getAccountInfo per key. */
  getMultipleAccounts?(
    pubkeys: string[],
  ): Promise<RpcResult<(AccountInfo | null)[]>>;
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
  /** Holder numbers for the log (graduated coins). */
  metrics?: GraduatedHolderMetrics;
}

export interface GraduatedHolderMetrics {
  pool: string;
  poolVault: string;
  poolPct: number;
  topHolderPct: number;
  top10Pct: number;
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
  /** From the scan: "pumpswap" = graduated. Unknown is resolved on-chain. */
  venue?: "bonding_curve" | "pumpswap";
  /** Graduated coins: skip if the pool vault holds less than this % of supply. */
  gradMinPoolPct?: number;
  /** Graduated coins: skip if any one non-pool holder is above this % of supply. */
  gradMaxHolderPct?: number;
  /** Graduated coins: skip if the top 10 non-pool holders together are above this %. */
  gradMaxTop10Pct?: number;
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

  // Graduated? Decided from the chain (canonical PumpSwap pool), not only the scan.
  const grad = await readGraduation(input);
  if (!grad.ok) return reject(grad.reason, grad.detail, skipped);

  let metrics: GraduatedHolderMetrics | undefined;
  if (grad.pool) {
    const g = await checkGraduatedHolders(input, mint.supply, grad.pool);
    if (!g.ok) {
      const out = reject(g.reason, g.detail, skipped);
      if (g.metrics) out.metrics = g.metrics;
      return out;
    }
    metrics = g.metrics;
  } else {
    const holders = await checkTopHolder(input, mint.supply);
    if (!holders.ok) return reject(holders.reason, holders.detail, skipped);
  }

  const slot = await checkSameSlot(input);
  if (!slot.ok) return reject(slot.reason, slot.detail, skipped);
  // Same-slot history only; holder concentration never passes on a truncated read.
  if (slot.truncated) skipped.push(RUG_FILTER_SKIPPED.sameSlotTruncated);

  return {
    allow: true,
    reason: null,
    detail: metrics
      ? `rug filter passed (graduated: pool ${metrics.poolPct.toFixed(1)}%, top holder ${metrics.topHolderPct.toFixed(1)}%, top10 ${metrics.top10Pct.toFixed(1)}%)`
      : "rug filter passed",
    skipped,
    ...(metrics ? { metrics } : {}),
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
    ...(snap.venue ? { venue: snap.venue } : {}),
    gradMinPoolPct:
      cfg.rugFilterGradMinPoolPct ?? DEFAULT_RUG_FILTER_GRAD_MIN_POOL_PCT,
    gradMaxHolderPct:
      cfg.rugFilterGradMaxHolderPct ?? DEFAULT_RUG_FILTER_GRAD_MAX_HOLDER_PCT,
    gradMaxTop10Pct:
      cfg.rugFilterGradMaxTop10Pct ?? DEFAULT_RUG_FILTER_GRAD_MAX_TOP10_PCT,
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
  if (!ownerAcc.ok) return "error";
  // A wallet with 0 SOL has no account at all — it is still a wallet, not an error.
  if (!ownerAcc.value) return "wallet";
  if (ownerAcc.value.owner === PUMP_FUN_PROGRAM_ID) return "curve";
  return "wallet";
}

// ---------------------------------------------------------------- graduated

type GradPool = { pool: string; vault: string };
type Graduation =
  | { ok: true; pool: GradPool | null }
  | { ok: false; reason: string; detail: string };

/**
 * Canonical PumpSwap pool for the mint (SOL quote). `pool: null` = still on
 * the bonding curve. Fails closed when the scan says graduated but the pool
 * is missing / unreadable, or when the read itself errors.
 */
async function readGraduation(input: RugFilterInput): Promise<Graduation> {
  let pool: string;
  try {
    pool = canonicalPumpSwapPool(input.mint);
  } catch {
    if (input.venue === "pumpswap") {
      return {
        ok: false,
        reason: RUG_FILTER_REASONS.gradPoolUnavailable,
        detail: "graduated coin but mint is not a valid key for the PumpSwap pool",
      };
    }
    return { ok: true, pool: null };
  }
  const res = await input.rpc!.getAccountInfo(pool);
  if (!res.ok) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.rpcError,
      detail: `PumpSwap pool read failed: ${res.error}`,
    };
  }
  if (!res.value) {
    if (input.venue === "pumpswap") {
      return {
        ok: false,
        reason: RUG_FILTER_REASONS.gradPoolUnavailable,
        detail: "graduated coin but its canonical PumpSwap SOL pool was not found",
      };
    }
    return { ok: true, pool: null };
  }
  const info =
    res.value.owner === PUMPSWAP_PROGRAM_ID ? parsePumpSwapPool(res.value.data) : null;
  if (!info || info.baseMint !== input.mint || info.quoteMint !== WSOL_MINT) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.gradPoolUnavailable,
      detail: "PumpSwap pool account did not parse as this coin's SOL pool",
    };
  }
  return { ok: true, pool: { pool, vault: info.poolBaseAccount } };
}

async function readAccounts(
  rpc: RugFilterRpc,
  keys: string[],
): Promise<RpcResult<(AccountInfo | null)[]>> {
  if (rpc.getMultipleAccounts) return rpc.getMultipleAccounts(keys);
  const out: (AccountInfo | null)[] = [];
  for (const k of keys) {
    const r = await rpc.getAccountInfo(k);
    if (!r.ok) return r;
    out.push(r.value);
  }
  return { ok: true, value: out };
}

function pctOf(amount: bigint, supply: bigint): number {
  if (supply <= 0n) return 100;
  return Number((amount * 1_000_000n) / supply) / 10_000;
}

type GradCheck =
  | { ok: true; metrics: GraduatedHolderMetrics }
  | { ok: false; reason: string; detail: string; metrics?: GraduatedHolderMetrics };

/**
 * Holder concentration for a graduated coin. Only the canonical pool's token
 * vault, the incinerator and pump.fun-curve-owned accounts are excluded —
 * every other holder (including other pools) counts. Any read gap fails closed.
 */
async function checkGraduatedHolders(
  input: RugFilterInput,
  supply: bigint,
  grad: GradPool,
): Promise<GradCheck> {
  const rpc = input.rpc!;
  const unavailable = (detail: string): GradCheck => ({
    ok: false,
    reason: RUG_FILTER_REASONS.gradPoolUnavailable,
    detail,
  });

  const largest = await rpc.getTokenLargestAccounts(input.mint);
  if (!largest.ok) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.rpcError,
      detail: `largest accounts failed: ${largest.error}`,
    };
  }
  if (largest.value.length === 0) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.holdersUnavailable,
      detail: "getTokenLargestAccounts returned no accounts",
    };
  }

  // Pool vault balance straight from its token account (it may not be top-20).
  const rows = largest.value.filter((r) => r.address !== grad.vault);
  const tokenAccs = await readAccounts(rpc, [grad.vault, ...rows.map((r) => r.address)]);
  if (!tokenAccs.ok) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.rpcError,
      detail: `holder accounts read failed: ${tokenAccs.error}`,
    };
  }
  const vaultAcc = tokenAccs.value[0];
  const vaultAmount = vaultAcc ? parseTokenAccountAmount(vaultAcc.data) : null;
  const vaultHolder = vaultAcc ? parseTokenAccountHolder(vaultAcc.data) : null;
  if (vaultAmount == null || vaultHolder !== grad.pool) {
    return unavailable("PumpSwap pool token vault unreadable");
  }

  const holders: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const acc = tokenAccs.value[i + 1];
    const h = acc ? parseTokenAccountHolder(acc.data) : null;
    if (!h) return unavailable(`could not read holder of ${rows[i]!.address}`);
    holders.push(h);
  }
  const uniqueHolders = [...new Set(holders)];
  const holderAccs = await readAccounts(rpc, uniqueHolders);
  if (!holderAccs.ok) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.rpcError,
      detail: `holder owner read failed: ${holderAccs.error}`,
    };
  }
  const programOf = new Map<string, string | null>();
  uniqueHolders.forEach((h, i) => programOf.set(h, holderAccs.value[i]?.owner ?? null));

  // Sum per holder wallet (one wallet can own several token accounts).
  const perHolder = new Map<string, bigint>();
  for (let i = 0; i < rows.length; i++) {
    const h = holders[i]!;
    if (h === INCINERATOR_ADDRESS) continue;
    if (programOf.get(h) === PUMP_FUN_PROGRAM_ID) continue; // leftover curve
    perHolder.set(h, (perHolder.get(h) ?? 0n) + rows[i]!.amount);
  }
  const sorted = [...perHolder.values()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const top = sorted[0] ?? 0n;
  const top10 = sorted.slice(0, 10).reduce((a, b) => a + b, 0n);

  const metrics: GraduatedHolderMetrics = {
    pool: grad.pool,
    poolVault: grad.vault,
    poolPct: pctOf(vaultAmount, supply),
    topHolderPct: pctOf(top, supply),
    top10Pct: pctOf(top10, supply),
  };
  const nums = `pool ${metrics.poolPct.toFixed(1)}%, top holder ${metrics.topHolderPct.toFixed(1)}%, top10 ${metrics.top10Pct.toFixed(1)}%`;

  const maxHolder = Math.min(
    input.gradMaxHolderPct ?? DEFAULT_RUG_FILTER_GRAD_MAX_HOLDER_PCT,
    input.maxTopHolderPct,
  );
  if (holderExceedsPct(top, supply, maxHolder)) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.gradHolder,
      detail: `one wallet holds more than ${maxHolder}% of supply outside the pool (${nums})`,
      metrics,
    };
  }
  const maxTop10 = input.gradMaxTop10Pct ?? DEFAULT_RUG_FILTER_GRAD_MAX_TOP10_PCT;
  if (holderExceedsPct(top10, supply, maxTop10)) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.gradTop10,
      detail: `top 10 wallets outside the pool hold more than ${maxTop10}% of supply (${nums})`,
      metrics,
    };
  }
  const minPool = input.gradMinPoolPct ?? DEFAULT_RUG_FILTER_GRAD_MIN_POOL_PCT;
  if (minPool > 0 && vaultAmount * 10000n < supply * BigInt(Math.round(minPool * 100))) {
    return {
      ok: false,
      reason: RUG_FILTER_REASONS.gradPoolThin,
      detail: `pool holds less than ${minPool}% of supply — wallets outside could dump it (${nums})`,
      metrics,
    };
  }
  return { ok: true, metrics };
}

// ------------------------------------------------------------ fail cache

/**
 * Per-mint memory of failed verdicts. A fail sticks for the cooldown so a
 * later re-check (RPC flake, holders shuffled between wallets) can't turn it
 * into a pass. RPC errors are remembered briefly too (no hammering), but a
 * real verdict (concentration, freeze, …) is never shortened by them.
 */
export const RUG_FILTER_TRANSIENT_FAIL_MS = 2 * 60_000;
const TRANSIENT_REASONS = new Set<string>([
  RUG_FILTER_REASONS.noRpc,
  RUG_FILTER_REASONS.rpcError,
]);

export class RugVerdictCache {
  private readonly fails = new Map<string, { until: number; reason: string; detail: string }>();
  constructor(private readonly cooldownMs: number) {}

  get(mint: string, nowMs: number): { reason: string; detail: string; until: number } | null {
    const f = this.fails.get(mint);
    if (!f) return null;
    if (nowMs >= f.until) {
      this.fails.delete(mint);
      return null;
    }
    return f;
  }

  record(mint: string, decision: RugFilterDecision, nowMs: number): void {
    if (decision.allow || !decision.reason) return;
    if (this.cooldownMs <= 0) return;
    const transient = TRANSIENT_REASONS.has(decision.reason);
    const until = nowMs + (transient ? Math.min(this.cooldownMs, RUG_FILTER_TRANSIENT_FAIL_MS) : this.cooldownMs);
    const prev = this.get(mint, nowMs);
    // Never let a transient error shorten a real verdict.
    if (prev && prev.until >= until) return;
    this.fails.set(mint, { until, reason: decision.reason, detail: decision.detail });
    if (this.fails.size > 5_000) {
      for (const [k, v] of this.fails) if (v.until <= nowMs) this.fails.delete(k);
    }
  }

  size(): number {
    return this.fails.size;
  }
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
