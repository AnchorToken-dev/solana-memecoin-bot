import { getApiBaseUrl } from "./settings";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const base = await getApiBaseUrl();
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch (err) {
    throw new ApiError(
      `Cannot reach API at ${base}. Is the bot running (npm run api)? On USB try: adb reverse tcp:8787 tcp:8787. On Wi‑Fi use your laptop LAN IP.`,
    );
  }
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const msg =
      typeof body === "object" && body && "message" in body
        ? String((body as { message: unknown }).message)
        : `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

export const api = {
  health: () => request<{ ok: boolean; paperMode: boolean }>("/health"),
  status: () => request<Record<string, unknown>>("/status"),
  config: () => request<{ config: Record<string, unknown> }>("/config"),
  portfolio: () =>
    request<{
      bankrollUsd: number;
      portfolio: {
        cashUsd: number;
        equityUsd: number;
        realizedPnlUsd: number;
        unrealizedPnlUsd: number;
        tradeCount: number;
        /** Each open position includes mint + symbol for chart URLs. */
        openPositions: Array<{
          id?: string;
          mint: string;
          symbol: string;
          qty: number;
          entryPrice: number;
          trailArmed?: boolean;
          [key: string]: unknown;
        }>;
      };
    }>("/portfolio"),
  trades: (limit = 40) =>
    request<{ trades: Array<{ fill: Record<string, unknown>; realizedPnlUsd?: number; cashAfter: number }> }>(
      `/trades?limit=${limit}`,
    ),
  start: (opts?: { reset?: boolean }) =>
    request<{ ok: boolean; message: string }>(
      opts?.reset ? "/runner/start?reset=1" : "/runner/start",
      {
        method: "POST",
        body: opts?.reset ? JSON.stringify({ reset: true }) : undefined,
      },
    ),
  stop: () =>
    request<{ ok: boolean; message: string }>("/runner/stop", { method: "POST" }),
  reset: () =>
    request<{
      ok: boolean;
      message: string;
      status: Record<string, unknown>;
      portfolio: Record<string, unknown>;
    }>("/runner/reset", { method: "POST" }),
  exitNow: () =>
    request<{
      ok: boolean;
      message: string;
      status: Record<string, unknown>;
      portfolio: Record<string, unknown>;
      fills?: Array<Record<string, unknown>>;
    }>("/runner/exit", { method: "POST" }),
  patchConfig: (body: Record<string, unknown>) =>
    request<{
      ok: boolean;
      message: string;
      config: Record<string, unknown>;
      status: Record<string, unknown>;
    }>("/config", { method: "PATCH", body: JSON.stringify(body) }),
  applyPreset: (preset: "momentum" | "sniper") =>
    request<{
      ok: boolean;
      message: string;
      config: Record<string, unknown>;
      status: Record<string, unknown>;
    }>("/config/preset", {
      method: "POST",
      body: JSON.stringify({ preset }),
    }),
  journal: (limit = 50, offset = 0) =>
    request<{
      entries: Array<{
        id: string;
        timestamp: number;
        openedAt: number;
        mint: string;
        symbol: string;
        side: string;
        sizeUsd: number;
        entryPrice: number;
        exitPrice: number;
        pnlUsd: number;
        pnlPct: number;
        exitReason: string;
        note: string;
      }>;
      total: number;
      limit: number;
      offset: number;
    }>(`/journal?limit=${limit}&offset=${offset}`),
  updateJournalNote: (id: string, note: string) =>
    request<{ ok: boolean; entry: { id: string; note: string }; message?: string }>(
      `/journal/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify({ note }) },
    ),
  clearJournal: () =>
    request<{ ok: boolean; cleared: number; message: string }>("/journal", {
      method: "DELETE",
    }),
  checklistTemplate: () =>
    request<{
      items: Array<{
        id: string;
        label: string;
        required: boolean;
        status: "pass" | "fail" | "skip" | "unset";
      }>;
      thesis: string;
      invalidation: string;
      verdict: "GO" | "NO-GO" | "INCOMPLETE";
    }>("/checklist/template"),
  checklist: (limit = 30, offset = 0, mint?: string) =>
    request<{
      entries: Array<{
        id: string;
        timestamp: number;
        mint: string;
        symbol: string;
        link: string;
        items: Array<{
          id: string;
          label: string;
          required: boolean;
          status: string;
        }>;
        thesis: string;
        invalidation: string;
        verdict: "GO" | "NO-GO" | "INCOMPLETE";
      }>;
      total: number;
      limit: number;
      offset: number;
    }>(
      `/checklist?limit=${limit}&offset=${offset}${
        mint ? `&mint=${encodeURIComponent(mint)}` : ""
      }`,
    ),
  createChecklist: (body: Record<string, unknown>) =>
    request<{
      ok: boolean;
      entry: {
        id: string;
        verdict: "GO" | "NO-GO" | "INCOMPLETE";
        mint: string;
        symbol: string;
        timestamp: number;
      };
      message?: string;
    }>("/checklist", { method: "POST", body: JSON.stringify(body) }),
  getChecklist: (id: string) =>
    request<{
      ok: boolean;
      entry: {
        id: string;
        timestamp: number;
        mint: string;
        symbol: string;
        link: string;
        items: Array<{
          id: string;
          label: string;
          required: boolean;
          status: string;
        }>;
        thesis: string;
        invalidation: string;
        verdict: "GO" | "NO-GO" | "INCOMPLETE";
      };
    }>(`/checklist/${encodeURIComponent(id)}`),
  alerts: (since = 0, limit = 50) =>
    request<{
      events: Array<{
        id: string;
        type: string;
        title: string;
        body: string;
        timestamp: number;
        meta?: Record<string, unknown>;
      }>;
    }>(`/alerts?since=${since}&limit=${limit}`),
};
