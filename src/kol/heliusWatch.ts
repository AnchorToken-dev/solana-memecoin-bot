/**
 * Poll Helius address history for KOL wallets and emit buys.
 *
 * History calls are paced (minimum gap between starts, plus a concurrency cap).
 * HTTP 429 stops the rest of that sweep, backs off (honouring Retry-After), and
 * the next sweep resumes at the wallet that was limited.
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
const RETRY_AFTER_CAP_MS = 300_000;

export interface HeliusHistoryClient {
  getTransactions(wallet: string): Promise<unknown[]>;
}

export interface HeliusWatchStats {
  polls: number;
  /** Failures other than HTTP 429. */
  errors: number;
  /** HTTP 429 responses. A sweep starts no further history calls after the first 429. */
  rateLimits: number;
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
  /** Minimum time between history-call starts. 0 disables the gap. Default 250. */
  minIntervalMs?: number;
  /** Max history calls in flight at once. Default 1. */
  concurrency?: number;
  /** Cap on the wait after an error or HTTP 429. Default 60s. */
  maxBackoffMs?: number;
  /** Called for failures that should be visible (program ids + reason). */
  onNote?: (line: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const SEEN_CAP = 6_000;

export function redactSecrets(message: string): string {
  return message
    .replace(/api-key=[^&\s]+/gi, "api-key=[redacted]")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[url]")
    .slice(0, 200);
}

/** `Retry-After` as delta-seconds or an HTTP date. Null when the header is absent or not a date. */
export function parseRetryAfterMs(raw: string | null | undefined, nowMs: number): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return null;
    return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, Math.round(seconds * 1000)));
  }
  const when = Date.parse(trimmed);
  if (!Number.isFinite(when)) return null;
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(0, when - nowMs));
}

export class HeliusHttpError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, retryAfterMs: number | null) {
    super(`helius history HTTP ${status}`);
    this.name = "HeliusHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface HeliusFetchResponse {
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
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
        const retryAfterMs = parseRetryAfterMs(headerGet(res, "retry-after"), Date.now());
        const text = await res.text();
        if (!res.ok) throw new HeliusHttpError(res.status, retryAfterMs);
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
        if (err instanceof HeliusHttpError) throw err;
        const msg = err instanceof Error ? err.message : "helius history request failed";
        throw new Error(redactSecrets(msg));
      }
    },
  };
}

type ReadOutcome =
  | { kind: "ok" }
  | { kind: "error" }
  | { kind: "rate_limit"; retryAfterMs: number };

export class HeliusWalletWatch {
  readonly stats: HeliusWatchStats = {
    polls: 0, errors: 0, rateLimits: 0, rows: 0, buys: 0, rejected: {}, unreadable: 0, possibleGaps: 0, lastError: null, lastUnreadable: null,
  };
  private readonly seen = new Set<string>();
  private readonly baselined = new Set<string>();
  private backoffMs = 0;
  /** Wallet index the next sweep starts at. A 429 leaves this on the wallet that was limited. */
  private cursor = 0;
  private timer: unknown = null;
  private stopped = true;
  private aborted = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private readonly minIntervalMs: number;
  private readonly concurrency: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly client: HeliusHistoryClient,
    private readonly wallets: readonly string[],
    private readonly onBuy: (buy: KolBuy) => void,
    private readonly opts: HeliusWatchOptions,
  ) {
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 250);
    this.concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
    this.maxBackoffMs = Math.max(1_000, opts.maxBackoffMs ?? 60_000);
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.aborted = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.aborted = true;
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

  /** One pass over watched wallets. Never throws. The first pass per wallet only records signatures. */
  async pollOnce(): Promise<void> {
    this.stats.polls++;
    const wallets = this.wallets;
    const n = wallets.length;
    if (n === 0 || this.aborted) return;

    const start = this.cursor % n;
    const concurrency = Math.min(this.concurrency, n);
    let next = 0;
    let stop = false;
    let anyError = false;
    let rateLimited = false;
    let retryAfterMs = 0;
    let firstHalt: number | null = null;
    const sem = new Semaphore(concurrency);
    const pacer = new StartPacer(this.minIntervalMs, this.sleep, this.now);

    const worker = async (): Promise<void> => {
      try {
        for (;;) {
          if (stop || this.aborted) return;
          const i = next++;
          if (i >= n) return;
          await sem.acquire();
          try {
            if (stop || this.aborted) continue;
            await pacer.waitTurn();
            if (stop || this.aborted) continue;
            const wallet = wallets[(start + i) % n]!;
            const outcome = await this.readWallet(wallet);
            switch (outcome.kind) {
              case "ok":
                break;
              case "error":
                anyError = true;
                break;
              case "rate_limit":
                anyError = true;
                rateLimited = true;
                stop = true;
                if (outcome.retryAfterMs > retryAfterMs) retryAfterMs = outcome.retryAfterMs;
                if (firstHalt == null || i < firstHalt) firstHalt = i;
                break;
              default: {
                const neverOutcome: never = outcome;
                return neverOutcome;
              }
            }
          } finally {
            sem.release();
          }
        }
      } catch (err) {
        anyError = true;
        this.stats.errors++;
        this.stats.lastError = redactSecrets(err instanceof Error ? err.message : String(err));
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    this.cursor = firstHalt != null ? (start + firstHalt) % n : 0;
    this.applyBackoff(rateLimited, anyError, retryAfterMs);
  }

  private async readWallet(wallet: string): Promise<ReadOutcome> {
    let page: unknown[];
    try {
      page = await this.client.getTransactions(wallet);
    } catch (err) {
      const failure = describeHeliusFailure(err);
      const message = err instanceof Error ? err.message : String(err);
      const wait = failure.rateLimit && failure.retryAfterMs > 0
        ? ` (retry after ${Math.ceil(failure.retryAfterMs / 1000)}s)`
        : "";
      this.stats.lastError = redactSecrets(`${message}${wait}`);
      if (failure.rateLimit) {
        this.stats.rateLimits++;
        return { kind: "rate_limit", retryAfterMs: failure.retryAfterMs };
      }
      this.stats.errors++;
      return { kind: "error" };
    }
    this.ingest(wallet, page);
    return { kind: "ok" };
  }

  private ingest(wallet: string, page: unknown[]): void {
    if (!this.baselined.has(wallet)) {
      for (const tx of page) this.remember(sigOf(tx));
      this.baselined.add(wallet);
      return;
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

  private applyBackoff(rateLimited: boolean, anyError: boolean, retryAfterMs: number): void {
    if (!anyError) {
      this.backoffMs = 0;
      return;
    }
    const cap = this.maxBackoffMs;
    const doubled = Math.min(cap, (this.backoffMs || this.opts.pollMs) * 2);
    this.backoffMs = rateLimited ? Math.min(cap, Math.max(doubled, retryAfterMs)) : doubled;
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

function headerGet(res: HeliusFetchResponse, name: string): string | null {
  const headers = res.headers;
  if (!headers || typeof headers.get !== "function") return null;
  return headers.get(name);
}

function describeHeliusFailure(err: unknown): { rateLimit: boolean; retryAfterMs: number } {
  const obj = err !== null && typeof err === "object" ? err as Record<string, unknown> : null;
  const status = err instanceof HeliusHttpError
    ? err.status
    : typeof obj?.status === "number" && Number.isFinite(obj.status)
      ? obj.status
      : 0;
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const rateLimit = status === 429 || /\bHTTP 429\b/.test(msg);
  let retryAfterMs = 0;
  if (err instanceof HeliusHttpError && err.retryAfterMs != null && Number.isFinite(err.retryAfterMs)) {
    retryAfterMs = err.retryAfterMs;
  } else if (obj) {
    if (typeof obj.retryAfterMs === "number" && Number.isFinite(obj.retryAfterMs)) retryAfterMs = obj.retryAfterMs;
    else if (typeof obj.retryAfter === "number" && Number.isFinite(obj.retryAfter)) retryAfterMs = obj.retryAfter * 1000;
  }
  return { rateLimit, retryAfterMs: Math.max(0, retryAfterMs) };
}

/** Spaces call starts by `minIntervalMs`. The first start in a sweep waits 0. */
class StartPacer {
  private tail: Promise<void> = Promise.resolve();
  private nextAt: number;

  constructor(
    private readonly minIntervalMs: number,
    private readonly sleep: (ms: number) => Promise<void>,
    private readonly now: () => number,
  ) {
    this.nextAt = now();
  }

  waitTurn(): Promise<void> {
    const run = this.tail.then(async () => {
      const wait = this.nextAt - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextAt = this.now() + this.minIntervalMs;
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active++;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiting.shift();
    if (next) next();
  }
}

function sigOf(tx: unknown): string | null {
  if (!tx || typeof tx !== "object") return null;
  const sig = (tx as { signature?: unknown }).signature;
  return typeof sig === "string" && sig.trim() ? sig.trim() : null;
}
