/**
 * Per-filter value report from the shadow tape (skipped coins) + price tape (bought coins):
 *   npx tsx scripts/filter-report.ts data   # the mode's ledger dir
 * For each skip reason: how many coins, how far they ran in the next 5 min, and what a
 * $15 paper trade (TP +15% / SL -8% / exit at the end, ~5% round-trip costs) would have made.
 * A filter "earns its keep" when its skipped coins would have done worse than the coins we bought.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "data";
const TP = 15, SL = -8, COST = 5.0;
type R = [number, number, number?];
function sim(p0: number, reads: R[]): { pnlPct: number; maxPct: number } {
  let maxPct = 0;
  let exit: number | null = null;
  for (const [, px] of reads) {
    const ch = (px / p0 - 1) * 100;
    maxPct = Math.max(maxPct, ch);
    if (exit == null && (ch >= TP || ch <= SL)) exit = ch;
  }
  const last = reads.length ? (reads[reads.length - 1]![1] / p0 - 1) * 100 : 0;
  return { pnlPct: (exit ?? last) - COST, maxPct };
}
function lines(sub: string): Record<string, unknown>[] {
  const d = join(dir, sub);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith(".jsonl")).sort().flatMap((f) =>
    readFileSync(join(d, f), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>));
}
const groups = new Map<string, { pnl: number[]; max: number[] }>();
for (const l of lines("shadow-tape")) {
  const reads = (l.reads ?? []) as R[];
  if (reads.length < 3) continue;
  const s = sim(reads[0]![1], reads.slice(1));
  const g = groups.get(String(l.reason)) ?? { pnl: [], max: [] };
  g.pnl.push(s.pnlPct); g.max.push(s.maxPct);
  groups.set(String(l.reason), g);
}
// Bought coins, same yardstick: first 5 min of hold marks.
const ent = new Map<string, Record<string, unknown>>();
const bought = { pnl: [] as number[], max: [] as number[] };
for (const l of lines("price-tape")) {
  if (l.kind === "entry") ent.set(String(l.tradeId), l);
  else if (l.kind === "exit") {
    const e = ent.get(String(l.tradeId));
    const marks = ((l.marks ?? []) as [number, number][]).filter((m) => m[0] <= 300_000).map((m) => [m[0], m[1]] as R);
    if (!e || marks.length < 3) continue;
    const s = sim(Number(e.fillPrice), marks);
    bought.pnl.push(s.pnlPct); bought.max.push(s.maxPct);
  }
}
const med = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)]! : NaN; };
const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
const row = (name: string, g: { pnl: number[]; max: number[] }) =>
  `${name.padEnd(26)} n=${String(g.pnl.length).padStart(4)}  median 5-min high +${med(g.max).toFixed(1)}%  ` +
  `hit +15%: ${((g.max.filter((m) => m >= TP).length / (g.max.length || 1)) * 100).toFixed(0)}%  ` +
  `sim $/trade ${((avg(g.pnl) / 100) * 15).toFixed(2)}`;
console.log(row("BOUGHT (reference)", bought));
for (const [k, g] of [...groups].sort((a, b) => b[1].pnl.length - a[1].pnl.length)) console.log(row(k, g));
