import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { TradeJournal } from "../src/journal/journal.js";
import { applyPaperPatch, loadConfig, parsePaperConfigPatch } from "../src/config.js";
import { applyPresetKnobs } from "../src/presets.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";
import { base58Encode } from "../src/solana/base58.js";
import type {
  AccountInfo,
  LargestTokenAccount,
  ParsedMint,
  RpcResult,
  SignatureInfo,
} from "../src/solana/rpc.js";
import {
  DEFAULT_RUG_FILTER_MAX_SAME_SLOT_BUYS,
  DEFAULT_RUG_FILTER_MAX_TOP_HOLDER_PCT,
  PUMP_FUN_PROGRAM_ID,
  RUG_FILTER_REASONS,
  RUG_FILTER_SKIPPED,
  SAME_SLOT_SIGNATURE_LIMIT,
  holderExceedsPct,
  runRugFilter,
  type RugFilterRpc,
} from "../src/risk/rugFilter.js";

const SYSTEM = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const HOLDER_BYTES = new Uint8Array(32).fill(4);
const HOLDER = base58Encode(HOLDER_BYTES);
const WHALE = "WhaleAcct1111111111111111111111111111111";
const CURVE_TA = "AssocCurve111111111111111111111111111111";

function cfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true,
    bankrollUsd: 100,
    maxOpenTrades: 1,
    stopLossPct: 10,
    takeProfitPct: 25,
    positionSizePct: 0.95,
    maxPositionUsd: 25,
    momentum: {
      minPct: 1,
      windowMinutes: 5,
      volumeSpikeMult: 1,
      minLiquidityUsd: 0,
      minVolume24hUsd: 0,
      minAgeMinutes: 0,
    },
    trailingTakeProfit: { activatePct: 50, distancePct: 5 },
    paperBroker: { slippageBps: 0, feeBps: 0 },
    runner: { pollIntervalMs: 20, scanLimit: 5, maxCycles: 1 },
    maxHoldMinutes: 0,
    dailyLossUsd: 25,
    chaseLockoutHours: 12,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "momentum",
    requireChecklistGo: false,
    ...over,
  };
}

function snap(over: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    mint: "mintRug",
    symbol: "RUG",
    name: "Rug",
    priceUsd: 1,
    changeWindowPct: 20,
    volumeWindowUsd: 10_000,
    volumeAvgUsd: 1_000,
    volume24hUsd: 50_000,
    liquidityUsd: 50_000,
    timestamp: Date.now(),
    createdAt: Date.now() - 60_000,
    associatedBondingCurve: CURVE_TA,
    creator: "Creator111111111111111111111111111111111",
    ...over,
  };
}

function tokenAccount(holder: Uint8Array): Uint8Array {
  const data = new Uint8Array(165);
  data.set(holder, 32);
  return data;
}

function account(owner: string, data: Uint8Array): AccountInfo {
  return { lamports: 1, owner, executable: false, data };
}

class FakeRpc implements RugFilterRpc {
  calls: string[] = [];
  mint: ParsedMint = {
    supply: 1_000_000n,
    decimals: 6,
    mintAuthority: null,
    freezeAuthority: null,
  };
  largest: LargestTokenAccount[] = [
    { address: CURVE_TA, amount: 800_000n, decimals: 6 },
    { address: WHALE, amount: 100_000n, decimals: 6 },
  ];
  sigs: SignatureInfo[] = [
    { signature: "buy1", slot: 20, err: null, blockTime: 2 },
    { signature: "create", slot: 10, err: null, blockTime: 1 },
  ];
  boom = false;

  private hit(name: string): void {
    this.calls.push(name);
    if (this.boom) throw new Error("rpc should not be called");
  }

  async getMintAccount(): Promise<RpcResult<ParsedMint | null>> {
    this.hit("getMintAccount");
    return { ok: true, value: this.mint };
  }

  async getTokenLargestAccounts(): Promise<{
    ok: true;
    value: LargestTokenAccount[];
  }> {
    this.hit("getTokenLargestAccounts");
    return { ok: true, value: this.largest };
  }

  async getAccountInfo(pubkey: string) {
    this.hit(`getAccountInfo:${pubkey}`);
    if (pubkey === WHALE) {
      return { ok: true as const, value: account(TOKEN, tokenAccount(HOLDER_BYTES)) };
    }
    if (pubkey === HOLDER) {
      return { ok: true as const, value: account(SYSTEM, new Uint8Array(0)) };
    }
    if (pubkey === "CurvePda") {
      return {
        ok: true as const,
        value: account(PUMP_FUN_PROGRAM_ID, new Uint8Array(0)),
      };
    }
    return { ok: false as const, error: `unknown account ${pubkey}` };
  }

  async getSignaturesForAddress() {
    this.hit("getSignaturesForAddress");
    return { ok: true as const, value: this.sigs };
  }
}

function baseInput(rpc: RugFilterRpc | null, over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    rpc,
    mint: "mintRug",
    symbol: "RUG",
    maxTopHolderPct: DEFAULT_RUG_FILTER_MAX_TOP_HOLDER_PCT,
    maxSameSlotBuys: DEFAULT_RUG_FILTER_MAX_SAME_SLOT_BUYS,
    ignoreAddresses: [CURVE_TA],
    creator: "Creator111111111111111111111111111111111",
    ...over,
  };
}

describe("rug filter decisions", () => {
  it("passes a clean mint and names the checks that are not implemented", async () => {
    const rpc = new FakeRpc();
    const d = await runRugFilter(baseInput(rpc));
    assert.equal(d.allow, true);
    assert.equal(d.reason, null);
    assert.ok(d.skipped.includes(RUG_FILTER_SKIPPED.devRug));
    assert.ok(d.skipped.includes(RUG_FILTER_SKIPPED.wash));
    assert.equal(d.skipped.includes(RUG_FILTER_SKIPPED.sameSlotTruncated), false);
    assert.ok(rpc.calls.includes("getMintAccount"));
    assert.equal(rpc.calls.some((c) => c.includes(CURVE_TA)), false);
  });

  it("rejects freeze authority before holder calls", async () => {
    const rpc = new FakeRpc();
    rpc.mint = { ...rpc.mint, freezeAuthority: "FreezeAuth111111111111111111111111111" };
    const d = await runRugFilter(baseInput(rpc));
    assert.equal(d.allow, false);
    assert.equal(d.reason, RUG_FILTER_REASONS.freeze);
    assert.deepEqual(rpc.calls, ["getMintAccount"]);
  });

  it("rejects top holder above 30% and allows exactly 30%", async () => {
    assert.equal(holderExceedsPct(300_000n, 1_000_000n, 30), false);
    assert.equal(holderExceedsPct(300_001n, 1_000_000n, 30), true);
    const rpc = new FakeRpc();
    rpc.largest = [
      { address: CURVE_TA, amount: 500_000n, decimals: 6 },
      { address: WHALE, amount: 400_000n, decimals: 6 },
    ];
    const d = await runRugFilter(baseInput(rpc));
    assert.equal(d.allow, false);
    assert.equal(d.reason, RUG_FILTER_REASONS.topHolder);
  });

  it("ignores a pump-program-owned holder even without a payload address", async () => {
    const rpc = new FakeRpc();
    rpc.largest = [
      { address: "CurveTaUnknown", amount: 900_000n, decimals: 6 },
      { address: WHALE, amount: 50_000n, decimals: 6 },
    ];
    const orig = rpc.getAccountInfo.bind(rpc);
    rpc.getAccountInfo = async (pubkey: string) => {
      if (pubkey === "CurveTaUnknown") {
        rpc.calls.push(`getAccountInfo:${pubkey}`);
        const curveHolder = new Uint8Array(32).fill(9);
        return { ok: true, value: account(TOKEN, tokenAccount(curveHolder)) };
      }
      if (pubkey === base58Encode(new Uint8Array(32).fill(9))) {
        rpc.calls.push(`getAccountInfo:${pubkey}`);
        return { ok: true, value: account(PUMP_FUN_PROGRAM_ID, new Uint8Array(0)) };
      }
      return orig(pubkey);
    };
    const d = await runRugFilter(baseInput(rpc, { ignoreAddresses: [] }));
    assert.equal(d.allow, true, d.detail);
  });

  it("rejects a same-slot burst above the configured count", async () => {
    const rpc = new FakeRpc();
    rpc.sigs = [0, 1, 2, 3, 4].map((i) => ({
      signature: `s${i}`,
      slot: 7,
      err: null,
      blockTime: i,
    }));
    const d = await runRugFilter(baseInput(rpc));
    assert.equal(d.allow, false);
    assert.equal(d.reason, RUG_FILTER_REASONS.sameSlot);
    const ok = new FakeRpc();
    ok.sigs = [0, 1, 2, 3].map((i) => ({
      signature: `s${i}`,
      slot: 7,
      err: null,
      blockTime: i,
    }));
    const passed = await runRugFilter(baseInput(ok));
    assert.equal(passed.allow, true);
  });

  it("does not guess the creation slot when signature history is truncated", async () => {
    const rpc = new FakeRpc();
    rpc.sigs = Array.from({ length: SAME_SLOT_SIGNATURE_LIMIT }, (_, i) => ({
      signature: `s${i}`,
      slot: 1000 - i,
      err: null,
      blockTime: i,
    }));
    const d = await runRugFilter(baseInput(rpc));
    assert.equal(d.allow, true);
    assert.ok(d.skipped.includes(RUG_FILTER_SKIPPED.sameSlotTruncated));
  });

  it("filter off makes no RPC calls", async () => {
    const rpc = new FakeRpc();
    rpc.boom = true;
    const d = await runRugFilter(baseInput(rpc, { enabled: false }));
    assert.equal(d.allow, true);
    assert.equal(d.reason, null);
    assert.deepEqual(rpc.calls, []);
  });

  it("filter on without RPC skips the buy", async () => {
    const d = await runRugFilter(baseInput(null));
    assert.equal(d.allow, false);
    assert.equal(d.reason, RUG_FILTER_REASONS.noRpc);
    assert.ok(d.skipped.includes(RUG_FILTER_SKIPPED.devRug));
    assert.ok(d.skipped.includes(RUG_FILTER_SKIPPED.wash));
  });

  it("RPC error is a skip, not a throw", async () => {
    const rpc = new FakeRpc();
    rpc.getMintAccount = async () => {
      rpc.calls.push("getMintAccount");
      return { ok: false, error: "timeout [rpc]" };
    };
    const d = await runRugFilter(baseInput(rpc));
    assert.equal(d.allow, false);
    assert.equal(d.reason, RUG_FILTER_REASONS.rpcError);
    assert.equal(d.detail.includes("http"), false);
  });
});

describe("rug filter config defaults", () => {
  it("defaults off, 30%, 3 same-slot buys, and rejects an RPC URL patch", () => {
    const prev = {
      en: process.env.RUG_FILTER_ENABLED,
      pct: process.env.RUG_FILTER_MAX_TOP_HOLDER_PCT,
      slot: process.env.RUG_FILTER_MAX_SAME_SLOT_BUYS,
      rpc: process.env.SOLANA_RPC_URL,
    };
    delete process.env.RUG_FILTER_ENABLED;
    delete process.env.RUG_FILTER_MAX_TOP_HOLDER_PCT;
    delete process.env.RUG_FILTER_MAX_SAME_SLOT_BUYS;
    delete process.env.SOLANA_RPC_URL;
    try {
      const loaded = loadConfig({ skipRuntimeOverlay: true });
      assert.equal(loaded.rugFilterEnabled, false);
      assert.equal(loaded.rugFilterMaxTopHolderPct, 30);
      assert.equal(loaded.rugFilterMaxSameSlotBuys, 3);
      assert.equal(loaded.solanaRpcConfigured, false);
      const rejected = parsePaperConfigPatch({ SOLANA_RPC_URL: "https://rpc.example/secret" });
      assert.equal(rejected.ok, false);
      const c = cfg({ activePreset: "momentum" });
      applyPresetKnobs(c, "momentum");
      applyPaperPatch(c, { rugFilterEnabled: true });
      assert.equal(c.rugFilterEnabled, true);
      assert.equal(c.activePreset, "momentum");
      assert.equal(c.stopLossPct, 10);
    } finally {
      for (const [k, v] of Object.entries({
        RUG_FILTER_ENABLED: prev.en,
        RUG_FILTER_MAX_TOP_HOLDER_PCT: prev.pct,
        RUG_FILTER_MAX_SAME_SLOT_BUYS: prev.slot,
        SOLANA_RPC_URL: prev.rpc,
      })) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

function mockMarket(priceByMint: Map<string, number>): MarketDataProvider {
  return {
    async scan(): Promise<TokenSnapshot[]> {
      return [...priceByMint.entries()].map(([mint, priceUsd]) =>
        snap({ mint, symbol: mint.slice(0, 4).toUpperCase(), priceUsd }),
      );
    },
    async getPrice(mint: string) {
      return priceByMint.get(mint) ?? null;
    },
  };
}

async function waitStopped(engine: BotEngine): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (engine.getStatus().state === "stopped") return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("rug filter paper buy gate", () => {
  it("filter on without RPC skips the buy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rug-norpc-"));
    try {
      const prices = new Map([["mintRug", 1]]);
      const c = cfg({ ledgerDir: dir, rugFilterEnabled: true });
      const engine = new BotEngine(c, {
        ledger: new PaperLedger(c.bankrollUsd, dir),
        broker: new PaperBroker(c),
        journal: new TradeJournal(dir),
        market: mockMarket(prices),
        solanaRpc: null,
      });
      assert.equal((await engine.start()).ok, true);
      await waitStopped(engine);
      const port = await engine.getPortfolio();
      assert.equal(port.openPositions.length, 0);
      assert.equal(port.tradeCount, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filter off does not call RPC and still buys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rug-off-"));
    try {
      const prices = new Map([["mintRug", 1]]);
      const c = cfg({ ledgerDir: dir, rugFilterEnabled: false });
      const rpc = new FakeRpc();
      rpc.boom = true;
      const engine = new BotEngine(c, {
        ledger: new PaperLedger(c.bankrollUsd, dir),
        broker: new PaperBroker(c),
        journal: new TradeJournal(dir),
        market: mockMarket(prices),
        solanaRpc: rpc,
      });
      assert.equal((await engine.start()).ok, true);
      await waitStopped(engine);
      const port = await engine.getPortfolio();
      assert.equal(port.tradeCount, 1);
      assert.deepEqual(rpc.calls, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("filter on rejects a frozen mint and does not buy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rug-freeze-"));
    try {
      const prices = new Map([["mintRug", 1]]);
      const c = cfg({ ledgerDir: dir, rugFilterEnabled: true });
      const rpc = new FakeRpc();
      rpc.mint = { ...rpc.mint, freezeAuthority: "FreezeAuth111111111111111111111111111" };
      const engine = new BotEngine(c, {
        ledger: new PaperLedger(c.bankrollUsd, dir),
        broker: new PaperBroker(c),
        journal: new TradeJournal(dir),
        market: mockMarket(prices),
        solanaRpc: rpc,
      });
      assert.equal((await engine.start()).ok, true);
      await waitStopped(engine);
      const port = await engine.getPortfolio();
      assert.equal(port.tradeCount, 0);
      assert.deepEqual(rpc.calls, ["getMintAccount"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
