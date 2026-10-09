/**
 * Live-trading safety tests. Mocked RPC + mocked PumpPortal only.
 * No network, no real sends. A throwaway keypair is generated in a temp dir
 * and deleted afterwards (never committed).
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify as edVerify, createPublicKey } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTradingMode, loadLiveSettings, sellSlippageLadder, LIVE_CONFIRM_PHRASE } from "../src/live/mode.js";
import { applyTradingModeGates, assertPaperOrStubLive } from "../src/config.js";
import { loadLiveSigner, permsTooOpen, type LiveSigner } from "../src/live/keypair.js";
import { parseTransaction, signTransaction, txSignature } from "../src/live/tx.js";
import { redactSecrets } from "../src/live/redact.js";
import { LiveBroker, dryRunCostModelFromConfig, type DryRunCostModel } from "../src/live/liveBroker.js";
import { PaperBroker } from "../src/broker/paper.js";
import { PAPER_FEE_DEFAULTS, computeBuyCosts, loadPaperFeeSettings, type PaperFeeSettings } from "../src/broker/paperFees.js";
import type { LiveRpc, TxMeta } from "../src/live/rpc.js";
import type { SwapRequest, SwapTxBuilder } from "../src/live/pumpportal.js";
import { PumpPortalBuilder } from "../src/live/pumpportal.js";
import { TradeJournal } from "../src/journal/journal.js";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { base58Encode } from "../src/solana/base58.js";
import type { BotConfig, Position, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";

let dir: string;
let keyPath: string;
let signer: LiveSigner;
let secretBytes: number[];

before(() => {
  dir = mkdtempSync(join(tmpdir(), "live-test-"));
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  secretBytes = [...seed, ...pub];
  keyPath = join(dir, "test-keypair.json");
  writeFileSync(keyPath, JSON.stringify(secretBytes), { mode: 0o600 });
  chmodSync(keyPath, 0o600);
  const r = loadLiveSigner(keyPath);
  assert.ok(r.ok);
  signer = r.signer;
});
after(() => rmSync(dir, { recursive: true, force: true }));

// ---------- gates ----------
describe("trading mode gates", () => {
  const vals = {
    PAPER_MODE: [undefined, "", "true", "false", "FALSE", "0"],
    LIVE_TRADING_ENABLED: [undefined, "", "false", "true", "yes"],
    LIVE_CONFIRM: [undefined, "", "i_understand", "I UNDERSTAND", "yes", LIVE_CONFIRM_PHRASE],
  };
  it("every combination missing any gate resolves to paper", () => {
    let liveCount = 0;
    for (const p of vals.PAPER_MODE)
      for (const e of vals.LIVE_TRADING_ENABLED)
        for (const c of vals.LIVE_CONFIRM)
          for (const d of [undefined, "true", "false", "nope"]) {
            const env = { PAPER_MODE: p, LIVE_TRADING_ENABLED: e, LIVE_CONFIRM: c, LIVE_DRY_RUN: d };
            const allPass =
              ["false", "0"].includes((p ?? "").toLowerCase()) &&
              ["true", "yes"].includes(e ?? "") &&
              c === LIVE_CONFIRM_PHRASE;
            const m = resolveTradingMode(env).mode;
            if (!allPass) assert.equal(m, "paper", JSON.stringify(env));
            else {
              liveCount++;
              assert.equal(m, d === "false" ? "live" : "live_dry_run", JSON.stringify(env));
            }
          }
    assert.ok(liveCount > 0);
  });
  it("empty env is paper; dry-run is the default once live gates pass", () => {
    assert.equal(resolveTradingMode({}).mode, "paper");
    assert.equal(
      resolveTradingMode({ PAPER_MODE: "false", LIVE_TRADING_ENABLED: "true", LIVE_CONFIRM: LIVE_CONFIRM_PHRASE }).mode,
      "live_dry_run",
    );
  });
  it("applyTradingModeGates forces paperMode=true when gates fail, and rug filter on in live", () => {
    const c1 = applyTradingModeGates({ paperMode: false, rugFilterEnabled: false } as BotConfig, { PAPER_MODE: "false" });
    assert.equal(c1.paperMode, true);
    assert.equal(c1.tradingMode, "paper");
    assert.equal(c1.live, undefined);
    const c2 = applyTradingModeGates({ paperMode: false, rugFilterEnabled: false } as BotConfig, {
      PAPER_MODE: "false", LIVE_TRADING_ENABLED: "true", LIVE_CONFIRM: LIVE_CONFIRM_PHRASE,
    });
    assert.equal(c2.paperMode, false);
    assert.equal(c2.tradingMode, "live_dry_run");
    assert.equal(c2.rugFilterEnabled, true);
  });
  it("live refuses to start without keypair path / RPC", () => {
    const cfg = { paperMode: false, tradingMode: "live" } as BotConfig;
    assert.throws(() => assertPaperOrStubLive(cfg, {}), /LIVE_WALLET_KEYPAIR_PATH/);
    assert.doesNotThrow(() => assertPaperOrStubLive({ paperMode: true } as BotConfig, {}));
  });
});

describe("live caps", () => {
  it("defaults are conservative", () => {
    const s = loadLiveSettings({});
    assert.equal(s.maxPositionUsd, 60);
    assert.equal(s.maxOpenPositions, 1);
    assert.equal(s.dailyLossLimitUsd, 300);
    assert.ok(s.priorityFeeSol <= s.priorityFeeMaxSol);
  });
  it("priority fee is clamped to the hard cap", () => {
    const s = loadLiveSettings({ LIVE_PRIORITY_FEE_SOL: "0.5", LIVE_PRIORITY_FEE_MAX_SOL: "0.002" });
    assert.equal(s.priorityFeeSol, 0.002);
  });
  it("sell ladder escalates from base to cap", () => {
    assert.deepEqual(sellSlippageLadder({ slippageBps: 1000, sellMaxSlippageBps: 4000, sellMaxAttempts: 4 }), [1000, 2000, 3000, 4000]);
  });
});

// ---------- keypair + redaction ----------
describe("keypair safety", () => {
  it("refuses group/world-readable keypair files", () => {
    const p = join(dir, "open.json");
    writeFileSync(p, JSON.stringify(secretBytes));
    chmodSync(p, 0o644);
    const r = loadLiveSigner(p, { platform: "linux" });
    assert.equal(r.ok, false);
    assert.match((r as { error: string }).error, /chmod 600/);
    assert.ok(!(r as { error: string }).error.includes(String(secretBytes[0]) + ","));
    assert.equal(permsTooOpen(0o100600, "linux"), false);
    assert.equal(permsTooOpen(0o100640, "linux"), true);
  });
  it("bad file errors never echo contents", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, '{"secret":"SHOULD_NOT_APPEAR"}', { mode: 0o600 });
    const r = loadLiveSigner(p);
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes("SHOULD_NOT_APPEAR"));
  });
  it("signer exposes only the public key when serialized", () => {
    const j = JSON.stringify(signer);
    assert.deepEqual(JSON.parse(j), { publicKey: signer.publicKey });
  });
  it("redacts key bytes, base58 secret, RPC URL and api keys", () => {
    const b58 = base58Encode(Uint8Array.from(secretBytes));
    const env = { SOLANA_RPC_URL: "https://rpc.example.com/?api-key=abc123" };
    const out = redactSecrets(
      `boom ${JSON.stringify(secretBytes)} ${b58} https://rpc.example.com/?api-key=abc123 api_key=zzz`,
      env,
    );
    assert.ok(!out.includes(b58));
    assert.ok(!out.includes("abc123"));
    assert.ok(!out.includes("zzz"));
    assert.ok(!out.includes(JSON.stringify(secretBytes)));
  });
});

// ---------- tx helpers ----------
function fakeTx(feePayer: Uint8Array, extraSigners = 0): Uint8Array {
  const nSig = 1 + extraSigners;
  const msg = [0x80, nSig, 0, 1, 2, ...feePayer, ...new Array(32).fill(7), ...new Array(32).fill(9), ...new Array(40).fill(0)];
  return Uint8Array.from([nSig, ...new Array(64 * nSig).fill(0), ...msg]);
}

describe("transaction signing", () => {
  it("signs when fee payer is our wallet; signature verifies", () => {
    const tx = fakeTx(signer.publicKeyBytes);
    const signed = signTransaction(tx, signer);
    const p = parseTransaction(signed);
    assert.equal(p.feePayer, signer.publicKey);
    const pubDer = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(signer.publicKeyBytes)]);
    const ok = edVerify(null, p.message, createPublicKey({ key: pubDer, format: "der", type: "spki" }), signed.subarray(1, 65));
    assert.ok(ok);
    assert.equal(txSignature(signed).length > 60, true);
  });
  it("refuses a tx paid by someone else or with extra signers", () => {
    assert.throws(() => signTransaction(fakeTx(new Uint8Array(32).fill(3)), signer), /fee payer/);
    assert.throws(() => signTransaction(fakeTx(signer.publicKeyBytes, 1), signer), /extra signers/);
  });
});

// ---------- broker with mocks ----------
class MockBuilder implements SwapTxBuilder {
  calls: SwapRequest[] = [];
  constructor(private readonly pk: () => Uint8Array) {}
  async buildTx(req: SwapRequest) {
    this.calls.push(req);
    return fakeTx(this.pk());
  }
}

interface MockRpcOpts {
  balanceSol?: number;
  simErr?: (n: number) => unknown;
  sendThrows?: (n: number) => boolean;
  status?: (n: number) => { confirmationStatus: "confirmed" | null; err: unknown } | null;
  meta?: (kind: "buy" | "sell") => TxMeta;
}
class MockRpc implements LiveRpc {
  sends = 0;
  sims = 0;
  kind: "buy" | "sell" = "buy";
  constructor(private readonly o: MockRpcOpts = {}) {}
  async getBalanceLamports() { return (this.o.balanceSol ?? 1) * 1e9; }
  async simulate() { this.sims++; return { err: this.o.simErr?.(this.sims) ?? null, logs: [] }; }
  async send() {
    this.sends++;
    if (this.o.sendThrows?.(this.sends)) throw new Error("send failed https://rpc.secret.example/?api-key=SECRET");
    return "sig";
  }
  async getSignatureStatus() { return this.o.status ? this.o.status(this.sends) : { confirmationStatus: "confirmed" as const, err: null }; }
  async getTransactionMeta() {
    return { meta: this.o.meta!(this.kind), accountKeys: [signer.publicKey, "Other"] };
  }
}

const MINT = "So1aMint1111111111111111111111111111111111";
function buyMeta(): TxMeta {
  return {
    err: null, fee: 105_000,
    preBalances: [1_000_000_000, 0], postBalances: [873_000_000, 0], // spent 0.127 SOL
    preTokenBalances: [],
    postTokenBalances: [{ accountIndex: 1, mint: MINT, owner: signer.publicKey, uiTokenAmount: { amount: "500000000000", decimals: 6, uiAmount: 500000 } }],
  };
}
function sellMeta(): TxMeta {
  return {
    err: null, fee: 105_000,
    preBalances: [873_000_000, 0], postBalances: [1_000_000_000, 0], // +0.127 SOL
    preTokenBalances: [{ accountIndex: 1, mint: MINT, owner: signer.publicKey, uiTokenAmount: { amount: "500000000000", decimals: 6, uiAmount: 500000 } }],
    postTokenBalances: [],
  };
}

function mkBroker(rpc: MockRpc, mode: "live" | "live_dry_run" = "live", env: Record<string, string> = {}, dryRunCosts?: DryRunCostModel) {
  const builder = new MockBuilder(() => signer.publicKeyBytes);
  const settings = loadLiveSettings({ LIVE_CONFIRM_TIMEOUT_MS: "5000", ...env });
  let t = 0;
  const broker = new LiveBroker({
    signer, rpc, builder, settings, mode,
    ...(dryRunCosts ? { dryRunCosts } : {}),
    sleep: async (ms) => { t += ms; },
    now: () => t,
  });
  return { broker, builder, settings };
}

describe("LiveBroker", () => {
  const buyArgs = { mint: MINT, symbol: "TST", markPrice: 0.00003, notionalUsd: 15, solUsd: 118 };

  it("refuses (never shrinks) a buy above LIVE_MAX_POSITION_USD; exact size at the cap fills from the on-chain delta", async () => {
    const rpc = new MockRpc({ meta: buyMeta });
    const { broker, builder } = mkBroker(rpc, "live", { LIVE_MAX_POSITION_USD: "15" });
    const over = await broker.buy({ ...buyArgs, notionalUsd: 100 });
    assert.equal(over.ok, false);
    assert.match((over as { reason: string }).reason, /above LIVE_MAX_POSITION_USD/);
    assert.equal(builder.calls.length, 0);
    assert.equal(rpc.sends, 0);
    const r = await broker.buy(buyArgs);
    assert.ok(r.ok);
    assert.equal(builder.calls[0]!.amount, Number((15 / 118).toFixed(6)));
    assert.equal(r.fill.qty, 500000);
    assert.ok(Math.abs(r.fill.notionalUsd - 0.127 * 118) < 1e-9);
    assert.equal(r.fill.mode, "live");
    assert.equal(r.fill.paper, false);
    assert.equal(rpc.sends, 1);
  });

  it("failed buy (on-chain error) returns no position — no ghost", async () => {
    const rpc = new MockRpc({ meta: buyMeta, status: () => ({ confirmationStatus: null, err: { InstructionError: [0, "x"] } }) });
    const { broker } = mkBroker(rpc);
    const r = await broker.buy(buyArgs);
    assert.equal(r.ok, false);
  });

  it("buy that never confirms → unconfirmed, no position", async () => {
    const rpc = new MockRpc({ meta: buyMeta, status: () => null });
    const { broker } = mkBroker(rpc);
    const r = await broker.buy(buyArgs);
    assert.equal(r.ok, false);
    assert.equal((r as { unconfirmed?: boolean }).unconfirmed, true);
  });

  it("simulation failure never sends", async () => {
    const rpc = new MockRpc({ meta: buyMeta, simErr: () => "InsufficientFunds" });
    const { broker } = mkBroker(rpc);
    const r = await broker.buy(buyArgs);
    assert.equal(r.ok, false);
    assert.equal(rpc.sends, 0);
  });

  it("refuses when SOL balance would dip below reserve", async () => {
    const rpc = new MockRpc({ meta: buyMeta, balanceSol: 0.1 });
    const { broker } = mkBroker(rpc);
    const r = await broker.buy(buyArgs);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /insufficient SOL/);
    assert.equal(rpc.sims, 0);
  });

  it("dry-run simulates but NEVER sends", async () => {
    const rpc = new MockRpc({ meta: buyMeta });
    const { broker } = mkBroker(rpc, "live_dry_run");
    const r = await broker.buy(buyArgs);
    assert.ok(r.ok);
    assert.equal(r.simulated, true);
    assert.equal(r.fill.mode, "live_dry_run");
    assert.equal(rpc.sims, 1);
    assert.equal(rpc.sends, 0);
    const pos = r.position;
    const s = await broker.sell({ position: pos, markPrice: 0.00004, reason: "take_profit", solUsd: 118 });
    assert.ok(s.ok);
    assert.equal(rpc.sends, 0);
  });

  it("sell retries with escalating slippage, then succeeds", async () => {
    const rpc = new MockRpc({ meta: sellMeta, sendThrows: (n) => n <= 2, status: (n) => (n <= 2 ? null : { confirmationStatus: "confirmed", err: null }) });
    rpc.kind = "sell";
    const { broker, builder } = mkBroker(rpc, "live", { LIVE_SLIPPAGE_BPS: "1000", LIVE_SELL_MAX_SLIPPAGE_BPS: "4000", LIVE_SELL_MAX_ATTEMPTS: "4" });
    const pos = { id: "p1", mint: MINT, symbol: "TST", side: "long", qty: 500000, entryPrice: 0.00003, entryNotionalUsd: 15, entryFeesUsd: 0, highWaterPrice: 0.00003, trailArmed: false, openedAt: 0 } as Position;
    const s = await broker.sell({ position: pos, markPrice: 0.00003, reason: "stop_loss", solUsd: 118 });
    assert.ok(s.ok);
    assert.equal(s.attempts, 3);
    assert.deepEqual(builder.calls.map((c) => c.slippageBps), [1000, 2000, 3000]);
    for (let i = 1; i < builder.calls.length; i++) assert.ok(builder.calls[i]!.priorityFeeSol >= builder.calls[i - 1]!.priorityFeeSol);
  });

  it("sell that fails every attempt reports failure with redacted errors", async () => {
    const rpc = new MockRpc({ meta: sellMeta, sendThrows: () => true, status: () => null });
    const { broker } = mkBroker(rpc, "live", { LIVE_SELL_MAX_ATTEMPTS: "3" });
    const pos = { id: "p2", mint: MINT, symbol: "TST", side: "long", qty: 1, entryPrice: 1, entryNotionalUsd: 15, entryFeesUsd: 0, highWaterPrice: 1, trailArmed: false, openedAt: 0 } as Position;
    const s = await broker.sell({ position: pos, markPrice: 1, reason: "stop_loss", solUsd: 118 });
    assert.equal(s.ok, false);
    assert.equal(s.attempts, 3);
    const txt = JSON.stringify(s);
    assert.ok(!txt.includes("SECRET"));
    assert.ok(!txt.includes("rpc.secret.example/?"));
  });
});

describe("PumpPortal builder", () => {
  it("sends percent slippage and never a key", async () => {
    let body: Record<string, unknown> = {};
    const b = new PumpPortalBuilder(async (_u, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(new Uint8Array(200), { status: 200 });
    });
    await b.buildTx({ publicKey: "PUB", action: "buy", mint: MINT, amount: 0.1, denominatedInSol: true, slippageBps: 1500, priorityFeeSol: 0.0002, pool: "auto" });
    assert.equal(body.slippage, 15);
    assert.equal(body.denominatedInSol, "true");
    assert.deepEqual(Object.keys(body).sort(), ["action", "amount", "denominatedInSol", "mint", "pool", "priorityFee", "publicKey", "slippage"]);
  });
});

// ---------- journal mode tagging ----------
describe("journal mode tagging", () => {
  it("rows carry mode; old rows load as paper; list filters by mode", () => {
    const jd = mkdtempSync(join(tmpdir(), "jr-"));
    try {
      writeFileSync(join(jd, "journal.json"), JSON.stringify([{ id: "old", timestamp: Date.now() - 1000, sizeUsd: 15, pnlUsd: 1 }]));
      const j = new TradeJournal(jd);
      const pos = { id: "p", mint: MINT, symbol: "T", side: "long", qty: 1, entryPrice: 1, entryNotionalUsd: 15, entryFeesUsd: 0, highWaterPrice: 1, trailArmed: false, openedAt: Date.now() - 500 } as Position;
      j.appendClose({ position: pos, exitPrice: 1, pnlUsd: -4, exitReason: "stop_loss", fillId: "f1", mode: "live", signature: "SIG" });
      j.appendClose({ position: pos, exitPrice: 1, pnlUsd: 2, exitReason: "take_profit", fillId: "f2", mode: "live_dry_run" });
      const all = j.list();
      assert.equal(all.total, 3);
      assert.equal(j.list({ mode: "paper" }).entries[0]!.id, "old");
      const live = j.list({ mode: "live" });
      assert.equal(live.total, 1);
      assert.equal(live.entries[0]!.signature, "SIG");
      assert.equal(live.summary.periods.find((p) => p.period === "overall")!.pnlUsd, -4);
      assert.equal(j.realizedSince(0, "live"), -4);
    } finally {
      rmSync(jd, { recursive: true, force: true });
    }
  });
});

// ---------- engine integration (mocked) ----------
class OneCoinMarket implements MarketDataProvider {
  price = 0.00003;
  async scan(): Promise<TokenSnapshot[]> {
    return [{
      mint: MINT, symbol: "TST", name: "Test", priceUsd: this.price, changeWindowPct: 50, volumeWindowUsd: 100_000,
      volumeAvgUsd: 1000, volume24hUsd: 1_000_000, liquidityUsd: 1_000_000, timestamp: Date.now(), createdAt: Date.now() - 3_600_000,
    }];
  }
  async getPrice() { return this.price; }
  async getQuoteUsdRate() { return 118; }
}

function liveCfg(ledgerDir: string): BotConfig {
  return {
    paperMode: false, bankrollUsd: 200, maxOpenTrades: 1, stopLossPct: 8, takeProfitPct: 15, positionSizePct: 0.95, maxPositionUsd: 50,
    momentum: { minPct: 1, windowMinutes: 5, volumeSpikeMult: 1, minLiquidityUsd: 0, minVolume24hUsd: 0, minAgeMinutes: 0 },
    trailingTakeProfit: { activatePct: 10, distancePct: 5 }, paperBroker: { slippageBps: 50, feeBps: 30 },
    runner: { pollIntervalMs: 10, scanLimit: 5, maxCycles: 0 }, maxHoldMinutes: 0, dailyLossUsd: 0, chaseLockoutHours: 0,
    marketDataSource: "mock", ledgerDir, activePreset: "custom", requireChecklistGo: false,
    solanaRpcConfigured: true, solanaRpcWssConfigured: false, rugFilterEnabled: false, rugFilterMaxTopHolderPct: 30, rugFilterMaxSameSlotBuys: 3,
    tradingMode: "live_dry_run", live: loadLiveSettings({}),
  };
}

describe("engine in LIVE DRY-RUN (mocked)", () => {
  it("status shows label + public key only; rug filter is mandatory; buy cap enforced; never sends", async () => {
    const ld = mkdtempSync(join(tmpdir(), "eng-"));
    try {
      const rpc = new MockRpc({ meta: buyMeta });
      const { broker } = mkBroker(rpc, "live_dry_run");
      const market = new OneCoinMarket();
      let rugCalls = 0;
      const rugRpc = new Proxy({}, { get: () => async () => { rugCalls++; throw new Error("no rpc in test"); } });
      const engine = new BotEngine(liveCfg(ld), {
        market, liveBroker: broker, solanaWs: null, solanaRpc: rugRpc as never,
        ledger: new PaperLedger(200, join(ld, "live")),
      });
      const st = engine.getStatus();
      assert.equal(st.modeLabel, "LIVE DRY-RUN");
      assert.equal(st.live!.walletPublicKey, signer.publicKey);
      assert.ok(!JSON.stringify(st).includes(keyPath));
      const started = await engine.start();
      assert.ok(started.ok, started.message);
      await new Promise((r) => setTimeout(r, 150));
      // Rug filter threw → buy skipped (mandatory filter in live; fails closed).
      assert.ok(rugCalls > 0);
      assert.equal(engine.ledger.openPositions.length, 0);
      await engine.stop();
      assert.equal(rpc.sends, 0);
      await engine.dispose();
    } finally {
      rmSync(ld, { recursive: true, force: true });
    }
  });

  it("kill switch: stop with an open position halts buys but keeps managing; second stop fully stops", async () => {
    const ld = mkdtempSync(join(tmpdir(), "eng2-"));
    try {
      const rpc = new MockRpc({ meta: buyMeta });
      const { broker } = mkBroker(rpc, "live_dry_run");
      const market = new OneCoinMarket();
      const engine = new BotEngine(liveCfg(ld), { market, liveBroker: broker, solanaWs: null, solanaRpc: null, ledger: new PaperLedger(200, join(ld, "live")) });
      // Inject a position directly (rug RPC is null → buys skip, which is the safe default).
      const r = await broker.buy({ mint: MINT, symbol: "TST", markPrice: market.price, notionalUsd: 15, solUsd: 118 });
      assert.ok(r.ok);
      engine.ledger.recordBuy(r.fill, r.position);
      assert.ok(r.fill.notionalUsd <= 15 + 0.0002 * 118 + 1e-9); // cap + priority fee
      await engine.start();
      const first = await engine.stop();
      assert.match(first.message, /halted/i);
      assert.equal(engine.getStatus().state, "running");
      assert.equal(engine.getStatus().live!.buysHalted, true);
      // Price pops past TP → simulated sell closes it → loop stops itself.
      market.price = 0.00004;
      await new Promise((res) => setTimeout(res, 3500));
      assert.equal(engine.ledger.openPositions.length, 0);
      const rows = engine.journal.list({ mode: "live_dry_run" });
      assert.equal(rows.total, 1);
      assert.equal(rows.entries[0]!.mode, "live_dry_run");
      await engine.stop();
      assert.equal(engine.getStatus().state, "stopped");
      assert.equal(rpc.sends, 0);
      await engine.dispose();
    } finally {
      rmSync(ld, { recursive: true, force: true });
    }
  });

  it("paper engine with default config reports PAPER and no live block", async () => {
    const ld = mkdtempSync(join(tmpdir(), "eng3-"));
    try {
      const cfg = { ...liveCfg(ld), paperMode: true, tradingMode: "paper" as const, live: undefined };
      const engine = new BotEngine(cfg, { market: new OneCoinMarket(), solanaWs: null, solanaRpc: null });
      const st = engine.getStatus();
      assert.equal(st.modeLabel, "PAPER");
      assert.equal(st.live, null);
      await engine.dispose();
    } finally {
      rmSync(ld, { recursive: true, force: true });
    }
  });
});

describe("default config (no new env vars) is unchanged paper", () => {
  it("loadConfig with no live env → paper, no live block, rug filter untouched", async () => {
    const keys = ["PAPER_MODE", "LIVE_TRADING_ENABLED", "LIVE_CONFIRM", "LIVE_DRY_RUN", "LIVE_WALLET_KEYPAIR_PATH"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
    try {
      const { loadConfig } = await import("../src/config.js");
      const cfg = loadConfig({ skipRuntimeOverlay: true });
      assert.equal(cfg.paperMode, true);
      assert.equal(cfg.tradingMode, "paper");
      assert.equal(cfg.live, undefined);
      assert.equal(cfg.rugFilterEnabled, process.env.RUG_FILTER_ENABLED === "true");
      assert.doesNotThrow(() => assertPaperOrStubLive(cfg));
    } finally {
      for (const k of keys) if (saved[k] !== undefined) process.env[k] = saved[k];
    }
  });
});

// ---------- trade-size hot buttons ----------
import { TradeSizeStore, tradeSizeStatus, isTradeSize, DEFAULT_TRADE_SIZE_USD } from "../src/risk/tradeSize.js";

describe("trade-size hot buttons", () => {
  it("allows only 15/30/60; default is 15", () => {
    for (const v of [15, 30, 60]) assert.ok(isTradeSize(v));
    for (const v of [0, 14, 16, 25, 45, 61, 100, -15, "15", null, undefined, 15.5]) assert.equal(isTradeSize(v), false);
    assert.equal(DEFAULT_TRADE_SIZE_USD, 15);
    assert.equal(loadLiveSettings({}).maxPositionUsd, 60);
  });
  it("persists across restarts (new store instance)", () => {
    const d = mkdtempSync(join(tmpdir(), "ts-"));
    try {
      assert.equal(new TradeSizeStore(d).get(), 15);
      new TradeSizeStore(d).set(30);
      assert.equal(new TradeSizeStore(d).get(), 30);
      writeFileSync(join(d, "trade-size.json"), '{"usd":999}');
      assert.equal(new TradeSizeStore(d).get(), 15);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("cap disables buttons above it and clamps a saved size", () => {
    const st = tradeSizeStatus(60, { usd: 30, source: "LIVE_MAX_POSITION_USD" });
    assert.deepEqual(st.options.map((o) => o.enabled), [true, true, false]);
    assert.match(st.options[2]!.reason!, /LIVE_MAX_POSITION_USD/);
    assert.equal(st.effectiveUsd, 30);
    assert.ok(st.warning);
  });
  it("engine endpoint logic: rejects bad values and above-cap in live; works in paper", async () => {
    const d = mkdtempSync(join(tmpdir(), "ts-eng-"));
    try {
      const cfg = { ...liveCfg(d), live: loadLiveSettings({ LIVE_MAX_POSITION_USD: "30" }) };
      const rpc = new MockRpc({ meta: buyMeta });
      const { broker } = mkBroker(rpc, "live_dry_run");
      const e = new BotEngine(cfg, { market: new OneCoinMarket(), liveBroker: broker, solanaWs: null, solanaRpc: null });
      assert.equal(e.getStatus().tradeSize.selectedUsd, 15);
      assert.equal(e.setTradeSize(25).status, 400);
      assert.equal(e.setTradeSize("30").status, 400);
      assert.equal(e.setTradeSize(60).status, 409);
      assert.equal(e.setTradeSize(30).ok, true);
      assert.equal(e.getStatus().tradeSize.effectiveUsd, 30);
      await e.dispose();
      // Restart → still 30
      const e2 = new BotEngine(cfg, { market: new OneCoinMarket(), liveBroker: broker, solanaWs: null, solanaRpc: null });
      assert.equal(e2.getTradeSize().selectedUsd, 30);
      await e2.dispose();
      // Paper: MAX_POSITION_USD caps (50) → 60 disabled, 30 ok
      const p = new BotEngine({ ...liveCfg(d), paperMode: true, tradingMode: "paper", live: undefined, maxPositionUsd: 50 }, { market: new OneCoinMarket(), solanaWs: null, solanaRpc: null });
      assert.equal(p.setTradeSize(60).status, 409);
      assert.equal(p.setTradeSize(15).ok, true);
      await p.dispose();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("paper buy uses the selected size and the journal records it", async () => {
    const d = mkdtempSync(join(tmpdir(), "ts-buy-"));
    try {
      const cfg = { ...liveCfg(d), paperMode: true, tradingMode: "paper" as const, live: undefined, maxPositionUsd: 100, takeProfitPct: 10 };
      const market = new OneCoinMarket();
      const e = new BotEngine(cfg, { market, solanaWs: null, solanaRpc: null });
      e.setTradeSize(30);
      await e.start();
      await new Promise((r) => setTimeout(r, 100));
      const pos = e.ledger.openPositions[0]!;
      assert.equal(pos.entryNotionalUsd, 30);
      assert.equal(pos.tradeSizeUsd, 30);
      // Changing size does not touch the open position
      e.setTradeSize(15);
      assert.equal(e.ledger.openPositions[0]!.entryNotionalUsd, 30);
      market.price = 0.00004;
      await new Promise((r) => setTimeout(r, 3500));
      await e.stop();
      const row = e.journal.list().entries[0]!;
      assert.equal(row.tradeSizeUsd, 30);
      assert.equal(row.mode, "paper");
      await e.dispose();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ---------- LIVE DRY-RUN uses the paper cost model ----------
describe("LIVE DRY-RUN realistic costs (same model as paper)", () => {
  const SOL = 150;
  const FEES: PaperFeeSettings = { ...PAPER_FEE_DEFAULTS };
  const COSTS: DryRunCostModel = { fees: FEES, flatSlippageBps: 50 };
  const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps})`);
  const buy15 = { mint: MINT, symbol: "TST", markPrice: 0.00003, notionalUsd: 15, solUsd: SOL };

  function paperCfg(fees: PaperFeeSettings | undefined, slippageBps = 50): BotConfig {
    return { ...liveCfg("/tmp/unused"), paperMode: true, tradingMode: undefined, live: undefined, paperBroker: { slippageBps, feeBps: 30, ...(fees ? { fees } : {}) } } as unknown as BotConfig;
  }

  it("buy charges pump.fun 1.25% + PumpPortal 0.5% + network + rent, records breakdown, never sends", async () => {
    const rpc = new MockRpc({ meta: buyMeta });
    const { broker } = mkBroker(rpc, "live_dry_run", {}, COSTS);
    const r = await broker.buy({ ...buy15, venue: "bonding_curve", liquidityUsd: 30_000 });
    assert.ok(r.ok);
    assert.equal(rpc.sends, 0);
    const bd = r.fill.feeBreakdown!;
    assert.ok(bd, "fill carries fee breakdown");
    assert.equal(bd.venue, "bonding_curve");
    assert.equal(bd.venueFeeBps, 125);
    near(bd.venueFeeUsd, 15 * 0.0125);
    near(bd.pumpPortalFeeUsd, 15 * 0.005);
    near(bd.networkFeeUsd, (0.000005 + 0.0002) * SOL);
    near(bd.rentUsd, 0.00148844 * SOL);
    near(r.fill.feesUsd, bd.totalFeesUsd);
    // Size-aware slippage: 25 bps base + 15/30k = 5 bps → 30 bps.
    near(bd.slippageBps, 30, 1e-9);
    // All-in: the trade size leaves the wallet (like paper), fees come out of it.
    near(r.fill.notionalUsd, 15);
    near(r.position.entryNotionalUsd, 15);
    const expectQty = (15 - bd.totalFeesUsd) / (0.00003 * 1.003);
    near(r.position.qty, expectQty, 1e-3);
    // Position remembers venue + liquidity + breakdown for the exit and the journal.
    assert.equal(r.position.venue, "bonding_curve");
    assert.equal(r.position.entryLiquidityUsd, 30_000);
    assert.deepEqual(r.position.entryFeeBreakdown, bd);
  });

  it("$15 flat round trip costs the same as paper", async () => {
    const rpc = new MockRpc({ meta: buyMeta });
    const { broker } = mkBroker(rpc, "live_dry_run", {}, COSTS);
    const b = await broker.buy({ ...buy15, venue: "bonding_curve", liquidityUsd: 30_000 });
    assert.ok(b.ok);
    const s = await broker.sell({ position: b.position, markPrice: 0.00003, reason: "time_stop", solUsd: SOL });
    assert.ok(s.ok);
    assert.equal(rpc.sends, 0);
    assert.ok(s.fill.feeBreakdown, "sell fill carries fee breakdown");
    assert.equal(s.fill.feeBreakdown!.rentUsd, 0);

    const paper = new PaperBroker(paperCfg(FEES));
    const pb = paper.applyBuy({ mint: MINT, symbol: "TST", markPrice: 0.00003, notionalUsd: 15, solUsd: SOL, venue: "bonding_curve", liquidityUsd: 30_000 });
    const ps = paper.applySell({ position: pb.position, markPrice: 0.00003, reason: "time_stop", solUsd: SOL });
    near(s.realizedPnlUsd, ps.realizedPnlUsd, 1e-6);
    near(b.fill.feesUsd + s.fill.feesUsd, pb.fill.feesUsd + ps.fill.feesUsd, 1e-6);
    // @ $150 SOL: buy 0.1875 + 0.075 + 0.03075 + 0.22327 rent; sell ≈ 0.1803 + 0.0721 + 0.03075.
    near(b.fill.feesUsd + s.fill.feesUsd, 0.7995, 0.005);
    // Plus 30 bps slippage each side → ≈ $0.89 all-in on a flat $15 trade.
    assert.ok(s.realizedPnlUsd < -0.85 && s.realizedPnlUsd > -0.92, `round trip ${s.realizedPnlUsd}`);
  });

  it("is materially more conservative than the old dry-run estimate", async () => {
    const rt = async (costs?: DryRunCostModel) => {
      const rpc = new MockRpc({ meta: buyMeta });
      const { broker } = mkBroker(rpc, "live_dry_run", {}, costs);
      const b = await broker.buy({ ...buy15, venue: "bonding_curve", liquidityUsd: 30_000 });
      assert.ok(b.ok);
      const s = await broker.sell({ position: b.position, markPrice: 0.00003, reason: "time_stop", solUsd: SOL });
      assert.ok(s.ok);
      return s.realizedPnlUsd;
    };
    const legacy = await rt(undefined);
    const realistic = await rt(COSTS);
    const diff = legacy - realistic;
    // Old estimate ≈ $0.21 on a flat $15 trade @ $150 SOL; realistic ≈ $0.89.
    assert.ok(diff > 0.6 && diff < 0.75, `difference ${diff}`);
  });

  it("graduated coin (PumpSwap) uses the market-cap fee tier, same as paper", async () => {
    const rpc = new MockRpc({ meta: buyMeta });
    const { broker } = mkBroker(rpc, "live_dry_run", {}, COSTS);
    // mcap = 0.0003 × 1B = $300k → 2,000 SOL @ $150 → tier 115 bps.
    const r = await broker.buy({ ...buy15, markPrice: 0.0003, venue: "pumpswap", liquidityUsd: 80_000 });
    assert.ok(r.ok);
    assert.equal(r.fill.feeBreakdown!.venue, "pumpswap");
    assert.equal(r.fill.feeBreakdown!.venueFeeBps, 115);
    const s = await broker.sell({ position: r.position, markPrice: 0.0003, reason: "time_stop", solUsd: SOL });
    assert.ok(s.ok);
    assert.equal(s.fill.feeBreakdown!.venue, "pumpswap");
    assert.equal(s.fill.feeBreakdown!.venueFeeBps, 115);
  });

  it("thin pools slip more (capped at 3%/side); unknown liquidity falls back to SLIPPAGE_BPS", async () => {
    const rpc = new MockRpc({ meta: buyMeta });
    const { broker } = mkBroker(rpc, "live_dry_run", {}, COSTS);
    const thin = await broker.buy({ ...buy15, liquidityUsd: 300 });
    assert.ok(thin.ok);
    assert.equal(thin.fill.feeBreakdown!.slippageBps, 300);
    const unknown = await broker.buy({ ...buy15 });
    assert.ok(unknown.ok);
    assert.equal(unknown.fill.feeBreakdown!.slippageBps, 50);
    assert.equal(unknown.fill.feeBreakdown!.venue, "bonding_curve");
    assert.equal(unknown.position.entryLiquidityUsd, undefined);
  });

  it("exit slippage tracks pool size at exit like paper (√ price move)", async () => {
    const rpc = new MockRpc({ meta: buyMeta });
    const { broker } = mkBroker(rpc, "live_dry_run", {}, COSTS);
    const b = await broker.buy({ ...buy15, liquidityUsd: 20_000 });
    assert.ok(b.ok);
    const s = await broker.sell({ position: b.position, markPrice: 0.00012, reason: "take_profit", solUsd: SOL });
    assert.ok(s.ok);
    const paper = new PaperBroker(paperCfg(FEES));
    const pb = paper.applyBuy({ mint: MINT, symbol: "TST", markPrice: 0.00003, notionalUsd: 15, solUsd: SOL, liquidityUsd: 20_000 });
    const ps = paper.applySell({ position: pb.position, markPrice: 0.00012, reason: "take_profit", solUsd: SOL });
    near(s.fill.feeBreakdown!.slippageBps, ps.fill.feeBreakdown!.slippageBps, 0.01);
    near(s.realizedPnlUsd, ps.realizedPnlUsd, 1e-6);
  });

  it("network fee uses the priority fee the tx was built with", async () => {
    const rpc = new MockRpc({ meta: buyMeta });
    const { broker } = mkBroker(rpc, "live_dry_run", { LIVE_PRIORITY_FEE_SOL: "0.0005" }, COSTS);
    const r = await broker.buy(buy15);
    assert.ok(r.ok);
    near(r.fill.feeBreakdown!.networkFeeUsd, (0.000005 + 0.0005) * SOL);
  });

  it("PAPER_FEE_MODEL=legacy → old dry-run estimate exactly (no breakdown)", async () => {
    const legacyFees = loadPaperFeeSettings({ PAPER_FEE_MODEL: "legacy" });
    for (const costs of [{ fees: legacyFees, flatSlippageBps: 50 }, undefined, { fees: null, flatSlippageBps: 50 }]) {
      const rpc = new MockRpc({ meta: buyMeta });
      const { broker } = mkBroker(rpc, "live_dry_run", {}, costs);
      const r = await broker.buy({ ...buy15, venue: "pumpswap", liquidityUsd: 1000 });
      assert.ok(r.ok);
      near(r.fill.feesUsd, 15 * 0.005 + 0.0002 * SOL);
      near(r.fill.notionalUsd, 15 + 0.0002 * SOL);
      near(r.position.qty, (15 * 0.995) / 0.00003, 1e-3);
      assert.equal(r.fill.feeBreakdown, undefined);
      assert.equal(r.position.entryFeeBreakdown, undefined);
      const s = await broker.sell({ position: r.position, markPrice: 0.00003, reason: "time_stop", solUsd: SOL });
      assert.ok(s.ok);
      const gross = r.position.qty * 0.00003;
      near(s.fill.feesUsd, gross * 0.005 + 0.0002 * SOL);
      near(s.proceedsUsd, gross - (gross * 0.005 + 0.0002 * SOL));
      assert.equal(s.fill.feeBreakdown, undefined);
    }
  });

  it("real LIVE mode ignores the cost model: P&L still comes from the on-chain wallet delta", async () => {
    const run = async (costs?: DryRunCostModel) => {
      const rpc = new MockRpc({ meta: buyMeta });
      const { broker } = mkBroker(rpc, "live", { LIVE_MAX_POSITION_USD: "15" }, costs);
      const b = await broker.buy({ ...buy15, notionalUsd: 15, solUsd: 118, venue: "pumpswap", liquidityUsd: 500 });
      assert.ok(b.ok);
      rpc.kind = "sell";
      const s = await broker.sell({ position: b.position, markPrice: 0.00003, reason: "stop_loss", solUsd: 118 });
      assert.ok(s.ok);
      return { b, s, sends: rpc.sends };
    };
    const without = await run(undefined);
    const withCosts = await run(COSTS);
    assert.equal(withCosts.sends, 2);
    near(withCosts.b.fill.notionalUsd, 0.127 * 118, 1e-9);
    assert.equal(withCosts.b.fill.qty, 500000);
    for (const k of ["notionalUsd", "feesUsd", "slippageUsd", "price", "qty"] as const) {
      assert.equal(withCosts.b.fill[k], without.b.fill[k], `buy ${k}`);
      assert.equal(withCosts.s.fill[k], without.s.fill[k], `sell ${k}`);
    }
    assert.equal(withCosts.s.realizedPnlUsd, without.s.realizedPnlUsd);
    assert.equal(withCosts.s.proceedsUsd, without.s.proceedsUsd);
    assert.equal(withCosts.b.fill.feeBreakdown, undefined);
    assert.equal(withCosts.s.fill.feeBreakdown, undefined);
    assert.equal(withCosts.b.position.entryFeeBreakdown, undefined);
  });

  it("engine wiring: config → dry-run cost model (realistic by default, legacy honoured)", () => {
    const real = dryRunCostModelFromConfig({ paperBroker: { slippageBps: 50, fees: loadPaperFeeSettings({}) } });
    assert.equal(real.fees!.model, "realistic");
    assert.equal(real.flatSlippageBps, 50);
    const legacy = dryRunCostModelFromConfig({ paperBroker: { slippageBps: 80, fees: loadPaperFeeSettings({ PAPER_FEE_MODEL: "legacy" }) } });
    assert.equal(legacy.fees!.model, "legacy");
    assert.equal(dryRunCostModelFromConfig({ paperBroker: { slippageBps: 50 } }).fees, null);
  });

  it("journal row for a dry-run close carries the itemised entry + exit costs", async () => {
    const jd = mkdtempSync(join(tmpdir(), "jr-dry-"));
    try {
      const rpc = new MockRpc({ meta: buyMeta });
      const { broker } = mkBroker(rpc, "live_dry_run", {}, COSTS);
      const b = await broker.buy({ ...buy15, liquidityUsd: 30_000 });
      assert.ok(b.ok);
      const s = await broker.sell({ position: b.position, markPrice: 0.000033, reason: "take_profit", solUsd: SOL });
      assert.ok(s.ok);
      const j = new TradeJournal(jd);
      const row = j.appendClose({ position: b.position, exitPrice: s.fill.price, pnlUsd: s.realizedPnlUsd, exitReason: "take_profit", fillId: s.fill.id, mode: "live_dry_run", exitFill: s.fill });
      assert.equal(row.mode, "live_dry_run");
      assert.ok(row.feeBreakdown?.entry && row.feeBreakdown?.exit);
      near(row.feeBreakdown!.entry!.rentUsd, 0.00148844 * SOL);
      near(row.feesUsd!, b.fill.feesUsd + s.fill.feesUsd, 1e-5);
    } finally {
      rmSync(jd, { recursive: true, force: true });
    }
  });

  it("buy computation matches computeBuyCosts with the live priority fee", async () => {
    const rpc = new MockRpc({ meta: buyMeta });
    const { broker, settings } = mkBroker(rpc, "live_dry_run", {}, COSTS);
    const r = await broker.buy({ ...buy15, liquidityUsd: 50_000 });
    assert.ok(r.ok);
    const c = computeBuyCosts({ ...FEES, priorityFeeSol: settings.priorityFeeSol }, { notionalUsd: 15, markPrice: 0.00003, solUsd: SOL, liquidityUsd: 50_000, flatSlippageBps: 50 });
    near(r.position.qty, c.qty, 1e-6);
    assert.deepEqual(r.fill.feeBreakdown, c.breakdown);
  });
});
