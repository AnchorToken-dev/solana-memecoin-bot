import {
  mkdirSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { renameSync } from "node:fs";
import type {
  Fill,
  PortfolioSnapshot,
  Position,
  TradeRecord,
  TradingMode,
} from "../types.js";
import { log } from "../logging.js";
import {
  POSITIONS_FILE_VERSION,
  readPositionsFile,
  writeFileAtomic,
  type PositionLevels,
  type PositionsFile,
} from "./positionStore.js";

export interface PositionPersistence {
  path: string;
  mode: TradingMode;
  /** Optional exit levels written next to each position (informational). */
  levels?: (p: Position) => PositionLevels;
}

export type RestoreResult =
  | { ok: true; restored: Position[]; savedAt: number | null }
  | { ok: false; error: string; movedTo: string | null };

/**
 * Paper ledger + skim vault.
 *
 * - cashUsd = tradable bankroll used for sizing
 * - vaultUsd = skimmed funds locked out of sizing
 * - vault persists in data/vault.json and SURVIVES resetSession /runner/reset
 *   (same design as journal / checklists — learning + locked profit stick)
 */
export class PaperLedger {
  private cashUsd: number;
  private vaultUsd = 0;
  private positions: Position[] = [];
  private realizedPnlUsd = 0;
  private trades: TradeRecord[] = [];
  private readonly dir: string;
  private readonly jsonPath: string;
  private readonly csvPath: string;
  private readonly vaultPath: string;
  private persistence: PositionPersistence | null = null;
  private lastPositionsJson = "";

  constructor(bankrollUsd: number, ledgerDir: string) {
    this.cashUsd = bankrollUsd;
    this.dir = ledgerDir;
    this.jsonPath = join(ledgerDir, "trades.json");
    this.csvPath = join(ledgerDir, "trades.csv");
    this.vaultPath = join(ledgerDir, "vault.json");
    mkdirSync(ledgerDir, { recursive: true });
    if (!existsSync(this.csvPath)) {
      writeFileSync(
        this.csvPath,
        "timestamp,side,symbol,mint,qty,price,notionalUsd,feesUsd,slippageUsd,reason,realizedPnlUsd,cashAfter\n",
      );
    }
    this.loadVault();
  }

  /** Directory holding trades.json / vault.json (mode-scoped by the engine). */
  get directory(): string {
    return this.dir;
  }

  /** Write open positions + session cash to `opts.path` on every change from now on. */
  enablePositionPersistence(opts: PositionPersistence): void {
    this.persistence = opts;
  }

  get positionsFilePath(): string | null {
    return this.persistence?.path ?? null;
  }

  /**
   * Load open positions saved by a previous process. When the file has open
   * positions, session cash + realized PnL come from it too — that cash
   * already has those positions' cost deducted, so nothing is double counted.
   * A flat (or missing) file leaves the fresh session untouched.
   * A corrupt file is moved aside (never silently overwritten).
   */
  restorePositions(): RestoreResult {
    const pp = this.persistence;
    if (!pp) return { ok: true, restored: [], savedAt: null };
    const r = readPositionsFile(pp.path, pp.mode);
    if (!r.ok) {
      let movedTo: string | null = `${pp.path}.corrupt-${Date.now()}`;
      try {
        renameSync(pp.path, movedTo);
      } catch {
        movedTo = null;
      }
      return { ok: false, error: r.error, movedTo };
    }
    if (!r.file || r.file.positions.length === 0) return { ok: true, restored: [], savedAt: r.file?.savedAt ?? null };
    const known = new Set(this.positions.map((p) => p.id));
    const restored = r.file.positions.filter((p) => !known.has(p.id));
    this.positions.push(...restored);
    if (Number.isFinite(r.file.cashUsd)) this.cashUsd = r.file.cashUsd;
    if (Number.isFinite(r.file.realizedPnlUsd)) this.realizedPnlUsd = r.file.realizedPnlUsd;
    this.savePositions(true);
    return { ok: true, restored, savedAt: r.file.savedAt };
  }

  /** Force-write the positions file (graceful shutdown). */
  flushPositions(): void {
    this.savePositions(true);
  }

  private savePositions(force = false): void {
    const pp = this.persistence;
    if (!pp) return;
    const positions = this.positions.map((p) => (pp.levels ? { ...p, levels: pp.levels(p) } : { ...p }));
    const body = JSON.stringify({ positions, cashUsd: this.cashUsd, realizedPnlUsd: this.realizedPnlUsd });
    if (!force && body === this.lastPositionsJson) return;
    const file: PositionsFile = {
      version: POSITIONS_FILE_VERSION,
      mode: pp.mode,
      savedAt: Date.now(),
      cashUsd: this.cashUsd,
      realizedPnlUsd: this.realizedPnlUsd,
      positions,
    };
    try {
      writeFileAtomic(pp.path, `${JSON.stringify(file, null, 2)}\n`);
      this.lastPositionsJson = body;
    } catch (err) {
      log.error(`Could not save open positions to ${pp.path} — a restart now could lose track of them`, err);
    }
  }

  /**
   * Live reconciliation: track wallet tokens the bot bought but lost track of.
   * Their cost was spent in an earlier session → deduct it so cash isn't double counted.
   */
  adoptPosition(position: Position): void {
    this.positions.push(position);
    this.cashUsd -= position.entryNotionalUsd;
    this.savePositions(true);
    log.warn(
      `ADOPT ${position.symbol} qty=${position.qty} @ ${position.entryPrice.toPrecision(6)} (${position.adopted?.entrySource ?? "?"}) cash=$${this.cashUsd.toFixed(2)}`,
    );
  }

  /**
   * Live reconciliation: a restored position's tokens are gone from the wallet
   * (e.g. sold by hand). Remove it WITHOUT a sell and WITHOUT booking P&L
   * (proceeds unknown). Recorded in trades.json as a zero sell so the mint
   * is never re-adopted from the old buy.
   */
  dropPosition(position: Position, reason: "reconciled_missing"): boolean {
    const before = this.positions.length;
    this.positions = this.positions.filter((p) => p.id !== position.id);
    if (this.positions.length === before) return false;
    const fill: Fill = {
      id: `reconcile-${position.id}`,
      positionId: position.id,
      mint: position.mint,
      symbol: position.symbol,
      side: "sell",
      qty: 0,
      price: 0,
      notionalUsd: 0,
      feesUsd: 0,
      slippageUsd: 0,
      reason,
      timestamp: Date.now(),
      paper: position.mode == null || position.mode === "paper",
      ...(position.mode ? { mode: position.mode } : {}),
      signature: null,
    };
    const rec: TradeRecord = { fill, realizedPnlUsd: 0, cashAfter: this.cashUsd };
    this.trades.push(rec);
    this.persist(rec);
    this.savePositions(true);
    log.warn(`DROP ${position.symbol} (${position.mint}): ${reason} — not in wallet; no sell attempted, P&L not booked`);
    return true;
  }

  /** Every fill ever written to trades.json in this ledger dir (oldest first). */
  readAllFills(): Fill[] {
    if (!existsSync(this.jsonPath)) return [];
    try {
      const all = JSON.parse(readFileSync(this.jsonPath, "utf8")) as TradeRecord[];
      return Array.isArray(all) ? all.map((r) => r?.fill).filter((f): f is Fill => !!f && typeof f.mint === "string") : [];
    } catch {
      return [];
    }
  }

  get openPositions(): Position[] {
    return [...this.positions];
  }

  get cash(): number {
    return this.cashUsd;
  }

  /** Locked skim — not used for sizing. */
  get vault(): number {
    return this.vaultUsd;
  }

  /** Tradable cash alias (sizing input). */
  get tradableCash(): number {
    return this.cashUsd;
  }

  /** Session realized PnL (sum of closed paper sells). */
  get realizedPnl(): number {
    return this.realizedPnlUsd;
  }

  /** Most recent trades first. */
  getTrades(limit = 50): TradeRecord[] {
    const n = Math.max(0, Math.floor(limit));
    return [...this.trades].reverse().slice(0, n);
  }

  replacePosition(updated: Position): void {
    const i = this.positions.findIndex((p) => p.id === updated.id);
    if (i >= 0) {
      this.positions[i] = updated;
      // Only rewrites when something changed (high-water / trail arm), not every tick.
      this.savePositions();
    }
  }

  recordBuy(fill: Fill, position: Position): void {
    this.cashUsd -= fill.notionalUsd;
    this.positions.push(position);
    const rec: TradeRecord = { fill, cashAfter: this.cashUsd };
    this.trades.push(rec);
    this.persist(rec);
    this.savePositions(true);
    log.info(
      `BUY  ${fill.symbol} qty=${fill.qty.toFixed(4)} @ ${fill.price.toPrecision(6)} (fees $${fill.feesUsd.toFixed(4)}) cash=$${this.cashUsd.toFixed(2)} vault=$${this.vaultUsd.toFixed(2)}`,
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
    this.savePositions(true);
    log.info(
      `SELL ${fill.symbol} @ ${fill.price.toPrecision(6)} reason=${fill.reason} pnl=$${realizedPnlUsd.toFixed(4)} cash=$${this.cashUsd.toFixed(2)} vault=$${this.vaultUsd.toFixed(2)}`,
    );
  }

  /**
   * Move USD from tradable cash into the vault (locked out of sizing).
   * Capped to available cash. amount must be > 0.
   */
  skim(amountUsd: number): {
    ok: boolean;
    message: string;
    skimmedUsd: number;
    cashUsd: number;
    vaultUsd: number;
  } {
    if (!(amountUsd > 0) || !Number.isFinite(amountUsd)) {
      return {
        ok: false,
        message: "amountUsd must be a positive number",
        skimmedUsd: 0,
        cashUsd: this.cashUsd,
        vaultUsd: this.vaultUsd,
      };
    }
    const skimmed = Math.min(amountUsd, this.cashUsd);
    if (skimmed < 0.01) {
      return {
        ok: false,
        message: "No tradable cash available to skim",
        skimmedUsd: 0,
        cashUsd: this.cashUsd,
        vaultUsd: this.vaultUsd,
      };
    }
    this.cashUsd -= skimmed;
    this.vaultUsd += skimmed;
    this.persistVault();
    this.savePositions();
    log.info(
      `VAULT skim $${skimmed.toFixed(2)} → vault=$${this.vaultUsd.toFixed(2)} tradable=$${this.cashUsd.toFixed(2)}`,
    );
    return {
      ok: true,
      message: `Skimmed $${skimmed.toFixed(2)} to vault`,
      skimmedUsd: skimmed,
      cashUsd: this.cashUsd,
      vaultUsd: this.vaultUsd,
    };
  }

  /**
   * Move USD from vault back to tradable cash (paper convenience).
   */
  returnFromVault(amountUsd: number): {
    ok: boolean;
    message: string;
    returnedUsd: number;
    cashUsd: number;
    vaultUsd: number;
  } {
    if (!(amountUsd > 0) || !Number.isFinite(amountUsd)) {
      return {
        ok: false,
        message: "amountUsd must be a positive number",
        returnedUsd: 0,
        cashUsd: this.cashUsd,
        vaultUsd: this.vaultUsd,
      };
    }
    const returned = Math.min(amountUsd, this.vaultUsd);
    if (returned < 0.01) {
      return {
        ok: false,
        message: "Vault is empty",
        returnedUsd: 0,
        cashUsd: this.cashUsd,
        vaultUsd: this.vaultUsd,
      };
    }
    this.vaultUsd -= returned;
    this.cashUsd += returned;
    this.persistVault();
    this.savePositions();
    log.info(
      `VAULT return $${returned.toFixed(2)} → vault=$${this.vaultUsd.toFixed(2)} tradable=$${this.cashUsd.toFixed(2)}`,
    );
    return {
      ok: true,
      message: `Returned $${returned.toFixed(2)} from vault to tradable cash`,
      returnedUsd: returned,
      cashUsd: this.cashUsd,
      vaultUsd: this.vaultUsd,
    };
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
      tradableCashUsd: this.cashUsd,
      vaultUsd: this.vaultUsd,
      equityUsd: equity,
      totalEquityUsd: equity + this.vaultUsd,
      openPositions: this.openPositions,
      realizedPnlUsd: this.realizedPnlUsd,
      unrealizedPnlUsd: unrealized,
      tradeCount: this.trades.length,
    };
  }

  /**
   * Clear session state for a fresh paper run: cash back to bankroll,
   * no positions, zero realized PnL, empty in-memory trades, and rewrite
   * trades.json / trades.csv (header only).
   *
   * Vault is NOT cleared — locked skim survives /runner/reset like journal.
   */
  resetSession(bankrollUsd: number): void {
    this.cashUsd = bankrollUsd;
    this.positions = [];
    this.realizedPnlUsd = 0;
    this.trades = [];
    this.savePositions(true);
    writeFileSync(this.jsonPath, "[]\n");
    writeFileSync(
      this.csvPath,
      "timestamp,side,symbol,mint,qty,price,notionalUsd,feesUsd,slippageUsd,reason,realizedPnlUsd,cashAfter\n",
    );
    log.info(
      `Paper ledger reset: cash=$${bankrollUsd.toFixed(2)}, trades cleared, vault=$${this.vaultUsd.toFixed(2)} (survives)`,
    );
  }

  private loadVault(): void {
    if (!existsSync(this.vaultPath)) {
      this.vaultUsd = 0;
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.vaultPath, "utf8")) as {
        vaultUsd?: unknown;
      };
      const v = Number(raw?.vaultUsd);
      this.vaultUsd = Number.isFinite(v) && v > 0 ? v : 0;
    } catch {
      this.vaultUsd = 0;
    }
  }

  private persistVault(): void {
    writeFileSync(
      this.vaultPath,
      `${JSON.stringify({ vaultUsd: this.vaultUsd, updatedAt: Date.now() }, null, 2)}\n`,
    );
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
