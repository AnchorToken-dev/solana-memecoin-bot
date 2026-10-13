/** Shared domain types for the paper momentum bot. */
import type { LiveSettings, TradingMode } from "./live/mode.js";
export type { TradingMode } from "./live/mode.js";
import type { FeeBreakdown, PaperFeeSettings, PaperVenue } from "./broker/paperFees.js";
export type { FeeBreakdown, PaperFeeSettings, PaperVenue } from "./broker/paperFees.js";

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
  /**
   * Flat slippage per side (bps). Realistic model: used only when pool
   * liquidity is unknown or PAPER_SLIPPAGE_MODEL=flat. Legacy model: always.
   */
  slippageBps: number;
  /** Legacy flat fee per side (bps). Ignored by the realistic model. */
  feeBps: number;
  /**
   * Itemised cost model (pump.fun fee, PumpPortal, network, rent, slippage).
   * loadConfig always sets it (realistic by default). Absent = legacy flat
   * fee/slippage (keeps old fixtures exact).
   */
  fees?: PaperFeeSettings;
  /**
   * Paper skips coins LIVE can't buy (non-SOL pairs, PumpSwap pools under the
   * thin-pool floor) and cools those coins down like live. Env
   * PAPER_SKIP_UNBUYABLE (default on). Absent = off (old fixtures unchanged).
   */
  skipUnbuyable?: boolean;
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
  /**
   * True when SOLANA_RPC_WSS_URL is set. URL never stored here.
   * Optional listen-only WebSocket; paper stays HTTPS-first when unset.
   */
  solanaRpcWssConfigured?: boolean;
  /**
   * Pre-buy rug filter. Default false — paper entries behave exactly as today.
   * When true and no read-only RPC is configured, that buy is skipped.
   * Optional on the type so older fixtures compile; loadConfig sets it.
   */
  rugFilterEnabled?: boolean;
  /** Reject when the top non-curve holder is above this % of supply. Default 30. */
  rugFilterMaxTopHolderPct?: number;
  /**
   * Reject when more than this many other txs share the mint's creation slot.
   * Default 3. Exactly this many is allowed.
   */
  rugFilterMaxSameSlotBuys?: number;
  /** Graduated (PumpSwap) coins: skip when the pool vault holds less than this % of supply. Default 10. */
  rugFilterGradMinPoolPct?: number;
  /** Graduated coins: skip when one non-pool wallet holds more than this % of supply. Default 10. */
  rugFilterGradMaxHolderPct?: number;
  /** Graduated coins: skip when the top 10 non-pool wallets hold more than this % together. Default 35. */
  rugFilterGradMaxTop10Pct?: number;
  /** A failed rug verdict sticks to the mint for this many minutes. Default 60. */
  rugFilterFailCooldownMinutes?: number;
  /**
   * While holding, read the coin's bonding curve / PumpSwap pool on-chain this
   * often (ms) and run TP / trailing / stop on it. 0 = off. Default 1000.
   */
  fastExitPollMs?: number;
  /**
   * Extra entry filters from the Oct 9 live review (buying the top). All off
   * by default (0 = off). Optional so older fixtures compile.
   */
  entryGuard?: EntryGuardParams;
  /**
   * Early-warning exits on the fast on-chain mark (Oct 9 review). All off by
   * default (0 = off). Optional so older fixtures compile.
   */
  earlyExit?: EarlyExitParams;
  /** Entry price sanity check vs a fresh on-chain read (Oct 11 Nike). Optional so older fixtures compile. */
  entryPriceCheck?: EntryPriceCheckParams;
  /** Per-coin re-entry cooldown after any exit (persisted). Optional so older fixtures compile. */
  reentryCooldown?: ReentryCooldownParams;
  /** Price-history tape for the memory feature (JSONL per day). Optional so older fixtures compile. */
  priceTape?: PriceTapeParams;
  /** Follow skipped coins on-chain for a few minutes (src/journal/shadowTape.ts). */
  shadowTape?: import("./journal/shadowTape.js").ShadowTapeParams;
  /** Skip when similar trades' typical move < round-trip costs (src/strategy/costGate.ts). Default off. */
  costGate?: import("./strategy/costGate.js").CostGateParams;
  /** Paper only: also price every trade at this size, log to size-compare.jsonl (0 = off). */
  sizeCompareUsd?: number;
  /** Optional pullback entry (src/strategy/pullback.ts), paper only. Absent / pct 0 = off. */
  pullbackEntry?: import("./strategy/pullback.js").PullbackParams;
  /** Trailing take-profit never sells below break-even (Oct 12 review). Optional so older fixtures compile. */
  trailBreakeven?: TrailBreakevenParams;
  /** Entry memory score (src/strategy/memory.ts). Optional so older fixtures compile. */
  memory?: MemoryParams;
  /**
   * Resolved trading mode. Absent / "paper" = today's behaviour.
   * Set by loadConfig from the live gates (see src/live/mode.ts).
   */
  tradingMode?: TradingMode;
  /** Live hard caps (env only, never PATCH-able). Present only in live modes. */
  live?: LiveSettings;
  /**
   * HARD daily loss limit for paper / dry-run / live (ET day, realized + unrealized).
   * Always within (0, 300]; loadConfig / PATCH clamp anything else to 300.
   */
  hardDailyLossUsd?: number;
  /** Clamp warnings from env/config/overlay/PATCH. */
  hardDailyLossWarnings?: string[];
}

/** Entry filters (0 = off). See src/strategy/entryGuard.ts. */
export interface EntryGuardParams {
  /** Skip when the window % change (5m) is above this. ENTRY_MAX_RUNUP_PCT. */
  maxRunupPct: number;
  /**
   * Skip coins younger than this many minutes. Uses createdAt; when unknown,
   * treats "nearly all 24h volume happened inside the window" as brand new.
   * ENTRY_MIN_COIN_AGE_MINUTES. Independent of momentum.minAgeMinutes, which
   * the sniper preset sets to 0.
   */
  minCoinAgeMinutes: number;
  /**
   * Skip when the window volume is at least this % of 24h volume (the coin
   * basically only exists since the window started). ENTRY_MAX_WINDOW_VOLUME_SHARE_PCT.
   */
  maxWindowVolumeSharePct: number;
  /**
   * Skip when the price is this % or more below the highest price the bot
   * saw for the coin in the last pullbackWindowSec (momentum fading).
   * ENTRY_MAX_PULLBACK_PCT.
   */
  maxPullbackPct: number;
  /** ENTRY_PULLBACK_WINDOW_SEC (default 120). */
  pullbackWindowSec: number;
  /** Skip after this many lower scan prices in a row ("red candles"). ENTRY_MAX_DOWN_TICKS. */
  maxDownTicks: number;
}

/** Trailing floor at break-even + a little (src/strategy/momentum.ts). */
export interface TrailBreakevenParams {
  /** TRAIL_BREAKEVEN_FLOOR (default true). */
  enabled: boolean;
  /** Estimated sell-side cost %, used for the break-even price. TRAIL_EXIT_FEE_PCT (default 2). */
  exitFeePct: number;
  /** Floor sits this % above break-even. TRAIL_MIN_PROFIT_PCT (default 1). */
  minProfitPct: number;
}

/** Entry memory score (src/strategy/memory.ts). */
export interface MemoryParams {
  /** MEMORY_ENABLED (default true). */
  enabled: boolean;
  /** No skipping until this many closed trades are remembered. MEMORY_MIN_TRADES (default 40). */
  minTrades: number;
  /** Similar past trades to compare. MEMORY_NEIGHBORS (default 15). */
  neighbors: number;
  /** Skip when those trades averaged this % of trade size or worse. MEMORY_SKIP_AVG_PNL_PCT (default -8). */
  skipAvgPnlPct: number;
  /** MEMORY_MAX_TRADES (default 2000, oldest dropped). */
  maxTrades: number;
}

/** Entry price sanity check (src/risk/entryPriceCheck.ts). */
export interface EntryPriceCheckParams {
  /** ENTRY_PRICE_CHECK (default true). */
  enabled: boolean;
  /** Skip when quote and on-chain differ by more than this %. ENTRY_PRICE_MAX_GAP_PCT (default 25). */
  maxGapPct: number;
  /** After a mismatch / failed read, skip the coin this long. ENTRY_PRICE_MISMATCH_SKIP_MINUTES (default 10). */
  mismatchSkipMinutes: number;
  /** Paper + dry-run: fill at the on-chain price, not the scan quote. PAPER_FILL_AT_ONCHAIN (default true). */
  fillAtOnchain: boolean;
}

/** Re-entry cooldown (src/risk/reentryCooldown.ts). 0 = off. */
export interface ReentryCooldownParams {
  /** After any exit. REENTRY_COOLDOWN_MINUTES (default 30). */
  minutes: number;
  /** After a stop-loss / early exit / any losing exit. REENTRY_COOLDOWN_AFTER_LOSS_MINUTES (default 120). */
  afterLossMinutes: number;
}

/** Price tape (src/journal/priceTape.ts). */
export interface PriceTapeParams {
  /** PRICE_TAPE (default true). */
  enabled: boolean;
  /** Keep reading this long after an exit. PRICE_TAPE_POST_EXIT_SECONDS (default 180, 0 = off). */
  postExitSeconds: number;
  /** PRICE_TAPE_POST_EXIT_INTERVAL_MS (default 5000). */
  postExitIntervalMs: number;
  /** Fetch ~10 min of 1m candles from GeckoTerminal at entry (async). PRICE_TAPE_PRE_CANDLES (default true). */
  preCandles: boolean;
}

/** Early-warning exits (0 = off). See src/strategy/earlyExit.ts. */
export interface EarlyExitParams {
  /** Sell when the on-chain mark falls this % within fastDropWindowMs. EXIT_FAST_DROP_PCT. */
  fastDropPct: number;
  /** EXIT_FAST_DROP_WINDOW_MS (default 3000). */
  fastDropWindowMs: number;
  /** Sell after this many lower on-chain reads in a row... EXIT_RED_TICKS. */
  redTicks: number;
  /** ...that add up to at least this % drop. EXIT_RED_TICKS_MIN_DROP_PCT (default 3). */
  redTicksMinDropPct: number;
  /** Once up this % from entry, arm the giveback exit. EXIT_GIVEBACK_ARM_PCT. */
  givebackArmPct: number;
  /** Sell when this % of the peak gain is given back. EXIT_GIVEBACK_PCT (default 50). */
  givebackPct: number;
  /** Sell when no new high for this many seconds and below entry. EXIT_STALL_SECONDS. */
  stallSeconds: number;
  /** Sell when the pool/curve SOL reserve falls this % between two on-chain reads. EXIT_RESERVE_DROP_PCT. */
  reserveDropPct?: number;
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
  /**
   * Pump.fun coin `creator`, when the list/lookup payload already includes it.
   * Not used to fetch that wallet's other coins (no such source in this bot).
   */
  creator?: string;
  /** Pump.fun `bonding_curve` account, when the payload already includes it. */
  bondingCurve?: string;
  /** Pump.fun `associated_bonding_curve` token account, when present. */
  associatedBondingCurve?: string;
  /**
   * bonding_curve = still on pump.fun's curve; pumpswap = graduated.
   * From Pump.fun `complete` or DexScreener dexId. Absent = unknown.
   */
  venue?: PaperVenue;
  /**
   * Token the coin is paired with (Pump.fun `quote_mint`). SOL coins report
   * the System Program id. A non-SOL pair (PUMP, USDC, tokenized stock) can't
   * be bought with a SOL PumpPortal tx. Absent = unknown.
   */
  quoteMint?: string;
  /**
   * Real SOL in the coin's PumpSwap pool, from DexScreener `liquidity.quote`
   * (already fetched by Dex enrich — no extra request). Only set for a
   * SOL-quoted pumpswap pair. Absent = unknown.
   */
  poolQuoteSol?: number;
}

export type Side = "buy" | "sell";
export type ExitReason =
  | "stop_loss"
  | "take_profit"
  | "trailing_take_profit"
  | "time_stop"
  | "manual_exit"
  | "risk_flat"
  /** Restored position whose tokens were no longer in the wallet at live start (no sell attempted). */
  | "reconciled_missing"
  /** Early-warning exits (src/strategy/earlyExit.ts). */
  | "early_fast_drop"
  | "early_red_ticks"
  | "early_giveback"
  | "early_stall"
  | "early_reserve_drop";

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
  /** Hot-button trade size selected when this position was bought. */
  tradeSizeUsd?: number;
  /** Paper cost model: venue + pool liquidity seen at entry (for exit fees/slippage). */
  venue?: PaperVenue;
  entryLiquidityUsd?: number;
  /** Paper cost model: itemised buy-side costs. */
  entryFeeBreakdown?: FeeBreakdown;
  /** On-chain signature of the buy (live sends only; null in paper / dry-run). */
  entrySignature?: string | null;
  /** Mode the position was opened in. */
  mode?: TradingMode;
  /**
   * Set when live startup reconciliation adopted wallet tokens the bot had
   * bought (by signature) but no longer tracked, e.g. after a crash/restart.
   */
  adopted?: {
    at: number;
    /** Where the entry price came from. */
    entrySource: "live_buy_fill" | "unconfirmed_buy_mark";
    note: string;
  };
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
  /** true for paper fills; false for live / live dry-run fills. */
  paper: boolean;
  /** Absent on old rows = paper. */
  mode?: TradingMode;
  /** On-chain tx signature (live sends only). */
  signature?: string | null;
  /** Itemised paper costs for this fill (realistic paper model only). */
  feeBreakdown?: FeeBreakdown;
  /** Sells: the mark that triggered the exit decision (fill price can differ). */
  decisionMarkPrice?: number;
  /**
   * Sells: plain-English warning when the fill doesn't match the exit label,
   * e.g. a take_profit decision that filled at a loss because the price
   * collapsed before the sell landed.
   */
  exitWarning?: string;
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
  | "no_volume_spike"
  /** Entry guard (src/strategy/entryGuard.ts). */
  | "run_too_far"
  | "price_mismatch"
  | "reentry_cooldown"
  | "brand_new"
  | "fading";

export interface EntryReject {
  mint: string;
  symbol: string;
  reason: EntryRejectReason;
  detail: string;
}
