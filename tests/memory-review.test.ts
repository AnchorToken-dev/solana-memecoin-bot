/** Oct 12 review: entry memory, reserve-drop exit, trailing break-even floor. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MEMORY, TradeMemory, featuresFrom, scoreAgainst, seedFromTape, type MemoryTrade } from "../src/strategy/memory.js";
import { DEFAULT_EARLY_EXIT, PositionMarkHistory, earlyExitActive, evaluateEarlyExit } from "../src/strategy/earlyExit.js";
import { breakevenPrice, evaluateExit } from "../src/strategy/momentum.js";
import { loadConfig } from "../src/config.js";
import type { BotConfig, Position } from "../src/types.js";

const f = (runupPct: number, liq = 10_000) => ({ runupPct, volSharePct: 20, ageMin: 30, spike: 20, liquidityUsd: liq, gapPct: 0, reserveSol: 90 });
const trade = (runup: number, pnlPct: number, i: number): MemoryTrade => ({ at: i, symbol: `T${i}`, f: f(runup), pnlPct });

describe("entry memory", () => {
  const hist: MemoryTrade[] = [];
  for (let i = 0; i < 30; i++) hist.push(trade(200 + i, -15, i)); // big run-ups lost
  for (let i = 0; i < 30; i++) hist.push(trade(10 + i, +6, 100 + i)); // small run-ups won

  it("does nothing until minTrades are remembered", () => {
    const v = scoreAgainst(hist.slice(0, 39), f(210), DEFAULT_MEMORY);
    assert.equal(v.skip, false);
    assert.match(v.detail, /learning/);
  });
  it("skips a setup that looks like past losers, keeps one like past winners", () => {
    assert.equal(scoreAgainst(hist, f(215), DEFAULT_MEMORY).skip, true);
    assert.equal(scoreAgainst(hist, f(20), DEFAULT_MEMORY).skip, false);
  });
  it("off = never skips", () => {
    assert.equal(scoreAgainst(hist, f(215), { ...DEFAULT_MEMORY, enabled: false }).skip, false);
  });
  it("features from a scan snapshot", () => {
    const x = featuresFrom({ changeWindowPct: 40, volumeWindowUsd: 50, volume24hUsd: 100, volumeAvgUsd: 5, liquidityUsd: 1000, createdAt: 0 }, 600_000, 2, 80);
    assert.deepEqual(x, { runupPct: 40, volSharePct: 50, ageMin: null, spike: 10, liquidityUsd: 1000, gapPct: 2, reserveSol: 80 });
  });
  it("seeds from the price tape on first start and persists new trades", () => {
    const dir = mkdtempSync(join(tmpdir(), "mem-"));
    try {
      mkdirSync(join(dir, "price-tape"));
      const lines = [
        { kind: "entry", tradeId: "a", at: 1, symbol: "A", notionalUsd: 15, runupPct: 30, windowVolumeSharePct: 10, coinAgeMin: 20, quoteVsOnchainPct: 1, snapshot: { liquidityUsd: 9000, volumeWindowUsd: 100, volumeAvgUsd: 10 } },
        { kind: "exit", tradeId: "a", at: 2, realizedPnlUsd: -3, marks: [[100, 1, "chain", 88]] },
        { kind: "entry", tradeId: "b", at: 3, symbol: "B", notionalUsd: 15 },
      ];
      writeFileSync(join(dir, "price-tape", "2026-10-11.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n"));
      const seeded = seedFromTape(join(dir, "price-tape"));
      assert.equal(seeded.length, 1, "open trade b is not remembered");
      assert.equal(seeded[0]!.pnlPct, -20);
      assert.equal(seeded[0]!.f.reserveSol, 88);
      assert.equal(seeded[0]!.f.spike, 10);
      const m = new TradeMemory(dir, DEFAULT_MEMORY);
      assert.equal(m.size, 1);
      assert.ok(existsSync(m.filePath));
      m.add(trade(5, 3, 9));
      assert.equal(new TradeMemory(dir, DEFAULT_MEMORY).size, 2, "survives restart");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const pos = (over: Partial<Position> = {}): Position => ({
  id: "p1", mint: "M", symbol: "X", side: "long", qty: 14.56, entryPrice: 1, entryNotionalUsd: 15, entryFeesUsd: 0.44,
  highWaterPrice: 1, trailArmed: false, openedAt: 0, ...over,
});

describe("reserve-drop early exit", () => {
  const p = { ...DEFAULT_EARLY_EXIT, reserveDropPct: 5 };
  it("fires when pool SOL falls 5%+ between two reads", () => {
    const h = new PositionMarkHistory();
    h.record("p1", 1, 0); h.recordReserve("p1", 100);
    h.record("p1", 0.99, 1000); h.recordReserve("p1", 99);
    assert.equal(evaluateEarlyExit(pos(), 0.99, h, p, 1000), null);
    h.record("p1", 0.9, 2000); h.recordReserve("p1", 93);
    assert.equal(evaluateEarlyExit(pos(), 0.9, h, p, 2000)?.reason, "early_reserve_drop");
  });
  it("off by default in the pure defaults; on (5%) from config", () => {
    assert.equal(earlyExitActive(DEFAULT_EARLY_EXIT), false);
    delete process.env.EXIT_RESERVE_DROP_PCT;
    assert.equal(loadConfig({ skipRuntimeOverlay: true } as never).earlyExit?.reserveDropPct, 5);
  });
});

describe("trailing take-profit break-even floor", () => {
  const cfg = (on: boolean): BotConfig => ({
    stopLossPct: 8, takeProfitPct: 15, maxHoldMinutes: 0, trailingTakeProfit: { activatePct: 8, distancePct: 4 },
    ...(on ? { trailBreakeven: { enabled: true, exitFeePct: 2, minProfitPct: 1 } } : {}),
  }) as unknown as BotConfig;
  it("break-even price covers entry costs + estimated exit fee", () => {
    const be = breakevenPrice(pos(), { enabled: true, exitFeePct: 2, minProfitPct: 0 })!;
    assert.ok(Math.abs(be - 15 / (14.56 * 0.98)) < 1e-9); // ≈ +5.1% over the fill
  });
  it("old rule sells at +6% after a +9% peak (a loss after fees); the floor sells at break-even first", () => {
    const armed = pos({ trailArmed: true, highWaterPrice: 1.09 });
    // +6%: old trail floor is 1.0464 → no exit; break-even floor ≈1.0617 → exit.
    assert.equal(evaluateExit(armed, 1.06, cfg(false)).exit, null);
    assert.equal(evaluateExit(armed, 1.06, cfg(true)).exit?.reason, "trailing_take_profit");
    // Still rising: no exit either way.
    assert.equal(evaluateExit(armed, 1.08, cfg(true)).exit, null);
  });
  it("config defaults", () => {
    for (const k of ["TRAIL_BREAKEVEN_FLOOR", "MEMORY_ENABLED"]) delete process.env[k];
    const c = loadConfig({ skipRuntimeOverlay: true } as never);
    assert.deepEqual(c.trailBreakeven, { enabled: true, exitFeePct: 2, minProfitPct: 1 });
    assert.deepEqual(c.memory, DEFAULT_MEMORY);
  });
});
