/**
 * KOL trade feed (Solana Tracker `GET /trades/kols`, SDK `client.getKolTrades`).
 *
 * Shadow logging only: nothing here can place a trade. Two pieces:
 *  - normalizeKolTrade(): one raw row -> a clean "KOL bought coin X" event, or a reason it was dropped.
 *  - KolTradePoller: polls the newest rows, skips what it has already seen, emits new buys.
 *
 * Written against the documented response (tx, amount, priceUsd, volume, volumeSol, type, wallet,
 * time (ms), program, pools, identity, and meta.from / meta.to when showMeta=true). The token that
 * was bought is meta.to.address, so showMeta is always requested. Every field is validated; a row
 * that doesn't look right is dropped and counted, never guessed at.
 */

export const WSOL_MINT = "So11111111111111111111111111111111111111112";
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const BASE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

export interface KolBuy {
  tx: string;
  wallet: string;
  /** Token the KOL received. */
  mint: string;
  symbol: string | null;
  kolName: string | null;
  /** The KOL's fill price (USD per token), from the row. */
  kolPriceUsd: number | null;
  volumeUsd: number;
  volumeSol: number;
  /** SOL price implied by the row (volume / volumeSol). */
  solUsd: number | null;
  /** The row's own timestamp (ms). */
  tradeTimeMs: number;
  program: string | null;
}

export type RejectReason =
  | "not_object"
  | "not_buy"
  | "bad_fields"
  | "no_meta"
  | "bought_base_currency"
  | "paid_with_non_base";

export type NormalizeResult = { ok: true; buy: KolBuy } | { ok: false; reason: RejectReason };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function normalizeKolTrade(raw: unknown): NormalizeResult {
  if (!isObj(raw)) return { ok: false, reason: "not_object" };
  if (raw.type !== "buy") return { ok: false, reason: "not_buy" };
  const tx = str(raw.tx);
  const wallet = str(raw.wallet);
  const time = num(raw.time);
  const volume = num(raw.volume);
  const volumeSol = num(raw.volumeSol);
  if (!tx || !wallet || time == null || time <= 0 || volume == null || volumeSol == null) {
    return { ok: false, reason: "bad_fields" };
  }
  const meta = isObj(raw.meta) ? raw.meta : null;
  const to = meta && isObj(meta.to) ? meta.to : null;
  const from = meta && isObj(meta.from) ? meta.from : null;
  const mint = to ? str(to.address) : null;
  if (!to || !from || !mint) return { ok: false, reason: "no_meta" };
  if (BASE_MINTS.has(mint)) return { ok: false, reason: "bought_base_currency" };
  const fromMint = str(from.address);
  if (!fromMint || !BASE_MINTS.has(fromMint)) return { ok: false, reason: "paid_with_non_base" };

  const toPrice = num(to.priceUsd);
  const rowPrice = num(raw.priceUsd);
  const kolPriceUsd = toPrice != null && toPrice > 0 ? toPrice : rowPrice != null && rowPrice > 0 ? rowPrice : null;
  const identity = isObj(raw.identity) ? raw.identity : null;
  return {
    ok: true,
    buy: {
      tx,
      wallet,
      mint,
      symbol: str(to.symbol),
      kolName: identity ? str(identity.name) : null,
      kolPriceUsd,
      volumeUsd: volume,
      volumeSol,
      solUsd: volumeSol > 0 && volume > 0 ? volume / volumeSol : null,
      tradeTimeMs: time,
      program: str(raw.program),
    },
  };
}

/** Subset of the SDK client the poller needs (so tests can fake it). */
export interface KolClientLike {
  getKolTrades(params?: { minVolume?: 0; limit?: number; showMeta?: boolean; sortDirection?: "DESC" }): Promise<{ trades: unknown[] }>;
}

export interface PollerStats {
  polls: number;
  errors: number;
  rows: number;
  buys: number;
  rejected: Record<string, number>;
  /** A poll where EVERY returned row was new: rows may have been missed between polls. */
  possibleGaps: number;
  lastError: string | null;
}

export interface PollerOptions {
  pollMs: number;
  limit?: number;
  /** Only emit buys from these wallets (null/undefined = every KOL wallet in the feed). */
  onlyWallets?: ReadonlySet<string> | null;
  /** Called with each raw response (used to save a few raw samples for format checks). */
  onRaw?: (resp: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

const SEEN_CAP = 6_000;

export class KolTradePoller {
  readonly stats: PollerStats = { polls: 0, errors: 0, rows: 0, buys: 0, rejected: {}, possibleGaps: 0, lastError: null };
  private readonly seen = new Set<string>();
  private baselined = false;
  private backoffMs = 0;
  private timer: unknown = null;
  private stopped = true;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(
    private readonly client: KolClientLike,
    private readonly onBuy: (buy: KolBuy) => void,
    private readonly opts: PollerOptions,
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

  /** One poll. Never throws. The FIRST successful poll only records what is already there. */
  async pollOnce(): Promise<void> {
    this.stats.polls++;
    let resp: { trades: unknown[] };
    try {
      resp = await this.client.getKolTrades({ minVolume: 0, limit: this.opts.limit ?? 100, showMeta: true, sortDirection: "DESC" });
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = errMsg(err);
      const retryAfterS = isObj(err) && typeof err.retryAfter === "number" ? err.retryAfter : 0;
      this.backoffMs = Math.min(60_000, Math.max(retryAfterS * 1000, (this.backoffMs || this.opts.pollMs) * 2));
      return;
    }
    this.backoffMs = 0;
    try {
      this.opts.onRaw?.(resp);
    } catch {
      /* sample saving must never break polling */
    }
    const trades = Array.isArray(resp?.trades) ? resp.trades : [];
    if (!this.baselined) {
      for (const t of trades) this.remember(keyOf(t));
      this.baselined = true;
      return;
    }
    let fresh = 0;
    // Feed is newest-first; emit oldest-first.
    for (let i = trades.length - 1; i >= 0; i--) {
      const t = trades[i];
      const k = keyOf(t);
      if (k == null || this.seen.has(k)) continue;
      this.remember(k);
      fresh++;
      this.stats.rows++;
      const r = normalizeKolTrade(t);
      if (!r.ok) {
        this.stats.rejected[r.reason] = (this.stats.rejected[r.reason] ?? 0) + 1;
        continue;
      }
      if (this.opts.onlyWallets && !this.opts.onlyWallets.has(r.buy.wallet)) continue;
      this.stats.buys++;
      try {
        this.onBuy(r.buy);
      } catch (err) {
        this.stats.lastError = errMsg(err);
      }
    }
    if (trades.length > 0 && fresh === trades.length) this.stats.possibleGaps++;
  }

  private remember(k: string | null): void {
    if (k == null) return;
    this.seen.add(k);
    if (this.seen.size > SEEN_CAP) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
  }
}

function keyOf(t: unknown): string | null {
  if (!isObj(t)) return null;
  const tx = str(t.tx);
  const w = str(t.wallet);
  return tx && w ? `${tx}:${w}:${String(t.type)}` : null;
}

function errMsg(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  // Never let a URL or key from an error text reach logs.
  return m.replace(/https?:\/\/[^\s"'<>]+/gi, "[url]").slice(0, 200);
}
