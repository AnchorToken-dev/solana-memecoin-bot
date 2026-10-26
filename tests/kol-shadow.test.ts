import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_EVAL, buildReport, chaseBucket, evaluateSignal, lagBucket } from "../src/kol/eval.js";
import { extractLeaderboard, loadLeaderboardRanks } from "../src/kol/leaderboard.js";
import { KolShadowLogger, type KolMark, type KolSignalRecord } from "../src/kol/shadowLog.js";
import { KolTradePoller, USDC_MINT, WSOL_MINT, normalizeKolTrade, type KolBuy } from "../src/kol/trades.js";

const W = "9jyqFiLnruggwNn4EQwBNFXwpbLM9hrA4hV59ytyAVVz";
const MINT = "6qsFmXN58Y8YF6wWjNF36FSMh8nvfReo2V9ZmjFppump";

/** Row shaped like the documented example, plus meta.from / meta.to. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tx: "tx1",
    amount: 13720522.13,
    priceUsd: 0.00011062,
    volume: 1517.82,
    volumeSol: 13.08,
    type: "buy",
    wallet: W,
    time: 1_786_471_285_000,
    program: "axiom-flash",
    pools: [],
    identity: { name: "Nach", twitter: "@NachSOL", avatar: "x" },
    meta: {
      from: { address: WSOL_MINT, symbol: "SOL", priceUsd: 116 },
      to: { address: MINT, symbol: "TRUMPSI", priceUsd: 0.00011062, decimals: 6 },
    },
    ...over,
  };
}

function buy(over: Partial<KolBuy> = {}): KolBuy {
  return {
    tx: "tx1", wallet: W, mint: MINT, symbol: "TRUMPSI", kolName: "Nach", kolPriceUsd: 0.0001,
    volumeUsd: 1500, volumeSol: 13, solUsd: 116, tradeTimeMs: 1_000, program: "axiom-flash", ...over,
  };
}

describe("normalizeKolTrade", () => {
  it("accepts a SOL -> token buy and derives SOL price and mint", () => {
    const r = normalizeKolTrade(row());
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.buy.mint, MINT);
    assert.equal(r.buy.kolName, "Nach");
    assert.equal(r.buy.kolPriceUsd, 0.00011062);
    assert.ok(Math.abs(r.buy.solUsd! - 1517.82 / 13.08) < 1e-9);
  });

  it("drops sells, missing meta, base-currency buys and token-for-token swaps", () => {
    assert.deepEqual(normalizeKolTrade(row({ type: "sell" })), { ok: false, reason: "not_buy" });
    assert.deepEqual(normalizeKolTrade(row({ meta: undefined })), { ok: false, reason: "no_meta" });
    assert.deepEqual(
      normalizeKolTrade(row({ meta: { from: { address: MINT }, to: { address: USDC_MINT } } })),
      { ok: false, reason: "bought_base_currency" },
    );
    assert.deepEqual(
      normalizeKolTrade(row({ meta: { from: { address: "SomeOtherToken11111111111111111111111111111" }, to: { address: MINT } } })),
      { ok: false, reason: "paid_with_non_base" },
    );
    assert.deepEqual(normalizeKolTrade(row({ tx: "" })), { ok: false, reason: "bad_fields" });
    assert.deepEqual(normalizeKolTrade(null), { ok: false, reason: "not_object" });
  });

  it("falls back to the row price when meta has none", () => {
    const r = normalizeKolTrade(row({ meta: { from: { address: WSOL_MINT }, to: { address: MINT } } }));
    assert.equal(r.ok && r.buy.kolPriceUsd, 0.00011062);
  });
});

describe("KolTradePoller", () => {
  const mk = (trades: unknown[]) => ({ trades });

  it("first poll only records what exists; later polls emit new buys oldest-first, once", async () => {
    const pages = [
      mk([row({ tx: "old" })]),
      mk([row({ tx: "c" }), row({ tx: "b" }), row({ tx: "old" })]),
      mk([row({ tx: "c" }), row({ tx: "b" })]),
    ];
    let i = 0;
    const got: string[] = [];
    const p = new KolTradePoller({ getKolTrades: async () => pages[i++]! }, (b) => got.push(b.tx), { pollMs: 1000 });
    await p.pollOnce();
    assert.deepEqual(got, []);
    await p.pollOnce();
    assert.deepEqual(got, ["b", "c"]);
    await p.pollOnce();
    assert.deepEqual(got, ["b", "c"]);
    assert.equal(p.stats.buys, 2);
  });

  it("counts rejected rows by reason and ignores non-listed wallets when filtered", async () => {
    const pages = [mk([]), mk([row({ tx: "s", type: "sell" }), row({ tx: "x", wallet: "OtherWallet1111111111111111111111111111111" }), row({ tx: "ok" })])];
    let i = 0;
    const got: string[] = [];
    const p = new KolTradePoller({ getKolTrades: async () => pages[i++]! }, (b) => got.push(b.tx), { pollMs: 1000, onlyWallets: new Set([W]) });
    await p.pollOnce();
    await p.pollOnce();
    assert.deepEqual(got, ["ok"]);
    assert.equal(p.stats.rejected.not_buy, 1);
  });

  it("backs off after an error (honouring retryAfter) and recovers; never throws", async () => {
    let n = 0;
    const err = Object.assign(new Error("rate limited https://x.example/?key=SECRET"), { retryAfter: 20 });
    const p = new KolTradePoller(
      { getKolTrades: async () => { if (n++ === 0) throw err; return mk([]); } },
      () => undefined,
      { pollMs: 3000 },
    );
    await p.pollOnce();
    assert.equal(p.stats.errors, 1);
    assert.ok(!p.stats.lastError!.includes("SECRET"));
    assert.ok((p as unknown as { backoffMs: number }).backoffMs >= 20_000);
    await p.pollOnce();
    assert.equal((p as unknown as { backoffMs: number }).backoffMs, 0);
  });

  it("flags a possible gap when every returned row is new", async () => {
    const pages = [mk([row({ tx: "a" })]), mk([row({ tx: "n1" }), row({ tx: "n2" })])];
    let i = 0;
    const p = new KolTradePoller({ getKolTrades: async () => pages[i++]! }, () => undefined, { pollMs: 1000 });
    await p.pollOnce();
    await p.pollOnce();
    assert.equal(p.stats.possibleGaps, 1);
  });
});

/** Manual clock + timers so samples fire on command. */
function harness(prices: Array<KolMark | null | "throw">, opts: { maxActive?: number; offsetsS?: number[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kol-"));
  let t = 1_000_000;
  const timers: { at: number; fn: () => void; id: number; dead: boolean }[] = [];
  let nextId = 1;
  let reads = 0;
  const logger = new KolShadowLogger({
    dir,
    maxActive: opts.maxActive ?? 25,
    offsetsS: opts.offsetsS ?? [5, 30],
    readCacheMs: 0,
    now: () => t,
    setTimer: (fn, ms) => { const x = { at: t + ms, fn, id: nextId++, dead: false }; timers.push(x); return x; },
    clearTimer: (x) => { (x as { dead: boolean }).dead = true; },
    reader: {
      async read() {
        const v = prices[Math.min(reads++, prices.length - 1)];
        if (v === "throw") throw new Error("rpc down");
        return v ?? null;
      },
    },
    ranks: new Map([[W, 3]]),
  });
  const advance = async (ms: number) => {
    const target = t + ms;
    for (;;) {
      const due = timers.filter((x) => !x.dead && x.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.dead = true;
      t = due.at;
      due.fn();
      await new Promise((r) => setImmediate(r));
    }
    t = target;
  };
  const lines = (): KolSignalRecord[] => {
    try {
      const d = join(dir, "signals");
      return readdirSync(d).flatMap((f) => readFileSync(join(d, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as KolSignalRecord));
    } catch {
      return [];
    }
  };
  return { dir, logger, advance, lines, setNow: (v: number) => { t = v; }, clean: () => rmSync(dir, { recursive: true, force: true }) };
}

const m = (p: number, venue = "bonding_curve", r = 40): KolMark => ({ priceSol: p, venue, quoteReserveSol: r });

describe("KolShadowLogger", () => {
  it("samples at the offsets and writes one complete line, with rank and lag", async () => {
    const h = harness([m(1e-7), m(1.1e-7), m(1.3e-7)]);
    try {
      await h.logger.onBuy(buy({ tradeTimeMs: 1_000_000 - 4_000 }));
      assert.equal(h.logger.activeCount, 1);
      await h.advance(5_000);
      assert.equal(h.logger.activeCount, 1);
      await h.advance(25_000);
      await h.logger.flush();
      const l = h.lines();
      assert.equal(l.length, 1);
      assert.equal(l[0]!.rank, 3);
      assert.equal(l[0]!.lagMs, 4_000);
      assert.equal(l[0]!.venue, "bonding_curve");
      assert.deepEqual(l[0]!.samples.map((s) => s[0]), [0, 5_000, 30_000]);
      assert.deepEqual(l[0]!.samples.map((s) => s[1]), [1e-7, 1.1e-7, 1.3e-7]);
      assert.equal(l[0]!.partial, undefined);
    } finally {
      h.clean();
    }
  });

  it("keeps a buy the pump reader can't price when the feed already has a fill, and names a priceless miss", async () => {
    const h = harness([null], { maxActive: 1 });
    try {
      await h.logger.onBuy(buy({ program: "axiom-flash" }));
      await h.logger.flush();
      assert.equal(h.logger.stats.unreadable, 0);
      assert.equal(h.logger.stats.loggedUnpriced, 1);
      assert.equal(h.logger.activeCount, 0);
      const line = h.lines()[0]!;
      assert.equal(line.venue, "unpriced");
      assert.equal(line.program, "axiom-flash");
      assert.equal(line.unpriced, true);
      assert.ok(Math.abs(line.samples[0]![1] - 0.0001 / 116) < 1e-12);
      await h.logger.onBuy(buy({ tx: "tx2", program: "axiom-flash" }));
      await h.logger.flush();
      assert.equal(h.logger.stats.loggedUnpriced, 2); // cached: no second pump read, buy still kept
      const router = "RouterNew111111111111111111111111111111111";
      await h.logger.onBuy(buy({ tx: "tx3", mint: "OtherMint111111111111111111111111111111111", kolPriceUsd: null, solUsd: null, priceSol: null, program: null, programIds: [router] }));
      assert.equal(h.logger.stats.unreadable, 1);
      assert.match(h.logger.lastUnreadable ?? "", /reason=no_pump_or_pumpswap_mark/);
      assert.match(h.logger.lastUnreadable ?? "", new RegExp(router));
    } finally {
      h.clean();
    }
    const h2 = harness([m(1e-7)], { maxActive: 1 });
    try {
      await h2.logger.onBuy(buy({ tx: "a", mint: "MintAAAA" }));
      await h2.logger.onBuy(buy({ tx: "b", mint: "MintBBBB" }));
      assert.equal(h2.logger.stats.droppedBusy, 1);
      await h2.logger.onBuy(buy({ tx: "a", mint: "MintAAAA" }));
      assert.equal(h2.logger.stats.duplicates, 1);
    } finally {
      h2.clean();
    }
  });

  it("survives read errors mid-way (sample missing, line still written) and writes partial on flush", async () => {
    const h = harness([m(1e-7), "throw", m(1.2e-7)]);
    try {
      await h.logger.onBuy(buy());
      await h.advance(40_000);
      await h.logger.flush();
      const l = h.lines();
      assert.equal(l.length, 1);
      assert.equal(l[0]!.samples.length, 2);
      assert.equal(h.logger.stats.sampleReadFails, 1);
    } finally {
      h.clean();
    }
    const h2 = harness([m(1e-7), m(1.1e-7)]);
    try {
      await h2.logger.onBuy(buy());
      await h2.advance(6_000);
      await h2.logger.flush();
      const l = h2.lines();
      assert.equal(l.length, 1);
      assert.equal(l[0]!.partial, true);
      assert.equal(l[0]!.samples.length, 2);
    } finally {
      h2.clean();
    }
  });
});

function sig(samples: KolSignalRecord["samples"], over: Partial<KolSignalRecord> = {}): KolSignalRecord {
  return {
    v: 1, kind: "kol_signal", at: 0, tx: "t" + Math.random(), wallet: W, rank: 1, kol: "Nach", mint: MINT, symbol: "X", program: null,
    kolPriceUsd: 0.0001, solUsd: 100, volumeUsd: 1000, tradeTimeMs: 0, lagMs: 3_000, venue: "bonding_curve", samples, ...over,
  };
}

describe("KOL evaluation", () => {
  it("measures gross and net return from the entry sample, and the chase vs the KOL price", () => {
    // KOL price 0.0001 USD at $100/SOL = 1e-6 SOL. Our entry sample (3 s) is 1.2e-6 -> 20% chase.
    const s = sig([[0, 1.1e-6, 40], [3_000, 1.2e-6, 40], [13_000, 1.32e-6, 40], [33_000, 1.08e-6, 40], [63_000, 1.2e-6, 40]]);
    const e = evaluateSignal(s, DEFAULT_EVAL)!;
    assert.ok(e);
    assert.equal(e.entryMs, 3_000);
    assert.ok(Math.abs(e.chasePct! - 20) < 1e-6);
    assert.ok(Math.abs(e.gross.get(10_000)! - 10) < 1e-6);
    assert.ok(Math.abs(e.gross.get(30_000)! - -10) < 1e-6);
    assert.ok(e.costPct > 3 && e.costPct < 12, `cost ${e.costPct}`);
    assert.equal(e.gross.get(240_000), null);
  });

  it("returns null with no sample near the entry delay; stop/tp walk uses the sampled price", () => {
    assert.equal(evaluateSignal(sig([[0, 1e-6], [60_000, 1e-6]]), DEFAULT_EVAL), null);
    const tp = evaluateSignal(sig([[3_000, 1e-6], [10_000, 1.05e-6], [20_000, 1.2e-6]]), DEFAULT_EVAL)!;
    assert.equal(tp.strat!.reason, "tp");
    assert.ok(Math.abs(tp.strat!.grossPct - 20) < 1e-6);
    const stop = evaluateSignal(sig([[3_000, 1e-6], [10_000, 0.7e-6], [20_000, 1.3e-6]]), DEFAULT_EVAL)!;
    assert.equal(stop.strat!.reason, "stop");
    assert.ok(Math.abs(stop.strat!.grossPct - -30) < 1e-6);
    const partial = evaluateSignal(sig([[3_000, 1e-6], [20_000, 1.01e-6]]), DEFAULT_EVAL)!;
    assert.equal(partial.strat, null);
    const time = evaluateSignal(sig([[3_000, 1e-6], [100_000, 1.02e-6], [290_000, 1.03e-6]]), DEFAULT_EVAL)!;
    assert.equal(time.strat!.reason, "time");
  });

  it("buckets and report: keeps the fuller of two lines for one signal, groups by lag/chase/wallet", () => {
    assert.equal(lagBucket(1_000), "lag <5s");
    assert.equal(lagBucket(20_000), "lag 15-60s");
    assert.equal(chaseBucket(null), "chase unknown");
    assert.equal(chaseBucket(5), "chase 0-10%");
    const full = sig([[3_000, 1e-6], [10_000, 1.2e-6]], { tx: "same" });
    const partial = { ...full, samples: [[3_000, 1e-6]] as KolSignalRecord["samples"], partial: true as const };
    const rep = buildReport([partial, full, sig([[3_000, 1e-6], [10_000, 0.5e-6]], { tx: "other" })], DEFAULT_EVAL, 1);
    assert.equal(rep.signalsRead, 2);
    assert.equal(rep.signalsUsable, 2);
    assert.equal(rep.strategy.overall.n, 2);
    assert.equal(rep.strategy.byWallet.length, 1);
    assert.equal(rep.strategy.byReason.tp, 1);
    assert.equal(rep.strategy.byReason.stop, 1);
  });
});

describe("leaderboard helpers", () => {
  it("extracts wallets in order, skips junk and duplicates, and reads ranks back from the saved file", () => {
    const resp = { traders: [{ wallet: W, identity: { name: "Nach", twitter: "@n" }, pnl: { total: 5 } }, { wallet: "short" }, { wallet: W }, { wallet: "5jFQdYm76BsyEDQqnfwN9Hfc5YWCS81U2hM5hDLjcQYL" }], pagination: {} };
    const e = extractLeaderboard(resp);
    assert.deepEqual(e.map((x) => [x.rank, x.wallet.slice(0, 4), x.name]), [[1, "9jyq", "Nach"], [2, "5jFQ", null]]);
    const dir = mkdtempSync(join(tmpdir(), "kol-lb-"));
    try {
      writeFileSync(join(dir, "leaderboard.json"), JSON.stringify({ entries: e }));
      const r = loadLeaderboardRanks(join(dir, "leaderboard.json"));
      assert.equal(r.get(W), 1);
      assert.equal(loadLeaderboardRanks(join(dir, "missing.json")).size, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    assert.deepEqual(extractLeaderboard({ nope: 1 }), []);
  });
});

describe("KolShadowLogger fixes (Oct 12 review)", () => {
  it("a throwing reader doesn't leak the slot; finished coins are dropped from the reader", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kolfix-"));
    const dropped: string[] = [];
    let throwNext = true;
    const timers: (() => void)[] = [];
    const logger = new KolShadowLogger({
      reader: {
        read: async () => {
          if (throwNext) { throwNext = false; throw new Error("rpc down"); }
          return { priceSol: 1e-6, venue: "pumpswap" } as KolMark;
        },
        drop: (m) => dropped.push(m),
      },
      dir,
      offsetsS: [1],
      maxActive: 1,
      readCacheMs: 0,
      setTimer: (fn) => { timers.push(fn); return timers.length; },
      clearTimer: () => undefined,
    });
    await logger.onBuy(buy({ tx: "t1", mint: "M1" }));
    assert.equal(logger.activeCount, 0, "slot released after throw");
    await logger.onBuy(buy({ tx: "t2", mint: "M2" }));
    assert.equal(logger.activeCount, 1);
    timers.forEach((f) => f());
    await new Promise((r) => setTimeout(r, 20));
    await logger.flush();
    assert.equal(logger.activeCount, 0);
    assert.deepEqual(dropped, ["M2"]);
    rmSync(dir, { recursive: true, force: true });
  });
});
