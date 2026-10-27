/**
 * Read a KOL buy from a Helius wallet-watch transaction.
 *
 * Helius enhanced transactions label `source` / `type` only for routers they
 * have a parser for. That catalog is frozen (the enhanced API is in
 * maintenance), so newer routers come back as UNKNOWN — or, on a plain
 * getTransaction, as a program id with no label at all. Gating on those
 * labels drops the buy even though the wallet's SOL and token balances
 * already say what was bought.
 *
 * This parser never allowlists program ids. Balances decide the trade.
 * Program ids are collected only so a failure can name them. Infrastructure
 * programs (compute budget, token, ATA, memo, system) are kept on the
 * failure line and omitted from the venue label.
 *
 * Accepts either shape:
 *  - Helius enhanced transaction (address history / webhook)
 *  - jsonParsed getTransaction (account keys as strings OR {pubkey,signer,writable},
 *    instructions with programId or programIdIndex, including inner instructions)
 */
import type { KolBuy } from "./trades.js";
import { USDC_MINT, USDT_MINT, WSOL_MINT } from "./trades.js";

export type HeliusRejectReason =
  | "not_object"
  | "no_signature"
  | "failed_tx"
  | "wallet_not_involved"
  | "not_buy"
  | "no_balance_change"
  | "no_quote_spent"
  | "paid_with_non_base"
  | "ambiguous_mints";

export type HeliusBuyResult =
  | { ok: true; buy: KolBuy }
  | { ok: false; reason: HeliusRejectReason; signature: string | null; programIds: string[]; report: boolean };

const BASE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

/** Programs that sit on almost every transaction and are not the venue. */
const INFRA_PROGRAMS = new Set([
  "ComputeBudget111111111111111111111111111111",
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);

/** Short names for logs. Unknown ids stay as the id — they are not rejected. */
const PROGRAM_LABELS: Record<string, string> = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun",
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pumpswap",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "raydium_amm_v4",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "raydium_cpmm",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "raydium_clmm",
  LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj: "raydium_launchlab",
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: "jupiter_v6",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "orca_whirlpool",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "meteora_dlmm",
  cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG: "meteora_damm_v2",
  Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB: "meteora_pools",
  dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN: "meteora_dbc",
  MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG: "moonshot",
};

const DUST = 1e-9;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function numish(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function labelProgram(id: string): string {
  return PROGRAM_LABELS[id] ?? id;
}

export function shouldReportHeliusFailure(reason: HeliusRejectReason, swapLike: boolean): boolean {
  switch (reason) {
    case "not_object":
    case "no_signature":
    case "ambiguous_mints":
    case "paid_with_non_base":
      return true;
    case "no_balance_change":
    case "no_quote_spent":
      return swapLike;
    case "not_buy":
    case "failed_tx":
    case "wallet_not_involved":
      return false;
    default: {
      const neverReason: never = reason;
      return neverReason;
    }
  }
}

export function formatHeliusFailure(f: Extract<HeliusBuyResult, { ok: false }>): string {
  const ids = f.programIds.length > 0 ? f.programIds.join(",") : "none";
  return `reason=${f.reason} sig=${f.signature ?? "none"} programs=${ids}`;
}

function uiFromRaw(amount: string, decimals: number): number | null {
  if (!/^-?\d+$/.test(amount)) return null;
  const neg = amount.startsWith("-");
  const digits = neg ? amount.slice(1) : amount;
  const d = Math.max(0, Math.trunc(decimals));
  const padded = digits.padStart(d + 1, "0");
  const whole = padded.slice(0, padded.length - d);
  const frac = d > 0 ? padded.slice(padded.length - d) : "";
  const ui = Number(frac ? `${whole}.${frac}` : whole);
  if (!Number.isFinite(ui)) return null;
  return neg ? -ui : ui;
}

function accountKeysOf(raw: Record<string, unknown>): string[] {
  const tx = isObj(raw.transaction) ? raw.transaction : null;
  const message = tx && isObj(tx.message) ? tx.message : null;
  const list = message && Array.isArray(message.accountKeys) ? message.accountKeys : [];
  const keys: string[] = [];
  for (const k of list) {
    if (typeof k === "string" && k) keys.push(k);
    else if (isObj(k)) {
      const pk = str(k.pubkey);
      if (pk) keys.push(pk);
    }
  }
  const meta = isObj(raw.meta) ? raw.meta : null;
  const loaded = meta && isObj(meta.loadedAddresses) ? meta.loadedAddresses : null;
  if (loaded) {
    for (const bucket of [loaded.writable, loaded.readonly]) {
      if (!Array.isArray(bucket)) continue;
      for (const k of bucket) {
        if (typeof k === "string" && k && !keys.includes(k)) keys.push(k);
      }
    }
  }
  return keys;
}

function programFromIx(ix: Record<string, unknown>, keys: string[]): string | null {
  const direct = str(ix.programId);
  if (direct) return direct;
  const idx = numish(ix.programIdIndex);
  if (idx == null || !Number.isInteger(idx) || idx < 0) return null;
  return keys[idx] ?? null;
}

function pushId(out: string[], id: string | null): void {
  if (!id || out.includes(id)) return;
  out.push(id);
}

/** Outer instructions first, then each instruction's inner instructions. */
export function collectProgramIds(raw: unknown): string[] {
  if (!isObj(raw)) return [];
  const keys = accountKeysOf(raw);
  const out: string[] = [];
  const walk = (ix: unknown): void => {
    if (!isObj(ix)) return;
    pushId(out, programFromIx(ix, keys));
    if (Array.isArray(ix.innerInstructions)) {
      for (const inner of ix.innerInstructions) walk(inner);
    }
  };
  if (Array.isArray(raw.instructions)) {
    for (const ix of raw.instructions) walk(ix);
  }
  const tx = isObj(raw.transaction) ? raw.transaction : null;
  const message = tx && isObj(tx.message) ? tx.message : null;
  if (message && Array.isArray(message.instructions)) {
    for (const ix of message.instructions) walk(ix);
  }
  const meta = isObj(raw.meta) ? raw.meta : null;
  if (meta && Array.isArray(meta.innerInstructions)) {
    for (const group of meta.innerInstructions) {
      if (!isObj(group) || !Array.isArray(group.instructions)) continue;
      for (const ix of group.instructions) walk(ix);
    }
  }
  return out;
}

function signatureOf(raw: Record<string, unknown>): string | null {
  const direct = str(raw.signature);
  if (direct) return direct;
  const tx = isObj(raw.transaction) ? raw.transaction : null;
  const sigs = tx && Array.isArray(tx.signatures) ? tx.signatures : null;
  const first = sigs && typeof sigs[0] === "string" ? sigs[0].trim() : "";
  return first || null;
}

function failed(raw: Record<string, unknown>): boolean {
  if ("transactionError" in raw && raw.transactionError != null) return true;
  const meta = isObj(raw.meta) ? raw.meta : null;
  return meta != null && "err" in meta && meta.err != null;
}

function feePayerOf(raw: Record<string, unknown>, keys: string[]): string | null {
  const named = str(raw.feePayer);
  if (named) return named;
  const tx = isObj(raw.transaction) ? raw.transaction : null;
  const message = tx && isObj(tx.message) ? tx.message : null;
  const list = message && Array.isArray(message.accountKeys) ? message.accountKeys : [];
  const k0 = list[0];
  if (typeof k0 === "string") return k0;
  if (isObj(k0) && str(k0.pubkey)) return str(k0.pubkey);
  return keys[0] ?? null;
}

function timeMs(raw: Record<string, unknown>): number {
  const sec = numish(raw.timestamp) ?? numish(raw.blockTime);
  if (sec == null || sec <= 0) return 0;
  return sec > 1e12 ? sec : sec * 1000;
}

function hasSwapEvent(raw: Record<string, unknown>): boolean {
  return isObj(raw.events) && isObj(raw.events.swap);
}

function addDelta(map: Map<string, number>, mint: string, delta: number): void {
  if (!Number.isFinite(delta) || delta === 0) return;
  map.set(mint, (map.get(mint) ?? 0) + delta);
}

function tokenUi(entry: Record<string, unknown>): number | null {
  const ui = isObj(entry.uiTokenAmount) ? entry.uiTokenAmount : null;
  if (!ui) return null;
  const asString = str(ui.uiAmountString);
  if (asString != null && Number.isFinite(Number(asString))) return Number(asString);
  const direct = numish(ui.uiAmount);
  if (direct != null) return direct;
  const raw = str(ui.amount);
  const decimals = numish(ui.decimals) ?? 0;
  if (raw && /^-?\d+$/.test(raw)) return uiFromRaw(raw, decimals);
  return null;
}

/** Net token UI change and net native lamports for `wallet`. Native is fee-excluded. */
function balancesFor(raw: Record<string, unknown>, wallet: string, keys: string[]): { tokens: Map<string, number>; nativeLamports: number } {
  const tokens = new Map<string, number>();
  let nativeLamports = 0;
  const meta = isObj(raw.meta) ? raw.meta : null;
  const usedMetaTokens = meta != null && (Array.isArray(meta.preTokenBalances) || Array.isArray(meta.postTokenBalances));

  if (usedMetaTokens && meta) {
    const pre = new Map<string, number>();
    const post = new Map<string, number>();
    const take = (list: unknown, into: Map<string, number>) => {
      if (!Array.isArray(list)) return;
      for (const row of list) {
        if (!isObj(row) || str(row.owner) !== wallet) continue;
        const mint = str(row.mint);
        const ui = tokenUi(row);
        if (!mint || ui == null) continue;
        into.set(mint, (into.get(mint) ?? 0) + ui);
      }
    };
    take(meta.preTokenBalances, pre);
    take(meta.postTokenBalances, post);
    const mints = new Set([...pre.keys(), ...post.keys()]);
    for (const mint of mints) addDelta(tokens, mint, (post.get(mint) ?? 0) - (pre.get(mint) ?? 0));
  } else if (Array.isArray(raw.tokenTransfers) && raw.tokenTransfers.length > 0) {
    for (const t of raw.tokenTransfers) {
      if (!isObj(t)) continue;
      const mint = str(t.mint);
      const amt = numish(t.tokenAmount);
      if (!mint || amt == null || amt === 0) continue;
      if (str(t.toUserAccount) === wallet) addDelta(tokens, mint, Math.abs(amt));
      if (str(t.fromUserAccount) === wallet) addDelta(tokens, mint, -Math.abs(amt));
    }
  } else if (Array.isArray(raw.accountData)) {
    for (const ad of raw.accountData) {
      if (!isObj(ad) || !Array.isArray(ad.tokenBalanceChanges)) continue;
      for (const ch of ad.tokenBalanceChanges) {
        if (!isObj(ch) || str(ch.userAccount) !== wallet) continue;
        const mint = str(ch.mint);
        const rawAmt = isObj(ch.rawTokenAmount) ? ch.rawTokenAmount : null;
        const amount = rawAmt ? str(rawAmt.tokenAmount) : null;
        const decimals = rawAmt ? numish(rawAmt.decimals) ?? 0 : 0;
        if (!mint || !amount) continue;
        const ui = uiFromRaw(amount, decimals);
        if (ui == null) continue;
        addDelta(tokens, mint, ui);
      }
    }
  }

  if (tokens.size === 0 && hasSwapEvent(raw)) {
    const swap = (raw.events as Record<string, unknown>).swap as Record<string, unknown>;
    const legs = (list: unknown, sign: 1 | -1) => {
      if (!Array.isArray(list)) return;
      for (const leg of list) {
        if (!isObj(leg) || str(leg.userAccount) !== wallet) continue;
        const mint = str(leg.mint);
        const rawAmt = isObj(leg.rawTokenAmount) ? leg.rawTokenAmount : null;
        const amount = rawAmt ? str(rawAmt.tokenAmount) : null;
        const decimals = rawAmt ? numish(rawAmt.decimals) ?? 0 : 0;
        if (!mint || !amount) continue;
        const ui = uiFromRaw(amount.replace(/^-/, ""), decimals);
        if (ui == null) continue;
        addDelta(tokens, mint, sign * Math.abs(ui));
      }
    };
    legs(swap.tokenInputs, -1);
    legs(swap.tokenOutputs, 1);
  }

  if (meta && Array.isArray(meta.preBalances) && Array.isArray(meta.postBalances)) {
    const idx = keys.indexOf(wallet);
    const pre = idx >= 0 ? numish(meta.preBalances[idx]) : null;
    const post = idx >= 0 ? numish(meta.postBalances[idx]) : null;
    if (pre != null && post != null) {
      nativeLamports = post - pre;
      if (feePayerOf(raw, keys) === wallet) nativeLamports += numish(meta.fee) ?? 0;
    }
  } else if (Array.isArray(raw.nativeTransfers) && raw.nativeTransfers.length > 0) {
    let sum = 0;
    for (const n of raw.nativeTransfers) {
      if (!isObj(n)) continue;
      const amt = numish(n.amount);
      if (amt == null) continue;
      if (str(n.fromUserAccount) === wallet) sum -= Math.abs(amt);
      if (str(n.toUserAccount) === wallet) sum += Math.abs(amt);
    }
    nativeLamports = sum;
  } else if (Array.isArray(raw.accountData)) {
    let sum = 0;
    let saw = false;
    for (const ad of raw.accountData) {
      if (!isObj(ad) || str(ad.account) !== wallet) continue;
      const change = numish(ad.nativeBalanceChange);
      if (change == null) continue;
      saw = true;
      sum += change;
    }
    if (saw) {
      if (feePayerOf(raw, keys) === wallet) sum += numish(raw.fee) ?? 0;
      nativeLamports = sum;
    }
  }
  if (nativeLamports === 0 && hasSwapEvent(raw)) {
    const swap = (raw.events as Record<string, unknown>).swap as Record<string, unknown>;
    const nativeIn = isObj(swap.nativeInput) ? swap.nativeInput : null;
    const nativeOut = isObj(swap.nativeOutput) ? swap.nativeOutput : null;
    if (nativeIn && str(nativeIn.account) === wallet) {
      const lamports = numish(nativeIn.amount);
      if (lamports != null) nativeLamports -= Math.abs(lamports);
    }
    if (nativeOut && str(nativeOut.account) === wallet) {
      const lamports = numish(nativeOut.amount);
      if (lamports != null) nativeLamports += Math.abs(lamports);
    }
  }

  return { tokens, nativeLamports };
}

function walletMentioned(raw: Record<string, unknown>, wallet: string, keys: string[]): boolean {
  if (feePayerOf(raw, keys) === wallet) return true;
  if (keys.includes(wallet)) return true;
  const lists = [raw.tokenTransfers, raw.nativeTransfers, raw.accountData];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (!isObj(row)) continue;
      if (str(row.fromUserAccount) === wallet || str(row.toUserAccount) === wallet || str(row.account) === wallet || str(row.userAccount) === wallet) {
        return true;
      }
      if (Array.isArray(row.tokenBalanceChanges)) {
        for (const ch of row.tokenBalanceChanges) {
          if (isObj(ch) && str(ch.userAccount) === wallet) return true;
        }
      }
    }
  }
  return false;
}

function fail(
  reason: HeliusRejectReason,
  signature: string | null,
  programIds: string[],
  swapLike: boolean,
): HeliusBuyResult {
  return { ok: false, reason, signature, programIds, report: shouldReportHeliusFailure(reason, swapLike) };
}

function venueIds(programIds: string[]): string[] {
  return programIds.filter((id) => !INFRA_PROGRAMS.has(id));
}

/**
 * `wallet` is the watched KOL address. A positive non-base token balance
 * together with SOL / WSOL / USDC / USDT spent is a buy, whatever program
 * moved the funds.
 */
export function parseHeliusWalletBuy(raw: unknown, wallet: string): HeliusBuyResult {
  if (!isObj(raw)) return fail("not_object", null, [], true);
  const programIds = collectProgramIds(raw);
  const venues = venueIds(programIds);
  const signature = signatureOf(raw);
  const swapLike = str(raw.type) === "SWAP" || hasSwapEvent(raw) || venues.length > 0;
  if (!signature) return fail("no_signature", null, programIds, swapLike);
  if (failed(raw)) return fail("failed_tx", signature, programIds, swapLike);
  const keys = accountKeysOf(raw);
  if (!walletMentioned(raw, wallet, keys)) return fail("wallet_not_involved", signature, programIds, false);

  const { tokens, nativeLamports } = balancesFor(raw, wallet, keys);
  const nativeSol = nativeLamports / 1e9;
  const wsol = tokens.get(WSOL_MINT) ?? 0;
  // Native SOL and WSOL often describe the same wrap. Take the larger leg, not the sum.
  const netSol = Math.abs(wsol) >= Math.abs(nativeSol) ? wsol : nativeSol;
  const received = [...tokens.entries()]
    .filter(([mint, delta]) => !BASE_MINTS.has(mint) && delta > DUST)
    .sort((a, b) => b[1] - a[1]);
  const spentToken = [...tokens.entries()].some(([mint, delta]) => !BASE_MINTS.has(mint) && delta < -DUST);
  const stableSpent = Math.max(0, -(tokens.get(USDC_MINT) ?? 0)) + Math.max(0, -(tokens.get(USDT_MINT) ?? 0));
  const solSpent = netSol < -DUST ? -netSol : 0;

  if (received.length === 0) {
    if (spentToken && netSol > DUST) return fail("not_buy", signature, programIds, swapLike);
    const anyToken = [...tokens.values()].some((d) => Math.abs(d) > DUST);
    if (!anyToken && Math.abs(nativeSol) <= DUST) {
      // Third-party bots (e.g. program DhpyN…) list dozens of KOL wallets as read-only
      // accounts. The KOL did not sign and nothing moved: not their activity.
      if (feePayerOf(raw, keys) !== wallet) return fail("wallet_not_involved", signature, programIds, false);
      return fail("no_balance_change", signature, programIds, swapLike);
    }
    return fail("not_buy", signature, programIds, swapLike);
  }
  if (received.length > 1 && received[1]![1] * 1000 > received[0]![1]) {
    return fail("ambiguous_mints", signature, programIds, true);
  }
  if (solSpent <= DUST && stableSpent <= DUST) {
    if (spentToken) return fail("paid_with_non_base", signature, programIds, true);
    return fail("no_quote_spent", signature, programIds, swapLike);
  }

  const [mint, tokenUi] = received[0]!;
  const priceSol = solSpent > DUST ? solSpent / tokenUi : null;
  const program = venues.length > 0 ? venues.map(labelProgram).join("+") : str(raw.source);
  const buy: KolBuy = {
    tx: signature,
    wallet,
    mint,
    symbol: null,
    kolName: null,
    kolPriceUsd: stableSpent > DUST && solSpent <= DUST ? stableSpent / tokenUi : null,
    volumeUsd: stableSpent > DUST ? stableSpent : 0,
    volumeSol: solSpent,
    solUsd: null,
    tradeTimeMs: timeMs(raw),
    program,
    priceSol,
    programIds: venues.length > 0 ? venues : programIds,
  };
  return { ok: true, buy };
}
