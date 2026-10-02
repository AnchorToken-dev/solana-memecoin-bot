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
  SessionEventBus,
  exitEventType,
  exitTitle,
} from "../alerts/sessionEvents.js";

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
    },
  ) {
    this.cfg = cfg;
    this.market = deps?.market ?? createMarketData(cfg);
    this.broker = deps?.broker ?? new PaperBroker(cfg);
    this.ledger =
      deps?.ledger ?? new PaperLedger(cfg.bankrollUsd, cfg.ledgerDir);
    this.journal =
      deps?.journal ?? new TradeJournal(cfg.ledgerDir);
    this.checklist =
      deps?.checklist ?? new ResearchChecklistStore(cfg.ledgerDir);
    this.events = deps?.events ?? new SessionEventBus();
    this.chaseLockout =
      deps?.chaseLockout ?? new ChaseLockoutStore(cfg.ledgerDir);
    this.runtimeConfigPath = deps?.runtimeConfigPath;
    this.solanaRpcOverride = deps?.solanaRpc;
    this.loadPinnedMint();
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
    };
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
      if (px != null) marks.set(p.mint, px);
    }
    return this.ledger.snapshot(marks);
  }

  getTrades(limit = 50): TradeRecord[] {
    return this.ledger.getTrades(limit);
  }

  async getJournal(opts?: { limit?: number; offset?: number }) {
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
    if (!this.cfg.paperMode) {
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
    });
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
    if (!this.cfg.paperMode) {
      return {
        ok: false,
        message:
          "Refusing to start: PAPER_MODE is false. Live trading is stubbed; keep PAPER_MODE=true.",
        status: this.getStatus(),
      };
    }
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

    log.info("Paper runner started via engine");
    this.events.push(
      "bot_started",
      "Paper bot started",
      `Runner running · bankroll $${this.cfg.bankrollUsd.toFixed(2)}`,
      { bankrollUsd: this.cfg.bankrollUsd },
    );
    return {
      ok: true,
      message: "Paper runner started",
      status: this.getStatus(),
    };
  }

  async stop(): Promise<{ ok: boolean; message: string; status: EngineStatus }> {
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
    log.info("Paper runner stopped via engine");
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
    if (!this.cfg.paperMode) {
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
      const { fill, proceedsUsd, realizedPnlUsd } = this.broker.applySell({
        position: pos,
        markPrice: mark,
        reason: "manual_exit",
      });
      this.ledger.recordSell(fill, realizedPnlUsd, proceedsUsd);
      await this.recordJournalClose(pos, fill, realizedPnlUsd);
      fills.push(fill);
      log.info("Manual paper exit", {
        symbol: pos.symbol,
        mark,
        realizedPnlUsd,
        proceedsUsd,
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
      const { position: updated, exit } = evaluateExit(pos, mark, cfg, now);
      ledger.replacePosition(updated);
      if (exit) {
        if (!ledger.openPositions.some((p) => p.id === updated.id)) {
          continue;
        }
        const { fill, proceedsUsd, realizedPnlUsd } = broker.applySell({
          position: updated,
          markPrice: exit.markPrice,
          reason: exit.reason,
        });
        ledger.recordSell(fill, realizedPnlUsd, proceedsUsd);
        await this.recordJournalClose(updated, fill, realizedPnlUsd);
      }
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

    if (!canOpenAnother(ledger.openPositions.length, cfg)) {
      log.debug(`Cycle ${cycle}: at max open trades (skipped entry scan)`);
      return false;
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

    if (cfg.requireChecklistGo && !this.checklist.hasGoForMint(entry.mint)) {
      log.info(
        `Skip entry ${entry.symbol}: requireChecklistGo — no GO checklist for mint`,
      );
      return false;
    }

    if (cfg.rugFilterEnabled === true) {
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
          rugFilterInputFromConfig(cfg, snap, rpc),
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

    const { fill, position } = broker.applyBuy({
      mint: entry.mint,
      symbol: entry.symbol,
      markPrice: entry.priceUsd,
      notionalUsd: sized.notionalUsd,
    });
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

