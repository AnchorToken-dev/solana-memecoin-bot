import type {
  BotConfig,
  EntryReject,
  EntryRejectReason,
  ExitReason,
  Position,
  TokenSnapshot,
} from "../types.js";
import { isMaxHoldExceeded, isTakeProfitHit } from "../risk/manager.js";

export interface EntrySignal {
  mint: string;
  symbol: string;
  priceUsd: number;
  reason: string;
}

export interface ExitSignal {
  positionId: string;
  reason: ExitReason;
  markPrice: number;
}

export interface EntryEvaluation {
  signals: EntrySignal[];
  rejects: EntryReject[];
}

function ageMinutes(createdAt: number, nowMs: number): number {
  return (nowMs - createdAt) / 60_000;
}

/**
 * Momentum entry: age floor (when known) + liquidity + 24h vol + window % + volume spike.
 *
 * Defaults (overridable via env / config):
 *   - MOMENTUM_MIN_PCT = 8
 *   - VOLUME_SPIKE_MULT = 2.0
 *   - MIN_LIQUIDITY_USD = 15000
 *   - MIN_VOLUME_24H_USD = 25000
 *   - MIN_AGE_MINUTES = 3 (skip when createdAt present and younger)
 *
 * Collects skip/reject reasons for logging (too_new, low_liquidity, etc.).
 */
export function evaluateEntries(
  snaps: TokenSnapshot[],
  cfg: BotConfig,
  openMints: Set<string>,
  nowMs: number = Date.now(),
): EntryEvaluation {
  const m = cfg.momentum;
  const signals: EntrySignal[] = [];
  const rejects: EntryReject[] = [];

  const reject = (
    s: TokenSnapshot,
    reason: EntryRejectReason,
    detail: string,
  ): void => {
    rejects.push({ mint: s.mint, symbol: s.symbol, reason, detail });
  };

  for (const s of snaps) {
    if (openMints.has(s.mint)) {
      reject(s, "already_open", "already holding this mint");
      continue;
    }

    if (
      m.minAgeMinutes > 0 &&
      s.createdAt != null &&
      Number.isFinite(s.createdAt) &&
      s.createdAt > 0
    ) {
      const age = ageMinutes(s.createdAt, nowMs);
      if (age < m.minAgeMinutes) {
        reject(
          s,
          "too_new",
          `age ${age.toFixed(2)}m < min ${m.minAgeMinutes}m`,
        );
        continue;
      }
    }

    if (s.liquidityUsd < m.minLiquidityUsd) {
      reject(
        s,
        "low_liquidity",
        `liq $${s.liquidityUsd.toFixed(0)} < $${m.minLiquidityUsd}`,
      );
      continue;
    }
    if (s.volume24hUsd < m.minVolume24hUsd) {
      reject(
        s,
        "low_volume_24h",
        `vol24h $${s.volume24hUsd.toFixed(0)} < $${m.minVolume24hUsd}`,
      );
      continue;
    }
    if (s.changeWindowPct < m.minPct) {
      reject(
        s,
        "no_momentum",
        `change ${s.changeWindowPct.toFixed(2)}% < ${m.minPct}%`,
      );
      continue;
    }

    const spike =
      s.volumeAvgUsd > 0
        ? s.volumeWindowUsd / s.volumeAvgUsd
        : 0;
    if (spike < m.volumeSpikeMult) {
      reject(
        s,
        "no_volume_spike",
        `spike ${spike.toFixed(2)}x < ${m.volumeSpikeMult}x`,
      );
      continue;
    }

    signals.push({
      mint: s.mint,
      symbol: s.symbol,
      priceUsd: s.priceUsd,
      reason: `momentum ${s.changeWindowPct.toFixed(2)}% / volSpike ${spike.toFixed(2)}x`,
    });
  }

  // Prefer strongest % change first.
  signals.sort((a, b) => {
    const sa = snaps.find((x) => x.mint === a.mint)?.changeWindowPct ?? 0;
    const sb = snaps.find((x) => x.mint === b.mint)?.changeWindowPct ?? 0;
    return sb - sa;
  });

  return { signals, rejects };
}

/**
 * Update high-water / trail arming, then decide stop, hard TP, time-stop, or trailing TP.
 *
 * Hard take-profit (defaults):
 *   - TAKE_PROFIT_PCT = 25  (exit when unrealized ≥ +25%; 0 disables)
 * Trailing TP (defaults):
 *   - TRAIL_ACTIVATE_PCT = 15  (arm after +15% from entry)
 *   - TRAIL_DISTANCE_PCT = 5   (exit if price falls 5% from HWM once armed)
 * Hard stop:
 *   - STOP_LOSS_PCT = 10
 * Time stop:
 *   - MAX_HOLD_MINUTES = 20 (0 disables)
 */
export function evaluateExit(
  position: Position,
  markPrice: number,
  cfg: BotConfig,
  nowMs: number = Date.now(),
): { position: Position; exit: ExitSignal | null } {
  const updated: Position = { ...position };

  if (markPrice > updated.highWaterPrice) {
    updated.highWaterPrice = markPrice;
  }

  const gainPct =
    ((markPrice - updated.entryPrice) / updated.entryPrice) * 100;

  if (!updated.trailArmed && gainPct >= cfg.trailingTakeProfit.activatePct) {
    updated.trailArmed = true;
  }

  // Hard stop — always checked.
  const stopPrice =
    updated.entryPrice * (1 - cfg.stopLossPct / 100);
  if (markPrice <= stopPrice) {
    return {
      position: updated,
      exit: {
        positionId: updated.id,
        reason: "stop_loss",
        markPrice,
      },
    };
  }

  // Hard take-profit (fixed % gain). 0 disables.
  if (isTakeProfitHit(updated, markPrice, cfg.takeProfitPct)) {
    return {
      position: updated,
      exit: {
        positionId: updated.id,
        reason: "take_profit",
        markPrice,
      },
    };
  }

  // Hard time stop (paper).
  if (isMaxHoldExceeded(updated, nowMs, cfg.maxHoldMinutes)) {
    return {
      position: updated,
      exit: {
        positionId: updated.id,
        reason: "time_stop",
        markPrice,
      },
    };
  }

  // Trailing take-profit once armed.
  if (updated.trailArmed) {
    const trailFloor =
      updated.highWaterPrice *
      (1 - cfg.trailingTakeProfit.distancePct / 100);
    if (markPrice <= trailFloor) {
      return {
        position: updated,
        exit: {
          positionId: updated.id,
          reason: "trailing_take_profit",
          markPrice,
        },
      };
    }
  }

  return { position: updated, exit: null };
}
