/**
 * Shadow tape: what happened to coins we DIDN'T buy.
 *
 * When a coin passes the scan but an entry filter / memory / price check /
 * cooldown / rug filter (or, sampled, a momentum filter) says no, follow its
 * on-chain price for a few minutes anyway so we can later ask "was that skip
 * right?". Writes one line per followed coin when the follow ends:
 *   <mode dir>/shadow-tape/YYYY-MM-DD.jsonl
 *   {v, kind:"shadow", mint, symbol, mode, at, reason, detail, quotePrice,
 *    features, snapshot, reads: [[msSinceSkip, priceUsd, quoteReserveSol?], ...], endedBy}
 *
 * Never slows trading: nothing is awaited by the engine, timers are unref'd,
 * at most `maxConcurrent` coins are followed at once (momentum-filter rejects
 * only get the spare half), and a coin is followed at most once per
 * `dedupeMinutes`.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { TokenSnapshot } from "../types.js";
import { JOURNAL_TZ_DEFAULT, getZonedParts } from "./timezone.js";
import type { TapeOnchainRead } from "./priceTape.js";

export interface ShadowTapeParams {
  enabled: boolean;
  seconds: number;
  intervalMs: number;
  maxConcurrent: number;
  dedupeMinutes: number;
}

export const DEFAULT_SHADOW_TAPE: ShadowTapeParams = {
  enabled: true,
  seconds: 300,
  intervalMs: 5_000,
  maxConcurrent: 4,
  dedupeMinutes: 30,
};

/** Skips from the final entry checks get priority over plain momentum-filter rejects. */
export type ShadowPriority = "filter" | "scan";

export interface ShadowSkip {
  mint: string;
  symbol: string;
  mode: string;
  reason: string;
  detail?: string;
  quotePrice?: number;
  snapshot?: TokenSnapshot;
  features?: Record<string, number | null>;
  priority?: ShadowPriority;
}

interface Follow {
  s: ShadowSkip;
  at: number;
  reads: [number, number, number?][];
  timer: ReturnType<typeof setTimeout> | null;
  fails: number;
}

export class ShadowTape {
  private readonly active = new Map<string, Follow>();
  private readonly lastFollowed = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  private readonly now: () => number;
  private readonly tz: string;
  /** Counters for /status. */
  readonly stats = { started: 0, written: 0, droppedBusy: 0, droppedDup: 0 };

  constructor(
    private readonly dir: string,
    private readonly p: ShadowTapeParams,
    private readonly readOnchain: ((mint: string) => Promise<TapeOnchainRead | null>) | null,
    opts?: { now?: () => number; timeZone?: string },
  ) {
    this.now = opts?.now ?? Date.now;
    this.tz = opts?.timeZone ?? JOURNAL_TZ_DEFAULT;
  }

  get enabled(): boolean {
    return this.p.enabled && !this.disposed && this.readOnchain != null && this.p.seconds > 0;
  }

  get activeCount(): number {
    return this.active.size;
  }

  fileFor(ms: number): string {
    const z = getZonedParts(ms, this.tz);
    const d = `${z.year}-${String(z.month).padStart(2, "0")}-${String(z.day).padStart(2, "0")}`;
    return join(this.dir, "shadow-tape", `${d}.jsonl`);
  }

  /** Start following a skipped coin. Returns false when not taken (off / busy / duplicate). Never throws. */
  track(s: ShadowSkip): boolean {
    try {
      if (!this.enabled) return false;
      const now = this.now();
      if (this.active.has(s.mint)) {
        this.stats.droppedDup++;
        return false;
      }
      const last = this.lastFollowed.get(s.mint);
      if (last != null && now - last < this.p.dedupeMinutes * 60_000) {
        this.stats.droppedDup++;
        return false;
      }
      const cap = Math.max(0, this.p.maxConcurrent);
      const limit = (s.priority ?? "filter") === "scan" ? Math.floor(cap / 2) : cap;
      if (this.active.size >= limit) {
        this.stats.droppedBusy++;
        return false;
      }
      if (this.lastFollowed.size > 5_000) {
        for (const [m, t] of this.lastFollowed) if (now - t > this.p.dedupeMinutes * 60_000) this.lastFollowed.delete(m);
      }
      this.lastFollowed.set(s.mint, now);
      const f: Follow = { s, at: now, reads: [], timer: null, fails: 0 };
      this.active.set(s.mint, f);
      this.stats.started++;
      this.schedule(f, 0);
      return true;
    } catch {
      return false;
    }
  }

  private schedule(f: Follow, delay: number): void {
    if (this.disposed) return;
    f.timer = setTimeout(() => void this.tick(f), delay);
    f.timer.unref?.();
  }

  private async tick(f: Follow): Promise<void> {
    f.timer = null;
    if (this.disposed || this.active.get(f.s.mint) !== f) return;
    const t = this.now() - f.at;
    try {
      const r = await this.readOnchain!(f.s.mint);
      if (r && Number.isFinite(r.priceUsd) && r.priceUsd > 0) {
        f.reads.push(r.quoteReserveSol != null ? [t, r.priceUsd, r.quoteReserveSol] : [t, r.priceUsd]);
        f.fails = 0;
      } else f.fails++;
    } catch {
      f.fails++;
    }
    if (this.disposed) return;
    const elapsed = this.now() - f.at;
    if (elapsed >= this.p.seconds * 1_000) return this.finish(f, "done");
    // Unreadable coin (wrong pair / dead): stop after 6 misses in a row.
    if (f.fails >= 6) return this.finish(f, "unreadable");
    this.schedule(f, Math.max(1_000, this.p.intervalMs));
  }

  private finish(f: Follow, endedBy: string): void {
    if (f.timer) clearTimeout(f.timer);
    f.timer = null;
    this.active.delete(f.s.mint);
    const { s } = f;
    const line = {
      v: 1,
      kind: "shadow",
      mint: s.mint,
      symbol: s.symbol,
      mode: s.mode,
      at: f.at,
      reason: s.reason,
      ...(s.detail ? { detail: s.detail.slice(0, 300) } : {}),
      quotePrice: s.quotePrice ?? s.snapshot?.priceUsd ?? null,
      features: s.features ?? null,
      snapshot: s.snapshot ?? null,
      reads: f.reads,
      endedBy,
    };
    const file = this.fileFor(f.at);
    const text = `${JSON.stringify(line)}\n`;
    this.stats.written++;
    this.chain = this.chain
      .then(async () => {
        await mkdir(join(this.dir, "shadow-tape"), { recursive: true });
        await appendFile(file, text, "utf8");
      })
      .catch(() => undefined);
  }

  flush(): Promise<void> {
    return this.chain;
  }

  /** Stop all timers; write what we have so far. */
  dispose(): Promise<void> {
    for (const f of [...this.active.values()]) this.finish(f, "stopped");
    this.disposed = true;
    return this.chain;
  }
}
