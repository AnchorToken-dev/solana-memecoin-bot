/**
 * Walk-forward replay of the entry memory on a price-tape folder:
 *   npx tsx scripts/memory-replay.ts data/price-tape
 * Each trade is scored only against trades that had closed before it was entered. Optimistic:
 * a skipped coin's slot might have gone to another (unknown) trade.
 */
import { DEFAULT_MEMORY, scoreAgainst, seedFromTape } from "../src/strategy/memory.js";

const dir = process.argv[2] ?? "data/price-tape";
const all = seedFromTape(dir);
const p = { ...DEFAULT_MEMORY };
let skipped = 0, skippedPct = 0, skippedWins = 0, skippedCrash = 0, evaluated = 0, evalPct = 0;
for (let i = 0; i < all.length; i++) {
  const t = all[i]!;
  // Only trades already CLOSED when this one was entered (review Oct 12).
  const known = all.slice(0, i).filter((h) => (h.closedAt ?? h.at) <= t.at);
  const v = scoreAgainst(known, t.f, p);
  if (i >= p.minTrades) { evaluated++; evalPct += t.pnlPct; }
  if (v.skip) {
    skipped++; skippedPct += t.pnlPct;
    if (t.pnlPct > 0) skippedWins++;
    if (t.pnlPct <= -15) skippedCrash++;
  }
}
const usd = (pct: number) => (pct / 100) * 15;
console.log(JSON.stringify({
  trades: all.length,
  learningTrades: Math.min(all.length, p.minTrades),
  evaluated,
  skipped,
  skippedWinners: skippedWins,
  skippedSharpLosses: skippedCrash,
  skippedPnlUsdAt15: +usd(skippedPct).toFixed(2),
  avgEvaluatedUsd: +(usd(evalPct) / Math.max(1, evaluated)).toFixed(3),
  avgKeptUsd: +(usd(evalPct - skippedPct) / Math.max(1, evaluated - skipped)).toFixed(3),
}, null, 2));
