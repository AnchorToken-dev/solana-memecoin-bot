# KOL shadow logger (v2)

**What it is.** A separate process that watches KOL buys and records what the coin's price did over the next 5 minutes. It answers one question with real data before any trading code exists: *if the bot had bought when it saw the KOL buy, would it have beaten the ~5-6% round-trip cost?*

Two feeds, selected with `KOL_FEED`:

- `tracker` (default) — Solana Tracker's KOL trade feed.
- `helius` — poll the public addresses in `KOL_WALLETS` (or `data/kol/leaderboard.json`) through Helius and read each buy from the wallet's SOL and token balance changes.

**What it is not.** It never trades, never imports the bot engine, and never touches the ledger, journal, memory, or price tape. Safe to run beside the paper test.

## Setup (on your machine)

1. Put the key in `.env` (git-ignored): `SOLANA_TRACKER_API_KEY=...` for the tracker feed, or `HELIUS_API_KEY=...` and `KOL_FEED=helius` for wallet watch. Optional: `KOL_RPC_URL=...` (a different provider than the bot's, so they never share rate limits; falls back to `SOLANA_RPC_URL`).
2. `npm run kol:leaderboard` — saves the top wallets (default top 50 by total PnL; `-- --limit 100 --sort realized`). Writes `data/kol/leaderboard.json` and `leaderboard-raw.json`.
3. `npm run kol:shadow` — leave running. A status line prints every minute.
4. `npm run kol:eval` — read the results (any time; it only reads files).

No webhook, tunnel or public URL is needed. The tracker feed polls `getKolTrades` (every 3 s by default). The Helius feed polls each watched wallet's recent transactions: 10 s between sweeps by default, with a gap between wallets so the calls are not a burst.

## What gets logged

One line per KOL buy in `data/kol/signals/YYYY-MM-DD.jsonl` (UTC day): the wallet, leaderboard rank, coin, the KOL's fill price, the feed delay (`lagMs`), the venue, and on-chain price samples at 0, 2, 3, 5, 8, 13, 20, 33, 45, 63, 90, 123, 180, 243 and 300 s.

The follow-up marks come from the pump.fun bonding curve and the canonical PumpSwap SOL pool only (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`). A buy on any other program used to be dropped and counted as `unreadable`, which is why most buys disappeared when wallets routed through other DEXes. Those buys are now written with `venue: "unpriced"` and a single sample at the fill. `kol:eval` still ignores them (it needs a sample near 3 s). A buy with no fill and no pump mark is still `unreadable`, and the log line names `reason`, `program`, and `programs`.

## How `kol:eval` judges it

- **Entry** = the sample at 3 s (about how long the bot needs to decide and fill), not the KOL's price. The gap between the two is reported as "chase".
- **Cost** = the same round-trip fee/slippage model as paper at the chosen `--size`.
- Reports return after costs at 10/30/60/120/240 s, a stop/take-profit walk (`--stop`, `--tp`, default 12/15), and breakdowns by feed delay, chase, venue and wallet.
- Samples are 2-60 s apart, so the stop/TP walk can miss a spike between samples. Treat it as a rough check.

## How to read it

- Need a 95% range **entirely above zero** after costs, on a few hundred signals, before this is worth building into the bot.
- Choosing the best wallet or bucket *from* the same data overstates it. Pick a rule, then confirm it on signals recorded after.
- The leaderboard is backward-looking. Wallets that look good may be insiders, promoters, or lucky.
- Feed delay matters: if most signals arrive 10+ s after the KOL's trade, the price has usually moved already.

## Helius request rate

`KOL_FEED=helius` sends one Helius address-history call per watched wallet per sweep. Those calls are paced:

- `KOL_HELIUS_MIN_INTERVAL_MS` (default `250`) — minimum time between history-call starts. The default is about 4 requests/second.
- `KOL_HELIUS_CONCURRENCY` (default `1`, max `4`) — how many history calls may be in flight at once.
- `KOL_HELIUS_POLL_MS` (default `10000`) — quiet time after a sweep finishes. When this is unset and `KOL_POLL_MS` is set, Helius uses `KOL_POLL_MS`. When both are unset, Helius waits 10 s. The tracker feed keeps `KOL_POLL_MS` (default `3000`) and ignores the Helius knobs.
- `KOL_HELIUS_MAX_BACKOFF_MS` (default `60000`) — cap on the pause after an error.
- `KOL_HELIUS_LIMIT` (default `25`, max `100`) — transactions read per wallet per sweep.

On HTTP 429 the sweep stops. The status line counts that response under `429s` (other failures stay under `errors`). The next sweep waits for the longer of `Retry-After` and exponential backoff, capped by `KOL_HELIUS_MAX_BACKOFF_MS`, and resumes at the wallet that was limited. A sweep with no failures clears the backoff. Other HTTP errors stay on `errors`; the sweep continues, still paced.

`possible gaps` means one wallet's page was entirely new, so a transaction may have fallen off the page. Raise `KOL_HELIUS_LIMIT` before shortening the intervals. If `429s` still climbs after a restart, set `KOL_HELIUS_MIN_INTERVAL_MS=500` or `1000`.

A ~50 wallet leaderboard can start on the defaults (`10000` / `250` / concurrency `1`).

## Limits and honest unknowns

- Written against Solana Tracker's documented response format; it could not be tested against the live API from the build environment. On the first run, check `data/kol/raw-samples/*.json` (the first few raw responses are saved) — if rows have no `meta.to.address`, the logger will count them as rejected (status line shows it) rather than guess.
- Solana Tracker rate limits: on a rate-limit error the tracker poller backs off (up to 60 s) and keeps going. `possible gaps` on that feed means a poll returned only new rows — raise the page size or lower `KOL_POLL_MS`. Helius pacing is described above.
- Only buys are logged (not the KOL's later sells), so "exit when the KOL exits" is not testable yet.
- Each tracked coin costs about one RPC read per sample (reads of the same coin within 0.8 s are shared). `KOL_MAX_ACTIVE` caps the load; dropped signals are counted.
- `KOL_FEED=helius` does not filter Helius history to `type=SWAP`. That filter only returns routers Helius already knows how to label, and the enhanced parser catalog is frozen, so newer routers never show up. Buys are read from balance changes. A transaction that still cannot be decoded (no token movement, two similar mints, a non-SOL/USDC/USDT quote, a failed transaction) is counted `unreadable` with the program ids on the line. Sells are counted separately and are not called unreadable.

## Verify without a live key

```
npm test
```

`tests/kol-helius-buy.test.ts` covers an unknown router on a v0 transaction whose account keys are `{pubkey, signer}` objects, an enhanced `source: UNKNOWN` buy, a sell, and a SWAP with no balances (the failure line includes the program id). `tests/kol-helius-throttle.test.ts` covers 429 backoff, `Retry-After`, the in-flight cap, and the gap between wallet history calls. `tests/kol-shadow.test.ts` covers a feed fill kept when the pump reader returns null.
