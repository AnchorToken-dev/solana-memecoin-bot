/**
 * Jupiter Swap API quotes for PAPER fills only.
 *
 * Prefer GET /swap/v2/build (Metis router, no Jupiter swap fee — we never set
 * platformFeeBps and we never sign or send the instructions). If /build is
 * down but not a hard "no route", fall back to Metis GET /swap/v1/quote.
 *
 * A 400 "no routes" is a real answer: the mint is not Jupiter-tradable.
 * Timeouts, network errors, and 5xx are "unreachable" — callers must keep
 * trading on the offline model instead of stalling.
 */

import { fetchWithTimeout, type FetchLike } from "../market/http.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Public key from Jupiter's own /build examples. Paper sends it only as the
 * required `taker` query param. This process never signs or submits.
 */
export const PAPER_JUPITER_TAKER_DEFAULT = "GkwFnmMDvn3HGMpJpWBg8tgJxr3NxNvg3AXxvXVPbRGJ";

export const JUPITER_API_BASE_DEFAULT = "https://api.jup.ag";

/** How long a "Jupiter has no route" skip sticks before we ask again. */
export const JUPITER_NO_ROUTE_COOLDOWN_MS = 10 * 60_000;

export interface JupiterRouteQuote {
  source: "jupiter_build" | "jupiter_quote_v1";
  inputMint: string;
  outputMint: string;
  inAmountRaw: string;
  outAmountRaw: string;
  /** Decimal ratio. 0.001 = 0.1% price impact. */
  priceImpactPct: number;
  slippageBps: number;
  route: string;
  dexLabels: string[];
  /** Jupiter platform/swap fee. /build has none; v1 quote is 0 unless a platform fee was requested (we never request one). */
  jupiterFeeBps: number;
}

export type JupiterQuoteResult =
  | { kind: "ok"; quote: JupiterRouteQuote }
  | { kind: "no_route"; reason: string }
  | { kind: "unreachable"; reason: string };

export interface JupiterSwapRequest {
  inputMint: string;
  outputMint: string;
  /** Integer amount in base units of inputMint (lamports or token atoms). */
  amountRaw: string;
  slippageBps: number;
  timeoutMs: number;
  taker?: string;
  apiBase?: string;
}

export interface JupiterQuoteDeps {
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export function formatJupiterRoute(plan: unknown): { route: string; dexLabels: string[] } {
  if (!Array.isArray(plan) || plan.length === 0) return { route: "jupiter", dexLabels: [] };
  const parts: string[] = [];
  const labels: string[] = [];
  for (const step of plan) {
    if (step == null || typeof step !== "object") continue;
    const row = step as { swapInfo?: { label?: unknown }; bps?: unknown; percent?: unknown };
    const info = row.swapInfo;
    const rawLabel = info && typeof info.label === "string" ? info.label.trim() : "";
    const label = rawLabel || "DEX";
    labels.push(label);
    const bps =
      typeof row.bps === "number" && Number.isFinite(row.bps)
        ? row.bps
        : typeof row.percent === "number" && Number.isFinite(row.percent)
          ? row.percent * 100
          : null;
    const share =
      bps == null ? "" : ` ${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;
    parts.push(`${label}${share}`);
  }
  if (parts.length === 0) return { route: "jupiter", dexLabels: [] };
  return { route: parts.join(" → "), dexLabels: labels };
}

/** Jupiter documents priceImpactPct as a decimal ratio ("0.001" = 0.1%). Values above 1 are treated as already-in-percent. */
export function parsePriceImpactPct(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace("%", "").trim()) : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 1) return n / 100;
  return n;
}

export function parseJupiterQuoteBody(
  body: unknown,
  source: JupiterRouteQuote["source"],
): JupiterRouteQuote | null {
  if (body == null || typeof body !== "object") return null;
  const b = body as {
    inputMint?: unknown;
    outputMint?: unknown;
    inAmount?: unknown;
    outAmount?: unknown;
    priceImpactPct?: unknown;
    slippageBps?: unknown;
    routePlan?: unknown;
    platformFee?: { feeBps?: unknown };
  };
  const inAmountRaw = rawAmount(b.inAmount);
  const outAmountRaw = rawAmount(b.outAmount);
  if (!inAmountRaw || !outAmountRaw) return null;
  if (outAmountRaw === "0") return null;
  const route = formatJupiterRoute(b.routePlan);
  const platform = b.platformFee && typeof b.platformFee.feeBps === "number" ? b.platformFee.feeBps : 0;
  return {
    source,
    inputMint: typeof b.inputMint === "string" ? b.inputMint : "",
    outputMint: typeof b.outputMint === "string" ? b.outputMint : "",
    inAmountRaw,
    outAmountRaw,
    priceImpactPct: parsePriceImpactPct(b.priceImpactPct),
    slippageBps: typeof b.slippageBps === "number" && Number.isFinite(b.slippageBps) ? b.slippageBps : 0,
    route: route.route,
    dexLabels: route.dexLabels,
    jupiterFeeBps: platform > 0 ? platform : 0,
  };
}

function rawAmount(v: unknown): string | null {
  if (typeof v === "string" && /^\d+$/.test(v) && v.length > 0) return v;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return String(Math.round(v));
  return null;
}

export function isJupiterNoRoute(status: number, body: string): boolean {
  if (status !== 400 && status !== 404) return false;
  const t = body.toLowerCase();
  return t.includes("no route") || t.includes("no routes") || t.includes("could not find any route");
}

function clipReason(status: number, body: string): string {
  const text = body.replace(/\s+/g, " ").trim().slice(0, 180);
  return text ? `HTTP ${status}: ${text}` : `HTTP ${status}`;
}

function headersFromEnv(env: Record<string, string | undefined>): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json" };
  const key = (env.JUPITER_API_KEY ?? env.JUPITER_SWAP_API_KEY ?? "").trim();
  if (key) headers["x-api-key"] = key;
  return headers;
}

async function readBody(res: Response): Promise<{ json: unknown; text: string }> {
  const text = await res.text();
  try {
    return { json: text ? JSON.parse(text) : null, text };
  } catch {
    return { json: null, text };
  }
}

/**
 * One quote. Never throws. Does not sign, send, or log the API key.
 */
export async function fetchJupiterSwapQuote(
  req: JupiterSwapRequest,
  deps: JupiterQuoteDeps = {},
): Promise<JupiterQuoteResult> {
  const env = deps.env ?? process.env;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const apiBase = (req.apiBase ?? env.JUPITER_API_BASE ?? JUPITER_API_BASE_DEFAULT).replace(/\/$/, "");
  const taker = (req.taker ?? env.PAPER_JUPITER_TAKER ?? PAPER_JUPITER_TAKER_DEFAULT).trim();
  const headers = headersFromEnv(env);
  const timeoutMs = Math.max(250, Math.floor(req.timeoutMs));

  const build = new URL(`${apiBase}/swap/v2/build`);
  build.searchParams.set("inputMint", req.inputMint);
  build.searchParams.set("outputMint", req.outputMint);
  build.searchParams.set("amount", req.amountRaw);
  build.searchParams.set("taker", taker);
  build.searchParams.set("slippageBps", String(Math.max(0, Math.round(req.slippageBps))));

  const built = await requestQuote(build.toString(), headers, timeoutMs, fetchImpl, "jupiter_build");
  if (built.kind === "ok" || built.kind === "no_route") return built;

  const v1 = new URL(`${apiBase}/swap/v1/quote`);
  v1.searchParams.set("inputMint", req.inputMint);
  v1.searchParams.set("outputMint", req.outputMint);
  v1.searchParams.set("amount", req.amountRaw);
  v1.searchParams.set("slippageBps", String(Math.max(0, Math.round(req.slippageBps))));
  v1.searchParams.set("swapMode", "ExactIn");
  const quoted = await requestQuote(v1.toString(), headers, timeoutMs, fetchImpl, "jupiter_quote_v1");
  if (quoted.kind === "ok" || quoted.kind === "no_route") return quoted;
  return {
    kind: "unreachable",
    reason: `${built.reason}; v1 ${quoted.reason}`,
  };
}

async function requestQuote(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  fetchImpl: FetchLike,
  source: JupiterRouteQuote["source"],
): Promise<JupiterQuoteResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout(url, { headers }, timeoutMs, fetchImpl);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : "request failed";
    const why = name === "AbortError" ? "timeout" : msg.slice(0, 160);
    return { kind: "unreachable", reason: `${source} ${why}` };
  }
  const { json, text } = await readBody(res);
  if (isJupiterNoRoute(res.status, text)) {
    return { kind: "no_route", reason: clipReason(res.status, text) };
  }
  if (!res.ok) {
    return { kind: "unreachable", reason: `${source} ${clipReason(res.status, text)}` };
  }
  const quote = parseJupiterQuoteBody(json, source);
  if (!quote) return { kind: "unreachable", reason: `${source} HTTP 200 but no outAmount` };
  return { kind: "ok", quote };
}

export interface JupiterSelectResult<T> {
  /** Remaining candidates, winner first when a quote succeeded. Empty when every attempt was no_route. */
  entries: T[];
  quote: JupiterRouteQuote | null;
  /** Jupiter could not be reached. `entries` still includes the unproven tail so trading can fall back. */
  unreachable: boolean;
  unreachableReason?: string;
  skipped: Array<{ entry: T; reason: string }>;
}

/**
 * Walk ranked candidates until one quotes, Jupiter is unreachable, or the
 * attempt cap is hit. no_route drops that mint. Unreachable stops the walk
 * and keeps the rest (offline fallback — do not stall the cycle).
 */
export async function selectJupiterQuotable<T extends { mint: string; symbol: string }>(
  entries: readonly T[],
  quoteOne: (entry: T) => Promise<JupiterQuoteResult>,
  maxAttempts: number,
): Promise<JupiterSelectResult<T>> {
  const attempts = Math.max(0, Math.floor(maxAttempts));
  const skipped: Array<{ entry: T; reason: string }> = [];
  let tried = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    if (tried >= attempts) {
      return { entries: [], quote: null, unreachable: false, skipped };
    }
    tried += 1;
    const result = await quoteOne(entry);
    switch (result.kind) {
      case "ok":
        return {
          entries: [entry, ...entries.slice(i + 1)],
          quote: result.quote,
          unreachable: false,
          skipped,
        };
      case "unreachable":
        return {
          entries: entries.slice(i),
          quote: null,
          unreachable: true,
          unreachableReason: result.reason,
          skipped,
        };
      case "no_route":
        skipped.push({ entry, reason: result.reason });
        break;
      default: {
        const _exhaustive: never = result;
        return _exhaustive;
      }
    }
  }
  return { entries: [], quote: null, unreachable: false, skipped };
}
