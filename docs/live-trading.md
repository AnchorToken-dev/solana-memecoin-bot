# Live trading (gated, opt-in)

Paper is the default. Live is reachable only when **all** gates pass; otherwise the
bot runs PAPER and logs which gate failed.

| Gate | Value |
|------|-------|
| `PAPER_MODE` | `false` |
| `LIVE_TRADING_ENABLED` | `true` |
| `LIVE_CONFIRM` | `I_UNDERSTAND` (exact) |
| `LIVE_DRY_RUN` | anything but `false` = **dry-run** (default) |
| `LIVE_WALLET_KEYPAIR_PATH` | required, file must be `chmod 600` |
| `SOLANA_RPC_URL` | required (HTTPS send/simulate/confirm) |

Behaviour change vs. main: `PAPER_MODE=false` alone used to crash at startup
("live is stubbed"). It now falls back to PAPER with a warning.

## Execution route: PumpPortal Local Transaction API

`POST https://pumpportal.fun/api/trade-local` returns an **unsigned** transaction.
The bot then:

1. checks the fee payer is the bot wallet and that it is the only signer (refuses otherwise),
2. signs locally (node:crypto ed25519; no extra npm deps),
3. `simulateTransaction` (sigVerify on); a failed simulation is never sent,
4. dry-run stops here; live calls `sendTransaction` over `SOLANA_RPC_URL`,
5. polls `getSignatureStatuses` over HTTPS until `confirmed` (timeout `LIVE_CONFIRM_TIMEOUT_MS`),
6. reads `getTransaction` and records the **real** SOL spent/received (network +
   priority fee included) and the real token amount.

Why: one endpoint covers the bonding curve **and** graduated coins
(`pool=auto` → pump / pump-amm / raydium), the key never leaves the machine, no
API key or account is needed, and it's what pump.fun bots commonly use. Jupiter
can't route pre-graduation bonding-curve coins, which is most of what the sniper
preset buys. Hand-building pump.fun program instructions is more code and breaks
whenever pump.fun changes accounts (it has changed its fee accounts several times).
Cost: PumpPortal takes **0.5%** per trade.

WSS stays listen-only (slotSubscribe as today). No signatureSubscribe was added;
HTTPS polling is simpler and was enough.

## Safety rules in code

- Live caps (env only, never PATCH-able): `LIVE_MAX_POSITION_USD` (60; hot-button size $15/$30/$60 never exceeds it),
  `LIVE_MAX_OPEN_POSITIONS` (1), `LIVE_DAILY_LOSS_LIMIT_USD` (30, ET day, from
  journal live rows), `LIVE_MIN_SOL_RESERVE` (0.05 SOL).
- Rug filter is forced on in live. No RPC or a filter error means **skip the buy**.
- No ghost positions: a buy becomes a position only after it is confirmed with tokens > 0.
  An unconfirmed send raises a loud `live_buy_unconfirmed` alert and goes in `data/live-events.json`.
- Sells use the same stop / TP / trail / time-stop logic as paper. On failure they retry on a
  slippage ladder (`LIVE_SLIPPAGE_BPS` → `LIVE_SELL_MAX_SLIPPAGE_BPS`, `LIVE_SELL_MAX_ATTEMPTS`),
  and the priority fee goes up too, capped at `LIVE_PRIORITY_FEE_MAX_SOL`. If every attempt
  fails, the position stays open and is retried next tick. A `live_sell_failed` alert goes to
  `/alerts` and `data/live-events.json`.
- Live has its own session ledger (`data/live/`) so paper numbers never mix with real ones.
  The journal tags every row `paper` / `live_dry_run` / `live`. `GET /journal?mode=live` filters
  rows, the P&L summary and the charts.
- Kill switch: `POST /runner/stop` halts new buys at once and keeps managing held coins.
  A second stop stops fully. `POST /runner/sell-all` halts buys and sells everything.
- `/status.live` shows only the public address, SOL balance, caps, halt state and
  today's live P&L. The key file path and contents are never returned or logged.
  Errors go through `redactSecrets` (RPC URL, api keys, key bytes).

## Rough cost per $15 round trip (SOL ≈ $118, Oct 7 2026)

$15 ≈ 0.127 SOL.

| Item | Per side | Round trip |
|------|----------|-----------|
| PumpPortal fee 0.5% | $0.075 | $0.15 |
| pump.fun bonding curve 1.25% (PumpSwap after graduation ≈ 0.3%) | $0.19 | $0.38 |
| Base + priority fee (0.000005 + 0.0002 SOL) | $0.024 | $0.05 |
| Token account rent (~0.002 SOL, first buy of each coin; only refunded if the account is closed) | | ~$0.24 |
| **Total before slippage** | | **≈ $0.80 (≈ 5% of $15)** |

Paper models 0.5% slippage + 0.3% fee (about $0.24 per round trip), so live will
be noticeably worse than paper before any slippage. Consider raising paper
`FEE_BPS` to ~200 to preview it.

## Trade-size hot buttons ($15 / $30 / $60)

- `POST /config/trade-size` `{ "usd": 15 | 30 | 60 }`: any other value → 400; above the active cap → 409.
  `GET /config/trade-size`. Also shown in `/status.tradeSize` and `/portfolio.tradeSize`.
- Works in paper, dry-run and live, and is allowed while running. It affects **new buys only**.
- Persisted in `data/trade-size.json`. Default is $15.
- Cap: `LIVE_MAX_POSITION_USD` in live/dry-run, `MAX_POSITION_USD` in paper. Buttons above the cap are
  disabled with the reason. If the cap is later lowered below the saved size, buys use the cap and
  a warning shows.
- Every new buy = min(normal sizing, selected size, cap). Journal rows store `tradeSizeUsd`.
- Phone: three big buttons + the active size in large text. Switching to $60 in LIVE asks to confirm first.
