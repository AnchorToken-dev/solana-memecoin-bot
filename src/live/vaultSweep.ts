/**
 * LIVE vault sweep: move skimmed profit (as SOL) from the bot wallet to ONE
 * vault wallet, set only by public address in LIVE_VAULT_ADDRESS.
 *
 * - Destination is read once from env at startup. No setter exists; API/phone
 *   can only trigger "sweep now" to that same address.
 * - Plain SystemProgram transfer, built + signed locally, simulated, then sent
 *   and confirmed over the HTTPS RPC. Dry-run simulates only.
 * - Idempotent: the signed tx + signature are persisted as `inFlight` BEFORE
 *   sending. On retry/restart we look that signature up first; we only build a
 *   new tx after the old one is confirmed failed or its blockhash expired.
 * - Keeps LIVE_MIN_SOL_RESERVE; skips amounts below LIVE_VAULT_MIN_SWEEP_SOL.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { base58Decode, base58Encode } from "../solana/base58.js";
import type { LiveSigner } from "./keypair.js";
import type { LiveRpc } from "./rpc.js";
import { signTransaction, txSignature } from "./tx.js";
import { redactSecrets } from "./redact.js";
import { LAMPORTS_PER_SOL } from "./fills.js";

export const LIVE_VAULT_ADDRESS_ENV = "LIVE_VAULT_ADDRESS";
const BASE_FEE_LAMPORTS = 5_000;

export function maskAddress(a: string): string {
  return a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-4)}` : "****";
}

export type AddressCheck = { ok: true; address: string; bytes: Uint8Array } | { ok: false; error: string };

/** Valid base58 32-byte pubkey, not the bot wallet, not the system program. Never echoes input. */
export function validateVaultAddress(raw: string | undefined, botPublicKey: string): AddressCheck {
  const a = raw?.trim() ?? "";
  if (!a) return { ok: false, error: `${LIVE_VAULT_ADDRESS_ENV} is not set` };
  if (a.length < 32 || a.length > 44) {
    return { ok: false, error: `${LIVE_VAULT_ADDRESS_ENV} is not a Solana public address (wrong length — never paste a private key here)` };
  }
  let bytes: Uint8Array;
  try {
    bytes = base58Decode(a);
  } catch {
    return { ok: false, error: `${LIVE_VAULT_ADDRESS_ENV} is not valid base58` };
  }
  if (bytes.length !== 32 || base58Encode(bytes) !== a) {
    return { ok: false, error: `${LIVE_VAULT_ADDRESS_ENV} is not a 32-byte Solana public address` };
  }
  if (bytes.every((b) => b === 0)) return { ok: false, error: `${LIVE_VAULT_ADDRESS_ENV} is the system program, not a wallet` };
  if (a === botPublicKey) return { ok: false, error: `${LIVE_VAULT_ADDRESS_ENV} is the bot wallet itself — use a separate vault wallet` };
  return { ok: true, address: a, bytes };
}

function shortvec(n: number): number[] {
  const out: number[] = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v) b |= 0x80;
    out.push(b);
    if (!v) break;
  }
  return out;
}

/** Unsigned legacy tx with one SystemProgram::Transfer. */
export function buildTransferTx(from: Uint8Array, to: Uint8Array, lamports: bigint, blockhash: string): Uint8Array {
  const bh = base58Decode(blockhash);
  if (bh.length !== 32) throw new Error("bad blockhash");
  const data = new Uint8Array(12);
  const dv = new DataView(data.buffer);
  dv.setUint32(0, 2, true); // Transfer
  dv.setBigUint64(4, lamports, true);
  const msg = [
    1, 0, 1, // 1 signer, 0 ro-signed, 1 ro-unsigned (system program)
    ...shortvec(3), ...from, ...to, ...new Uint8Array(32),
    ...bh,
    ...shortvec(1), 2, ...shortvec(2), 0, 1, ...shortvec(data.length), ...data,
  ];
  return Uint8Array.from([...shortvec(1), ...new Uint8Array(64), ...msg]);
}

export interface VaultSweepSettings {
  autoSweep: boolean;
  minSweepSol: number;
  minSolReserve: number;
  maxAttempts: number;
  confirmTimeoutMs: number;
  confirmPollMs: number;
}

export function loadVaultSweepSettings(env: Record<string, string | undefined>, base: { minSolReserve: number; confirmTimeoutMs: number; confirmPollMs: number }): VaultSweepSettings {
  const n = (k: string, d: number, lo: number, hi: number) => {
    const v = Number(env[k]);
    return env[k] == null || env[k]!.trim() === "" || !Number.isFinite(v) ? d : Math.min(Math.max(v, lo), hi);
  };
  const auto = (env.LIVE_VAULT_AUTO_SWEEP ?? "").trim().toLowerCase();
  return {
    autoSweep: !["false", "0", "no", "off"].includes(auto),
    minSweepSol: n("LIVE_VAULT_MIN_SWEEP_SOL", 0.05, 0.001, 100),
    minSolReserve: base.minSolReserve,
    maxAttempts: Math.floor(n("LIVE_VAULT_MAX_ATTEMPTS", 5, 1, 20)),
    confirmTimeoutMs: base.confirmTimeoutMs,
    confirmPollMs: base.confirmPollMs,
  };
}

interface InFlight {
  id: string;
  lamports: number;
  signature: string;
  txBase64: string;
  lastValidBlockHeight: number;
  createdAt: number;
}

export interface SweepRecord {
  id: string;
  state: "confirmed" | "simulated" | "failed";
  lamports: number;
  signature: string | null;
  at: number;
  detail?: string;
}

interface State {
  owedLamports: number;
  inFlight: InFlight | null;
  failedAttempts: number;
  lastError: string | null;
  history: SweepRecord[];
}

export interface VaultSweepStatus {
  configured: boolean;
  addressMasked: string | null;
  autoSweep: boolean;
  minSweepSol: number;
  owedSol: number;
  pending: { signature: string; sol: number } | null;
  failedAttempts: number;
  maxAttempts: number;
  stuck: boolean;
  lastError: string | null;
  lastSweep: SweepRecord | null;
  warning: string | null;
}

export type SweepEvent = (kind: "vault_sweep" | "vault_sweep_failed", title: string, body: string, signature: string | null) => void;

export class VaultSweeper {
  private state: State = { owedLamports: 0, inFlight: null, failedAttempts: 0, lastError: null, history: [] };
  private busy = false;
  private readonly path: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly d: {
      signer: LiveSigner;
      rpc: LiveRpc;
      /** Locked destination (already validated). */
      destination: { address: string; bytes: Uint8Array };
      settings: VaultSweepSettings;
      mode: "live" | "live_dry_run";
      dataDir: string;
      onEvent?: SweepEvent;
      sleep?: (ms: number) => Promise<void>;
      now?: () => number;
    },
  ) {
    this.path = join(d.dataDir, "vault-sweeps.json");
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = d.now ?? Date.now;
    if (existsSync(this.path)) {
      try {
        this.state = { ...this.state, ...(JSON.parse(readFileSync(this.path, "utf8")) as Partial<State>) };
      } catch {
        // Unreadable: refuse to sweep until a human looks (no blind re-sends).
        this.state.failedAttempts = Number.MAX_SAFE_INTEGER;
        this.state.lastError = "vault-sweeps.json unreadable — auto-sweep paused; check the file";
      }
    }
  }

  /** Read-only. There is intentionally no way to change it after construction. */
  get destinationAddress(): string {
    return this.d.destination.address;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
  }

  enqueueUsd(usd: number, solUsd: number): number {
    if (!(usd > 0) || !(solUsd > 0)) return 0;
    const lamports = Math.floor((usd / solUsd) * LAMPORTS_PER_SOL);
    this.state.owedLamports += lamports;
    this.persist();
    return lamports;
  }

  status(): VaultSweepStatus {
    const last = this.state.history[this.state.history.length - 1] ?? null;
    return {
      configured: true,
      addressMasked: maskAddress(this.d.destination.address),
      autoSweep: this.d.settings.autoSweep,
      minSweepSol: this.d.settings.minSweepSol,
      owedSol: this.state.owedLamports / LAMPORTS_PER_SOL,
      pending: this.state.inFlight ? { signature: this.state.inFlight.signature, sol: this.state.inFlight.lamports / LAMPORTS_PER_SOL } : null,
      failedAttempts: Math.min(this.state.failedAttempts, 999),
      maxAttempts: this.d.settings.maxAttempts,
      stuck: this.state.failedAttempts >= this.d.settings.maxAttempts,
      lastError: this.state.lastError,
      lastSweep: last,
      warning: null,
    };
  }

  /**
   * Reconcile any in-flight sweep, then (if owed ≥ min) start one new sweep.
   * `manual` clears the retry counter (phone "Sweep vault now").
   */
  async process(opts?: { manual?: boolean }): Promise<{ ok: boolean; message: string }> {
    if (this.busy) return { ok: false, message: "Sweep already running" };
    this.busy = true;
    try {
      if (opts?.manual && this.state.failedAttempts !== Number.MAX_SAFE_INTEGER) this.state.failedAttempts = 0;
      if (this.state.inFlight) {
        const r = await this.reconcile(this.state.inFlight);
        if (r !== "resolved") return { ok: r === "pending", message: r === "pending" ? "Previous sweep still confirming" : "Previous sweep unresolved" };
      }
      if (this.state.failedAttempts >= this.d.settings.maxAttempts) {
        return { ok: false, message: `Sweep paused after ${this.d.settings.maxAttempts} failures — press Sweep vault now to retry` };
      }
      const minL = Math.round(this.d.settings.minSweepSol * LAMPORTS_PER_SOL);
      if (this.state.owedLamports < minL) {
        return { ok: true, message: `Nothing to sweep yet (${(this.state.owedLamports / LAMPORTS_PER_SOL).toFixed(4)} SOL owed; min ${this.d.settings.minSweepSol})` };
      }
      return await this.startSweep(minL);
    } finally {
      this.busy = false;
    }
  }

  private async startSweep(minL: number): Promise<{ ok: boolean; message: string }> {
    const rpc = this.d.rpc;
    if (!rpc.getLatestBlockhash || !rpc.getBlockHeight) return { ok: false, message: "RPC lacks blockhash support" };
    let balance: number;
    try {
      balance = await rpc.getBalanceLamports(this.d.signer.publicKey);
    } catch (err) {
      return this.fail(`balance: ${redactSecrets(err)}`, false);
    }
    const reserveL = Math.round(this.d.settings.minSolReserve * LAMPORTS_PER_SOL);
    const available = balance - reserveL - BASE_FEE_LAMPORTS;
    const dry = this.d.mode === "live_dry_run";
    let lamports = Math.min(this.state.owedLamports, Math.max(0, available));
    if (lamports < minL) {
      if (!dry) return { ok: true, message: `Waiting: sweeping now would dip below the ${this.d.settings.minSolReserve} SOL reserve` };
      lamports = 0;
    }
    if (dry && lamports === 0) {
      // Dry-run wallet is usually tiny; record that the sweep would happen without a sim.
      const owed = this.state.owedLamports;
      this.state.owedLamports = 0;
      this.record({ id: randomUUID(), state: "simulated", lamports: owed, signature: null, at: this.now(), detail: "dry-run: wallet too small to simulate; nothing sent" });
      return { ok: true, message: "DRY-RUN: sweep recorded (not sent)" };
    }
    let signed: Uint8Array;
    let lastValidBlockHeight: number;
    try {
      const bh = await rpc.getLatestBlockhash();
      lastValidBlockHeight = bh.lastValidBlockHeight;
      signed = signTransaction(buildTransferTx(this.d.signer.publicKeyBytes, this.d.destination.bytes, BigInt(lamports), bh.blockhash), this.d.signer);
    } catch (err) {
      return this.fail(`build: ${redactSecrets(err)}`, false);
    }
    const b64 = Buffer.from(signed).toString("base64");
    const sig = txSignature(signed);
    try {
      const sim = await rpc.simulate(b64);
      if (sim.err != null) return this.fail(`simulation failed: ${redactSecrets(sim.err)}`, false);
    } catch (err) {
      return this.fail(`simulate: ${redactSecrets(err)}`, false);
    }
    if (dry) {
      this.state.owedLamports = Math.max(0, this.state.owedLamports - lamports);
      this.record({ id: randomUUID(), state: "simulated", lamports, signature: null, at: this.now(), detail: "dry-run: simulated, not sent" });
      return { ok: true, message: `DRY-RUN: simulated sweep of ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL (not sent)` };
    }
    // Persist BEFORE send → a crash after send can never lead to a second, different tx.
    this.state.inFlight = { id: randomUUID(), lamports, signature: sig, txBase64: b64, lastValidBlockHeight, createdAt: this.now() };
    this.persist();
    try {
      await rpc.send(b64);
    } catch {
      /* may still have landed — reconcile decides */
    }
    const r = await this.reconcile(this.state.inFlight, true);
    if (r === "resolved") {
      const last = this.state.history[this.state.history.length - 1];
      return last?.state === "confirmed"
        ? { ok: true, message: `Swept ${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL to vault ${maskAddress(this.d.destination.address)}` }
        : { ok: false, message: this.state.lastError ?? "Sweep failed" };
    }
    return { ok: false, message: "Sweep sent; still confirming — will re-check (no re-send of a new tx)" };
  }

  /** resolved = confirmed or definitively failed/expired (inFlight cleared). */
  private async reconcile(f: InFlight, wait = false): Promise<"resolved" | "pending"> {
    const rpc = this.d.rpc;
    const deadline = this.now() + (wait ? this.d.settings.confirmTimeoutMs : 0);
    for (;;) {
      let st = null;
      try {
        st = await rpc.getSignatureStatus(f.signature);
      } catch {
        /* transient */
      }
      if (st?.err != null) {
        this.state.inFlight = null;
        this.fail(`on-chain error: ${redactSecrets(st.err)}`, true, f.signature);
        return "resolved";
      }
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
        this.state.inFlight = null;
        this.state.owedLamports = Math.max(0, this.state.owedLamports - f.lamports);
        this.state.failedAttempts = 0;
        this.state.lastError = null;
        this.record({ id: f.id, state: "confirmed", lamports: f.lamports, signature: f.signature, at: this.now() });
        return "resolved";
      }
      // Not seen: has its blockhash expired? Only then is a NEW tx safe.
      let height: number | null = null;
      try {
        height = rpc.getBlockHeight ? await rpc.getBlockHeight() : null;
      } catch {
        /* unknown */
      }
      if (height != null && height > f.lastValidBlockHeight) {
        try {
          const late = await rpc.getSignatureStatus(f.signature);
          if (late) continue; // landed at the last moment; loop handles it
        } catch {
          return "pending";
        }
        this.state.inFlight = null;
        this.fail("sweep expired without landing", true, f.signature);
        return "resolved";
      }
      if (this.now() >= deadline) {
        // Same bytes, same signature: re-broadcast can never double-pay.
        try {
          await rpc.send(f.txBase64);
        } catch {
          /* ignore */
        }
        return "pending";
      }
      await this.sleep(this.d.settings.confirmPollMs);
    }
  }

  private fail(msg: string, counted: boolean, signature: string | null = null): { ok: false; message: string } {
    this.state.failedAttempts += 1;
    void counted;
    this.state.lastError = msg;
    this.state.history.push({ id: randomUUID(), state: "failed", lamports: 0, signature, at: this.now(), detail: msg });
    this.state.history = this.state.history.slice(-200);
    this.persist();
    if (this.state.failedAttempts >= this.d.settings.maxAttempts) {
      this.d.onEvent?.("vault_sweep_failed", "⚠️ VAULT SWEEP FAILED", `Vault sweep failed ${this.state.failedAttempts}× — paused. Profit stays in the bot wallet. ${msg}`, signature);
    }
    return { ok: false, message: msg };
  }

  private record(r: SweepRecord): void {
    this.state.history.push(r);
    this.state.history = this.state.history.slice(-200);
    this.persist();
    this.d.onEvent?.(
      "vault_sweep",
      r.state === "confirmed" ? "Vault sweep confirmed" : "Vault sweep (dry-run)",
      `${(r.lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL → ${maskAddress(this.d.destination.address)}${r.detail ? ` · ${r.detail}` : ""}`,
      r.signature,
    );
  }
}
