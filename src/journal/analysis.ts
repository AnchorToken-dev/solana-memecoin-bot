/**
 * Plain-numbers analysis of closed trades (journal rows): win rate, average win
 * vs loss, the win rate needed to break even at THOSE averages, and whether the
 * average result is distinguishable from zero given how few trades there are.
 *
 * Used by scripts/trade-analysis.ts. Pure functions, no I/O.
 */
export interface AnalysisRow {
  mode?: string;
  sizeUsd: number;
  tradeSizeUsd?: number | null;
  pnlUsd: number;
  /** Realized % of entry size (net of costs). */
  pnlPct: number;
  exitReason: string;
  feesUsd?: number;
  slippageUsd?: number;
  openedAt?: number;
  timestamp?: number;
}

export interface GroupStats {
  n: number;
  wins: number;
  winRatePct: number;
  totalPnlUsd: number;
  avgPnlUsd: number;
  avgPnlPct: number;
  avgWinPct: number | null;
  avgLossPct: number | null;
  /** Win rate needed to break even given the average win and loss above (null if no wins or no losses). */
  breakEvenWinRatePct: number | null;
  /** 95% confidence interval of the average pnlPct (normal approximation). null when n < 2. */
  ci95Pct: [number, number] | null;
  /** "positive"/"negative" only when the whole 95% interval is on one side of zero. */
  verdict: "positive" | "negative" | "inconclusive";
  avgFeesUsd: number | null;
  avgSlippageUsd: number | null;
  avgHoldMin: number | null;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

export function groupStats(rows: readonly AnalysisRow[]): GroupStats {
  const n = rows.length;
  if (n === 0) {
    return { n: 0, wins: 0, winRatePct: 0, totalPnlUsd: 0, avgPnlUsd: 0, avgPnlPct: 0, avgWinPct: null, avgLossPct: null, breakEvenWinRatePct: null, ci95Pct: null, verdict: "inconclusive", avgFeesUsd: null, avgSlippageUsd: null, avgHoldMin: null };
  }
  const pct = rows.map((r) => r.pnlPct);
  const winsPct = rows.filter((r) => r.pnlPct > 0).map((r) => r.pnlPct);
  const lossPct = rows.filter((r) => r.pnlPct <= 0).map((r) => r.pnlPct);
  const avgPct = mean(pct);
  let ci: [number, number] | null = null;
  if (n >= 2) {
    const sd = Math.sqrt(pct.reduce((a, x) => a + (x - avgPct) ** 2, 0) / (n - 1));
    const half = 1.96 * (sd / Math.sqrt(n));
    ci = [avgPct - half, avgPct + half];
  }
  const avgWin = winsPct.length ? mean(winsPct) : null;
  const avgLoss = lossPct.length ? mean(lossPct) : null;
  const opt = <T>(xs: (T | undefined)[]): T[] => xs.filter((x): x is T => x !== undefined && Number.isFinite(x as number));
  const fees = opt(rows.map((r) => r.feesUsd));
  const slip = opt(rows.map((r) => r.slippageUsd));
  const holds = rows
    .filter((r) => r.openedAt != null && r.timestamp != null && r.timestamp >= r.openedAt)
    .map((r) => (r.timestamp! - r.openedAt!) / 60_000);
  return {
    n,
    wins: winsPct.length,
    winRatePct: (winsPct.length / n) * 100,
    totalPnlUsd: rows.reduce((a, r) => a + r.pnlUsd, 0),
    avgPnlUsd: mean(rows.map((r) => r.pnlUsd)),
    avgPnlPct: avgPct,
    avgWinPct: avgWin,
    avgLossPct: avgLoss,
    breakEvenWinRatePct: avgWin != null && avgLoss != null && avgWin - avgLoss > 0 ? (-avgLoss / (avgWin - avgLoss)) * 100 : null,
    ci95Pct: ci,
    verdict: ci ? (ci[0] > 0 ? "positive" : ci[1] < 0 ? "negative" : "inconclusive") : "inconclusive",
    avgFeesUsd: fees.length ? mean(fees) : null,
    avgSlippageUsd: slip.length ? mean(slip) : null,
    avgHoldMin: holds.length ? mean(holds) : null,
  };
}

const keyOf = <T>(rows: readonly T[], f: (r: T) => string): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = f(r);
    const a = m.get(k);
    if (a) a.push(r);
    else m.set(k, [r]);
  }
  return m;
};

export interface Analysis {
  overall: GroupStats;
  byMode: Record<string, GroupStats>;
  /** key = `${mode} | $${size}` */
  byModeAndSize: Record<string, GroupStats>;
  /** key = `${mode} | ${exitReason}` */
  byModeAndReason: Record<string, GroupStats>;
}

export function sizeBucket(r: AnalysisRow): string {
  const s = r.tradeSizeUsd ?? Math.round(r.sizeUsd);
  return `$${s}`;
}

export function analyzeJournal(rows: readonly AnalysisRow[]): Analysis {
  const mode = (r: AnalysisRow): string => r.mode ?? "paper";
  const toObj = (m: Map<string, AnalysisRow[]>): Record<string, GroupStats> =>
    Object.fromEntries([...m.entries()].sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true })).map(([k, v]) => [k, groupStats(v)]));
  return {
    overall: groupStats(rows),
    byMode: toObj(keyOf(rows, mode)),
    byModeAndSize: toObj(keyOf(rows, (r) => `${mode(r)} | ${sizeBucket(r)}`)),
    byModeAndReason: toObj(keyOf(rows, (r) => `${mode(r)} | ${r.exitReason}`)),
  };
}

/** How many trades are needed before an average of this size and spread could be told from zero. */
export function tradesNeededForSignificance(avgPct: number, sdPct: number): number | null {
  if (!Number.isFinite(avgPct) || !Number.isFinite(sdPct) || avgPct === 0) return null;
  return Math.ceil((1.96 * sdPct / Math.abs(avgPct)) ** 2);
}
