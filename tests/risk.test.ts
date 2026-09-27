import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sizePosition,
  isStopLossHit,
  canOpenAnother,
} from "../src/risk/manager.js";
import { evaluateExit } from "../src/strategy/momentum.js";
import type { BotConfig, Position } from "../src/types.js";

function baseCfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true,
    bankrollUsd: 20,
    maxOpenTrades: 1,
    stopLossPct: 10,
    positionSizePct: 0.95,
    momentum: {
      minPct: 8,
      windowMinutes: 5,
      volumeSpikeMult: 2,
      minLiquidityUsd: 15_000,
      minVolume24hUsd: 25_000,
    },
    trailingTakeProfit: { activatePct: 15, distancePct: 5 },
    paperBroker: { slippageBps: 50, feeBps: 30 },
    runner: { pollIntervalMs: 1000, scanLimit: 10, maxCycles: 0 },
    marketDataSource: "mock",
    ledgerDir: "data",
    ...over,
  };
}

function pos(entryPrice: number): Position {
  return {
    id: "p1",
    mint: "mint",
    symbol: "TST",
    side: "long",
    qty: 1000,
    entryPrice,
    entryNotionalUsd: entryPrice * 1000,
    entryFeesUsd: 0,
    highWaterPrice: entryPrice,
    trailArmed: false,
    openedAt: Date.now(),
  };
}

describe("risk: max open trades", () => {
  it("never sizes a second trade when maxOpenTrades=1", () => {
    const cfg = baseCfg({ maxOpenTrades: 1 });
    assert.equal(canOpenAnother(0, cfg), true);
    assert.equal(canOpenAnother(1, cfg), false);

    const blocked = sizePosition(
      { cashUsd: 20, markPrice: 0.001, openCount: 1 },
      cfg,
    );
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason ?? "", /max open trades/);
  });

  it("allows sizing when no open trades", () => {
    const cfg = baseCfg();
    const ok = sizePosition(
      { cashUsd: 20, markPrice: 0.001, openCount: 0 },
      cfg,
    );
    assert.equal(ok.ok, true);
    assert.ok(ok.notionalUsd === 20 * 0.95);
    assert.ok(ok.qty > 0);
  });
});

describe("risk: hard stop at -10%", () => {
  it("isStopLossHit fires at exactly -10%", () => {
    const p = pos(1.0);
    assert.equal(isStopLossHit(p, 0.9001, 10), false);
    assert.equal(isStopLossHit(p, 0.9, 10), true);
    assert.equal(isStopLossHit(p, 0.85, 10), true);
  });

  it("evaluateExit returns stop_loss when mark <= -10%", () => {
    const cfg = baseCfg();
    const p = pos(1.0);
    const { exit } = evaluateExit(p, 0.89, cfg);
    assert.ok(exit);
    assert.equal(exit!.reason, "stop_loss");
  });

  it("does not stop above the threshold", () => {
    const cfg = baseCfg();
    const p = pos(1.0);
    const { exit } = evaluateExit(p, 0.95, cfg);
    assert.equal(exit, null);
  });
});

describe("strategy: trailing take-profit", () => {
  it("arms trail after +15% and exits on 5% pullback from HWM", () => {
    const cfg = baseCfg();
    let p = pos(1.0);

    // Pump to +20% — arm trail, no exit yet.
    let r = evaluateExit(p, 1.2, cfg);
    p = r.position;
    assert.equal(p.trailArmed, true);
    assert.equal(r.exit, null);
    assert.equal(p.highWaterPrice, 1.2);

    // Pull back 5% from HWM (1.2 * 0.95 = 1.14) — should exit.
    r = evaluateExit(p, 1.14, cfg);
    assert.ok(r.exit);
    assert.equal(r.exit!.reason, "trailing_take_profit");
  });
});
