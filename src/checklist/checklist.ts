/**
 * Human research go/no-go checklist — survives /runner/reset.
 * Stored as data/checklists.json under the ledger/data dir.
 * Advisory by default; optional requireChecklistGo can gate paper entries.
 */
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "../logging.js";

export type CheckStatus = "pass" | "fail" | "skip" | "unset";
export type ChecklistVerdict = "GO" | "NO-GO" | "INCOMPLETE";

export interface ChecklistItemDef {
  id: string;
  label: string;
  /** When true, must be "pass" for GO (skip/unset → INCOMPLETE; fail → NO-GO). */
  required: boolean;
}

/** Default research rows — editable later via custom item payloads if needed. */
export const DEFAULT_CHECKLIST_ITEMS: readonly ChecklistItemDef[] = [
  {
    id: "token_age",
    label: "Token age OK (matches filters / not brand-new if Momentum)",
    required: true,
  },
  {
    id: "liquidity",
    label: "Liquidity above floor",
    required: true,
  },
  {
    id: "volume_real",
    label: "Volume looks real (not one-tick fake)",
    required: true,
  },
  {
    id: "holders",
    label: "Top holders not insanely concentrated / no deployer dump in progress",
    required: false,
  },
  {
    id: "mint_freeze",
    label: "Mint/freeze authority renounced or acceptable risk noted",
    required: false,
  },
  {
    id: "not_clone",
    label: "Not an obvious clone / scam name",
    required: true,
  },
  {
    id: "size_ok",
    label: "Size within bankroll rules (one trade, risk cap)",
    required: true,
  },
] as const;

export interface ChecklistItemState {
  id: string;
  label: string;
  required: boolean;
  status: CheckStatus;
}

export interface ResearchChecklist {
  id: string;
  /** Created / last-saved timestamp (epoch ms). */
  timestamp: number;
  mint: string;
  symbol: string;
  /** Optional DexScreener / Pump.fun URL. */
  link: string;
  items: ChecklistItemState[];
  /** One-line thesis (required for GO). */
  thesis: string;
  /** When to skip or exit (required for GO). */
  invalidation: string;
  verdict: ChecklistVerdict;
}

export interface ChecklistListResult {
  entries: ResearchChecklist[];
  total: number;
  limit: number;
  offset: number;
}

const STATUSES = new Set<CheckStatus>(["pass", "fail", "skip", "unset"]);

export function defaultItemStates(): ChecklistItemState[] {
  return DEFAULT_CHECKLIST_ITEMS.map((d) => ({
    id: d.id,
    label: d.label,
    required: d.required,
    status: "unset" as CheckStatus,
  }));
}

/**
 * GO only if every required row is pass, optional rows are pass or skip,
 * and thesis + invalidation are non-empty. Any fail → NO-GO. Gaps → INCOMPLETE.
 */
export function computeVerdict(args: {
  items: ChecklistItemState[];
  thesis: string;
  invalidation: string;
}): ChecklistVerdict {
  const thesisOk = args.thesis.trim().length > 0;
  const invOk = args.invalidation.trim().length > 0;
  if (!thesisOk || !invOk) return "INCOMPLETE";

  let sawFail = false;
  let incomplete = false;
  for (const item of args.items) {
    const st = STATUSES.has(item.status) ? item.status : "unset";
    if (st === "fail") {
      sawFail = true;
      continue;
    }
    if (item.required) {
      if (st === "pass") continue;
      incomplete = true;
    } else {
      // Optional: pass or skip OK; unset → incomplete; fail already counted
      if (st === "unset") incomplete = true;
    }
  }
  if (sawFail) return "NO-GO";
  if (incomplete) return "INCOMPLETE";
  return "GO";
}

function normalizeStatus(v: unknown): CheckStatus {
  if (typeof v === "string" && STATUSES.has(v as CheckStatus)) {
    return v as CheckStatus;
  }
  return "unset";
}

function mergeItems(
  incoming: unknown,
): ChecklistItemState[] {
  const byId = new Map<string, CheckStatus>();
  if (Array.isArray(incoming)) {
    for (const raw of incoming) {
      if (raw == null || typeof raw !== "object") continue;
      const o = raw as Record<string, unknown>;
      if (typeof o.id !== "string") continue;
      byId.set(o.id, normalizeStatus(o.status));
    }
  }
  return DEFAULT_CHECKLIST_ITEMS.map((d) => ({
    id: d.id,
    label: d.label,
    required: d.required,
    status: byId.get(d.id) ?? "unset",
  }));
}

function cleanStr(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, max);
}

export interface CreateChecklistInput {
  mint: string;
  symbol?: string;
  link?: string;
  items?: unknown;
  thesis?: string;
  invalidation?: string;
  /** If omitted, computed from items + thesis + invalidation. */
  verdict?: unknown;
}

export class ResearchChecklistStore {
  private entries: ResearchChecklist[] = [];
  private readonly path: string;

  constructor(dataDir: string, filename = "checklists.json") {
    mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, filename);
    this.load();
  }

  get filePath(): string {
    return this.path;
  }

  /** Template for the UI (empty draft). */
  template(): {
    items: ChecklistItemState[];
    thesis: string;
    invalidation: string;
    verdict: ChecklistVerdict;
  } {
    const items = defaultItemStates();
    return {
      items,
      thesis: "",
      invalidation: "",
      verdict: computeVerdict({ items, thesis: "", invalidation: "" }),
    };
  }

  list(opts?: { limit?: number; offset?: number; mint?: string }): ChecklistListResult {
    let pool = this.entries;
    if (opts?.mint && opts.mint.trim()) {
      const m = opts.mint.trim();
      pool = pool.filter((e) => e.mint === m);
    }
    const total = pool.length;
    const limitRaw = opts?.limit ?? 50;
    const offsetRaw = opts?.offset ?? 0;
    const limit = Number.isFinite(limitRaw)
      ? Math.min(Math.max(1, Math.floor(limitRaw)), 500)
      : 50;
    const offset = Number.isFinite(offsetRaw)
      ? Math.max(0, Math.floor(offsetRaw))
      : 0;
    const newestFirst = [...pool].reverse();
    return {
      entries: newestFirst.slice(offset, offset + limit),
      total,
      limit,
      offset,
    };
  }

  getById(id: string): ResearchChecklist | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /** Most recent checklist for a mint (any verdict). */
  latestForMint(mint: string): ResearchChecklist | undefined {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i]!;
      if (e.mint === mint) return e;
    }
    return undefined;
  }

  /** True when the latest checklist for mint is GO. */
  hasGoForMint(mint: string): boolean {
    const latest = this.latestForMint(mint);
    return latest?.verdict === "GO";
  }

  create(
    input: CreateChecklistInput,
  ): { ok: true; entry: ResearchChecklist } | { ok: false; message: string } {
    const mint = cleanStr(input.mint, 128);
    if (!mint) {
      return { ok: false, message: 'Body must include non-empty string "mint"' };
    }
    const symbol = cleanStr(input.symbol, 64) || mint.slice(0, 6).toUpperCase();
    const link = cleanStr(input.link, 500);
    const thesis = cleanStr(input.thesis, 500);
    const invalidation = cleanStr(input.invalidation, 500);
    const items = mergeItems(input.items);
    const verdict = computeVerdict({ items, thesis, invalidation });
    const entry: ResearchChecklist = {
      id: randomUUID(),
      timestamp: Date.now(),
      mint,
      symbol,
      link,
      items,
      thesis,
      invalidation,
      verdict,
    };
    this.entries.push(entry);
    this.persist();
    log.info("Research checklist saved", {
      id: entry.id,
      mint: entry.mint,
      verdict: entry.verdict,
    });
    return { ok: true, entry };
  }

  /**
   * Update an existing checklist (recomputes verdict).
   */
  update(
    id: string,
    patch: Partial<CreateChecklistInput>,
  ): { ok: true; entry: ResearchChecklist } | { ok: false; message: string } {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) {
      return { ok: false, message: `Checklist not found: ${id}` };
    }
    const prev = this.entries[i]!;
    const mint =
      patch.mint != null ? cleanStr(patch.mint, 128) : prev.mint;
    if (!mint) {
      return { ok: false, message: 'mint cannot be empty' };
    }
    const symbol =
      patch.symbol != null
        ? cleanStr(patch.symbol, 64) || mint.slice(0, 6).toUpperCase()
        : prev.symbol;
    const link = patch.link != null ? cleanStr(patch.link, 500) : prev.link;
    const thesis =
      patch.thesis != null ? cleanStr(patch.thesis, 500) : prev.thesis;
    const invalidation =
      patch.invalidation != null
        ? cleanStr(patch.invalidation, 500)
        : prev.invalidation;
    const items =
      patch.items != null ? mergeItems(patch.items) : prev.items;
    const verdict = computeVerdict({ items, thesis, invalidation });
    const updated: ResearchChecklist = {
      ...prev,
      mint,
      symbol,
      link,
      thesis,
      invalidation,
      items,
      verdict,
      timestamp: Date.now(),
    };
    this.entries[i] = updated;
    this.persist();
    return { ok: true, entry: updated };
  }

  clear(): { ok: true; cleared: number } {
    const n = this.entries.length;
    this.entries = [];
    this.persist();
    log.info("Research checklists cleared", { cleared: n });
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
      this.entries = raw
        .filter(
          (e): e is ResearchChecklist =>
            e != null &&
            typeof e === "object" &&
            typeof (e as ResearchChecklist).id === "string" &&
            typeof (e as ResearchChecklist).mint === "string" &&
            typeof (e as ResearchChecklist).timestamp === "number",
        )
        .map((e) => {
          const items = mergeItems(e.items);
          const thesis = typeof e.thesis === "string" ? e.thesis : "";
          const invalidation =
            typeof e.invalidation === "string" ? e.invalidation : "";
          return {
            id: e.id,
            timestamp: e.timestamp,
            mint: e.mint,
            symbol: typeof e.symbol === "string" ? e.symbol : e.mint.slice(0, 6),
            link: typeof e.link === "string" ? e.link : "",
            items,
            thesis,
            invalidation,
            verdict: computeVerdict({ items, thesis, invalidation }),
          };
        });
    } catch {
      this.entries = [];
    }
  }

  private persist(): void {
    writeFileSync(this.path, `${JSON.stringify(this.entries, null, 2)}\n`, "utf8");
  }
}
