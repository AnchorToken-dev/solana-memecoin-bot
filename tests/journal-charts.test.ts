import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeJournalCharts } from "../src/journal/charts.js";
import { TradeJournal } from "../src/journal/journal.js";
import type { Position } from "../src/types.js";

const TZ = "America/New_York";

function pos(id: string): Position {
  return {
    id,
    mint: `Mint${id}`,
    symbol: id,
    side: "long",
    qty: 1,
    entryPrice: 1,
    entryNotionalUsd: 10,
    entryFeesUsd: 0,
    highWaterPrice: 1,
    trailArmed: false,
    openedAt: 1,
  };
}

describe("journal charts", () => {
  it("empty journal has no equity points and no fake 0% hours", () => {
    const charts = computeJournalCharts([], { timeZone: TZ });
    assert.equal(charts.equityBasis, "cumulative_realized_pnl_usd");
    assert.equal(charts.timezone, TZ);
    assert.deepEqual(charts.equity, []);
    assert.deepEqual(charts.winRateByHour, []);
    assert.equal(charts.skippedHours.length, 24);
    assert.equal(charts.winLoss.winCount, 0);
    assert.equal(charts.winLoss.lossCount, 0);
    assert.equal(charts.winLoss.breakevenCount, 0);
    assert.equal(charts.winLoss.averageWinUsd, null);
    assert.equal(charts.winLoss.averageLossUsd, null);
    assert.equal(charts.winLoss.payoffRatio, null);
  });

  it("equity is cumulative realized P&L in close order, starting flat at open", () => {
    const charts = computeJournalCharts(
      [
        { timestamp: 3_000, openedAt: 2_500, pnlUsd: -4 },
        { timestamp: 2_000, openedAt: 1_000, pnlUsd: 10 },
        { timestamp: 4_000, openedAt: 3_500, pnlUsd: 2 },
      ],
      { timeZone: TZ },
    );
    assert.deepEqual(
      charts.equity.map((p) => [p.timestamp, p.cumulativePnlUsd]),
      [
        [1_000, 0],
        [2_000, 10],
        [3_000, 6],
        [4_000, 8],
      ],
    );
  });

  it("skips hours with no decided trades and buckets by America/New_York close time", () => {
    // 2026-01-15 04:30 UTC = 2026-01-14 23:30 EST → 11 PM
    const late = Date.parse("2026-01-15T04:30:00.000Z");
    // 2026-07-15 04:30 UTC = 2026-07-15 00:30 EDT → 12 AM
    const early = Date.parse("2026-07-15T04:30:00.000Z");
    // 2026-01-15 17:00 UTC = 12:00 EST → 12 PM, breakeven only
    const noon = Date.parse("2026-01-15T17:00:00.000Z");
    const charts = computeJournalCharts(
      [
        { timestamp: late, openedAt: late - 1_000, pnlUsd: 8 },
        { timestamp: late + 60_000, openedAt: late, pnlUsd: -2 },
        { timestamp: early, openedAt: early - 1_000, pnlUsd: 4 },
        { timestamp: noon, openedAt: noon - 1_000, pnlUsd: 0 },
      ],
      { timeZone: TZ },
    );
    assert.deepEqual(
      charts.winRateByHour.map((h) => [h.hour, h.label, h.winPct, h.decidedCount]),
      [
        [0, "12 AM", 100, 1],
        [23, "11 PM", 50, 2],
      ],
    );
    assert.ok(charts.skippedHours.includes(12));
    assert.equal(
      charts.winRateByHour.some((h) => h.winPct === 0 && h.decidedCount === 0),
      false,
    );
    assert.equal(charts.winLoss.breakevenCount, 1);
    assert.equal(charts.winLoss.winCount, 2);
    assert.equal(charts.winLoss.lossCount, 1);
  });

  it("average win vs average loss ignores breakeven and does not invent a $0 side", () => {
    const both = computeJournalCharts(
      [
        { timestamp: 1, pnlUsd: 10 },
        { timestamp: 2, pnlUsd: 20 },
        { timestamp: 3, pnlUsd: -4 },
        { timestamp: 4, pnlUsd: -8 },
        { timestamp: 5, pnlUsd: 0 },
      ],
      { timeZone: TZ },
    );
    assert.equal(both.winLoss.averageWinUsd, 15);
    assert.equal(both.winLoss.averageLossUsd, -6);
    assert.equal(both.winLoss.payoffRatio, 2.5);

    const winsOnly = computeJournalCharts(
      [{ timestamp: 1, pnlUsd: 5 }],
      { timeZone: TZ },
    );
    assert.equal(winsOnly.winLoss.averageWinUsd, 5);
    assert.equal(winsOnly.winLoss.averageLossUsd, null);
    assert.equal(winsOnly.winLoss.payoffRatio, null);
  });

  it("list charts use every stored row, not the page", () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-charts-"));
    try {
      const j = new TradeJournal(dir);
      j.appendClose({
        position: { ...pos("a"), openedAt: 1_000 },
        exitPrice: 2,
        pnlUsd: 10,
        exitReason: "take_profit",
        fillId: "fa",
        timestamp: 2_000,
      });
      j.appendClose({
        position: { ...pos("b"), openedAt: 3_000 },
        exitPrice: 0.5,
        pnlUsd: -4,
        exitReason: "stop_loss",
        fillId: "fb",
        timestamp: 4_000,
      });
      const page = j.list({ limit: 1, offset: 0, timeZone: TZ });
      assert.equal(page.entries.length, 1);
      assert.equal(page.total, 2);
      assert.equal(page.charts.equity.at(-1)?.cumulativePnlUsd, 6);
      assert.equal(page.charts.winLoss.winCount, 1);
      assert.equal(page.charts.winLoss.lossCount, 1);
      assert.equal(page.charts.winLoss.averageWinUsd, 10);
      assert.equal(page.charts.winLoss.averageLossUsd, -4);
      assert.equal(page.charts.timezone, TZ);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
