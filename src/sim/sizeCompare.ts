/**
 * $30-vs-$15 shadow sizing (SIZE_COMPARE_USD, paper only; 0 = off).
 *
 * Every real paper buy is also priced at a second size with the same coin,
 * same mark, same pool depth and the same exit decision. Nothing is traded at
 * the shadow size. Uses the real paper fee model: percentage fees and
 * slippage scale with size (slippage grows with size/liquidity), while the
 * network fee and token-account rent are flat per trade.
 *
 * One JSONL line per closed trade: <mode dir>/size-compare.jsonl.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExitReason, Fill, Position } from "../types.js";
import type { PaperBroker } from "../broker/paper.js";

export interface SizeCompareRow {
  v: 1;
  tradeId: string;
  symbol: string;
  mint: string;
  openedAt: number;
  closedAt: number;
  reason: string;
  realUsd: number;
  shadowUsd: number;
  real: { entryFill: number; exitFill: number; feesUsd: number; slippageUsd: number; pnlUsd: number; pnlPct: number };
  shadow: { entryFill: number; exitFill: number; feesUsd: number; slippageUsd: number; pnlUsd: number; pnlPct: number };
  liquidityUsd: number | null;
}

export interface SizeCompareSummary {
  enabled: boolean;
  shadowUsd: number;
  trades: number;
  realPnlUsd: number;
  shadowPnlUsd: number;
  realAvgPnlPct: number | null;
  shadowAvgPnlPct: number | null;
  realFeesUsd: number;
  shadowFeesUsd: number;
  realSlippageUsd: number;
  shadowSlippageUsd: number;
  file: string;
}

export class SizeCompare {
  readonly file: string;
  private readonly open = new Map<string, { pos: Position; buyFees: number; buySlip: number; liq: number | null }>();
  private rows: SizeCompareRow[] = [];

  constructor(
    dir: string,
    readonly shadowUsd: number,
    private readonly broker: PaperBroker,
  ) {
    this.file = join(dir, "size-compare.jsonl");
    if (existsSync(this.file)) {
      try {
        this.rows = readFileSync(this.file, "utf8")
          .split("\n")
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l) as SizeCompareRow);
      } catch {
        this.rows = [];
      }
    }
  }

  get enabled(): boolean {
    return this.shadowUsd > 0;
  }

  /** Right after a real paper buy: price the same buy at the shadow size. */
  onBuy(real: Position, args: { markPrice: number; solUsd: number | null; venue?: Position["venue"]; liquidityUsd?: number }): void {
    if (!this.enabled) return;
    const { fill, position } = this.broker.applyBuy({
      mint: real.mint,
      symbol: real.symbol,
      markPrice: args.markPrice,
      notionalUsd: this.shadowUsd,
      solUsd: args.solUsd,
      ...(args.venue ? { venue: args.venue } : {}),
      ...(args.liquidityUsd ? { liquidityUsd: args.liquidityUsd } : {}),
    });
    this.open.set(real.id, { pos: position, buyFees: fill.feesUsd, buySlip: fill.slippageUsd, liq: args.liquidityUsd ?? null });
  }

  /** After the real sell: same mark, same reason, shadow size. */
  onSell(real: Position, realSell: Fill, realPnlUsd: number, markPrice: number, reason: ExitReason, solUsd: number | null): SizeCompareRow | null {
    const o = this.open.get(real.id);
    if (!o) return null;
    this.open.delete(real.id);
    const s = this.broker.applySell({ position: o.pos, markPrice, reason, solUsd });
    const realFees = (real.entryFeesUsd ?? 0) + realSell.feesUsd;
    const realSlip = (real.entryFeeBreakdown?.slippageUsd ?? 0) + realSell.slippageUsd;
    const row: SizeCompareRow = {
      v: 1,
      tradeId: real.id,
      symbol: real.symbol,
      mint: real.mint,
      openedAt: real.openedAt,
      closedAt: realSell.timestamp ?? Date.now(),
      reason,
      realUsd: real.entryNotionalUsd,
      shadowUsd: this.shadowUsd,
      real: {
        entryFill: real.entryPrice,
        exitFill: realSell.price,
        feesUsd: r6(realFees),
        slippageUsd: r6(realSlip),
        pnlUsd: r6(realPnlUsd),
        pnlPct: r6((realPnlUsd / real.entryNotionalUsd) * 100),
      },
      shadow: {
        entryFill: o.pos.entryPrice,
        exitFill: s.fill.price,
        feesUsd: r6(o.buyFees + s.fill.feesUsd),
        slippageUsd: r6(o.buySlip + s.fill.slippageUsd),
        pnlUsd: r6(s.realizedPnlUsd),
        pnlPct: r6((s.realizedPnlUsd / this.shadowUsd) * 100),
      },
      liquidityUsd: o.liq,
    };
    this.rows.push(row);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(row)}\n`, "utf8");
    } catch {
      // best effort — never affects trading
    }
    return row;
  }

  summary(): SizeCompareSummary {
    return summarizeSizeCompare(this.rows, this.enabled, this.shadowUsd, this.file);
  }
}

export function summarizeSizeCompare(rows: readonly SizeCompareRow[], enabled: boolean, shadowUsd: number, file: string): SizeCompareSummary {
  const sum = (f: (r: SizeCompareRow) => number) => r6(rows.reduce((a, r) => a + f(r), 0));
  const avg = (f: (r: SizeCompareRow) => number) => (rows.length ? r6(rows.reduce((a, r) => a + f(r), 0) / rows.length) : null);
  return {
    enabled,
    shadowUsd,
    trades: rows.length,
    realPnlUsd: sum((r) => r.real.pnlUsd),
    shadowPnlUsd: sum((r) => r.shadow.pnlUsd),
    realAvgPnlPct: avg((r) => r.real.pnlPct),
    shadowAvgPnlPct: avg((r) => r.shadow.pnlPct),
    realFeesUsd: sum((r) => r.real.feesUsd),
    shadowFeesUsd: sum((r) => r.shadow.feesUsd),
    realSlippageUsd: sum((r) => r.real.slippageUsd),
    shadowSlippageUsd: sum((r) => r.shadow.slippageUsd),
    file,
  };
}

function r6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
