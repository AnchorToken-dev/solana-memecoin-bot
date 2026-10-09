/**
 * Graduated (PumpSwap) rug checks. Numbers mirror the 2026-10-09 incidents:
 * TRUMPSI pool held 53.85M of 1B (5.4%) and BUNKER 42.24M (4.2%) at our buy,
 * while ~41% / ~40% of supply sat outside the pool and was dumped minutes later.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base58Decode, base58Encode } from "../src/solana/base58.js";
import type { AccountInfo, LargestTokenAccount, ParsedMint, RpcResult, SignatureInfo } from "../src/solana/rpc.js";
import { canonicalPumpSwapPool, PUMPSWAP_PROGRAM_ID, WSOL_MINT } from "../src/live/pumpswapPool.js";
import {
  INCINERATOR_ADDRESS,
  PUMP_FUN_PROGRAM_ID,
  RUG_FILTER_REASONS,
  RUG_FILTER_SKIPPED,
  RUG_FILTER_TRANSIENT_FAIL_MS,
  RugVerdictCache,
  runRugFilter,
  type RugFilterRpc,
} from "../src/risk/rugFilter.js";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { TradeJournal } from "../src/journal/journal.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";
import { loadConfig } from "../src/config.js";

const MINT = "6qsFmXN58Y8YF6wWjNF36FSMh8nvfReo2V9ZmjFppump"; // TRUMPSI
const POOL = canonicalPumpSwapPool(MINT);
const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SUPPLY = 1_000_000_000_000_000n; // 1B tokens, 6 decimals
const M = 1_000_000_000_000n; // 1M tokens in base units
const key = (n: number) => base58Encode(new Uint8Array(32).fill(n));
const VAULT = key(200);
const QUOTE_VAULT = key(201);

function poolBytes(base: string, quote: string, baseVault: string): Uint8Array {
  const b = Buffer.alloc(301);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(b, 0);
  Buffer.from(base58Decode(base)).copy(b, 43);
  Buffer.from(base58Decode(quote)).copy(b, 75);
  Buffer.from(base58Decode(baseVault)).copy(b, 139);
  Buffer.from(base58Decode(QUOTE_VAULT)).copy(b, 171);
  return new Uint8Array(b);
}
function tokenAcc(holder: string, amount: bigint): Uint8Array {
  const b = Buffer.alloc(165);
  Buffer.from(base58Decode(MINT)).copy(b, 0);
  Buffer.from(base58Decode(holder)).copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  return new Uint8Array(b);
}
const acc = (owner: string, data: Uint8Array): AccountInfo => ({ lamports: 1, owner, executable: false, data });

interface Holding { ta: string; holder: string; amount: bigint; holderProgram?: string | null }

class GradRpc implements RugFilterRpc {
  accounts = new Map<string, AccountInfo | null>();
  largest: LargestTokenAccount[] = [];
  sigs: SignatureInfo[] = Array.from({ length: 1000 }, (_, i) => ({ signature: `s${i}`, slot: 100 + i, err: null, blockTime: i }));
  failKeys = new Set<string>();
  batch = true;
  calls: string[] = [];
  mint: ParsedMint = { supply: SUPPLY, decimals: 6, mintAuthority: null, freezeAuthority: null };

  constructor(poolAmount: bigint | null, holdings: Holding[]) {
    this.accounts.set(POOL, acc(PUMPSWAP_PROGRAM_ID, poolBytes(MINT, WSOL_MINT, VAULT)));
    if (poolAmount != null) this.accounts.set(VAULT, acc(TOKEN, tokenAcc(POOL, poolAmount)));
    const rows: LargestTokenAccount[] = poolAmount != null ? [{ address: VAULT, amount: poolAmount, decimals: 6 }] : [];
    for (const h of holdings) {
      this.accounts.set(h.ta, acc(TOKEN, tokenAcc(h.holder, h.amount)));
      if (h.holderProgram !== null) this.accounts.set(h.holder, acc(h.holderProgram ?? SYSTEM, new Uint8Array(0)));
      rows.push({ address: h.ta, amount: h.amount, decimals: 6 });
    }
    rows.sort((a, b) => (a.amount > b.amount ? -1 : 1));
    this.largest = rows.slice(0, 20);
  }
  async getMintAccount(): Promise<RpcResult<ParsedMint | null>> {
    this.calls.push("mint");
    return { ok: true, value: this.mint };
  }
  async getTokenLargestAccounts() {
    this.calls.push("largest");
    return { ok: true as const, value: this.largest };
  }
  async getAccountInfo(k: string): Promise<RpcResult<AccountInfo | null>> {
    this.calls.push(`acct:${k.slice(0, 6)}`);
    if (this.failKeys.has(k)) return { ok: false, error: "429" };
    return { ok: true, value: this.accounts.get(k) ?? null };
  }
  async getSignaturesForAddress() {
    this.calls.push("sigs");
    return { ok: true as const, value: this.sigs };
  }
}
class GradRpcBatch extends GradRpc {
  async getMultipleAccounts(keys: string[]): Promise<RpcResult<(AccountInfo | null)[]>> {
    this.calls.push(`multi:${keys.length}`);
    if (keys.some((k) => this.failKeys.has(k))) return { ok: false, error: "429" };
    return { ok: true, value: keys.map((k) => this.accounts.get(k) ?? null) };
  }
}

function input(rpc: RugFilterRpc, over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    rpc,
    mint: MINT,
    symbol: "TRUMPSI",
    maxTopHolderPct: 30,
    maxSameSlotBuys: 3,
    venue: "pumpswap" as const,
    gradMinPoolPct: 15,
    gradMaxHolderPct: 10,
    gradMaxTop10Pct: 35,
    ...over,
  };
}
/** n wallets, each holding `eachPct` % of the 1B supply. */
function wallets(n: number, eachPct: number, start = 1): Holding[] {
  return Array.from({ length: n }, (_, i) => ({ ta: key(start + i), holder: key(100 + start + i), amount: BigInt(Math.round(eachPct * 1000)) * ((10n * M) / 1000n) }));
}

describe("rug filter: graduated PumpSwap coins", () => {
  it("TRUMPSI at buy: pool 5.4%, one wallet 41% → blocked (holder concentration)", async () => {
    const rpc = new GradRpcBatch(53_850n * M / 1000n, [{ ta: key(1), holder: key(101), amount: 410n * M }, ...wallets(19, 0.5, 2)]);
    const d = await runRugFilter(input(rpc));
    assert.equal(d.allow, false);
    assert.equal(d.reason, RUG_FILTER_REASONS.gradHolder);
    assert.ok(Math.abs(d.metrics!.poolPct - 5.385) < 0.01, String(d.metrics!.poolPct));
    assert.equal(d.metrics!.topHolderPct, 41);
    // Concentration fails before the same-slot check — no "truncated" pass is possible.
    assert.ok(!rpc.calls.includes("sigs"));
  });

  it("same supply split across 10 wallets (4.1% each) → blocked by top-10", async () => {
    const rpc = new GradRpcBatch(53_850n * M / 1000n, [...wallets(10, 4.1), ...wallets(9, 2, 20)]);
    const d = await runRugFilter(input(rpc));
    assert.equal(d.reason, RUG_FILTER_REASONS.gradTop10);
    assert.equal(d.metrics!.top10Pct, 41);
  });

  it("BUNKER at buy: pool 4.2% with dispersed holders → blocked (pool share low)", async () => {
    const rpc = new GradRpcBatch(42_240n * M / 1000n, wallets(19, 1.5));
    const d = await runRugFilter(input(rpc));
    assert.equal(d.reason, RUG_FILTER_REASONS.gradPoolThin);
    assert.match(d.detail, /pool 4\.2%/);
  });

  it("healthy graduated coin passes; the pool vault (largest holder) is excluded", async () => {
    const rpc = new GradRpcBatch(206n * M, [...wallets(10, 2.5), ...wallets(9, 1, 30)]);
    const d = await runRugFilter(input(rpc));
    assert.equal(d.allow, true, d.detail);
    assert.equal(d.metrics!.poolPct, 20.6);
    assert.equal(d.metrics!.topHolderPct, 2.5);
    assert.equal(d.metrics!.top10Pct, 25);
    assert.ok(d.skipped.includes(RUG_FILTER_SKIPPED.sameSlotTruncated));
    // Batched: mint, pool, largest, 2× getMultipleAccounts, sigs.
    assert.equal(rpc.calls.filter((c) => c.startsWith("multi:")).length, 2);
  });

  it("works without getMultipleAccounts (per-account fallback)", async () => {
    const rpc = new GradRpc(206n * M, wallets(10, 2.5));
    const d = await runRugFilter(input(rpc));
    assert.equal(d.allow, true, d.detail);
  });

  it("one wallet with several token accounts is summed", async () => {
    const holder = key(150);
    const rpc = new GradRpcBatch(206n * M, [
      { ta: key(1), holder, amount: 60n * M },
      { ta: key(2), holder, amount: 60n * M },
      ...wallets(5, 1, 10),
    ]);
    const d = await runRugFilter(input(rpc));
    assert.equal(d.reason, RUG_FILTER_REASONS.gradHolder);
    assert.equal(d.metrics!.topHolderPct, 12);
  });

  it("incinerator and leftover pump.fun curve accounts are excluded; other pools are not", async () => {
    const burned = { ta: key(1), holder: INCINERATOR_ADDRESS, amount: 300n * M };
    const curve = { ta: key(2), holder: key(102), amount: 200n * M, holderProgram: PUMP_FUN_PROGRAM_ID };
    const ok = await runRugFilter(input(new GradRpcBatch(206n * M, [burned, curve, ...wallets(5, 2, 10)])));
    assert.equal(ok.allow, true, ok.detail);
    const otherPool = { ta: key(3), holder: key(103), amount: 150n * M, holderProgram: PUMPSWAP_PROGRAM_ID };
    const bad = await runRugFilter(input(new GradRpcBatch(206n * M, [otherPool, ...wallets(5, 2, 10)])));
    assert.equal(bad.reason, RUG_FILTER_REASONS.gradHolder);
  });

  it("a holder wallet with no account (0 SOL) counts as a wallet, not an RPC error", async () => {
    const rpc = new GradRpcBatch(206n * M, [{ ta: key(1), holder: key(101), amount: 120n * M, holderProgram: null }]);
    const d = await runRugFilter(input(rpc));
    assert.equal(d.reason, RUG_FILTER_REASONS.gradHolder);
  });

  it("fails closed: graduated per scan but no pool", async () => {
    const rpc = new GradRpcBatch(206n * M, wallets(3, 1));
    rpc.accounts.delete(POOL);
    const d = await runRugFilter(input(rpc));
    assert.equal(d.reason, RUG_FILTER_REASONS.gradPoolUnavailable);
  });

  it("fails closed: pool read error, vault missing, holder read error", async () => {
    const a = new GradRpcBatch(206n * M, wallets(3, 1));
    a.failKeys.add(POOL);
    assert.equal((await runRugFilter(input(a))).reason, RUG_FILTER_REASONS.rpcError);
    // Unknown venue: still fails closed on the pool read error.
    assert.equal((await runRugFilter(input(a, { venue: undefined }))).allow, false);
    const b = new GradRpcBatch(null, wallets(3, 1));
    assert.equal((await runRugFilter(input(b))).reason, RUG_FILTER_REASONS.gradPoolUnavailable);
    const c = new GradRpcBatch(206n * M, wallets(3, 1));
    c.failKeys.add(key(101));
    assert.equal((await runRugFilter(input(c))).reason, RUG_FILTER_REASONS.rpcError);
  });

  it("pool found on-chain is used even when the scan didn't say graduated", async () => {
    const rpc = new GradRpcBatch(53n * M, [{ ta: key(1), holder: key(101), amount: 410n * M }]);
    const d = await runRugFilter(input(rpc, { venue: undefined }));
    assert.equal(d.reason, RUG_FILTER_REASONS.gradHolder);
  });

  it("thresholds are configurable (0 disables the pool-share rule)", async () => {
    const rpc = new GradRpcBatch(42n * M, wallets(10, 3));
    assert.equal((await runRugFilter(input(rpc))).reason, RUG_FILTER_REASONS.gradPoolThin);
    assert.equal((await runRugFilter(input(rpc, { gradMinPoolPct: 0 }))).allow, true);
    assert.equal((await runRugFilter(input(rpc, { gradMaxTop10Pct: 25 }))).reason, RUG_FILTER_REASONS.gradTop10);
  });
});

describe("rug verdict cache: a fail can't flip to pass on retry", () => {
  const fail = (reason: string) => ({ allow: false, reason, detail: "", skipped: [] });
  it("keeps a real fail for the cooldown; a later pass doesn't clear it", () => {
    const c = new RugVerdictCache(60 * 60_000);
    c.record("m", fail(RUG_FILTER_REASONS.topHolder), 0);
    c.record("m", { allow: true, reason: null, detail: "", skipped: [] }, 10 * 60_000);
    assert.equal(c.get("m", 10 * 60_000)?.reason, RUG_FILTER_REASONS.topHolder);
    assert.equal(c.get("m", 60 * 60_000), null);
  });
  it("RPC errors are remembered briefly and never shorten a real verdict", () => {
    const c = new RugVerdictCache(60 * 60_000);
    c.record("a", fail(RUG_FILTER_REASONS.rpcError), 0);
    assert.ok(c.get("a", RUG_FILTER_TRANSIENT_FAIL_MS - 1));
    assert.equal(c.get("a", RUG_FILTER_TRANSIENT_FAIL_MS), null);
    c.record("b", fail(RUG_FILTER_REASONS.gradHolder), 0);
    c.record("b", fail(RUG_FILTER_REASONS.rpcError), 1000);
    assert.equal(c.get("b", 30 * 60_000)?.reason, RUG_FILTER_REASONS.gradHolder);
  });
  it("cooldown 0 disables caching", () => {
    const c = new RugVerdictCache(0);
    c.record("m", fail(RUG_FILTER_REASONS.topHolder), 0);
    assert.equal(c.get("m", 1), null);
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
    trailingTakeProfit: { activatePct: 50, distancePct: 5 },
    paperBroker: { slippageBps: 0, feeBps: 0 },
    runner: { pollIntervalMs: 20, scanLimit: 5, maxCycles: 1 },
    maxHoldMinutes: 0,
    dailyLossUsd: 25,
    chaseLockoutHours: 0,
    marketDataSource: "mock",
    ledgerDir: dir,
    activePreset: "momentum",
    requireChecklistGo: false,
    rugFilterEnabled: true,
    ...over,
  };
}
function market(): MarketDataProvider {
  const s: TokenSnapshot = {
    mint: MINT, symbol: "TRUMPSI", name: "T", priceUsd: 1, changeWindowPct: 20, volumeWindowUsd: 10_000,
    volumeAvgUsd: 1_000, volume24hUsd: 50_000, liquidityUsd: 50_000, timestamp: Date.now(),
    createdAt: Date.now() - 3_600_000, venue: "pumpswap",
  };
  return { async scan() { return [{ ...s, timestamp: Date.now() }]; }, async getPrice() { return 1; } };
}
async function runOnce(engine: BotEngine): Promise<void> {
  assert.equal((await engine.start()).ok, true);
  for (let i = 0; i < 60 && engine.getStatus().state !== "stopped"; i++) await new Promise((r) => setTimeout(r, 50));
}

describe("engine: cached rug fail survives a re-check that would pass", () => {
  it("06:48 fail (holder 41%), 06:58 holders split → still skipped within the cooldown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rug-grad-cache-"));
    try {
      const c = cfg(dir);
      const rpc = new GradRpcBatch(53n * M, [{ ta: key(1), holder: key(101), amount: 410n * M }]);
      const deps = { ledger: new PaperLedger(c.bankrollUsd, dir), broker: new PaperBroker(c), journal: new TradeJournal(dir), market: market(), solanaRpc: rpc, onchainPrice: null };
      const engine = new BotEngine(c, deps);
      await runOnce(engine);
      assert.equal((await engine.getPortfolio()).tradeCount, 0);
      // Same engine, now an RPC that would pass everything.
      const clean = new GradRpcBatch(300n * M, wallets(10, 1));
      (engine as unknown as { solanaRpcOverride: RugFilterRpc }).solanaRpcOverride = clean;
      await runOnce(engine);
      assert.equal((await engine.getPortfolio()).tradeCount, 0);
      assert.ok(!clean.calls.includes("largest"), "cached verdict: no re-check");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("config: graduated thresholds from env", () => {
  it("defaults 10 / 10 / 35 / 60 and env overrides", () => {
    const keys = ["RUG_FILTER_GRAD_MIN_POOL_PCT", "RUG_FILTER_GRAD_MAX_HOLDER_PCT", "RUG_FILTER_GRAD_MAX_TOP10_PCT", "RUG_FILTER_FAIL_COOLDOWN_MINUTES", "FAST_EXIT_POLL_MS"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      for (const k of keys) delete process.env[k];
      const d = loadConfig({ skipRuntimeOverlay: true });
      assert.equal(d.rugFilterGradMinPoolPct, 10);
      assert.equal(d.rugFilterGradMaxHolderPct, 10);
      assert.equal(d.rugFilterGradMaxTop10Pct, 35);
      assert.equal(d.rugFilterFailCooldownMinutes, 60);
      assert.equal(d.fastExitPollMs, 1000);
      process.env.RUG_FILTER_GRAD_MIN_POOL_PCT = "8";
      process.env.RUG_FILTER_GRAD_MAX_HOLDER_PCT = "12";
      process.env.RUG_FILTER_GRAD_MAX_TOP10_PCT = "40";
      process.env.RUG_FILTER_FAIL_COOLDOWN_MINUTES = "30";
      process.env.FAST_EXIT_POLL_MS = "0";
      const e = loadConfig({ skipRuntimeOverlay: true });
      assert.equal(e.rugFilterGradMinPoolPct, 8);
      assert.equal(e.rugFilterGradMaxHolderPct, 12);
      assert.equal(e.rugFilterGradMaxTop10Pct, 40);
      assert.equal(e.rugFilterFailCooldownMinutes, 30);
      assert.equal(e.fastExitPollMs, 0);
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
