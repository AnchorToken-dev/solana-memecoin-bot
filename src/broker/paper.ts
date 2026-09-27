import { randomUUID } from "node:crypto";
import type { BotConfig, ExitReason, Fill, Position } from "../types.js";

/**
 * Paper broker — simulates DEX fills with flat slippage + fee estimates.
 * No wallet keys. No on-chain transactions.
 *
 * LIVE STUB (not implemented):
 *   - Jupiter quote + swap API / Raydium SDK would replace applyBuy/applySell
 *   - See README § Live wiring (stub)
 */
export class PaperBroker {
  constructor(private readonly cfg: BotConfig) {}

  applyBuy(args: {
    mint: string;
    symbol: string;
    markPrice: number;
    notionalUsd: number;
  }): { fill: Fill; position: Position } {
    const { slippageBps, feeBps } = this.cfg.paperBroker;
    const slipMult = 1 + slippageBps / 10_000;
    const fillPrice = args.markPrice * slipMult;
    const feesUsd = args.notionalUsd * (feeBps / 10_000);
    const spendable = args.notionalUsd - feesUsd;
    const qty = spendable / fillPrice;
    const slippageUsd = args.notionalUsd - args.notionalUsd / slipMult;

    const positionId = randomUUID();
    const now = Date.now();

    const fill: Fill = {
      id: randomUUID(),
      positionId,
      mint: args.mint,
      symbol: args.symbol,
      side: "buy",
      qty,
      price: fillPrice,
      notionalUsd: args.notionalUsd,
      feesUsd,
      slippageUsd,
      timestamp: now,
      paper: true,
    };

    const position: Position = {
      id: positionId,
      mint: args.mint,
      symbol: args.symbol,
      side: "long",
      qty,
      entryPrice: fillPrice,
      entryNotionalUsd: args.notionalUsd,
      entryFeesUsd: feesUsd,
      highWaterPrice: fillPrice,
      trailArmed: false,
      openedAt: now,
    };

    return { fill, position };
  }

  applySell(args: {
    position: Position;
    markPrice: number;
    reason: ExitReason;
  }): { fill: Fill; proceedsUsd: number; realizedPnlUsd: number } {
    const { slippageBps, feeBps } = this.cfg.paperBroker;
    const slipMult = 1 - slippageBps / 10_000;
    const fillPrice = args.markPrice * slipMult;
    const gross = args.position.qty * fillPrice;
    const feesUsd = gross * (feeBps / 10_000);
    const proceedsUsd = gross - feesUsd;
    const slippageUsd =
      args.position.qty * args.markPrice - args.position.qty * fillPrice;
    const realizedPnlUsd =
      proceedsUsd -
      args.position.entryNotionalUsd;

    const fill: Fill = {
      id: randomUUID(),
      positionId: args.position.id,
      mint: args.position.mint,
      symbol: args.position.symbol,
      side: "sell",
      qty: args.position.qty,
      price: fillPrice,
      notionalUsd: proceedsUsd,
      feesUsd,
      slippageUsd,
      reason: args.reason,
      timestamp: Date.now(),
      paper: true,
    };

    return { fill, proceedsUsd, realizedPnlUsd };
  }
}

/** Placeholder for future live swaps — intentionally throws. */
export function liveSwapStub(_args: unknown): never {
  throw new Error(
    "liveSwapStub: not implemented. Wire Jupiter/Raydium here only after paper validation. Never commit private keys.",
  );
}
