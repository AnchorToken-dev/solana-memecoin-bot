/**
 * KOL shadow logger (separate process; never trades, never touches the bot's files).
 *
 *   npx tsx scripts/kol-shadow.ts
 *
 * For every KOL BUY it reads the coin's on-chain price at once and then over the next
 * 5 minutes, and writes one line per signal to data/kol/signals/.
 * Evaluate later with: npx tsx scripts/kol-eval.ts
 *
 * .env:
 *   KOL_FEED=tracker         tracker (default) = Solana Tracker KOL feed
 *                            helius = poll watched wallets and read buys from balances
 *   SOLANA_TRACKER_API_KEY   required when KOL_FEED=tracker
 *   HELIUS_API_KEY           required when KOL_FEED=helius (never printed)
 *   KOL_WALLETS=             comma-separated wallets for the Helius feed; otherwise the leaderboard file
 *   KOL_RPC_URL              optional; RPC for price reads (falls back to SOLANA_RPC_URL).
 *                            Use a different provider than the bot's if you can, so the two never share rate limits.
 *   KOL_POLL_MS=3000         how often to poll the feed
 *   KOL_MAX_ACTIVE=25        most coins tracked at the same time (extra signals are dropped and counted)
 *   KOL_ONLY_LEADERBOARD=false   tracker: true = only wallets in data/kol/leaderboard.json
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
import { createHeliusHistoryClient, HeliusWalletWatch } from "../src/kol/heliusWatch.js";
import { loadLeaderboardRanks } from "../src/kol/leaderboard.js";
import { DEFAULT_OFFSETS_S, KolShadowLogger } from "../src/kol/shadowLog.js";
import { KolTradePoller } from "../src/kol/trades.js";

const env = process.env;
const numEnv = (k: string, d: number, min: number, max: number): number => {
  const n = Number(env[k]);
  return Number.isFinite(n) && env[k]?.trim() ? Math.min(max, Math.max(min, n)) : d;
};
const dir = env.KOL_DATA_DIR?.trim() || "data/kol";
const feed = (env.KOL_FEED?.trim() || "tracker").toLowerCase();
const rpcUrl = (env.KOL_RPC_URL ?? env.SOLANA_RPC_URL)?.trim();
if (feed !== "tracker" && feed !== "helius") {
  console.error("KOL_FEED must be tracker or helius.");
  process.exit(1);
}
if (feed === "tracker" && !env.SOLANA_TRACKER_API_KEY?.trim()) {
  console.error("Set SOLANA_TRACKER_API_KEY in your .env file.");
  process.exit(1);
}
if (feed === "helius" && !env.HELIUS_API_KEY?.trim()) {
  console.error("Set HELIUS_API_KEY in your .env file.");
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
  onNote: (line) => console.log(line),
});

let rawLeft = Math.floor(numEnv("KOL_SAVE_RAW", 3, 0, 20));
let rawN = 0;
const pollMs = numEnv("KOL_POLL_MS", 3_000, 1_000, 60_000);

interface FeedCounters {
  polls: number;
  errors: number;
  rows: number;
  buys: number;
  possibleGaps: number;
  lastError: string | null;
  unreadable: number;
  lastUnreadable: string | null;
  stop: () => void;
  start: () => void;
}

let feedRun: FeedCounters;
if (feed === "helius") {
  const fromEnv = (env.KOL_WALLETS ?? "").split(/[\s,]+/).map((w) => w.trim()).filter(Boolean);
  const wallets = fromEnv.length > 0 ? fromEnv : [...ranks.keys()];
  if (wallets.length === 0) {
    console.error("KOL_FEED=helius needs KOL_WALLETS or data/kol/leaderboard.json. Run npm run kol:leaderboard first, or set KOL_WALLETS.");
    process.exit(1);
  }
  const watch = new HeliusWalletWatch(
    createHeliusHistoryClient(env.HELIUS_API_KEY!.trim(), fetch, numEnv("KOL_HELIUS_LIMIT", 25, 1, 100)),
    wallets,
    (buy) => void logger.onBuy(buy),
    { pollMs, onNote: (line) => console.log(line) },
  );
  feedRun = {
    get polls() { return watch.stats.polls; },
    get errors() { return watch.stats.errors; },
    get rows() { return watch.stats.rows; },
    get buys() { return watch.stats.buys; },
    get possibleGaps() { return watch.stats.possibleGaps; },
    get lastError() { return watch.stats.lastError; },
    get unreadable() { return watch.stats.unreadable; },
    get lastUnreadable() { return watch.stats.lastUnreadable; },
    stop: () => watch.stop(),
    start: () => watch.start(),
  };
  console.log(`KOL shadow logger started (no trading, Helius wallet watch). Poll ${pollMs} ms · ${wallets.length} wallet(s) · ${offsets.length} price samples per signal · output ${join(dir, "signals")}`);
} else {
  const poller = new KolTradePoller(new Client({ apiKey: env.SOLANA_TRACKER_API_KEY!.trim() }), (buy) => void logger.onBuy(buy), {
    pollMs,
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
  feedRun = {
    get polls() { return poller.stats.polls; },
    get errors() { return poller.stats.errors; },
    get rows() { return poller.stats.rows; },
    get buys() { return poller.stats.buys; },
    get possibleGaps() { return poller.stats.possibleGaps; },
    get lastError() { return poller.stats.lastError; },
    unreadable: 0,
    lastUnreadable: null,
    stop: () => poller.stop(),
    start: () => poller.start(),
  };
  console.log(`KOL shadow logger started (no trading, Solana Tracker). Poll ${pollMs} ms · ${offsets.length} price samples per signal · ${onlyLb ? `${ranks.size} leaderboard wallets only` : "all KOL wallets in the feed"} · output ${join(dir, "signals")}`);
}
feedRun.start();

const timer = setInterval(() => {
  const p = feedRun;
  const s = logger.stats;
  const why = s.lastUnreadable ?? p.lastUnreadable;
  console.log(
    `[${new Date().toISOString()}] polls ${p.polls} (errors ${p.errors}) · new rows ${p.rows} · KOL buys ${p.buys} · tracking ${logger.activeCount} · logged ${s.logged} · ` +
      `unpriced ${s.loggedUnpriced} · unreadable ${s.unreadable + p.unreadable} · busy-dropped ${s.droppedBusy} · read fails ${s.sampleReadFails} · possible gaps ${p.possibleGaps}` +
      (why ? ` · last unreadable: ${why}` : "") +
      (p.lastError ? ` · last error: ${p.lastError}` : ""),
  );
}, 60_000);

let stopping = false;
const shutdown = async (sig: string) => {
  if (stopping) process.exit(0);
  stopping = true;
  console.log(`${sig}: stopping, writing in-flight signals as partial…`);
  clearInterval(timer);
  feedRun.stop();
  await Promise.race([logger.flush(), new Promise((r) => setTimeout(r, 5_000))]);
  process.exit(0);
};
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown(sig));
