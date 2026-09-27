/**
 * Controllable paper bot engine — start/stop from CLI or HTTP control API.
 * Live trading remains stubbed; start() refuses unless PAPER_MODE=true.
 */
import type { BotConfig, Fill, PortfolioSnapshot, TokenSnapshot, TradeRecord } from "../types.js";
import type { MarketDataProvider } from "../market/data.js";
import { createMarketData } from "../market/data.js";
import { PaperBroker } from "../broker/paper.js";
import { PaperLedger } from "../ledger/ledger.js";
import { evaluateEntries, evaluateExit } from "../strategy/momentum.js";
import {
  sizePosition,
  canOpenAnother,
  isDailyLossBreached,
} from "../risk/manager.js";
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
  marketDataSource: BotConfig["marketDataSource"];
  stopReason: string | null;
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

  private state: RunnerState = "stopped";
  private cycle = 0;
  private startedAt: number | null = null;
  private stoppedAt: number | null = null;
  private lastError: string | null = null;
  private lastCycleAt: number | null = null;
  private stopReason: string | null = null;
  private abort: AbortController | null = null;
  private loopPromise: Promise<void> | null = null;

  /** Where PATCH / preset persist the paper overlay (default data/runtime-config.json). */
  private readonly runtimeConfigPath: string | undefined;

  constructor(
    cfg: BotConfig,
    deps?: {
      market?: MarketDataProvider;
      broker?: PaperBroker;
      ledger?: PaperLedger;
      /** Absolute or relative path for runtime-config.json persistence. */
      runtimeConfigPath?: string;
    },
  ) {
    this.cfg = cfg;
    this.market = deps?.market ?? createMarketData(cfg);
    this.broker = deps?.broker ?? new PaperBroker(cfg);
    this.ledger =
      deps?.ledger ?? new PaperLedger(cfg.bankrollUsd, cfg.ledgerDir);
    this.runtimeConfigPath = deps?.runtimeConfigPath;
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
      marketDataSource: this.cfg.marketDataSource,
      stopReason: this.stopReason,
    };
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
    log.info("Paper preset applied + persisted", { preset, path });
    return {
      ok: true,
      message: `Preset "${preset}" applied and saved to ${path}`,
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
      await this.loopPromise.catch(() => undefined);
    }
    log.info("Paper runner stopped via engine");
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
    log.info("Paper session reset", {
      cashUsd: portfolio.cashUsd,
      tradeCount: portfolio.tradeCount,
    });
    return {
      ok: true,
      message: `Paper session reset to $${this.cfg.bankrollUsd.toFixed(2)} bankroll`,
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
      const mark = await this.market.getPrice(pos.mint);
      if (mark == null || !(mark > 0)) {
        const portfolio = await this.getPortfolio();
        return {
          ok: false,
          message: `No mark price for ${pos.symbol} (${pos.mint}); cannot exit`,
          status: this.getStatus(),
          portfolio,
        };
      }
      const { fill, proceedsUsd, realizedPnlUsd } = this.broker.applySell({
        position: pos,
        markPrice: mark,
        reason: "manual_exit",
      });
      this.ledger.recordSell(fill, realizedPnlUsd, proceedsUsd);
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

    const portfolio = await this.getPortfolio();
    const syms = fills.map((f) => f.symbol).join(", ");
    return {
      ok: true,
      message: `Manual exit filled for ${syms}`,
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
      maxHoldMinutes: cfg.maxHoldMinutes,
      dailyLossUsd: cfg.dailyLossUsd,
      takeProfitPct: cfg.takeProfitPct,
    });

    while (!signal.aborted) {
      if (isDailyLossBreached(ledger.realizedPnl, cfg.dailyLossUsd)) {
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

      if (isDailyLossBreached(ledger.realizedPnl, cfg.dailyLossUsd)) {
        this.stopReason = `daily_loss_cap (realized $${ledger.realizedPnl.toFixed(2)} ≤ −$${cfg.dailyLossUsd})`;
        log.warn(`Stopping runner: ${this.stopReason}`);
        break;
      }

      try {
        await sleep(cfg.runner.pollIntervalMs, signal);
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
  }

  /** @returns true if the runner should halt (daily loss). */
  private async tick(cycle: number): Promise<boolean> {
    const { cfg, market, broker, ledger } = this;
    const now = Date.now();
    const snaps = await market.scan(cfg.runner.scanLimit);

    for (const pos of ledger.openPositions) {
      const mark = await markFor(pos.mint, snaps, market);
      if (mark == null) {
        log.warn(`No mark for ${pos.symbol}; skipping exit check`);
        continue;
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
      }
    }

    if (isDailyLossBreached(ledger.realizedPnl, cfg.dailyLossUsd)) {
      this.stopReason = `daily_loss_cap (realized $${ledger.realizedPnl.toFixed(2)} ≤ −$${cfg.dailyLossUsd})`;
      log.warn(`Stopping runner after exits: ${this.stopReason}`);
      return true;
    }

    if (!canOpenAnother(ledger.openPositions.length, cfg)) {
      log.debug(`Cycle ${cycle}: at max open trades`);
      return false;
    }

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

    const { fill, position } = broker.applyBuy({
      mint: entry.mint,
      symbol: entry.symbol,
      markPrice: entry.priceUsd,
      notionalUsd: sized.notionalUsd,
    });
    ledger.recordBuy(fill, position);
    log.info(`Entry signal: ${entry.reason}`);
    return false;
  }
}

async function markFor(
  mint: string,
  snaps: TokenSnapshot[],
  market: MarketDataProvider,
): Promise<number | null> {
  const fromScan = snaps.find((s) => s.mint === mint);
  if (fromScan) return fromScan.priceUsd;
  return market.getPrice(mint);
}
