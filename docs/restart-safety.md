# Restart safety: saved open positions + live wallet check

Open positions used to live only in memory, so restarting the API while a
LIVE position was open made the bot forget it and left real tokens behind.

## What is saved

On every buy, sell, trailing high-water / trail-arm change and vault move, the
ledger rewrites a mode-scoped file **atomically** (temp file → fsync → rename):

| Mode | File |
|------|------|
| LIVE | `data/live/open-positions.json` |
| LIVE DRY-RUN | `data/live/open-positions.dry-run.json` |
| PAPER | `data/open-positions.paper.json` |

Each position keeps mint, symbol, qty, entry price, entry USD, fees +
breakdown, venue, pool liquidity, high-water price, trail armed, opened-at,
buy signature and mode, plus the current stop / TP / trail / max-hold levels
(informational; exits always recompute from config). The file also holds the
session cash and realized P&L. Nothing secret is written.

## On start

- **Boot (any mode):** positions in the file are loaded. If any are open,
  session cash + realized P&L come from the file too (that cash already paid
  for them), so nothing is double counted. A flat or missing file leaves a
  fresh session exactly as before. An unreadable file is moved aside
  (`*.corrupt-<time>`) and reported — never silently overwritten.
- **Runner start (LIVE only, not dry-run):** the bot reads the wallet's SPL
  token balances (Token **and** Token-2022, `getTokenAccountsByOwner` over the
  configured HTTPS RPC; read-only) and:
  - restored position, tokens gone (≤ 0.1% left) → closed as
    `reconciled_missing` in the problem log (`data/live-events.json`), **no
    sell attempted, no P&L booked**;
  - restored position, fewer tokens than recorded → tracks the wallet amount;
  - wallet holds a coin **the bot itself bought** (a confirmed live buy fill
    with a signature in `data/live/trades.json`, or an unconfirmed buy it sent,
    with a signature) in the last 24 h, with no later bot sell, and it isn't
    tracked → **adopted**: qty = wallet balance, entry = that buy's fill price
    (unconfirmed buy: current price). Managed with the normal exits.
  - every other token (coins you already held, dust) → left alone.
  - wallet read fails → the bot still starts, keeps managing saved positions,
    and warns.

Results show in `GET /status` → `positionRecovery` and as phone alerts.

## Shutdown

Ctrl+C / SIGTERM / closed terminal writes the file first, stops the runner,
writes again, exits. A second Ctrl+C exits immediately (file already written).

## Check before restarting

`GET /positions` → `"flat": true` means nothing is held. Otherwise it lists
each open position with its exit levels.
