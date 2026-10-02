/** Shared domain types for the paper momentum bot. */

export interface MomentumParams {
  minPct: number;
  windowMinutes: number;
  volumeSpikeMult: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
  /**
   * Skip coins younger than this many minutes when `createdAt` is present
   * on the snapshot (Pump.fun `created_timestamp`). 0 = disabled.
   */
  minAgeMinutes: number;
}

export interface TrailingTakeProfitParams {
  /** Activate trail after unrealized gain reaches this % from entry. */
  activatePct: number;
  /** Exit when price drops this % from the high-water mark (after activation). */
  distancePct: number;
}

export interface PaperBrokerParams {
  slippageBps: number;
  feeBps: number;
}

export interface RunnerParams {
  pollIntervalMs: number;
  scanLimit: number;
  /** 0 = run forever; >0 stops after N cycles (useful for demos/tests). */
  maxCycles: number;
}

export type ActivePreset = "momentum" | "sniper" | "custom";

export interface BotConfig {
  paperMode: boolean;
  bankrollUsd: number;
  maxOpenTrades: number;
  stopLossPct: number;
  /**
   * Hard take-profit: exit when unrealized gain ≥ this % from entry.
   * 0 = disabled. Default 25.
   */
  takeProfitPct: number;
  positionSizePct: number;
  /**
   * Hard USD cap per open paper trade (after positionSizePct).
   * 0 = disabled. Sticky across presets with bankroll / daily loss.
   * Default 25 — sensible for a ~$100 bankroll / one-trade style.
   */
  maxPositionUsd: number;
  momentum: MomentumParams;
  trailingTakeProfit: TrailingTakeProfitParams;
  paperBroker: PaperBrokerParams;
  runner: RunnerParams;
  /**
   * Hard time stop: exit an open paper position after this many minutes.
   * 0 = disabled.
   */
  maxHoldMinutes: number;
  /**
   * Stop the runner when session realized PnL ≤ −this USD amount.
   * 0 = disabled. Measured against session realized PnL (not growing equity).
   */
  dailyLossUsd: number;
  /**
   * Paper chase-lockout cool-down hours after a FULL loss of the original
   * deposit/bankroll (cfg.bankrollUsd), not peak equity. Default 12.
   * 0 = disabled. Persisted on laptop/API (data/chase-lockout.json).
   * Reset does NOT clear an active lockout — timer-only unlock.
   */
  chaseLockoutHours: number;
  marketDataSource: "mock" | "dexscreener" | "pumpfun";
  ledgerDir: string;
  /**
   * Named paper preset last applied via API / overlay.
   * `custom` when individual knobs were patched away from a named preset.
   */
  activePreset: ActivePreset;
  /**
   * When true, paper entries require a saved research checklist with verdict GO
   * for that mint. Default false — checklist is advisory only (v1).
   */
  requireChecklistGo: boolean;
  /**
   * True when SOLANA_RPC_URL is set. The URL itself is never stored here
   * (so /config and /status cannot leak it). Unset → paper loop unchanged.
   * Optional on the type so older test fixtures still compile; loadConfig sets it.
   */
  solanaRpcConfigured?: boolean;
}

export interface TokenSnapshot {
  mint: string;
  symbol: string;
  name: string;
  priceUsd: number;
  /** % price change over the momentum window (e.g. 5m). */
  changeWindowPct: number;
  volumeWindowUsd: number;
  volumeAvgUsd: number;
  volume24hUsd: number;
  liquidityUsd: number;
  timestamp: number;
  /**
   * Token / pair creation time in epoch ms, when known
   * (Pump.fun `created_timestamp`, DexScreener `pairCreatedAt`).
   */
  createdAt?: number;
}

export type Side = "buy" | "sell";
export type ExitReason =
  | "stop_loss"
  | "take_profit"
  | "trailing_take_profit"
  | "time_stop"
  | "manual_exit"
  | "risk_flat";

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  side: "long";
  qty: number;
  entryPrice: number;
  entryNotionalUsd: number;
  entryFeesUsd: number;
  highWaterPrice: number;
  trailArmed: boolean;
  openedAt: number;
}

export interface Fill {
  id: string;
  positionId: string;
  mint: string;
  symbol: string;
  side: Side;
  qty: number;
  price: number;
  notionalUsd: number;
  feesUsd: number;
  slippageUsd: number;
  reason?: ExitReason;
  timestamp: number;
  paper: true;
}

export interface TradeRecord {
  fill: Fill;
  realizedPnlUsd?: number;
  cashAfter: number;
}

export interface PortfolioSnapshot {
  /** Tradable cash (not in vault). Sizing uses this only. */
  cashUsd: number;
  /** Alias of cashUsd — funds available to size new entries. */
  tradableCashUsd: number;
  /**
   * Skimmed / vaulted USD locked out of sizing.
   * Survives /runner/reset (like journal); not cleared with the session ledger.
   */
  vaultUsd: number;
  /** Mark-to-market of cash + open positions (excludes vault). */
  equityUsd: number;
  /** equityUsd + vaultUsd — total paper wealth. */
  totalEquityUsd: number;
  openPositions: Position[];
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  tradeCount: number;
}

/** Why a scanned token was not taken as an entry. */
export type EntryRejectReason =
  | "already_open"
  | "too_new"
  | "low_liquidity"
  | "low_volume_24h"
  | "no_momentum"
  | "no_volume_spike";

export interface EntryReject {
  mint: string;
  symbol: string;
  reason: EntryRejectReason;
  detail: string;
}
