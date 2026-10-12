/**
 * KOL shadow logger (separate process; never trades, never touches the bot's files).
 *
 *   npx tsx scripts/kol-shadow.ts
 *
 * Polls Solana Tracker's KOL trade feed. For every KOL BUY it reads the coin's on-chain price at
 * once and then over the next 5 minutes, and writes one line per signal to data/kol/signals/.
 * Evaluate later with: npx tsx scripts/kol-eval.ts
 *
 * .env:
 *   SOLANA_TRACKER_API_KEY   required
 *   KOL_RPC_URL              optional; RPC for price reads (falls back to SOLANA_RPC_URL).
 *                            Use a different provider than the bot's if you can, so the two never share rate limits.
 *   KOL_POLL_MS=3000         how often to poll the feed
 *   KOL_MAX_ACTIVE=25        most coins tracked at the same time (extra signals are dropped and counted)
 *   KOL_ONLY_LEADERBOARD=false   true = only wallets in data/kol/leaderboard.json
 *   KOL_SAMPLE_OFFSETS_S=    comma list of seconds, default 2,3,5,8,13,20,33,45,63,90,123,180,243,300 (keep 3 and 3+10/30/60/120/240 so kol-eval lines up)
 *   KOL_SAVE_RAW=3           save the first N raw feed responses to data/kol/raw-samples/ to check the format
 *   KOL_DATA_DIR=data/kol
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@solana-tracker/data-api";
import { OnchainPriceReader } from "../src/market/onchainPrice.js";
import { ReadOnlySolanaRpc } from "../src/solana/rpc.js";
import { loadLeaderboardRanks } from "../src/kol/leaderboard.js";
import { DEFAULT_OFFSETS_S, KolShadowLogger } from "../src/kol/shadowLog.js";
import { KolTradePoller } from "../src/kol/trades.js";

const env = process.env;
const numEnv = (k: string, d: number, min: number, max: number): number => {
  const n = Number(env[k]);
  return Number.isFinite(n) && env[k]?.trim() ? Math.min(max, Math.max(min, n)) : d;
};
const dir = env.KOL_DATA_DIR?.trim() || "data/kol";
const apiKey = env.SOLANA_TRACKER_API_KEY?.trim();
const rpcUrl = (env.KOL_RPC_URL ?? env.SOLANA_RPC_URL)?.trim();
if (!apiKey) {
  console.error("Set SOLANA_TRACKER_API_KEY in your .env file.");
  process.exit(1);
}
if (!rpcUrl) {
  console.error("Set KOL_RPC_URL (or SOLANA_RPC_URL) in your .env file; price reads need an RPC.");
  process.exit(1);
}

const offsets = env.KOL_SAMPLE_OFFSETS_S?.trim()
  ? env.KOL_SAMPLE_OFFSETS_S.split(",").map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 900)
  : [...DEFAULT_OFFSETS_S];
const ranks = loadLeaderboardRanks(join(dir, "leaderboard.json"));
const onlyLb = /^(1|true|yes)$/i.test(env.KOL_ONLY_LEADERBOARD ?? "");
if (onlyLb && ranks.size === 0) {
  console.error("KOL_ONLY_LEADERBOARD is on but data/kol/leaderboard.json is missing or empty. Run scripts/kol-leaderboard.ts first.");
  process.exit(1);
}

const rpc = new ReadOnlySolanaRpc(rpcUrl);
const reader = new OnchainPriceReader(rpc);
const logger = new KolShadowLogger({
  reader,
  dir,
  offsetsS: offsets,
  maxActive: numEnv("KOL_MAX_ACTIVE", 25, 1, 200),
  ranks,
});

let rawLeft = Math.floor(numEnv("KOL_SAVE_RAW", 3, 0, 20));
let rawN = 0;
const poller = new KolTradePoller(new Client({ apiKey }), (buy) => void logger.onBuy(buy), {
  pollMs: numEnv("KOL_POLL_MS", 3_000, 1_000, 60_000),
  onlyWallets: onlyLb ? new Set(ranks.keys()) : null,
  onRaw: (resp) => {
    if (rawLeft <= 0) return;
    rawLeft--;
    mkdirSync(join(dir, "raw-samples"), { recursive: true });
    const r = resp as { trades?: unknown[] };
    const sample = { ...r, trades: Array.isArray(r.trades) ? r.trades.slice(0, 5) : r.trades };
    writeFileSync(join(dir, "raw-samples", `kol-trades-${++rawN}.json`), JSON.stringify(sample, null, 2));
  },
});

console.log(`KOL shadow logger started (no trading). Poll ${numEnv("KOL_POLL_MS", 3_000, 1_000, 60_000)} ms · ${offsets.length} price samples per signal · ${onlyLb ? `${ranks.size} leaderboard wallets only` : "all KOL wallets in the feed"} · output ${join(dir, "signals")}`);
poller.start();

const timer = setInterval(() => {
  const p = poller.stats;
  const s = logger.stats;
  console.log(
    `[${new Date().toISOString()}] polls ${p.polls} (errors ${p.errors}) · new rows ${p.rows} · KOL buys ${p.buys} · tracking ${logger.activeCount} · logged ${s.logged} · ` +
      `unreadable ${s.unreadable} · busy-dropped ${s.droppedBusy} · read fails ${s.sampleReadFails} · possible gaps ${p.possibleGaps}` +
      (p.lastError ? ` · last error: ${p.lastError}` : ""),
  );
}, 60_000);

let stopping = false;
const shutdown = async (sig: string) => {
  if (stopping) process.exit(0);
  stopping = true;
  console.log(`${sig}: stopping, writing in-flight signals as partial…`);
  clearInterval(timer);
  poller.stop();
  await Promise.race([logger.flush(), new Promise((r) => setTimeout(r, 5_000))]);
  process.exit(0);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown(sig));
