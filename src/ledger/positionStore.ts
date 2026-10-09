/**
 * Open-position persistence (crash / restart safety).
 *
 * Open positions used to live only in memory, so restarting the API while a
 * LIVE position was open orphaned real tokens. Now the ledger writes its open
 * positions + session cash to a mode-scoped file on every open / close /
 * update, atomically (write tmp → fsync → rename), and restores it on boot.
 *
 *   paper         → <ledgerDir>/open-positions.paper.json
 *   live_dry_run  → <ledgerDir>/live/open-positions.dry-run.json
 *   live          → <ledgerDir>/live/open-positions.json
 *
 * No secrets: mint, symbol, qty, prices, fees, signature, timestamps only.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { Position, TradingMode } from "../types.js";

export const POSITIONS_FILE_VERSION = 1;

export function positionsFileName(mode: TradingMode): string {
  if (mode === "live") return "open-positions.json";
  if (mode === "live_dry_run") return "open-positions.dry-run.json";
  return "open-positions.paper.json";
}

/** Human-readable exit levels at save time (informational; exits recompute from config). */
export interface PositionLevels {
  stopLossPrice: number;
  takeProfitPrice: number | null;
  trailActivatePrice: number | null;
  trailStopPrice: number | null;
  maxHoldUntil: number | null;
}

export interface PositionsFile {
  version: number;
  mode: TradingMode;
  savedAt: number;
  /** Session tradable cash with the open positions' cost already deducted. */
  cashUsd: number;
  realizedPnlUsd: number;
  positions: Array<Position & { levels?: PositionLevels }>;
}

/** Atomic write: a crash mid-write leaves the previous file intact. */
export function writeFileAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export type ReadPositionsResult =
  | { ok: true; file: PositionsFile | null }
  | { ok: false; error: string };

function isPosition(v: unknown): v is Position {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.id === "string" &&
    typeof p.mint === "string" &&
    typeof p.symbol === "string" &&
    typeof p.qty === "number" && Number.isFinite(p.qty) && p.qty > 0 &&
    typeof p.entryPrice === "number" && Number.isFinite(p.entryPrice) &&
    typeof p.entryNotionalUsd === "number" && Number.isFinite(p.entryNotionalUsd) &&
    typeof p.highWaterPrice === "number" &&
    typeof p.openedAt === "number"
  );
}

export function readPositionsFile(path: string, mode: TradingMode): ReadPositionsResult {
  if (!existsSync(path)) return { ok: true, file: null };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, error: `unreadable positions file (${(err as Error).message})` };
  }
  const f = raw as Partial<PositionsFile>;
  if (!f || typeof f !== "object" || !Array.isArray(f.positions)) {
    return { ok: false, error: "positions file has no positions array" };
  }
  if (f.mode !== mode) return { ok: false, error: `positions file is for mode ${String(f.mode)}, not ${mode}` };
  const bad = f.positions.filter((p) => !isPosition(p));
  if (bad.length > 0) return { ok: false, error: `${bad.length} malformed position(s) in positions file` };
  return {
    ok: true,
    file: {
      version: Number(f.version ?? POSITIONS_FILE_VERSION),
      mode,
      savedAt: Number(f.savedAt ?? 0),
      cashUsd: Number(f.cashUsd),
      realizedPnlUsd: Number(f.realizedPnlUsd ?? 0),
      positions: f.positions.map((p) => {
        const { levels: _l, ...pos } = p as Position & { levels?: unknown };
        void _l;
        return { ...pos, trailArmed: pos.trailArmed === true, side: "long" as const, entryFeesUsd: Number(pos.entryFeesUsd ?? 0) };
      }),
    },
  };
}
