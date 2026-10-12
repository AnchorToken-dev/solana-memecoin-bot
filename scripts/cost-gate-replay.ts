/**
 * Walk-forward replay of the expected-cost gate on a price-tape folder:
 *   npx tsx scripts/cost-gate-replay.ts data/price-tape [costPct=5.0] [quantile=0.5]
 * Each trade is judged only against trades that had closed before it was entered.
 * Prints all trades and the newer half separately (the gate must hold up out of sample).
 */
import { DEFAULT_COST_GATE, evaluateCostGate } from "../src/strategy/costGate.js";
import { seedFromTape } from "../src/strategy/memory.js";

const dir = process.argv[2] ?? "data/price-tape";
const costPct = Number(process.argv[3] ?? 5.0);
const quantile = Number(process.argv[4] ?? 0.5);
const all = seedFromTape(dir).sort((a, b) => a.at - b.at);
const p = { ...DEFAULT_COST_GATE, enabled: true, quantile };
const usd = (pct: number) => (pct / 100) * 15;
function run(fromIdx: number) {
  let ev = 0, evPct = 0, sk = 0, skPct = 0;
  for (let i = fromIdx; i < all.length; i++) {
    const t = all[i]!;
    const known = all.slice(0, i).filter((h) => (h.closedAt ?? h.at) <= t.at);
    const v = evaluateCostGate(known, t.f, costPct, p);
    if (v.expectedMovePct == null) continue;
    ev++; evPct += t.pnlPct;
    if (v.skip) { sk++; skPct += t.pnlPct; }
  }
  const kept = ev - sk;
  return {
    evaluated: ev,
    skipped: sk,
    avgUsdAll: ev ? +usd(evPct / ev).toFixed(3) : null,
    avgUsdSkipped: sk ? +usd(skPct / sk).toFixed(3) : null,
    avgUsdKept: kept ? +usd((evPct - skPct) / kept).toFixed(3) : null,
    usdSaved: +(-usd(skPct)).toFixed(2),
  };
}
console.log(JSON.stringify({ trades: all.length, costPct, quantile, all: run(0), newerHalf: run(Math.floor(all.length / 2)) }, null, 2));
