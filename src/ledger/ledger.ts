import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
  Fill,
  PortfolioSnapshot,
  Position,
  TradeRecord,
} from "../types.js";
import { log } from "../logging.js";

export class PaperLedger {
  private cashUsd: number;
  private positions: Position[] = [];
  private realizedPnlUsd = 0;
  private trades: TradeRecord[] = [];
  private readonly dir: string;
  private readonly jsonPath: string;
  private readonly csvPath: string;

  constructor(bankrollUsd: number, ledgerDir: string) {
    this.cashUsd = bankrollUsd;
    this.dir = ledgerDir;
    this.jsonPath = join(ledgerDir, "trades.json");
    this.csvPath = join(ledgerDir, "trades.csv");
    mkdirSync(ledgerDir, { recursive: true });
    if (!existsSync(this.csvPath)) {
      writeFileSync(
        this.csvPath,
        "timestamp,side,symbol,mint,qty,price,notionalUsd,feesUsd,slippageUsd,reason,realizedPnlUsd,cashAfter\n",
      );
    }
  }

  get openPositions(): Position[] {
    return [...this.positions];
  }

  get cash(): number {
    return this.cashUsd;
  }

  /** Most recent trades first. */
  getTrades(limit = 50): TradeRecord[] {
    const n = Math.max(0, Math.floor(limit));
    return [...this.trades].reverse().slice(0, n);
  }

  replacePosition(updated: Position): void {
    const i = this.positions.findIndex((p) => p.id === updated.id);
    if (i >= 0) this.positions[i] = updated;
  }

  recordBuy(fill: Fill, position: Position): void {
    this.cashUsd -= fill.notionalUsd;
    this.positions.push(position);
    const rec: TradeRecord = { fill, cashAfter: this.cashUsd };
    this.trades.push(rec);
    this.persist(rec);
    log.info(
      `BUY  ${fill.symbol} qty=${fill.qty.toFixed(4)} @ ${fill.price.toPrecision(6)} (fees $${fill.feesUsd.toFixed(4)}) cash=$${this.cashUsd.toFixed(2)}`,
    );
  }

  recordSell(
    fill: Fill,
    realizedPnlUsd: number,
    proceedsUsd: number,
  ): void {
    this.positions = this.positions.filter((p) => p.id !== fill.positionId);
    this.cashUsd += proceedsUsd;
    this.realizedPnlUsd += realizedPnlUsd;
    const rec: TradeRecord = {
      fill,
      realizedPnlUsd,
      cashAfter: this.cashUsd,
    };
    this.trades.push(rec);
    this.persist(rec);
    log.info(
      `SELL ${fill.symbol} @ ${fill.price.toPrecision(6)} reason=${fill.reason} pnl=$${realizedPnlUsd.toFixed(4)} cash=$${this.cashUsd.toFixed(2)}`,
    );
  }

  snapshot(marks: Map<string, number>): PortfolioSnapshot {
    let unrealized = 0;
    for (const p of this.positions) {
      const m = marks.get(p.mint) ?? p.entryPrice;
      unrealized += p.qty * m - p.entryNotionalUsd;
    }
    const equity = this.cashUsd + this.positions.reduce((sum, p) => {
      const m = marks.get(p.mint) ?? p.entryPrice;
      return sum + p.qty * m;
    }, 0);

    return {
      cashUsd: this.cashUsd,
      equityUsd: equity,
      openPositions: this.openPositions,
      realizedPnlUsd: this.realizedPnlUsd,
      unrealizedPnlUsd: unrealized,
      tradeCount: this.trades.length,
    };
  }

  private persist(rec: TradeRecord): void {
    // JSON array rewrite (small paper ledgers)
    let all: TradeRecord[] = [];
    if (existsSync(this.jsonPath)) {
      try {
        all = JSON.parse(readFileSync(this.jsonPath, "utf8")) as TradeRecord[];
      } catch {
        all = [];
      }
    }
    all.push(rec);
    writeFileSync(this.jsonPath, JSON.stringify(all, null, 2));

    const f = rec.fill;
    const line = [
      new Date(f.timestamp).toISOString(),
      f.side,
      f.symbol,
      f.mint,
      f.qty,
      f.price,
      f.notionalUsd,
      f.feesUsd,
      f.slippageUsd,
      f.reason ?? "",
      rec.realizedPnlUsd ?? "",
      rec.cashAfter,
    ].join(",");
    appendFileSync(this.csvPath, line + "\n");
  }
}
