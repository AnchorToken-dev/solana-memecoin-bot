/**
 * Read-only chart series from existing journal rows.
 * Does not record anything and does not affect entries, exits, or sizing.
 *
 * Equity is cumulative realized P&L (USD). Journal rows do not store equity.
 * Win rate uses decided closes only (pnlUsd > 0 win, < 0 loss), same as
 * period winPct. Hours with no decided closes are omitted, not returned as 0%.
 */
import { JOURNAL_TZ_DEFAULT, getZonedParts } from "./timezone.js";

/** Fields the charts need. Full journal entries are compatible. */
export interface JournalChartRow {
  timestamp: number;
  openedAt?: number;
  pnlUsd: number;
}

export interface JournalEquityPoint {
  /** Close time (epoch ms), except a leading 0 point at the first open when earlier. */
  timestamp: number;
  cumulativePnlUsd: number;
}

export interface JournalHourWinRate {
  /** 0–23 in the chart timezone. */
  hour: number;
  /** "12 AM" … "11 PM" */
  label: string;
  decidedCount: number;
  winCount: number;
  lossCount: number;
  /** wins / decided * 100. Always defined: empty hours are not in this list. */
  winPct: number;
}

export interface JournalWinLoss {
  winCount: number;
  lossCount: number;
  breakevenCount: number;
  /** Mean pnlUsd of winning closes. null when there are no wins. */
  averageWinUsd: number | null;
  /** Mean pnlUsd of losing closes (negative). null when there are no losses — not 0. */
  averageLossUsd: number | null;
  /** averageWin / |averageLoss|. null when either side is missing. */
  payoffRatio: number | null;
}

export interface JournalCharts {
  timezone: string;
  /**
   * Journal does not store account equity. Points are cumulative realized P&L
   * after each close, oldest first.
   */
  equityBasis: "cumulative_realized_pnl_usd";
  equity: JournalEquityPoint[];
  /** Close-time hour in `timezone`. Hours with zero decided trades are absent. */
  winRateByHour: JournalHourWinRate[];
  /** Local hours 0–23 with no decided closes. Not a 0% win rate. */
  skippedHours: number[];
  winLoss: JournalWinLoss;
}

function hourLabel(hour: number): string {
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12} ${hour < 12 ? "AM" : "PM"}`;
}

function localHour(ms: number, timeZone: string): number | null {
  const raw = getZonedParts(ms, timeZone).hour;
  const hour = raw === 24 ? 0 : raw;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  return hour;
}

export function computeJournalCharts(
  entries: readonly JournalChartRow[],
  opts?: { timeZone?: string },
): JournalCharts {
  const timeZone = opts?.timeZone ?? JOURNAL_TZ_DEFAULT;
  const ordered = entries
    .map((e, i) => ({ e, i }))
    .filter(
      ({ e }) => Number.isFinite(e.timestamp) && Number.isFinite(e.pnlUsd),
    )
    .sort((a, b) => a.e.timestamp - b.e.timestamp || a.i - b.i);

  const equity: JournalEquityPoint[] = [];
  let cumulative = 0;
  if (ordered.length > 0) {
    const first = ordered[0]!.e;
    const opened = first.openedAt;
    if (
      typeof opened === "number" &&
      Number.isFinite(opened) &&
      opened > 0 &&
      opened < first.timestamp
    ) {
      equity.push({ timestamp: opened, cumulativePnlUsd: 0 });
    }
  }
  for (const { e } of ordered) {
    cumulative += e.pnlUsd;
    equity.push({ timestamp: e.timestamp, cumulativePnlUsd: cumulative });
  }

  const byHour = Array.from({ length: 24 }, () => ({ wins: 0, losses: 0 }));
  let winSum = 0;
  let winCount = 0;
  let lossSum = 0;
  let lossCount = 0;
  let breakevenCount = 0;

  for (const { e } of ordered) {
    if (e.pnlUsd > 0) {
      winCount += 1;
      winSum += e.pnlUsd;
    } else if (e.pnlUsd < 0) {
      lossCount += 1;
      lossSum += e.pnlUsd;
    } else {
      breakevenCount += 1;
    }
    if (e.pnlUsd === 0) continue;
    const hour = localHour(e.timestamp, timeZone);
    if (hour == null) continue;
    if (e.pnlUsd > 0) byHour[hour]!.wins += 1;
    else byHour[hour]!.losses += 1;
  }

  const winRateByHour: JournalHourWinRate[] = [];
  const skippedHours: number[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const wins = byHour[hour]!.wins;
    const losses = byHour[hour]!.losses;
    const decided = wins + losses;
    if (decided <= 0) {
      skippedHours.push(hour);
      continue;
    }
    winRateByHour.push({
      hour,
      label: hourLabel(hour),
      decidedCount: decided,
      winCount: wins,
      lossCount: losses,
      winPct: (wins / decided) * 100,
    });
  }

  const averageWinUsd = winCount > 0 ? winSum / winCount : null;
  const averageLossUsd = lossCount > 0 ? lossSum / lossCount : null;
  const payoffRatio =
    averageWinUsd != null &&
    averageLossUsd != null &&
    averageLossUsd !== 0
      ? averageWinUsd / Math.abs(averageLossUsd)
      : null;

  return {
    timezone: timeZone,
    equityBasis: "cumulative_realized_pnl_usd",
    equity,
    winRateByHour,
    skippedHours,
    winLoss: {
      winCount,
      lossCount,
      breakevenCount,
      averageWinUsd,
      averageLossUsd,
      payoffRatio,
    },
  };
}
