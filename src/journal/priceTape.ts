/**
 * Price tape for the future "memory" feature: for every trade, what the coin
 * looked like before we bought, every mark we read while holding (~1s on-chain
 * polls), and a few minutes after we sold.
 *
 * One JSONL file per ET day: <mode ledger dir>/price-tape/YYYY-MM-DD.jsonl
 * (paper = data/, dry-run = data/live-dry-run/, live = data/live/).
 * Lines (all carry v, kind, tradeId, mint, symbol, mode, at):
 *   entry       — fill + quote vs on-chain price, scan snapshot, age, volume
 *                 share, run-up, rug-filter stats, the bot's own scan prices.
 *   pre_candles — ~10 x 1m candles from GeckoTerminal (async, best effort).
 *   exit        — exit fill + every mark while held: [msSinceEntry, priceUsd, src, quoteReserveSol?].
 *   post_exit   — [msSinceExit, priceUsd, quoteReserveSol?] on-chain reads every PRICE_TAPE_POST_EXIT_INTERVAL_MS for
 *                 PRICE_TAPE_POST_EXIT_SECONDS after the sell.
 *
 * Cheap by design: marks are buffered in memory and written once at exit;
 * writes are async and serialized; nothing here is awaited on the exit path.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { PriceTapeParams, TokenSnapshot } from "../types.js";
import { JOURNAL_TZ_DEFAULT, getZonedParts } from "./timezone.js";

export const DEFAULT_PRICE_TAPE: PriceTapeParams = {
  enabled: true,
  postExitSeconds: 180,
  postExitIntervalMs: 5_000,
  preCandles: true,
};

/** Hold-time marks kept per trade (~2h at 1s). Older ones are thinned. */
const MAX_MARKS = 7_200;

export type TapeMark = [msSinceEntry: number, priceUsd: number, src: "chain" | "quote", quoteReserveSol?: number];

export interface TapeOnchainRead {
  priceUsd: number;
  quoteReserveSol?: number;
  venue?: string;
}

/** [unix sec, open, high, low, close, volumeUsd] */
export type TapeCandle = [number, number, number, number, number, number];

export interface PriceTapeDeps {
  /** Fresh on-chain read for post-exit tracking; null = skip post-exit. */
  readOnchain?: ((mint: string) => Promise<TapeOnchainRead | null>) | null;
  /** 1m candles before entry for a market (pool / curve) address; null = skip. */
  fetchCandles?: ((market: string, beforeSec: number, limit: number) => Promise<TapeCandle[] | null>) | null;
  now?: () => number;
  timeZone?: string;
}

export interface TapeEntry {
  tradeId: string;
  mint: string;
  symbol: string;
  mode: string;
  at: number;
  fillPrice: number;
  quotePrice: number;
  onchainPrice: number | null;
  quoteVsOnchainPct: number | null;
  market?: string | null;
  venue?: string | null;
  notionalUsd: number;
  entryReason?: string;
  snapshot?: TokenSnapshot;
  scanPrices?: readonly { at: number; price: number }[];
  rug?: unknown;
}

interface OpenTrade {
  e: TapeEntry;
  marks: TapeMark[];
}

export class PriceTape {
  private readonly open = new Map<string, OpenTrade>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private chain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly tz: string;
  private disposed = false;

  constructor(
    private readonly dir: string,
    private readonly p: PriceTapeParams,
    private readonly deps: PriceTapeDeps = {},
  ) {
    this.now = deps.now ?? (() => Date.now());
    this.tz = deps.timeZone ?? JOURNAL_TZ_DEFAULT;
  }

  get enabled(): boolean {
    return this.p.enabled && !this.disposed;
  }

  /** Today's file (ET). */
  fileFor(ms: number): string {
    const z = getZonedParts(ms, this.tz);
    const d = `${z.year}-${String(z.month).padStart(2, "0")}-${String(z.day).padStart(2, "0")}`;
    return join(this.dir, "price-tape", `${d}.jsonl`);
  }

  /** Resolves when all queued writes are done (tests / shutdown). */
  flush(): Promise<void> {
    return this.chain;
  }

  private write(line: Record<string, unknown>): void {
    const at = typeof line.at === "number" ? line.at : this.now();
    const file = this.fileFor(at);
    const text = `${JSON.stringify({ v: 1, ...line })}\n`;
    this.chain = this.chain
      .then(async () => {
        await mkdir(join(this.dir, "price-tape"), { recursive: true });
        await appendFile(file, text, "utf8");
      })
      .catch(() => {
        // Never let tape I/O affect trading.
      });
  }

  recordEntry(e: TapeEntry): void {
    if (!this.enabled) return;
    this.open.set(e.tradeId, { e, marks: [] });
    const snap = e.snapshot;
    const ageMin = snap?.createdAt && snap.createdAt > 0 ? (e.at - snap.createdAt) / 60_000 : null;
    const volShare = snap && snap.volume24hUsd > 0 ? (snap.volumeWindowUsd / snap.volume24hUsd) * 100 : null;
    this.write({
      kind: "entry",
      tradeId: e.tradeId,
      mint: e.mint,
      symbol: e.symbol,
      mode: e.mode,
      at: e.at,
      fillPrice: e.fillPrice,
      quotePrice: e.quotePrice,
      onchainPrice: e.onchainPrice,
      quoteVsOnchainPct: e.quoteVsOnchainPct,
      market: e.market ?? null,
      venue: e.venue ?? snap?.venue ?? null,
      notionalUsd: e.notionalUsd,
      entryReason: e.entryReason ?? null,
      coinAgeMin: ageMin,
      windowVolumeSharePct: volShare,
      runupPct: snap?.changeWindowPct ?? null,
      snapshot: snap
        ? {
            priceUsd: snap.priceUsd,
            changeWindowPct: snap.changeWindowPct,
            volumeWindowUsd: snap.volumeWindowUsd,
            volumeAvgUsd: snap.volumeAvgUsd,
            volume24hUsd: snap.volume24hUsd,
            liquidityUsd: snap.liquidityUsd,
            createdAt: snap.createdAt ?? null,
            poolQuoteSol: snap.poolQuoteSol ?? null,
            quoteMint: snap.quoteMint ?? null,
            scannedAt: snap.timestamp,
          }
        : null,
      // The bot's own scan prices for this coin (last ~10 min).
      scanPrices: (e.scanPrices ?? []).map((t) => [t.at - e.at, t.price]),
      rug: e.rug ?? null,
    });
    const market = e.market;
    const fetchCandles = this.deps.fetchCandles;
    if (this.p.preCandles && market && fetchCandles) {
      void fetchCandles(market, Math.floor(e.at / 1000), 10)
        .then((c) => {
          if (c && c.length > 0 && !this.disposed) {
            this.write({ kind: "pre_candles", tradeId: e.tradeId, mint: e.mint, symbol: e.symbol, mode: e.mode, at: this.now(), source: "geckoterminal", interval: "1m", candles: c });
          }
        })
        .catch(() => undefined);
    }
  }

  /** Every mark while holding. Cheap: memory only. */
  recordMark(tradeId: string, at: number, priceUsd: number, src: "chain" | "quote", quoteReserveSol?: number): void {
    const t = this.open.get(tradeId);
    if (!t || !(priceUsd > 0) || !Number.isFinite(priceUsd)) return;
    const last = t.marks[t.marks.length - 1];
    const rel = at - t.e.at;
    if (last && last[0] === rel && last[1] === priceUsd) return;
    const m: TapeMark = quoteReserveSol != null && Number.isFinite(quoteReserveSol)
      ? [rel, priceUsd, src, Math.round(quoteReserveSol * 1e6) / 1e6]
      : [rel, priceUsd, src];
    t.marks.push(m);
    if (t.marks.length > MAX_MARKS) {
      // Thin the oldest half (keep every other) so long holds stay bounded.
      const half = Math.floor(t.marks.length / 2);
      t.marks = [...t.marks.slice(0, half).filter((_, i) => i % 2 === 0), ...t.marks.slice(half)];
    }
  }

  recordExit(x: {
    tradeId: string;
    at: number;
    reason: string;
    fillPrice: number;
    decisionMarkPrice?: number;
    realizedPnlUsd: number;
    exitWarning?: string | null;
  }): void {
    const t = this.open.get(x.tradeId);
    if (!t) return;
    this.open.delete(x.tradeId);
    if (!this.enabled) return;
    const e = t.e;
    this.write({
      kind: "exit",
      tradeId: x.tradeId,
      mint: e.mint,
      symbol: e.symbol,
      mode: e.mode,
      at: x.at,
      holdMs: x.at - e.at,
      reason: x.reason,
      entryPrice: e.fillPrice,
      fillPrice: x.fillPrice,
      decisionMarkPrice: x.decisionMarkPrice ?? null,
      realizedPnlUsd: x.realizedPnlUsd,
      exitWarning: x.exitWarning ?? null,
      marks: t.marks,
    });
    this.trackAfterExit(e, x.at);
  }

  private trackAfterExit(e: TapeEntry, exitAt: number): void {
    const read = this.deps.readOnchain;
    if (!read || !(this.p.postExitSeconds > 0)) return;
    const step = Math.max(1_000, this.p.postExitIntervalMs);
    const endAt = exitAt + this.p.postExitSeconds * 1_000;
    const reads: [number, number, number?][] = [];
    const finish = (): void => {
      if (reads.length > 0) {
        this.write({ kind: "post_exit", tradeId: e.tradeId, mint: e.mint, symbol: e.symbol, mode: e.mode, at: this.now(), intervalMs: step, reads });
      }
    };
    const tick = (): void => {
      if (this.disposed) return finish();
      void read(e.mint)
        .then((r) => {
          if (r && r.priceUsd > 0) {
            reads.push(r.quoteReserveSol != null ? [this.now() - exitAt, r.priceUsd, Math.round(r.quoteReserveSol * 1e6) / 1e6] : [this.now() - exitAt, r.priceUsd]);
          }
        })
        .catch(() => undefined)
        .finally(() => {
          if (this.disposed || this.now() + step > endAt) return finish();
          schedule();
        });
    };
    const schedule = (): void => {
      const h = setTimeout(() => {
        this.timers.delete(h);
        tick();
      }, step);
      h.unref?.();
      this.timers.add(h);
    };
    schedule();
  }

  /** Stop post-exit timers (engine stop). Partial post-exit reads are written. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
  }
}

/** GeckoTerminal 1m candles before `beforeSec` (public API, no key). */
export async function fetchGeckoCandles(
  market: string,
  beforeSec: number,
  limit: number,
  fetchImpl: typeof fetch = fetch,
): Promise<TapeCandle[] | null> {
  const url = `https://api.geckoterminal.com/api/v2/networks/solana/pools/${encodeURIComponent(market)}/ohlcv/minute?aggregate=1&before_timestamp=${beforeSec}&limit=${limit}&currency=usd`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  timer.unref?.();
  try {
    const r = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const j = (await r.json()) as { data?: { attributes?: { ohlcv_list?: unknown[] } } };
    const list = j.data?.attributes?.ohlcv_list;
    if (!Array.isArray(list)) return null;
    const out: TapeCandle[] = [];
    for (const c of list) {
      if (Array.isArray(c) && c.length >= 6 && c.every((n) => typeof n === "number")) {
        out.push(c.slice(0, 6) as TapeCandle);
      }
    }
    return out.sort((a, b) => a[0] - b[0]);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
