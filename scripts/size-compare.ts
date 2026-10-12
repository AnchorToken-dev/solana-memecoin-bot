/**
 * Summary of the $15-vs-shadow-size comparison:
 *   npx tsx scripts/size-compare.ts [data/size-compare.jsonl]
 */
import { readFileSync } from "node:fs";
import { summarizeSizeCompare, type SizeCompareRow } from "../src/sim/sizeCompare.js";

const file = process.argv[2] ?? "data/size-compare.jsonl";
const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as SizeCompareRow);
const s = summarizeSizeCompare(rows, true, rows[0]?.shadowUsd ?? 0, file);
console.log(JSON.stringify(s, null, 2));
const byReason = new Map<string, { n: number; real: number; shadow: number }>();
for (const r of rows) {
  const b = byReason.get(r.reason) ?? { n: 0, real: 0, shadow: 0 };
  b.n++; b.real += r.real.pnlUsd; b.shadow += r.shadow.pnlUsd;
  byReason.set(r.reason, b);
}
for (const [k, b] of byReason) console.log(`${k.padEnd(18)} n=${b.n}  real $${b.real.toFixed(2)}  shadow $${b.shadow.toFixed(2)}  (2x real would be $${(2 * b.real).toFixed(2)})`);
