import type { BotConfig, Position } from "../types.js";

export interface SizeRequest {
  cashUsd: number;
  markPrice: number;
  openCount: number;
}

export interface SizeResult {
  ok: boolean;
  notionalUsd: number;
  qty: number;
  reason?: string;
}

/**
 * Risk gates:
 *  - Never exceed MAX_OPEN_TRADES (default 1)
 *  - Size = cash * POSITION_SIZE_PCT (default 0.95)
 *  - Refuse zero/negative price
 */
export function sizePosition(
  req: SizeRequest,
  cfg: BotConfig,
): SizeResult {
  if (req.openCount >= cfg.maxOpenTrades) {
    return {
      ok: false,
      notionalUsd: 0,
      qty: 0,
      reason: `max open trades reached (${cfg.maxOpenTrades})`,
    };
  }
  if (req.markPrice <= 0) {
    return {
      ok: false,
      notionalUsd: 0,
      qty: 0,
      reason: "invalid mark price",
    };
  }
  if (req.cashUsd <= 0) {
    return {
      ok: false,
      notionalUsd: 0,
      qty: 0,
      reason: "no cash",
    };
  }

  const notionalUsd = req.cashUsd * cfg.positionSizePct;
  if (notionalUsd < 1) {
    return {
      ok: false,
      notionalUsd: 0,
      qty: 0,
      reason: "notional below $1 dust floor",
    };
  }

  const qty = notionalUsd / req.markPrice;
  return { ok: true, notionalUsd, qty };
}

/** True when mark has breached the hard stop vs entry. */
export function isStopLossHit(
  position: Position,
  markPrice: number,
  stopLossPct: number,
): boolean {
  const stopPrice = position.entryPrice * (1 - stopLossPct / 100);
  return markPrice <= stopPrice;
}

export function canOpenAnother(
  openCount: number,
  cfg: BotConfig,
): boolean {
  return openCount < cfg.maxOpenTrades;
}
