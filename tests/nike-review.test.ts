/**
 * Oct 11 paper review (Nike): entry price sanity check, re-entry cooldown,
 * price tape.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { TradeJournal } from "../src/journal/journal.js";
import { PriceTape, fetchGeckoCandles } from "../src/journal/priceTape.js";
import { DEFAULT_ENTRY_PRICE_CHECK, checkEntryPrice } from "../src/risk/entryPriceCheck.js";
import { ReentryCooldownStore, reentryMinutesFor, DEFAULT_REENTRY_COOLDOWN } from "../src/risk/reentryCooldown.js";
import type { OnchainMark } from "../src/market/onchainPrice.js";
import type { MarketDataProvider } from "../src/market/data.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import { loadConfig } from "../src/config.js";

const MINT = "F4UPAURFT4C6UBHE6n7aFnbpgwF13nXu5GdWZ4hcpump";
const SOL_USD = 100;

function baseCfg(dir: string, over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true, bankrollUsd: 100, maxOpenTrades: 1, stopLossPct: 10, takeProfitPct: 25,
    positionSizePct: 0.5, maxPositionUsd: 15,
    momentum: { minPct: 1, windowMinutes: 5, volumeSpikeMult: 1, minLiquidityUsd: 0, minVolume24hUsd: 0, minAgeMinutes: 0 },
    trailingTakeProfit: { activatePct: 15, distancePct: 5 },
    paperBroker: { slippageBps: 0, feeBps: 0 },
    runner: { pollIntervalMs: 10_000, scanLimit: 5, maxCycles: 0 },
    maxHoldMinutes: 0, dailyLossUsd: 0, chaseLockoutHours: 0, marketDataSource: "mock",
    ledgerDir: dir, activePreset: "custom", requireChecklistGo: false, fastExitPollMs: 1000, ...over,
  };
}

const nikeSnap = (over: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  mint: MINT, symbol: "Nike", name: "Nike", priceUsd: 0.00119417, changeWindowPct: 14.42,
  volumeWindowUsd: 46_000, volumeAvgUsd: 1_530, volume24hUsd: 100_000, liquidityUsd: 2_000, timestamp: 0,
  venue: "pumpswap", ...over,
});

function market(snaps: TokenSnapshot[]): MarketDataProvider & { getQuoteUsdRate(): Promise<number> } {
  return { async scan() { return snaps; }, async getPrice() { return snaps[0]?.priceUsd ?? 1; }, async getQuoteUsdRate() { return SOL_USD; } };
}

/** On-chain reader returning a fixed USD price (priceSol = usd / SOL_USD). */
class FixedReader {
  reads = 0;
  constructor(public usd: number | null) {}
  async read(): Promise<OnchainMark | null> {
    this.reads++;
    return this.usd == null ? null : { priceSol: this.usd / SOL_USD, venue: "pumpswap", market: "9vzvRWsYhstjczQYeuoV6jJB88UXtbXti6bv3mtsCRTi", quoteReserveSol: 12.5 };
  }
  drop() {}
}

const tick = (e: BotEngine) => (e as unknown as { tick(n: number): Promise<boolean> }).tick(1);
const noTape = { enabled: false, postExitSeconds: 0, postExitIntervalMs: 5_000, preCandles: false };

function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "nike-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("entry price check (pure)", () => {
  const p = DEFAULT_ENTRY_PRICE_CHECK;
  it("Nike: quote 0.00119 vs chain 0.000024 is rejected", () => {
    const v = checkEntryPrice({ quoteUsd: 0.00119417, onchainUsd: 0.000024, params: p });
    assert.equal(v.ok, false);
    if (!v.ok) assert.ok(v.gapPct! > 4_000);
  });
  it("within ±25% passes, both directions checked", () => {
    assert.equal(checkEntryPrice({ quoteUsd: 1.2, onchainUsd: 1.0, params: p }).ok, true);
    assert.equal(checkEntryPrice({ quoteUsd: 0.8, onchainUsd: 1.0, params: p }).ok, true);
    assert.equal(checkEntryPrice({ quoteUsd: 1.3, onchainUsd: 1.0, params: p }).ok, false);
    assert.equal(checkEntryPrice({ quoteUsd: 0.7, onchainUsd: 1.0, params: p }).ok, false, "0.7 vs 1.0 = 43% apart symmetric");
  });
  it("failed on-chain read fails closed", () => {
    const v = checkEntryPrice({ quoteUsd: 1, onchainUsd: null, params: p, readError: "timeout" });
    assert.equal(v.ok, false);
    if (!v.ok) assert.match(v.detail, /read failed \(timeout\)/);
  });
});

describe("re-entry cooldown (pure + persistence)", () => {
  it("longer after a stop / loss", () => {
    const p = DEFAULT_REENTRY_COOLDOWN;
    assert.equal(reentryMinutesFor("take_profit", 2, p), 30);
    assert.equal(reentryMinutesFor("stop_loss", -1, p), 120);
    assert.equal(reentryMinutesFor("time_stop", -0.5, p), 120);
    assert.equal(reentryMinutesFor("take_profit", 2, { minutes: 0, afterLossMinutes: 0 }), 0);
  });
  it("survives a restart and expires", () =>
    withDir(async (dir) => {
      const a = new ReentryCooldownStore(dir);
      a.block(MINT, "Nike", 30, "after stop_loss", 1_000);
      assert.ok(existsSync(a.filePath));
      const now = Date.now();
      a.block("other", "O", 30, "x", now);
      const b = new ReentryCooldownStore(dir);
      assert.equal(b.get(MINT), null, "old block (t=1000) already expired");
      assert.ok(b.get("other", now + 29 * 60_000));
      assert.equal(b.get("other", now + 31 * 60_000), null);
    }));
});

describe("engine: Nike replay", () => {
  it("check OFF (old behaviour): buys at the stale quote", () =>
    withDir(async (dir) => {
      const c = baseCfg(dir, { priceTape: noTape });
      const ledger = new PaperLedger(c.bankrollUsd, dir);
      const e = new BotEngine(c, { ledger, broker: new PaperBroker(c), journal: new TradeJournal(dir), market: market([nikeSnap()]), solanaRpc: null, solanaWs: null, onchainPrice: new FixedReader(0.000024) as never });
      await tick(e);
      assert.equal(ledger.openPositions.length, 1);
      assert.equal(ledger.openPositions[0]!.entryPrice, 0.00119417);
    }));

  it("check ON: skips the 50x-stale quote and blocks the coin for 10 min", () =>
    withDir(async (dir) => {
      const c = baseCfg(dir, { entryPriceCheck: DEFAULT_ENTRY_PRICE_CHECK, priceTape: noTape });
      const ledger = new PaperLedger(c.bankrollUsd, dir);
      const r = new FixedReader(0.000024);
      const e = new BotEngine(c, { ledger, broker: new PaperBroker(c), journal: new TradeJournal(dir), market: market([nikeSnap()]), solanaRpc: null, solanaWs: null, onchainPrice: r as never });
      await tick(e);
      assert.equal(ledger.openPositions.length, 0);
      const reads = r.reads;
      await tick(e); // second cycle 4s later (Nike re-buy) — blocked without another read
      assert.equal(ledger.openPositions.length, 0);
      assert.equal(r.reads, reads);
      const blocks = new ReentryCooldownStore(dir).list();
      assert.equal(blocks[0]?.reason, "price_mismatch");
    }));

  it("check ON: on-chain read failure → no buy", () =>
    withDir(async (dir) => {
      const c = baseCfg(dir, { entryPriceCheck: DEFAULT_ENTRY_PRICE_CHECK, priceTape: noTape });
      const ledger = new PaperLedger(c.bankrollUsd, dir);
      const e = new BotEngine(c, { ledger, broker: new PaperBroker(c), journal: new TradeJournal(dir), market: market([nikeSnap()]), solanaRpc: null, solanaWs: null, onchainPrice: new FixedReader(null) as never });
      await tick(e);
      assert.equal(ledger.openPositions.length, 0);
    }));

  it("check ON, prices agree: paper fills at the on-chain price, not the quote", () =>
    withDir(async (dir) => {
      const c = baseCfg(dir, { entryPriceCheck: DEFAULT_ENTRY_PRICE_CHECK, priceTape: noTape });
      const ledger = new PaperLedger(c.bankrollUsd, dir);
      const e = new BotEngine(c, { ledger, broker: new PaperBroker(c), journal: new TradeJournal(dir), market: market([nikeSnap()]), solanaRpc: null, solanaWs: null, onchainPrice: new FixedReader(0.0011) as never });
      await tick(e);
      assert.equal(ledger.openPositions.length, 1);
      assert.ok(Math.abs(ledger.openPositions[0]!.entryPrice - 0.0011) < 1e-12);
    }));

  it("re-entry cooldown: no re-buy after a stop-out, also after a restart; tape has entry + exit", () =>
    withDir(async (dir) => {
      const c = baseCfg(dir, {
        entryPriceCheck: DEFAULT_ENTRY_PRICE_CHECK,
        reentryCooldown: DEFAULT_REENTRY_COOLDOWN,
        priceTape: { enabled: true, postExitSeconds: 0, postExitIntervalMs: 5_000, preCandles: false },
      });
      const ledger = new PaperLedger(c.bankrollUsd, dir);
      const r = new FixedReader(0.00119);
      const tape = new PriceTape(dir, c.priceTape!);
      const mk = (l: PaperLedger, t?: PriceTape) =>
        new BotEngine(c, { ledger: l, broker: new PaperBroker(c), journal: new TradeJournal(dir), market: market([nikeSnap()]), solanaRpc: null, solanaWs: null, onchainPrice: r as never, ...(t ? { priceTape: t } : {}) });
      const e = mk(ledger, tape);
      await tick(e);
      assert.equal(ledger.openPositions.length, 1);
      r.usd = 0.00115; // small dip, recorded on the tape
      assert.equal(await e.fastExitTick(), 0);
      r.usd = 0.000024; // the rug
      assert.equal(await e.fastExitTick(), 1);
      assert.equal(ledger.openPositions.length, 0);
      r.usd = 0.00119; // quote and chain agree again — still blocked by the cooldown
      await tick(e);
      assert.equal(ledger.openPositions.length, 0, "no immediate re-buy");
      const l2 = new PaperLedger(c.bankrollUsd, dir);
      const restarted = mk(l2);
      await tick(restarted);
      assert.equal(l2.openPositions.length, 0, "still blocked after a restart");
      const blocks = new ReentryCooldownStore(dir).list();
      assert.equal(blocks.length, 1);
      assert.match(blocks[0]!.reason, /after stop_loss/);
      assert.ok(blocks[0]!.until - Date.now() > 119 * 60_000);

      await tape.flush();
      const files = readdirSync(join(dir, "price-tape"));
      assert.equal(files.length, 1);
      const lines = readFileSync(join(dir, "price-tape", files[0]!), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(lines.map((l) => l.kind), ["entry", "exit"]);
      assert.equal(lines[0].mode, "paper");
      assert.equal(lines[0].quotePrice, 0.00119417);
      assert.ok(Math.abs(lines[0].onchainPrice - 0.00119) < 1e-12);
      assert.equal(lines[0].market, "9vzvRWsYhstjczQYeuoV6jJB88UXtbXti6bv3mtsCRTi");
      assert.equal(lines[1].reason, "stop_loss");
      assert.equal(lines[1].tradeId, lines[0].tradeId);
      assert.ok(lines[1].marks.length >= 2, JSON.stringify(lines[1].marks));
      assert.equal(lines[1].marks.at(-1)[2], "chain");
      assert.equal(lines[1].marks.at(-1)[3], 12.5);
    }));
});

describe("price tape", () => {
  it("post-exit reads + pre-candles are written without blocking", () =>
    withDir(async (dir) => {
      let n = 0;
      const tape = new PriceTape(
        dir,
        { enabled: true, postExitSeconds: 2, postExitIntervalMs: 1_000, preCandles: true },
        {
          readOnchain: async () => ({ priceUsd: 0.000002 + n++ * 1e-9, quoteReserveSol: 1 }),
          fetchCandles: async () => [[1, 1, 2, 0.5, 1.5, 100]],
        },
      );
      const at = Date.now();
      tape.recordEntry({ tradeId: "t1", mint: MINT, symbol: "Nike", mode: "paper", at, fillPrice: 1, quotePrice: 1, onchainPrice: 1, quoteVsOnchainPct: 0, market: "pool", notionalUsd: 15 });
      tape.recordMark("t1", at + 1000, 0.9, "chain", 10);
      tape.recordExit({ tradeId: "t1", at, reason: "stop_loss", fillPrice: 0.9, realizedPnlUsd: -1.5 });
      await new Promise((r) => setTimeout(r, 2_600));
      await tape.flush();
      tape.dispose();
      const f = readdirSync(join(dir, "price-tape"))[0]!;
      const kinds = readFileSync(join(dir, "price-tape", f), "utf8").trim().split("\n").map((l) => JSON.parse(l).kind);
      assert.deepEqual(kinds.sort(), ["entry", "exit", "post_exit", "pre_candles"]);
    }));

  it("gecko candle parser", async () => {
    const fake = (async () => new Response(JSON.stringify({ data: { attributes: { ohlcv_list: [[2, 1, 1, 1, 1, 5], [1, 1, 1, 1, 1, 4], ["bad"]] } } }))) as unknown as typeof fetch;
    assert.deepEqual(await fetchGeckoCandles("pool", 10, 10, fake), [[1, 1, 1, 1, 1, 4], [2, 1, 1, 1, 1, 5]]);
  });

  it("config defaults: check on (25%), cooldown 30/120 min, tape on", () => {
    const keys = ["ENTRY_PRICE_CHECK", "ENTRY_PRICE_MAX_GAP_PCT", "REENTRY_COOLDOWN_MINUTES", "REENTRY_COOLDOWN_AFTER_LOSS_MINUTES", "PRICE_TAPE"];
    const saved = keys.map((k) => process.env[k]);
    try {
      for (const k of keys) delete process.env[k];
      const c = loadConfig({ skipRuntimeOverlay: true } as never);
      assert.deepEqual(c.entryPriceCheck, { enabled: true, maxGapPct: 25, mismatchSkipMinutes: 10, fillAtOnchain: true });
      assert.deepEqual(c.reentryCooldown, { minutes: 30, afterLossMinutes: 120 });
      assert.equal(c.priceTape?.enabled, true);
      process.env.ENTRY_PRICE_CHECK = "false";
      process.env.REENTRY_COOLDOWN_MINUTES = "0";
      const off = loadConfig({ skipRuntimeOverlay: true } as never);
      assert.equal(off.entryPriceCheck?.enabled, false);
      assert.equal(off.reentryCooldown?.minutes, 0);
    } finally {
      keys.forEach((k, i) => (saved[i] == null ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });
});
