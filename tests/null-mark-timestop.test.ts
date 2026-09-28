import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";

function baseCfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true,
    bankrollUsd: 20,
    maxOpenTrades: 1,
    stopLossPct: 10,
    takeProfitPct: 25,
    positionSizePct: 0.95,
    maxPositionUsd: 25,
    momentum: {
      minPct: 8,
      windowMinutes: 5,
      volumeSpikeMult: 2,
      minLiquidityUsd: 15_000,
      minVolume24hUsd: 25_000,
      minAgeMinutes: 3,
    },
    trailingTakeProfit: { activatePct: 15, distancePct: 5 },
    paperBroker: { slippageBps: 50, feeBps: 30 },
    runner: { pollIntervalMs: 30, scanLimit: 5, maxCycles: 3 },
    maxHoldMinutes: 1, // 1 minute
    dailyLossUsd: 0,
    chaseLockoutHours: 0,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "custom",
    requireChecklistGo: false,
    ...over,
  };
}

/** Scan never includes the open mint; getPrice always null — classic wedge. */
class BlindMarket implements MarketDataProvider {
  async scan(_limit: number): Promise<TokenSnapshot[]> {
    return [];
  }
  async getPrice(_mint: string): Promise<number | null> {
    return null;
  }
}

describe("null mark still enforces time_stop", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "null-mark-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("flattens open position via time_stop when marks are missing", async () => {
    const cfg = baseCfg({ ledgerDir: dir, maxHoldMinutes: 1 });
    const market = new BlindMarket();
    const ledger = new PaperLedger(cfg.bankrollUsd, dir);
    const broker = new PaperBroker(cfg);
    const engine = new BotEngine(cfg, { ledger, broker, market });

    const openedAt = Date.now() - 2 * 60_000; // held 2 minutes > maxHold 1
    const { fill, position } = broker.applyBuy({
      mint: "BlindMint1",
      symbol: "BLIND",
      markPrice: 1.0,
      notionalUsd: 10,
    });
    // Backdate openedAt so time_stop is already due.
    (position as { openedAt: number }).openedAt = openedAt;
    ledger.recordBuy(fill, position);
    assert.equal(ledger.openPositions.length, 1);

    const started = await engine.start();
    assert.equal(started.ok, true);

    // Wait for a couple of cycles
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && ledger.openPositions.length > 0) {
      await new Promise((r) => setTimeout(r, 40));
    }
    await engine.stop();

    assert.equal(
      ledger.openPositions.length,
      0,
      "time_stop must clear the wedged position without a live mark",
    );
    const sells = ledger.getTrades(10).filter((t) => t.fill.side === "sell");
    assert.ok(sells.length >= 1);
    assert.equal(sells[0]!.fill.reason, "time_stop");
  });
});
