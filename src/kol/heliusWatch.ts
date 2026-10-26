/**
 * Poll Helius address history for KOL wallets and emit buys.
 *
 * The history request is NOT filtered to type=SWAP. Helius only types a swap
 * when it already has a parser for that router; newer routers stay UNKNOWN
 * and a type filter would drop them before this parser can read the balances.
 *
 * No trading. The API key is never put in an error string.
 */
import { formatHeliusFailure, parseHeliusWalletBuy } from "./heliusBuy.js";
import type { KolBuy } from "./trades.js";

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface HeliusHistoryClient {
  getTransactions(wallet: string): Promise<unknown[]>;
}

export interface HeliusWatchStats {
  polls: number;
  errors: number;
  rows: number;
  buys: number;
  rejected: Record<string, number>;
  /** Swap-shaped transactions whose balances still could not be read. */
  unreadable: number;
  possibleGaps: number;
  lastError: string | null;
  lastUnreadable: string | null;
}

export interface HeliusWatchOptions {
  pollMs: number;
  /** Called for failures that should be visible (program ids + reason). */
  onNote?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const SEEN_CAP = 6_000;

export function redactSecrets(message: string): string {
  return message
    .replace(/api-key=[^&\s]+/gi, "api-key=[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .slice(0, 200);
}

export interface HeliusFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type HeliusFetch = (url: string) => Promise<HeliusFetchResponse>;

export function createHeliusHistoryClient(apiKey: string, fetchImpl: HeliusFetch = fetch, limit = 25): HeliusHistoryClient {
  const page = Math.min(100, Math.max(1, Math.floor(limit)));
  return {
    async getTransactions(wallet: string): Promise<unknown[]> {
      if (!BASE58.test(wallet)) throw new Error("helius history: wallet is not a public address");
      const url =
        `https://mainnet.helius-rpc.com/v0/addresses/${encodeURIComponent(wallet)}/transactions` +
        `?api-key=${encodeURIComponent(apiKey)}&limit=${page}&token-accounts=balanceChanged&commitment=confirmed`;
      try {
        const res = await fetchImpl(url);
        const text = await res.text();
        if (!res.ok) throw new Error(`helius history HTTP ${res.status}`);
        let body: unknown;
        try {
          body = JSON.parse(text) as unknown;
        } catch {
          throw new Error("helius history: response was not JSON");
        }
        if (Array.isArray(body)) return body;
        const errText = body && typeof body === "object" && "error" in body ? String((body as { error: unknown }).error) : "not a list";
        throw new Error(`helius history: ${redactSecrets(errText)}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "helius history request failed";
        throw new Error(redactSecrets(msg));
      }
    },
  };
}

export class HeliusWalletWatch {
  readonly stats: HeliusWatchStats = {
    polls: 0, errors: 0, rows: 0, buys: 0, rejected: {}, unreadable: 0, possibleGaps: 0, lastError: null, lastUnreadable: null,
  };
  private readonly seen = new Set<string>();
  private readonly baselined = new Set<string>();
  private backoffMs = 0;
  private timer: unknown = null;
  private stopped = true;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(
    private readonly client: HeliusHistoryClient,
    private readonly wallets: readonly string[],
    private readonly onBuy: (buy: KolBuy) => void,
    private readonly opts: HeliusWatchOptions,
  ) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer != null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private async loop(): Promise<void> {
    if (this.stopped) return;
    await this.pollOnce();
    if (this.stopped) return;
    const wait = this.backoffMs > 0 ? this.backoffMs : this.opts.pollMs;
    this.timer = this.setTimer(() => void this.loop(), wait);
  }

  /** One pass over every watched wallet. Never throws. The first pass per wallet only records signatures. */
  async pollOnce(): Promise<void> {
    this.stats.polls++;
    let anyError = false;
    for (const wallet of this.wallets) {
      let page: unknown[];
      try {
        page = await this.client.getTransactions(wallet);
      } catch (err) {
        anyError = true;
        this.stats.errors++;
        this.stats.lastError = redactSecrets(err instanceof Error ? err.message : String(err));
        continue;
      }
      if (!this.baselined.has(wallet)) {
        for (const tx of page) this.remember(sigOf(tx));
        this.baselined.add(wallet);
        continue;
      }
      let fresh = 0;
      for (let i = page.length - 1; i >= 0; i--) {
        const tx = page[i];
        const sig = sigOf(tx);
        if (!sig || this.seen.has(sig)) continue;
        this.remember(sig);
        fresh++;
        this.stats.rows++;
        const parsed = parseHeliusWalletBuy(tx, wallet);
        if (!parsed.ok) {
          this.stats.rejected[parsed.reason] = (this.stats.rejected[parsed.reason] ?? 0) + 1;
          if (parsed.report) {
            this.stats.unreadable++;
            const line = formatHeliusFailure(parsed);
            this.stats.lastUnreadable = line;
            this.opts.onNote?.(`unreadable ${line}`);
          }
          continue;
        }
        this.stats.buys++;
        try {
          this.onBuy(parsed.buy);
        } catch (err) {
          this.stats.lastError = redactSecrets(err instanceof Error ? err.message : String(err));
        }
      }
      if (page.length > 0 && fresh === page.length) this.stats.possibleGaps++;
    }
    this.backoffMs = anyError ? Math.min(60_000, (this.backoffMs || this.opts.pollMs) * 2) : 0;
  }

  private remember(sig: string | null): void {
    if (!sig) return;
    this.seen.add(sig);
    if (this.seen.size > SEEN_CAP) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

function sigOf(tx: unknown): string | null {
  if (!tx || typeof tx !== "object") return null;
  const sig = (tx as { signature?: unknown }).signature;
  return typeof sig === "string" && sig.trim() ? sig.trim() : null;
}
