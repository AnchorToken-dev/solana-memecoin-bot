/**
 * Live broker: PumpPortal-built tx → verify → sign locally → simulate →
 * (dry-run stops here) → send over HTTPS RPC → poll confirmation →
 * read real SOL/token deltas from the confirmed tx.
 *
 * Invariants:
 *  - A buy that is not CONFIRMED on-chain with a token delta > 0 never
 *    becomes a position (no ghost positions).
 *  - Sells retry on an escalating slippage ladder; if all fail the caller
 *    keeps the position open and alerts loudly.
 *  - Nothing here ever logs or returns key material; errors pass redactSecrets.
 */
import { randomUUID } from "node:crypto";
import type { ExitReason, Fill, Position } from "../types.js";
import type { LiveSigner } from "./keypair.js";
import type { LiveRpc } from "./rpc.js";
import type { SwapTxBuilder } from "./pumpportal.js";
import { signTransaction, txSignature } from "./tx.js";
import { computeOnChainDelta, LAMPORTS_PER_SOL } from "./fills.js";
import { redactSecrets } from "./redact.js";
import { sellSlippageLadder, type LiveSettings } from "./mode.js";
import {
  computeBuyCosts,
  computeSellCosts,
  exitLiquidityUsd,
  type PaperFeeSettings,
  type PaperVenue,
} from "../broker/paperFees.js";

export type LiveExecMode = "live_dry_run" | "live";

export type BuyResult =
  | { ok: true; fill: Fill; position: Position; signature: string | null; simulated: boolean }
  | { ok: false; reason: string; signature?: string; unconfirmed?: boolean };

export type SellResult =
  | { ok: true; fill: Fill; proceedsUsd: number; realizedPnlUsd: number; signature: string | null; attempts: number; simulated: boolean; notes: string[] }
  | { ok: false; reason: string; attempts: number; errors: string[] };

type SendOutcome =
  | { ok: true; signature: string }
  | { ok: false; reason: string; signature?: string; unconfirmed?: boolean };

/**
 * Cost model for LIVE DRY-RUN estimates (nothing hits the chain, so costs are
 * estimated). Same itemised model as paper mode (src/broker/paperFees.ts).
 * Absent, or fees.model === "legacy" (PAPER_FEE_MODEL=legacy) → the old
 * PumpPortal 0.5% + priority-fee estimate. Real live mode never uses this:
 * it reads the actual SOL/token deltas from the confirmed transaction.
 */
export interface DryRunCostModel {
  fees?: PaperFeeSettings | null;
  /** SLIPPAGE_BPS fallback when pool liquidity is unknown (same as paper). */
  flatSlippageBps: number;
}

/** Dry-run cost model from bot config: paper fee settings + SLIPPAGE_BPS fallback. */
export function dryRunCostModelFromConfig(cfg: {
  paperBroker: { slippageBps: number; fees?: PaperFeeSettings };
}): DryRunCostModel {
  return { fees: cfg.paperBroker.fees ?? null, flatSlippageBps: cfg.paperBroker.slippageBps };
}

export interface LiveBrokerDeps {
  signer: LiveSigner;
  rpc: LiveRpc;
  builder: SwapTxBuilder;
  settings: LiveSettings;
  mode: LiveExecMode;
  dryRunCosts?: DryRunCostModel;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class LiveBroker {
  readonly mode: LiveExecMode;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly d: LiveBrokerDeps) {
    this.mode = d.mode;
    this.sleep = d.sleep ?? defaultSleep;
    this.now = d.now ?? Date.now;
  }

  /** Realistic dry-run cost settings, or null → legacy estimate. */
  private dryRunFees(prioritySol: number): { fees: PaperFeeSettings; flatSlippageBps: number } | null {
    const m = this.d.dryRunCosts;
    if (!m?.fees || m.fees.model !== "realistic") return null;
    // Network fee uses the priority fee this tx was actually built with.
    return { fees: { ...m.fees, priorityFeeSol: prioritySol }, flatSlippageBps: m.flatSlippageBps };
  }

  get publicKey(): string {
    return this.d.signer.publicKey;
  }

  async getSolBalance(): Promise<number> {
    return (await this.d.rpc.getBalanceLamports(this.d.signer.publicKey)) / LAMPORTS_PER_SOL;
  }

  /** Build → sign → simulate. Dry-run returns here. Live sends + confirms. */
  private async execute(req: Parameters<SwapTxBuilder["buildTx"]>[0]): Promise<SendOutcome & { simulated?: boolean }> {
    let signed: Uint8Array;
    try {
      const unsigned = await this.d.builder.buildTx(req);
      signed = signTransaction(unsigned, this.d.signer);
    } catch (err) {
      return { ok: false, reason: `build/sign: ${redactSecrets(err)}` };
    }
    const b64 = Buffer.from(signed).toString("base64");
    const sig = txSignature(signed);
    try {
      const sim = await this.d.rpc.simulate(b64);
      if (sim.err != null) {
        return { ok: false, reason: `simulation failed: ${redactSecrets(sim.err)}` };
      }
    } catch (err) {
      return { ok: false, reason: `simulate: ${redactSecrets(err)}` };
    }
    if (this.mode === "live_dry_run") return { ok: true, signature: sig, simulated: true };

    try {
      await this.d.rpc.send(b64);
    } catch (err) {
      // Send can error after the node accepted it — still poll before giving up.
      const st = await this.pollConfirm(sig, Math.min(10_000, this.d.settings.confirmTimeoutMs));
      if (st.ok) return { ok: true, signature: sig };
      return { ok: false, reason: `send: ${redactSecrets(err)}`, signature: sig, unconfirmed: st.unknown };
    }
    const st = await this.pollConfirm(sig, this.d.settings.confirmTimeoutMs);
    if (st.ok) return { ok: true, signature: sig };
    return { ok: false, reason: st.reason, signature: sig, unconfirmed: st.unknown };
  }

  private async pollConfirm(sig: string, timeoutMs: number): Promise<{ ok: true } | { ok: false; reason: string; unknown: boolean }> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      try {
        const s = await this.d.rpc.getSignatureStatus(sig);
        if (s) {
          if (s.err != null) return { ok: false, reason: `on-chain error: ${redactSecrets(s.err)}`, unknown: false };
          if (s.confirmationStatus === "confirmed" || s.confirmationStatus === "finalized") return { ok: true };
        }
      } catch {
        /* transient; keep polling */
      }
      if (this.now() >= deadline) return { ok: false, reason: "not confirmed before timeout", unknown: true };
      await this.sleep(this.d.settings.confirmPollMs);
    }
  }

  private async readDelta(sig: string, mint: string) {
    for (let i = 0; i < 5; i++) {
      try {
        const tx = await this.d.rpc.getTransactionMeta(sig);
        if (tx) return computeOnChainDelta(tx.meta, tx.accountKeys, this.d.signer.publicKey, mint);
      } catch {
        /* retry */
      }
      await this.sleep(this.d.settings.confirmPollMs);
    }
    return null;
  }

  async buy(args: {
    mint: string;
    symbol: string;
    markPrice: number;
    notionalUsd: number;
    solUsd: number;
    /** Dry-run cost model only: where the coin trades + pool liquidity (USD). */
    venue?: PaperVenue;
    liquidityUsd?: number;
  }): Promise<BuyResult> {
    const s = this.d.settings;
    const notionalUsd = Math.min(args.notionalUsd, s.maxPositionUsd);
    if (!(args.solUsd > 0)) return { ok: false, reason: "no SOL/USD rate — cannot size a live buy" };
    if (!(notionalUsd > 0)) return { ok: false, reason: "zero notional" };
    const solAmount = Number((notionalUsd / args.solUsd).toFixed(6));
    let balance: number;
    try {
      balance = await this.getSolBalance();
    } catch (err) {
      return { ok: false, reason: `balance check: ${redactSecrets(err)}` };
    }
    const needed = solAmount + s.priorityFeeMaxSol + s.minSolReserve;
    if (balance < needed) {
      return { ok: false, reason: `insufficient SOL: have ${balance.toFixed(4)}, need ${needed.toFixed(4)} (incl. reserve ${s.minSolReserve})` };
    }
    const buyPrio = Math.min(s.priorityFeeSol, s.priorityFeeMaxSol);
    const out = await this.execute({
      publicKey: this.d.signer.publicKey,
      action: "buy",
      mint: args.mint,
      amount: solAmount,
      denominatedInSol: true,
      slippageBps: s.slippageBps,
      priorityFeeSol: buyPrio,
      pool: s.pool,
    });
    if (!out.ok) return out;

    const now = this.now();
    const positionId = randomUUID();
    let qty: number;
    let spentUsd: number;
    let feesUsd: number;
    let slippageUsd: number | null = null;
    let breakdown: Fill["feeBreakdown"];
    const realistic = out.simulated ? this.dryRunFees(buyPrio) : null;
    if (out.simulated && realistic) {
      // Dry-run, realistic (same model as paper): the trade size leaves the
      // wallet; pump.fun/PumpSwap + PumpPortal + network fees + token-account
      // rent come out of it; the rest buys at the size-aware slipped price.
      const c = computeBuyCosts(realistic.fees, {
        notionalUsd,
        markPrice: args.markPrice,
        solUsd: args.solUsd,
        venue: args.venue,
        liquidityUsd: args.liquidityUsd,
        flatSlippageBps: realistic.flatSlippageBps,
      });
      qty = c.qty;
      spentUsd = notionalUsd;
      feesUsd = c.breakdown.totalFeesUsd;
      slippageUsd = c.breakdown.slippageUsd;
      breakdown = c.breakdown;
      if (!(qty > 0)) return { ok: false, reason: "dry-run: costs exceed trade size" };
    } else if (out.simulated) {
      // Dry-run, legacy (PAPER_FEE_MODEL=legacy): PumpPortal 0.5% + priority fee only.
      feesUsd = notionalUsd * 0.005 + s.priorityFeeSol * args.solUsd;
      spentUsd = notionalUsd + s.priorityFeeSol * args.solUsd;
      qty = (notionalUsd * 0.995) / args.markPrice;
    } else {
      const delta = await this.readDelta(out.signature, args.mint);
      if (!delta || !(delta.tokenDelta > 0)) {
        return {
          ok: false,
          reason: delta ? "confirmed but no tokens received" : "confirmed but could not read result — CHECK WALLET",
          signature: out.signature,
          unconfirmed: !delta,
        };
      }
      qty = delta.tokenDelta;
      spentUsd = (-delta.solDeltaLamports / LAMPORTS_PER_SOL) * args.solUsd;
      feesUsd = (delta.feeLamports / LAMPORTS_PER_SOL) * args.solUsd + notionalUsd * 0.005;
    }
    const price = spentUsd / qty;
    const fill: Fill = {
      id: randomUUID(),
      positionId,
      mint: args.mint,
      symbol: args.symbol,
      side: "buy",
      qty,
      price,
      notionalUsd: spentUsd,
      feesUsd,
      slippageUsd: slippageUsd ?? Math.max(0, spentUsd - qty * args.markPrice - feesUsd),
      timestamp: now,
      paper: false,
      mode: this.mode,
      signature: out.simulated ? null : out.signature,
      ...(breakdown ? { feeBreakdown: breakdown } : {}),
    };
    const position: Position = {
      id: positionId,
      mint: args.mint,
      symbol: args.symbol,
      side: "long",
      qty,
      entryPrice: price,
      entryNotionalUsd: spentUsd,
      entryFeesUsd: feesUsd,
      highWaterPrice: price,
      trailArmed: false,
      openedAt: now,
      ...(breakdown ? { venue: breakdown.venue, entryFeeBreakdown: breakdown } : {}),
      ...(breakdown && typeof args.liquidityUsd === "number" && args.liquidityUsd > 0
        ? { entryLiquidityUsd: args.liquidityUsd }
        : {}),
    };
    return { ok: true, fill, position, signature: fill.signature ?? null, simulated: !!out.simulated };
  }

  async sell(args: { position: Position; markPrice: number; reason: ExitReason; solUsd: number }): Promise<SellResult> {
    const s = this.d.settings;
    const ladder = sellSlippageLadder(s);
    const errors: string[] = [];
    for (let i = 0; i < ladder.length; i++) {
      // Priority fee escalates too, never past the hard cap.
      const prio = Math.min(s.priorityFeeSol * (1 + i), s.priorityFeeMaxSol);
      const out = await this.execute({
        publicKey: this.d.signer.publicKey,
        action: "sell",
        mint: args.position.mint,
        amount: "100%",
        denominatedInSol: false,
        slippageBps: ladder[i]!,
        priorityFeeSol: prio,
        pool: s.pool,
      });
      if (!out.ok) {
        errors.push(`attempt ${i + 1} @ ${ladder[i]}bps: ${out.reason}`);
        if (this.mode !== "live_dry_run") continue;
        // Dry-run wallet never holds the token, so a sell simulation is EXPECTED
        // to fail. Close the simulated position at mark so exits keep working.
      }
      let proceedsUsd: number;
      let feesUsd: number;
      let slippageUsd: number | null = null;
      let breakdown: Fill["feeBreakdown"];
      const simulated = !out.ok || !!out.simulated;
      const realistic = simulated ? this.dryRunFees(prio) : null;
      if (simulated && realistic) {
        // Dry-run, realistic (same model as paper): size-aware exit slippage,
        // then pump.fun/PumpSwap + PumpPortal + network fees off the SOL received.
        // Pool liquidity at exit ≈ entry liquidity × √(price move), measured from
        // the slipped fill price like paper (entryPrice here includes fees, so back them out).
        const entryFill = args.position.entryFeeBreakdown
          ? entryFillPrice(args.position)
          : args.position.entryPrice;
        const c = computeSellCosts(realistic.fees, {
          qty: args.position.qty,
          markPrice: args.markPrice,
          solUsd: args.solUsd,
          venue: args.position.venue,
          liquidityUsd: exitLiquidityUsd(args.position.entryLiquidityUsd, entryFill, args.markPrice),
          flatSlippageBps: realistic.flatSlippageBps,
        });
        proceedsUsd = c.proceedsUsd;
        feesUsd = c.breakdown.totalFeesUsd;
        slippageUsd = c.breakdown.slippageUsd;
        breakdown = c.breakdown;
      } else if (simulated) {
        const gross = args.position.qty * args.markPrice;
        feesUsd = gross * 0.005 + prio * args.solUsd;
        proceedsUsd = gross - feesUsd;
      } else {
        const delta = await this.readDelta((out as { signature: string }).signature, args.position.mint);
        if (delta) {
          proceedsUsd = (delta.solDeltaLamports / LAMPORTS_PER_SOL) * args.solUsd;
          feesUsd = (delta.feeLamports / LAMPORTS_PER_SOL) * args.solUsd + Math.max(0, proceedsUsd) * 0.005;
        } else {
          // Sold for sure (confirmed) but result unreadable: estimate, flag in journal.
          const gross = args.position.qty * args.markPrice;
          feesUsd = gross * 0.005 + prio * args.solUsd;
          proceedsUsd = gross - feesUsd;
          errors.push("confirmed but result unreadable — proceeds ESTIMATED");
        }
      }
      const fill: Fill = {
        id: randomUUID(),
        positionId: args.position.id,
        mint: args.position.mint,
        symbol: args.position.symbol,
        side: "sell",
        qty: args.position.qty,
        price: args.position.qty > 0 ? proceedsUsd / args.position.qty : 0,
        notionalUsd: proceedsUsd,
        feesUsd,
        slippageUsd: slippageUsd ?? Math.max(0, args.position.qty * args.markPrice - proceedsUsd - feesUsd),
        reason: args.reason,
        timestamp: this.now(),
        paper: false,
        mode: this.mode,
        signature: out.ok && !simulated ? out.signature : null,
        ...(breakdown ? { feeBreakdown: breakdown } : {}),
      };
      return {
        ok: true,
        fill,
        proceedsUsd,
        realizedPnlUsd: proceedsUsd - args.position.entryNotionalUsd,
        signature: fill.signature ?? null,
        attempts: i + 1,
        simulated,
        notes: errors,
      };
    }
    return { ok: false, reason: errors[errors.length - 1] ?? "sell failed", attempts: errors.length, errors };
  }
}

/**
 * Paper-model fill price for a realistic dry-run position. entryPrice is the
 * all-in cost per token (trade size ÷ tokens, like live); the paper model's
 * slipped fill price is that with the fees taken back out.
 */
function entryFillPrice(p: Position): number {
  const bd = p.entryFeeBreakdown!;
  if (!(p.qty > 0)) return p.entryPrice;
  const fill = Math.max(0, p.entryNotionalUsd - bd.totalFeesUsd) / p.qty;
  return fill > 0 ? fill : p.entryPrice;
}
