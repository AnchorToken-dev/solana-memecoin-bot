/**
 * KOL leaderboard helpers (Solana Tracker `getPnlV2KOLLeaderboard`).
 *
 * The response is `{ traders: [{ wallet, pnl: {realized, unrealized, total}, invested, proceeds,
 * counts, identity?: {name, twitter, ...}, ... }], pagination }`. Only the wallet and display name
 * are needed to follow a wallet; the whole trader row is kept in the saved file for later analysis.
 *
 * The ranking is backward-looking profit. It says who WAS profitable, not who will be.
 */
import { existsSync, readFileSync } from "node:fs";

export interface LeaderboardEntry {
  rank: number;
  wallet: string;
  name: string | null;
  twitter: string | null;
  /** The full trader row from the API, kept for analysis. */
  row: unknown;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function extractLeaderboard(resp: unknown): LeaderboardEntry[] {
  const traders = isObj(resp) && Array.isArray(resp.traders) ? resp.traders : [];
  const out: LeaderboardEntry[] = [];
  const seen = new Set<string>();
  for (const t of traders) {
    if (!isObj(t) || typeof t.wallet !== "string" || !BASE58.test(t.wallet) || seen.has(t.wallet)) continue;
    seen.add(t.wallet);
    const id = isObj(t.identity) ? t.identity : null;
    out.push({
      rank: out.length + 1,
      wallet: t.wallet,
      name: id && typeof id.name === "string" ? id.name : null,
      twitter: id && typeof id.twitter === "string" ? id.twitter : null,
      row: t,
    });
  }
  return out;
}

/** wallet -> rank from a saved leaderboard file; empty map if missing or unreadable. */
export function loadLeaderboardRanks(path: string): Map<string, number> {
  const m = new Map<string, number>();
  try {
    if (!existsSync(path)) return m;
    const data = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const entries = isObj(data) && Array.isArray(data.entries) ? data.entries : [];
    for (const e of entries) {
      if (isObj(e) && typeof e.wallet === "string" && typeof e.rank === "number") m.set(e.wallet, e.rank);
    }
  } catch {
    /* ignore */
  }
  return m;
}
