/**
 * Entry guard: extra "don't buy the top" filters from the Oct 9 live review.
 *
 * Oct 9 (64 live trades, -$78): the 3 worst bonding-curve losses (Neura,
 * sobdog, CASHDOG, -$32.80) were coins 2.6-4 minutes old that had run
 * +130% to +912% in 5 minutes; 20-33 bundled wallets dumped them in one slot
 * seconds after our buy. 30 of 64 buys were coins whose whole 24h volume was
 * inside the 5-minute window (volSpike 288x) — those lost -$47.73.
 *
 * Every check is off at 0. Pure functions + a small per-mint price memory fed
 * from the scans the bot already does (no extra requests).
 */
import type { EntryGuardParams, EntryRejectReason, TokenSnapshot } from "../types.js";

export const DEFAULT_ENTRY_GUARD: EntryGuardParams = {
  maxRunupPct: 0,
  minCoinAgeMinutes: 0,
  maxWindowVolumeSharePct: 0,
  maxPullbackPct: 0,
  pullbackWindowSec: 120,
  maxDownTicks: 0,
};

export function entryGuardActive(p: EntryGuardParams | undefined): boolean {
  if (!p) return false;
  return (
    p.maxRunupPct > 0 ||
    p.minCoinAgeMinutes > 0 ||
    p.maxWindowVolumeSharePct > 0 ||
    p.maxPullbackPct > 0 ||
    p.maxDownTicks > 0
  );
}

interface Tick {
  at: number;
  price: number;
}

/** Prices the bot saw per mint in its scans (bounded memory). */
export class ScanPriceHistory {
  private readonly ticks = new Map<string, Tick[]>();

  constructor(
    private readonly keepMs = 10 * 60_000,
    private readonly maxMints = 2_000,
  ) {}

  record(snaps: Pick<TokenSnapshot, "mint" | "priceUsd">[], nowMs: number): void {
    for (const s of snaps) {
      if (!(s.priceUsd > 0) || !Number.isFinite(s.priceUsd)) continue;
      const arr = this.ticks.get(s.mint) ?? [];
      const last = arr[arr.length - 1];
      // Same scan can list a coin twice; keep one tick per instant.
      if (last && last.at === nowMs) last.price = s.priceUsd;
      else arr.push({ at: nowMs, price: s.priceUsd });
      while (arr.length > 0 && nowMs - arr[0]!.at > this.keepMs) arr.shift();
      this.ticks.set(s.mint, arr);
    }
    if (this.ticks.size > this.maxMints) {
      for (const [k, v] of this.ticks) {
        if (v.length === 0 || nowMs - v[v.length - 1]!.at > this.keepMs) this.ticks.delete(k);
      }
    }
  }

  get(mint: string): readonly Tick[] {
    return this.ticks.get(mint) ?? [];
  }
}

export interface EntryGuardVerdict {
  ok: boolean;
  reason?: EntryRejectReason;
  detail?: string;
}

/**
 * Check one candidate. `history` should already include the current scan.
 * Unknown data never blocks (except where noted): these are extra filters
 * on top of the existing momentum/rug checks.
 */
export function evaluateEntryGuard(
  snap: TokenSnapshot,
  history: readonly Tick[],
  p: EntryGuardParams,
  nowMs: number,
): EntryGuardVerdict {
  if (p.maxRunupPct > 0 && snap.changeWindowPct > p.maxRunupPct) {
    return {
      ok: false,
      reason: "run_too_far",
      detail: `already up ${snap.changeWindowPct.toFixed(0)}% in the window (max ${p.maxRunupPct}%) — likely buying the top`,
    };
  }

  const share =
    snap.volume24hUsd > 0 ? (snap.volumeWindowUsd / snap.volume24hUsd) * 100 : null;
  if (p.minCoinAgeMinutes > 0) {
    const known = snap.createdAt != null && Number.isFinite(snap.createdAt) && snap.createdAt > 0;
    if (known) {
      const age = (nowMs - snap.createdAt!) / 60_000;
      if (age < p.minCoinAgeMinutes) {
        return {
          ok: false,
          reason: "brand_new",
          detail: `coin is ${age.toFixed(1)} min old (min ${p.minCoinAgeMinutes})`,
        };
      }
    } else if (share != null && share >= 95) {
      // No creation time: all of the 24h volume inside the window = brand new.
      return {
        ok: false,
        reason: "brand_new",
        detail: `age unknown and ${share.toFixed(0)}% of 24h volume is from the last window — treating as brand new`,
      };
    }
  }
  if (p.maxWindowVolumeSharePct > 0 && share != null && share >= p.maxWindowVolumeSharePct) {
    return {
      ok: false,
      reason: "brand_new",
      detail: `${share.toFixed(0)}% of its 24h volume is from the last window (max ${p.maxWindowVolumeSharePct}%) — coin just launched`,
    };
  }

  if (p.maxPullbackPct > 0 && history.length >= 2) {
    const since = nowMs - p.pullbackWindowSec * 1_000;
    const recent = history.filter((t) => t.at >= since);
    const high = Math.max(...recent.map((t) => t.price));
    const cur = snap.priceUsd;
    if (high > 0 && cur > 0) {
      const off = ((high - cur) / high) * 100;
      if (off >= p.maxPullbackPct) {
        return {
          ok: false,
          reason: "fading",
          detail: `price is ${off.toFixed(1)}% below its ${p.pullbackWindowSec}s high (max ${p.maxPullbackPct}%) — momentum fading`,
        };
      }
    }
  }

  if (p.maxDownTicks > 0 && history.length > p.maxDownTicks) {
    const tail = history.slice(-(p.maxDownTicks + 1));
    let down = true;
    for (let i = 1; i < tail.length; i++) {
      if (!(tail[i]!.price < tail[i - 1]!.price)) {
        down = false;
        break;
      }
    }
    if (down) {
      return {
        ok: false,
        reason: "fading",
        detail: `${p.maxDownTicks} lower prices in a row across scans — red candles`,
      };
    }
  }
  return { ok: true };
}
