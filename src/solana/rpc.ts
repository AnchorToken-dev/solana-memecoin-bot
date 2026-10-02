/**
 * Read-only Solana JSON-RPC.
 *
 * Allowed methods: getAccountInfo, getSignaturesForAddress, getTransaction,
 * getTokenLargestAccounts. Mint accounts are parsed from getAccountInfo.
 *
 * No sendTransaction, no signing, no keypair loading. The endpoint URL is
 * never included in errors or logs.
 */
import { fetchWithTimeout, type FetchLike } from "../market/http.js";
import { base58Encode } from "./base58.js";

export const SOLANA_RPC_URL_ENV = "SOLANA_RPC_URL";

/** Trimmed SOLANA_RPC_URL, or null when unset/blank. Never log the return value. */
export function readSolanaRpcUrl(): string | null {
  const v = process.env[SOLANA_RPC_URL_ENV]?.trim();
  return v ? v : null;
}

export function solanaRpcIsConfigured(): boolean {
  return readSolanaRpcUrl() != null;
}

export interface RpcOk<T> {
  ok: true;
  value: T;
}
export interface RpcErr {
  ok: false;
  /** Safe to log. Never contains the RPC URL. */
  error: string;
}
export type RpcResult<T> = RpcOk<T> | RpcErr;

export interface AccountInfo {
  lamports: number;
  owner: string;
  executable: boolean;
  data: Uint8Array;
}

export interface ParsedMint {
  supply: bigint;
  decimals: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  blockTime: number | null;
}

export interface LargestTokenAccount {
  address: string;
  amount: bigint;
  decimals: number;
}

export interface TransactionInfo {
  slot: number;
  blockTime: number | null;
  transaction: unknown;
  meta: unknown;
}

/** Methods this client is allowed to POST. Anything else is refused locally. */
export const READ_ONLY_RPC_METHODS = [
  "getAccountInfo",
  "getSignaturesForAddress",
  "getTransaction",
  "getTokenLargestAccounts",
] as const;

const ALLOWED_METHODS = new Set<string>(READ_ONLY_RPC_METHODS);

function redact(message: string, secret: string): string {
  let m = message;
  if (secret) m = m.split(secret).join("[rpc]");
  m = m.replace(/https?:\/\/[^\s"'<>]+/gi, "[rpc]");
  return m.slice(0, 240);
}

/**
 * SPL mint account (82-byte header; Token-2022 extensions after that are ignored).
 * COption<Pubkey> is a 4-byte LE tag (0 none, 1 some) plus 32 bytes.
 * Returns null when the buffer is too short or a tag is not 0/1.
 */
export function parseSplMint(data: Uint8Array): ParsedMint | null {
  if (data.length < 82) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const mintAuth = readCOptionPubkey(data, 0);
  if (mintAuth === undefined) return null;
  const supply = view.getBigUint64(36, true);
  const decimals = data[44]!;
  const freeze = readCOptionPubkey(data, 46);
  if (freeze === undefined) return null;
  return {
    supply,
    decimals,
    mintAuthority: mintAuth,
    freezeAuthority: freeze,
  };
}

/** undefined = malformed tag; null = None. */
function readCOptionPubkey(
  data: Uint8Array,
  offset: number,
): string | null | undefined {
  if (offset + 36 > data.length) return undefined;
  const tag = new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getUint32(offset, true);
  const pk = data.subarray(offset + 4, offset + 36);
  if (tag === 0) return null;
  if (tag === 1) return base58Encode(pk);
  return undefined;
}

/** SPL token-account holder pubkey (bytes 32..64). Null if the buffer is short. */
export function parseTokenAccountHolder(data: Uint8Array): string | null {
  if (data.length < 64) return null;
  return base58Encode(data.subarray(32, 64));
}

export class ReadOnlySolanaRpc {
  constructor(
    private readonly endpoint: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 8_000,
  ) {}

  /** Null when SOLANA_RPC_URL is unset. Does not throw. */
  static fromEnv(fetchImpl?: FetchLike): ReadOnlySolanaRpc | null {
    const url = readSolanaRpcUrl();
    if (!url) return null;
    return new ReadOnlySolanaRpc(url, fetchImpl);
  }

  async getAccountInfo(pubkey: string): Promise<RpcResult<AccountInfo | null>> {
    const res = await this.rpc("getAccountInfo", [
      pubkey,
      { encoding: "base64", commitment: "confirmed" },
    ]);
    if (!res.ok) return res;
    const wrapped = res.value as { value?: unknown } | null;
    const value = wrapped && typeof wrapped === "object" ? wrapped.value ?? null : null;
    if (value == null) return { ok: true, value: null };
    const parsed = parseAccountInfo(value);
    if (!parsed) {
      return { ok: false, error: "getAccountInfo: unexpected account payload" };
    }
    return { ok: true, value: parsed };
  }

  /** Parsed SPL mint, or null when the account does not exist. */
  async getMintAccount(mint: string): Promise<RpcResult<ParsedMint | null>> {
    const info = await this.getAccountInfo(mint);
    if (!info.ok) return info;
    if (!info.value) return { ok: true, value: null };
    const mintParsed = parseSplMint(info.value.data);
    if (!mintParsed) {
      return { ok: false, error: "mint account data is not an SPL mint" };
    }
    return { ok: true, value: mintParsed };
  }

  async getSignaturesForAddress(
    address: string,
    opts?: { limit?: number },
  ): Promise<RpcResult<SignatureInfo[]>> {
    const limit = Math.max(1, Math.min(opts?.limit ?? 1000, 1000));
    const res = await this.rpc("getSignaturesForAddress", [
      address,
      { limit, commitment: "confirmed" },
    ]);
    if (!res.ok) return res;
    if (!Array.isArray(res.value)) {
      return { ok: false, error: "getSignaturesForAddress: expected array" };
    }
    const out: SignatureInfo[] = [];
    for (const row of res.value) {
      if (!row || typeof row !== "object") continue;
      const r = row as {
        signature?: unknown;
        slot?: unknown;
        err?: unknown;
        blockTime?: unknown;
      };
      if (typeof r.signature !== "string" || typeof r.slot !== "number") continue;
      out.push({
        signature: r.signature,
        slot: r.slot,
        err: r.err ?? null,
        blockTime: typeof r.blockTime === "number" ? r.blockTime : null,
      });
    }
    return { ok: true, value: out };
  }

  async getTransaction(
    signature: string,
  ): Promise<RpcResult<TransactionInfo | null>> {
    const res = await this.rpc("getTransaction", [
      signature,
      {
        encoding: "json",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      },
    ]);
    if (!res.ok) return res;
    if (res.value == null) return { ok: true, value: null };
    if (typeof res.value !== "object") {
      return { ok: false, error: "getTransaction: unexpected payload" };
    }
    const tx = res.value as {
      slot?: unknown;
      blockTime?: unknown;
      transaction?: unknown;
      meta?: unknown;
    };
    if (typeof tx.slot !== "number") {
      return { ok: false, error: "getTransaction: missing slot" };
    }
    return {
      ok: true,
      value: {
        slot: tx.slot,
        blockTime: typeof tx.blockTime === "number" ? tx.blockTime : null,
        transaction: tx.transaction ?? null,
        meta: tx.meta ?? null,
      },
    };
  }

  async getTokenLargestAccounts(
    mint: string,
  ): Promise<RpcResult<LargestTokenAccount[]>> {
    const res = await this.rpc("getTokenLargestAccounts", [
      mint,
      { commitment: "confirmed" },
    ]);
    if (!res.ok) return res;
    const wrapped = res.value as { value?: unknown } | null;
    const value =
      wrapped && typeof wrapped === "object" ? wrapped.value : undefined;
    if (!Array.isArray(value)) {
      return { ok: false, error: "getTokenLargestAccounts: expected value array" };
    }
    const out: LargestTokenAccount[] = [];
    for (const row of value) {
      if (!row || typeof row !== "object") continue;
      const r = row as {
        address?: unknown;
        amount?: unknown;
        decimals?: unknown;
      };
      if (typeof r.address !== "string" || typeof r.amount !== "string") continue;
      let amount: bigint;
      try {
        amount = BigInt(r.amount);
      } catch {
        continue;
      }
      out.push({
        address: r.address,
        amount,
        decimals: typeof r.decimals === "number" ? r.decimals : 0,
      });
    }
    return { ok: true, value: out };
  }

  private async rpc(
    method: string,
    params: unknown[],
  ): Promise<RpcResult<unknown>> {
    if (!ALLOWED_METHODS.has(method)) {
      return { ok: false, error: `blocked rpc method: ${method}` };
    }
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
    try {
      const res = await fetchWithTimeout(
        this.endpoint,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        },
        this.timeoutMs,
        this.fetchImpl,
      );
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, error: redact(`HTTP ${res.status}`, this.endpoint) };
      }
      let json: unknown;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        return { ok: false, error: "rpc response was not JSON" };
      }
      if (!json || typeof json !== "object") {
        return { ok: false, error: "rpc response was not an object" };
      }
      const obj = json as { error?: { message?: string }; result?: unknown };
      if (obj.error) {
        const msg =
          typeof obj.error.message === "string" ? obj.error.message : "rpc error";
        return { ok: false, error: redact(msg, this.endpoint) };
      }
      return { ok: true, value: obj.result ?? null };
    } catch (err) {
      const raw = err instanceof Error ? err.message : "rpc request failed";
      return { ok: false, error: redact(raw || "rpc request failed", this.endpoint) };
    }
  }
}

function parseAccountInfo(value: unknown): AccountInfo | null {
  if (!value || typeof value !== "object") return null;
  const v = value as {
    lamports?: unknown;
    owner?: unknown;
    executable?: unknown;
    data?: unknown;
  };
  if (typeof v.owner !== "string" || typeof v.lamports !== "number") return null;
  const data = decodeBase64Data(v.data);
  if (!data) return null;
  return {
    lamports: v.lamports,
    owner: v.owner,
    executable: v.executable === true,
    data,
  };
}

function decodeBase64Data(data: unknown): Uint8Array | null {
  let b64: string | null = null;
  if (typeof data === "string") b64 = data;
  else if (Array.isArray(data) && typeof data[0] === "string") b64 = data[0];
  if (b64 == null) return null;
  const buf = Buffer.from(b64, "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
