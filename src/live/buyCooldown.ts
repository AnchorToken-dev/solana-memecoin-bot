/**
 * Per-coin cooldown after a failed LIVE buy, so the bot doesn't hammer the
 * same coin every cycle with a buy that's going to fail the same way (the
 * overnight dry-run retried some coins 2–3× hours apart).
 *
 * In memory only: a restart clears it. Never affects exits, the daily loss
 * limit or any other safety gate — it only makes the bot skip a coin.
 */
import type { BuyFailureKind } from "./pumpErrors.js";

const MIN = 60_000;

/** How long to skip a coin after each kind of failure. 0 = don't skip (not the coin's fault). */
export const BUY_COOLDOWN_MS: Readonly<Record<BuyFailureKind, number>> = {
  // Price ran past the cap. Re-entering right away would be chasing the pump.
  slippage: 10 * MIN,
  // Just graduated and even the PumpSwap retry failed; give the pool a few minutes.
  migrated: 5 * MIN,
  // Paired with a non-SOL token; PumpPortal can't buy it with SOL. Won't change.
  unsupported_quote: 24 * 60 * MIN,
  // PumpPortal refuses this coin; won't change soon.
  build_rejected: 6 * 60 * MIN,
  pool_too_thin: 15 * MIN,
  // Sent but outcome unknown — re-buying could double the position.
  unconfirmed: 60 * MIN,
  not_coin_specific: 0,
  other: 5 * MIN,
};

export interface CooldownEntry {
  mint: string;
  symbol: string;
  kind: BuyFailureKind;
  until: number;
  failures: number;
}

export class BuyCooldowns {
  private readonly m = new Map<string, CooldownEntry>();

  /** Record a failed buy. Returns the entry, or null when the failure isn't the coin's fault. */
  record(mint: string, symbol: string, kind: BuyFailureKind, now: number): CooldownEntry | null {
    const ms = BUY_COOLDOWN_MS[kind] ?? BUY_COOLDOWN_MS.other;
    if (!(ms > 0)) return null;
    const prev = this.m.get(mint);
    const failures = (prev?.failures ?? 0) + 1;
    // Repeat offenders wait longer (×2 per repeat, capped at 24h).
    const until = now + Math.min(ms * 2 ** (failures - 1), 24 * 60 * MIN);
    const e: CooldownEntry = { mint, symbol, kind, until, failures };
    this.m.set(mint, e);
    return e;
  }

  blocked(mint: string, now: number): CooldownEntry | null {
    const e = this.m.get(mint);
    if (!e) return null;
    if (now >= e.until) return null;
    return e;
  }

  /** Forget a coin (e.g. after a successful buy). */
  clear(mint: string): void {
    this.m.delete(mint);
  }

  active(now: number): CooldownEntry[] {
    const out: CooldownEntry[] = [];
    for (const [k, e] of this.m) {
      if (now >= e.until && now - e.until > 24 * 60 * MIN) this.m.delete(k);
      else if (now < e.until) out.push(e);
    }
    return out;
  }
}

export function formatCooldown(ms: number): string {
  const m = Math.round(ms / MIN);
  return m >= 120 ? `${Math.round(m / 60)}h` : `${m} min`;
}
