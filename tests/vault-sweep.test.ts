/** Vault sweep tests — mocked RPC only, no network, no real sends. Throwaway keys in temp dirs. */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { loadLiveSigner, type LiveSigner } from "../src/live/keypair.js";
import { base58Decode, base58Encode } from "../src/solana/base58.js";
import { VaultSweeper, validateVaultAddress, buildTransferTx, maskAddress, loadVaultSweepSettings } from "../src/live/vaultSweep.js";
import { parseTransaction, txSignature } from "../src/live/tx.js";
import type { LiveRpc, SignatureStatus } from "../src/live/rpc.js";
import { loadLiveSettings } from "../src/live/mode.js";
import { BotEngine } from "../src/engine/botEngine.js";
import { createControlApp } from "../src/api/server.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";

let dir: string;
let signer: LiveSigner;
let vaultAddr: string;

function newKeyFile(d: string, name: string): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  const p = join(d, name);
  writeFileSync(p, JSON.stringify([...seed, ...pub]), { mode: 0o600 });
  return p;
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "vault-"));
  const r = loadLiveSigner(newKeyFile(dir, "bot.json"));
  assert.ok(r.ok);
  signer = r.signer;
  // Vault: only a PUBLIC address is used (random 32 bytes).
  vaultAddr = base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 0xff));
});
after(() => rmSync(dir, { recursive: true, force: true }));

const BH = base58Encode(new Uint8Array(32).fill(9));

class MockRpc implements LiveRpc {
  sends: string[] = [];
  sims = 0;
  balanceLamports = 2_000_000_000;
  height = 100;
  statusFn: (sig: string) => SignatureStatus | null = () => ({ confirmationStatus: "confirmed", err: null });
  async getBalanceLamports() { return this.balanceLamports; }
  async simulate() { this.sims++; return { err: null, logs: [] }; }
  async send(b64: string) { this.sends.push(b64); return "x"; }
  async getSignatureStatus(sig: string) { return this.statusFn(sig); }
  async getTransactionMeta() { return null; }
  async getLatestBlockhash() { return { blockhash: BH, lastValidBlockHeight: 250 }; }
  async getBlockHeight() { return this.height; }
}

const settings = (over: Record<string, string> = {}) =>
  loadVaultSweepSettings({ ...over }, { minSolReserve: 0.05, confirmTimeoutMs: 3000, confirmPollMs: 500 });

function mkSweeper(rpc: MockRpc, d: string, mode: "live" | "live_dry_run" = "live", env: Record<string, string> = {}) {
  let t = 0;
  const v = validateVaultAddress(vaultAddr, signer.publicKey);
  assert.ok(v.ok);
  return new VaultSweeper({
    signer, rpc, destination: { address: v.address, bytes: v.bytes }, settings: settings(env), mode, dataDir: d,
    sleep: async (ms) => { t += ms; }, now: () => t,
  });
}

const sigOf = (b64: string) => txSignature(Buffer.from(b64, "base64"));

describe("vault address validation", () => {
  it("accepts a valid pubkey; rejects own bot wallet, bad strings, system program, private-key-sized input", () => {
    assert.ok(validateVaultAddress(vaultAddr, signer.publicKey).ok);
    const bad = [
      undefined, "", "   ", "abc", "0OIl" + "1".repeat(40), "not a key!!", signer.publicKey,
      "11111111111111111111111111111111",
      base58Encode(new Uint8Array(64).fill(5)), // 64-byte secret-key-looking blob
      JSON.stringify([1, 2, 3]),
      vaultAddr.slice(0, -1) + "0", // "0" is not base58
      vaultAddr + "xyz", // too long
    ];
    for (const b of bad) {
      const r = validateVaultAddress(b as string, signer.publicKey);
      assert.equal(r.ok, false, String(b));
      if (b) assert.ok(!(r as { error: string }).error.includes(b), "never echoes input");
    }
    assert.match((validateVaultAddress(signer.publicKey, signer.publicKey) as { error: string }).error, /bot wallet/);
  });
  it("base58 round-trips and masks 4…4", () => {
    const b = Uint8Array.from([0, 0, 1, 2, 255, 3]);
    assert.deepEqual(base58Decode(base58Encode(b)), b);
    assert.equal(maskAddress(vaultAddr), `${vaultAddr.slice(0, 4)}…${vaultAddr.slice(-4)}`);
  });
  it("builds a plain SystemProgram transfer paid by the bot wallet", () => {
    const tx = buildTransferTx(signer.publicKeyBytes, base58Decode(vaultAddr), 123_456n, BH);
    const p = parseTransaction(tx);
    assert.equal(p.feePayer, signer.publicKey);
    const m = p.message;
    const data = m.subarray(m.length - 12);
    assert.equal(new DataView(data.buffer, data.byteOffset).getUint32(0, true), 2);
    assert.equal(new DataView(data.buffer, data.byteOffset).getBigUint64(4, true), 123_456n);
  });
});

describe("VaultSweeper", () => {
  it("dry-run simulates but never sends", async () => {
    const d = mkdtempSync(join(tmpdir(), "vs-"));
    try {
      const rpc = new MockRpc();
      const s = mkSweeper(rpc, d, "live_dry_run");
      s.enqueueUsd(30, 120); // 0.25 SOL
      const r = await s.process();
      assert.ok(r.ok, r.message);
      assert.equal(rpc.sims, 1);
      assert.equal(rpc.sends.length, 0);
      assert.equal(s.status().lastSweep?.state, "simulated");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("live: sends once, confirms, records signature, clears owed", async () => {
    const d = mkdtempSync(join(tmpdir(), "vs-"));
    try {
      const rpc = new MockRpc();
      const s = mkSweeper(rpc, d);
      s.enqueueUsd(30, 120);
      const r = await s.process();
      assert.ok(r.ok, r.message);
      assert.equal(rpc.sends.length, 1);
      const st = s.status();
      assert.equal(st.owedSol, 0);
      assert.equal(st.lastSweep?.state, "confirmed");
      assert.equal(st.lastSweep?.signature, sigOf(rpc.sends[0]!));
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("below min sweep: nothing sent", async () => {
    const d = mkdtempSync(join(tmpdir(), "vs-"));
    try {
      const rpc = new MockRpc();
      const s = mkSweeper(rpc, d, "live", { LIVE_VAULT_MIN_SWEEP_SOL: "0.1" });
      s.enqueueUsd(6, 120); // 0.05 SOL
      await s.process();
      assert.equal(rpc.sends.length, 0);
      assert.equal(rpc.sims, 0);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("keeps LIVE_MIN_SOL_RESERVE: caps amount, waits when too low", async () => {
    const d = mkdtempSync(join(tmpdir(), "vs-"));
    try {
      const rpc = new MockRpc();
      rpc.balanceLamports = 120_000_000; // 0.12 SOL; reserve 0.05 → ~0.07 available
      const s = mkSweeper(rpc, d);
      s.enqueueUsd(60, 120); // 0.5 SOL owed
      await s.process();
      assert.equal(rpc.sends.length, 1);
      const tx = Buffer.from(rpc.sends[0]!, "base64");
      const m = parseTransaction(tx).message;
      const lamports = new DataView(m.buffer, m.byteOffset + m.length - 8).getBigUint64(0, true);
      assert.equal(lamports, BigInt(120_000_000 - 50_000_000 - 5_000));
      assert.ok(s.status().owedSol > 0.42);
      // Now wallet at reserve → waits, no send
      rpc.balanceLamports = 50_000_000;
      const r = await s.process();
      assert.match(r.message, /reserve/);
      assert.equal(rpc.sends.length, 1);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("no double-send across restart: pending tx is reconciled, never rebuilt", async () => {
    const d = mkdtempSync(join(tmpdir(), "vs-"));
    try {
      const rpc = new MockRpc();
      rpc.statusFn = () => null; // never seen yet
      const a = mkSweeper(rpc, d);
      a.enqueueUsd(30, 120);
      const r1 = await a.process();
      assert.equal(r1.ok, false);
      assert.ok(a.status().pending, "persisted as pending");
      const firstSig = sigOf(rpc.sends[0]!);
      // "Restart": new instance reads the same file
      const b = mkSweeper(rpc, d);
      assert.ok(b.status().pending);
      await b.process();
      await b.process({ manual: true });
      // Every broadcast is the SAME signed tx (same signature) → can't double-pay.
      assert.ok(rpc.sends.length >= 1);
      assert.ok(rpc.sends.every((x) => sigOf(x) === firstSig));
      // It lands → confirmed, owed cleared, no new tx
      rpc.statusFn = (sig) => (sig === firstSig ? { confirmationStatus: "confirmed", err: null } : null);
      const c = mkSweeper(rpc, d);
      await c.process();
      assert.equal(c.status().pending, null);
      assert.equal(c.status().owedSol, 0);
      assert.ok(rpc.sends.every((x) => sigOf(x) === firstSig));
      await c.process({ manual: true });
      assert.ok(rpc.sends.every((x) => sigOf(x) === firstSig), "nothing new after confirm");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("only after blockhash expiry with no landing may a NEW tx be built; failures cap + alert", async () => {
    const d = mkdtempSync(join(tmpdir(), "vs-"));
    try {
      const rpc = new MockRpc();
      rpc.statusFn = () => null;
      const alerts: string[] = [];
      let t = 0;
      const v = validateVaultAddress(vaultAddr, signer.publicKey) as { ok: true; address: string; bytes: Uint8Array };
      const s = new VaultSweeper({ signer, rpc, destination: v, settings: settings({ LIVE_VAULT_MAX_ATTEMPTS: "2" }), mode: "live", dataDir: d,
        sleep: async (ms) => { t += ms; }, now: () => t, onEvent: (k, title) => { if (k === "vault_sweep_failed") alerts.push(title); } });
      s.enqueueUsd(30, 120);
      await s.process();
      rpc.height = 300; // past lastValidBlockHeight 250 → expired
      await s.process(); // reconcile → expired (fail 1) → builds new tx (pending)
      await s.process(); // expired again (fail 2) → paused
      assert.equal(s.status().stuck, true);
      assert.ok(alerts.length >= 1);
      assert.ok(s.status().owedSol > 0, "profit stays owed, not lost");
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});

// ---------- engine + API ----------
class Mkt implements MarketDataProvider {
  async scan(): Promise<TokenSnapshot[]> { return []; }
  async getPrice() { return null; }
  async getQuoteUsdRate() { return 120; }
}
function cfg(ledgerDir: string, mode: "paper" | "live_dry_run" | "live"): BotConfig {
  return {
    paperMode: mode === "paper", bankrollUsd: 100, maxOpenTrades: 1, stopLossPct: 8, takeProfitPct: 15, positionSizePct: 0.95, maxPositionUsd: 50,
    momentum: { minPct: 1, windowMinutes: 5, volumeSpikeMult: 1, minLiquidityUsd: 0, minVolume24hUsd: 0, minAgeMinutes: 0 },
    trailingTakeProfit: { activatePct: 10, distancePct: 5 }, paperBroker: { slippageBps: 50, feeBps: 30 },
    runner: { pollIntervalMs: 50, scanLimit: 5, maxCycles: 0 }, maxHoldMinutes: 0, dailyLossUsd: 0, chaseLockoutHours: 0,
    marketDataSource: "mock", ledgerDir, activePreset: "custom", requireChecklistGo: false,
    solanaRpcConfigured: true, solanaRpcWssConfigured: false, rugFilterEnabled: true, rugFilterMaxTopHolderPct: 30, rugFilterMaxSameSlotBuys: 3,
    tradingMode: mode, live: mode === "paper" ? undefined : loadLiveSettings({}),
  };
}

describe("engine + API vault sweep", () => {
  it("destination can't be changed via API; sweep ignores any body address; shown masked", async () => {
    const d = mkdtempSync(join(tmpdir(), "vapi-"));
    let server: Server | undefined;
    try {
      const rpc = new MockRpc();
      const attacker = base58Encode(new Uint8Array(32).fill(77));
      const e = new BotEngine(cfg(d, "live"), { market: new Mkt(), solanaWs: null, solanaRpc: null,
        vaultDeps: { signer, rpc, env: { LIVE_VAULT_ADDRESS: vaultAddr }, sleep: async () => undefined } });
      const app = createControlApp(e);
      await new Promise<void>((r) => { server = app.listen(0, "127.0.0.1", () => r()); });
      const port = (server!.address() as { port: number }).port;
      const post = (path: string, body: unknown, method = "POST") =>
        fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      for (const body of [{ LIVE_VAULT_ADDRESS: attacker }, { liveVaultAddress: attacker }, { vaultAddress: attacker }]) {
        await post("/config", body, "PATCH");
      }
      e.ledger.recordSell({ id: "f", positionId: "p", mint: "m", symbol: "S", side: "sell", qty: 1, price: 1, notionalUsd: 0, feesUsd: 0, slippageUsd: 0, timestamp: Date.now(), paper: false }, 60, 60);
      const skim = await post("/vault/skim", { amountUsd: 30, to: attacker, destination: attacker });
      assert.equal(skim.status, 200);
      await post("/vault/sweep", { to: attacker, address: attacker });
      const st = (await (await fetch(`http://127.0.0.1:${port}/status`)).json()) as { vaultSweep: { addressMasked: string } };
      assert.equal(st.vaultSweep.addressMasked, maskAddress(vaultAddr));
      const raw = JSON.stringify(st);
      assert.ok(!raw.includes(vaultAddr), "full address never in /status");
      assert.ok(rpc.sends.length >= 1);
      for (const b64 of rpc.sends) {
        const m = parseTransaction(Buffer.from(b64, "base64")).message;
        const to = base58Encode(m.subarray(4 + 32, 4 + 64));
        assert.equal(to, vaultAddr, "only ever sends to the env address");
      }
      await e.dispose();
    } finally {
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("own bot address as vault → live refuses to start", async () => {
    const d = mkdtempSync(join(tmpdir(), "vown-"));
    try {
      const e = new BotEngine(cfg(d, "live"), { market: new Mkt(), solanaWs: null, solanaRpc: null,
        vaultDeps: { signer, rpc: new MockRpc(), env: { LIVE_VAULT_ADDRESS: signer.publicKey } } });
      const r = await e.start();
      assert.equal(r.ok, false);
      assert.match(r.message, /bot wallet/);
      await e.dispose();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("unset address in live → bookkeeping only with a warning; nothing sent", async () => {
    const d = mkdtempSync(join(tmpdir(), "vunset-"));
    try {
      const rpc = new MockRpc();
      const e = new BotEngine(cfg(d, "live"), { market: new Mkt(), solanaWs: null, solanaRpc: null, vaultDeps: { signer, rpc, env: {} } });
      e.ledger.recordSell({ id: "f", positionId: "p", mint: "m", symbol: "S", side: "sell", qty: 1, price: 1, notionalUsd: 0, feesUsd: 0, slippageUsd: 0, timestamp: Date.now(), paper: false }, 60, 60);
      const r = await e.skimAndSweep({ amountUsd: 20 });
      assert.ok(r.ok);
      assert.equal(r.sweep, null);
      assert.match(e.getStatus().vaultSweep!.warning!, /bookkeeping only/);
      assert.equal(rpc.sends.length, 0);
      await e.dispose();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("paper unchanged: skim is bookkeeping, no vaultSweep block, sweep endpoint refuses", async () => {
    const d = mkdtempSync(join(tmpdir(), "vpaper-"));
    try {
      const e = new BotEngine(cfg(d, "paper"), { market: new Mkt(), solanaWs: null, solanaRpc: null });
      e.ledger.recordSell({ id: "f", positionId: "p", mint: "m", symbol: "S", side: "sell", qty: 1, price: 1, notionalUsd: 0, feesUsd: 0, slippageUsd: 0, timestamp: Date.now(), paper: true }, 60, 60);
      const r = await e.skimAndSweep({ amountUsd: 20 });
      assert.ok(r.ok);
      assert.equal(r.skimmedUsd, 20);
      assert.equal(r.sweep, null);
      assert.equal(e.getStatus().vaultSweep, null);
      assert.equal((await e.sweepVaultNow()).ok, false);
      await e.dispose();
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
