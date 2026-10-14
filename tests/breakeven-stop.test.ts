/** Oct 13 Gemini exit test: stop moves to entry after +BREAKEVEN_ARM_PCT. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateExit } from "../src/strategy/momentum.js";
import { loadConfig } from "../src/config.js";
import type { BotConfig, Position } from "../src/types.js";

const pos = (over: Partial<Position> = {}): Position => ({
  id: "p1", mint: "M", symbol: "X", side: "long", qty: 15, entryPrice: 1, entryNotionalUsd: 15, entryFeesUsd: 0.44,
  highWaterPrice: 1, trailArmed: false, openedAt: 0, ...over,
} as Position);
const cfg = (armPct: number): BotConfig => {
  const c = loadConfig({ skipRuntimeOverlay: true });
  c.stopLossPct = 20; c.takeProfitPct = 0; c.maxHoldMinutes = 0;
  c.trailingTakeProfit = { activatePct: 20, distancePct: 10 };
  c.breakevenStop = { armPct };
  return c;
};

describe("break-even stop", () => {
  it("off by default (env unset)", () => {
    assert.equal(loadConfig({ skipRuntimeOverlay: true }).breakevenStop?.armPct, 0);
  });
  it("not armed below +10%: only the 20% hard stop applies", () => {
    const p = pos({ highWaterPrice: 1.09 });
    assert.equal(evaluateExit(p, 0.99, cfg(10), 1).exit, null);
    assert.equal(evaluateExit(p, 0.8, cfg(10), 1).exit?.reason, "stop_loss");
  });
  it("armed after +10%: exits at or below entry", () => {
    const p = pos({ highWaterPrice: 1.1 });
    assert.equal(evaluateExit(p, 1.01, cfg(10), 1).exit, null);
    assert.equal(evaluateExit(p, 1.0, cfg(10), 1).exit?.reason, "breakeven_stop");
  });
  it("arms from the current mark too", () => {
    const r = evaluateExit(pos(), 1.12, cfg(10), 1);
    assert.equal(r.exit, null);
    assert.equal(evaluateExit(r.position, 0.98, cfg(10), 1).exit?.reason, "breakeven_stop");
  });
  it("armPct 0 = disabled", () => {
    assert.equal(evaluateExit(pos({ highWaterPrice: 1.5 }), 0.95, cfg(0), 1).exit, null);
  });
  it("no fixed TP; trail arms at +20% and sells 10% off peak", () => {
    const c = cfg(10);
    let r = evaluateExit(pos(), 1.5, c, 1);
    assert.equal(r.exit, null, "TP 0 = no fixed take-profit");
    assert.equal(evaluateExit(r.position, 1.36, c, 1).exit, null);
    assert.equal(evaluateExit(r.position, 1.35, c, 1).exit?.reason, "trailing_take_profit");
  });
});
