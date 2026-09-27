import type { BotConfig, TokenSnapshot } from "../types.js";
import { log } from "../logging.js";

export interface MarketDataProvider {
  /** Return candidate tokens for the momentum scan. */
  scan(limit: number): Promise<TokenSnapshot[]>;
  /** Latest price for an open position mint (may return null if unknown). */
  getPrice(mint: string): Promise<number | null>;
}

/** Deterministic mock provider — good for paper demos and unit tests. */
export class MockMarketData implements MarketDataProvider {
  private tick = 0;
  private readonly tokens: Array<{
    mint: string;
    symbol: string;
    name: string;
    basePrice: number;
    /** Per-tick drift multiplier applied to price. */
    drift: number[];
    volumeSpikeAt: number;
  }>;

  constructor(seed?: Partial<{ startTick: number }>) {
    this.tick = seed?.startTick ?? 0;
    // Three synthetic memecoins with scripted momentum patterns.
    this.tokens = [
      {
        mint: "MockMint1111111111111111111111111111111",
        symbol: "MOON",
        name: "Mock Moon",
        basePrice: 0.00012,
        // Quiet then strong pump then fade — triggers entry then trail exit.
        drift: [1, 1.01, 1.02, 1.1, 1.18, 1.25, 1.22, 1.15, 1.08, 1.05],
        volumeSpikeAt: 3,
      },
      {
        mint: "MockMint2222222222222222222222222222222",
        symbol: "RUGX",
        name: "Mock Dump",
        basePrice: 0.00045,
        // Brief pop then hard dump — exercises hard stop.
        drift: [1, 1.12, 1.05, 0.95, 0.88, 0.8, 0.75, 0.7, 0.68, 0.65],
        volumeSpikeAt: 1,
      },
      {
        mint: "MockMint3333333333333333333333333333333",
        symbol: "FLAT",
        name: "Mock Flat",
        basePrice: 0.001,
        drift: [1, 1.001, 0.999, 1.002, 1.0, 0.998, 1.001, 1.0, 1.0, 1.0],
        volumeSpikeAt: -1, // never spikes
      },
    ];
  }

  private snapshotAt(tIndex: number, now: number): TokenSnapshot[] {
    const idx = ((tIndex % 10) + 10) % 10;
    return this.tokens.map((t) => {
      const mult = t.drift[idx] ?? 1;
      const price = t.basePrice * mult;
      const windowStart = t.drift[Math.max(0, idx - 2)] ?? 1;
      const changeFromWindow = ((mult - windowStart) / windowStart) * 100;
      const spiked = idx === t.volumeSpikeAt || idx === t.volumeSpikeAt + 1;
      const volumeAvgUsd = 8_000;
      const volumeWindowUsd = spiked ? volumeAvgUsd * 3.5 : volumeAvgUsd * 0.8;

      return {
        mint: t.mint,
        symbol: t.symbol,
        name: t.name,
        priceUsd: price,
        changeWindowPct: changeFromWindow,
        volumeWindowUsd,
        volumeAvgUsd,
        volume24hUsd: spiked ? 80_000 : 30_000,
        liquidityUsd: 40_000,
        timestamp: now,
      };
    });
  }

  async scan(limit: number): Promise<TokenSnapshot[]> {
    const now = Date.now();
    const snaps = this.snapshotAt(this.tick, now).slice(0, limit);
    this.tick += 1;
    return snaps;
  }

  async getPrice(mint: string): Promise<number | null> {
    // Peek current tick without advancing (exits checked before scan in the loop).
    const snaps = this.snapshotAt(this.tick, Date.now());
    return snaps.find((s) => s.mint === mint)?.priceUsd ?? null;
  }
}

/**
 * DexScreener public API (no key). Rate-limited; treat as best-effort.
 * Docs: https://docs.dexscreener.com/api/reference
 */
export class DexScreenerMarketData implements MarketDataProvider {
  private cache = new Map<string, number>();

  async scan(limit: number): Promise<TokenSnapshot[]> {
    const url = "https://api.dexscreener.com/token-boosts/top/v1";
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        log.warn(`DexScreener boosts HTTP ${res.status}; returning empty scan`);
        return [];
      }
      const raw = (await res.json()) as Array<{
        chainId?: string;
        tokenAddress?: string;
        description?: string;
      }>;

      const sol = (raw ?? [])
        .filter((x) => x.chainId === "solana" && x.tokenAddress)
        .slice(0, limit);

      const out: TokenSnapshot[] = [];
      for (const item of sol) {
        const detail = await this.fetchPair(item.tokenAddress!);
        if (detail) out.push(detail);
      }
      return out;
    } catch (err) {
      log.warn("DexScreener scan failed", err);
      return [];
    }
  }

  private async fetchPair(mint: string): Promise<TokenSnapshot | null> {
    try {
      const res = await fetch(
        `https://api.dexscreener.com/latest/dex/tokens/${mint}`,
        { headers: { accept: "application/json" } },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as {
        pairs?: Array<{
          chainId: string;
          baseToken: { address: string; symbol: string; name: string };
          priceUsd?: string;
          liquidity?: { usd?: number };
          volume?: { h24?: number; m5?: number };
          priceChange?: { m5?: number; h1?: number };
        }>;
      };
      const pair = (body.pairs ?? []).find((p) => p.chainId === "solana");
      if (!pair || !pair.priceUsd) return null;

      const price = Number(pair.priceUsd);
      this.cache.set(mint, price);
      const vol5 = pair.volume?.m5 ?? 0;
      const vol24 = pair.volume?.h24 ?? 0;
      const volumeAvgUsd = Math.max(vol24 / 288, 1);

      return {
        mint: pair.baseToken.address,
        symbol: pair.baseToken.symbol,
        name: pair.baseToken.name,
        priceUsd: price,
        changeWindowPct: pair.priceChange?.m5 ?? 0,
        volumeWindowUsd: vol5,
        volumeAvgUsd,
        volume24hUsd: vol24,
        liquidityUsd: pair.liquidity?.usd ?? 0,
        timestamp: Date.now(),
      };
    } catch {
      return null;
    }
  }

  async getPrice(mint: string): Promise<number | null> {
    const snap = await this.fetchPair(mint);
    if (snap) return snap.priceUsd;
    return this.cache.get(mint) ?? null;
  }
}

export function createMarketData(cfg: BotConfig): MarketDataProvider {
  if (cfg.marketDataSource === "dexscreener") {
    log.info("Market data: DexScreener public API");
    return new DexScreenerMarketData();
  }
  log.info("Market data: Mock (deterministic paper fixtures)");
  return new MockMarketData();
}
