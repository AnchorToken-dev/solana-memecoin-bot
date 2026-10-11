/**
 * Early-warning exits on the fast on-chain mark (FAST_EXIT_POLL_MS, ~1s).
 * Run AFTER the normal stop / take-profit / time / trail checks and only
 * when those didn't fire. Every rule is off at 0.
 *
 * Oct 9 evidence (honest): the four biggest crashes went from fine to -80%+
 * inside one or two Solana slots (bundled dumps), so no exit rule could have
 * beaten them — the entry guard is the fix for those. On-chain marks were not
 * logged per read that day and minute candles can't show what happened inside
 * a 5-20s hold, so these rules are NOT proven by Oct 9 data. They target slow
 * fades and stalls (e.g. CLAUDIA held 10 min for -$1.11) and should be tried
 * in paper / dry-run before live.
 */
import type { EarlyExitParams, ExitReason, Position } from "../types.js";

export const DEFAULT_EARLY_EXIT: EarlyExitParams = {
  fastDropPct: 0,
  fastDropWindowMs: 3_000,
  redTicks: 0,
  redTicksMinDropPct: 3,
  givebackArmPct: 0,
  givebackPct: 50,
  stallSeconds: 0,
};

export function earlyExitActive(p: EarlyExitParams | undefined): boolean {
  if (!p) return false;
  return p.fastDropPct > 0 || p.redTicks > 0 || p.givebackArmPct > 0 || p.stallSeconds > 0;
}

interface Mark {
  at: number;
  price: number;
}

/** Recent marks per open position plus when it last made a new high. */
export class PositionMarkHistory {
  private readonly marks = new Map<string, Mark[]>();
  private readonly lastHighAt = new Map<string, number>();
  private readonly peak = new Map<string, number>();

  constructor(private readonly keepMs = 120_000) {}

  record(positionId: string, price: number, nowMs: number): void {
    if (!(price > 0) || !Number.isFinite(price)) return;
    const arr = this.marks.get(positionId) ?? [];
    const last = arr[arr.length - 1];
    // The full tick re-uses the fast poller's cached read: don't count it twice.
    if (last && last.price === price && nowMs - last.at < 1_000) return;
    arr.push({ at: nowMs, price });
    while (arr.length > 0 && nowMs - arr[0]!.at > this.keepMs) arr.shift();
    this.marks.set(positionId, arr);
    const pk = this.peak.get(positionId);
    if (pk == null || price > pk) {
      this.peak.set(positionId, price);
      this.lastHighAt.set(positionId, nowMs);
    }
  }

  get(positionId: string): readonly Mark[] {
    return this.marks.get(positionId) ?? [];
  }

  peakPrice(positionId: string): number | undefined {
    return this.peak.get(positionId);
  }

  lastNewHighAt(positionId: string): number | undefined {
    return this.lastHighAt.get(positionId);
  }

  /** Forget positions that are no longer open. */
  retain(openIds: Set<string>): void {
    for (const k of [...this.marks.keys()]) {
      if (!openIds.has(k)) {
        this.marks.delete(k);
        this.lastHighAt.delete(k);
        this.peak.delete(k);
      }
    }
  }
}

export interface EarlyExitSignal {
  reason: ExitReason;
  detail: string;
}

/**
 * `history` must already include the current mark. Peak = max(highWater,
 * history peak). Returns null when nothing fires.
 */
export function evaluateEarlyExit(
  pos: Position,
  mark: number,
  history: PositionMarkHistory,
  p: EarlyExitParams,
  nowMs: number,
): EarlyExitSignal | null {
  const marks = history.get(pos.id);

  if (p.fastDropPct > 0 && marks.length >= 2) {
    const since = nowMs - p.fastDropWindowMs;
    const window = marks.filter((m) => m.at >= since);
    const hi = Math.max(...window.map((m) => m.price));
    if (hi > 0) {
      const drop = ((hi - mark) / hi) * 100;
      if (drop >= p.fastDropPct) {
        return {
          reason: "early_fast_drop",
          detail: `fell ${drop.toFixed(1)}% in ${(p.fastDropWindowMs / 1000).toFixed(1)}s`,
        };
      }
    }
  }

  if (p.redTicks > 0 && marks.length > p.redTicks) {
    const tail = marks.slice(-(p.redTicks + 1));
    let allDown = true;
    for (let i = 1; i < tail.length; i++) {
      if (!(tail[i]!.price < tail[i - 1]!.price)) {
        allDown = false;
        break;
      }
    }
    const start = tail[0]!.price;
    const drop = start > 0 ? ((start - mark) / start) * 100 : 0;
    if (allDown && drop >= p.redTicksMinDropPct) {
      return {
        reason: "early_red_ticks",
        detail: `${p.redTicks} lower reads in a row (-${drop.toFixed(1)}%) — sellers in control`,
      };
    }
  }

  if (p.givebackArmPct > 0 && pos.entryPrice > 0) {
    const peak = Math.max(pos.highWaterPrice, history.peakPrice(pos.id) ?? 0);
    const peakGainPct = ((peak - pos.entryPrice) / pos.entryPrice) * 100;
    if (peakGainPct >= p.givebackArmPct) {
      const gainNow = ((mark - pos.entryPrice) / pos.entryPrice) * 100;
      const givenBack = ((peakGainPct - gainNow) / peakGainPct) * 100;
      if (givenBack >= p.givebackPct) {
        return {
          reason: "early_giveback",
          detail: `peaked +${peakGainPct.toFixed(1)}%, now ${gainNow >= 0 ? "+" : ""}${gainNow.toFixed(1)}% (gave back ${givenBack.toFixed(0)}% of the gain)`,
        };
      }
    }
  }

  if (p.stallSeconds > 0 && mark < pos.entryPrice) {
    const lastHigh = history.lastNewHighAt(pos.id) ?? pos.openedAt;
    const since = Math.max(lastHigh, pos.openedAt);
    if (nowMs - since >= p.stallSeconds * 1_000) {
      return {
        reason: "early_stall",
        detail: `no new high for ${Math.round((nowMs - since) / 1000)}s and below entry`,
      };
    }
  }
  return null;
}
