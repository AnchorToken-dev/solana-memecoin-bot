/**
 * Controllable paper bot engine — start/stop from CLI or HTTP control API.
 * Live trading remains stubbed; start() refuses unless PAPER_MODE=true.
 */
import type { BotConfig, Fill, PortfolioSnapshot, Position, TokenSnapshot, TradeRecord } from "../types.js";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSolanaMintInput } from "../target/solanaMint.js";
import type { MarketDataProvider } from "../market/data.js";
import { createMarketData } from "../market/data.js";
import { IN_POSITION_POLL_INTERVAL_MS } from "../market/http.js";
import { PaperBroker } from "../broker/paper.js";
import { PaperLedger } from "../ledger/ledger.js";
import { evaluateEntries, evaluateExit } from "../strategy/momentum.js";
import {
  sizePosition,
  canOpenAnother,
  isDailyLossBreached,
  isMaxHoldExceeded,
} from "../risk/manager.js";
import {
  ChaseLockoutStore,
  type ChaseLockoutStatus,
} from "../risk/chaseLockout.js";
import { log } from "../logging.js";
import {
  applyPaperPatch,
  overlayFromConfig,
  parsePaperConfigPatch,
  saveRuntimeOverlay,
} from "../config.js";
import {
  applyPresetKnobs,
  isPresetName,
  PRESET_NAMES,
  type PresetName,
} from "../presets.js";
import {
  TradeJournal,
  type JournalEntry,
  DEFAULT_QUOTE_ASSET,
  DEFAULT_CHAIN_ID,
} from "../journal/journal.js";
import { quoteUsdRateFromEnv } from "../market/data.js";
import { ResearchChecklistStore } from "../checklist/checklist.js";
import {
  rugFilterInputFromConfig,
  runRugFilter,
  type RugFilterRpc,
} from "../risk/rugFilter.js";
import { ReadOnlySolanaRpc } from "../solana/rpc.js";
import {
  ReadOnlySolanaWs,
  emptySolanaWsStatus,
  type SolanaWsPublicStatus,
} from "../solana/ws.js";
import {
  SessionEventBus,
  exitEventType,
  exitTitle,
} from "../alerts/sessionEvents.js";
import { modeLabel, type TradingMode, type LiveSettings } from "../live/mode.js";
import { LiveBroker } from "../live/liveBroker.js";
import { loadLiveSigner } from "../live/keypair.js";
import { HttpsLiveRpc } from "../live/rpc.js";
import { PumpPortalBuilder } from "../live/pumpportal.js";
import {
  VaultSweeper,
  validateVaultAddress,
  loadVaultSweepSettings,
  LIVE_VAULT_ADDRESS_ENV,
  type VaultSweepStatus,
} from "../live/vaultSweep.js";
import type { LiveSigner } from "../live/keypair.js";
import type { LiveRpc } from "../live/rpc.js";
import { redactSecrets } from "../live/redact.js";
import { startOfDay } from "../journal/timezone.js";
import {
  HardDailyLossStore,
  clampHardDailyLoss,
  type HardDailyLossStatus,
} from "../risk/hardDailyLoss.js";
import {
  TradeSizeStore,
  isTradeSize,
  tradeSizeStatus,
  TRADE_SIZES_USD,
  type TradeSizeStatus,
} from "../risk/tradeSize.js";

const ET_TZ = "America/New_York";

export interface LiveStatus {
  /** Public address only. Never the key or the key file path. */
  walletPublicKey: string | null;
  solBalance: number | null;
  solBalanceAt: number | null;
  dryRun: boolean;
  buysHalted: boolean;
  /** Realized PnL today (ET) for the current live mode. */
  todayRealizedUsd: number;
  dailyLossLimitHit: boolean;
  caps: Pick<LiveSettings, "maxPositionUsd" | "maxOpenPositions" | "dailyLossLimitUsd" | "minSolReserve" | "slippageBps" | "sellMaxSlippageBps" | "priorityFeeSol" | "priorityFeeMaxSol">;
  rugFilterMandatory: true;
  lastLiveError: string | null;
}

export type RunnerState = "stopped" | "starting" | "running" | "stopping";

export interface EngineStatus {
  state: RunnerState;
  paperMode: boolean;
  cycle: number;
  startedAt: number | null;
  stoppedAt: number | null;
  uptimeMs: number;
  lastError: string | null;
  lastCycleAt: number | null;
  /** Ms since last completed tick while running (null if never ticked / not running). */
  cycleAgeMs: number | null;
  marketDataSource: BotConfig["marketDataSource"];
  stopReason: string | null;
  /** Paper chase lockout (laptop/API persisted). Timer-only unlock. */
  chaseLockout: ChaseLockoutStatus;
  /** Pinned contract address, or null when hunting the board. */
  pinnedMint: string | null;
  pinnedSymbol: string | null;
  pinnedName: string | null;
  /**
   * Whether SOLANA_RPC_URL is set. Boolean only — the URL is never returned.
   * False keeps today's pump.fun HTTP paper loop (RPC is not required).
   */
  solanaRpcConfigured: boolean;
  /**
   * Optional read-only WSS listen status. URL never returned.
   * When not configured, connected is false and state is disconnected.
   */
  solanaRpcWss: SolanaWsPublicStatus;
  /** paper | live_dry_run | live */
  tradingMode: TradingMode;
  /** Big on-screen label: "PAPER" | "LIVE DRY-RUN" | "LIVE". */
  modeLabel: "PAPER" | "LIVE DRY-RUN" | "LIVE";
  /** Null in paper mode. */
  live: LiveStatus | null;
  /** Hot-button trade size for NEW buys. */
  tradeSize: TradeSizeStatus;
  /** HARD daily loss limit (cannot be disabled; $300 ceiling). */
  hardDailyLoss: HardDailyLossStatus;
  /** Live vault sweep (null in paper). Address shown masked only. */
  vaultSweep: VaultSweepStatus | null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
  });
}

function summarizeRejects(
  rejects: { reason: string; symbol: string; detail: string }[],
): string {
  const counts = new Map<string, number>();
  for (const r of rejects) {
    counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");
}

export class BotEngine {
  /** Mutable paper config (PATCH / preset when stopped). */
  readonly cfg: BotConfig;
  readonly market: MarketDataProvider;
  readonly broker: PaperBroker;
  readonly ledger: PaperLedger;
  readonly journal: TradeJournal;
  readonly checklist: ResearchChecklistStore;
  readonly events: SessionEventBus;
  /** Persisted chase lockout — lives on laptop/API, survives phone restarts. */
  readonly chaseLockout: ChaseLockoutStore;

  private state: RunnerState = "stopped";
  private cycle = 0;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private lastError: string | null = null;
  private lastCycleAt: number | null = null;
  private stopReason: string | null = null;
  private abort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;
  /** Single-coin pin. Null = normal hunt. Persisted beside the ledger. */
  private pinnedMint: string | null = null;
  private pinnedSymbol: string | null = null;
  private pinnedName: string | null = null;

  /** Where PATCH / preset persist the paper overlay (default data/runtime-config.json). */
  private readonly runtimeConfigPath: string | undefined;
  /** undefined = fromEnv when needed; null = explicitly no RPC. */
  private readonly solanaRpcOverride: RugFilterRpc | null | undefined;
  /** Optional WSS listener. null = not configured / disabled. */
  private readonly solanaWs: ReadOnlySolanaWs | null;
  /** Live broker (live modes only). Built lazily on start() unless injected. */
  private liveBroker: LiveBroker | null;
  /** Kill switch: no new buys; exits keep running. */
  private buysHalted = false;
  private liveSolBalance: number | null = null;
  private liveSolBalanceAt: number | null = null;
  private lastLiveError: string | null = null;
  private readonly sellFailAlerted = new Set<string>();
  readonly tradeSizeStore: TradeSizeStore;
  readonly hardLossStore: HardDailyLossStore;
  /** Last seen marks for open positions (unrealized loss for the hard limit). */
  private readonly lastMarks = new Map<string, number>();
  private vaultSweeper: VaultSweeper | null = null;
  /** Invalid LIVE_VAULT_ADDRESS → refuse to start live. */
  private vaultError: string | null = null;
  private vaultWarning: string | null = null;
  private lastVaultCheckAt = 0;

  constructor(
    cfg: BotConfig,
    deps?: {
      market?: MarketDataProvider;
      broker?: PaperBroker;
      ledger?: PaperLedger;
      journal?: TradeJournal;
      checklist?: ResearchChecklistStore;
      events?: SessionEventBus;
      chaseLockout?: ChaseLockoutStore;
      /** Absolute or relative path for runtime-config.json persistence. */
      runtimeConfigPath?: string;
      /**
       * Read-only RPC for the rug filter.
       * undefined = use SOLANA_RPC_URL when the filter is on.
       * null = no RPC (filter-on skips the buy).
       */
      solanaRpc?: RugFilterRpc | null;
      /**
       * Optional read-only WSS listener.
       * undefined = ReadOnlySolanaWs.fromEnv() when SOLANA_RPC_WSS_URL is set.
       * null = force no WSS (tests).
       */
      solanaWs?: ReadOnlySolanaWs | null;
      /** Live broker for tests. Ignored in paper mode. */
      liveBroker?: LiveBroker | null;
      /** Hard daily loss store (tests inject a clock). */
      hardLossStore?: HardDailyLossStore;
      /** Live vault sweep wiring for tests (signer + rpc; destination still from env). */
      vaultDeps?: { signer: LiveSigner; rpc: LiveRpc; env?: Record<string, string | undefined>; sleep?: (ms: number) => Promise<void> };
    },
  ) {
    this.cfg = cfg;
    this.market = deps?.market ?? createMarketData(cfg);
    this.broker = deps?.broker ?? new PaperBroker(cfg);
    // Live keeps its own session ledger so paper numbers never mix with real ones.
    this.ledger =
      deps?.ledger ??
      new PaperLedger(
        cfg.bankrollUsd,
        this.isLiveMode(cfg) ? join(cfg.ledgerDir, "live") : cfg.ledgerDir,
      );
    this.liveBroker = this.isLiveMode(cfg) ? (deps?.liveBroker ?? null) : null;
    this.tradeSizeStore = new TradeSizeStore(cfg.ledgerDir);
    this.hardLossStore = deps?.hardLossStore ?? new HardDailyLossStore(cfg.ledgerDir);
    if (this.isLiveMode(cfg) && deps?.vaultDeps) {
      const r = this.setupVault(deps.vaultDeps.signer, deps.vaultDeps.rpc, deps.vaultDeps.env ?? process.env, deps.vaultDeps.sleep);
      if (!r.ok) this.vaultError = r.message;
    }
    this.journal =
      deps?.journal ?? new TradeJournal(cfg.ledgerDir);
    this.checklist =
      deps?.checklist ?? new ResearchChecklistStore(cfg.ledgerDir);
    this.events = deps?.events ?? new SessionEventBus();
    this.chaseLockout =
      deps?.chaseLockout ?? new ChaseLockoutStore(cfg.ledgerDir);
    this.runtimeConfigPath = deps?.runtimeConfigPath;
    this.solanaRpcOverride = deps?.solanaRpc;
    if (deps?.solanaWs !== undefined) {
      this.solanaWs = deps.solanaWs;
    } else if (this.cfg.solanaRpcWssConfigured === true) {
      this.solanaWs = ReadOnlySolanaWs.fromEnv();
    } else {
      this.solanaWs = null;
    }
    this.loadPinnedMint();
    // Optional listen-only WSS. Fail-soft: never blocks paper/HTTPS paths.
    if (this.solanaWs) {
      try {
        this.solanaWs.start();
        if (this.pinnedMint) {
          void this.solanaWs.ensureAccountSubscription(this.pinnedMint);
        }
      } catch (err) {
        log.warn("Solana WSS start failed (paper continues on HTTPS)", err);
      }
    }
    // Backfill mint/CA on old journal rows from in-memory session fills
    // (disk trades.json already applied inside TradeJournal constructor).
    const sessionFills = this.ledger.getTrades(10_000).map((t) => t.fill);
    if (sessionFills.length > 0) {
      this.journal.backfillMissingMints(sessionFills);
    }
  }

  getStatus(): EngineStatus {
    const now = Date.now();
    return {
      state: this.state,
      paperMode: this.cfg.paperMode,
      cycle: this.cycle,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      uptimeMs:
        this.startedAt != null && this.state === "running"
          ? now - this.startedAt
          : this.startedAt != null && this.stoppedAt != null
            ? this.stoppedAt - this.startedAt
            : 0,
      lastError: this.lastError,
      lastCycleAt: this.lastCycleAt,
      cycleAgeMs:
        this.state === "running" && this.lastCycleAt != null
          ? now - this.lastCycleAt
          : null,
      marketDataSource: this.cfg.marketDataSource,
      stopReason: this.stopReason,
      chaseLockout: this.chaseLockout.getStatus(),
      pinnedMint: this.pinnedMint,
      pinnedSymbol: this.pinnedSymbol,
      pinnedName: this.pinnedName,
      solanaRpcConfigured: this.cfg.solanaRpcConfigured === true,
      solanaRpcWss: this.solanaWs
        ? this.solanaWs.getStatus()
        : emptySolanaWsStatus(),
      tradingMode: this.tradingMode,
      modeLabel: modeLabel(this.tradingMode),
      live: this.liveStatus(),
      tradeSize: this.getTradeSize(),
      hardDailyLoss: this.getHardDailyLoss(),
      vaultSweep: this.getVaultSweepStatus(),
    };
  }

  /**
   * Wire the vault sweeper. Destination comes ONLY from env (LIVE_VAULT_ADDRESS),
   * read here once. There is no other way to set it.
   */
  private setupVault(
    signer: LiveSigner,
    rpc: LiveRpc,
    env: Record<string, string | undefined>,
    sleep?: (ms: number) => Promise<void>,
  ): { ok: true } | { ok: false; message: string } {
    const live = this.cfg.live;
    if (!live) return { ok: true };
    const raw = env[LIVE_VAULT_ADDRESS_ENV];
    if (!raw || !raw.trim()) {
      this.vaultSweeper = null;
      this.vaultWarning = `${LIVE_VAULT_ADDRESS_ENV} not set — vault is bookkeeping only (no SOL is moved)`;
      log.warn(this.vaultWarning);
      return { ok: true };
    }
    const v = validateVaultAddress(raw, signer.publicKey);
    if (!v.ok) return { ok: false, message: `Refusing to start LIVE: ${v.error}` };
    this.vaultSweeper = new VaultSweeper({
      signer,
      rpc,
      destination: { address: v.address, bytes: v.bytes },
      settings: loadVaultSweepSettings(env, live),
      mode: this.tradingMode === "live" ? "live" : "live_dry_run",
      dataDir: join(this.cfg.ledgerDir, "live"),
      sleep,
      onEvent: (kind, title, body, signature) => {
        this.events.push(kind, title, body, { signature });
        try {
          this.journal.appendEvent({ kind, symbol: "SOL", mint: "vault", detail: body, signature });
        } catch {
          /* ignore */
        }
      },
    });
    this.vaultWarning = null;
    return { ok: true };
  }

  getVaultSweepStatus(): VaultSweepStatus | null {
    if (!this.isLiveMode()) return null;
    if (this.vaultSweeper) return this.vaultSweeper.status();
    return {
      configured: false,
      addressMasked: null,
      autoSweep: false,
      minSweepSol: 0,
      owedSol: 0,
      pending: null,
      failedAttempts: 0,
      maxAttempts: 0,
      stuck: false,
      lastError: this.vaultError,
      lastSweep: null,
      warning: this.vaultError ?? this.vaultWarning ?? `${LIVE_VAULT_ADDRESS_ENV} not set — vault is bookkeeping only`,
    };
  }

  /** Phone "Sweep vault now". Takes NO destination — always the env address. */
  async sweepVaultNow(): Promise<{ ok: boolean; message: string; vaultSweep: VaultSweepStatus | null }> {
    if (!this.isLiveMode()) return { ok: false, message: "Vault sweep is live-only (paper vault is bookkeeping)", vaultSweep: null };
    if (!this.vaultSweeper) return { ok: false, message: this.getVaultSweepStatus()?.warning ?? "Vault not configured", vaultSweep: this.getVaultSweepStatus() };
    const r = await this.vaultSweeper.process({ manual: true });
    return { ...r, vaultSweep: this.getVaultSweepStatus() };
  }

  /** Skim (bookkeeping) and, in live with a vault address, queue + auto-sweep that profit as SOL. */
  async skimAndSweep(body: unknown) {
    const result = this.skimToVault(body);
    if (!result.ok || !this.isLiveMode() || !this.vaultSweeper || !result.skimmedUsd) return { ...result, sweep: null };
    const solUsd = await this.resolveQuoteUsdRate();
    if (solUsd == null) {
      return { ...result, sweep: { ok: false, message: "No SOL/USD rate — skim recorded but sweep not queued" } };
    }
    this.vaultSweeper.enqueueUsd(result.skimmedUsd, solUsd);
    const st = this.vaultSweeper.status();
    const sweep = st.autoSweep ? await this.vaultSweeper.process() : { ok: true, message: "Queued; auto-sweep off — use Sweep vault now" };
    return { ...result, sweep, status: this.getStatus() };
  }

  /** Effective hard limit: min(config/env/PATCH value, live cap), always in (0, 300]. */
  hardDailyLossLimit(): { usd: number; warnings: string[] } {
    const base = clampHardDailyLoss(this.cfg.hardDailyLossUsd, "hardDailyLossUsd");
    const warnings = [...(this.cfg.hardDailyLossWarnings ?? []), ...(base.warning ? [base.warning] : [])];
    let usd = base.usd;
    if (this.isLiveMode() && this.cfg.live) {
      const l = clampHardDailyLoss(this.cfg.live.dailyLossLimitUsd, "LIVE_DAILY_LOSS_LIMIT_USD");
      usd = Math.min(usd, l.usd);
      warnings.push(...this.cfg.live.warnings, ...(l.warning ? [l.warning] : []));
    }
    return { usd, warnings: [...new Set(warnings)] };
  }

  private unrealizedLossUsd(): number {
    let loss = 0;
    for (const p of this.ledger.openPositions) {
      const mark = this.lastMarks.get(p.mint);
      if (mark == null || !(mark > 0)) continue;
      const pnl = p.qty * mark - p.entryNotionalUsd;
      if (pnl < 0) loss += -pnl;
    }
    return loss;
  }

  getHardDailyLoss(): HardDailyLossStatus {
    const lim = this.hardDailyLossLimit();
    return this.hardLossStore.status(this.tradingMode, lim.usd, this.unrealizedLossUsd(), lim.warnings);
  }

  /** @returns true when new buys must be blocked (locked now or just hit). */
  private checkHardDailyLoss(): boolean {
    const mode = this.tradingMode;
    if (this.hardLossStore.isLocked(mode)) return true;
    const st = this.getHardDailyLoss();
    if (st.todayLossUsd < st.limitUsd) return false;
    this.hardLossStore.lock(mode, st.todayLossUsd);
    const until = new Date(this.hardLossStore.status(mode, st.limitUsd, 0, []).lockedUntil ?? 0).toLocaleString("en-US", { timeZone: ET_TZ });
    const msg = `HARD DAILY LOSS LIMIT HIT: down $${st.todayLossUsd.toFixed(2)} today (limit $${st.limitUsd}). No new buys until midnight ET (${until}). Open coins are still managed. Reset/restart will NOT clear this.`;
    log.error(msg);
    this.events.push("daily_loss_cap", "🛑 HARD DAILY LOSS LIMIT HIT", msg, {
      todayLossUsd: st.todayLossUsd,
      limitUsd: st.limitUsd,
      hard: true,
    });
    try {
      this.journal.appendEvent({ kind: "hard_daily_loss_lock", symbol: "-", mint: "-", detail: msg });
    } catch {
      /* never block exits */
    }
    return true;
  }

  /** Active cap: LIVE_MAX_POSITION_USD in live/dry-run, MAX_POSITION_USD in paper. */
  getTradeSize(): TradeSizeStatus {
    const cap = this.isLiveMode() && this.cfg.live
      ? { usd: this.cfg.live.maxPositionUsd, source: "LIVE_MAX_POSITION_USD" as const }
      : { usd: this.cfg.maxPositionUsd > 0 ? this.cfg.maxPositionUsd : null, source: "MAX_POSITION_USD" as const };
    return tradeSizeStatus(this.tradeSizeStore.get(), cap);
  }

  /** Set the hot-button size (15/30/60). New buys only; open positions untouched. */
  setTradeSize(usd: unknown): { ok: boolean; status: number; message: string; tradeSize: TradeSizeStatus } {
    if (!isTradeSize(usd)) {
      return { ok: false, status: 400, message: `usd must be one of ${TRADE_SIZES_USD.join(", ")}`, tradeSize: this.getTradeSize() };
    }
    const opt = this.getTradeSize().options.find((o) => o.usd === usd)!;
    if (!opt.enabled) {
      return { ok: false, status: 409, message: `$${usd} not allowed: ${opt.reason}`, tradeSize: this.getTradeSize() };
    }
    this.tradeSizeStore.set(usd);
    log.info(`Trade size set to $${usd} (new buys only)`);
    return { ok: true, status: 200, message: `Trade size $${usd} for new buys`, tradeSize: this.getTradeSize() };
  }

  get tradingMode(): TradingMode {
    return this.isLiveMode(this.cfg) ? this.cfg.tradingMode! : "paper";
  }

  private isLiveMode(cfg: BotConfig = this.cfg): boolean {
    return (
      !cfg.paperMode &&
      (cfg.tradingMode === "live" || cfg.tradingMode === "live_dry_run") &&
      cfg.live != null
    );
  }

  private liveTodayRealized(): number {
    return this.hardLossStore.realizedToday(this.tradingMode);
  }

  private liveDailyLossHit(): boolean {
    return this.hardLossStore.isLocked(this.tradingMode);
  }

  private liveStatus(): LiveStatus | null {
    const live = this.cfg.live;
    if (!this.isLiveMode() || !live) return null;
    return {
      walletPublicKey: this.liveBroker?.publicKey ?? null,
      solBalance: this.liveSolBalance,
      solBalanceAt: this.liveSolBalanceAt,
      dryRun: this.tradingMode === "live_dry_run",
      buysHalted: this.buysHalted,
      todayRealizedUsd: this.liveTodayRealized(),
      dailyLossLimitHit: this.liveDailyLossHit(),
      caps: {
        maxPositionUsd: live.maxPositionUsd,
        maxOpenPositions: live.maxOpenPositions,
        dailyLossLimitUsd: this.hardDailyLossLimit().usd,
        minSolReserve: live.minSolReserve,
        slippageBps: live.slippageBps,
        sellMaxSlippageBps: live.sellMaxSlippageBps,
        priorityFeeSol: live.priorityFeeSol,
        priorityFeeMaxSol: live.priorityFeeMaxSol,
      },
      rugFilterMandatory: true,
      lastLiveError: this.lastLiveError,
    };
  }

  /** Build the live broker from env (keypair file + HTTPS RPC). Never logs secrets. */
  private ensureLiveBroker(): { ok: true; broker: LiveBroker } | { ok: false; message: string } {
    if (this.liveBroker) return { ok: true, broker: this.liveBroker };
    const live = this.cfg.live;
    if (!live) return { ok: false, message: "Live settings missing" };
    const signer = loadLiveSigner();
    if (!signer.ok) return { ok: false, message: `Refusing to start LIVE: ${signer.error}` };
    const rpc = HttpsLiveRpc.fromEnv();
    if (!rpc) return { ok: false, message: "Refusing to start LIVE: SOLANA_RPC_URL is not set" };
    this.liveBroker = new LiveBroker({
      signer: signer.signer,
      rpc,
      builder: new PumpPortalBuilder(),
      settings: live,
      mode: this.tradingMode === "live" ? "live" : "live_dry_run",
    });
    const v = this.setupVault(signer.signer, rpc, process.env);
    if (!v.ok) {
      this.liveBroker = null;
      this.vaultError = v.message;
      return { ok: false, message: v.message };
    }
    return { ok: true, broker: this.liveBroker };
  }

  private async refreshLiveBalance(): Promise<void> {
    if (!this.liveBroker) return;
    try {
      this.liveSolBalance = await this.liveBroker.getSolBalance();
      this.liveSolBalanceAt = Date.now();
    } catch (err) {
      this.lastLiveError = redactSecrets(err);
    }
  }

  private async liveSolUsd(): Promise<number | null> {
    return this.resolveQuoteUsdRate();
  }

  /**
   * Close one position through the right broker. Paper = identical to main.
   * Live: on failure the position STAYS open (retried next tick) and we alert loudly.
   */
  private async closePosition(
    pos: Position,
    markPrice: number,
    reason: import("../types.js").ExitReason,
  ): Promise<Fill | null> {
    if (!this.isLiveMode() || !this.liveBroker) {
      // SOL/USD prices the network fees in the realistic paper cost model.
      const solUsd = await this.resolveQuoteUsdRate();
      // That await yields: a concurrent tick / manual exit may have closed it.
      if (!this.ledger.openPositions.some((p) => p.id === pos.id)) return null;
      const { fill, proceedsUsd, realizedPnlUsd } = this.broker.applySell({
        position: pos,
        markPrice,
        reason,
        solUsd,
      });
      this.ledger.recordSell(fill, realizedPnlUsd, proceedsUsd);
      await this.recordJournalClose(pos, fill, realizedPnlUsd);
      return fill;
    }
    const solUsd = await this.liveSolUsd();
    if (solUsd == null) {
      this.liveSellFailed(pos, "no SOL/USD rate — cannot value the sell; will retry");
      return null;
    }
    const res = await this.liveBroker.sell({ position: pos, markPrice, reason, solUsd });
    if (!res.ok) {
      this.liveSellFailed(pos, `${res.attempts} attempt(s): ${res.errors.join(" | ")}`);
      return null;
    }
    this.sellFailAlerted.delete(pos.id);
    this.ledger.recordSell(res.fill, res.realizedPnlUsd, res.proceedsUsd);
    const note = res.notes.length > 0 ? redactSecrets(res.notes.join(" | ")).slice(0, 400) : undefined;
    await this.recordJournalClose(pos, res.fill, res.realizedPnlUsd, note);
    void this.refreshLiveBalance();
    return res.fill;
  }

  private liveSellFailed(pos: Position, detail: string): void {
    const msg = redactSecrets(detail).slice(0, 500);
    this.lastLiveError = `SELL FAILED ${pos.symbol}: ${msg}`;
    log.error(`LIVE SELL FAILED ${pos.symbol} (${pos.mint}) — position still open: ${msg}`);
    // Loud, but not one alert every 3s: once per position until it clears.
    if (!this.sellFailAlerted.has(pos.id)) {
      this.sellFailAlerted.add(pos.id);
      this.events.push(
        "live_sell_failed",
        "⚠️ LIVE SELL FAILED",
        `${pos.symbol}: could not sell after retries. Still holding. Bot keeps retrying — check the wallet. ${msg}`,
        { symbol: pos.symbol, mint: pos.mint, positionId: pos.id },
      );
      try {
        this.journal.appendEvent({ kind: "live_sell_failed", symbol: pos.symbol, mint: pos.mint, detail: msg });
      } catch {
        /* never let journaling break exits */
      }
    }
  }

  /** Absolute path of data/pinned-mint.json (or the ledger dir equivalent). */
  pinnedMintPath(): string {
    return join(this.cfg.ledgerDir, "pinned-mint.json");
  }

  private loadPinnedMint(): void {
    const path = this.pinnedMintPath();
    if (!existsSync(path)) return;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as {
        mint?: unknown;
        symbol?: unknown;
        name?: unknown;
      };
      const parsed = parseSolanaMintInput(raw.mint);
      if (!parsed.ok) {
        log.warn("Ignoring pinned-mint.json — mint is not a Solana address");
        return;
      }
      this.pinnedMint = parsed.mint;
      this.pinnedSymbol =
        typeof raw.symbol === "string" && raw.symbol.trim()
          ? raw.symbol.trim().slice(0, 32)
          : null;
      this.pinnedName =
        typeof raw.name === "string" && raw.name.trim()
          ? raw.name.trim().slice(0, 80)
          : null;
    } catch (err) {
      log.warn("Ignoring unreadable pinned-mint.json", err);
    }
  }

  private savePinnedMint(): void {
    const path = this.pinnedMintPath();
    mkdirSync(dirname(path), { recursive: true });
    if (!this.pinnedMint) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    const body = {
      mint: this.pinnedMint,
      symbol: this.pinnedSymbol,
      name: this.pinnedName,
    };
    writeFileSync(path, JSON.stringify(body, null, 2) + "\n", "utf8");
  }

  /**
   * Pin the bot to one Solana mint. Does not close an open trade on another
   * coin — that position keeps its normal exits. New entries only consider
   * this mint (and only when a slot is free). Risk gates are unchanged.
   * Allowed while the runner is going; paper mode only.
   */
  setPinnedMint(body: unknown): {
    ok: boolean;
    message: string;
    status: EngineStatus;
    mint: string | null;
  } {
    if (!this.cfg.paperMode) {
      return {
        ok: false,
        message:
          "PAPER_MODE only: refusing to pin a coin while live mode is configured (live is stubbed).",
        status: this.getStatus(),
        mint: this.pinnedMint,
      };
    }
    const raw =
      body && typeof body === "object" && "mint" in body
        ? (body as { mint?: unknown }).mint
        : body;
    const parsed = parseSolanaMintInput(raw);
    if (!parsed.ok) {
      return {
        ok: false,
        message: parsed.message,
        status: this.getStatus(),
        mint: this.pinnedMint,
      };
    }
    const changed = parsed.mint !== this.pinnedMint;
    this.pinnedMint = parsed.mint;
    if (changed) {
      this.pinnedSymbol = null;
      this.pinnedName = null;
    }
    this.savePinnedMint();
    const others = this.ledger.openPositions.filter((p) => p.mint !== parsed.mint);
    let message = `Watching this coin only: ${parsed.mint}. Clear it to go back to hunting.`;
    if (others.length > 0) {
      const names = others
        .map((p) => p.symbol || `${p.mint.slice(0, 4)}…`)
        .join(", ");
      message += ` Open trade (${names}) stays open until its own exit — it is not closed because you pinned a new coin. New buys are only this coin, and only when a free slot exists.`;
    }
    message +=
      " Bankroll, max position, daily loss, vault, chase lockout, and exit rules still apply. The coin still has to pass the momentum checks before a buy.";
    log.info("Pinned single coin", { mint: parsed.mint, openOthers: others.length });
    if (this.solanaWs) {
      void this.solanaWs.ensureAccountSubscription(parsed.mint);
    }
    return {
      ok: true,
      message,
      status: this.getStatus(),
      mint: this.pinnedMint,
    };
  }

  /** Clear the pin. Next cycle hunts the board again. Does not close trades. */
  clearPinnedMint(): {
    ok: boolean;
    message: string;
    status: EngineStatus;
    mint: string | null;
  } {
    if (!this.cfg.paperMode) {
      return {
        ok: false,
        message:
          "PAPER_MODE only: refusing to clear the pin while live mode is configured (live is stubbed).",
        status: this.getStatus(),
        mint: this.pinnedMint,
      };
    }
    const had = this.pinnedMint;
    this.pinnedMint = null;
    this.pinnedSymbol = null;
    this.pinnedName = null;
    this.savePinnedMint();
    return {
      ok: true,
      message: had
        ? "Pin cleared. The bot is hunting the board again."
        : "Already hunting. No coin is pinned.",
      status: this.getStatus(),
      mint: null,
    };
  }

  /**
   * Entry universe for this cycle.
   * Pin set → lookup that mint only (no board scan).
   * Pin empty → normal hunt scan.
   */
  async selectEntrySnapshots(): Promise<TokenSnapshot[]> {
    const pin = this.pinnedMint;
    if (!pin) {
      return this.market.scan(this.cfg.runner.scanLimit);
    }
    const lookup = this.market.lookup;
    if (!lookup) {
      log.warn(
        `Pinned ${pin.slice(0, 8)}… but market data has no single-coin lookup; not hunting other coins`,
      );
      return [];
    }
    let snap: TokenSnapshot | null = null;
    try {
      snap = await lookup.call(this.market, pin);
    } catch (err) {
      log.warn(`Pinned mint lookup failed for ${pin.slice(0, 8)}…`, err);
      return [];
    }
    if (!snap || snap.mint !== pin) {
      log.info(
        `Pinned ${pin.slice(0, 8)}…: no quote this cycle (still not hunting other coins)`,
      );
      return [];
    }
    if (
      snap.symbol !== this.pinnedSymbol ||
      (snap.name ?? null) !== this.pinnedName
    ) {
      this.pinnedSymbol = snap.symbol;
      this.pinnedName = snap.name ?? null;
      this.savePinnedMint();
    }
    return [snap];
  }

  /** Public config — BotConfig has no secrets; wallet paths stay out of this object. */
  getPublicConfig(): BotConfig & {
    availablePresets: readonly PresetName[];
  } {
    return {
      ...this.cfg,
      momentum: { ...this.cfg.momentum },
      trailingTakeProfit: { ...this.cfg.trailingTakeProfit },
      paperBroker: { ...this.cfg.paperBroker },
      runner: { ...this.cfg.runner },
      availablePresets: PRESET_NAMES,
    };
  }

  /**
   * Persist current paper knobs to data/runtime-config.json (or injected path).
   */
  persistRuntimeConfig(): string {
    return saveRuntimeOverlay(
      overlayFromConfig(this.cfg),
      this.runtimeConfigPath,
    );
  }

  /**
   * PATCH paper-safe knobs. Requires runner stopped (safest — no mid-cycle drift).
   * Persists to runtime overlay so restart keeps settings.
   */
  patchConfig(body: unknown): {
    ok: boolean;
    message: string;
    status: EngineStatus;
    config?: ReturnType<BotEngine["getPublicConfig"]>;
    rejected?: string[];
  } {
    if (!this.cfg.paperMode) {
      return {
        ok: false,
        message:
          "PAPER_MODE only: refusing config changes while live mode is configured (live is stubbed).",
        status: this.getStatus(),
      };
    }
    if (this.state !== "stopped") {
      return {
        ok: false,
        message:
          "Stop the paper runner before changing settings (POST /runner/stop). Preset/config changes are not applied while running.",
        status: this.getStatus(),
      };
    }
    const parsed = parsePaperConfigPatch(body);
    if (!parsed.ok) {
      return {
        ok: false,
        message: parsed.message,
        status: this.getStatus(),
        rejected: parsed.rejected,
      };
    }
    applyPaperPatch(this.cfg, parsed.patch);
    const path = this.persistRuntimeConfig();
    log.info("Paper config patched + persisted", {
      path,
      activePreset: this.cfg.activePreset,
    });
    return {
      ok: true,
      message: `Config updated and saved to ${path}`,
      status: this.getStatus(),
      config: this.getPublicConfig(),
    };
  }

  /**
   * Apply a named preset (momentum | sniper), persist overlay.
   * Requires runner stopped.
   */
  applyPreset(preset: unknown): {
    ok: boolean;
    message: string;
    status: EngineStatus;
    config?: ReturnType<BotEngine["getPublicConfig"]>;
  } {
    if (!this.cfg.paperMode) {
      return {
        ok: false,
        message:
          "PAPER_MODE only: refusing preset while live mode is configured (live is stubbed).",
        status: this.getStatus(),
      };
    }
    if (this.state !== "stopped") {
      return {
        ok: false,
        message:
          "Stop the paper runner before applying a preset (POST /runner/stop).",
        status: this.getStatus(),
      };
    }
    if (!isPresetName(preset)) {
      return {
        ok: false,
        message: `Unknown preset; use one of: ${PRESET_NAMES.join(", ")}`,
        status: this.getStatus(),
      };
    }
    applyPresetKnobs(this.cfg, preset);
    const path = this.persistRuntimeConfig();
    log.info("Paper preset applied + persisted", {
      preset,
      path,
      bankrollUsd: this.cfg.bankrollUsd,
      dailyLossUsd: this.cfg.dailyLossUsd,
      maxPositionUsd: this.cfg.maxPositionUsd,
    });
    return {
      ok: true,
      message: `Preset "${preset}" applied and saved to ${path} (bankroll $${this.cfg.bankrollUsd} / daily loss $${this.cfg.dailyLossUsd} / max position $${this.cfg.maxPositionUsd} / chase lockout ${this.cfg.chaseLockoutHours}h kept sticky)`,
      status: this.getStatus(),
      config: this.getPublicConfig(),
    };
  }

  async getPortfolio(): Promise<PortfolioSnapshot> {
    const marks = new Map<string, number>();
    for (const p of this.ledger.openPositions) {
      const px = await this.market.getPrice(p.mint);
      if (px != null) {
        marks.set(p.mint, px);
        this.lastMarks.set(p.mint, px);
      }
    }
    return this.ledger.snapshot(marks);
  }

  getTrades(limit = 50): TradeRecord[] {
    return this.ledger.getTrades(limit);
  }

  getLiveEvents() {
    return this.journal.listEvents();
  }

  async getJournal(opts?: { limit?: number; offset?: number; mode?: import("../journal/journal.js").JournalModeFilter }) {
    const estimateQuoteUsdRate = await this.resolveQuoteUsdRate();
    return this.journal.list({
      ...opts,
      estimateQuoteUsdRate,
    });
  }

  updateJournalNote(id: string, note: string) {
    return this.journal.updateNote(id, note);
  }

  clearJournal() {
    return this.journal.clear();
  }

  /**
   * Skim tradable cash into the vault (locked out of sizing).
   * - amountUsd: absolute skim, capped to available cash
   * - percentOfProfit: skim % of max(0, cash − bankrollUsd) — cash profit
   *   above the configured bankroll floor (ignores open-position MTM)
   * PAPER_MODE only. Allowed while running (cash move only; no strategy change).
   */
  skimToVault(body: unknown): {
    ok: boolean;
    message: string;
    status: EngineStatus;
    portfolio?: PortfolioSnapshot;
    skimmedUsd?: number;
  } {
    if (!this.cfg.paperMode && !this.isLiveMode()) {
      return {
        ok: false,
        message:
          "PAPER_MODE only: refusing vault skim while live mode is configured (live is stubbed).",
        status: this.getStatus(),
      };
    }
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      return {
        ok: false,
        message: 'Body must be { "amountUsd": number } or { "percentOfProfit": number }',
        status: this.getStatus(),
      };
    }
    const obj = body as { amountUsd?: unknown; percentOfProfit?: unknown };
    const hasAmount = obj.amountUsd != null;
    const hasPct = obj.percentOfProfit != null;
    if (hasAmount === hasPct) {
      return {
        ok: false,
        message: "Provide exactly one of amountUsd or percentOfProfit",
        status: this.getStatus(),
      };
    }

    let amount = 0;
    if (hasAmount) {
      amount = Number(obj.amountUsd);
      if (!Number.isFinite(amount) || amount <= 0) {
        return {
          ok: false,
          message: "amountUsd must be a positive number",
          status: this.getStatus(),
        };
      }
    } else {
      const pct = Number(obj.percentOfProfit);
      if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
        return {
          ok: false,
          message: "percentOfProfit must be in (0, 100]",
          status: this.getStatus(),
        };
      }
      // Profit above bankroll floor from available cash (not open MTM).
      const profitAboveFloor = Math.max(0, this.ledger.cash - this.cfg.bankrollUsd);
      amount = (profitAboveFloor * pct) / 100;
      if (amount < 0.01) {
        return {
          ok: false,
          message: `No skimable profit above bankroll floor ($${this.cfg.bankrollUsd.toFixed(2)}); cash=$${this.ledger.cash.toFixed(2)}`,
          status: this.getStatus(),
          portfolio: this.ledger.snapshot(new Map()),
        };
      }
    }

    const result = this.ledger.skim(amount);
    const portfolio = this.ledger.snapshot(new Map());
    if (!result.ok) {
      return {
        ok: false,
        message: result.message,
        status: this.getStatus(),
        portfolio,
      };
    }
    return {
      ok: true,
      message: result.message,
      status: this.getStatus(),
      portfolio,
      skimmedUsd: result.skimmedUsd,
    };
  }

  /**
   * Return USD from vault back to tradable cash (paper convenience).
   * PAPER_MODE only.
   */
  returnFromVault(body: unknown): {
    ok: boolean;
    message: string;
    status: EngineStatus;
    portfolio?: PortfolioSnapshot;
    returnedUsd?: number;
  } {
    if (!this.cfg.paperMode) {
      return {
        ok: false,
        message:
          "PAPER_MODE only: refusing vault return while live mode is configured (live is stubbed).",
        status: this.getStatus(),
      };
    }
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      return {
        ok: false,
        message: 'Body must be { "amountUsd": number }',
        status: this.getStatus(),
      };
    }
    const amount = Number((body as { amountUsd?: unknown }).amountUsd);
    if (!Number.isFinite(amount) || amount <= 0) {
      return {
        ok: false,
        message: "amountUsd must be a positive number",
        status: this.getStatus(),
      };
    }
    const result = this.ledger.returnFromVault(amount);
    const portfolio = this.ledger.snapshot(new Map());
    if (!result.ok) {
      return {
        ok: false,
        message: result.message,
        status: this.getStatus(),
        portfolio,
      };
    }
    return {
      ok: true,
      message: result.message,
      status: this.getStatus(),
      portfolio,
      returnedUsd: result.returnedUsd,
    };
  }

  getChecklist(opts?: { limit?: number; offset?: number; mint?: string }) {
    return this.checklist.list(opts);
  }

  getChecklistById(id: string) {
    return this.checklist.getById(id);
  }

  getChecklistTemplate() {
    return this.checklist.template();
  }

  createChecklist(body: unknown) {
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false as const, message: "Body must be a JSON object" };
    }
    return this.checklist.create(body as {
      mint: string;
      symbol?: string;
      link?: string;
      items?: unknown;
      thesis?: string;
      invalidation?: string;
    });
  }

  updateChecklist(id: string, body: unknown) {
    if (body == null || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false as const, message: "Body must be a JSON object" };
    }
    return this.checklist.update(id, body as {
      mint?: string;
      symbol?: string;
      link?: string;
      items?: unknown;
      thesis?: string;
      invalidation?: string;
    });
  }

  clearChecklists() {
    return this.checklist.clear();
  }

  getAlerts(sinceMs = 0, limit = 50) {
    return { events: this.events.since(sinceMs, limit) };
  }

  /** Best-effort SOL/USD (quote asset) for journal dual display. */
  private async resolveQuoteUsdRate(): Promise<number | null> {
    const fromEnv = quoteUsdRateFromEnv();
    if (fromEnv != null) return fromEnv;
    if (typeof this.market.getQuoteUsdRate === "function") {
      try {
        const r = await this.market.getQuoteUsdRate();
        if (r != null && Number.isFinite(r) && r > 0) return r;
      } catch (err) {
        log.warn("getQuoteUsdRate failed; journal may be USD-only", err);
      }
    }
    return null;
  }

  getChaseLockout(): ChaseLockoutStatus {
    return this.chaseLockout.getStatus();
  }

  /**
   * Check ledger vs original deposit (cfg.bankrollUsd) and engage chase lockout
   * when the full original deposit is gone. Paper preview for future live.
   */
  private maybeEngageChaseLockout(): ChaseLockoutStatus {
    return this.chaseLockout.evaluateAndMaybeEngage({
      realizedPnlUsd: this.ledger.realizedPnl,
      cashUsd: this.ledger.cash,
      openCount: this.ledger.openPositions.length,
      originalDepositUsd: this.cfg.bankrollUsd,
      lockoutHours: this.cfg.chaseLockoutHours,
    });
  }

  /** Record a closed paper trade into the learning journal (survives session reset). */
  private async recordJournalClose(
    position: Position,
    fill: Fill,
    realizedPnlUsd: number,
    note?: string,
  ): Promise<JournalEntry> {
    const quoteUsdRate = await this.resolveQuoteUsdRate();
    // Snapshot latest research checklist for this mint (learning link).
    const cl = this.checklist.latestForMint(position.mint);
    const entry = this.journal.appendClose({
      position,
      exitPrice: fill.price,
      pnlUsd: realizedPnlUsd,
      exitReason: fill.reason ?? "unknown",
      fillId: fill.id,
      timestamp: fill.timestamp,
      quoteUsdRate,
      quoteAsset: DEFAULT_QUOTE_ASSET,
      chainId: DEFAULT_CHAIN_ID,
      checklistId: cl?.id ?? null,
      checklistVerdict: cl?.verdict ?? null,
      checklistThesis: cl?.thesis ?? null,
      mode: fill.mode ?? "paper",
      signature: fill.signature ?? null,
      exitFill: fill,
      ...(note ? { note } : {}),
    });
    this.hardLossStore.recordClose(fill.mode ?? "paper", realizedPnlUsd);
    const reason = fill.reason ?? "unknown";
    const pnlSign = realizedPnlUsd >= 0 ? "+" : "";
    const body = `${position.symbol}: ${pnlSign}$${realizedPnlUsd.toFixed(2)} (${pnlSign}${entry.pnlPct.toFixed(1)}%) · ${reason}`;
    // One notification per close: typed exit + PnL in body.
    this.events.push(
      exitEventType(reason),
      exitTitle(reason),
      body,
      {
        symbol: position.symbol,
        mint: position.mint,
        pnlUsd: realizedPnlUsd,
        reason,
        closed: true,
      },
    );
    return entry;
  }

  /**
   * Start the paper runner loop. Only allowed when PAPER_MODE=true.
   * Idempotent if already running.
   * Pass `{ reset: true }` to clear the paper ledger / daily-loss lock first.
   */
  async start(opts?: {
    reset?: boolean;
  }): Promise<{ ok: boolean; message: string; status: EngineStatus }> {
    if (!this.cfg.paperMode && !this.isLiveMode()) {
      return {
        ok: false,
        message:
          "Refusing to start: PAPER_MODE is false but the live gates did not all pass.",
        status: this.getStatus(),
      };
    }
    if (this.isLiveMode()) {
      if (opts?.reset) {
        return { ok: false, message: "Reset is paper-only; refusing to start LIVE with reset", status: this.getStatus() };
      }
      if (this.vaultError) {
        return { ok: false, message: this.vaultError, status: this.getStatus() };
      }
      const b = this.ensureLiveBroker();
      if (!b.ok) {
        this.lastLiveError = b.message;
        return { ok: false, message: b.message, status: this.getStatus() };
      }
      await this.refreshLiveBalance();
    }
    this.buysHalted = false;
    if (opts?.reset) {
      const cleared = await this.reset();
      if (!cleared.ok) {
        return {
          ok: false,
          message: cleared.message,
          status: cleared.status,
        };
      }
    }
    // Chase lockout is laptop/API-side — phone restart / Reset cannot bypass.
    const lock = this.chaseLockout.getStatus();
    if (lock.active) {
      const until =
        lock.unlockAt != null
          ? new Date(lock.unlockAt).toISOString()
          : "unknown";
      return {
        ok: false,
        message: `Chase lockout active until ${until} (full original deposit lost). Reset does not clear this — wait for the timer. Paper preview for future live.`,
        status: this.getStatus(),
      };
    }
    if (this.state === "running" || this.state === "starting") {
      return {
        ok: true,
        message: "Runner already active",
        status: this.getStatus(),
      };
    }
    if (this.state === "stopping" && this.loopPromise) {
      await this.loopPromise.catch(() => undefined);
    }

    this.state = "starting";
    this.lastError = null;
    this.stopReason = null;
    this.abort = new AbortController();
    this.startedAt = Date.now();
    this.stoppedAt = null;
    this.state = "running";
    this.loopPromise = this.runLoop(this.abort.signal).finally(() => {
      this.state = "stopped";
      this.stoppedAt = Date.now();
      this.abort = null;
      this.loopPromise = null;
    });

    const label = modeLabel(this.tradingMode);
    log.info(`${label} runner started via engine`);
    this.events.push(
      "bot_started",
      this.isLiveMode() ? `${label} bot started` : "Paper bot started",
      `Runner running · bankroll $${this.cfg.bankrollUsd.toFixed(2)}`,
      { bankrollUsd: this.cfg.bankrollUsd },
    );
    return {
      ok: true,
      message: this.isLiveMode() ? `${label} runner started` : "Paper runner started",
      status: this.getStatus(),
    };
  }

  /**
   * Live kill switch / sell-all: halt buys immediately, then market-sell every
   * open position (same retry ladder as normal exits).
   */
  async sellAll(): Promise<{ ok: boolean; message: string; status: EngineStatus; portfolio: PortfolioSnapshot; fills?: Fill[] }> {
    this.buysHalted = true;
    if (this.ledger.openPositions.length === 0) {
      return { ok: true, message: "Buys halted. No open positions to sell.", status: this.getStatus(), portfolio: await this.getPortfolio() };
    }
    return this.exitNow();
  }

  async stop(): Promise<{ ok: boolean; message: string; status: EngineStatus }> {
    // LIVE kill switch: halt new buys at once. If coins are still held, keep
    // the loop alive so stops/TP/trail still protect them; it exits by itself
    // once flat. A second stop while halted forces a full stop.
    if (
      this.isLiveMode() &&
      (this.state === "running" || this.state === "starting") &&
      !this.buysHalted &&
      this.ledger.openPositions.length > 0
    ) {
      this.buysHalted = true;
      log.warn("LIVE kill switch: new buys halted; still managing open positions");
      this.events.push(
        "bot_stopped",
        "LIVE buys halted",
        `No new buys. Still managing ${this.ledger.openPositions.length} open position(s) until they exit. Press Stop again to stop fully, or Sell all.`,
        { buysHalted: true },
      );
      return {
        ok: true,
        message: `New buys halted. Still managing ${this.ledger.openPositions.length} open position(s); POST /runner/stop again to stop fully or POST /runner/sell-all to flatten now.`,
        status: this.getStatus(),
      };
    }
    this.buysHalted = true;
    if (this.state === "stopped") {
      return {
        ok: true,
        message: "Runner already stopped",
        status: this.getStatus(),
      };
    }
    this.state = "stopping";
    this.stopReason = this.stopReason ?? "manual_stop";
    this.abort?.abort();
    if (this.loopPromise) {
      // Market HTTP now times out, but still bound stop wait so the control
      // API cannot wedge if a tick is mid-flight.
      const STOP_WAIT_MS = 60_000;
      let timedOut = false;
      await Promise.race([
        this.loopPromise.catch(() => undefined),
        sleep(STOP_WAIT_MS).then(() => {
          timedOut = true;
        }),
      ]);
      if (timedOut) {
        log.warn(
          `stop(): runner loop still busy after ${STOP_WAIT_MS}ms (likely hung market HTTP); forcing stopped state`,
        );
        this.state = "stopped";
        this.stoppedAt = Date.now();
      }
    }
    log.info(`${modeLabel(this.tradingMode)} runner stopped via engine`);
    const reason = this.stopReason ?? "manual_stop";
    if (String(reason).startsWith("chase_lockout")) {
      const lock = this.chaseLockout.getStatus();
      this.events.push(
        "chase_lockout",
        "Chase lockout",
        reason,
        { stopReason: reason, unlockAt: lock.unlockAt },
      );
    } else if (String(reason).startsWith("daily_loss_cap")) {
      this.events.push(
        "daily_loss_cap",
        "Daily loss cap hit",
        reason,
        { stopReason: reason },
      );
    }
    this.events.push(
      "bot_stopped",
      "Paper bot stopped",
      reason,
      { stopReason: reason },
    );
    return {
      ok: true,
      message: "Paper runner stopped",
      status: this.getStatus(),
    };
  }

  /**
   * PAPER_MODE only: stop the runner if needed, rebuild the paper ledger to
   * BANKROLL_USD cash (flat, zero realized PnL, empty trades on disk), clear
   * stopReason / cycle counters. Unlocks start after a daily_loss_cap halt.
   * Vault (skimmedUsd) is NOT cleared — survives like journal / checklists.
   */
  async reset(): Promise<{
    ok: boolean;
    message: string;
    status: EngineStatus;
    portfolio: PortfolioSnapshot;
  }> {
    if (!this.cfg.paperMode) {
      const portfolio = await this.getPortfolio();
      return {
        ok: false,
        message:
          "PAPER_MODE only: refusing reset while live mode is configured (live is stubbed).",
        status: this.getStatus(),
        portfolio,
      };
    }

    if (this.state !== "stopped") {
      await this.stop();
    }

    this.ledger.resetSession(this.cfg.bankrollUsd);
    this.cycle = 0;
    this.startedAt = null;
    this.stoppedAt = null;
    this.lastError = null;
    this.lastCycleAt = null;
    this.stopReason = null;

    const portfolio = await this.getPortfolio();
    const lock = this.chaseLockout.getStatus();
    log.info("Paper session reset", {
      cashUsd: portfolio.cashUsd,
      vaultUsd: portfolio.vaultUsd,
      tradeCount: portfolio.tradeCount,
      chaseLockoutActive: lock.active,
      chaseUnlockAt: lock.unlockAt,
    });
    const lockNote = lock.active
      ? `; chase lockout STILL ACTIVE until ${new Date(lock.unlockAt!).toISOString()} (Reset does not unlock — timer only)`
      : "";
    return {
      ok: true,
      message: `Paper session reset to $${this.cfg.bankrollUsd.toFixed(2)} bankroll (vault $${portfolio.vaultUsd.toFixed(2)} kept)${lockNote}`,
      status: this.getStatus(),
      portfolio,
    };
  }

  /**
   * PAPER_MODE only: flatten the open paper position(s) at the current mark
   * via the paper broker. Reason = manual_exit. Does not stop the runner.
   */
  async exitNow(): Promise<{
    ok: boolean;
    message: string;
    status: EngineStatus;
    portfolio: PortfolioSnapshot;
    fills?: Fill[];
  }> {
    if (!this.cfg.paperMode && !this.isLiveMode()) {
      const portfolio = await this.getPortfolio();
      return {
        ok: false,
        message:
          "PAPER_MODE only: refusing manual exit while live mode is configured (live is stubbed).",
        status: this.getStatus(),
        portfolio,
      };
    }

    const open = this.ledger.openPositions;
    if (open.length === 0) {
      const portfolio = await this.getPortfolio();
      return {
        ok: false,
        message: "No open paper position to exit",
        status: this.getStatus(),
        portfolio,
      };
    }

    const fills: Fill[] = [];
    for (const pos of open) {
      // Re-check: a concurrent tick may have already closed it.
      if (!this.ledger.openPositions.some((p) => p.id === pos.id)) {
        continue;
      }
      let mark = await this.market.getPrice(pos.mint);
      if (mark == null || !(mark > 0)) {
        // Prefer flattening with last HWM / entry over wedging maxOpen=1.
        mark =
          pos.highWaterPrice > 0 ? pos.highWaterPrice : pos.entryPrice;
        log.warn(
          `No live mark for manual exit ${pos.symbol}; using fallback mark ${mark}`,
        );
        if (!(mark > 0)) {
          const portfolio = await this.getPortfolio();
          return {
            ok: false,
            message: `No mark price for ${pos.symbol} (${pos.mint}); cannot exit`,
            status: this.getStatus(),
            portfolio,
          };
        }
      }
      const fill = await this.closePosition(pos, mark, "manual_exit");
      // Paper: null only means a concurrent tick closed it first.
      if (!fill && !this.isLiveMode()) continue;
      if (!fill) {
        const portfolio = await this.getPortfolio();
        return {
          ok: false,
          message: `LIVE sell failed for ${pos.symbol}; position still open (see /alerts). ${this.lastLiveError ?? ""}`,
          status: this.getStatus(),
          portfolio,
          fills,
        };
      }
      fills.push(fill);
      log.info(this.isLiveMode() ? "Manual live exit" : "Manual paper exit", {
        symbol: pos.symbol,
        mark,
        notionalUsd: fill.notionalUsd,
      });
    }

    if (fills.length === 0) {
      const portfolio = await this.getPortfolio();
      return {
        ok: false,
        message: "No open paper position to exit",
        status: this.getStatus(),
        portfolio,
      };
    }

    const lock = this.maybeEngageChaseLockout();
    const portfolio = await this.getPortfolio();
    const syms = fills.map((f) => f.symbol).join(", ");
    const lockNote = lock.active
      ? ` · chase lockout until ${new Date(lock.unlockAt!).toISOString()}`
      : "";
    return {
      ok: true,
      message: `Manual exit filled for ${syms}${lockNote}`,
      status: this.getStatus(),
      portfolio,
      fills,
    };
  }

  /**
   * Stop the paper runner (if any) and tear down the optional WSS listener.
   * Call on process shutdown. Does not enable live trading.
   */
  async dispose(): Promise<void> {
    try {
      await this.stop();
    } catch (err) {
      log.warn("dispose: runner stop failed", err);
    }
    if (this.solanaWs) {
      try {
        await this.solanaWs.stop();
      } catch (err) {
        log.warn("dispose: Solana WSS stop failed", err);
      }
    }
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    const { cfg, market, ledger } = this;
    log.info("Runner loop starting", {
      paperMode: cfg.paperMode,
      bankrollUsd: cfg.bankrollUsd,
      maxOpenTrades: cfg.maxOpenTrades,
      source: cfg.marketDataSource,
      pinnedMint: this.pinnedMint,
      maxHoldMinutes: cfg.maxHoldMinutes,
      dailyLossUsd: cfg.dailyLossUsd,
      takeProfitPct: cfg.takeProfitPct,
    });

    while (!signal.aborted) {
      const lockEarly = this.maybeEngageChaseLockout();
      if (lockEarly.active) {
        this.stopReason =
          lockEarly.reason ??
          `chase_lockout until ${new Date(lockEarly.unlockAt!).toISOString()}`;
        log.warn(`Stopping runner: ${this.stopReason}`);
        break;
      }
      if (isDailyLossBreached(ledger.realizedPnl, cfg.dailyLossUsd)) {
        // Full original-deposit wipe also arms chase lockout (reset won't unlock).
        this.maybeEngageChaseLockout();
        this.stopReason = `daily_loss_cap (realized $${ledger.realizedPnl.toFixed(2)} ≤ −$${cfg.dailyLossUsd})`;
        log.warn(`Stopping runner: ${this.stopReason}`);
        break;
      }

      this.cycle += 1;
      if (cfg.runner.maxCycles > 0 && this.cycle > cfg.runner.maxCycles) {
        this.stopReason = `maxCycles=${cfg.runner.maxCycles}`;
        log.info(`Reached maxCycles=${cfg.runner.maxCycles}; stopping`);
        break;
      }

      try {
        const halt = await this.tick(this.cycle);
        this.lastCycleAt = Date.now();
        if (halt) {
          break;
        }
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        log.error("Cycle failed", err);
      }

      const lockAfter = this.maybeEngageChaseLockout();
      if (lockAfter.active) {
        this.stopReason =
          lockAfter.reason ??
          `chase_lockout until ${new Date(lockAfter.unlockAt!).toISOString()}`;
        log.warn(`Stopping runner: ${this.stopReason}`);
        break;
      }
      if (isDailyLossBreached(ledger.realizedPnl, cfg.dailyLossUsd)) {
        this.maybeEngageChaseLockout();
        this.stopReason = `daily_loss_cap (realized $${ledger.realizedPnl.toFixed(2)} ≤ −$${cfg.dailyLossUsd})`;
        log.warn(`Stopping runner: ${this.stopReason}`);
        break;
      }

      try {
        // Faster cadence while in a position so stop/trail don't wait a full
        // sniper 10s / momentum 15s between mark checks.
        const sleepMs =
          ledger.openPositions.length > 0
            ? Math.min(cfg.runner.pollIntervalMs, IN_POSITION_POLL_INTERVAL_MS)
            : cfg.runner.pollIntervalMs;
        await sleep(sleepMs, signal);
      } catch (err) {
        if ((err as { name?: string }).name === "AbortError") break;
        throw err;
      }
    }

    const marks = new Map<string, number>();
    for (const p of ledger.openPositions) {
      const px = await market.getPrice(p.mint);
      if (px != null) marks.set(p.mint, px);
    }
    const snap = ledger.snapshot(marks);
    log.info("Runner loop ended; portfolio", snap);
    const reason = this.stopReason;
    if (reason && String(reason).startsWith("chase_lockout")) {
      const lock = this.chaseLockout.getStatus();
      this.events.push(
        "chase_lockout",
        "Chase lockout",
        reason,
        {
          stopReason: reason,
          unlockAt: lock.unlockAt,
          originalDepositUsd: lock.originalDepositUsd,
          realizedPnlUsd: snap.realizedPnlUsd,
        },
      );
      this.events.push(
        "bot_stopped",
        "Paper bot stopped",
        reason,
        { stopReason: reason },
      );
    } else if (reason && String(reason).startsWith("daily_loss_cap")) {
      this.events.push(
        "daily_loss_cap",
        "Daily loss cap hit",
        reason,
        { stopReason: reason, realizedPnlUsd: snap.realizedPnlUsd },
      );
      this.events.push(
        "bot_stopped",
        "Paper bot stopped",
        reason,
        { stopReason: reason },
      );
    } else if (reason && reason !== "manual_stop") {
      // maxCycles / other auto-stops
      this.events.push(
        "bot_stopped",
        "Paper bot stopped",
        reason,
        { stopReason: reason },
      );
    }
  }

  /** @returns true if the runner should halt (daily loss). */
  private async tick(cycle: number): Promise<boolean> {
    const { cfg, market, broker, ledger } = this;
    const now = Date.now();

    // Exits FIRST — do not wait on a full candidate scan (Pump + sequential/parallel
    // Dex enrich) before stop / trail / TP / time_stop. With maxOpen=1 that scan
    // is wasted work on every in-position tick and added seconds of latency.
    for (const pos of [...ledger.openPositions]) {
      let mark = await market.getPrice(pos.mint);
      if (mark == null) {
        // Price-based exits need a mark; time-stop must NOT — otherwise
        // maxOpenTrades=1 wedges forever when Dex/Pump drops the mint.
        if (isMaxHoldExceeded(pos, now, cfg.maxHoldMinutes)) {
          mark =
            pos.highWaterPrice > 0
              ? pos.highWaterPrice
              : pos.entryPrice;
          log.warn(
            `No live mark for ${pos.symbol}; forcing time_stop at fallback mark ${mark}`,
          );
        } else {
          log.warn(`No mark for ${pos.symbol}; skipping exit check`);
          continue;
        }
      }
      // Skip if a concurrent manual exit already closed this position.
      if (!ledger.openPositions.some((p) => p.id === pos.id)) {
        continue;
      }
      this.lastMarks.set(pos.mint, mark);
      const { position: updated, exit } = evaluateExit(pos, mark, cfg, now);
      ledger.replacePosition(updated);
      if (exit) {
        if (!ledger.openPositions.some((p) => p.id === updated.id)) {
          continue;
        }
        await this.closePosition(updated, exit.markPrice, exit.reason);
      }
    }

    if (this.isLiveMode() && this.buysHalted) {
      if (ledger.openPositions.length === 0) {
        this.stopReason = this.stopReason ?? "manual_stop";
        log.warn("LIVE: buys halted and flat — stopping runner");
        return true;
      }
      return false;
    }

    const lockTick = this.maybeEngageChaseLockout();
    if (lockTick.active) {
      this.stopReason =
        lockTick.reason ??
        `chase_lockout until ${new Date(lockTick.unlockAt!).toISOString()}`;
      log.warn(`Stopping runner after exits: ${this.stopReason}`);
      return true;
    }
    if (isDailyLossBreached(ledger.realizedPnl, cfg.dailyLossUsd)) {
      this.maybeEngageChaseLockout();
      this.stopReason = `daily_loss_cap (realized $${ledger.realizedPnl.toFixed(2)} ≤ −$${cfg.dailyLossUsd})`;
      log.warn(`Stopping runner after exits: ${this.stopReason}`);
      return true;
    }

    // Vault sweep: reconcile pending / retry roughly once a minute (never blocks exits).
    if (this.vaultSweeper && now - this.lastVaultCheckAt > 60_000) {
      this.lastVaultCheckAt = now;
      const vs = this.vaultSweeper.status();
      if (vs.pending || (vs.autoSweep && !vs.stuck && vs.owedSol >= vs.minSweepSol)) {
        void this.vaultSweeper.process().catch(() => undefined);
      }
    }

    // HARD daily loss (all modes): blocks new buys only; exits above already ran.
    if (this.checkHardDailyLoss()) {
      log.debug(`Cycle ${cycle}: hard daily loss lock — no new buys`);
      return false;
    }

    if (!canOpenAnother(ledger.openPositions.length, cfg)) {
      log.debug(`Cycle ${cycle}: at max open trades (skipped entry scan)`);
      return false;
    }
    if (this.isLiveMode() && cfg.live) {
      if (ledger.openPositions.length >= cfg.live.maxOpenPositions) {
        log.debug(`Cycle ${cycle}: at LIVE_MAX_OPEN_POSITIONS`);
        return false;
      }
    }

    const snaps = await this.selectEntrySnapshots();

    const openMints = new Set(ledger.openPositions.map((p) => p.mint));
    const { signals: entries, rejects } = evaluateEntries(
      snaps,
      cfg,
      openMints,
      now,
    );

    if (rejects.length > 0) {
      log.info(
        `Cycle ${cycle}: skipped ${rejects.length}/${snaps.length} — ${summarizeRejects(rejects)}`,
      );
      for (const r of rejects) {
        log.debug(`Reject ${r.symbol}: ${r.reason} (${r.detail})`);
      }
    }

    if (entries.length === 0) {
      log.debug(`Cycle ${cycle}: no entry signals (${snaps.length} scanned)`);
      return false;
    }

    const entry = entries[0]!;
    // Size off tradable cash only — vault is excluded from ledger.cash after skim.
    const sized = sizePosition(
      {
        cashUsd: ledger.cash,
        markPrice: entry.priceUsd,
        openCount: ledger.openPositions.length,
      },
      cfg,
      ledger.realizedPnl,
    );

    if (!sized.ok) {
      log.info(`Skip entry ${entry.symbol}: ${sized.reason}`);
      return false;
    }
    // Hot-button size (already clamped to the active cap) bounds every new buy.
    const tradeSize = this.getTradeSize();
    sized.notionalUsd = Math.min(sized.notionalUsd, tradeSize.effectiveUsd);

    if (cfg.requireChecklistGo && !this.checklist.hasGoForMint(entry.mint)) {
      log.info(
        `Skip entry ${entry.symbol}: requireChecklistGo — no GO checklist for mint`,
      );
      return false;
    }

    if (cfg.rugFilterEnabled === true || this.isLiveMode()) {
      const rpc =
        this.solanaRpcOverride !== undefined
          ? this.solanaRpcOverride
          : ReadOnlySolanaRpc.fromEnv();
      let decision;
      try {
        const snap =
          snaps.find((s) => s.mint === entry.mint) ?? {
            mint: entry.mint,
            symbol: entry.symbol,
            name: entry.symbol,
            priceUsd: entry.priceUsd,
            changeWindowPct: 0,
            volumeWindowUsd: 0,
            volumeAvgUsd: 1,
            volume24hUsd: 0,
            liquidityUsd: 0,
            timestamp: Date.now(),
          };
        decision = await runRugFilter(
          // Live: filter is mandatory regardless of the paper toggle.
          rugFilterInputFromConfig(
            this.isLiveMode() ? { ...cfg, rugFilterEnabled: true } : cfg,
            snap,
            rpc,
          ),
        );
      } catch (err) {
        log.warn(
          `Skip entry ${entry.symbol}: rug_filter_rpc_error (filter threw; paper buy skipped)`,
          err,
        );
        return false;
      }
      if (decision.skipped.length > 0) {
        log.info(
          `Rug filter skipped checks for ${entry.symbol}: ${decision.skipped.join(", ")}`,
        );
      }
      if (!decision.allow) {
        log.info(
          `Skip entry ${entry.symbol}: ${decision.reason}${decision.detail ? ` (${decision.detail})` : ""}`,
        );
        return false;
      }
    }

    let fill: Fill;
    let position: Position;
    if (this.isLiveMode() && this.liveBroker && cfg.live) {
      if (this.buysHalted) return false;
      const solUsd = await this.liveSolUsd();
      if (solUsd == null) {
        log.warn(`Skip LIVE entry ${entry.symbol}: no SOL/USD rate`);
        return false;
      }
      const res = await this.liveBroker.buy({
        mint: entry.mint,
        symbol: entry.symbol,
        markPrice: entry.priceUsd,
        notionalUsd: Math.min(sized.notionalUsd, cfg.live.maxPositionUsd),
        solUsd,
      });
      if (!res.ok) {
        // No position recorded → no ghost. Loud only when the chain state is unknown.
        const msg = redactSecrets(res.reason).slice(0, 400);
        this.lastLiveError = `BUY ${entry.symbol}: ${msg}`;
        log.warn(`LIVE buy not filled for ${entry.symbol}: ${msg}`);
        if (res.unconfirmed) {
          this.events.push(
            "live_buy_unconfirmed",
            "⚠️ LIVE BUY UNCONFIRMED",
            `${entry.symbol}: sent but not confirmed. Not tracked as a position. Check the wallet / explorer. ${msg}`,
            { symbol: entry.symbol, mint: entry.mint, signature: res.signature ?? null },
          );
          this.journal.appendEvent({ kind: "live_buy_unconfirmed", symbol: entry.symbol, mint: entry.mint, detail: msg, signature: res.signature ?? null });
        }
        return false;
      }
      fill = res.fill;
      position = { ...res.position, tradeSizeUsd: tradeSize.selectedUsd };
      void this.refreshLiveBalance();
    } else {
      const entrySnap = snaps.find((s) => s.mint === entry.mint);
      ({ fill, position } = broker.applyBuy({
        mint: entry.mint,
        symbol: entry.symbol,
        markPrice: entry.priceUsd,
        notionalUsd: sized.notionalUsd,
        // Realistic paper costs: SOL-priced fees, venue fee tier, size-aware slippage.
        solUsd: await this.resolveQuoteUsdRate(),
        ...(entrySnap?.venue ? { venue: entrySnap.venue } : {}),
        ...(entrySnap && entrySnap.liquidityUsd > 0 ? { liquidityUsd: entrySnap.liquidityUsd } : {}),
      }));
      position = { ...position, tradeSizeUsd: tradeSize.selectedUsd };
    }
    ledger.recordBuy(fill, position);
    log.info(`Entry signal: ${entry.reason}`);
    this.events.push(
      "position_opened",
      "Position opened",
      `${position.symbol} · $${fill.notionalUsd.toFixed(2)} @ ${fill.price}`,
      {
        symbol: position.symbol,
        mint: position.mint,
        sizeUsd: fill.notionalUsd,
        entryPrice: fill.price,
      },
    );
    return false;
  }
}

