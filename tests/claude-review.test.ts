/** Fixes adopted from the Oct 12 external code review (Claude). */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MEMORY, TradeMemory, scoreAgainst, type MemoryFeatures, type MemoryTrade } from "../src/strategy/memory.js";
import { apiTokenGuard, extractToken, tokensMatch } from "../src/api/auth.js";

const f = (runupPct: number): MemoryFeatures => ({ runupPct, volSharePct: 20, ageMin: 30, spike: 20, liquidityUsd: 10_000, gapPct: 0, reserveSol: 90 });
const trade = (runup: number, pnlPct: number, i: number): MemoryTrade => ({ at: i, symbol: `T${i}`, f: f(runup), pnlPct });
const tmp = () => mkdtempSync(join(tmpdir(), "rev-"));

describe("memory persistence (review #4, #5)", () => {
  it("open position's entry features survive a restart and are learned on close", () => {
    const dir = tmp();
    try {
      new TradeMemory(dir, DEFAULT_MEMORY).noteEntry("pos-1", f(33));
      const m2 = new TradeMemory(dir, DEFAULT_MEMORY);
      assert.equal(m2.openCount, 1);
      assert.equal(m2.recordClose("pos-1", { symbol: "X", openedAt: 1, pnlPct: -7 }), true);
      assert.equal(m2.size, 1);
      assert.equal(new TradeMemory(dir, DEFAULT_MEMORY).openCount, 0);
      assert.equal(m2.recordClose("unknown", { symbol: "Y", openedAt: 1, pnlPct: 1 }), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a corrupt memory.json is kept aside, not overwritten", () => {
    const dir = tmp();
    try {
      writeFileSync(join(dir, "memory.json"), "{not json");
      const m = new TradeMemory(dir, DEFAULT_MEMORY);
      m.add(trade(1, 1, 1));
      assert.ok(readdirSync(dir).some((n) => n.startsWith("memory.json.corrupt-")));
      assert.ok(existsSync(join(dir, "memory.json")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("memory tie-break (review #6)", () => {
  it("equal-distance neighbours are the newest trades", () => {
    const h: MemoryTrade[] = [];
    for (let i = 0; i < 40; i++) h.push(trade(50, -20, i));
    for (let i = 0; i < 40; i++) h.push(trade(50, 10, 100 + i));
    const v = scoreAgainst(h, f(50), { ...DEFAULT_MEMORY, neighbors: 40 });
    assert.equal(v.avgPnlPct, 10);
    assert.equal(v.skip, false);
  });
});

describe("optional API token (review §3)", () => {
  const run = (headers: Record<string, string>, method = "POST", path = "/runner/start") => {
    let code = 0;
    let passed = false;
    const res = { status(c: number) { code = c; return this; }, json() { return this; } };
    apiTokenGuard("s3cret")({ method, path, headers } as never, res as never, () => { passed = true; });
    return { code, passed };
  };
  it("blocks without / with a wrong token, allows Bearer and X-API-Token, health stays open", () => {
    assert.deepEqual(run({}), { code: 401, passed: false });
    assert.deepEqual(run({ authorization: "Bearer nope" }), { code: 401, passed: false });
    assert.equal(run({ authorization: "Bearer s3cret" }).passed, true);
    assert.equal(run({ "x-api-token": "s3cret" }).passed, true);
    assert.equal(run({}, "GET", "/health").passed, true);
    assert.equal(tokensMatch(undefined, "x"), false);
    assert.equal(extractToken({ headers: { authorization: "bearer  abc " } } as never), "abc");
  });
});
