/**
 * Append-only paper trade journal — survives /runner/reset.
 * Stored as data/journal.json under the ledger/data dir.
 *
 * Each closed row stores token mint (CA) so same-named coins stay
 * distinguishable and the mobile Journal can deep-link DexScreener.
 *
 * Amounts are USD-primary (paper bot) with optional quote-asset mirrors
 * (SOL today; multi-chain via quoteAsset / chainId). P&L rollups use
 * America/New_York calendar periods by default.
 */
import type { TradingMode } from "../live/mode.js";
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
import {
  JOURNAL_TZ_DEFAULT,
  startOfDay,
  startOfMonth,
  startOfWeekMonday,
} from "./timezone.js";
import { computeJournalCharts, type JournalCharts } from "./charts.js";

/** Default chain quote asset for Solana paper bot (multi-chain later). */
export const DEFAULT_QUOTE_ASSET = "SOL";
export const DEFAULT_CHAIN_ID = "solana";

export type QuoteBasis = "recorded" | "estimated" | "usd_only";

export interface JournalEntry {
  id: string;
  /** Close timestamp (epoch ms). */
  timestamp: number;
  openedAt: number;
  /** Token mint / contract address (CA). */
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
  /**
   * Latest research checklist for this mint at close time (if any).
   * Snapshot only — checklist edits later do not rewrite journal rows.
   */
  checklistId: string | null;
  checklistVerdict: "GO" | "NO-GO" | "INCOMPLETE" | null;
  /** Thesis snippet from that checklist (truncated). */
  checklistThesis: string | null;
  /**
   * Chain quote asset ticker for native sizing display (SOL now;
   * later RHUSD / etc. — do not hard-wire UI to "SOL" forever).
   */
  quoteAsset: string;
  /** Chain id for explorers / Dex links (solana now; multi-chain later). */
  chainId: string;
  /** Entry size in quote asset units, when known. */
  sizeQuote: number | null;
  /** Realized PnL in quote asset units, when known. */
  pnlQuote: number | null;
  /** USD per 1 quote unit at fill time (e.g. SOL/USD). */
  quoteUsdRate: number | null;
  /** How quote amounts were obtained. */
  quoteBasis: QuoteBasis;
  /** paper | live_dry_run | live. Old rows without it load as paper. */
  mode: TradingMode;
  /** On-chain sell signature (live only). */
  signature: string | null;
  /** Hot-button trade size used for the buy ($15/$30/$60). null on old rows. */
  tradeSizeUsd: number | null;
}

export type JournalModeFilter = TradingMode | "all";

export function isJournalModeFilter(v: unknown): v is JournalModeFilter {
  return v === "paper" || v === "live_dry_run" || v === "live" || v === "all";
}

export function filterEntriesByMode(entries: JournalEntry[], mode: JournalModeFilter | undefined): JournalEntry[] {
  if (!mode || mode === "all") return entries;
  return entries.filter((e) => e.mode === mode);
}

export type JournalPeriodKey = "daily" | "weekly" | "monthly" | "overall";

export interface JournalPeriodSummary {
  period: JournalPeriodKey;
  /** Human label for mobile UI. */
  label: string;
  /** Inclusive period start (epoch ms); 0 for overall. */
  fromMs: number;
  /** Exclusive period end (epoch ms); now+epsilon for open-ended. */
  toMs: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  /**
   * wins / (wins + losses) * 100.
   * null when there are no decided closes (no trades, or only breakevens)
   * so clients do not paint a fake 0%.
   */
  winPct: number | null;
  pnlUsd: number;
  sizeUsd: number;
  /** Sum of quote PnL (recorded + estimated); null if nothing convertible. */
  pnlQuote: number | null;
  sizeQuote: number | null;
  quoteAsset: string;
  /** Aggregate basis across rows in the window. */
  quoteBasis: QuoteBasis | "mixed";
}

export interface JournalSummary {
  timezone: string;
  quoteAsset: string;
  chainId: string;
  /**
   * Rate used to estimate quote amounts for usd_only / missing-rate rows.
   * null when no estimate was applied.
   */
  estimateQuoteUsdRate: number | null;
  periods: JournalPeriodSummary[];
  /** Short note on how periods / quote amounts work. */
  note: string;
}

export interface JournalListResult {
  entries: JournalEntry[];
  total: number;
  limit: number;
  offset: number;
  summary: JournalSummary;
  /**
   * Tendencies from every stored row (not just this page).
   * Read-only; pagination does not drop older closes from the charts.
   */
  charts: JournalCharts;
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

function asFiniteNumber(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v;
}

function normalizeQuoteBasis(raw: unknown): QuoteBasis {
  if (raw === "recorded" || raw === "estimated" || raw === "usd_only") {
    return raw;
  }
  return "usd_only";
}

function deriveQuoteAmounts(
  sizeUsd: number,
  pnlUsd: number,
  quoteUsdRate: number | null | undefined,
): {
  sizeQuote: number | null;
  pnlQuote: number | null;
  quoteUsdRate: number | null;
  quoteBasis: QuoteBasis;
} {
  const rate =
    typeof quoteUsdRate === "number" &&
    Number.isFinite(quoteUsdRate) &&
    quoteUsdRate > 0
      ? quoteUsdRate
      : null;
  if (rate == null) {
    return {
      sizeQuote: null,
      pnlQuote: null,
      quoteUsdRate: null,
      quoteBasis: "usd_only",
    };
  }
  return {
    sizeQuote: sizeUsd / rate,
    pnlQuote: pnlUsd / rate,
    quoteUsdRate: rate,
    quoteBasis: "recorded",
  };
}

function normalizeEntry(raw: unknown): JournalEntry | null {
  if (raw == null || typeof raw !== "object") return null;
  const e = raw as Partial<JournalEntry>;
  if (typeof e.id !== "string" || typeof e.timestamp !== "number") return null;
  const sizeUsd = typeof e.sizeUsd === "number" ? e.sizeUsd : 0;
  const pnlUsd = typeof e.pnlUsd === "number" ? e.pnlUsd : 0;
  const storedRate = asFiniteNumber(e.quoteUsdRate);
  const storedSizeQ = asFiniteNumber(e.sizeQuote);
  const storedPnlQ = asFiniteNumber(e.pnlQuote);
  let quoteBasis = normalizeQuoteBasis(e.quoteBasis);
  let quoteUsdRate = storedRate != null && storedRate > 0 ? storedRate : null;
  let sizeQuote = storedSizeQ;
  let pnlQuote = storedPnlQ;

  // Legacy rows: only USD. Keep usd_only unless we already have quote fields.
  if (quoteUsdRate == null && sizeQuote == null && pnlQuote == null) {
    quoteBasis = "usd_only";
  } else if (quoteUsdRate != null && (sizeQuote == null || pnlQuote == null)) {
    sizeQuote = sizeUsd / quoteUsdRate;
    pnlQuote = pnlUsd / quoteUsdRate;
    if (quoteBasis === "usd_only") quoteBasis = "recorded";
  }

  return {
    id: e.id,
    timestamp: e.timestamp,
    openedAt: typeof e.openedAt === "number" ? e.openedAt : e.timestamp,
    mint: typeof e.mint === "string" ? e.mint : "",
    symbol: typeof e.symbol === "string" ? e.symbol : "",
    side: "long",
    sizeUsd,
    entryPrice: typeof e.entryPrice === "number" ? e.entryPrice : 0,
    exitPrice: typeof e.exitPrice === "number" ? e.exitPrice : 0,
    pnlUsd,
    pnlPct: typeof e.pnlPct === "number" ? e.pnlPct : 0,
    exitReason: typeof e.exitReason === "string" ? e.exitReason : "unknown",
    note: typeof e.note === "string" ? e.note : "",
    positionId: typeof e.positionId === "string" ? e.positionId : "",
    fillId: typeof e.fillId === "string" ? e.fillId : "",
    quoteAsset:
      typeof e.quoteAsset === "string" && e.quoteAsset.trim()
        ? e.quoteAsset.trim().toUpperCase()
        : DEFAULT_QUOTE_ASSET,
    chainId:
      typeof e.chainId === "string" && e.chainId.trim()
        ? e.chainId.trim().toLowerCase()
        : DEFAULT_CHAIN_ID,
    sizeQuote,
    pnlQuote,
    quoteUsdRate,
    quoteBasis,
    checklistId:
      typeof e.checklistId === "string" && e.checklistId.trim()
        ? e.checklistId.trim()
        : null,
    checklistVerdict:
      e.checklistVerdict === "GO" ||
      e.checklistVerdict === "NO-GO" ||
      e.checklistVerdict === "INCOMPLETE"
        ? e.checklistVerdict
        : null,
    checklistThesis:
      typeof e.checklistThesis === "string" && e.checklistThesis.trim()
        ? e.checklistThesis.trim().slice(0, 200)
        : null,
    mode: e.mode === "live" || e.mode === "live_dry_run" ? e.mode : "paper",
    signature: typeof e.signature === "string" ? e.signature : null,
    tradeSizeUsd: typeof e.tradeSizeUsd === "number" ? e.tradeSizeUsd : null,
  };
}

function quoteForEntry(
  e: JournalEntry,
  estimateRate: number | null,
): {
  sizeQuote: number | null;
  pnlQuote: number | null;
  basis: QuoteBasis;
} {
  if (
    e.quoteBasis === "recorded" &&
    e.pnlQuote != null &&
    e.sizeQuote != null
  ) {
    return { sizeQuote: e.sizeQuote, pnlQuote: e.pnlQuote, basis: "recorded" };
  }
  if (e.pnlQuote != null && e.sizeQuote != null && e.quoteBasis === "estimated") {
    return { sizeQuote: e.sizeQuote, pnlQuote: e.pnlQuote, basis: "estimated" };
  }
  const rate =
    e.quoteUsdRate != null && e.quoteUsdRate > 0
      ? e.quoteUsdRate
      : estimateRate != null && estimateRate > 0
        ? estimateRate
        : null;
  if (rate == null) {
    return { sizeQuote: null, pnlQuote: null, basis: "usd_only" };
  }
  const basis: QuoteBasis =
    e.quoteUsdRate != null && e.quoteUsdRate > 0 ? "recorded" : "estimated";
  return {
    sizeQuote: e.sizeUsd / rate,
    pnlQuote: e.pnlUsd / rate,
    basis,
  };
}

/** Win % from decided closes only. null when wins + losses is 0. */
function journalWinPct(winCount: number, lossCount: number): number | null {
  const decided = winCount + lossCount;
  if (!Number.isFinite(decided) || decided <= 0) return null;
  return (winCount / decided) * 100;
}

function mergeBasis(
  a: QuoteBasis | "mixed" | null,
  b: QuoteBasis,
): QuoteBasis | "mixed" {
  if (a == null) return b;
  if (a === b) return a;
  return "mixed";
}

function buildPeriod(
  period: JournalPeriodKey,
  label: string,
  fromMs: number,
  toMs: number,
  entries: JournalEntry[],
  quoteAsset: string,
  estimateRate: number | null,
): JournalPeriodSummary {
  let tradeCount = 0;
  let winCount = 0;
  let lossCount = 0;
  let pnlUsd = 0;
  let sizeUsd = 0;
  let pnlQuoteSum = 0;
  let sizeQuoteSum = 0;
  let quoteRows = 0;
  let basis: QuoteBasis | "mixed" | null = null;

  for (const e of entries) {
    if (e.timestamp < fromMs || e.timestamp >= toMs) continue;
    tradeCount += 1;
    pnlUsd += e.pnlUsd;
    sizeUsd += e.sizeUsd;
    if (e.pnlUsd > 0) winCount += 1;
    else if (e.pnlUsd < 0) lossCount += 1;
    const q = quoteForEntry(e, estimateRate);
    basis = mergeBasis(basis, q.basis);
    if (q.pnlQuote != null && q.sizeQuote != null) {
      pnlQuoteSum += q.pnlQuote;
      sizeQuoteSum += q.sizeQuote;
      quoteRows += 1;
    }
  }

  return {
    period,
    label,
    fromMs,
    toMs,
    tradeCount,
    winCount,
    lossCount,
    winPct: journalWinPct(winCount, lossCount),
    pnlUsd,
    sizeUsd,
    pnlQuote: quoteRows > 0 ? pnlQuoteSum : null,
    sizeQuote: quoteRows > 0 ? sizeQuoteSum : null,
    quoteAsset,
    quoteBasis: basis ?? "usd_only",
  };
}

export function computeJournalSummary(
  entries: JournalEntry[],
  opts?: {
    nowMs?: number;
    timeZone?: string;
    quoteAsset?: string;
    chainId?: string;
    estimateQuoteUsdRate?: number | null;
  },
): JournalSummary {
  const nowMs = opts?.nowMs ?? Date.now();
  const timeZone = opts?.timeZone ?? JOURNAL_TZ_DEFAULT;
  const quoteAsset = opts?.quoteAsset ?? DEFAULT_QUOTE_ASSET;
  const chainId = opts?.chainId ?? DEFAULT_CHAIN_ID;
  const estimateQuoteUsdRate =
    opts?.estimateQuoteUsdRate != null &&
    Number.isFinite(opts.estimateQuoteUsdRate) &&
    opts.estimateQuoteUsdRate > 0
      ? opts.estimateQuoteUsdRate
      : null;

  const dayStart = startOfDay(nowMs, timeZone);
  const weekStart = startOfWeekMonday(nowMs, timeZone);
  const monthStart = startOfMonth(nowMs, timeZone);
  const overallFrom =
    entries.length > 0
      ? Math.min(...entries.map((e) => e.timestamp))
      : 0;

  const periods: JournalPeriodSummary[] = [
    buildPeriod(
      "daily",
      "Today",
      dayStart,
      nowMs + 1,
      entries,
      quoteAsset,
      estimateQuoteUsdRate,
    ),
    buildPeriod(
      "weekly",
      "This week",
      weekStart,
      nowMs + 1,
      entries,
      quoteAsset,
      estimateQuoteUsdRate,
    ),
    buildPeriod(
      "monthly",
      "This month",
      monthStart,
      nowMs + 1,
      entries,
      quoteAsset,
      estimateQuoteUsdRate,
    ),
    buildPeriod(
      "overall",
      "Overall",
      overallFrom,
      nowMs + 1,
      entries,
      quoteAsset,
      estimateQuoteUsdRate,
    ),
  ];

  return {
    timezone: timeZone,
    quoteAsset,
    chainId,
    estimateQuoteUsdRate,
    periods,
    note:
      "Periods are calendar day / Monday-week / month in America/New_York (or timezone). " +
      "USD is primary; quote amounts use fill-time quoteUsdRate when recorded, else estimateQuoteUsdRate (marked estimated).",
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

  list(opts?: {
    limit?: number;
    offset?: number;
    nowMs?: number;
    timeZone?: string;
    estimateQuoteUsdRate?: number | null;
    /** Filter rows + summary + charts by mode. Default all. */
    mode?: JournalModeFilter;
  }): JournalListResult {
    const rows = filterEntriesByMode(this.entries, opts?.mode);
    const total = rows.length;
    const limitRaw = opts?.limit ?? 50;
    const offsetRaw = opts?.offset ?? 0;
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(1, Math.floor(limitRaw)), 500)
      : 50;
    const offset = Number.isFinite(offsetRaw)
      ? Math.max(0, Math.floor(offsetRaw))
      : 0;
    // Newest first
    const newestFirst = [...rows].reverse();
    const summary = computeJournalSummary(rows, {
      nowMs: opts?.nowMs,
      timeZone: opts?.timeZone,
      estimateQuoteUsdRate: opts?.estimateQuoteUsdRate,
    });
    const charts = computeJournalCharts(rows, {
      timeZone: opts?.timeZone,
    });
    return {
      entries: newestFirst.slice(offset, offset + limit),
      total,
      limit,
      offset,
      summary,
      charts,
    };
  }

  /**
   * Live problem log (failed sells, unconfirmed buys). Separate file so the
   * closed-trade schema in journal.json stays unchanged. Capped at 500 rows.
   */
  appendEvent(ev: { kind: string; symbol: string; mint: string; detail: string; signature?: string | null }): void {
    const path = join(this.dataDir, "live-events.json");
    const list = this.listEvents();
    list.push({ ...ev, timestamp: Date.now() });
    writeFileSync(path, `${JSON.stringify(list.slice(-500), null, 2)}\n`, "utf8");
  }

  listEvents(): Array<{ kind: string; symbol: string; mint: string; detail: string; signature?: string | null; timestamp: number }> {
    const path = join(this.dataDir, "live-events.json");
    if (!existsSync(path)) return [];
    try {
      const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
      return Array.isArray(raw) ? (raw as never[]) : [];
    } catch {
      return [];
    }
  }

  /** Sum of realized PnL for rows of `mode` closed at or after fromMs. */
  realizedSince(fromMs: number, mode: TradingMode): number {
    return this.entries
      .filter((e) => e.mode === mode && e.timestamp >= fromMs)
      .reduce((a, e) => a + e.pnlUsd, 0);
  }

  getById(id: string): JournalEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * Append a closed-trade row. Call after a successful paper sell.
   * Always stores position.mint (CA) for DexScreener / disambiguation.
   * When quoteUsdRate is provided, stores quote-asset size/PnL as recorded.
   */
  appendClose(args: {
    position: Position;
    exitPrice: number;
    pnlUsd: number;
    exitReason: ExitReason | string;
    fillId: string;
    timestamp?: number;
    note?: string;
    /** USD per 1 quote unit at fill time (SOL/USD). */
    quoteUsdRate?: number | null;
    quoteAsset?: string;
    chainId?: string;
    /** Snapshot of latest checklist for mint at close (optional). */
    checklistId?: string | null;
    checklistVerdict?: "GO" | "NO-GO" | "INCOMPLETE" | null;
    checklistThesis?: string | null;
    mode?: TradingMode;
    signature?: string | null;
  }): JournalEntry {
    const sizeUsd = args.position.entryNotionalUsd;
    const pnlPct = sizeUsd > 0 ? (args.pnlUsd / sizeUsd) * 100 : 0;
    const derived = deriveQuoteAmounts(
      sizeUsd,
      args.pnlUsd,
      args.quoteUsdRate,
    );
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
      quoteAsset: (args.quoteAsset ?? DEFAULT_QUOTE_ASSET).toUpperCase(),
      chainId: (args.chainId ?? DEFAULT_CHAIN_ID).toLowerCase(),
      sizeQuote: derived.sizeQuote,
      pnlQuote: derived.pnlQuote,
      quoteUsdRate: derived.quoteUsdRate,
      quoteBasis: derived.quoteBasis,
      checklistId:
        typeof args.checklistId === "string" && args.checklistId.trim()
          ? args.checklistId.trim()
          : null,
      checklistVerdict:
        args.checklistVerdict === "GO" ||
        args.checklistVerdict === "NO-GO" ||
        args.checklistVerdict === "INCOMPLETE"
          ? args.checklistVerdict
          : null,
      checklistThesis:
        typeof args.checklistThesis === "string" && args.checklistThesis.trim()
          ? args.checklistThesis.trim().slice(0, 200)
          : null,
      mode: args.mode ?? "paper",
      signature: args.signature ?? null,
      tradeSizeUsd: typeof args.position.tradeSizeUsd === "number" ? args.position.tradeSizeUsd : null,
    };
    this.entries.push(entry);
    this.persist();
    log.info("Journal close recorded", {
      id: entry.id,
      symbol: entry.symbol,
      mint: entry.mint,
      pnlUsd: entry.pnlUsd,
      pnlQuote: entry.pnlQuote,
      quoteAsset: entry.quoteAsset,
      quoteBasis: entry.quoteBasis,
      reason: entry.exitReason,
      mode: entry.mode,
      checklistId: entry.checklistId,
      checklistVerdict: entry.checklistVerdict,
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
