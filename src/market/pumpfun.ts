/**
 * Pump.fun-oriented paper market data.
 *
 * Primary (unofficial frontend API used by pump.fun web):
 *   GET https://frontend-api-v3.pump.fun/coins?...
 *   GET https://frontend-api-v3.pump.fun/sol-price
 *
 * These are NOT an official public SDK. Cloudflare / path changes can break
 * them without notice; some community docs claim JWT is required even when
 * list endpoints currently answer anonymously. Treat as best-effort.
 *
 * Fallback (labeled): DexScreener pairs with dexId in {pumpfun, pumpswap}
 * via search, when the frontend API fails or returns empty.
 *
 * Optional enrich: DexScreener /latest/dex/tokens/{mint} for m5 volume / % change
 * (Pump list payloads lack short-window volume and % change).
 *
 * PAPER ONLY — never loads wallet keys; fills stay in PaperBroker.
 */

import type { TokenSnapshot } from "../types.js";
import { log } from "../logging.js";
import {
  CACHED_PRICE_REFRESH_TIMEOUT_MS,
  fetchWithTimeout,
  isAbortError,
  marketHttpTimeoutMs,
  type FetchLike as HttpFetchLike,
} from "./http.js";

export const PUMPFUN_FRONTEND_API_BASE_DEFAULT =
  "https://frontend-api-v3.pump.fun";

/** DexScreener ids that map to Pump.fun bonding curve / PumpSwap AMM. */
export const PUMP_DEX_IDS = new Set(["pumpfun", "pumpswap"]);

/** @deprecated prefer HttpFetchLike from ./http.js — kept for test inject API. */
export type FetchLike = HttpFetchLike;

export interface PumpFunMarketOptions {
  /** Override frontend-api base (no trailing slash). */
  apiBase?: string;
  /** Injected fetch for tests. */
  fetchImpl?: FetchLike;
  /** When true (default), fall back to DexScreener pumpfun/pumpswap on API failure. */
  dexFallback?: boolean;
  /** When true (default), enrich volume / m5 % from DexScreener token pairs. */
  dexEnrich?: boolean;
  /** Soft delay between DexScreener enrich calls (ms). */
  enrichDelayMs?: number;
  /** Momentum window used for in-memory % change when Dex has no m5. */
  windowMinutes?: number;
  /** Per-request HTTP timeout ms (default MARKET_HTTP_TIMEOUT_MS / 8000). */
  httpTimeoutMs?: number;
}

interface PumpCoin {
  mint?: string;
  symbol?: string;
  name?: string;
  usd_market_cap?: number;
  market_cap_usd?: number;
  total_supply?: number | string;
  base_decimals?: number;
  virtual_sol_reserves?: number;
  real_sol_reserves?: number;
  virtual_token_reserves?: number;
  real_token_reserves?: number;
  complete?: boolean;
  created_timestamp?: number;
  last_trade_timestamp?: number;
  reply_count?: number;
  nsfw?: boolean;
  is_banned?: boolean;
  /** Already on the frontend payload when pump.fun sends it. Not a new request. */
  creator?: string;
  bonding_curve?: string;
  associated_bonding_curve?: string;
}

interface PriceSample {
  priceUsd: number;
  at: number;
}

const BROWSERISH_HEADERS: Record<string, string> = {
  accept: "application/json",
  origin: "https://pump.fun",
  referer: "https://pump.fun/",
  "user-agent":
    "solana-memecoin-bot/0.1 (paper research; +https://github.com/AnchorToken-dev/solana-memecoin-bot)",
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pump account strings already on the coin JSON. Ignore junk. */
function pumpAccount(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  if (s.length < 32 || s.length > 44) return undefined;
  return s;
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/** Normalize pump.fun / Dex created timestamps to epoch ms. */
export function normalizeCreatedAtMs(raw: unknown): number | undefined {
  const n = num(raw, 0);
  if (!(n > 0)) return undefined;
  // Seconds vs ms heuristic.
  return n < 1e12 ? n * 1000 : n;
}


/** Price from USD mcap / circulating supply (raw total_supply ÷ 10^decimals). */
export function priceFromPumpCoin(coin: PumpCoin): number {
  const decimals = coin.base_decimals ?? 6;
  const supplyRaw = num(coin.total_supply, 0);
  const supply = supplyRaw / 10 ** decimals;
  const mcap = num(coin.usd_market_cap ?? coin.market_cap_usd, 0);
  if (supply <= 0 || mcap <= 0) return 0;
  return mcap / supply;
}

/**
 * Rough USD liquidity proxy from SOL-side reserves × SOL/USD.
 * Prefers real reserves; falls back to virtual (bonding curve).
 */
export function liquidityFromPumpCoin(
  coin: PumpCoin,
  solPriceUsd: number,
): number {
  // Prefer real SOL reserves when non-zero; else virtual (bonding curve).
  const use =
    num(coin.real_sol_reserves, 0) > 0
      ? num(coin.real_sol_reserves, 0)
      : num(coin.virtual_sol_reserves, 0);
  const sol = use / 1e9;
  return Math.max(0, sol * solPriceUsd);
}

export class PumpFunMarketData {
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  private readonly dexFallback: boolean;
  private readonly dexEnrich: boolean;
  private readonly enrichDelayMs: number;
  private readonly windowMs: number;
  private readonly httpTimeoutMs: number;
  private readonly priceHistory = new Map<string, PriceSample[]>();
  private readonly priceCache = new Map<string, number>();
  private solPriceCache: { usd: number; at: number } | null = null;

  constructor(opts: PumpFunMarketOptions = {}) {
    this.apiBase = (opts.apiBase ?? PUMPFUN_FRONTEND_API_BASE_DEFAULT).replace(
      /\/$/,
      "",
    );
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.dexFallback = opts.dexFallback ?? true;
    this.dexEnrich = opts.dexEnrich ?? true;
    this.enrichDelayMs = opts.enrichDelayMs ?? 120;
    this.windowMs = (opts.windowMinutes ?? 5) * 60_000;
    this.httpTimeoutMs = opts.httpTimeoutMs ?? marketHttpTimeoutMs();
  }

  /** Timed fetch — never hang the runner on a stuck CF / Dex socket. */
  private async http(
    input: string,
    init?: RequestInit,
    timeoutMs?: number,
  ): Promise<Response> {
    return fetchWithTimeout(
      input,
      init,
      timeoutMs ?? this.httpTimeoutMs,
      this.fetchImpl,
    );
  }

  async scan(limit: number): Promise<TokenSnapshot[]> {
    const n = Math.max(1, Math.min(limit, 50));
    try {
      const coins = await this.fetchPumpCandidates(n);
      if (coins.length === 0) {
        log.warn("Pump.fun scan returned 0 coins; trying DexScreener fallback");
        if (this.dexFallback) return this.scanDexScreenerPump(n);
        return [];
      }
      const solUsd = await this.fetchSolPriceUsd();
      let snaps = coins
        .map((c) => this.coinToSnapshot(c, solUsd))
        .filter((s): s is TokenSnapshot => s !== null)
        .slice(0, n);

      if (this.dexEnrich && snaps.length > 0) {
        snaps = await this.enrichWithDexScreener(snaps);
      }
      return snaps;
    } catch (err) {
      log.warn("Pump.fun scan failed", err);
      if (this.dexFallback) {
        log.info("Falling back to DexScreener pumpfun/pumpswap filter");
        return this.scanDexScreenerPump(n);
      }
      return [];
    }
  }

  async getPrice(mint: string): Promise<number | null> {
    // Cache-first for latency: if we already have a mark, only wait a short
    // refresh window (CACHED_PRICE_REFRESH_TIMEOUT_MS) before using cache.
    // Without a cache, use the full HTTP timeout (cold path).
    const cached = this.priceCache.get(mint);
    if (this.dexEnrich) {
      const refreshMs =
        cached != null
          ? Math.min(this.httpTimeoutMs, CACHED_PRICE_REFRESH_TIMEOUT_MS)
          : this.httpTimeoutMs;
      try {
        const enriched = await this.fetchDexPairForMint(mint, refreshMs);
        if (enriched?.priceUsd) {
          this.priceCache.set(mint, enriched.priceUsd);
          this.recordPrice(mint, enriched.priceUsd);
          return enriched.priceUsd;
        }
      } catch (err) {
        if (isAbortError(err)) {
          log.warn(
            `getPrice Dex refresh timed out for ${mint.slice(0, 8)}…; using cache`,
          );
        } else {
          log.warn(`getPrice Dex refresh failed for ${mint.slice(0, 8)}…; using cache`, err);
        }
      }
    }
    return cached ?? null;
  }

  /**
   * One coin for the pin. Tries the Pump.fun coin endpoint, then DexScreener.
   * Never falls back to the board scan.
   */
  async lookup(mint: string): Promise<TokenSnapshot | null> {
    const fromPump = await this.lookupPumpCoin(mint);
    if (fromPump) {
      if (this.dexEnrich) {
        try {
          const [enriched] = await this.enrichWithDexScreener([fromPump]);
          return enriched ?? fromPump;
        } catch (err) {
          log.warn(`Pinned mint Dex enrich failed for ${mint.slice(0, 8)}…`, err);
          return fromPump;
        }
      }
      return fromPump;
    }
    if (!this.dexFallback && !this.dexEnrich) return null;
    try {
      const pair = await this.fetchDexPairForMint(mint);
      if (!pair || !(pair.priceUsd > 0)) return null;
      if (pair.baseMint && pair.baseMint !== mint) return null;
      this.priceCache.set(mint, pair.priceUsd);
      this.recordPrice(mint, pair.priceUsd);
      return {
        mint,
        symbol: pair.symbol || mint.slice(0, 4),
        name: pair.name || pair.symbol || mint.slice(0, 8),
        priceUsd: pair.priceUsd,
        changeWindowPct: pair.changeWindowPct ?? this.changeFromHistory(mint, pair.priceUsd),
        volumeWindowUsd: pair.volumeWindowUsd,
        volumeAvgUsd: pair.volumeAvgUsd,
        volume24hUsd: pair.volume24hUsd,
        liquidityUsd: pair.liquidityUsd,
        timestamp: Date.now(),
        ...(pair.createdAt != null ? { createdAt: pair.createdAt } : {}),
      };
    } catch (err) {
      log.warn(`Pinned mint Dex lookup failed for ${mint.slice(0, 8)}…`, err);
      return null;
    }
  }

  private async lookupPumpCoin(mint: string): Promise<TokenSnapshot | null> {
    try {
      const res = await this.http(
        `${this.apiBase}/coins/${encodeURIComponent(mint)}`,
        { headers: BROWSERISH_HEADERS },
      );
      if (!res.ok) return null;
      const coin = (await res.json()) as PumpCoin;
      if (!coin?.mint || coin.mint !== mint || coin.is_banned) return null;
      const solUsd = await this.fetchSolPriceUsd();
      return this.coinToSnapshot(coin, solUsd);
    } catch (err) {
      log.warn(`Pump.fun coin lookup failed for ${mint.slice(0, 8)}…`, err);
      return null;
    }
  }

  /** Exposed for tests / dry-run. */
  async fetchPumpCandidates(limit: number): Promise<PumpCoin[]> {
    // Mix "hot" (last trade) + "new" so paper scan resembles the pump.fun board.
    const half = Math.max(1, Math.ceil(limit / 2));
    const [hot, neu] = await Promise.all([
      this.fetchCoinsList({
        limit: half,
        sort: "last_trade_timestamp",
        order: "DESC",
        includeNsfw: false,
      }),
      this.fetchCoinsList({
        limit: half,
        sort: "created_timestamp",
        order: "DESC",
        includeNsfw: false,
        complete: false,
      }),
    ]);

    const byMint = new Map<string, PumpCoin>();
    for (const c of [...hot, ...neu]) {
      if (!c.mint || c.is_banned) continue;
      if (!byMint.has(c.mint)) byMint.set(c.mint, c);
    }
    return [...byMint.values()].slice(0, limit);
  }

  private async fetchCoinsList(params: {
    limit: number;
    sort: string;
    order: string;
    includeNsfw: boolean;
    complete?: boolean;
  }): Promise<PumpCoin[]> {
    const q = new URLSearchParams({
      offset: "0",
      limit: String(params.limit),
      sort: params.sort,
      order: params.order,
      includeNsfw: String(params.includeNsfw),
    });
    if (params.complete !== undefined) {
      q.set("complete", String(params.complete));
    }
    const url = `${this.apiBase}/coins?${q.toString()}`;
    const res = await this.http(url, { headers: BROWSERISH_HEADERS });
    if (!res.ok) {
      throw new Error(`Pump.fun coins HTTP ${res.status} for ${url}`);
    }
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) {
      throw new Error("Pump.fun coins: expected JSON array");
    }
    return body as PumpCoin[];
  }

  /**
   * USD per 1 SOL — used by journal for quote-asset PnL at fill time.
   * Prefer env SOL_USD_RATE / QUOTE_USD_RATE, else Pump.fun /sol-price, else cache/150.
   */
  async getQuoteUsdRate(): Promise<number | null> {
    const fromEnv = Number(process.env.SOL_USD_RATE ?? process.env.QUOTE_USD_RATE);
    if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
    return this.fetchSolPriceUsd();
  }

  private async fetchSolPriceUsd(): Promise<number> {
    const now = Date.now();
    if (this.solPriceCache && now - this.solPriceCache.at < 60_000) {
      return this.solPriceCache.usd;
    }
    try {
      const res = await this.http(`${this.apiBase}/sol-price`, {
        headers: BROWSERISH_HEADERS,
      });
      if (res.ok) {
        const body = (await res.json()) as { solPrice?: number };
        const usd = num(body.solPrice, 0);
        if (usd > 0) {
          this.solPriceCache = { usd, at: now };
          return usd;
        }
      }
    } catch (err) {
      log.warn("Pump.fun sol-price failed; using cache/fallback", err);
    }
    return this.solPriceCache?.usd ?? 150;
  }

  private coinToSnapshot(
    coin: PumpCoin,
    solUsd: number,
  ): TokenSnapshot | null {
    if (!coin.mint) return null;
    const priceUsd = priceFromPumpCoin(coin);
    if (!(priceUsd > 0)) return null;

    this.priceCache.set(coin.mint, priceUsd);
    this.recordPrice(coin.mint, priceUsd);
    const changeWindowPct = this.changeFromHistory(coin.mint, priceUsd);

    const liquidityUsd = liquidityFromPumpCoin(coin, solUsd);
    // List API has no volume windows — leave zeros until Dex enrich fills them.
    // volumeAvgUsd=1 avoids divide-by-zero in spike ratio if enrich misses.
    const createdAt = normalizeCreatedAtMs(coin.created_timestamp);
    const creator = pumpAccount(coin.creator);
    const bondingCurve = pumpAccount(coin.bonding_curve);
    const associatedBondingCurve = pumpAccount(coin.associated_bonding_curve);
    return {
      mint: coin.mint,
      symbol: coin.symbol ?? "???",
      name: coin.name ?? coin.symbol ?? coin.mint.slice(0, 8),
      priceUsd,
      changeWindowPct,
      volumeWindowUsd: 0,
      volumeAvgUsd: 1,
      volume24hUsd: 0,
      liquidityUsd,
      timestamp: Date.now(),
      ...(createdAt != null ? { createdAt } : {}),
      ...(creator ? { creator } : {}),
      ...(bondingCurve ? { bondingCurve } : {}),
      ...(associatedBondingCurve ? { associatedBondingCurve } : {}),
      // Graduated (complete) coins trade on PumpSwap; others on the curve.
      ...(typeof coin.complete === "boolean"
        ? { venue: coin.complete ? ("pumpswap" as const) : ("bonding_curve" as const) }
        : {}),
    };
  }

  private recordPrice(mint: string, priceUsd: number): void {
    const now = Date.now();
    const arr = this.priceHistory.get(mint) ?? [];
    arr.push({ priceUsd, at: now });
    const cutoff = now - this.windowMs * 3;
    const trimmed = arr.filter((s) => s.at >= cutoff).slice(-64);
    this.priceHistory.set(mint, trimmed);
  }

  private changeFromHistory(mint: string, current: number): number {
    const arr = this.priceHistory.get(mint) ?? [];
    const now = Date.now();
    const target = now - this.windowMs;
    // Oldest sample still within / just beyond the window.
    let baseline: PriceSample | undefined;
    for (const s of arr) {
      if (s.at <= target) baseline = s;
      else break;
    }
    if (!baseline && arr.length >= 2) baseline = arr[0];
    if (!baseline || baseline.priceUsd <= 0) return 0;
    return ((current - baseline.priceUsd) / baseline.priceUsd) * 100;
  }

  private async enrichWithDexScreener(
    snaps: TokenSnapshot[],
  ): Promise<TokenSnapshot[]> {
    // Parallel enrich — sequential awaits stacked full HTTP timeouts and
    // blocked entry scans (and previously, exit checks) for many seconds.
    return Promise.all(
      snaps.map(async (s, i) => {
        if (this.enrichDelayMs > 0 && i > 0) {
          await sleep(this.enrichDelayMs * i);
        }
        try {
          const pair = await this.fetchDexPairForMint(s.mint);
          if (pair) {
            if (pair.priceUsd > 0) {
              this.priceCache.set(s.mint, pair.priceUsd);
              this.recordPrice(s.mint, pair.priceUsd);
            }
            return {
              ...s,
              priceUsd: pair.priceUsd > 0 ? pair.priceUsd : s.priceUsd,
              changeWindowPct:
                pair.changeWindowPct !== null
                  ? pair.changeWindowPct
                  : s.changeWindowPct,
              volumeWindowUsd: pair.volumeWindowUsd || s.volumeWindowUsd,
              volumeAvgUsd: pair.volumeAvgUsd || s.volumeAvgUsd,
              volume24hUsd: pair.volume24hUsd || s.volume24hUsd,
              liquidityUsd:
                pair.liquidityUsd > 0 ? pair.liquidityUsd : s.liquidityUsd,
            };
          }
        } catch (err) {
          if (isAbortError(err)) {
            log.warn(`Dex enrich timed out for ${s.symbol}; keeping pump fields`);
          }
        }
        return s;
      }),
    );
  }

  private async fetchDexPairForMint(
    mint: string,
    timeoutMs?: number,
  ): Promise<{
    priceUsd: number;
    changeWindowPct: number | null;
    volumeWindowUsd: number;
    volumeAvgUsd: number;
    volume24hUsd: number;
    liquidityUsd: number;
    baseMint?: string;
    symbol?: string;
    name?: string;
    createdAt?: number;
  } | null> {
    const res = await this.http(
      `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
      { headers: { accept: "application/json" } },
      timeoutMs,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      pairs?: Array<{
        chainId?: string;
        dexId?: string;
        baseToken?: { address?: string; symbol?: string; name?: string };
        priceUsd?: string;
        liquidity?: { usd?: number };
        volume?: { h24?: number; m5?: number };
        priceChange?: { m5?: number; h1?: number };
        pairCreatedAt?: number;
      }>;
    };
    const pairs = (body.pairs ?? []).filter((p) => p.chainId === "solana");
    // Prefer pumpfun / pumpswap pools; else deepest Solana pool.
    const preferred =
      pairs.find((p) => PUMP_DEX_IDS.has((p.dexId ?? "").toLowerCase())) ??
      pairs.sort(
        (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
      )[0];
    if (!preferred?.priceUsd) return null;
    const price = Number(preferred.priceUsd);
    const vol5 = preferred.volume?.m5 ?? 0;
    const vol24 = preferred.volume?.h24 ?? 0;
    const createdAt = normalizeCreatedAtMs(preferred.pairCreatedAt);
    return {
      priceUsd: price,
      changeWindowPct:
        preferred.priceChange?.m5 !== undefined
          ? preferred.priceChange.m5
          : null,
      volumeWindowUsd: vol5,
      volumeAvgUsd: Math.max(vol24 / 288, 1),
      volume24hUsd: vol24,
      liquidityUsd: preferred.liquidity?.usd ?? 0,
      ...(preferred.baseToken?.address
        ? { baseMint: preferred.baseToken.address }
        : {}),
      ...(preferred.baseToken?.symbol
        ? { symbol: preferred.baseToken.symbol }
        : {}),
      ...(preferred.baseToken?.name ? { name: preferred.baseToken.name } : {}),
      ...(createdAt != null ? { createdAt } : {}),
    };
  }

  /**
   * Labeled fallback: DexScreener search, keep Solana pairs on pumpfun/pumpswap.
   * Not the Pump.fun frontend — used only when that API is down/empty.
   */
  async scanDexScreenerPump(limit: number): Promise<TokenSnapshot[]> {
    const queries = ["pumpfun", "pumpswap"];
    const byMint = new Map<string, TokenSnapshot>();

    for (const q of queries) {
      try {
        const res = await this.http(
          `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
          { headers: { accept: "application/json" } },
        );
        if (!res.ok) {
          log.warn(`DexScreener pump fallback search HTTP ${res.status}`);
          continue;
        }
        const body = (await res.json()) as {
          pairs?: Array<{
            chainId?: string;
            dexId?: string;
            baseToken?: { address?: string; symbol?: string; name?: string };
            priceUsd?: string;
            liquidity?: { usd?: number };
            volume?: { h24?: number; m5?: number };
            priceChange?: { m5?: number };
            pairCreatedAt?: number;
          }>;
        };
        for (const p of body.pairs ?? []) {
          if (p.chainId !== "solana") continue;
          const dex = (p.dexId ?? "").toLowerCase();
          if (!PUMP_DEX_IDS.has(dex)) continue;
          const mint = p.baseToken?.address;
          if (!mint || !p.priceUsd || byMint.has(mint)) continue;
          const price = Number(p.priceUsd);
          if (!(price > 0)) continue;
          const vol5 = p.volume?.m5 ?? 0;
          const vol24 = p.volume?.h24 ?? 0;
          this.priceCache.set(mint, price);
          this.recordPrice(mint, price);
          const createdAt = normalizeCreatedAtMs(p.pairCreatedAt);
          byMint.set(mint, {
            mint,
            symbol: p.baseToken?.symbol ?? "???",
            name: p.baseToken?.name ?? p.baseToken?.symbol ?? mint.slice(0, 8),
            priceUsd: price,
            changeWindowPct: p.priceChange?.m5 ?? this.changeFromHistory(mint, price),
            volumeWindowUsd: vol5,
            volumeAvgUsd: Math.max(vol24 / 288, 1),
            volume24hUsd: vol24,
            liquidityUsd: p.liquidity?.usd ?? 0,
            timestamp: Date.now(),
            ...(createdAt != null ? { createdAt } : {}),
            venue: dex === "pumpswap" ? "pumpswap" : "bonding_curve",
          });
          if (byMint.size >= limit) break;
        }
      } catch (err) {
        log.warn("DexScreener pump fallback failed", err);
      }
      if (byMint.size >= limit) break;
      await sleep(150);
    }

    log.info(
      `DexScreener pumpfun/pumpswap fallback: ${byMint.size} candidates (labeled fallback, not Pump.fun frontend)`,
    );
    return [...byMint.values()].slice(0, limit);
  }
}
