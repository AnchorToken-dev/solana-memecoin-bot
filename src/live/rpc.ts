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

export interface LiveRpc {
  getBalanceLamports(pubkey: string): Promise<number>;
  simulate(txBase64: string): Promise<{ err: unknown; logs: string[] | null; unitsConsumed?: number }>;
  send(txBase64: string): Promise<string>;
  getSignatureStatus(sig: string): Promise<SignatureStatus | null>;
  getTransactionMeta(sig: string): Promise<{ meta: TxMeta; accountKeys: string[] } | null>;
  /** Optional (vault sweep): recent blockhash + its expiry height. */
  getLatestBlockhash?(): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getBlockHeight?(): Promise<number>;
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
