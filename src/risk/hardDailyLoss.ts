/**
 * HARD daily loss limit. Cannot be turned off.
 *
 * - Ceiling is hardcoded at $300. Env / config / presets / API / phone may only LOWER it.
 * - Anything else (missing, 0, negative, NaN, text, > 300, "off", null…) → $300 + warning.
 * - Loss today (ET) = net realized PnL of closes today + unrealized LOSSES on open positions.
 * - When hit: no new buys, exits keep running, lock persists on disk until next ET midnight.
 *   Reset / restart / journal clear cannot clear it (separate file, separate tally).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startOfDay } from "../journal/timezone.js";

export const HARD_DAILY_LOSS_CEILING_USD = 300 as const;
export const HARD_DAILY_LOSS_TZ = "America/New_York";

export interface Clamped {
  usd: number;
  warning: string | null;
}

/** Only a finite number in (0, 300] is honoured. Everything else → 300. */
export function clampHardDailyLoss(raw: unknown, source: string): Clamped {
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw.trim())
        : NaN;
  if (raw === undefined || raw === null || (typeof raw === "string" && raw.trim() === "")) {
    return { usd: HARD_DAILY_LOSS_CEILING_USD, warning: null };
  }
  if (!Number.isFinite(n) || n <= 0 || n > HARD_DAILY_LOSS_CEILING_USD) {
    return {
      usd: HARD_DAILY_LOSS_CEILING_USD,
      warning: `${source}=${String(raw).slice(0, 20)} can't raise or disable the hard daily loss limit; using $${HARD_DAILY_LOSS_CEILING_USD}`,
    };
  }
  return { usd: n, warning: null };
}

/** Next ET midnight after `ms` (DST-safe). */
export function nextEtMidnight(ms: number): number {
  const today = startOfDay(ms, HARD_DAILY_LOSS_TZ);
  return startOfDay(today + 30 * 3600_000, HARD_DAILY_LOSS_TZ);
}

interface ModeDay {
  dayStartMs: number;
  realizedUsd: number;
  lockedAt: number | null;
  lossAtLockUsd: number | null;
}

export interface HardDailyLossStatus {
  ceilingUsd: number;
  limitUsd: number;
  /** Loss so far today as a positive number (0 when up). */
  todayLossUsd: number;
  realizedTodayUsd: number;
  unrealizedLossUsd: number;
  remainingUsd: number;
  locked: boolean;
  lockedAt: number | null;
  /** Epoch ms of next ET midnight when locked. */
  lockedUntil: number | null;
  warnings: string[];
}

export class HardDailyLossStore {
  readonly path: string;
  private data: Record<string, ModeDay> = {};

  constructor(dataDir: string, private readonly now: () => number = Date.now) {
    this.path = join(dataDir, "hard-daily-loss.json");
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, ModeDay>;
        if (raw && typeof raw === "object") this.data = raw;
      } catch {
        // Unreadable file: fail CLOSED for today rather than silently unlocking.
        const d = startOfDay(this.now(), HARD_DAILY_LOSS_TZ);
        this.data = { __corrupt: { dayStartMs: d, realizedUsd: 0, lockedAt: this.now(), lossAtLockUsd: null } };
      }
    }
  }

  private day(mode: string): ModeDay {
    const today = startOfDay(this.now(), HARD_DAILY_LOSS_TZ);
    const cur = this.data[mode];
    if (!cur || cur.dayStartMs !== today) {
      const fresh = { dayStartMs: today, realizedUsd: 0, lockedAt: null, lossAtLockUsd: null };
      this.data[mode] = fresh;
      return fresh;
    }
    return cur;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
  }

  recordClose(mode: string, pnlUsd: number): void {
    if (!Number.isFinite(pnlUsd)) return;
    this.day(mode).realizedUsd += pnlUsd;
    this.persist();
  }

  realizedToday(mode: string): number {
    return this.day(mode).realizedUsd;
  }

  isLocked(mode: string): boolean {
    const corrupt = this.data.__corrupt;
    if (corrupt && corrupt.dayStartMs === startOfDay(this.now(), HARD_DAILY_LOSS_TZ)) return true;
    return this.day(mode).lockedAt != null;
  }

  lock(mode: string, lossUsd: number): void {
    const d = this.day(mode);
    if (d.lockedAt != null) return;
    d.lockedAt = this.now();
    d.lossAtLockUsd = lossUsd;
    this.persist();
  }

  status(mode: string, limitUsd: number, unrealizedLossUsd: number, warnings: string[]): HardDailyLossStatus {
    const realized = this.realizedToday(mode);
    const todayLossUsd = Math.max(0, -(realized - Math.abs(unrealizedLossUsd)));
    const locked = this.isLocked(mode);
    return {
      ceilingUsd: HARD_DAILY_LOSS_CEILING_USD,
      limitUsd,
      todayLossUsd,
      realizedTodayUsd: realized,
      unrealizedLossUsd: Math.abs(unrealizedLossUsd),
      remainingUsd: locked ? 0 : Math.max(0, limitUsd - todayLossUsd),
      locked,
      lockedAt: this.data[mode]?.lockedAt ?? null,
      lockedUntil: locked ? nextEtMidnight(this.now()) : null,
      warnings,
    };
  }
}
