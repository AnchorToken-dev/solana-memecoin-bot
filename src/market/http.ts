/**
 * Market HTTP helpers — every external poll must time out so a hung
 * DexScreener / Pump.fun connection cannot wedge the single-trade runner.
 */

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Default per-request timeout for market data HTTP (ms). */
export const DEFAULT_MARKET_HTTP_TIMEOUT_MS = 8_000;

/** Resolve timeout from env MARKET_HTTP_TIMEOUT_MS (clamped). */
export function marketHttpTimeoutMs(
  fallback = DEFAULT_MARKET_HTTP_TIMEOUT_MS,
): number {
  const raw = process.env.MARKET_HTTP_TIMEOUT_MS;
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 500) return fallback;
  return Math.min(Math.floor(n), 60_000);
}

export function isAbortError(err: unknown): boolean {
  if (err == null || typeof err !== "object") return false;
  const e = err as { name?: string; code?: string };
  return e.name === "AbortError" || e.code === "ABORT_ERR";
}

/**
 * fetch() with a hard timeout. Optionally merges an outer AbortSignal
 * (engine stop) so stop() can cancel in-flight market polls.
 */
export async function fetchWithTimeout(
  input: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch,
): Promise<Response> {
  const ms = Math.max(1, Math.floor(timeoutMs));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);

  const outer = init?.signal;
  const onOuterAbort = (): void => {
    ctrl.abort();
  };
  if (outer) {
    if (outer.aborted) {
      clearTimeout(timer);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }
    outer.addEventListener("abort", onOuterAbort, { once: true });
  }

  try {
    return await fetchImpl(input, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}
