/**
 * Append-only paper trade journal — survives /runner/reset.
 * Stored as data/journal.json under the ledger/data dir.
 */
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExitReason, Position } from "../types.js";
import { log } from "../logging.js";

export interface JournalEntry {
  id: string;
  /** Close timestamp (epoch ms). */
  timestamp: number;
  openedAt: number;
  mint: string;
  symbol: string;
  side: "long";
  /** Entry notional USD (size). */
  sizeUsd: number;
  entryPrice: number;
  exitPrice: number;
  pnlUsd: number;
  /** Realized % vs entry notional. */
  pnlPct: number;
  exitReason: ExitReason | string;
  /** Free-text learning note (editable via PATCH). */
  note: string;
  positionId: string;
  fillId: string;
}

export interface JournalListResult {
  entries: JournalEntry[];
  total: number;
  limit: number;
  offset: number;
}

export class TradeJournal {
  private entries: JournalEntry[] = [];
  private readonly path: string;

  constructor(dataDir: string, filename = "journal.json") {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, filename);
    this.load();
  }

  get filePath(): string {
    return this.path;
  }

  list(opts?: { limit?: number; offset?: number }): JournalListResult {
    const total = this.entries.length;
    const limitRaw = opts?.limit ?? 50;
    const offsetRaw = opts?.offset ?? 0;
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(1, Math.floor(limitRaw)), 500)
      : 50;
    const offset = Number.isFinite(offsetRaw)
      ? Math.max(0, Math.floor(offsetRaw))
      : 0;
    // Newest first
    const newestFirst = [...this.entries].reverse();
    return {
      entries: newestFirst.slice(offset, offset + limit),
      total,
      limit,
      offset,
    };
  }

  getById(id: string): JournalEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * Append a closed-trade row. Call after a successful paper sell.
   */
  appendClose(args: {
    position: Position;
    exitPrice: number;
    pnlUsd: number;
    exitReason: ExitReason | string;
    fillId: string;
    timestamp?: number;
    note?: string;
  }): JournalEntry {
    const sizeUsd = args.position.entryNotionalUsd;
    const pnlPct =
      sizeUsd > 0 ? (args.pnlUsd / sizeUsd) * 100 : 0;
    const entry: JournalEntry = {
      id: randomUUID(),
      timestamp: args.timestamp ?? Date.now(),
      openedAt: args.position.openedAt,
      mint: args.position.mint,
      symbol: args.position.symbol,
      side: "long",
      sizeUsd,
      entryPrice: args.position.entryPrice,
      exitPrice: args.exitPrice,
      pnlUsd: args.pnlUsd,
      pnlPct,
      exitReason: args.exitReason,
      note: args.note ?? "",
      positionId: args.position.id,
      fillId: args.fillId,
    };
    this.entries.push(entry);
    this.persist();
    log.info("Journal close recorded", {
      id: entry.id,
      symbol: entry.symbol,
      pnlUsd: entry.pnlUsd,
      reason: entry.exitReason,
    });
    return entry;
  }

  updateNote(
    id: string,
    note: string,
  ): { ok: true; entry: JournalEntry } | { ok: false; message: string } {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) {
      return { ok: false, message: `Journal entry not found: ${id}` };
    }
    const cleaned = typeof note === "string" ? note.slice(0, 4000) : "";
    const updated: JournalEntry = { ...this.entries[i]!, note: cleaned };
    this.entries[i] = updated;
    this.persist();
    return { ok: true, entry: updated };
  }

  /** Explicit clear only — NOT called from /runner/reset. */
  clear(): { ok: true; cleared: number } {
    const n = this.entries.length;
    this.entries = [];
    this.persist();
    log.info("Journal cleared", { cleared: n });
    return { ok: true, cleared: n };
  }

  private load(): void {
    if (!existsSync(this.path)) {
      this.entries = [];
      this.persist();
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      if (!Array.isArray(raw)) {
        this.entries = [];
        return;
      }
      this.entries = raw.filter(
        (e): e is JournalEntry =>
          e != null &&
          typeof e === "object" &&
          typeof (e as JournalEntry).id === "string" &&
          typeof (e as JournalEntry).timestamp === "number",
      );
    } catch {
      this.entries = [];
    }
  }

  private persist(): void {
    writeFileSync(this.path, `${JSON.stringify(this.entries, null, 2)}\n`, "utf8");
  }
}
