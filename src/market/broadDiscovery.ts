/**
 * Paper-only wider candidate mix: graduated PumpSwap pools, Raydium, and
 * other Jupiter-routable Solana pools already covered by DexScreener and
 * GeckoTerminal. Strategy thresholds are not applied here.
 */

import type { TokenSnapshot } from "../types.js";
import type { PaperVenue } from "../broker/paperFees.js";

function createdAtMs(raw: unknown): number | undefined {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n) || !(n > 0)) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

/** DexScreener dex ids (and prefixes) that Jupiter Metis commonly routes. */
export const BROAD_DEX_IDS = new Set(["pumpfun", "pumpswap", "raydium", "orca", "meteora"]);

export const GECKO_TRENDING_POOLS_URL =
  "https://api.geckoterminal.com/api/v2/networks/solana/trending_pools?page=1";

const SOL_MINT = "So11111111111111111111111111111111111111112";

export function isBroadDex(dexId: string): boolean {
  const d = dexId.toLowerCase();
  if (BROAD_DEX_IDS.has(d)) return true;
  return d.startsWith("raydium") || d.startsWith("orca") || d.startsWith("meteora");
}

export function venueForDex(dexId: string): PaperVenue | undefined {
  const d = dexId.toLowerCase();
  if (d === "pumpfun") return "bonding_curve";
  if (d === "pumpswap") return "pumpswap";
  return undefined;
}

export function mergeWithReserve(
  primary: readonly TokenSnapshot[],
  extra: readonly TokenSnapshot[],
  limit: number,
): TokenSnapshot[] {
  const cap = Math.max(0, Math.floor(limit));
  const reserve = Math.min(extra.length, Math.max(extra.length > 0 ? 1 : 0, Math.floor(cap / 2)));
  const pumpSlots = Math.max(0, cap - reserve);
  const seen = new Set<string>();
  const out: TokenSnapshot[] = [];
  const push = (s: TokenSnapshot, max: number): void => {
    if (out.length >= max || seen.has(s.mint)) return;
    seen.add(s.mint);
    out.push(s);
  };
  for (const s of primary) push(s, pumpSlots);
  for (const s of extra) push(s, cap);
  for (const s of primary) push(s, cap);
  return out;
}

interface LoosePair {
  chainId?: string;
  dexId?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { address?: string };
  priceUsd?: string;
  liquidity?: { usd?: number; quote?: number };
  volume?: { h24?: number; m5?: number };
  priceChange?: { m5?: number };
  pairCreatedAt?: number;
}

/** One DexScreener pair → snapshot. Null when it isn't a Solana broad-dex pair. */
export function snapshotFromDexPair(
  p: LoosePair,
  now = Date.now(),
): TokenSnapshot | null {
  if (p.chainId !== "solana") return null;
  const dex = (p.dexId ?? "").toLowerCase();
  if (!isBroadDex(dex)) return null;
  const mint = p.baseToken?.address;
  if (!mint || mint === SOL_MINT || !p.priceUsd) return null;
  const price = Number(p.priceUsd);
  if (!(price > 0)) return null;
  const vol5 = p.volume?.m5 ?? 0;
  const vol24 = p.volume?.h24 ?? 0;
  const createdAt = createdAtMs(p.pairCreatedAt);
  const venue = venueForDex(dex);
  return {
    mint,
    symbol: p.baseToken?.symbol ?? "???",
    name: p.baseToken?.name ?? p.baseToken?.symbol ?? mint.slice(0, 8),
    priceUsd: price,
    changeWindowPct: p.priceChange?.m5 ?? 0,
    volumeWindowUsd: vol5,
    volumeAvgUsd: Math.max(vol24 / 288, 1),
    volume24hUsd: vol24,
    liquidityUsd: p.liquidity?.usd ?? 0,
    timestamp: now,
    ...(createdAt != null ? { createdAt } : {}),
    ...(venue ? { venue } : {}),
    ...(p.quoteToken?.address ? { quoteMint: p.quoteToken.address } : {}),
  };
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function geckoMint(id: unknown): string | null {
  if (typeof id !== "string") return null;
  const mint = id.startsWith("solana_") ? id.slice("solana_".length) : id;
  if (mint.length < 32 || mint === SOL_MINT) return null;
  return mint;
}

/**
 * GeckoTerminal trending Solana pools. Public API, no key.
 * Token id shape is `solana_<mint>`.
 */
export function snapshotsFromGeckoTrending(body: unknown, now = Date.now()): TokenSnapshot[] {
  if (body == null || typeof body !== "object") return [];
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  const out: TokenSnapshot[] = [];
  const seen = new Set<string>();
  for (const row of data) {
    if (row == null || typeof row !== "object") continue;
    const rec = row as {
      attributes?: {
        name?: unknown;
        base_token_price_usd?: unknown;
        reserve_in_usd?: unknown;
        pool_created_at?: unknown;
        price_change_percentage?: { m5?: unknown };
        volume_usd?: { m5?: unknown; h24?: unknown };
      };
      relationships?: {
        base_token?: { data?: { id?: unknown } };
        dex?: { data?: { id?: unknown } };
      };
    };
    const mint = geckoMint(rec.relationships?.base_token?.data?.id);
    if (!mint || seen.has(mint)) continue;
    const price = num(rec.attributes?.base_token_price_usd);
    if (!(price > 0)) continue;
    const name = typeof rec.attributes?.name === "string" ? rec.attributes.name : mint.slice(0, 8);
    const symbol = name.split("/")[0]?.trim() || name.slice(0, 8);
    const vol5 = num(rec.attributes?.volume_usd?.m5);
    const vol24 = num(rec.attributes?.volume_usd?.h24);
    const createdRaw = rec.attributes?.pool_created_at;
    const createdAt = createdAtMs(
      typeof createdRaw === "string" ? Date.parse(createdRaw) : createdRaw,
    );
    const dex = typeof rec.relationships?.dex?.data?.id === "string" ? rec.relationships.dex.data.id : "";
    const venue = venueForDex(dex);
    seen.add(mint);
    out.push({
      mint,
      symbol,
      name,
      priceUsd: price,
      changeWindowPct: num(rec.attributes?.price_change_percentage?.m5),
      volumeWindowUsd: vol5,
      volumeAvgUsd: Math.max(vol24 / 288, 1),
      volume24hUsd: vol24,
      liquidityUsd: num(rec.attributes?.reserve_in_usd),
      timestamp: now,
      ...(createdAt != null ? { createdAt } : {}),
      ...(venue ? { venue } : {}),
    });
  }
  return out;
}
