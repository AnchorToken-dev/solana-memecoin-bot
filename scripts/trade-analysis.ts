/**
 * Read-only analysis of your closed trades.
 *
 *   npx tsx scripts/trade-analysis.ts                       # data/journal.json, all modes
 *   npx tsx scripts/trade-analysis.ts path/to/journal.json
 *   npx tsx scripts/trade-analysis.ts --mode live           # live | live_dry_run | paper | all
 *   npx tsx scripts/trade-analysis.ts --json                # machine-readable
 *
 * Answers: is the average trade actually above zero (or just noise)? what win
 * rate would break even at your real average win/loss? how do different trade
 * sizes and exit reasons compare? how far is LIVE from PAPER?
 */
import { existsSync, readFileSync } from "node:fs";
import { analyzeJournal, groupStats, tradesNeededForSignificance, type AnalysisRow, type GroupStats } from "../src/journal/analysis.js";

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(n);
const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const path = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--mode") ?? "data/journal.json";
const modeFilter = val("--mode") ?? "all";

if (!existsSync(path)) {
  console.error(`Not found: ${path}`);
  process.exit(1);
}
const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
if (!Array.isArray(raw)) {
  console.error("Expected journal.json to be a JSON array of closed trades");
  process.exit(1);
}
const rows: AnalysisRow[] = raw
  .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
  .map((r) => ({
    mode: typeof r.mode === "string" ? r.mode : "paper",
    sizeUsd: Number(r.sizeUsd),
    tradeSizeUsd: typeof r.tradeSizeUsd === "number" ? r.tradeSizeUsd : null,
    pnlUsd: Number(r.pnlUsd),
    pnlPct: Number(r.pnlPct),
    exitReason: String(r.exitReason ?? "unknown"),
    ...(typeof r.feesUsd === "number" ? { feesUsd: r.feesUsd } : {}),
    ...(typeof r.slippageUsd === "number" ? { slippageUsd: r.slippageUsd } : {}),
    ...(typeof r.openedAt === "number" ? { openedAt: r.openedAt } : {}),
    ...(typeof r.timestamp === "number" ? { timestamp: r.timestamp } : {}),
  }))
  .filter((r) => Number.isFinite(r.pnlUsd) && Number.isFinite(r.pnlPct) && Number.isFinite(r.sizeUsd))
  .filter((r) => modeFilter === "all" || r.mode === modeFilter);

const a = analyzeJournal(rows);
if (flag("--json")) {
  console.log(JSON.stringify(a, null, 2));
  process.exit(0);
}

const f = (v: number | null, d = 1, suf = "") => (v == null ? "  n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}${suf}`);
function line(label: string, s: GroupStats): string {
  const ci = s.ci95Pct ? `[${s.ci95Pct[0].toFixed(1)}, ${s.ci95Pct[1].toFixed(1)}]` : "n/a";
  return [
    label.padEnd(28),
    String(s.n).padStart(4),
    `${s.winRatePct.toFixed(0)}%`.padStart(5),
    f(s.avgPnlPct, 1, "%").padStart(8),
    ci.padStart(16),
    f(s.avgPnlUsd, 2).padStart(8),
    f(s.totalPnlUsd, 2).padStart(9),
    (s.breakEvenWinRatePct == null ? "n/a" : `${s.breakEvenWinRatePct.toFixed(0)}%`).padStart(6),
    s.verdict.padStart(13),
  ].join("  ");
}
const head = ["group".padEnd(28), "n".padStart(4), "win%".padStart(5), "avg%".padStart(8), "95% CI of avg%".padStart(16), "avg $".padStart(8), "total $".padStart(9), "b/e".padStart(6), "verdict".padStart(13)].join("  ");
const section = (title: string, obj: Record<string, GroupStats>) => {
  console.log(`\n${title}\n${head}`);
  for (const [k, s] of Object.entries(obj)) console.log(line(k, s));
};

console.log(`Trades analysed: ${rows.length}  (file: ${path}, mode: ${modeFilter})`);
if (rows.length === 0) process.exit(0);
console.log(`\nb/e = win rate needed to break even at that group's own average win and loss.`);
console.log(`verdict is "positive"/"negative" only when the 95% interval of avg% is entirely above/below zero.`);
section("By mode", a.byMode);
section("By mode and trade size", a.byModeAndSize);
section("By mode and exit reason", a.byModeAndReason);

// Live vs paper, by exit reason
const modes = Object.keys(a.byMode);
if (modes.includes("live") && modes.includes("paper")) {
  console.log("\nLIVE minus PAPER, average % per trade, by exit reason (negative = live did worse than the paper model):");
  const reasons = new Set(Object.keys(a.byModeAndReason).map((k) => k.split(" | ")[1]!));
  for (const r of reasons) {
    const l = a.byModeAndReason[`live | ${r}`];
    const p = a.byModeAndReason[`paper | ${r}`];
    if (l && p) console.log(`  ${r.padEnd(24)} live ${f(l.avgPnlPct, 1, "%")} (n=${l.n})  paper ${f(p.avgPnlPct, 1, "%")} (n=${p.n})  gap ${f(l.avgPnlPct - p.avgPnlPct, 1, " pts")}`);
  }
}

// How many more trades before the verdict could change
for (const [mode, s] of Object.entries(a.byMode)) {
  if (s.n < 2) continue;
  const sub = rows.filter((r) => (r.mode ?? "paper") === mode);
  const sd = Math.sqrt(sub.reduce((acc, r) => acc + (r.pnlPct - s.avgPnlPct) ** 2, 0) / (sub.length - 1));
  const need = tradesNeededForSignificance(s.avgPnlPct, sd);
  console.log(`\n${mode}: ${s.n} trades, average ${f(s.avgPnlPct, 1, "%")} per trade, spread (sd) ${sd.toFixed(1)} pts.` + (need ? ` At this average and spread you'd need roughly ${need} trades before an average this size could be told from zero.` : ""));
  if (s.verdict === "inconclusive") console.log(`  -> Not enough data to say whether the average is above or below zero.`);
}
void groupStats;
