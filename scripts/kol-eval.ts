/**
 * Evaluate the KOL shadow log: would following KOL buys have made money after costs?
 *
 *   npx tsx scripts/kol-eval.ts                         # data/kol/signals/*.jsonl
 *   npx tsx scripts/kol-eval.ts --dir path/to/kol --size 30 --stop 12 --tp 15 --entry-delay 3
 *   npx tsx scripts/kol-eval.ts --min-wallet-n 8 --json
 *
 * Read-only. Prints return after costs at several holding times, a stop/take-profit walk-through,
 * and breakdowns by feed delay, how far the price had already run ("chase"), venue and wallet.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PAPER_FEE_DEFAULTS } from "../src/broker/paperFees.js";
import { DEFAULT_EVAL, buildReport, type EvalOptions } from "../src/kol/eval.js";
import type { KolSignalRecord } from "../src/kol/shadowLog.js";
import { tradesNeededForSignificance, type GroupStats } from "../src/journal/analysis.js";

const args = process.argv.slice(2);
const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const numArg = (n: string, d: number) => { const v = Number(val(n)); return val(n) !== undefined && Number.isFinite(v) ? v : d; };

const dir = val("--dir") ?? "data/kol";
const sigDir = join(dir, "signals");
if (!existsSync(sigDir)) {
  console.error(`No signals folder at ${sigDir}. Run scripts/kol-shadow.ts first.`);
  process.exit(1);
}
const signals: KolSignalRecord[] = [];
let badLines = 0;
for (const f of readdirSync(sigDir).filter((x) => x.endsWith(".jsonl")).sort()) {
  for (const line of readFileSync(join(sigDir, f), "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as KolSignalRecord;
      if (r && r.kind === "kol_signal" && Array.isArray(r.samples)) signals.push(r);
    } catch {
      badLines++;
    }
  }
}
const opts: EvalOptions = {
  ...DEFAULT_EVAL,
  fees: { ...PAPER_FEE_DEFAULTS },
  sizeUsd: numArg("--size", DEFAULT_EVAL.sizeUsd),
  stopPct: numArg("--stop", DEFAULT_EVAL.stopPct),
  tpPct: numArg("--tp", DEFAULT_EVAL.tpPct),
  entryDelayMs: numArg("--entry-delay", DEFAULT_EVAL.entryDelayMs / 1000) * 1000,
  maxHoldMs: numArg("--max-hold", DEFAULT_EVAL.maxHoldMs / 1000) * 1000,
};
const report = buildReport(signals, opts, numArg("--min-wallet-n", 5));
if (args.includes("--json")) {
  console.log(JSON.stringify(report, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v), 2));
  process.exit(0);
}

const f = (x: number | null | undefined, d = 1, sign = true) => (x == null || !Number.isFinite(x) ? "n/a" : `${sign && x > 0 ? "+" : ""}${x.toFixed(d)}`);
const line = (label: string, s: GroupStats) =>
  `  ${label.padEnd(16)} n=${String(s.n).padStart(4)}  win ${f(s.winRatePct, 0, false).padStart(3)}%  avg ${f(s.avgPnlPct).padStart(6)}%  95% ${s.ci95Pct ? `${f(s.ci95Pct[0])} to ${f(s.ci95Pct[1])}` : "n/a"}  ${s.verdict}`;

console.log(`KOL shadow evaluation — ${signals.length} signal line(s)${badLines ? `, ${badLines} unreadable line(s) skipped` : ""}`);
console.log(`Trade size $${opts.sizeUsd} · entry ${opts.entryDelayMs / 1000}s after the signal reaches us · round-trip cost model: paper defaults`);
console.log(`Usable signals: ${report.signalsUsable} of ${report.signalsRead} (${report.skippedNoEntrySample} had no price sample near the entry time)`);
console.log(`Average round-trip cost ${f(report.avgCostPct, 1, false)}% · median feed delay ${report.medianLagMs == null ? "n/a" : (report.medianLagMs / 1000).toFixed(1) + " s"} · median price already run vs the KOL's fill: ${f(report.medianChasePct)}%`);

console.log("\nHold for a fixed time (after costs; gross = before costs):");
for (const h of report.horizons) {
  console.log(line(`${h.horizonS}s net`, h.net) + `   | gross avg ${f(h.gross.avgPnlPct)}%`);
}

console.log(`\nStop ${opts.stopPct}% / take-profit ${opts.tpPct}% / time exit ${opts.maxHoldMs / 1000}s (sparse samples, so rough):`);
const st = report.strategy;
console.log(line("all signals", st.overall));
console.log(`  exits: ${Object.entries(st.byReason).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
const sd = st.overall.n >= 2 && st.overall.ci95Pct ? ((st.overall.ci95Pct[1] - st.overall.ci95Pct[0]) / 2 / 1.96) * Math.sqrt(st.overall.n) : null;
const need = sd != null ? tradesNeededForSignificance(st.overall.avgPnlPct, sd) : null;
if (need != null) console.log(`  about ${need} signals would be needed to tell this average from zero at the current spread`);

for (const [title, g] of [["By feed delay", st.byLag], ["By how far the price had already run", st.byChase], ["By venue", st.byVenue]] as const) {
  console.log(`\n${title}:`);
  for (const [k, s] of Object.entries(g).sort()) console.log(line(k, s));
}
console.log(`\nBy wallet (at least ${numArg("--min-wallet-n", 5)} signals; best first):`);
if (st.byWallet.length === 0) console.log("  none yet");
for (const w of st.byWallet.slice(0, 15)) console.log(line(`${w.kol ?? w.wallet.slice(0, 6)}`, w.stats));
console.log("\nReminder: a group only counts if its 95% range is entirely above zero AND it holds up on data you didn't use to choose it. Wallet rows especially: with many wallets, a few look good by luck.");
