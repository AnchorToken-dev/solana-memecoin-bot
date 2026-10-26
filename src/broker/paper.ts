import { randomUUID } from "node:crypto";
import type { BotConfig, ExitReason, Fill, Position } from "../types.js";
import { log } from "../logging.js";
import {
  computeBuyCosts,
  computeSellCosts,
  exitLiquidityUsd,
  type PaperVenue,
} from "./paperFees.js";
import { describePaperFill, priceJupiterBuy, priceJupiterSell } from "./jupiterFill.js";
import type { JupiterRouteQuote } from "./jupiterQuote.js";

/**
 * Paper broker — simulates DEX fills. No wallet keys. No on-chain transactions.
 *
 * Cost models (cfg.paperBroker.fees.model):
 *  - realistic + fillVenue jupiter (loadConfig default): Jupiter /build quote
 *    when the caller passes one, otherwise an offline model with no Jupiter
 *    fee and no PumpPortal fee. See src/broker/jupiterFill.ts.
 *  - realistic + fillVenue curve (or fillVenue omitted): pump.fun / PumpSwap
 *    fee, PumpPortal fee, network, rent, size-aware slippage.
 *  - legacy (or no `fees` block): flat FEE_BPS + SLIPPAGE_BPS, exactly as before.
 *
 * LIVE dry-run does not use this class. Slippage only moves the fill price;
 * it is never also added to feesUsd.
 */
export class PaperBroker {
  constructor(private readonly cfg: BotConfig) {}

  private realistic() {
    const f = this.cfg.paperBroker.fees;
    return f && f.model === "realistic" ? f : null;
  }

  /** Jupiter pricing is paper-only and only when the realistic model is on. */
  private jupiterPrices(): boolean {
    return this.cfg.paperBroker.fillVenue === "jupiter" && this.realistic() != null;
  }

  private fallbackFeeBps(): number {
    return this.cfg.paperBroker.jupiter?.fallbackFeeBps ?? 25;
  }

  applyBuy(args: {
    mint: string;
    symbol: string;
    markPrice: number;
    notionalUsd: number;
    /** SOL/USD for SOL-priced costs (network, rent). Falls back to config. */
    solUsd?: number | null;
    venue?: PaperVenue;
    liquidityUsd?: number;
    /** Live Jupiter quote for this size. Null/absent → offline fallback when fill venue is jupiter. */
    jupiterQuote?: JupiterRouteQuote | null;
    fallbackReason?: string;
  }): { fill: Fill; position: Position } {
    const positionId = randomUUID();
    const now = Date.now();
    const model = this.realistic();

    let fillPrice: number;
    let qty: number;
    let feesUsd: number;
    let slippageUsd: number;
    let tokenDecimals: number | undefined;
    let breakdown: Fill["feeBreakdown"];
    if (model && this.jupiterPrices()) {
      const c = priceJupiterBuy(model, {
        notionalUsd: args.notionalUsd,
        markPrice: args.markPrice,
        solUsd: args.solUsd,
        venue: args.venue,
        liquidityUsd: args.liquidityUsd,
        flatSlippageBps: this.cfg.paperBroker.slippageBps,
        fallbackFeeBps: this.fallbackFeeBps(),
        quote: args.jupiterQuote,
        fallbackReason: args.jupiterQuote ? undefined : (args.fallbackReason ?? "no Jupiter quote"),
        tokenDecimals: this.cfg.paperBroker.jupiter?.tokenDecimals,
      });
      fillPrice = c.fillPrice;
      qty = c.qty;
      feesUsd = c.breakdown.totalFeesUsd;
      slippageUsd = c.breakdown.slippageUsd;
      breakdown = c.breakdown;
      tokenDecimals = c.tokenDecimals;
      log.info(describePaperFill("BUY", args.symbol, c.breakdown));
    } else if (model) {
      const c = computeBuyCosts(model, {
        notionalUsd: args.notionalUsd,
        markPrice: args.markPrice,
        solUsd: args.solUsd,
        venue: args.venue,
        liquidityUsd: args.liquidityUsd,
        flatSlippageBps: this.cfg.paperBroker.slippageBps,
      });
      fillPrice = c.fillPrice;
      qty = c.qty;
      feesUsd = c.breakdown.totalFeesUsd;
      slippageUsd = c.breakdown.slippageUsd;
      breakdown = c.breakdown;
    } else {
      const { slippageBps, feeBps } = this.cfg.paperBroker;
      const slipMult = 1 + slippageBps / 10_000;
      fillPrice = args.markPrice * slipMult;
      feesUsd = args.notionalUsd * (feeBps / 10_000);
      qty = (args.notionalUsd - feesUsd) / fillPrice;
      slippageUsd = args.notionalUsd - args.notionalUsd / slipMult;
    }

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
      ...(breakdown ? { feeBreakdown: breakdown } : {}),
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
      ...(model ? { venue: breakdown!.venue } : {}),
      ...(model && typeof args.liquidityUsd === "number" && args.liquidityUsd > 0
        ? { entryLiquidityUsd: args.liquidityUsd }
        : {}),
      ...(breakdown ? { entryFeeBreakdown: breakdown } : {}),
      ...(tokenDecimals != null ? { tokenDecimals } : {}),
    };

    return { fill, position };
  }

  applySell(args: {
    position: Position;
    markPrice: number;
    reason: ExitReason;
    solUsd?: number | null;
    jupiterQuote?: JupiterRouteQuote | null;
    fallbackReason?: string;
  }): { fill: Fill; proceedsUsd: number; realizedPnlUsd: number } {
    const model = this.realistic();
    let fillPrice: number;
    let feesUsd: number;
    let proceedsUsd: number;
    let slippageUsd: number;
    let breakdown: Fill["feeBreakdown"];
    if (model && this.jupiterPrices()) {
      const c = priceJupiterSell(model, {
        qty: args.position.qty,
        markPrice: args.markPrice,
        solUsd: args.solUsd,
        venue: args.position.venue,
        liquidityUsd: exitLiquidityUsd(
          args.position.entryLiquidityUsd,
          args.position.entryPrice,
          args.markPrice,
        ),
        flatSlippageBps: this.cfg.paperBroker.slippageBps,
        fallbackFeeBps: this.fallbackFeeBps(),
        quote: args.jupiterQuote,
        fallbackReason: args.jupiterQuote ? undefined : (args.fallbackReason ?? "no Jupiter quote"),
        tokenDecimals: args.position.tokenDecimals,
      });
      fillPrice = c.fillPrice;
      feesUsd = c.breakdown.totalFeesUsd;
      proceedsUsd = c.proceedsUsd;
      slippageUsd = c.breakdown.slippageUsd;
      breakdown = c.breakdown;
      log.info(describePaperFill("SELL", args.position.symbol, c.breakdown));
    } else if (model) {
      const c = computeSellCosts(model, {
        qty: args.position.qty,
        markPrice: args.markPrice,
        solUsd: args.solUsd,
        venue: args.position.venue,
        liquidityUsd: exitLiquidityUsd(
          args.position.entryLiquidityUsd,
          args.position.entryPrice,
          args.markPrice,
        ),
        flatSlippageBps: this.cfg.paperBroker.slippageBps,
      });
      fillPrice = c.fillPrice;
      feesUsd = c.breakdown.totalFeesUsd;
      proceedsUsd = c.proceedsUsd;
      slippageUsd = c.breakdown.slippageUsd;
      breakdown = c.breakdown;
    } else {
      const { slippageBps, feeBps } = this.cfg.paperBroker;
      const slipMult = 1 - slippageBps / 10_000;
      fillPrice = args.markPrice * slipMult;
      const gross = args.position.qty * fillPrice;
      feesUsd = gross * (feeBps / 10_000);
      proceedsUsd = gross - feesUsd;
      slippageUsd = args.position.qty * args.markPrice - args.position.qty * fillPrice;
    }
    // Net of every cost: entry fees/rent were already taken out of the buy.
    const realizedPnlUsd = proceedsUsd - args.position.entryNotionalUsd;

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
      ...(breakdown ? { feeBreakdown: breakdown } : {}),
    };

    return { fill, proceedsUsd, realizedPnlUsd };
  }
}

/** Placeholder for future live swaps — intentionally throws. */
export function liveSwapStub(_args: unknown): never {
  throw new Error(
    "liveSwapStub: not implemented. Paper fills quote Jupiter for simulation only. Live sends stay on PumpPortal. Never commit private keys.",
  );
}
