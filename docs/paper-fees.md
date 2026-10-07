# Paper trading costs (realistic model)

Paper P&L used to assume about **$0.24** of costs per $15 round trip (a flat
0.3% "fee" plus 0.5% slippage on each side). A real $15 round trip through
PumpPortal on a pump.fun coin costs about **$0.74 in fees (~5%)** before
slippage. Paper now charges the real, itemised costs by default so paper
results are a fair preview of live.

## What gets charged

| Cost | When | Default | Env |
|---|---|---|---|
| pump.fun bonding-curve fee | every buy and sell | **1.25%** | `PAPER_PUMP_FEE_BPS=125` |
| PumpSwap fee (graduated coins) | every buy and sell | official market-cap tiers, **1.25% → 0.30%** | `PAPER_PUMPSWAP_FEE_BPS=` (blank = tiers, or a flat bps) |
| PumpPortal Local API fee | every buy and sell | **0.5%** | `PAPER_PUMPPORTAL_FEE_BPS=50` (0 = off) |
| Solana base fee | every transaction | **0.000005 SOL** (5,000 lamports) | `PAPER_BASE_FEE_SOL` |
| Priority fee | every transaction | **0.0002 SOL** (`LIVE_PRIORITY_FEE_SOL` default) | `PAPER_PRIORITY_FEE_SOL` (falls back to `LIVE_PRIORITY_FEE_SOL`) |
| Token-account rent | first buy of each coin | **0.00148844 SOL** (live mainnet value) | `PAPER_TOKEN_ACCOUNT_RENT_SOL` |
| Slippage | every buy and sell (price only) | 25 bps + trade size ÷ pool liquidity, max 300 bps; 50 bps flat if liquidity unknown | `PAPER_SLIPPAGE_MODEL`, `PAPER_SLIPPAGE_BASE_BPS`, `PAPER_SLIPPAGE_MAX_BPS`, `SLIPPAGE_BPS` |

* **Rent is a cost**, not a deposit, because the bot's sells don't close the
  token account, so the rent is never refunded.
* **Venue:** the bot tells curve from PumpSwap by Pump.fun's `complete` flag
  (or DexScreener's `pumpswap`/`pumpfun` dex id). Unknown → `PAPER_DEFAULT_VENUE`
  (bonding_curve). PumpSwap tiers use market cap in SOL = price × 1B ÷ SOL/USD.
* **SOL-priced costs** use the bot's live SOL/USD (Pump.fun `/sol-price`, or
  `SOL_USD_RATE`), else `PAPER_SOL_USD_FALLBACK` (150).
* **No double-counting:** slippage only moves the fill price. It is reported
  separately (`slippageUsd`) and never added to `feesUsd`. The realistic model
  *replaces* the old flat 50 bps slippage, it does not add to it.
* **Exit slippage** uses the liquidity seen at entry, scaled by √(price move)
  (how the SOL side of a constant-product pool moves).

## Where it shows up

* `pnlUsd` in the journal and `realizedPnlUsd` in the ledger are **net of every
  cost** above.
* Each paper fill in `data/trades.json` has `feesUsd`, `slippageUsd` and a
  `feeBreakdown` (venue fee, PumpPortal, network, rent, slippage, SOL/USD used).
* Each journal row (realistic paper only) adds `feesUsd` (buy + sell),
  `slippageUsd`, and `feeBreakdown: { entry, exit }`.

## Example: $15 trade, SOL ≈ $116, bonding curve

| | Buy | Sell | Round trip |
|---|---|---|---|
| pump.fun 1.25% | $0.188 | ~$0.19 | ~$0.38 |
| PumpPortal 0.5% | $0.075 | ~$0.075 | ~$0.15 |
| Base + priority fee | $0.024 | $0.024 | $0.048 |
| Token-account rent | $0.173 | — | $0.173 |
| **Fees** | | | **≈ $0.74** |
| Slippage ($5k–$10k pool) | | | ≈ $0.12–0.16 |

Versus the old model's ≈ $0.24, that is roughly **$0.55–0.90 less P&L per
trade** (about $0.65–0.70 typical; more on thin pools and on winners, since
percentage fees are charged on a bigger sale).

## LIVE DRY-RUN uses this model too

Practice mode (`LIVE_DRY_RUN=true`) estimates its costs with exactly this model
(rent on each buy, venue fee tier, size-aware slippage, priority fee from
`LIVE_PRIORITY_FEE_SOL`). `PAPER_FEE_MODEL=legacy` puts dry-run back on its old
estimate too. Real live trades use the actual wallet SOL delta. See
[live-trading.md](live-trading.md#dry-run-costs-same-model-as-paper).

## Switches

* `PAPER_FEE_MODEL=legacy` — old flat model (`FEE_BPS` + `SLIPPAGE_BPS`), for
  comparing against old results. `FEE_BPS` is ignored (with a warning) under
  the realistic model.
* `PAPER_PUMPPORTAL_FEE_BPS=0` — if you'd trade without PumpPortal.
* `PAPER_SLIPPAGE_MODEL=flat` — `SLIPPAGE_BPS` on every trade.

## Sources (checked 2026-10-07)

* pump.fun fees — https://pump.fun/docs/fees (bonding curve 1.25% total:
  0.30% creator + 0.95% protocol; canonical PumpSwap tiers by market cap in SOL,
  1.25% below 420 SOL down to 0.30% at 98,240 SOL+)
* pump.fun bonding curve — https://pump.fun/docs/bonding-curve
* PumpPortal fees — https://pumpportal.fun/fees (Local Transaction API: 0.5%
  per trade, not including Solana network or pump.fun fees)
* Solana fees — https://solana.com/docs/core/fees (base fee 5,000 lamports per
  signature; priority fee set per transaction)
* Token account rent — `getMinimumBalanceForRentExemption(165)` on mainnet
  returned **1,488,440 lamports (0.00148844 SOL)** on 2026-10-07. Solana is
  cutting rent in steps under SIMD-0437 (was 0.00203928 SOL before Sept 2026;
  planned to fall to ~0.0002 SOL after steps 3–5):
  https://solana.com/upgrades/reduced-rent ,
  https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0437-incremental-rent-reduction.md
  — lower `PAPER_TOKEN_ACCOUNT_RENT_SOL` when those land.
