import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  sizePosition,
  isStopLossHit,
  isTakeProfitHit,
  canOpenAnother,
  isDailyLossBreached,
  isMaxHoldExceeded,
} from "../src/risk/manager.js";
import { evaluateEntries, evaluateExit } from "../src/strategy/momentum.js";
import type { BotConfig, Position, TokenSnapshot } from "../src/types.js";

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
    runner: { pollIntervalMs: 1000, scanLimit: 10, maxCycles: 0 },
    maxHoldMinutes: 20,
    dailyLossUsd: 5,
    chaseLockoutHours: 12,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "custom",
    requireChecklistGo: false,
    ...over,
  };
}

function pos(entryPrice: number, openedAt = Date.now()): Position {
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
    openedAt,
  };
}

function snap(over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  const now = Date.now();
  return {
    mint: "mintA",
    symbol: "AAA",
    name: "Aaa",
    priceUsd: 0.001,
    changeWindowPct: 12,
    volumeWindowUsd: 20_000,
    volumeAvgUsd: 5_000,
    volume24hUsd: 40_000,
    liquidityUsd: 30_000,
    timestamp: now,
    createdAt: now - 10 * 60_000,
    ...over,
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


describe("risk: hard take-profit (TAKE_PROFIT_PCT)", () => {
  it("isTakeProfitHit fires at exactly +25%", () => {
    const p = pos(1.0);
    assert.equal(isTakeProfitHit(p, 1.249, 25), false);
    assert.equal(isTakeProfitHit(p, 1.25, 25), true);
    assert.equal(isTakeProfitHit(p, 1.5, 25), true);
    assert.equal(isTakeProfitHit(p, 2.0, 0), false);
  });

  it("evaluateExit returns take_profit when unrealized >= TAKE_PROFIT_PCT", () => {
    const cfg = baseCfg({ takeProfitPct: 25 });
    const p = pos(1.0);
    const { exit } = evaluateExit(p, 1.25, cfg);
    assert.ok(exit);
    assert.equal(exit!.reason, "take_profit");
  });

  it("does not take-profit below the threshold (trail may arm)", () => {
    const cfg = baseCfg({ takeProfitPct: 25 });
    const p = pos(1.0);
    // +20% — below hard TP 25, above trail activate 15 → arm trail, no exit
    const { exit, position } = evaluateExit(p, 1.2, cfg);
    assert.equal(exit, null);
    assert.equal(position.trailArmed, true);
  });

  it("takeProfitPct=0 disables hard take-profit", () => {
    const cfg = baseCfg({ takeProfitPct: 0 });
    const p = pos(1.0);
    const { exit, position } = evaluateExit(p, 1.5, cfg);
    assert.equal(exit, null);
    assert.equal(position.trailArmed, true);
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

describe("risk: hard time stop (MAX_HOLD_MINUTES)", () => {
  it("isMaxHoldExceeded is false before the window", () => {
    const openedAt = 1_000_000;
    const p = pos(1.0, openedAt);
    assert.equal(isMaxHoldExceeded(p, openedAt + 19 * 60_000, 20), false);
    assert.equal(isMaxHoldExceeded(p, openedAt + 20 * 60_000, 20), true);
    assert.equal(isMaxHoldExceeded(p, openedAt + 60 * 60_000, 0), false);
  });

  it("evaluateExit returns time_stop after MAX_HOLD_MINUTES", () => {
    const cfg = baseCfg({ maxHoldMinutes: 20 });
    const openedAt = Date.now() - 21 * 60_000;
    const p = pos(1.0, openedAt);
    const { exit } = evaluateExit(p, 1.02, cfg, Date.now());
    assert.ok(exit);
    assert.equal(exit!.reason, "time_stop");
  });

  it("does not time-stop when still inside the hold window", () => {
    const cfg = baseCfg({ maxHoldMinutes: 20 });
    const openedAt = Date.now() - 5 * 60_000;
    const p = pos(1.0, openedAt);
    const { exit } = evaluateExit(p, 1.02, cfg, Date.now());
    assert.equal(exit, null);
  });
});

describe("risk: daily loss cap (DAILY_LOSS_USD)", () => {
  it("isDailyLossBreached when realized ≤ −cap", () => {
    assert.equal(isDailyLossBreached(-4.99, 5), false);
    assert.equal(isDailyLossBreached(-5, 5), true);
    assert.equal(isDailyLossBreached(-12, 5), true);
    assert.equal(isDailyLossBreached(-100, 0), false);
  });

  it("sizePosition refuses new entries when daily loss is breached", () => {
    const cfg = baseCfg({ dailyLossUsd: 5 });
    const blocked = sizePosition(
      { cashUsd: 20, markPrice: 0.001, openCount: 0 },
      cfg,
      -5.5,
    );
    assert.equal(blocked.ok, false);
    assert.match(blocked.reason ?? "", /daily loss cap/);
  });
});

describe("strategy: entry reject reasons", () => {
  it("rejects too_new when createdAt is younger than MIN_AGE_MINUTES", () => {
    const cfg = baseCfg({
      momentum: {
        minPct: 5,
        windowMinutes: 5,
        volumeSpikeMult: 2,
        minLiquidityUsd: 5000,
        minVolume24hUsd: 8000,
        minAgeMinutes: 3,
      },
    });
    const now = Date.now();
    const { signals, rejects } = evaluateEntries(
      [
        snap({
          createdAt: now - 60_000,
          changeWindowPct: 20,
          liquidityUsd: 10_000,
          volume24hUsd: 20_000,
          volumeWindowUsd: 10_000,
          volumeAvgUsd: 2_000,
        }),
      ],
      cfg,
      new Set(),
      now,
    );
    assert.equal(signals.length, 0);
    assert.equal(rejects[0]?.reason, "too_new");
  });

  it("rejects low_liquidity with a clear reason", () => {
    const cfg = baseCfg();
    const now = Date.now();
    const { rejects } = evaluateEntries(
      [snap({ liquidityUsd: 100, changeWindowPct: 20 })],
      cfg,
      new Set(),
      now,
    );
    assert.equal(rejects[0]?.reason, "low_liquidity");
  });

  it("accepts a coin that clears looser pumpfun-style floors", () => {
    const cfg = baseCfg({
      momentum: {
        minPct: 5,
        windowMinutes: 5,
        volumeSpikeMult: 2,
        minLiquidityUsd: 5000,
        minVolume24hUsd: 8000,
        minAgeMinutes: 3,
      },
      trailingTakeProfit: { activatePct: 10, distancePct: 7 },
    });
    const now = Date.now();
    const { signals, rejects } = evaluateEntries(
      [
        snap({
          createdAt: now - 10 * 60_000,
          changeWindowPct: 6,
          liquidityUsd: 6_000,
          volume24hUsd: 9_000,
          volumeWindowUsd: 5_000,
          volumeAvgUsd: 2_000,
        }),
      ],
      cfg,
      new Set(),
      now,
    );
    assert.equal(rejects.length, 0);
    assert.equal(signals.length, 1);
  });
});
