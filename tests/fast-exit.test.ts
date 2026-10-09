/**
 * Fast exits: while holding, the on-chain mark (bonding curve / PumpSwap pool)
 * is read every FAST_EXIT_POLL_MS and TP / trailing / stop act on it at once,
 * instead of waiting on DexScreener (which lagged ~30 s in Oct 2026 tests).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base58Decode, base58Encode } from "../src/solana/base58.js";
import type { AccountInfo, RpcResult } from "../src/solana/rpc.js";
import { canonicalPumpSwapPool, PUMP_CURVE_PROGRAM_ID, PUMPSWAP_PROGRAM_ID, WSOL_MINT } from "../src/live/pumpswapPool.js";
import {
  OnchainPriceReader,
  bondingCurvePda,
  parseBondingCurve,
  reservesPriceSol,
  type OnchainMark,
} from "../src/market/onchainPrice.js";
import { BotEngine, fastExitPollMs } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { TradeJournal } from "../src/journal/journal.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";

const MINT = "6qsFmXN58Y8YF6wWjNF36FSMh8nvfReo2V9ZmjFppump";
const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));

function mintBytes(decimals = 6): Uint8Array {
  const b = new Uint8Array(82);
  b[44] = decimals;
  return b;
}
function curveBytes(vToken: bigint, vSol: bigint, complete = false): Uint8Array {
  const b = Buffer.alloc(150);
  Buffer.from([23, 183, 248, 55, 96, 216, 172, 96]).copy(b, 0);
  b.writeBigUInt64LE(vToken, 8);
  b.writeBigUInt64LE(vSol, 16);
  b[48] = complete ? 1 : 0;
  return new Uint8Array(b);
}
function poolBytes(baseVault: string, quoteVault: string, virtualQuote: bigint, base = MINT): Uint8Array {
  const b = Buffer.alloc(301);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(b, 0);
  Buffer.from(base58Decode(base)).copy(b, 43);
  Buffer.from(base58Decode(WSOL_MINT)).copy(b, 75);
  Buffer.from(base58Decode(baseVault)).copy(b, 139);
  Buffer.from(base58Decode(quoteVault)).copy(b, 171);
  b.writeBigUInt64LE(virtualQuote, 245);
  return new Uint8Array(b);
}
function tokenAcc(amount: bigint): Uint8Array {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return new Uint8Array(b);
}
const acc = (owner: string, data: Uint8Array): AccountInfo => ({ lamports: 1, owner, executable: false, data });

class ChainRpc {
  accounts = new Map<string, AccountInfo | null>();
  calls = 0;
  async getAccountInfo(k: string): Promise<RpcResult<AccountInfo | null>> {
    this.calls++;
    return { ok: true, value: this.accounts.get(k) ?? null };
  }
  async getMultipleAccounts(keys: string[]): Promise<RpcResult<(AccountInfo | null)[]>> {
    this.calls++;
    return { ok: true, value: keys.map((k) => this.accounts.get(k) ?? null) };
  }
}

describe("on-chain price reader", () => {
  it("reads the bonding curve (virtual SOL / virtual tokens)", async () => {
    const rpc = new ChainRpc();
    rpc.accounts.set(MINT, acc("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", mintBytes()));
    // 30 SOL / 1,073M tokens = 2.796e-8 SOL per token (fresh pump.fun curve).
    rpc.accounts.set(bondingCurvePda(MINT), acc(PUMP_CURVE_PROGRAM_ID, curveBytes(1_073_000_000_000_000n, 30_000_000_000n)));
    const r = new OnchainPriceReader(rpc);
    const m = (await r.read(MINT))!;
    assert.equal(m.venue, "bonding_curve");
    assert.ok(Math.abs(m.priceSol - 30 / 1_073_000_000) < 1e-15);
    assert.deepEqual(parseBondingCurve(curveBytes(1n, 2n, true)), { virtualTokenReserves: 1n, virtualSolReserves: 2n, complete: true });
    assert.equal(parseBondingCurve(new Uint8Array(60)), null);
    assert.equal(reservesPriceSol(0n, 5n, 6), null);
  });

  it("switches to the PumpSwap pool (real + virtual quote) once the curve completes", async () => {
    const rpc = new ChainRpc();
    const pool = canonicalPumpSwapPool(MINT);
    rpc.accounts.set(MINT, acc("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", mintBytes()));
    rpc.accounts.set(bondingCurvePda(MINT), acc(PUMP_CURVE_PROGRAM_ID, curveBytes(1_000_000_000_000_000n, 50_000_000_000n)));
    rpc.accounts.set(pool, acc(PUMPSWAP_PROGRAM_ID, poolBytes(key(10), key(11), 17_584_496_629n)));
    rpc.accounts.set(key(10), acc("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", tokenAcc(53_850_000_000_000n))); // 53.85M
    rpc.accounts.set(key(11), acc("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", tokenAcc(309_700_000_000n))); // 309.7 SOL
    const r = new OnchainPriceReader(rpc);
    assert.equal((await r.read(MINT))!.venue, "bonding_curve");
    rpc.accounts.set(bondingCurvePda(MINT), acc(PUMP_CURVE_PROGRAM_ID, curveBytes(0n, 0n, true)));
    const m = (await r.read(MINT))!;
    assert.equal(m.venue, "pumpswap");
    const want = (309.7 + 17.584496629) / 53_850_000;
    assert.ok(Math.abs(m.priceSol / want - 1) < 1e-9, `${m.priceSol} vs ${want}`);
  });

  it("returns null (caller falls back to Dex) for unknown / foreign accounts", async () => {
    const rpc = new ChainRpc();
    rpc.accounts.set(MINT, acc("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", mintBytes()));
    const r = new OnchainPriceReader(rpc);
    assert.equal(await r.read(MINT), null);
    // Pool for another mint at the derived address → refused.
    rpc.accounts.set(canonicalPumpSwapPool(MINT), acc(PUMPSWAP_PROGRAM_ID, poolBytes(key(10), key(11), 0n, key(9))));
    assert.equal(await r.read(MINT), null);
    // Curve PDA owned by someone else → refused.
    rpc.accounts.set(bondingCurvePda(MINT), acc(key(5), curveBytes(1_000n, 1_000n)));
    assert.equal(await r.read(MINT), null);
  });
});

function cfg(dir: string, over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true,
    bankrollUsd: 100,
    maxOpenTrades: 1,
    stopLossPct: 10,
    takeProfitPct: 25,
    positionSizePct: 0.5,
    maxPositionUsd: 50,
    momentum: { minPct: 1, windowMinutes: 5, volumeSpikeMult: 1, minLiquidityUsd: 0, minVolume24hUsd: 0, minAgeMinutes: 0 },
    trailingTakeProfit: { activatePct: 15, distancePct: 5 },
    paperBroker: { slippageBps: 0, feeBps: 0 },
    runner: { pollIntervalMs: 10_000, scanLimit: 5, maxCycles: 0 },
    maxHoldMinutes: 0,
    dailyLossUsd: 0,
    chaseLockoutHours: 0,
    marketDataSource: "mock",
    ledgerDir: dir,
    activePreset: "custom",
    requireChecklistGo: false,
    fastExitPollMs: 1000,
    ...over,
  };
}

/** DexScreener-like: stuck at the entry price (stale). Never offers a new coin. */
function staleDex(): MarketDataProvider & { getQuoteUsdRate(): Promise<number> } {
  return {
    async scan(): Promise<TokenSnapshot[]> { return []; },
    async getPrice() { return 1; },
    async getQuoteUsdRate() { return 100; },
  };
}

/** Fake on-chain reader: prices in SOL (×100 = USD). */
class FakeReader {
  reads = 0;
  constructor(private readonly seq: (number | null)[]) {}
  async read(_mint: string): Promise<OnchainMark | null> {
    const v = this.seq[Math.min(this.reads, this.seq.length - 1)] ?? null;
    this.reads++;
    return v == null ? null : { priceSol: v, venue: "pumpswap" };
  }
  drop() {}
}

function setup(over: Partial<BotConfig>, reader: FakeReader | null) {
  const dir = mkdtempSync(join(tmpdir(), "fast-exit-"));
  const c = cfg(dir, over);
  const ledger = new PaperLedger(c.bankrollUsd, dir);
  const broker = new PaperBroker(c);
  const engine = new BotEngine(c, {
    ledger,
    broker,
    journal: new TradeJournal(dir),
    market: staleDex(),
    solanaRpc: null,
    solanaWs: null,
    onchainPrice: reader as never,
  });
  const { fill, position } = broker.applyBuy({ mint: MINT, symbol: "PAUL", markPrice: 1, notionalUsd: 15 });
  ledger.recordBuy(fill, position);
  return { dir, engine, ledger };
}

describe("engine: fast exit ticks", () => {
  it("take-profit fires on the on-chain spike while Dex still shows entry", async () => {
    const r = new FakeReader([0.0126]); // $1.26 = +26%
    const { dir, engine, ledger } = setup({}, r);
    try {
      assert.equal(await engine.fastExitTick(), 1);
      assert.equal(ledger.openPositions.length, 0);
      const sell = ledger.getTrades(1).at(-1)!.fill;
      assert.equal(sell.side, "sell");
      assert.ok(Math.abs(sell.price - 1.26) < 1e-9, String(sell.price));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("PAUL case: +60% spike then fade — trailing arms on the spike and sells on the giveback", async () => {
    // TP off so only the trail acts; +60% → +58% → +50% (below 60 × 0.95 = 52%).
    const r = new FakeReader([0.016, 0.0158, 0.015]);
    const { dir, engine, ledger } = setup({ takeProfitPct: 0 }, r);
    try {
      assert.equal(await engine.fastExitTick(), 0);
      assert.equal(ledger.openPositions[0]!.trailArmed, true);
      assert.equal(ledger.openPositions[0]!.highWaterPrice, 1.6);
      assert.equal(await engine.fastExitTick(), 0);
      assert.equal(await engine.fastExitTick(), 1);
      const sell = ledger.getTrades(1).at(-1)!.fill;
      assert.ok(sell.price > 1.49, `closed green at ${sell.price}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stop-loss acts on the on-chain dump", async () => {
    const r = new FakeReader([0.0085]); // -15%
    const { dir, engine, ledger } = setup({}, r);
    try {
      assert.equal(await engine.fastExitTick(), 1);
      assert.equal(ledger.getTrades(1).at(-1)!.fill.side, "sell");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("no on-chain read → fast tick does nothing (full tick keeps the Dex fallback)", async () => {
    const off = setup({}, null);
    const nul = setup({}, new FakeReader([null]));
    try {
      assert.equal(await off.engine.fastExitTick(), 0);
      assert.equal(await nul.engine.fastExitTick(), 0);
      assert.equal(off.ledger.openPositions.length, 1);
      assert.equal(nul.ledger.openPositions.length, 1);
    } finally {
      rmSync(off.dir, { recursive: true, force: true });
      rmSync(nul.dir, { recursive: true, force: true });
    }
  });

  it("runner: sells within ~1 fast tick of the spike, well before the next 3 s full tick", async () => {
    // First (full-tick) read flat, then the spike.
    const r = new FakeReader([0.01, 0.0126]);
    const { dir, engine, ledger } = setup({ fastExitPollMs: 250 }, r);
    try {
      assert.equal((await engine.start()).ok, true);
      const t0 = Date.now();
      while (ledger.openPositions.length > 0 && Date.now() - t0 < 2500) await new Promise((res) => setTimeout(res, 20));
      const took = Date.now() - t0;
      await engine.stop();
      assert.equal(ledger.openPositions.length, 0, "sold");
      assert.ok(took < 1500, `took ${took}ms`);
      assert.equal(ledger.getTrades(1).at(-1)!.fill.price, 1.26);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("FAST_EXIT_POLL_MS: 0 = off, small values clamp to 250 ms, default 1000", () => {
    const base = cfg("/tmp/x");
    assert.equal(fastExitPollMs({ ...base, fastExitPollMs: 0 }), 0);
    assert.equal(fastExitPollMs({ ...base, fastExitPollMs: 10 }), 250);
    assert.equal(fastExitPollMs({ ...base, fastExitPollMs: undefined }), 1000);
  });
});
