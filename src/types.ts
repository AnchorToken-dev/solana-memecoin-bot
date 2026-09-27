/** Shared domain types for the paper momentum bot. */

export interface MomentumParams {
  minPct: number;
  windowMinutes: number;
  volumeSpikeMult: number;
  minLiquidityUsd: number;
  minVolume24hUsd: number;
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

export interface BotConfig {
  paperMode: boolean;
  bankrollUsd: number;
  maxOpenTrades: number;
  stopLossPct: number;
  positionSizePct: number;
  momentum: MomentumParams;
  trailingTakeProfit: TrailingTakeProfitParams;
  paperBroker: PaperBrokerParams;
  runner: RunnerParams;
  marketDataSource: "mock" | "dexscreener";
  ledgerDir: string;
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
}

export type Side = "buy" | "sell";
export type ExitReason =
  | "stop_loss"
  | "trailing_take_profit"
  | "manual"
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
  cashUsd: number;
  equityUsd: number;
  openPositions: Position[];
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  tradeCount: number;
}
