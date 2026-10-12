/**
 * Per-coin re-entry cooldown after any exit, persisted so a restart can't
 * re-buy the coin that just stopped us out (Oct 11 Nike: bought, stopped at
 * -99%, bought again 2.5s later). Also used for short "don't touch" blocks
 * after an entry price mismatch.
 *
 * File: <mode ledger dir>/reentry-cooldowns.json — separate for paper,
 * live-dry-run and live because each mode has its own ledger dir.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExitReason, ReentryCooldownParams } from "../types.js";

export const DEFAULT_REENTRY_COOLDOWN: ReentryCooldownParams = {
  minutes: 30,
  afterLossMinutes: 120,
};

export interface ReentryBlock {
  mint: string;
  symbol: string;
  until: number;
  reason: string;
  at: number;
}

const LOSS_REASONS = new Set<string>(["stop_loss", "early_fast_drop", "early_red_ticks", "early_giveback", "early_stall", "early_reserve_drop"]);

/** Minutes to wait after this exit (0 = no cooldown). */
export function reentryMinutesFor(
  reason: ExitReason | string,
  realizedPnlUsd: number,
  p: ReentryCooldownParams,
): number {
  const loss = LOSS_REASONS.has(reason) || realizedPnlUsd < 0;
  return Math.max(0, loss ? Math.max(p.afterLossMinutes, p.minutes) : p.minutes);
}

export class ReentryCooldownStore {
  readonly filePath: string;
  private readonly m = new Map<string, ReentryBlock>();

  constructor(dir: string, fileName = "reentry-cooldowns.json") {
    this.filePath = join(dir, fileName);
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as { blocks?: ReentryBlock[] };
      const now = Date.now();
      for (const b of raw.blocks ?? []) {
        if (b && typeof b.mint === "string" && Number.isFinite(b.until) && b.until > now) this.m.set(b.mint, b);
      }
    } catch {
      // Corrupt file: start empty (the worst case is one extra entry).
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, blocks: [...this.m.values()] }, null, 2));
      renameSync(tmp, this.filePath);
    } catch {
      // Best effort; the in-memory block still applies this session.
    }
  }

  /** Block a mint until now + minutes (keeps the later of old/new). */
  block(mint: string, symbol: string, minutes: number, reason: string, now = Date.now()): ReentryBlock | null {
    if (!(minutes > 0)) return null;
    const until = now + minutes * 60_000;
    const prev = this.m.get(mint);
    if (prev && prev.until >= until) return prev;
    const b: ReentryBlock = { mint, symbol, until, reason, at: now };
    this.m.set(mint, b);
    this.prune(now);
    this.save();
    return b;
  }

  /** Active block for a mint, or null. */
  get(mint: string, now = Date.now()): ReentryBlock | null {
    const b = this.m.get(mint);
    if (!b) return null;
    if (b.until <= now) {
      this.m.delete(mint);
      return null;
    }
    return b;
  }

  list(now = Date.now()): ReentryBlock[] {
    this.prune(now);
    return [...this.m.values()];
  }

  private prune(now: number): void {
    for (const [k, b] of this.m) if (b.until <= now) this.m.delete(k);
  }
}
