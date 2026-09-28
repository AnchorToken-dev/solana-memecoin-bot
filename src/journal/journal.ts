/**
 * Append-only paper trade journal — survives /runner/reset.
 * Stored as data/journal.json under the ledger/data dir.
 *
 * Each closed row stores token mint (CA) so same-named coins stay
 * distinguishable and the mobile Journal can deep-link DexScreener.
 */
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExitReason, Fill, Position } from "../types.js";
import { log } from "../logging.js";

export interface JournalEntry {
  id: string;
  /** Close timestamp (epoch ms). */
  timestamp: number;
  openedAt: number;
  /** Solana token mint / contract address (CA). */
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

/** Minimal fill shape for mint backfill (session ledger / trades.json). */
export interface FillMintSource {
  id: string;
  positionId: string;
  mint: string;
  symbol?: string;
}

function missingMint(mint: unknown): boolean {
  return typeof mint !== "string" || mint.trim() === "";
}

function normalizeEntry(raw: unknown): JournalEntry | null {
  if (raw == null || typeof raw !== "object") return null;
  const e = raw as Partial<JournalEntry>;
  if (typeof e.id !== "string" || typeof e.timestamp !== "number") return null;
  return {
    id: e.id,
    timestamp: e.timestamp,
    openedAt: typeof e.openedAt === "number" ? e.openedAt : e.timestamp,
    mint: typeof e.mint === "string" ? e.mint : "",
    symbol: typeof e.symbol === "string" ? e.symbol : "",
    side: "long",
    sizeUsd: typeof e.sizeUsd === "number" ? e.sizeUsd : 0,
    entryPrice: typeof e.entryPrice === "number" ? e.entryPrice : 0,
    exitPrice: typeof e.exitPrice === "number" ? e.exitPrice : 0,
    pnlUsd: typeof e.pnlUsd === "number" ? e.pnlUsd : 0,
    pnlPct: typeof e.pnlPct === "number" ? e.pnlPct : 0,
    exitReason: typeof e.exitReason === "string" ? e.exitReason : "unknown",
    note: typeof e.note === "string" ? e.note : "",
    positionId: typeof e.positionId === "string" ? e.positionId : "",
    fillId: typeof e.fillId === "string" ? e.fillId : "",
  };
}

export class TradeJournal {
  private entries: JournalEntry[] = [];
  private readonly path: string;
  private readonly dataDir: string;

  constructor(dataDir: string, filename = "journal.json") {
    mkdirSync(dataDir, { recursive: true });
    this.dataDir = dataDir;
    this.path = join(dataDir, filename);
    this.load();
    // Best-effort: restore mint on old rows from session fills still on disk.
    const fromDisk = this.readFillsFromTradesJson();
    if (fromDisk.length > 0) {
      this.backfillMissingMints(fromDisk);
    }
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
   * Always stores position.mint (CA) for DexScreener / disambiguation.
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
      mint: entry.mint,
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

  /**
   * Fill in missing mint/CA on old journal rows from paper fills.
   * Match order: fillId → positionId. Persists only when something changes.
   * Returns number of rows updated.
   */
  backfillMissingMints(fills: Iterable<FillMintSource | Fill>): number {
    const byFillId = new Map<string, string>();
    const byPositionId = new Map<string, string>();
    for (const f of fills) {
      const mint = typeof f.mint === "string" ? f.mint.trim() : "";
      if (!mint) continue;
      if (f.id) byFillId.set(f.id, mint);
      if (f.positionId) byPositionId.set(f.positionId, mint);
    }
    if (byFillId.size === 0 && byPositionId.size === 0) return 0;

    let updated = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]!;
      if (!missingMint(e.mint)) continue;
      const mint =
        (e.fillId ? byFillId.get(e.fillId) : undefined) ??
        (e.positionId ? byPositionId.get(e.positionId) : undefined);
      if (!mint) continue;
      this.entries[i] = { ...e, mint };
      updated += 1;
    }
    if (updated > 0) {
      this.persist();
      log.info("Journal mint backfill", { updated });
    }
    return updated;
  }

  /** Explicit clear only — NOT called from /runner/reset. */
  clear(): { ok: true; cleared: number } {
    const n = this.entries.length;
    this.entries = [];
    this.persist();
    log.info("Journal cleared", { cleared: n });
    return { ok: true, cleared: n };
  }

  private readFillsFromTradesJson(): FillMintSource[] {
    const tradesPath = join(this.dataDir, "trades.json");
    if (!existsSync(tradesPath)) return [];
    try {
      const raw = JSON.parse(readFileSync(tradesPath, "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      const out: FillMintSource[] = [];
      for (const rec of raw) {
        if (rec == null || typeof rec !== "object") continue;
        const fill = (rec as { fill?: unknown }).fill;
        if (fill == null || typeof fill !== "object") continue;
        const f = fill as Partial<FillMintSource>;
        if (
          typeof f.id === "string" &&
          typeof f.positionId === "string" &&
          typeof f.mint === "string" &&
          f.mint.trim() !== ""
        ) {
          out.push({
            id: f.id,
            positionId: f.positionId,
            mint: f.mint,
            symbol: typeof f.symbol === "string" ? f.symbol : undefined,
          });
        }
      }
      return out;
    } catch {
      return [];
    }
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
      this.entries = raw
        .map(normalizeEntry)
        .filter((e): e is JournalEntry => e != null);
    } catch {
      this.entries = [];
    }
  }

  private persist(): void {
    writeFileSync(this.path, `${JSON.stringify(this.entries, null, 2)}\n`, "utf8");
  }
}
