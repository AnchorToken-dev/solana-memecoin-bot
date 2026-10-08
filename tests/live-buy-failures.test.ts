/**
 * Overnight LIVE DRY-RUN buy failures (Oct 7–8 2026): decode the program
 * errors, fix PumpPortal's PumpSwap boost-pool quote, route graduated coins to
 * PumpSwap, skip non-SOL pairs, and cool down coins after a failed buy.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLiveSettings } from "../src/live/mode.js";
import { loadLiveSigner, type LiveSigner } from "../src/live/keypair.js";
import { instructionProgramIds } from "../src/live/tx.js";
import { LiveBroker } from "../src/live/liveBroker.js";
import type { LiveRpc, TxMeta } from "../src/live/rpc.js";
import type { SwapRequest, SwapTxBuilder } from "../src/live/pumpportal.js";
import { base58Decode, base58Encode } from "../src/solana/base58.js";
import { findProgramAddress, isOnCurve } from "../src/solana/pda.js";
import {
  canonicalPumpSwapPool,
  compensateBuy,
  isSolQuoteMint,
  parsePumpSwapPool,
  PUMP_CURVE_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  readPumpSwapQuoteGap,
  WSOL_MINT,
} from "../src/live/pumpswapPool.js";
import { classifyBuildFailure, classifyReason, decodeProgramError } from "../src/live/pumpErrors.js";
import { BuyCooldowns, BUY_COOLDOWN_MS } from "../src/live/buyCooldown.js";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";

// Real mints/pools seen on mainnet 2026-10-08 (web3.js findProgramAddressSync agrees).
const BILBO = "BEkw54ZMNfiQoS4PSxs1Bwrzjeu3bCrWtDGUNzKoojbN";
const BILBO_POOL = "EKejCoLC4Fx6rsVez9nxVYRA4hJUCRE8KqqPuSGfbMVY";
const ROUTER = "FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe";
const CB = "ComputeBudget111111111111111111111111111111";
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA1knL";
const SYS = "11111111111111111111111111111111";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

// Simulation logs copied from real failures (trimmed).
const LOGS_PUMPSWAP_SLIPPAGE = [
  "Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [1]",
  "Program log: Instruction: Buy",
  "Program log: AnchorError thrown in programs/pump-amm/src/instructions/swap/buy.rs:379. Error Code: ExceededSlippage. Error Number: 6004. Error Message: ExceededSlippage.",
  "Program log: Left: 115000000",
  "Program log: Right: 130066835",
  "Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA failed: custom program error: 0x1774",
];
const LOGS_UNSUPPORTED_QUOTE = [
  `Program ${ROUTER} invoke [1]`,
  "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [2]",
  "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P failed: custom program error: 0x17af",
  `Program ${ROUTER} failed: custom program error: 0x17af`,
];
const LOGS_CURVE_COMPLETE = [
  `Program ${ROUTER} invoke [1]`,
  "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P invoke [2]",
  "Program log: AnchorError thrown in programs/pump/src/lib.rs:554. Error Code: BondingCurveComplete. Error Number: 6005. Error Message: The bonding curve has completed and liquidity migrated to raydium..",
  "Program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P failed: custom program error: 0x1775",
  `Program ${ROUTER} failed: custom program error: 0x1775`,
];

let dir: string;
let signer: LiveSigner;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "buyfail-"));
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

/** v0 tx: fee payer + one instruction per program id (no accounts, no data). */
function txWithPrograms(feePayer: Uint8Array, programs: string[]): Uint8Array {
  const uniq = [...new Set(programs)];
  const keys = [feePayer, ...uniq.map((p) => base58Decode(p))];
  const msg: number[] = [0x80, 1, 0, uniq.length, keys.length];
  for (const k of keys) msg.push(...k);
  msg.push(...new Array(32).fill(5)); // blockhash
  msg.push(programs.length);
  for (const p of programs) msg.push(1 + uniq.indexOf(p), 0, 0);
  msg.push(0); // no lookup tables
  return Uint8Array.from([1, ...new Array(64).fill(0), ...msg]);
}

// ---------- error decoding ----------
describe("program error decoding", () => {
  it("6004 at instruction 4 on a fresh wallet = PumpSwap ExceededSlippage, with needed vs cap", () => {
    const d = decodeProgramError({ InstructionError: [4, { Custom: 6004 }] }, LOGS_PUMPSWAP_SLIPPAGE);
    assert.ok(d);
    assert.equal(d.program, "pumpswap");
    assert.equal(d.name, "ExceededSlippage");
    assert.equal(d.kind, "slippage");
    assert.equal(d.detail, "needed 0.1301 SOL, cap was 0.1150 SOL, 13% over");
  });
  it("without logs, the instruction's program decides (pump.fun 6004 means something else)", () => {
    const ps = [ATA, SYS, TOKEN, ATA, PUMPSWAP_PROGRAM_ID, TOKEN, SYS, CB, CB];
    assert.equal(decodeProgramError({ InstructionError: [4, { Custom: 6004 }] }, null, ps)!.name, "ExceededSlippage");
    const curve = [CB, CB, ATA, ROUTER];
    const d = decodeProgramError({ InstructionError: [3, { Custom: 6004 }] }, [], curve)!;
    assert.equal(d.program, "pump");
    assert.equal(d.name, "MintDoesNotMatchBondingCurve");
  });
  it("6063 at instruction 3 = pump.fun UnsupportedQuoteMint (coin paired with a non-SOL token)", () => {
    const d = decodeProgramError('{"InstructionError":[3,{"Custom":6063}]}', LOGS_UNSUPPORTED_QUOTE)!;
    assert.equal(d.programId, PUMP_CURVE_PROGRAM_ID);
    assert.equal(d.name, "UnsupportedQuoteMint");
    assert.equal(d.kind, "unsupported_quote");
    // On PumpSwap the same number is a different error.
    assert.equal(decodeProgramError({ InstructionError: [3, { Custom: 6063 }] }, null, [SYS, SYS, SYS, PUMPSWAP_PROGRAM_ID])!.name, "InsufficientRealQuoteReserves");
  });
  it("6005 at instruction 3 = pump.fun BondingCurveComplete (graduated coin sent to the curve)", () => {
    const d = decodeProgramError({ InstructionError: [3, { Custom: 6005 }] }, LOGS_CURVE_COMPLETE)!;
    assert.equal(d.name, "BondingCurveComplete");
    assert.equal(d.kind, "migrated");
    assert.match(d.plain, /graduated/);
  });
  it("non-custom errors decode to null; build failures and reasons classify", () => {
    assert.equal(decodeProgramError("InsufficientFunds"), null);
    assert.equal(decodeProgramError({ InstructionError: [2, "IncorrectProgramId"] }), null);
    assert.equal(classifyBuildFailure("build/sign: PumpPortal HTTP 400: Bad Request").kind, "build_rejected");
    assert.equal(classifyBuildFailure("build/sign: PumpPortal request failed: timeout").kind, "not_coin_specific");
    assert.equal(classifyReason("insufficient SOL: have 0.1, need 0.2"), "not_coin_specific");
    assert.equal(classifyReason('simulation failed: {"InstructionError":[3,{"Custom":6005}]}'), "other"); // no program info → generic
    assert.equal(classifyReason("build/sign: PumpPortal HTTP 400: Bad Request"), "build_rejected");
  });
  it("instructionProgramIds reads the outer program of each instruction", () => {
    const programs = [CB, CB, ATA, ROUTER];
    assert.deepEqual(instructionProgramIds(txWithPrograms(signer.publicKeyBytes, programs)), programs);
    assert.equal(instructionProgramIds(new Uint8Array(10)), null);
  });
});

// ---------- PDA + pool ----------
describe("PumpSwap canonical pool", () => {
  it("derives the same addresses as @solana/web3.js", () => {
    assert.equal(canonicalPumpSwapPool(BILBO), BILBO_POOL);
    assert.equal(canonicalPumpSwapPool("uNf4nNgqgXPVYpDH1xT4ExbXGvkkbQoQ6TB4C5gpump"), "A4pTgtC1FxBdmKLxKA8p78ZbSvbTzZmuRgLyvqrWuqFA");
    assert.equal(canonicalPumpSwapPool("BdXfLfcbDE8YvpbvvmmGTduqcDesaQVUm5xLxgUc2S5t"), "CzcFVsc2hQvf1ZwU6ya2vRF7g29aNu4nNrHw7JVVD3Vw");
    // Bumps below 255 exercise the on-curve check.
    const v = (seed: string) => findProgramAddress([Buffer.from(seed)], PUMPSWAP_PROGRAM_ID);
    assert.deepEqual(v("vec0"), { address: "4GVAGaJRC5t9LcruFe2tyZ5nBip4nudcXgTdr7BKoSYe", bump: 252 });
    assert.deepEqual(v("vec4"), { address: "G33NEvcbhguFhF1MrKKAya1txdeE1v4mBPEiftE5FXy7", bump: 251 });
    assert.deepEqual(v("vec31"), { address: "3ycYHsQZeBDkKP1vXiKs51v79piu9HoTMG7HWQiYjb42", bump: 250 });
    assert.equal(isOnCurve(base58Decode("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM")), true);
    assert.equal(isOnCurve(base58Decode(BILBO_POOL)), false);
  });
  it("SOL quote detection accepts wSOL / System Program id / unknown", () => {
    assert.equal(isSolQuoteMint(WSOL_MINT), true);
    assert.equal(isSolQuoteMint(SYS), true);
    assert.equal(isSolQuoteMint(undefined), true);
    assert.equal(isSolQuoteMint("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"), false);
  });
  it("parses the pool and computes the boost gap (real + virtual) / real", async () => {
    const vault = "Vau1t11111111111111111111111111111111111111";
    const data = poolBytes(BILBO, WSOL_MINT, vault, 17_580_853_519n);
    const p = parsePumpSwapPool(data)!;
    assert.equal(p.baseMint, BILBO);
    assert.equal(p.quoteMint, WSOL_MINT);
    assert.equal(p.virtualQuoteLamports, 17_580_853_519n);
    const accounts = new Map([[BILBO_POOL, data], [p.poolQuoteAccount, tokenAccountBytes(57_944_000_000n)]]);
    const gap = (await readPumpSwapQuoteGap(async (k) => accounts.get(k) ?? null, BILBO))!;
    assert.ok(Math.abs(gap.ratio - 1.3034) < 0.0005, String(gap.ratio));
    // Not graduated (no pool) → null; wrong quote → null.
    assert.equal(await readPumpSwapQuoteGap(async () => null, BILBO), null);
    const usdcPool = new Map([[BILBO_POOL, poolBytes(BILBO, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", vault, 0n)]]);
    assert.equal(await readPumpSwapQuoteGap(async (k) => usdcPool.get(k) ?? null, BILBO), null);
  });
  it("compensation keeps the SOL cap at amount × (1 + slippage)", () => {
    for (const ratio of [1.0341, 1.2075, 1.3034, 1.59]) {
      const c = compensateBuy(0.1, 1500, ratio);
      const cap = c.amount * (1 + c.slippageBps / 10_000);
      assert.ok(cap <= 0.115 + 1e-12, `ratio ${ratio}: cap ${cap}`);
      assert.ok(cap > 0.1148, `ratio ${ratio}: cap ${cap} too tight`);
      // Tokens requested ≈ what 0.1 SOL buys at the real price.
      assert.ok(Math.abs(c.amount * ratio - 0.1) < 0.00001);
    }
    assert.deepEqual(compensateBuy(0.1, 1500, 1), { amount: 0.1, slippageBps: 1500 });
  });
});

function poolBytes(base: string, quote: string, quoteVault: string, virtualQuote: bigint): Uint8Array {
  const b = Buffer.alloc(301);
  Buffer.from([241, 154, 109, 4, 17, 177, 109, 188]).copy(b, 0);
  Buffer.from(base58Decode(base)).copy(b, 43);
  Buffer.from(base58Decode(quote)).copy(b, 75);
  Buffer.from(base58Decode(quoteVault)).copy(b, 171);
  b.writeBigUInt64LE(virtualQuote & ((1n << 64n) - 1n), 245);
  b.writeBigInt64LE(virtualQuote >> 64n, 253);
  return new Uint8Array(b);
}
function tokenAccountBytes(amount: bigint): Uint8Array {
  const b = Buffer.alloc(165);
  b.writeBigUInt64LE(amount, 64);
  return new Uint8Array(b);
}

// ---------- broker ----------
class Builder implements SwapTxBuilder {
  calls: SwapRequest[] = [];
  constructor(private readonly programsFor: (req: SwapRequest) => string[], private readonly fail?: (req: SwapRequest) => string | null) {}
  async buildTx(req: SwapRequest) {
    this.calls.push(req);
    const f = this.fail?.(req);
    if (f) throw new Error(f);
    return txWithPrograms(signer.publicKeyBytes, this.programsFor(req));
  }
}
const curvePrograms = () => [CB, CB, ATA, ROUTER];
const ammPrograms = () => [ATA, SYS, TOKEN, ATA, PUMPSWAP_PROGRAM_ID, TOKEN, SYS, CB, CB];
const byPool = (r: SwapRequest) => (r.pool === "pump-amm" ? ammPrograms() : curvePrograms());

class Rpc implements LiveRpc {
  sims = 0;
  sends = 0;
  reads: string[] = [];
  constructor(
    private readonly sim: (n: number) => { err: unknown; logs: string[] | null },
    private readonly accounts: Map<string, Uint8Array> = new Map(),
  ) {}
  async getBalanceLamports() { return 2e9; }
  async simulate() { this.sims++; return this.sim(this.sims); }
  async send() { this.sends++; return "sig"; }
  async getSignatureStatus() { return { confirmationStatus: "confirmed" as const, err: null }; }
  async getTransactionMeta(): Promise<{ meta: TxMeta; accountKeys: string[] }> {
    return {
      meta: { err: null, fee: 5000, preBalances: [2e9], postBalances: [1.87e9], preTokenBalances: [],
        postTokenBalances: [{ accountIndex: 1, mint: BILBO, owner: signer.publicKey, uiTokenAmount: { amount: "1000", decimals: 0, uiAmount: 1000 } }] },
      accountKeys: [signer.publicKey, "Ata"],
    };
  }
  async getAccountData(k: string) { this.reads.push(k); return this.accounts.get(k) ?? null; }
}
const ok = () => ({ err: null, logs: [] });
const VAULT = "Vau1t11111111111111111111111111111111111111";
function bilboAccounts(realLamports: bigint): Map<string, Uint8Array> {
  return new Map([[BILBO_POOL, poolBytes(BILBO, WSOL_MINT, VAULT, 17_580_853_519n)], [VAULT, tokenAccountBytes(realLamports)]]);
}
function broker(rpc: Rpc, builder: Builder, mode: "live" | "live_dry_run" = "live_dry_run") {
  let t = 0;
  return new LiveBroker({
    signer, rpc, builder, mode,
    settings: loadLiveSettings({ LIVE_MAX_POSITION_USD: "15", LIVE_CONFIRM_TIMEOUT_MS: "5000" }),
    sleep: async (ms) => { t += ms; }, now: () => t,
  });
}
const args = { mint: BILBO, symbol: "Bilbo", markPrice: 0.0001, notionalUsd: 15, solUsd: 150 };
const sol = Number((15 / 150).toFixed(6));

describe("LiveBroker buy routing + quote fix", () => {
  it("graduated coin → pump-amm with the boost gap corrected; SOL cap unchanged", async () => {
    const rpc = new Rpc(ok, bilboAccounts(57_944_000_000n));
    const b = new Builder(byPool);
    const r = await broker(rpc, b).buy({ ...args, venue: "pumpswap" });
    assert.ok(r.ok);
    assert.equal(b.calls.length, 1);
    const c = b.calls[0]!;
    assert.equal(c.pool, "pump-amm");
    assert.ok(Math.abs((c.amount as number) - sol / 1.3034) < 0.00002);
    assert.ok((c.amount as number) * (1 + c.slippageBps / 10_000) <= sol * 1.15 + 1e-12);
    assert.ok(c.slippageBps > 1500);
    assert.match(r.notes!.join(" "), /boost quote fix/);
    assert.equal(rpc.sends, 0);
  });

  it("pool too thin (gap > 60%) → skipped before building anything", async () => {
    const rpc = new Rpc(ok, bilboAccounts(20_000_000_000n));
    const b = new Builder(byPool);
    const r = await broker(rpc, b).buy({ ...args, venue: "pumpswap" });
    assert.equal(r.ok, false);
    assert.equal((r as { kind?: string }).kind, "pool_too_thin");
    assert.equal(b.calls.length, 0);
  });

  it("curve buy refused with BondingCurveComplete → one retry on PumpSwap (simulation only, nothing sent twice)", async () => {
    const rpc = new Rpc((n) => (n === 1 ? { err: { InstructionError: [3, { Custom: 6005 }] }, logs: LOGS_CURVE_COMPLETE } : ok()), bilboAccounts(80_000_000_000n));
    const b = new Builder(byPool);
    const r = await broker(rpc, b, "live").buy({ ...args, venue: "bonding_curve" });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual(b.calls.map((c) => c.pool), ["auto", "pump-amm"]);
    assert.equal(rpc.sims, 2);
    assert.equal(rpc.sends, 1);
    assert.match(r.notes!.join(" "), /retried on PumpSwap/);
  });

  it("PumpPortal 'auto' routed to PumpSwap uncorrected → ExceededSlippage → one corrected retry", async () => {
    const rpc = new Rpc((n) => (n === 1 ? { err: { InstructionError: [4, { Custom: 6004 }] }, logs: LOGS_PUMPSWAP_SLIPPAGE } : ok()), bilboAccounts(57_944_000_000n));
    const b = new Builder(() => ammPrograms());
    const r = await broker(rpc, b).buy(args); // venue unknown
    assert.ok(r.ok);
    assert.equal(b.calls.length, 2);
    assert.equal(b.calls[0]!.amount, sol);
    assert.equal(b.calls[1]!.pool, "pump-amm");
    assert.ok((b.calls[1]!.amount as number) < sol);
  });

  it("real slippage after the fix is NOT retried or loosened — the chain protected us", async () => {
    const rpc = new Rpc(() => ({ err: { InstructionError: [4, { Custom: 6004 }] }, logs: LOGS_PUMPSWAP_SLIPPAGE }), bilboAccounts(57_944_000_000n));
    const b = new Builder(byPool);
    const r = await broker(rpc, b).buy({ ...args, venue: "pumpswap" });
    assert.equal(r.ok, false);
    assert.equal(b.calls.length, 1);
    assert.equal((r as { kind?: string }).kind, "slippage");
    assert.match((r as { plain?: string }).plain!, /PumpSwap ExceededSlippage.*needed 0\.1301 SOL, cap was 0\.1150 SOL/);
  });

  it("deep pool with ~no gap: genuine PumpSwap slippage → no retry", async () => {
    const rpc = new Rpc(() => ({ err: { InstructionError: [4, { Custom: 6004 }] }, logs: LOGS_PUMPSWAP_SLIPPAGE }), new Map([[BILBO_POOL, poolBytes(BILBO, WSOL_MINT, VAULT, 0n)], [VAULT, tokenAccountBytes(500_000_000_000n)]]));
    const b = new Builder(() => ammPrograms());
    const r = await broker(rpc, b).buy(args);
    assert.equal(r.ok, false);
    assert.equal(b.calls.length, 1);
  });

  it("non-SOL pair (e.g. paired with a tokenized stock) → skipped, nothing built", async () => {
    const rpc = new Rpc(ok);
    const b = new Builder(byPool);
    const r = await broker(rpc, b).buy({ ...args, quoteMint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W" });
    assert.equal(r.ok, false);
    assert.equal((r as { kind?: string }).kind, "unsupported_quote");
    assert.equal(b.calls.length, 0);
    // SOL coins from the pump.fun API carry the System Program id and are fine.
    assert.ok((await broker(new Rpc(ok), new Builder(byPool)).buy({ ...args, quoteMint: SYS })).ok);
  });

  it("UnsupportedQuoteMint from the chain decodes to a plain reason; HTTP 400 → build_rejected", async () => {
    const r1 = await broker(new Rpc(() => ({ err: { InstructionError: [3, { Custom: 6063 }] }, logs: LOGS_UNSUPPORTED_QUOTE })), new Builder(byPool)).buy(args);
    assert.equal(r1.ok, false);
    assert.equal((r1 as { kind?: string }).kind, "unsupported_quote");
    assert.match((r1 as { reason: string }).reason, /simulation failed: .*6063/); // raw error still logged
    const r2 = await broker(new Rpc(ok), new Builder(byPool, () => "PumpPortal HTTP 400: Bad Request")).buy(args);
    assert.equal((r2 as { kind?: string }).kind, "build_rejected");
  });

  it("RPC without getAccountData still works (no correction, old behaviour)", async () => {
    const rpc = new Rpc(ok);
    (rpc as { getAccountData?: unknown }).getAccountData = undefined;
    const b = new Builder(byPool);
    const r = await broker(rpc, b).buy({ ...args, venue: "pumpswap" });
    assert.ok(r.ok);
    assert.equal(b.calls[0]!.amount, sol);
    assert.equal(b.calls[0]!.slippageBps, 1500);
  });
});

// ---------- cooldown ----------
describe("per-coin buy cooldown", () => {
  it("skips the coin for a kind-specific time, longer on repeats; ignores non-coin failures", () => {
    const c = new BuyCooldowns();
    assert.equal(c.record("M", "S", "not_coin_specific", 0), null);
    assert.equal(c.blocked("M", 0), null);
    const e1 = c.record("M", "S", "slippage", 0)!;
    assert.equal(e1.until, BUY_COOLDOWN_MS.slippage);
    assert.ok(c.blocked("M", BUY_COOLDOWN_MS.slippage - 1));
    assert.equal(c.blocked("M", BUY_COOLDOWN_MS.slippage), null);
    const e2 = c.record("M", "S", "slippage", BUY_COOLDOWN_MS.slippage)!;
    assert.equal(e2.until - BUY_COOLDOWN_MS.slippage, 2 * BUY_COOLDOWN_MS.slippage);
    assert.equal(e2.failures, 2);
    const u = c.record("Q", "S", "unsupported_quote", 0)!;
    assert.equal(u.until, 24 * 3_600_000);
    c.clear("M");
    assert.equal(c.blocked("M", BUY_COOLDOWN_MS.slippage + 1), null);
    assert.equal(c.active(1).length, 1);
  });
});

// ---------- engine ----------
class OneCoin implements MarketDataProvider {
  async scan(): Promise<TokenSnapshot[]> {
    return [{
      mint: BILBO, symbol: "Bilbo", name: "Bilbo", priceUsd: 0.0001, changeWindowPct: 50, volumeWindowUsd: 100_000,
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

describe("engine: failed coin is not retried every cycle", () => {
  it("after an UnsupportedQuoteMint failure the bot stops re-trying that coin", async () => {
    const ld = mkdtempSync(join(tmpdir(), "buyfail-eng-"));
    try {
      const rpc = new Rpc(() => ({ err: { InstructionError: [3, { Custom: 6063 }] }, logs: LOGS_UNSUPPORTED_QUOTE }));
      const b = new Builder(byPool);
      const cfg: BotConfig = {
        paperMode: false, bankrollUsd: 200, maxOpenTrades: 1, stopLossPct: 8, takeProfitPct: 15, positionSizePct: 0.95, maxPositionUsd: 50,
        momentum: { minPct: 1, windowMinutes: 5, volumeSpikeMult: 1, minLiquidityUsd: 0, minVolume24hUsd: 0, minAgeMinutes: 0 },
        trailingTakeProfit: { activatePct: 10, distancePct: 5 }, paperBroker: { slippageBps: 50, feeBps: 30 },
        runner: { pollIntervalMs: 10, scanLimit: 5, maxCycles: 0 }, maxHoldMinutes: 0, dailyLossUsd: 0, chaseLockoutHours: 0,
        marketDataSource: "mock", ledgerDir: ld, activePreset: "custom", requireChecklistGo: false,
        solanaRpcConfigured: true, solanaRpcWssConfigured: false, rugFilterEnabled: false, rugFilterMaxTopHolderPct: 30, rugFilterMaxSameSlotBuys: 3,
        tradingMode: "live_dry_run", live: loadLiveSettings({ LIVE_MAX_POSITION_USD: "15" }),
      };
      const engine = new BotEngine(cfg, {
        market: new OneCoin(), liveBroker: broker(rpc, b), solanaWs: null, solanaRpc: passRug as never,
        ledger: new PaperLedger(200, join(ld, "live")),
      });
      const started = await engine.start();
      assert.ok(started.ok, started.message);
      await new Promise((r) => setTimeout(r, 400));
      await engine.stop();
      await engine.stop();
      await engine.dispose();
      assert.equal(b.calls.length, 1, `built ${b.calls.length} times`);
      assert.ok(engine.buyCooldowns.blocked(BILBO, Date.now()));
      assert.equal(engine.ledger.openPositions.length, 0);
      assert.equal(rpc.sends, 0);
    } finally {
      rmSync(ld, { recursive: true, force: true });
    }
  });
});

// keep base58Encode import used (helper parity)
void base58Encode;
