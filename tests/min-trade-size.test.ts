/**
 * Full-size-or-nothing entries: a new position is always the selected trade size.
 * Not enough tradable cash (paper / dry-run) or wallet SOL (live) → skip with a
 * plain-English "buying paused" status, logged/alerted once — never a tiny buy.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLiveSettings } from "../src/live/mode.js";
import { loadLiveSigner, type LiveSigner } from "../src/live/keypair.js";
import { LiveBroker, dryRunCostModelFromConfig } from "../src/live/liveBroker.js";
import type { LiveRpc, TxMeta } from "../src/live/rpc.js";
import type { SwapRequest, SwapTxBuilder } from "../src/live/pumpportal.js";
import { loadPaperFeeSettings } from "../src/broker/paperFees.js";
import { PaperBroker } from "../src/broker/paper.js";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { sizePosition } from "../src/risk/manager.js";
import {
  checkEntryCash,
  checkLiveWalletFunds,
  LIVE_BUY_RENT_SOL,
} from "../src/risk/entryFunds.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";

const MINT = "WinkMint11111111111111111111111111111111pump";
const OVERNIGHT_MSG =
  "Not enough cash for a $15 trade ($3.19 available) — buying paused until cash is added or the vault is moved back";

let dir: string;
let signer: LiveSigner;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "minsize-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const keyPath = join(dir, "k.json");
  writeFileSync(keyPath, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  const r = loadLiveSigner(keyPath);
  assert.ok(r.ok);
  signer = r.signer;
});
after(() => rmSync(dir, { recursive: true, force: true }));

function cfgFor(ledgerDir: string, over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: false, bankrollUsd: 200, maxOpenTrades: 1, stopLossPct: 8, takeProfitPct: 15, positionSizePct: 0.95, maxPositionUsd: 25,
    momentum: { minPct: 1, windowMinutes: 5, volumeSpikeMult: 1, minLiquidityUsd: 0, minVolume24hUsd: 0, minAgeMinutes: 0 },
    trailingTakeProfit: { activatePct: 10, distancePct: 5 },
    // Realistic cost model (the default from loadConfig) — fees come out of the trade size.
    paperBroker: { slippageBps: 50, feeBps: 30, fees: loadPaperFeeSettings({}) },
    runner: { pollIntervalMs: 10, scanLimit: 5, maxCycles: 0 }, maxHoldMinutes: 0, dailyLossUsd: 0, chaseLockoutHours: 0,
    marketDataSource: "mock", ledgerDir, activePreset: "custom", requireChecklistGo: false,
    solanaRpcConfigured: true, solanaRpcWssConfigured: false, rugFilterEnabled: false, rugFilterMaxTopHolderPct: 30, rugFilterMaxSameSlotBuys: 3,
    tradingMode: "live_dry_run", live: loadLiveSettings({}),
    ...over,
  };
}

/** Always signals an entry (like WINK overnight). */
class AlwaysSignal implements MarketDataProvider {
  scans = 0;
  async scan(): Promise<TokenSnapshot[]> {
    this.scans++;
    return [{
      mint: MINT, symbol: "WINK", name: "Wink", priceUsd: 0.0001, changeWindowPct: 50, volumeWindowUsd: 100_000,
      volumeAvgUsd: 1000, volume24hUsd: 1_000_000, liquidityUsd: 1_000_000, timestamp: Date.now(), createdAt: Date.now() - 3_600_000,
      associatedBondingCurve: "Small",
    }];
  }
  async getPrice() { return 0.0001; }
  async getQuoteUsdRate() { return 150; }
}
const passRug = {
  async getMintAccount() { return { ok: true as const, value: { supply: 1_000_000_000n, decimals: 6, mintAuthority: null, freezeAuthority: null } }; },
  async getTokenLargestAccounts() { return { ok: true as const, value: [{ address: "Small", amount: 1_000n, decimals: 6 }] }; },
  async getAccountInfo() { return { ok: true as const, value: null }; },
  async getSignaturesForAddress() {
    return { ok: true as const, value: [{ signature: "b", slot: 20, err: null, blockTime: 2 }, { signature: "c", slot: 10, err: null, blockTime: 1 }] };
  },
};

/** Minimal valid v0 tx (fee payer only) so signing + simulate work in dry-run. */
function tinyTx(feePayer: Uint8Array): Uint8Array {
  const msg: number[] = [0x80, 1, 0, 0, 1, ...feePayer, ...new Array(32).fill(5), 0, 0];
  return Uint8Array.from([1, ...new Array(64).fill(0), ...msg]);
}
class Builder implements SwapTxBuilder {
  calls: SwapRequest[] = [];
  async buildTx(req: SwapRequest) {
    this.calls.push(req);
    return tinyTx(signer.publicKeyBytes);
  }
}
class Rpc implements LiveRpc {
  sims = 0;
  sends = 0;
  balanceCalls = 0;
  constructor(public balanceSol = 2) {}
  async getBalanceLamports() { this.balanceCalls++; return Math.round(this.balanceSol * 1e9); }
  async simulate() { this.sims++; return { err: null, logs: [] }; }
  async send() { this.sends++; return "sig"; }
  async getSignatureStatus() { return { confirmationStatus: "confirmed" as const, err: null }; }
  async getTransactionMeta(): Promise<{ meta: TxMeta; accountKeys: string[] }> {
    throw new Error("not used in dry-run");
  }
  async getAccountData() { return null; }
}
function mkBroker(rpc: Rpc, builder: Builder, env: Record<string, string> = {}) {
  let t = 0;
  return new LiveBroker({
    signer, rpc, builder, mode: "live_dry_run",
    // Same wiring as the engine: realistic dry-run costs from config.
    dryRunCosts: dryRunCostModelFromConfig(cfgFor("/tmp/unused")),
    settings: loadLiveSettings({ LIVE_CONFIRM_TIMEOUT_MS: "5000", ...env }),
    sleep: async (ms) => { t += ms; }, now: () => t,
  });
}

/** Capture console.warn lines (the engine logs "buying paused" via log.warn). */
function captureWarn(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  return { lines, restore: () => { console.warn = orig; } };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("sizing: full selected size or nothing", () => {
  const base = cfgFor("/tmp/unused", { paperMode: true, tradingMode: "paper", live: undefined });

  it("overnight case: $3.19 tradable after a $250 vault skim → refused, not a $3 buy", () => {
    const r = sizePosition({ cashUsd: 3.19, markPrice: 0.0001, openCount: 0, targetUsd: 15 }, base);
    assert.equal(r.ok, false);
    assert.equal(r.notionalUsd, 0);
    assert.equal(r.funds?.reason, "insufficient_cash");
    assert.equal(r.reason, OVERNIGHT_MSG);
    assert.equal(r.funds?.availableUsd, 3.19);
    assert.equal(r.funds?.neededUsd, 15);
  });

  it("always exactly the selected size when cash covers it (no % of cash shrink, no cash-sized buy)", () => {
    const exact = sizePosition({ cashUsd: 15, markPrice: 0.0001, openCount: 0, targetUsd: 15 }, base);
    assert.equal(exact.ok, true);
    assert.equal(exact.notionalUsd, 15);
    // Old rule: 0.95 × $15.50 = $14.73. Now: $15 or nothing.
    const tight = sizePosition({ cashUsd: 15.5, markPrice: 0.0001, openCount: 0, targetUsd: 15 }, base);
    assert.equal(tight.notionalUsd, 15);
    const rich = sizePosition({ cashUsd: 500, markPrice: 0.0001, openCount: 0, targetUsd: 15 }, base);
    assert.equal(rich.notionalUsd, 15);
    assert.equal(rich.qty, 15 / 0.0001);
  });

  it("just short by a cent → refused", () => {
    const r = sizePosition({ cashUsd: 14.99, markPrice: 0.0001, openCount: 0, targetUsd: 15 }, base);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /Not enough cash for a \$15 trade \(\$14\.99 available\)/);
  });

  it("costs charged on top of the size must also be covered (legacy dry-run priority fee)", () => {
    const r = sizePosition({ cashUsd: 15.01, markPrice: 0.0001, openCount: 0, targetUsd: 15, extraCostsUsd: 0.03 }, base);
    assert.equal(r.ok, false);
    assert.equal(
      r.reason,
      "Not enough cash for a $15 trade (needs $15.03 incl. costs, $15.01 available) — buying paused until cash is added or the vault is moved back",
    );
    assert.equal(sizePosition({ cashUsd: 15.03, markPrice: 0.0001, openCount: 0, targetUsd: 15, extraCostsUsd: 0.03 }, base).ok, true);
  });

  it("a size above MAX_POSITION_USD is refused, never trimmed to the cap", () => {
    const r = sizePosition({ cashUsd: 500, markPrice: 0.0001, openCount: 0, targetUsd: 30 }, { ...base, maxPositionUsd: 25 });
    assert.equal(r.ok, false);
    assert.equal(r.funds?.reason, "size_above_cap");
    assert.match(r.reason!, /Trade size \$30 is above MAX_POSITION_USD \(\$25\)/);
  });

  it("other gates are unchanged (daily loss, max open trades)", () => {
    const loss = sizePosition({ cashUsd: 500, markPrice: 0.0001, openCount: 0, targetUsd: 15 }, { ...base, dailyLossUsd: 50 }, -60);
    assert.match(loss.reason!, /daily loss cap/);
    const open = sizePosition({ cashUsd: 500, markPrice: 0.0001, openCount: 1, targetUsd: 15 }, base);
    assert.match(open.reason!, /max open trades/);
  });

  it("checkEntryCash formats cents and whole dollars", () => {
    const r = checkEntryCash({ sizeUsd: 30, cashUsd: 2.934 });
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /^Not enough cash for a \$30 trade \(\$2\.93 available\)/);
  });
});

describe("live wallet: spendable SOL after reserve, priority-fee cap and rent", () => {
  const s = loadLiveSettings({});
  const need = (usd: number, solUsd: number) =>
    usd / solUsd + s.priorityFeeMaxSol + LIVE_BUY_RENT_SOL + 0.000005 + (usd / solUsd) * 0.02 + s.minSolReserve;

  it("covers the full size → ok; a lamport short → refused with plain message", () => {
    const n = need(15, 150);
    assert.equal(checkLiveWalletFunds({ balanceSol: n, sizeUsd: 15, solUsd: 150, minSolReserve: s.minSolReserve, priorityFeeMaxSol: s.priorityFeeMaxSol }).ok, true);
    const short = checkLiveWalletFunds({ balanceSol: n - 1e-6, sizeUsd: 15, solUsd: 150, minSolReserve: s.minSolReserve, priorityFeeMaxSol: s.priorityFeeMaxSol });
    assert.equal(short.ok, false);
    assert.match((short as { message: string }).message, /^Not enough SOL in the wallet for a \$15 trade \(\$\d+\.\d\d spendable after the 0\.05 SOL reserve, fees and rent\) — buying paused until SOL is added or the vault is moved back$/);
  });

  it("LiveBroker refuses instead of shrinking: nothing built, nothing simulated", async () => {
    const rpc = new Rpc(0.07); // ≈ $3 spendable over the 0.05 reserve
    const b = new Builder();
    const broker = mkBroker(rpc, b);
    const r = await broker.buy({ mint: MINT, symbol: "WINK", markPrice: 0.0001, notionalUsd: 15, solUsd: 150 });
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /insufficient SOL/);
    assert.match((r as { plain?: string }).plain ?? "", /Not enough SOL in the wallet for a \$15 trade/);
    assert.equal(broker.lastFundsCheck?.ok, false);
    assert.equal(b.calls.length, 0);
    assert.equal(rpc.sims, 0);
    // Enough SOL → the FULL amount is requested.
    rpc.balanceSol = 2;
    const ok = await broker.buy({ mint: MINT, symbol: "WINK", markPrice: 0.0001, notionalUsd: 15, solUsd: 150 });
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.equal(broker.lastFundsCheck?.ok, true);
    assert.equal(b.calls[0]!.amount, 0.1);
    assert.equal(rpc.sends, 0);
  });
});

describe("engine: overnight LIVE DRY-RUN scenario ($250 skimmed to the vault, ~$3 left)", () => {
  it("never opens a tiny position; pauses with one log + one alert; resumes at full size when cash is back", async () => {
    const ld = mkdtempSync(join(tmpdir(), "minsize-eng-"));
    const cap = captureWarn();
    try {
      const ledger = new PaperLedger(253.19, join(ld, "live"));
      assert.equal(ledger.skim(250).ok, true);
      assert.ok(Math.abs(ledger.cash - 3.19) < 1e-9);
      const rpc = new Rpc(2);
      const b = new Builder();
      const market = new AlwaysSignal();
      const engine = new BotEngine(cfgFor(ld), {
        market, liveBroker: mkBroker(rpc, b), solanaWs: null, solanaRpc: passRug as never, ledger,
      });
      assert.equal(engine.getTradeSize().effectiveUsd, 15);
      const started = await engine.start();
      assert.ok(started.ok, started.message);
      await wait(400); // dozens of 10ms cycles

      // Old behaviour: ~$3 buys over and over. Now: nothing.
      assert.equal(engine.ledger.openPositions.length, 0);
      assert.equal(engine.ledger.getTrades().length, 0);
      assert.equal(b.calls.length, 0, "no tx built");
      assert.equal(rpc.sims, 0, "nothing simulated");
      assert.ok(Math.abs(engine.ledger.cash - 3.19) < 1e-9);
      assert.equal(market.scans, 0, "no coin scanning while the size can't be paid for");
      assert.ok(engine.getStatus().cycle > 5);

      const paused = engine.getStatus().buyingPaused;
      assert.ok(paused);
      assert.equal(paused.reason, "insufficient_cash");
      assert.equal(paused.message, OVERNIGHT_MSG);
      assert.equal(paused.sizeUsd, 15);
      assert.ok(Math.abs(paused.availableUsd! - 3.19) < 1e-9);

      // Throttled: once per state change, not every cycle.
      const pausedEvents = engine.events.since(0, 100).filter((e) => e.type === "buying_paused");
      assert.equal(pausedEvents.length, 1);
      assert.equal(pausedEvents[0]!.body, OVERNIGHT_MSG);
      assert.equal(cap.lines.filter((l) => l.includes("Not enough cash")).length, 1);

      // Mark moves $20 back from the vault → next cycle buys exactly $15.
      assert.equal(ledger.returnFromVault(20).ok, true);
      await wait(300);
      assert.equal(engine.ledger.openPositions.length, 1);
      assert.equal(engine.ledger.openPositions[0]!.entryNotionalUsd, 15);
      assert.equal(b.calls.length, 1);
      assert.equal(b.calls[0]!.amount, 0.1); // $15 @ $150/SOL — full size
      assert.equal(engine.getStatus().buyingPaused, null);
      assert.equal(engine.events.since(0, 100).filter((e) => e.type === "buying_resumed").length, 1);
      assert.equal(rpc.sends, 0);

      await engine.stop();
      await engine.stop();
      await engine.dispose();
    } finally {
      cap.restore();
      rmSync(ld, { recursive: true, force: true });
    }
  });

  it("live wallet short of SOL (ledger has cash): pauses once, no tx built, balance re-checked ≤ once a minute", async () => {
    const ld = mkdtempSync(join(tmpdir(), "minsize-sol-"));
    const cap = captureWarn();
    try {
      const rpc = new Rpc(0.07);
      const b = new Builder();
      const engine = new BotEngine(cfgFor(ld), {
        market: new AlwaysSignal(), liveBroker: mkBroker(rpc, b), solanaWs: null, solanaRpc: passRug as never,
        ledger: new PaperLedger(200, join(ld, "live")),
      });
      const started = await engine.start();
      assert.ok(started.ok, started.message);
      await wait(400);
      assert.equal(engine.ledger.openPositions.length, 0);
      assert.equal(b.calls.length, 0);
      const st = engine.getStatus().buyingPaused;
      assert.equal(st?.reason, "insufficient_sol");
      assert.match(st!.message, /^Not enough SOL in the wallet for a \$15 trade/);
      assert.equal(engine.events.since(0, 100).filter((e) => e.type === "buying_paused").length, 1);
      assert.equal(cap.lines.filter((l) => l.includes("Not enough SOL")).length, 1);
      // Not hammering the RPC every 10ms cycle.
      assert.ok(rpc.balanceCalls <= 4, `balance calls ${rpc.balanceCalls}`);
      // Not recorded as a coin failure (no per-coin cooldown).
      assert.ok(!engine.buyCooldowns.blocked(MINT, Date.now()));
      await engine.stop();
      await engine.stop();
      await engine.dispose();
    } finally {
      cap.restore();
      rmSync(ld, { recursive: true, force: true });
    }
  });

  it("PAPER: same ~$3 after a skim → no buy, paused; full $15 once cash is back", async () => {
    const ld = mkdtempSync(join(tmpdir(), "minsize-paper-"));
    const cap = captureWarn();
    try {
      const cfg = cfgFor(ld, { paperMode: true, tradingMode: "paper", live: undefined });
      const ledger = new PaperLedger(253.19, ld);
      ledger.skim(250);
      const engine = new BotEngine(cfg, { market: new AlwaysSignal(), broker: new PaperBroker(cfg), ledger, solanaWs: null, solanaRpc: null });
      await engine.start();
      await wait(300);
      assert.equal(engine.ledger.openPositions.length, 0);
      assert.equal(engine.getStatus().buyingPaused?.message, OVERNIGHT_MSG);
      assert.equal(engine.events.since(0, 100).filter((e) => e.type === "buying_paused").length, 1);
      ledger.returnFromVault(12); // $15.19 → enough for exactly $15 (0.95×cash would have been $14.43)
      await wait(300);
      assert.equal(engine.ledger.openPositions.length, 1);
      assert.equal(engine.ledger.openPositions[0]!.entryNotionalUsd, 15);
      assert.equal(engine.getStatus().buyingPaused, null);
      await engine.stop();
      await engine.dispose();
    } finally {
      cap.restore();
      rmSync(ld, { recursive: true, force: true });
    }
  });
});
