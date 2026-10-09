/**
 * Restart safety: open positions persist to disk, restore on boot, and LIVE
 * start reconciles them with the wallet (adopt bot-bought orphans, close
 * missing ones without selling, never touch unrelated coins).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLiveSettings } from "../src/live/mode.js";
import { loadLiveSigner, type LiveSigner } from "../src/live/keypair.js";
import { LiveBroker, dryRunCostModelFromConfig } from "../src/live/liveBroker.js";
import { HttpsLiveRpc, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, type LiveRpc, type TxMeta, type WalletTokenAccount } from "../src/live/rpc.js";
import type { SwapRequest, SwapTxBuilder } from "../src/live/pumpportal.js";
import { loadPaperFeeSettings } from "../src/broker/paperFees.js";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { positionsFileName, readPositionsFile } from "../src/ledger/positionStore.js";
import { planReconciliation } from "../src/live/reconcile.js";
import type { BotConfig, Fill, Position, TokenSnapshot, TradeRecord } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";

const A = "AdoptMint1111111111111111111111111111111pump"; // bot bought, Token-2022, untracked → adopt
const B = "MissingMint11111111111111111111111111111pump"; // restored, wallet 0 → reconciled_missing
const C = "SoldMint111111111111111111111111111111111pump"; // bot bought then sold, leftovers → leave
const D = "UnconfMint1111111111111111111111111111111pump"; // unconfirmed buy event → adopt at mark
const R = "KeepMint11111111111111111111111111111111pump"; // restored + still in wallet → keep
const DUST1 = "E32yDustMint11111111111111111111111111111111"; // Mark's own coins — never adopted
const DUST2 = "GNhCDustMint11111111111111111111111111111111";

let dir: string;
let signer: LiveSigner;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "persist-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const keyPath = join(dir, "test-only-key.json");
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
    paperBroker: { slippageBps: 50, feeBps: 30, fees: loadPaperFeeSettings({}) },
    runner: { pollIntervalMs: 10, scanLimit: 5, maxCycles: 0 }, maxHoldMinutes: 0, dailyLossUsd: 0, chaseLockoutHours: 0,
    marketDataSource: "mock", ledgerDir, activePreset: "custom", requireChecklistGo: false,
    solanaRpcConfigured: true, solanaRpcWssConfigured: false, rugFilterEnabled: false, rugFilterMaxTopHolderPct: 30, rugFilterMaxSameSlotBuys: 3,
    tradingMode: "live_dry_run", live: loadLiveSettings({}),
    ...over,
  };
}

class Market implements MarketDataProvider {
  prices = new Map<string, number>();
  signal: string | null = null;
  async scan(): Promise<TokenSnapshot[]> {
    if (!this.signal) return [];
    return [{
      mint: this.signal, symbol: "HOTDOG", name: "Elonhotdog", priceUsd: this.prices.get(this.signal) ?? 0.0001, changeWindowPct: 50,
      volumeWindowUsd: 100_000, volumeAvgUsd: 1000, volume24hUsd: 1_000_000, liquidityUsd: 1_000_000, timestamp: Date.now(),
      createdAt: Date.now() - 3_600_000, associatedBondingCurve: "Small",
    }];
  }
  async getPrice(mint: string) { return this.prices.get(mint) ?? null; }
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
  tokenCalls: string[] = [];
  constructor(public tokens: WalletTokenAccount[] = [], public tokenErr: Error | null = null) {}
  async getBalanceLamports() { return 2e9; }
  async simulate() { this.sims++; return { err: null, logs: [] }; }
  async send() { this.sends++; return "sig"; }
  async getSignatureStatus() { return { confirmationStatus: "confirmed" as const, err: null }; }
  async getTransactionMeta(): Promise<{ meta: TxMeta; accountKeys: string[] }> { throw new Error("unused"); }
  async getAccountData() { return null; }
  async getTokenAccountsByOwner(_owner: string, programId: string) {
    this.tokenCalls.push(programId);
    if (this.tokenErr) throw this.tokenErr;
    return this.tokens.filter((t) => t.programId === programId);
  }
}
function mkBroker(rpc: Rpc, builder: Builder, mode: "live" | "live_dry_run", cfg: BotConfig) {
  let t = 0;
  return new LiveBroker({
    signer, rpc, builder, mode,
    settings: loadLiveSettings({ LIVE_CONFIRM_TIMEOUT_MS: "5000" }),
    dryRunCosts: dryRunCostModelFromConfig(cfg),
    sleep: async (ms) => { t += ms; }, now: () => t,
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tok = (mint: string, ui: number, programId = TOKEN_PROGRAM_ID, decimals = 6): WalletTokenAccount => ({
  mint, amount: String(Math.round(ui * 10 ** decimals)), decimals, programId,
});

function pos(mint: string, symbol: string, over: Partial<Position> = {}): Position {
  return {
    id: `pos-${symbol}`, mint, symbol, side: "long", qty: 150_000, entryPrice: 0.0001, entryNotionalUsd: 15, entryFeesUsd: 0.4,
    highWaterPrice: 0.00012, trailArmed: true, openedAt: Date.now() - 60_000, venue: "pumpswap", entryLiquidityUsd: 40_000,
    entrySignature: `sig-${symbol}`, mode: "live", tradeSizeUsd: 15,
    entryFeeBreakdown: { venue: "pumpswap", venueFeeBps: 115, venueFeeUsd: 0.17, pumpPortalFeeUsd: 0.075, networkFeeUsd: 0.03, rentUsd: 0.22, slippageBps: 30, slippageUsd: 0.045, totalFeesUsd: 0.495 } as never,
    ...over,
  };
}
function fill(mint: string, symbol: string, side: "buy" | "sell", ts: number, over: Partial<Fill> = {}): Fill {
  return {
    id: `f-${symbol}-${side}-${ts}`, positionId: `p-${symbol}`, mint, symbol, side, qty: 150_000, price: 0.0001, notionalUsd: 15,
    feesUsd: 0.3, slippageUsd: 0, timestamp: ts, paper: false, mode: "live", signature: `sig-${symbol}-${side}`, ...over,
  };
}

// ---------------------------------------------------------------------------
describe("open-position persistence (ledger)", () => {
  it("round-trip: every field (high-water, trail, venue, fees, signature) and session cash restore exactly", () => {
    const d = mkdtempSync(join(tmpdir(), "rt-"));
    try {
      const path = join(d, positionsFileName("live"));
      const a = new PaperLedger(200, d);
      a.enablePositionPersistence({ path, mode: "live" });
      const p = pos(R, "KEEP", { highWaterPrice: 0.0001, trailArmed: false });
      a.recordBuy(fill(R, "KEEP", "buy", Date.now(), { positionId: p.id }), p);
      a.replacePosition({ ...p, highWaterPrice: 0.00013, trailArmed: true });
      assert.equal(a.cash, 185);
      const onDisk = readPositionsFile(path, "live");
      assert.ok(onDisk.ok && onDisk.file);
      assert.equal(onDisk.file.positions[0]!.highWaterPrice, 0.00013);
      assert.deepEqual(readdirSync(d).filter((f) => f.includes(".tmp-")), [], "atomic write leaves no temp file");

      const b = new PaperLedger(200, d); // new process: fresh $200 bankroll
      b.enablePositionPersistence({ path, mode: "live" });
      const r = b.restorePositions();
      assert.ok(r.ok);
      assert.equal(r.restored.length, 1);
      assert.deepEqual(b.openPositions[0], { ...p, highWaterPrice: 0.00013, trailArmed: true });
      // Cash comes from the file (cost already deducted) — not $200 again.
      assert.equal(b.cash, 185);
      // Close → file goes flat.
      b.recordSell(fill(R, "KEEP", "sell", Date.now(), { positionId: p.id, notionalUsd: 17 }), 2, 17);
      const flat = readPositionsFile(path, "live");
      assert.ok(flat.ok && flat.file);
      assert.equal(flat.file.positions.length, 0);
      // A flat file never changes a fresh session's cash.
      const c = new PaperLedger(200, d);
      c.enablePositionPersistence({ path, mode: "live" });
      c.restorePositions();
      assert.equal(c.cash, 200);
      assert.equal(c.openPositions.length, 0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("modes never mix; a corrupt file is moved aside (not overwritten) and reported", () => {
    const d = mkdtempSync(join(tmpdir(), "rt2-"));
    try {
      assert.notEqual(positionsFileName("live"), positionsFileName("live_dry_run"));
      assert.notEqual(positionsFileName("paper"), positionsFileName("live"));
      const path = join(d, positionsFileName("live"));
      writeFileSync(path, "{ not json");
      const l = new PaperLedger(200, d);
      l.enablePositionPersistence({ path, mode: "live" });
      const r = l.restorePositions();
      assert.equal(r.ok, false);
      assert.ok(!r.ok && r.movedTo && existsSync(r.movedTo));
      assert.equal(readFileSync(r.movedTo!, "utf8"), "{ not json");
      // Wrong-mode file is rejected too.
      writeFileSync(path, JSON.stringify({ version: 1, mode: "live_dry_run", savedAt: 1, cashUsd: 1, realizedPnlUsd: 0, positions: [] }));
      assert.equal(new PaperLedger(200, d).restorePositions().ok, true); // persistence not enabled → no-op
      const l2 = new PaperLedger(200, d);
      l2.enablePositionPersistence({ path, mode: "live" });
      assert.equal(l2.restorePositions().ok, false);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
describe("crash mid-position (LIVE DRY-RUN engine)", () => {
  it("a new process restores the open position and its exits resume; cash is not double counted", async () => {
    const ld = mkdtempSync(join(tmpdir(), "crash-"));
    try {
      const cfg = cfgFor(ld);
      const market = new Market();
      market.prices.set(R, 0.0001);
      market.signal = R;
      const rpc1 = new Rpc();
      const e1 = new BotEngine(cfg, { market, liveBroker: mkBroker(rpc1, new Builder(), "live_dry_run", cfg), solanaWs: null, solanaRpc: passRug as never });
      assert.ok((await e1.start()).ok);
      await wait(150);
      assert.equal(e1.ledger.openPositions.length, 1);
      const before = e1.ledger.openPositions[0]!;
      const cashAtCrash = e1.ledger.cash;
      assert.ok(Math.abs(cashAtCrash - 185) < 1e-9);
      const path = join(ld, "live", positionsFileName("live_dry_run"));
      const snapshotAtCrash = readFileSync(path, "utf8"); // what's on disk when the process dies
      market.signal = null;
      await e1.stop();
      await e1.stop();
      await e1.dispose();
      writeFileSync(path, snapshotAtCrash); // the crash: no clean shutdown after this point

      const rpc2 = new Rpc(); // dry-run: wallet holds NOTHING — must not be "reconciled" away
      const e2 = new BotEngine(cfg, { market, liveBroker: mkBroker(rpc2, new Builder(), "live_dry_run", cfg), solanaWs: null, solanaRpc: passRug as never });
      assert.equal(e2.ledger.openPositions.length, 1);
      assert.deepEqual({ ...e2.ledger.openPositions[0]! }, { ...before });
      assert.ok(Math.abs(e2.ledger.cash - cashAtCrash) < 1e-9, "cash restored, not reset to bankroll");
      assert.equal(e2.getStatus().positionRecovery?.restored.length, 1);
      assert.equal(e2.getOpenPositionsReport().flat, false);
      assert.ok(e2.events.since(0, 100).some((e) => e.type === "positions_restored"));
      // Exits resume: price jumps past +15% take-profit.
      market.prices.set(R, 0.0002);
      assert.ok((await e2.start()).ok);
      await wait(200);
      assert.equal(rpc2.tokenCalls.length, 0, "dry-run never reconciles against the wallet");
      assert.equal(e2.ledger.openPositions.length, 0);
      const sell = e2.ledger.getTrades(5).find((t) => t.fill.side === "sell")!;
      assert.equal(sell.fill.reason, "take_profit");
      assert.ok(Math.abs(e2.ledger.cash - (cashAtCrash + sell.fill.notionalUsd)) < 1e-6);
      assert.ok(e2.ledger.cash < 200 + 20, "no phantom second $15");
      assert.equal(e2.getOpenPositionsReport().flat, true);
      assert.equal(rpc2.sends, 0);
      await e2.stop();
      await e2.stop();
      await e2.dispose();
    } finally {
      rmSync(ld, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
describe("LIVE startup reconciliation", () => {
  it("planner: adopt bot-bought orphan, missing restored, ignore unrelated + sold + dust, unconfirmed buy", () => {
    const now = Date.now();
    const plan = planReconciliation({
      now,
      positions: [pos(B, "MISS"), pos(R, "KEEP")],
      wallet: new Map([
        [A, { qty: 100_000, programIds: [TOKEN_2022_PROGRAM_ID] }],
        [R, { qty: 150_000, programIds: [TOKEN_PROGRAM_ID] }],
        [C, { qty: 40_000, programIds: [TOKEN_PROGRAM_ID] }],
        [D, { qty: 9_000, programIds: [TOKEN_PROGRAM_ID] }],
        [DUST1, { qty: 3, programIds: [TOKEN_PROGRAM_ID] }],
        [DUST2, { qty: 12, programIds: [TOKEN_2022_PROGRAM_ID] }],
        ["OldBuy1111111111111111111111111111111111pump", { qty: 1000, programIds: [TOKEN_PROGRAM_ID] }],
      ]),
      fills: [
        fill(A, "ADOPT", "buy", now - 3_600_000, { qty: 100_000 }),
        fill(C, "SOLD", "buy", now - 7_200_000),
        fill(C, "SOLD", "sell", now - 7_000_000),
        fill("OldBuy1111111111111111111111111111111111pump", "OLD", "buy", now - 48 * 3_600_000),
        // paper / dry-run fills never count as the bot's live buys
        fill(DUST1, "PAPER", "buy", now - 60_000, { paper: true, mode: "paper" }),
        fill(DUST2, "DRY", "buy", now - 60_000, { mode: "live_dry_run", signature: null }),
      ],
      events: [{ kind: "live_buy_unconfirmed", mint: D, symbol: "UNCONF", signature: "sig-D", timestamp: now - 600_000 }],
    });
    assert.deepEqual(plan.missing.map((p) => p.mint), [B]);
    assert.deepEqual(plan.adjusted, []);
    assert.deepEqual(plan.adopt.map((c) => c.mint).sort(), [A, D].sort());
    assert.equal(plan.adopt.find((c) => c.mint === A)!.fill!.signature, "sig-ADOPT-buy");
    assert.equal(plan.adopt.find((c) => c.mint === D)!.event!.signature, "sig-D");
    assert.deepEqual(plan.skipped.map((s) => s.mint), [C]);
    assert.equal(plan.ignoredUnrelated, 3); // DUST1, DUST2, >24h-old buy
  });

  it("engine (LIVE): adopts the Token-2022 orphan + unconfirmed buy, closes the missing one WITHOUT selling, leaves Mark's coins alone", async () => {
    const ld = mkdtempSync(join(tmpdir(), "recon-"));
    try {
      const cfg = cfgFor(ld, { tradingMode: "live" });
      const now = Date.now();
      // State left by the previous process: two open positions (B, R) + live trade log + problem log.
      mkdirSync(join(ld, "live"), { recursive: true });
      writeFileSync(
        join(ld, "live", positionsFileName("live")),
        JSON.stringify({ version: 1, mode: "live", savedAt: now - 1000, cashUsd: 170, realizedPnlUsd: 0, positions: [pos(B, "MISS"), pos(R, "KEEP", { highWaterPrice: 0.0001, trailArmed: false })] }),
      );
      const trades: TradeRecord[] = [
        { fill: fill(B, "MISS", "buy", now - 120_000), cashAfter: 185 },
        { fill: fill(R, "KEEP", "buy", now - 100_000), cashAfter: 170 },
        { fill: fill(A, "ADOPT", "buy", now - 3_600_000, { qty: 100_000, price: 0.0002, notionalUsd: 20, feesUsd: 0.5 }), cashAfter: 150 },
        { fill: fill(C, "SOLD", "buy", now - 7_200_000), cashAfter: 135 },
        { fill: fill(C, "SOLD", "sell", now - 7_000_000), realizedPnlUsd: 0, cashAfter: 150 },
      ];
      writeFileSync(join(ld, "live", "trades.json"), JSON.stringify(trades));
      writeFileSync(join(ld, "live-events.json"), JSON.stringify([
        { kind: "live_buy_unconfirmed", symbol: "UNCONF", mint: D, detail: "sent, not confirmed", signature: "sig-D", timestamp: now - 600_000 },
      ]));
      const market = new Market();
      for (const [m, px] of [[A, 0.0002], [R, 0.0001], [D, 0.001], [C, 0.0001]] as const) market.prices.set(m, px);
      // Wallet: A split over Token-2022 accounts, R intact, B gone, C leftovers, D unconfirmed buy landed, Mark's dust coins.
      const rpc = new Rpc([
        tok(A, 60_000, TOKEN_2022_PROGRAM_ID), tok(A, 40_000, TOKEN_2022_PROGRAM_ID),
        tok(R, 150_000), tok(C, 40_000), tok(D, 9_000),
        tok(DUST1, 3), tok(DUST2, 12, TOKEN_2022_PROGRAM_ID),
      ]);
      const builder = new Builder();
      const e = new BotEngine(cfg, { market, liveBroker: mkBroker(rpc, builder, "live", cfg), solanaWs: null, solanaRpc: null });
      // Restored at boot (before any start).
      assert.deepEqual(e.ledger.openPositions.map((p) => p.mint).sort(), [B, R].sort());
      assert.equal(e.ledger.cash, 170);

      assert.ok((await e.start()).ok);
      await wait(100);
      assert.deepEqual(rpc.tokenCalls.sort(), [TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID].sort());
      const rec = e.getStatus().positionRecovery!;
      assert.deepEqual(rec.adopted.map((a) => a.mint).sort(), [A, D].sort());
      const a = e.ledger.openPositions.find((p) => p.mint === A)!;
      assert.equal(a.qty, 100_000); // both Token-2022 accounts summed
      assert.equal(a.entryPrice, 0.0002); // from the bot's own buy fill
      assert.equal(a.entrySignature, "sig-ADOPT-buy");
      assert.equal(a.adopted?.entrySource, "live_buy_fill");
      const dpos = e.ledger.openPositions.find((p) => p.mint === D)!;
      assert.equal(dpos.adopted?.entrySource, "unconfirmed_buy_mark");
      assert.equal(dpos.entryPrice, 0.001);
      assert.deepEqual(rec.missing.map((m) => m.mint), [B]);
      assert.ok(!e.ledger.openPositions.some((p) => p.mint === B));
      assert.ok(e.ledger.openPositions.some((p) => p.mint === R));
      assert.ok(!e.ledger.openPositions.some((p) => [C, DUST1, DUST2].includes(p.mint)));
      assert.equal(rec.ignoredUnrelatedMints, 2);
      assert.deepEqual(rec.notAdopted.map((n) => n.mint), [C]);
      // No sell attempted for the missing coin (nor anything else).
      assert.equal(builder.calls.length, 0);
      assert.equal(rpc.sends, 0);
      // Journal problem log + alerts in plain words.
      const ev = e.journal.listEvents().find((x) => x.kind === "reconciled_missing")!;
      assert.equal(ev.mint, B);
      assert.match(ev.detail, /no sell was attempted/);
      const types = e.events.since(0, 100).map((x) => x.type);
      assert.ok(types.includes("position_missing"));
      assert.equal(types.filter((t) => t === "position_adopted").length, 2);
      assert.ok(rec.messages.some((m) => /wasn't tracking/.test(m)));
      // Cash: restored $170, missing B not refunded, adopted cost deducted (A $20, D 9000×0.001 = $9).
      assert.ok(Math.abs(e.ledger.cash - (170 - 20 - 9)) < 1e-9);
      // Persisted: the next restart sees the adopted positions, not B.
      const disk = readPositionsFile(join(ld, "live", positionsFileName("live")), "live");
      assert.ok(disk.ok && disk.file);
      assert.deepEqual(disk.file.positions.map((p) => p.mint).sort(), [A, D, R].sort());
      // /positions reports not flat with levels.
      const rep = e.getOpenPositionsReport();
      assert.equal(rep.flat, false);
      assert.equal(rep.count, 3);
      assert.ok(rep.positions.every((p) => p.levels.stopLossPrice > 0));
      assert.equal(rep.positionsFile, "data/live/open-positions.json");

      await e.stop();
      await e.stop();
      await e.dispose();
      // Second start: nothing new to adopt (already tracked), B never comes back.
      const e2 = new BotEngine(cfg, { market, liveBroker: mkBroker(rpc, builder, "live", cfg), solanaWs: null, solanaRpc: null });
      assert.ok((await e2.start()).ok);
      await wait(50);
      assert.deepEqual(e2.getStatus().positionRecovery!.adopted, []);
      assert.deepEqual(e2.ledger.openPositions.map((p) => p.mint).sort(), [A, D, R].sort());
      await e2.stop();
      await e2.stop();
      await e2.dispose();
    } finally {
      rmSync(ld, { recursive: true, force: true });
    }
  });

  it("wallet read fails → still starts, restored positions kept, plain warning", async () => {
    const ld = mkdtempSync(join(tmpdir(), "recon-err-"));
    try {
      const cfg = cfgFor(ld, { tradingMode: "live" });
      mkdirSync(join(ld, "live"), { recursive: true });
      writeFileSync(join(ld, "live", positionsFileName("live")), JSON.stringify({ version: 1, mode: "live", savedAt: 1, cashUsd: 185, realizedPnlUsd: 0, positions: [pos(R, "KEEP")] }));
      const market = new Market();
      market.prices.set(R, 0.0001);
      const rpc = new Rpc([], new Error("getTokenAccountsByOwner failed: HTTP 429 https://rpc.secret.example/?api-key=SECRET"));
      const e = new BotEngine(cfg, { market, liveBroker: mkBroker(rpc, new Builder(), "live", cfg), solanaWs: null, solanaRpc: null });
      assert.ok((await e.start()).ok);
      const rec = e.getStatus().positionRecovery!;
      assert.ok(rec.reconcileError);
      assert.ok(!JSON.stringify(rec).includes("SECRET"));
      assert.equal(e.ledger.openPositions.length, 1);
      assert.ok(e.events.since(0, 100).some((x) => x.type === "reconcile_failed"));
      await e.stop();
      await e.stop();
      await e.dispose();
    } finally {
      rmSync(ld, { recursive: true, force: true });
    }
  });

  it("HTTPS RPC reads Token + Token-2022 accounts (jsonParsed) and the broker sums per mint", async () => {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      const req = JSON.parse(init.body) as { method: string; params: unknown[] };
      calls.push(req);
      const prog = (req.params[1] as { programId: string }).programId;
      const acct = (mint: string, amount: string, decimals: number) => ({ account: { data: { parsed: { info: { mint, tokenAmount: { amount, decimals } } } } } });
      const value = prog === TOKEN_2022_PROGRAM_ID ? [acct(A, "1500000", 6), acct(A, "500000", 6)] : [acct(DUST1, "7", 0)];
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value } }), { status: 200 });
    }) as never;
    const rpc = new HttpsLiveRpc("https://rpc.example.invalid", fakeFetch);
    const t22 = await rpc.getTokenAccountsByOwner(signer.publicKey, TOKEN_2022_PROGRAM_ID);
    assert.equal(t22.length, 2);
    assert.equal(calls[0]!.method, "getTokenAccountsByOwner");
    assert.deepEqual((calls[0]!.params[2] as { encoding: string }).encoding, "jsonParsed");
    let t = 0;
    const broker = new LiveBroker({
      signer, rpc, builder: new Builder(), mode: "live", settings: loadLiveSettings({}),
      sleep: async (ms) => { t += ms; }, now: () => t,
    });
    const bal = await broker.getWalletTokenBalances();
    assert.equal(bal.get(A)!.qty, 2);
    assert.deepEqual(bal.get(A)!.programIds, [TOKEN_2022_PROGRAM_ID]);
    assert.equal(bal.get(DUST1)!.qty, 7);
  });
});

// ---------------------------------------------------------------------------
describe("graceful shutdown", () => {
  it("SIGTERM on the API process writes the positions file and exits 0", async () => {
    const ld = mkdtempSync(join(tmpdir(), "sig-"));
    const port = 18_000 + Math.floor(Math.random() * 2_000);
    let child: ReturnType<typeof spawn> | null = null;
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v != null && k !== "SOLANA_RPC_URL" && k !== "SOLANA_RPC_WSS_URL") env[k] = v;
      Object.assign(env, { LEDGER_DIR: ld, API_HOST: "127.0.0.1", API_PORT: String(port), PAPER_MODE: "true", LIVE_TRADING_ENABLED: "false" });
      child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "api"], { env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout!.on("data", (b) => { out += String(b); });
      child.stderr!.on("data", (b) => { out += String(b); });
      const deadline = Date.now() + 30_000;
      while (!/Control API ready|Listening on/.test(out) && Date.now() < deadline) await wait(100);
      assert.match(out, /Listening on|Control API ready/);
      // GET /positions on the live process: flat, with the mode + file location.
      const pr = (await (await fetch(`http://127.0.0.1:${port}/positions`)).json()) as { flat: boolean; count: number; tradingMode: string; positionsFile: string };
      assert.equal(pr.flat, true);
      assert.equal(pr.count, 0);
      assert.equal(pr.tradingMode, "paper");
      assert.match(pr.positionsFile, /open-positions\.paper\.json$/);
      const proc = child;
      const code = await new Promise<number | null>((resolve) => {
        proc.on("exit", (c) => resolve(c));
        proc.kill("SIGTERM");
      });
      child = null;
      assert.equal(code, 0, out.slice(-800));
      const f = readPositionsFile(join(ld, positionsFileName("paper")), "paper");
      assert.ok(f.ok && f.file, "positions file flushed on shutdown");
      assert.equal(f.file.positions.length, 0);
      assert.match(out, /SIGTERM: shutting down API… flat/);
    } finally {
      if (child) child.kill("SIGKILL");
      rmSync(ld, { recursive: true, force: true });
    }
  });
});
