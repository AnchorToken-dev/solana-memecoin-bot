# Pre-buy rug filter (paper only)

Default **OFF**. Leave it off and the bot buys exactly like it does today.

This never sends a live trade. Paper mode stays the switch. The filter only decides whether to **skip a paper buy**.

## Turn it on

Set `RUG_FILTER_ENABLED=true` (or the Settings toggle) **and** set `SOLANA_RPC_URL` to a read-only Solana RPC.

- Filter **off**: no RPC calls from this filter.
- Filter **on** and RPC **not** set: that buy is skipped. Log reason: `rug_filter_no_rpc`. Prices are not invented.
- A failed RPC skips the buy (`rug_filter_rpc_error`) and does not crash the runner.
- `/status` and `/config` never print the RPC URL. They only say whether one is configured.

Momentum, sniper, poll interval, bankroll, and exit rules are unchanged.

## Checks that actually run

| Check | Reject reason | Default |
| --- | --- | --- |
| Mint freeze authority is set (cannot sell) | `mint_freeze_authority` | reject if set |
| Biggest holder who is not the pump bonding curve, as % of supply | `top_holder_concentration` | reject **above 30%** (`RUG_FILTER_MAX_TOP_HOLDER_PCT`) |
| Other transactions in the same slot as creation | `same_slot_snipe` | reject **above 3** (`RUG_FILTER_MAX_SAME_SLOT_BUYS`) |

The curve is ignored when the pump.fun payload already names `bonding_curve` / `associated_bonding_curve`, or when the holder account is owned by the pump.fun program. PumpSwap pool vaults are **not** identified.

If signature history is longer than 1,000, the creation slot is not guessed. That check is skipped and logged as `same_slot_snipe_truncated`. The other checks still run.

## Not implemented

These are **not** a silent pass. When the filter runs, the log names them:

- `dev_rug_history_not_implemented` — a coin may include `creator`, but this bot cannot see that wallet's older coins. No new API is called.
- `wash_volume_not_implemented` — the bot only has aggregate volume, not a list of individual trades.

## After you change this

Merging the code does not start the bot. Restart is a separate step.

## Graduated (PumpSwap) coins

Added after the 2026-10-09 TRUMPSI / BUNKER losses (both about -99% within
4 min / 31 s of our buy).

**What went wrong.** The old holder check only treated accounts owned by the
pump.fun *curve* program as "the curve". A graduated coin's liquidity sits in a
PumpSwap pool (owned by the PumpSwap program), so the pool's token vault was
counted as an ordinary wallet, and the only concentration rule was "one wallet
above 30%". At 06:48 TRUMPSI had a wallet above 30% (skipped). By 06:58 the
supply outside the pool (pool: 6.7% at 06:48, 5.4% at 06:58) was spread over
one 13.5% wallet plus ~600 bundled wallets of 0.044% each — the largest was
under 30%, so it passed. Nothing remembered the 06:48 fail.

On-chain replay of the dump windows: in both coins one wallet sold 134.7M
tokens (13.5% of supply) and ~600 bundled wallets sold 0.44M each (~27%);
BUNKER: 651 wallets sold 403M (40.3%) in 31 s. The pool held 53.85M (5.4%,
TRUMPSI) and 42.24M (4.2%, BUNKER) when we bought.

**Now**, for any coin whose canonical PumpSwap SOL pool exists on-chain (or the
scan says it graduated):

| Check | Default | Env |
| --- | --- | --- |
| Pool token vault share of supply | skip below 10% | `RUG_FILTER_GRAD_MIN_POOL_PCT` (0 = off) |
| Largest single wallet outside the pool | skip above 10% | `RUG_FILTER_GRAD_MAX_HOLDER_PCT` |
| Top-10 wallets outside the pool | skip above 35% | `RUG_FILTER_GRAD_MAX_TOP10_PCT` |

- Only the canonical pool's token vault is excluded (plus the incinerator and
  leftover pump.fun curve accounts). Other pools / program accounts count.
- Several token accounts of one wallet are summed.
- A wallet with 0 SOL (no account) is a wallet, not an RPC error.
- Fail closed: graduated but pool / vault / holders unreadable → skip.
- Holder accounts are read with `getMultipleAccounts` (2 requests instead of
  ~40), which also removes most `could not tell if X is the bonding curve`
  rpc errors.
- A failed verdict sticks to the mint for `RUG_FILTER_FAIL_COOLDOWN_MINUTES`
  (60). RPC errors stick 2 minutes and never shorten a real verdict.
  Concentration never passes on a partial read; `same_slot_snipe_truncated` is
  only about the creation-slot check (normal for older graduated coins).

**Tradeoff.** The pool share falls as price rises after graduation (~20% at
migration). On 52 active graduated pump coins (Oct 9, pump.fun lists, > $30k
cap): 3 fail the holder rules; with the pool floor at 10%, 11 pass (15% → 7,
5% → 20, off → 49). Both incident coins fail the 10% single-wallet rule on its
own, and the pool floor at 10%.
