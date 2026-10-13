/**
 * Train / evaluate the soft-rug model from price-tape files.
 *
 *   npm run softrug:train -- <tape dir or file> [--label -10] [--out models/softrug-model.json] [--no-write]
 *
 * Prints a chronological hold-out report FIRST (fit on the earliest 70% of
 * trades, replay on the latest 30%), then fits on everything and writes the model.
 * If the hold-out range includes zero, the model has not shown an edge - keep
 * SOFT_RUG_MODE=shadow.
 */
import { DEFAULT_TRAIN, evaluateHoldout, featureUse, fitModel, loadTapeTrades } from "../src/strategy/softRugTrain.js";
import { saveModel } from "../src/strategy/softRug.js";

const args = process.argv.slice(2);
const flag = (n: string): string | undefined => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : undefined;
};
const dir = args.find((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1]!.startsWith("--")));
if (!dir) {
  console.error("usage: npm run softrug:train -- <price-tape dir or file> [--label -10] [--out path] [--no-write]");
  process.exit(2);
}
const labelPct = Number(flag("--label") ?? DEFAULT_TRAIN.labelPct);
const out = flag("--out") ?? "models/softrug-model.json";
const cfg = { ...DEFAULT_TRAIN, labelPct };
const trades = loadTapeTrades(dir);
console.log(`Loaded ${trades.length} closed trades from ${dir}; label = net result <= ${labelPct}%`);
if (trades.length < 40) {
  console.error("Too few trades to train or evaluate (need 40+).");
  process.exit(1);
}
const r = evaluateHoldout(trades, cfg);
const f = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
console.log(`\nHOLD-OUT (train ${r.trainTrades} earliest trades, test ${r.testTrades} latest, ${r.testSamples} score points)`);
console.log(`  loss-tail rate in test: ${(r.lossTailRate * 100).toFixed(0)}%   AUC per read: ${r.sampleAuc?.toFixed(3) ?? "n/a"}   AUC per trade (max score): ${r.tradeAuc?.toFixed(3) ?? "n/a"}   (0.5 = coin flip)`);
console.log(`  no rule: avg ${f(r.baselineAvg.mean)}% [${f(r.baselineAvg.lo)}, ${f(r.baselineAvg.hi)}]`);
for (const x of r.rows) {
  console.log(
    `  sell at score >= ${x.threshold.toFixed(1)}: triggered ${String(x.triggered).padStart(3)} (${x.triggeredWereLossTail} were loss tails)  avg ${f(x.avg.mean)}%  change vs no rule ${f(x.delta.mean)} [${f(x.delta.lo)}, ${f(x.delta.hi)}]`,
  );
}
console.log("  --- compare: no model, just a tighter plain stop on the same test trades ---");
for (const x of r.tighterStops) {
  console.log(`  sell when ${x.stopPct}% below entry: triggered ${String(x.triggered).padStart(3)}  change vs no rule ${f(x.delta.mean)} [${f(x.delta.lo)}, ${f(x.delta.hi)}]`);
}
const model = fitModel(trades, cfg);
console.log(`\nFull-data model: ${model.stumps.length} stumps from ${model.trainedOn.samples} points (${(model.trainedOn.positiveRate * 100).toFixed(0)}% positive). Most used: ${featureUse(model).slice(0, 4).map((u) => `${u.name}(${u.stumps})`).join(", ")}`);
if (args.includes("--no-write")) {
  console.log("--no-write: model not saved.");
} else {
  saveModel(out, model);
  console.log(`Saved ${out}`);
}
