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
4. dry-run stops here (costs are **estimated** — see "Dry-run costs" below); live calls `sendTransaction` over `SOLANA_RPC_URL`,
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

## Dry-run costs (same model as paper)

Nothing is sent in dry-run, so its P&L is an estimate. It uses the **same
itemised cost model as paper mode** (`src/broker/paperFees.ts`,
[paper-fees.md](paper-fees.md)) so practice results are as honest as paper:

- pump.fun bonding-curve fee 1.25% per side, or the PumpSwap market-cap tier for
  graduated coins (same `complete` / dexId detection as paper),
- PumpPortal 0.5% per side,
- network base fee + the **priority fee the tx was actually built with**
  (`LIVE_PRIORITY_FEE_SOL`),
- token-account rent (0.00148844 SOL) on each buy,
- size-aware slippage on the fill price (0.25% + size ÷ pool liquidity, max 3% per side;
  `SLIPPAGE_BPS` when liquidity is unknown).

Each dry-run buy/sell fill and journal row carries the same `feeBreakdown` as
paper. A flat $15 round trip costs ≈ $0.74 in fees + ≈ $0.09–0.16 slippage at
SOL ≈ $116 (the old dry-run estimate charged only ≈ $0.20). `PAPER_FEE_MODEL=legacy`
restores the old dry-run estimate (PumpPortal 0.5% + priority fee).

Entry price in dry-run is the all-in cost per token (trade size ÷ tokens), the
same way real live computes it from the wallet delta, so take-profit / stop-loss
trigger the same way they would live.

**Real live mode is unaffected:** its P&L is the actual SOL that left / entered
the wallet. (Its `feesUsd` label is still network fee + 0.5%; the pump.fun fee
and slippage are inside the real SOL delta, just not itemised.)

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

Paper now charges these same costs by default (`PAPER_FEE_MODEL=realistic`,
see [paper-fees.md](paper-fees.md)), so paper and live should line up much more
closely. `PAPER_FEE_MODEL=legacy` restores the old flat 0.5% slippage + 0.3% fee
(about $0.24 per round trip) for comparison.

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

## Hard daily loss limit ($300, cannot be disabled)

- `HARD_DAILY_LOSS_CEILING_USD = 300` in `src/risk/hardDailyLoss.ts`. `HARD_DAILY_LOSS_USD` (env), `hardDailyLossUsd`
  (config file / runtime overlay / `PATCH /config`) and `LIVE_DAILY_LOSS_LIMIT_USD` can only **lower** it.
  Missing → 300. 0, negative, non-numeric, `off`/`false`, null and >300 → 300 with a warning (shown in `/status`).
  The effective limit is the lowest of these.
- Applies in **paper, dry-run and live**. Each mode keeps its own tally.
- Loss today = net realized P&L of closes since ET midnight + unrealized losses on open positions (last mark).
- When hit: new buys are blocked, exits keep running, a loud `/alerts` event fires and a `data/live-events.json` row
  is written. The lock is persisted in `data/hard-daily-loss.json` until the next ET midnight. `/runner/reset`,
  restarts, journal clear and raising the setting do not clear it. An unreadable lock file fails **closed** for the day.
- Shown in `/status.hardDailyLoss` and `/portfolio.hardDailyLoss` (limit, todayLossUsd, remainingUsd, locked,
  lockedUntil, warnings), and on the phone in large text.
- Paper's old session cap (`DAILY_LOSS_USD`, which stops the runner and is cleared by Reset) is unchanged
  and still separate.

## Vault sweep (LIVE only)

- `LIVE_VAULT_ADDRESS` = **public** address of a separate vault wallet. It must be valid base58, 32 bytes, not the
  bot wallet and not the system program. Invalid → live refuses to start. Unset → bookkeeping-only vault with a
  warning. It is read once at startup with no setter. `POST /vault/skim` and `POST /vault/sweep` ignore any
  address in the body. `/status.vaultSweep` shows it masked (`ABCD…WXYZ`).
- Skim in LIVE → the USD amount is converted to SOL at the current rate and queued. With `LIVE_VAULT_AUTO_SWEEP`
  (default true) it's sent right away; the phone's **Sweep vault now** (`POST /vault/sweep`) sends on demand.
- Plain SystemProgram transfer, built and signed locally, simulated, then sent and confirmed over HTTPS.
  It keeps `LIVE_MIN_SOL_RESERVE` + the fee in the bot wallet and skips totals below `LIVE_VAULT_MIN_SWEEP_SOL`.
- **No double-send:** the signed tx and its signature are saved as `pending` in `data/live/vault-sweeps.json`
  *before* sending. Retries and restarts look up that signature first and only rebroadcast the same bytes.
  A new tx is built only after the old one failed on-chain or its blockhash expired unseen.
  After `LIVE_VAULT_MAX_ATTEMPTS` failures sweeps pause, with a loud `/alerts` event; the owed SOL stays tracked.
  An unreadable state file pauses sweeps.
- Every sweep (confirmed / simulated / failed) is written to `data/live-events.json` with its signature.
- DRY-RUN: simulated only, never sent. PAPER: unchanged (bookkeeping vault, `/vault/return` still works;
  in live `/vault/return` stays refused).
