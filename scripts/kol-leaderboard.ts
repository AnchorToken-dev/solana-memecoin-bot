/**
 * Fetch the KOL profit leaderboard from Solana Tracker and save it for the shadow logger.
 *
 *   npx tsx scripts/kol-leaderboard.ts                 # top 50 by total PnL
 *   npx tsx scripts/kol-leaderboard.ts --limit 100 --sort realized
 *
 * Needs SOLANA_TRACKER_API_KEY in .env (never on the command line, never in a file you commit).
 * Writes data/kol/leaderboard.json (wallet, rank, name + the full API row) and
 * data/kol/leaderboard-raw.json (the raw response, so you can check the format).
 * Read-only: one API call, no trading.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@solana-tracker/data-api";
import { extractLeaderboard } from "../src/kol/leaderboard.js";

const args = process.argv.slice(2);
const val = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const limit = Math.min(500, Math.max(1, Number(val("--limit") ?? 50)));
const SORTS = ["total", "realized", "unrealized", "invested", "proceeds", "value", "trades", "tokens", "roi", "win_percentage", "last_trade"] as const;
type Sort = (typeof SORTS)[number];
const sortArg = val("--sort") ?? "total";
if (!SORTS.includes(sortArg as Sort)) {
  console.error(`--sort must be one of: ${SORTS.join(", ")}`);
  process.exit(1);
}
const dir = process.env.KOL_DATA_DIR?.trim() || "data/kol";

const apiKey = process.env.SOLANA_TRACKER_API_KEY?.trim();
if (!apiKey) {
  console.error("Set SOLANA_TRACKER_API_KEY in your .env file (see .env.example). The key is not read from anywhere else.");
  process.exit(1);
}

try {
  const client = new Client({ apiKey });
  const resp = await client.getPnlV2KOLLeaderboard({ limit, sort: sortArg as Sort, direction: "desc" });
  const entries = extractLeaderboard(resp);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "leaderboard-raw.json"), JSON.stringify(resp, null, 2));
  writeFileSync(join(dir, "leaderboard.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), sort: sortArg, entries }, null, 2));
  console.log(`Saved ${entries.length} wallets to ${join(dir, "leaderboard.json")} (sorted by ${sortArg}).`);
  if (entries.length === 0) console.log("No wallets found in the response; open leaderboard-raw.json and check its format.");
  for (const e of entries.slice(0, 10)) {
    const total = (e.row as { pnl?: { total?: number | null } }).pnl?.total;
    console.log(`  #${String(e.rank).padStart(2)}  ${e.wallet.slice(0, 6)}…${e.wallet.slice(-4)}  ${e.name ?? "(no name)"}${typeof total === "number" ? `  total PnL $${Math.round(total).toLocaleString()}` : ""}`);
  }
} catch (err) {
  // Print only the message; never the client object (it holds the key).
  console.error("Leaderboard request failed:", (err instanceof Error ? err.message : String(err)).slice(0, 300));
  process.exit(1);
}
