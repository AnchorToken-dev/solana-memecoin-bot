/**
 * Entry "memory": before a buy, look up the most similar setups the bot has
 * already traded (same mode) and skip if those lost badly on average.
 *
 * Oct 12 review (140 paper trades, 39W/101L, -$130): no single pre-entry
 * number separated winners from losers. A walk-forward test (each trade
 * scored only on trades before it, first 40 used for learning) with
 * 15 neighbours and a -8% average skipped 26 of 100 later trades worth
 * -$32 (8 winners, 10 sharp losses) and improved the average kept trade
 * from -$1.03 to -$0.96. Small edge, small sample. It's a brake, not a strategy.
 *
 * Features (all known at buy time, no extra requests): 5m run-up, share of
 * 24h volume inside the window, coin age, volume spike, liquidity, quote vs
 * on-chain gap, pool SOL reserve.
 *
 * Persisted per mode at <mode ledger dir>/memory.json. Seeded from that
 * mode's price tape on first start; updated after every closed trade.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryParams, TokenSnapshot } from "../types.js";

export const DEFAULT_MEMORY: MemoryParams = {
  enabled: true,
  minTrades: 40,
  neighbors: 15,
  skipAvgPnlPct: -8,
  maxTrades: 2_000,
};

export interface MemoryFeatures {
  runupPct: number | null;
  volSharePct: number | null;
  ageMin: number | null;
  spike: number | null;
  liquidityUsd: number | null;
  gapPct: number | null;
  reserveSol: number | null;
}

export interface MemoryTrade {
  at: number;
  symbol: string;
  f: MemoryFeatures;
  /** Realized P&L as % of trade size (fees included). */
  pnlPct: number;
}

export interface MemoryVerdict {
  skip: boolean;
  /** Trades remembered. */
  n: number;
  /** Neighbours used. */
  k: number;
  avgPnlPct: number | null;
  winRatePct: number | null;
  detail: string;
}

const KEYS: (keyof MemoryFeatures)[] = ["runupPct", "volSharePct", "ageMin", "spike", "liquidityUsd", "gapPct", "reserveSol"];
const LOG_KEYS = new Set<keyof MemoryFeatures>(["ageMin", "spike", "liquidityUsd", "reserveSol"]);

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function featuresFrom(
  snap: Pick<TokenSnapshot, "changeWindowPct" | "volumeWindowUsd" | "volume24hUsd" | "volumeAvgUsd" | "liquidityUsd" | "createdAt"> | undefined,
  nowMs: number,
  gapPct: number | null,
  reserveSol: number | null,
): MemoryFeatures {
  const share = snap && snap.volume24hUsd > 0 ? (snap.volumeWindowUsd / snap.volume24hUsd) * 100 : null;
  const age = snap?.createdAt && snap.createdAt > 0 ? (nowMs - snap.createdAt) / 60_000 : null;
  const spike = snap && snap.volumeAvgUsd > 0 ? snap.volumeWindowUsd / snap.volumeAvgUsd : null;
  return {
    runupPct: num(snap?.changeWindowPct),
    volSharePct: num(share),
    ageMin: num(age),
    spike: num(spike),
    liquidityUsd: snap && snap.liquidityUsd > 0 ? snap.liquidityUsd : null,
    gapPct: num(gapPct),
    reserveSol: num(reserveSol),
  };
}

function tx(k: keyof MemoryFeatures, v: number | null): number | null {
  if (v == null) return null;
  return LOG_KEYS.has(k) ? Math.log1p(Math.max(0, v)) : v;
}

function stdev(xs: number[]): number {
  if (xs.length < 2) return 1;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length;
  return Math.sqrt(v) || 1;
}

/** Pure scorer (used by the store and the replay test). */
export function scoreAgainst(history: readonly MemoryTrade[], f: MemoryFeatures, p: MemoryParams): MemoryVerdict {
  const n = history.length;
  if (!p.enabled) return { skip: false, n, k: 0, avgPnlPct: null, winRatePct: null, detail: "memory off" };
  if (n < p.minTrades) {
    return { skip: false, n, k: 0, avgPnlPct: null, winRatePct: null, detail: `learning (${n}/${p.minTrades} trades remembered)` };
  }
  const sd = new Map<keyof MemoryFeatures, number>();
  for (const k of KEYS) {
    const xs = history.map((h) => tx(k, h.f[k])).filter((v): v is number => v != null);
    sd.set(k, stdev(xs));
  }
  const ds: { d: number; h: MemoryTrade }[] = [];
  for (const h of history) {
    let s = 0;
    let used = 0;
    for (const k of KEYS) {
      const a = tx(k, h.f[k]);
      const b = tx(k, f[k]);
      if (a == null || b == null) continue;
      s += ((a - b) / sd.get(k)!) ** 2;
      used++;
    }
    if (used >= 3) ds.push({ d: Math.sqrt(s / used), h });
  }
  ds.sort((a, b) => a.d - b.d);
  const nb = ds.slice(0, p.neighbors).map((x) => x.h);
  if (nb.length < Math.min(p.neighbors, 5)) {
    return { skip: false, n, k: nb.length, avgPnlPct: null, winRatePct: null, detail: "not enough comparable trades" };
  }
  const avg = nb.reduce((a, h) => a + h.pnlPct, 0) / nb.length;
  const win = (nb.filter((h) => h.pnlPct > 0).length / nb.length) * 100;
  const skip = avg <= p.skipAvgPnlPct;
  return {
    skip,
    n,
    k: nb.length,
    avgPnlPct: avg,
    winRatePct: win,
    detail: `${nb.length} most similar past trades: ${win.toFixed(0)}% winners, average ${avg >= 0 ? "+" : ""}${avg.toFixed(1)}% (skip at ${p.skipAvgPnlPct}%)`,
  };
}

export class TradeMemory {
  readonly filePath: string;
  private trades: MemoryTrade[] = [];

  constructor(
    private readonly dir: string,
    private readonly p: MemoryParams,
  ) {
    this.filePath = join(dir, "memory.json");
    this.load();
  }

  get size(): number {
    return this.trades.length;
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as { trades?: MemoryTrade[] };
        this.trades = (raw.trades ?? []).filter((t) => t && t.f && Number.isFinite(t.pnlPct));
        return;
      }
    } catch {
      this.trades = [];
    }
    // First start in this mode: learn from the price tape already on disk.
    this.trades = seedFromTape(join(this.dir, "price-tape"));
    if (this.trades.length > 0) this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify({ v: 1, trades: this.trades }));
      renameSync(tmp, this.filePath);
    } catch {
      // best effort
    }
  }

  score(f: MemoryFeatures): MemoryVerdict {
    return scoreAgainst(this.trades, f, this.p);
  }

  add(t: MemoryTrade): void {
    if (!Number.isFinite(t.pnlPct)) return;
    this.trades.push(t);
    if (this.trades.length > this.p.maxTrades) this.trades.splice(0, this.trades.length - this.p.maxTrades);
    this.save();
  }
}

/** Rebuild remembered trades from price-tape JSONL (entry + exit pairs). */
export function seedFromTape(tapeDir: string): MemoryTrade[] {
  if (!existsSync(tapeDir)) return [];
  const entries = new Map<string, Record<string, unknown>>();
  const out: MemoryTrade[] = [];
  let files: string[];
  try {
    files = readdirSync(tapeDir).filter((f) => f.endsWith(".jsonl")).sort();
  } catch {
    return [];
  }
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(tapeDir, file), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      const id = d.tradeId as string;
      if (d.kind === "entry") entries.set(id, d);
      else if (d.kind === "exit") {
        const e = entries.get(id);
        if (!e) continue;
        const notional = num(e.notionalUsd);
        const pnl = num(d.realizedPnlUsd);
        if (!notional || pnl == null) continue;
        const snap = (e.snapshot ?? {}) as Record<string, number | null>;
        const marks = (d.marks ?? []) as unknown[][];
        const firstRes = marks.find((m) => Array.isArray(m) && m.length > 3)?.[3];
        out.push({
          at: num(e.at) ?? 0,
          symbol: String(e.symbol ?? ""),
          pnlPct: (pnl / notional) * 100,
          f: {
            runupPct: num(e.runupPct),
            volSharePct: num(e.windowVolumeSharePct),
            ageMin: num(e.coinAgeMin),
            spike: snap.volumeAvgUsd && snap.volumeAvgUsd > 0 && snap.volumeWindowUsd != null ? snap.volumeWindowUsd / snap.volumeAvgUsd : null,
            liquidityUsd: num(snap.liquidityUsd),
            gapPct: num(e.quoteVsOnchainPct),
            reserveSol: num(firstRes),
          },
        });
        entries.delete(id);
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
