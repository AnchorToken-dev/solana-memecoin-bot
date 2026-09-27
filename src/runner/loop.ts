import type { BotConfig, TokenSnapshot } from "../types.js";
import type { MarketDataProvider } from "../market/data.js";
import { PaperBroker } from "../broker/paper.js";
import { PaperLedger } from "../ledger/ledger.js";
import { evaluateEntries, evaluateExit } from "../strategy/momentum.js";
import { sizePosition, canOpenAnother } from "../risk/manager.js";
import { log } from "../logging.js";

export interface RunnerDeps {
  cfg: BotConfig;
  market: MarketDataProvider;
  broker: PaperBroker;
  ledger: PaperLedger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runLoop(deps: RunnerDeps): Promise<void> {
  const { cfg, market, ledger } = deps;
  let cycle = 0;

  log.info("Runner starting", {
    paperMode: cfg.paperMode,
    bankrollUsd: cfg.bankrollUsd,
    maxOpenTrades: cfg.maxOpenTrades,
    stopLossPct: cfg.stopLossPct,
    trail: cfg.trailingTakeProfit,
    momentum: cfg.momentum,
    source: cfg.marketDataSource,
  });

  while (true) {
    cycle += 1;
    if (cfg.runner.maxCycles > 0 && cycle > cfg.runner.maxCycles) {
      log.info(`Reached maxCycles=${cfg.runner.maxCycles}; stopping`);
      break;
    }

    try {
      await tick(deps, cycle);
    } catch (err) {
      log.error("Cycle failed", err);
    }

    await sleep(cfg.runner.pollIntervalMs);
  }

  const marks = new Map<string, number>();
  for (const p of ledger.openPositions) {
    const px = await market.getPrice(p.mint);
    if (px != null) marks.set(p.mint, px);
  }
  const snap = ledger.snapshot(marks);
  log.info("Final portfolio", snap);
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

async function tick(deps: RunnerDeps, cycle: number): Promise<void> {
  const { cfg, market, broker, ledger } = deps;

  // Always scan so mock clocks (and live caches) advance even when flat-out on risk.
  const snaps = await market.scan(cfg.runner.scanLimit);

  // 1) Manage open positions (stop / trail) — priority over new entries.
  for (const pos of ledger.openPositions) {
    const mark = await markFor(pos.mint, snaps, market);
    if (mark == null) {
      log.warn(`No mark for ${pos.symbol}; skipping exit check`);
      continue;
    }
    const { position: updated, exit } = evaluateExit(pos, mark, cfg);
    ledger.replacePosition(updated);
    if (exit) {
      const { fill, proceedsUsd, realizedPnlUsd } = broker.applySell({
        position: updated,
        markPrice: exit.markPrice,
        reason: exit.reason,
      });
      ledger.recordSell(fill, realizedPnlUsd, proceedsUsd);
    }
  }

  // 2) Scan for momentum entries if capacity remains.
  if (!canOpenAnother(ledger.openPositions.length, cfg)) {
    log.debug(`Cycle ${cycle}: at max open trades`);
    return;
  }

  const openMints = new Set(ledger.openPositions.map((p) => p.mint));
  const entries = evaluateEntries(snaps, cfg, openMints);

  if (entries.length === 0) {
    log.debug(`Cycle ${cycle}: no entry signals (${snaps.length} scanned)`);
    return;
  }

  // One trade at a time — take the strongest signal only.
  const signal = entries[0]!;
  const sized = sizePosition(
    {
      cashUsd: ledger.cash,
      markPrice: signal.priceUsd,
      openCount: ledger.openPositions.length,
    },
    cfg,
  );

  if (!sized.ok) {
    log.info(`Skip entry ${signal.symbol}: ${sized.reason}`);
    return;
  }

  const { fill, position } = broker.applyBuy({
    mint: signal.mint,
    symbol: signal.symbol,
    markPrice: signal.priceUsd,
    notionalUsd: sized.notionalUsd,
  });
  ledger.recordBuy(fill, position);
  log.info(`Entry signal: ${signal.reason}`);
}
