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
