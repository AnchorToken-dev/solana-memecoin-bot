import type { BotConfig, Position } from "../types.js";
import { checkEntryCash, type EntryFundsCheck } from "./entryFunds.js";

export interface SizeRequest {
  cashUsd: number;
  markPrice: number;
  openCount: number;
  /**
   * Selected trade size (tradeSize.effectiveUsd). When set, the entry is
   * exactly this size or it is refused — never shrunk to fit cash or a cap.
   */
  targetUsd?: number;
  /** Costs charged on top of the size by the active cost model (USD). */
  extraCostsUsd?: number;
}

export interface SizeResult {
  ok: boolean;
  notionalUsd: number;
  qty: number;
  reason?: string;
  /** Set when a fixed-size entry was refused for lack of cash / an over-cap size. */
  funds?: Extract<EntryFundsCheck, { ok: false }>;
}

/**
 * Risk gates:
 *  - Never exceed MAX_OPEN_TRADES (default 1)
 *  - With targetUsd (the engine always passes the selected trade size):
 *    size = targetUsd exactly; refused if tradable cash can't cover it plus
 *    costs charged on top, or if it is above maxPositionUsd. Never shrunk.
 *  - Without targetUsd (legacy helper): min(cash * POSITION_SIZE_PCT, maxPositionUsd if >0, cash)
 *  - cashUsd must be TRADABLE only (caller passes ledger.cash after vault skim)
 *  - Refuse zero/negative price
 *  - Refuse new entries when session daily loss cap is hit
 */
export function sizePosition(
  req: SizeRequest,
  cfg: BotConfig,
  sessionRealizedPnlUsd = 0,
): SizeResult {
  if (isDailyLossBreached(sessionRealizedPnlUsd, cfg.dailyLossUsd)) {
    return {
      ok: false,
      notionalUsd: 0,
      qty: 0,
      reason: `daily loss cap hit (realized $${sessionRealizedPnlUsd.toFixed(2)} ≤ −$${cfg.dailyLossUsd})`,
    };
  }
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
  if (req.targetUsd != null) {
    if (!(req.targetUsd > 0)) return { ok: false, notionalUsd: 0, qty: 0, reason: "trade size not set" };
    const funds = checkEntryCash({
      sizeUsd: req.targetUsd,
      cashUsd: req.cashUsd,
      extraCostsUsd: req.extraCostsUsd,
      capUsd: cfg.maxPositionUsd > 0 ? cfg.maxPositionUsd : null,
      capName: "MAX_POSITION_USD",
    });
    if (!funds.ok) return { ok: false, notionalUsd: 0, qty: 0, reason: funds.message, funds };
    return { ok: true, notionalUsd: req.targetUsd, qty: req.targetUsd / req.markPrice };
  }
  if (req.cashUsd <= 0) {
    return {
      ok: false,
      notionalUsd: 0,
      qty: 0,
      reason: "no cash",
    };
  }

  // Tradable cash only — vault is never passed in as cashUsd.
  let notionalUsd = req.cashUsd * cfg.positionSizePct;
  if (cfg.maxPositionUsd > 0) {
    notionalUsd = Math.min(notionalUsd, cfg.maxPositionUsd);
  }
  notionalUsd = Math.min(notionalUsd, req.cashUsd);

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

/**
 * Hard take-profit: unrealized gain ≥ takeProfitPct from entry.
 * takeProfitPct = 0 disables.
 */
export function isTakeProfitHit(
  position: Position,
  markPrice: number,
  takeProfitPct: number,
): boolean {
  if (takeProfitPct <= 0) return false;
  if (position.entryPrice <= 0) return false;
  const gainPct =
    ((markPrice - position.entryPrice) / position.entryPrice) * 100;
  return gainPct >= takeProfitPct;
}

export function canOpenAnother(
  openCount: number,
  cfg: BotConfig,
): boolean {
  return openCount < cfg.maxOpenTrades;
}

/**
 * Session daily loss cap: stop when realized PnL ≤ −dailyLossUsd.
 * dailyLossUsd = 0 disables the gate.
 */
export function isDailyLossBreached(
  realizedPnlUsd: number,
  dailyLossUsd: number,
): boolean {
  if (dailyLossUsd <= 0) return false;
  return realizedPnlUsd <= -dailyLossUsd;
}

/**
 * Hard time stop: position held longer than maxHoldMinutes.
 * maxHoldMinutes = 0 disables.
 */
export function isMaxHoldExceeded(
  position: Position,
  nowMs: number,
  maxHoldMinutes: number,
): boolean {
  if (maxHoldMinutes <= 0) return false;
  const heldMs = nowMs - position.openedAt;
  return heldMs >= maxHoldMinutes * 60_000;
}
