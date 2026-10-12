import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeJournal, groupStats, tradesNeededForSignificance, type AnalysisRow } from "../src/journal/analysis.js";
describe("journal analysis", () => {
  const row = (pnlPct: number, extra: Partial<AnalysisRow> = {}): AnalysisRow => ({ mode: "live", sizeUsd: 15, tradeSizeUsd: 15, pnlUsd: (pnlPct / 100) * 15, pnlPct, exitReason: pnlPct > 0 ? "take_profit" : "stop_loss", ...extra });
  it("win rate, averages and the break-even win rate at those averages", () => {
    const rows = [row(20), row(20), row(-10), row(-10), row(-10), row(-10)];
    const s = groupStats(rows);
    assert.equal(s.n, 6);
    assert.ok(Math.abs(s.winRatePct - 33.33) < 0.01);
    assert.equal(s.avgWinPct, 20);
    assert.equal(s.avgLossPct, -10);
    assert.ok(Math.abs(s.breakEvenWinRatePct! - 33.33) < 0.01, "10 / (20+10)");
  });
  it("small samples are 'inconclusive'; a consistent big result is not", () => {
    assert.equal(groupStats([row(5), row(-3), row(8)]).verdict, "inconclusive");
    assert.equal(groupStats(Array.from({ length: 50 }, (_, i) => row(-6 - (i % 3)))).verdict, "negative");
    assert.equal(groupStats(Array.from({ length: 50 }, (_, i) => row(6 + (i % 3)))).verdict, "positive");
  });
  it("groups by mode, size and exit reason; old rows without a mode count as paper", () => {
    const rows = [row(10), row(-10, { tradeSizeUsd: 30, sizeUsd: 30 }), { ...row(-5), mode: undefined }];
    const a = analyzeJournal(rows);
    assert.deepEqual(Object.keys(a.byMode).sort(), ["live", "paper"]);
    assert.ok(a.byModeAndSize["live | $15"] && a.byModeAndSize["live | $30"] && a.byModeAndSize["paper | $15"]);
    assert.ok(a.byModeAndReason["live | take_profit"] && a.byModeAndReason["live | stop_loss"]);
  });
  it("averages fees/slippage/hold time only over rows that have them; empty input is safe", () => {
    const s = groupStats([row(1, { feesUsd: 0.5, slippageUsd: 0.1, openedAt: 0, timestamp: 120_000 }), row(2)]);
    assert.equal(s.avgFeesUsd, 0.5);
    assert.equal(s.avgHoldMin, 2);
    assert.equal(groupStats([]).n, 0);
  });
  it("trades needed for significance scales with spread/average squared", () => {
    assert.equal(tradesNeededForSignificance(0, 10), null);
    const n = tradesNeededForSignificance(-2, 12)!;
    assert.ok(n > 130 && n < 150, `${n}`);
  });
});
