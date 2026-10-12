import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAPER_FEE_DEFAULTS } from "../src/broker/paperFees.js";
import { PaperBroker } from "../src/broker/paper.js";
import { ShadowTape } from "../src/journal/shadowTape.js";
import { SizeCompare } from "../src/sim/sizeCompare.js";
import { evaluateCostGate, roundTripCostPct, breakEvenMovePct, DEFAULT_COST_GATE } from "../src/strategy/costGate.js";
import type { MemoryTrade } from "../src/strategy/memory.js";
import type { BotConfig } from "../src/types.js";

const tmp = () => mkdtempSync(join(tmpdir(), "shadow-"));
const cfg = { paperBroker: { slippageBps: 50, feeBps: 30, fees: { ...PAPER_FEE_DEFAULTS, model: "realistic" } } } as unknown as BotConfig;

describe("ShadowTape", () => {
  it("follows a skipped coin, writes one line with reads + reason, and caps concurrency", async () => {
    const dir = tmp();
    let px = 1;
    const tape = new ShadowTape(dir, { enabled: true, seconds: 2.5, intervalMs: 1_000, maxConcurrent: 2, dedupeMinutes: 30 }, async () => ({ priceUsd: (px *= 1.01), quoteReserveSol: 50 }));
    assert.equal(tape.track({ mint: "A", symbol: "AAA", mode: "paper", reason: "memory", detail: "x" }), true);
    assert.equal(tape.track({ mint: "A", symbol: "AAA", mode: "paper", reason: "memory" }), false, "same coin twice");
    assert.equal(tape.track({ mint: "S", symbol: "SSS", mode: "paper", reason: "no_momentum", priority: "scan" }), false, "scan rejects only get the spare half (1 of 2, already used)");
    assert.equal(tape.track({ mint: "B", symbol: "BBB", mode: "paper", reason: "price_mismatch" }), true);
    assert.equal(tape.track({ mint: "C", symbol: "CCC", mode: "paper", reason: "rug:x" }), false, "cap 2");
    await new Promise((r) => setTimeout(r, 3_500));
    await tape.flush();
    assert.equal(tape.activeCount, 0);
    const f = readdirSync(join(dir, "shadow-tape"));
    const lines = readFileSync(join(dir, "shadow-tape", f[0]!), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    const a = lines.find((l) => l.mint === "A");
    assert.equal(a.kind, "shadow");
    assert.equal(a.reason, "memory");
    assert.ok(a.reads.length >= 3, `reads ${a.reads.length}`);
    assert.equal(a.reads[0][2], 50);
    assert.equal(a.endedBy, "done");
    rmSync(dir, { recursive: true, force: true });
  });

  it("stops after repeated unreadable reads; dispose leaves no timers", async () => {
    const dir = tmp();
    const tape = new ShadowTape(dir, { enabled: true, seconds: 300, intervalMs: 1_000, maxConcurrent: 4, dedupeMinutes: 30 }, async () => null);
    tape.track({ mint: "D", symbol: "D", mode: "paper", reason: "memory" });
    await tape.dispose();
    assert.equal(tape.activeCount, 0);
    assert.equal(tape.track({ mint: "E", symbol: "E", mode: "paper", reason: "memory" }), false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("SizeCompare", () => {
  it("prices the same trade at $30: scaled % fees, bigger slippage, flat network/rent", () => {
    const dir = tmp();
    const broker = new PaperBroker(cfg);
    const sc = new SizeCompare(dir, 30, broker);
    const { fill, position } = broker.applyBuy({ mint: "M", symbol: "M", markPrice: 1, notionalUsd: 15, solUsd: 150, liquidityUsd: 20_000 });
    sc.onBuy(position, { markPrice: 1, solUsd: 150, liquidityUsd: 20_000 });
    const sell = broker.applySell({ position, markPrice: 1.2, reason: "take_profit", solUsd: 150 });
    const row = sc.onSell(position, sell.fill, sell.realizedPnlUsd, 1.2, "take_profit", 150)!;
    assert.ok(row);
    assert.equal(row.realUsd, 15);
    assert.equal(row.shadowUsd, 30);
    assert.ok(row.shadow.entryFill > row.real.entryFill, "more price impact at $30");
    assert.ok(row.shadow.exitFill < row.real.exitFill);
    assert.ok(row.shadow.feesUsd < 2 * row.real.feesUsd, "network + rent don't double");
    assert.ok(row.shadow.slippageUsd > 2 * row.real.slippageUsd, "slippage grows faster than size");
    assert.ok(Math.abs(row.real.pnlUsd - sell.realizedPnlUsd) < 1e-6);
    void fill;
    const s = new SizeCompare(dir, 30, broker).summary();
    assert.equal(s.trades, 1, "reloads from size-compare.jsonl");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("cost gate", () => {
  const f = { runupPct: 5, volSharePct: 10, ageMin: 30, spike: 3, liquidityUsd: 20_000, gapPct: 0, reserveSol: 60 };
  const hist = (mfe: number): MemoryTrade[] => Array.from({ length: 50 }, (_, i) => ({ at: i, symbol: `T${i}`, f: { ...f, runupPct: 5 + (i % 5) }, pnlPct: -5, mfePct: mfe }));
  it("is off by default", () => {
    assert.equal(DEFAULT_COST_GATE.enabled, false);
    assert.equal(evaluateCostGate(hist(1), f, 5, DEFAULT_COST_GATE).skip, false);
  });
  it("skips when similar trades' typical move can't cover costs", () => {
    const p = { ...DEFAULT_COST_GATE, enabled: true };
    assert.equal(evaluateCostGate(hist(2), f, 5, p).skip, true);
    assert.equal(evaluateCostGate(hist(12), f, 5, p).skip, false);
  });
  it("round-trip cost rises with size vs pool depth", () => {
    const fees = { ...PAPER_FEE_DEFAULTS };
    const a = roundTripCostPct(fees, { notionalUsd: 15, solUsd: 150, liquidityUsd: 10_000, flatSlippageBps: 50 });
    const b = roundTripCostPct(fees, { notionalUsd: 15, solUsd: 150, liquidityUsd: 100_000, flatSlippageBps: 50 });
    assert.ok(a > b && b > 0);
    assert.ok(breakEvenMovePct(5) > 5);
  });
});
