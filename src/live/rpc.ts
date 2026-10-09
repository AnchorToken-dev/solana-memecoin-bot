/**
 * HTTPS JSON-RPC client for the live path ONLY (send/simulate/confirm).
 * Lives apart from the read-only client in src/solana/rpc.ts so the paper
 * path can never reach sendTransaction. Errors never include the URL.
 */
import { fetchWithTimeout, type FetchLike } from "../market/http.js";
import { readSolanaRpcUrl } from "../solana/rpc.js";
import { redactSecrets } from "./redact.js";

export interface SignatureStatus {
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  err: unknown;
}

export interface TokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null };
}

export interface TxMeta {
  err: unknown;
  fee: number;
  preBalances: number[];
  postBalances: number[];
  preTokenBalances?: TokenBalance[];
  postTokenBalances?: TokenBalance[];
}

/** SPL Token + Token-2022 program ids (wallet token balances for live reconciliation). */
export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** One wallet token account (UI amount = raw / 10^decimals). */
export interface WalletTokenAccount {
  mint: string;
  /** Raw integer amount as a string (exact). */
  amount: string;
  decimals: number;
  programId: string;
}

export interface LiveRpc {
  getBalanceLamports(pubkey: string): Promise<number>;
  simulate(txBase64: string): Promise<{ err: unknown; logs: string[] | null; unitsConsumed?: number }>;
  send(txBase64: string): Promise<string>;
  getSignatureStatus(sig: string): Promise<SignatureStatus | null>;
  getTransactionMeta(sig: string): Promise<{ meta: TxMeta; accountKeys: string[] } | null>;
  /** Optional (vault sweep): recent blockhash + its expiry height. */
  getLatestBlockhash?(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getBlockHeight?(): Promise<number>;
  /** Optional (PumpSwap quote fix): raw account data, null if the account doesn't exist. Read-only. */
  getAccountData?(pubkey: string): Promise<Uint8Array | null>;
  /** Optional (startup reconciliation): owner's SPL token accounts for one token program. Read-only. */
  getTokenAccountsByOwner?(owner: string, programId: string): Promise<WalletTokenAccount[]>;
}

export class HttpsLiveRpc implements LiveRpc {
  private id = 0;
  constructor(
    private readonly url: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  static fromEnv(): HttpsLiveRpc | null {
    const u = readSolanaRpcUrl();
    return u ? new HttpsLiveRpc(u) : null;
  }

  private async call<T>(method: string, params: unknown[]): Promise<T> {
    try {
      const res = await fetchWithTimeout(
        this.url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
        },
        this.timeoutMs,
        this.fetchImpl,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { result?: T; error?: { message?: string } };
      if (j.error) throw new Error(j.error.message ?? "rpc error");
      return j.result as T;
    } catch (err) {
      throw new Error(`${method} failed: ${redactSecrets(err)}`);
    }
  }

  async getBalanceLamports(pubkey: string): Promise<number> {
    const r = await this.call<{ value: number }>("getBalance", [pubkey, { commitment: "confirmed" }]);
    return r.value;
  }

  async simulate(txBase64: string) {
    const r = await this.call<{ value: { err: unknown; logs: string[] | null; unitsConsumed?: number } }>(
      "simulateTransaction",
      [txBase64, { encoding: "base64", sigVerify: true, commitment: "processed", replaceRecentBlockhash: false }],
    );
    return r.value;
  }

  async send(txBase64: string): Promise<string> {
    return this.call<string>("sendTransaction", [
      txBase64,
      { encoding: "base64", skipPreflight: false, preflightCommitment: "processed", maxRetries: 3 },
    ]);
  }

  async getSignatureStatus(sig: string): Promise<SignatureStatus | null> {
    const r = await this.call<{ value: (SignatureStatus | null)[] }>("getSignatureStatuses", [
      [sig],
      { searchTransactionHistory: true },
    ]);
    return r.value[0] ?? null;
  }

  async getLatestBlockhash() {
    const r = await this.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>("getLatestBlockhash", [
      { commitment: "confirmed" },
    ]);
    return r.value;
  }

  async getBlockHeight(): Promise<number> {
    return this.call<number>("getBlockHeight", [{ commitment: "confirmed" }]);
  }

  async getAccountData(pubkey: string): Promise<Uint8Array | null> {
    const r = await this.call<{ value: { data: [string, string] } | null }>("getAccountInfo", [
      pubkey,
      { encoding: "base64", commitment: "processed" },
    ]);
    if (!r.value) return null;
    return new Uint8Array(Buffer.from(r.value.data[0], "base64"));
  }

  async getTokenAccountsByOwner(owner: string, programId: string): Promise<WalletTokenAccount[]> {
    const r = await this.call<{
      value: Array<{
        account: {
          data: { parsed?: { info?: { mint?: string; tokenAmount?: { amount?: string; decimals?: number } } } };
        };
      }>;
    }>("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const out: WalletTokenAccount[] = [];
    for (const v of r.value ?? []) {
      const info = v.account?.data?.parsed?.info;
      const amt = info?.tokenAmount;
      if (!info?.mint || typeof amt?.amount !== "string" || typeof amt.decimals !== "number") continue;
      out.push({ mint: info.mint, amount: amt.amount, decimals: amt.decimals, programId });
    }
    return out;
  }

  async getTransactionMeta(sig: string) {
    const r = await this.call<{
      meta: TxMeta;
      transaction: { message: { accountKeys: ({ pubkey: string } | string)[] } };
    } | null>("getTransaction", [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (!r || !r.meta) return null;
    const accountKeys = r.transaction.message.accountKeys.map((k) => (typeof k === "string" ? k : k.pubkey));
    return { meta: r.meta, accountKeys };
  }
}
