/**
 * Shadow logger: for every KOL buy, record what a follower would have seen.
 *
 * It reads the coin's on-chain price right away (when the signal reaches us), then again at fixed
 * offsets (default 2, 3, 5, 8, 13, 20, 33, 45, 63, 90, 123, 180, 243, 300 s: the evaluator enters at the 3 s sample, so 13/33/63/123/243 land exactly 10/30/60/120/240 s after it), and writes ONE line per signal when the last sample is
 * in. It never trades and never touches the bot's ledger or journal. Output:
 *   <dir>/signals/YYYY-MM-DD.jsonl   (UTC day)
 *
 * Line (kind "kol_signal"):
 *   at           ms when the signal reached us
 *   tradeTimeMs  the KOL row's own timestamp; lagMs = at - tradeTimeMs (feed delay)
 *   kolPriceUsd / solUsd  the KOL's fill price and the SOL price implied by the row
 *   samples      [[msSinceArrival, priceSol, quoteReserveSol?], ...] on-chain marks
 *   venue        bonding_curve | pumpswap (coins the on-chain reader can't price are skipped)
 *   partial      true if the process stopped before all samples were taken
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { KolBuy } from "./trades.js";

export interface KolMark {
  priceSol: number;
  venue: string;
  quoteReserveSol?: number;
}

export interface KolMarkReader {
  read(mint: string): Promise<KolMark | null>;
  drop?(mint: string): void;
}

export type SampleRow = [msSinceArrival: number, priceSol: number, quoteReserveSol?: number];

export interface KolSignalRecord {
  v: 1;
  kind: "kol_signal";
  at: number;
  tx: string;
  wallet: string;
  rank: number | null;
  kol: string | null;
  mint: string;
  symbol: string | null;
  program: string | null;
  kolPriceUsd: number | null;
  solUsd: number | null;
  volumeUsd: number;
  tradeTimeMs: number;
  lagMs: number;
  venue: string;
  samples: SampleRow[];
  partial?: true;
}

export interface ShadowStats {
  signals: number;
  logged: number;
  duplicates: number;
  droppedBusy: number;
  unreadable: number;
  sampleReadFails: number;
}

export interface ShadowDeps {
  reader: KolMarkReader;
  dir: string;
  /** Seconds after arrival to sample. 0 is always added. */
  offsetsS?: readonly number[];
  maxActive?: number;
  /** wallet -> leaderboard rank (1 = top). */
  ranks?: ReadonlyMap<string, number>;
  /** Reuse a read of the same coin made within this many ms (saves RPC calls). */
  readCacheMs?: number;
  /** How long a coin the reader can't price is ignored. */
  unreadableTtlMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export const DEFAULT_OFFSETS_S = [2, 3, 5, 8, 13, 20, 33, 45, 63, 90, 123, 180, 243, 300] as const;

interface Active {
  rec: KolSignalRecord;
  timers: unknown[];
  remaining: number;
}

export class KolShadowLogger {
  readonly stats: ShadowStats = { signals: 0, logged: 0, duplicates: 0, droppedBusy: 0, unreadable: 0, sampleReadFails: 0 };
  private readonly active = new Map<string, Active>();
  private readonly doneKeys = new Set<string>();
  private readonly unreadable = new Map<string, number>();
  private readonly lastRead = new Map<string, { at: number; mark: KolMark | null }>();
  private writeChain: Promise<void> = Promise.resolve();
  private readonly offsets: number[];
  private readonly maxActive: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  constructor(private readonly deps: ShadowDeps) {
    this.offsets = [...new Set((deps.offsetsS ?? DEFAULT_OFFSETS_S).filter((s) => s > 0))].sort((a, b) => a - b);
    this.maxActive = deps.maxActive ?? 25;
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  get activeCount(): number {
    return this.active.size;
  }

  /** Never throws. */
  async onBuy(buy: KolBuy): Promise<void> {
    try {
      await this.handle(buy);
    } catch {
      this.stats.sampleReadFails++;
    }
  }

  private async handle(buy: KolBuy): Promise<void> {
    this.stats.signals++;
    const key = `${buy.tx}:${buy.wallet}`;
    if (this.active.has(key) || this.doneKeys.has(key)) {
      this.stats.duplicates++;
      return;
    }
    const at = this.now();
    const bad = this.unreadable.get(buy.mint);
    if (bad != null && bad > at) {
      this.stats.unreadable++;
      return;
    }
    if (this.active.size >= this.maxActive) {
      this.stats.droppedBusy++;
      return;
    }
    // Reserve the slot before awaiting so concurrent signals can't exceed the cap.
    const rec: KolSignalRecord = {
      v: 1,
      kind: "kol_signal",
      at,
      tx: buy.tx,
      wallet: buy.wallet,
      rank: this.deps.ranks?.get(buy.wallet) ?? null,
      kol: buy.kolName,
      mint: buy.mint,
      symbol: buy.symbol,
      program: buy.program,
      kolPriceUsd: buy.kolPriceUsd,
      solUsd: buy.solUsd,
      volumeUsd: buy.volumeUsd,
      tradeTimeMs: buy.tradeTimeMs,
      lagMs: at - buy.tradeTimeMs,
      venue: "?",
      samples: [],
    };
    const a: Active = { rec, timers: [], remaining: this.offsets.length };
    this.active.set(key, a);

    let first: KolMark | null = null;
    try {
      first = await this.readCached(buy.mint);
    } catch {
      first = null; // a throwing reader must not leak the reserved slot
    }
    if (!first) {
      this.unreadable.set(buy.mint, this.now() + (this.deps.unreadableTtlMs ?? 10 * 60_000));
      this.stats.unreadable++;
      this.active.delete(key);
      return;
    }
    rec.venue = first.venue;
    this.addSample(rec, at, first);

    for (const s of this.offsets) {
      a.timers.push(
        this.setTimer(() => {
          void this.sampleAt(key, a, at);
        }, s * 1000),
      );
      (a.timers[a.timers.length - 1] as { unref?: () => void } | undefined)?.unref?.();
    }
  }

  private async sampleAt(key: string, a: Active, at: number): Promise<void> {
    try {
      const m = await this.readCached(a.rec.mint);
      if (m) this.addSample(a.rec, at, m);
      else this.stats.sampleReadFails++;
    } catch {
      this.stats.sampleReadFails++;
    }
    a.remaining--;
    if (a.remaining <= 0 && this.active.get(key) === a) {
      this.active.delete(key);
      this.rememberDone(key);
      this.write(a.rec);
      this.release(a.rec.mint);
    }
  }

  private addSample(rec: KolSignalRecord, at: number, m: KolMark): void {
    const row: SampleRow = [Math.max(0, this.now() - at), m.priceSol];
    if (m.quoteReserveSol != null) row.push(m.quoteReserveSol);
    rec.samples.push(row);
  }

  private async readCached(mint: string): Promise<KolMark | null> {
    const t = this.now();
    const c = this.lastRead.get(mint);
    const ttl = this.deps.readCacheMs ?? 800;
    if (c && t - c.at < ttl) return c.mark;
    const mark = await this.deps.reader.read(mint);
    this.lastRead.set(mint, { at: this.now(), mark });
    if (this.lastRead.size > 500) {
      const oldest = this.lastRead.keys().next().value;
      if (oldest !== undefined) this.lastRead.delete(oldest);
    }
    return mark;
  }

  /** Let the reader forget the coin's pool once no signal follows it (bounded memory, catches graduation). */
  private release(mint: string): void {
    for (const o of this.active.values()) if (o.rec.mint === mint) return;
    try {
      this.deps.reader.drop?.(mint);
    } catch {
      /* best effort */
    }
  }

  private rememberDone(key: string): void {
    this.doneKeys.add(key);
    if (this.doneKeys.size > 5_000) {
      const oldest = this.doneKeys.values().next().value;
      if (oldest !== undefined) this.doneKeys.delete(oldest);
    }
  }

  private write(rec: KolSignalRecord): void {
    this.stats.logged++;
    const day = new Date(rec.at).toISOString().slice(0, 10);
    const dir = join(this.deps.dir, "signals");
    const line = JSON.stringify(rec) + "\n";
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dir, { recursive: true });
        await appendFile(join(dir, `${day}.jsonl`), line);
      })
      .catch(() => undefined);
  }

  /** Stop timers, write what is in flight as partial, and wait for writes to finish. */
  async flush(): Promise<void> {
    for (const [key, a] of [...this.active]) {
      for (const t of a.timers) this.clearTimer(t);
      this.active.delete(key);
      if (a.rec.samples.length > 0) this.write({ ...a.rec, partial: true });
    }
    await this.writeChain;
  }
}
