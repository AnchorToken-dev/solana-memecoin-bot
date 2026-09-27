import type {
  BotConfig,
  ExitReason,
  Position,
  TokenSnapshot,
} from "../types.js";

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

/**
 * Momentum entry: short-window % change + volume spike + liquidity floor.
 *
 * Defaults (overridable via env / config):
 *   - MOMENTUM_MIN_PCT = 8          (% over ~5m window)
 *   - VOLUME_SPIKE_MULT = 2.0       (window vol vs avg)
 *   - MIN_LIQUIDITY_USD = 15000
 *   - MIN_VOLUME_24H_USD = 25000
 */
export function evaluateEntries(
  snaps: TokenSnapshot[],
  cfg: BotConfig,
  openMints: Set<string>,
): EntrySignal[] {
  const m = cfg.momentum;
  const signals: EntrySignal[] = [];

  for (const s of snaps) {
    if (openMints.has(s.mint)) continue;
    if (s.liquidityUsd < m.minLiquidityUsd) continue;
    if (s.volume24hUsd < m.minVolume24hUsd) continue;
    if (s.changeWindowPct < m.minPct) continue;

    const spike =
      s.volumeAvgUsd > 0
        ? s.volumeWindowUsd / s.volumeAvgUsd
        : 0;
    if (spike < m.volumeSpikeMult) continue;

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

  return signals;
}

/**
 * Update high-water / trail arming, then decide stop or trailing TP exit.
 *
 * Trailing TP (defaults):
 *   - TRAIL_ACTIVATE_PCT = 15  (arm after +15% from entry)
 *   - TRAIL_DISTANCE_PCT = 5   (exit if price falls 5% from HWM once armed)
 * Hard stop:
 *   - STOP_LOSS_PCT = 10       (exit if mark <= entry * (1 - 0.10))
 */
export function evaluateExit(
  position: Position,
  markPrice: number,
  cfg: BotConfig,
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
