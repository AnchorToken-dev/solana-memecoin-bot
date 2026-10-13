# Soft-rug early warning (SOFT_RUG_MODE)

A small learned model that watches an **open** position and estimates the chance it will end as a loss tail (net result of -10% or worse, which is basically "will hit the stop"). When the score is high it can sell before the stop. Idea taken from AFKmoney/pumpfun-agent (`analysis/soft_rug.py`), rebuilt on data v2 really records.

## What it looks at
Only the position's own path, read the same way live and in training (`src/strategy/softRug.ts`):
seconds held, % from entry, % from the peak, % change over 3 s and 10 s, share of the last 10 reads that were down, pool-SOL change since entry and over 5 s.
No entry features: those showed no predictive power (REVIEW.md sections 10-11), and entry memory already covers them.

## Modes
| `SOFT_RUG_MODE` | Behaviour |
|---|---|
| `off` | nothing runs |
| `shadow` (**default**) | scores every open position; the first time the score reaches the threshold it writes a line to `<ledger>/softrug-shadow.jsonl`. **Never sells.** Needs `models/softrug-model.json`. |
| `exit` | sells with reason `early_soft_rug` when score >= `SOFT_RUG_THRESHOLD` after `SOFT_RUG_MIN_HOLD_S`. **Paper / dry-run only**: in live it is forced to shadow. |

Other settings: `SOFT_RUG_THRESHOLD` (0.6), `SOFT_RUG_MIN_HOLD_S` (3), `SOFT_RUG_MODEL` (`models/softrug-model.json`).
The score runs after the fixed early-exit rules (`EXIT_*`) and only on reads where the normal stop / take-profit did not fire. `early_soft_rug` counts as a loss for the re-entry cooldown.
`GET /status` shows `softRug { mode, configured, modelLoaded, threshold, scored, crossed, fired }`.

## Evidence so far (be skeptical)
Chronological hold-out on the Oct 9-12 tape: fit on the earliest 113 trades, replay on the latest 49 (loss-tail rate 55%).
- AUC 0.72 per read, 0.78 per trade (0.5 = coin flip).
- Selling at score >= 0.6: average change vs no rule **+1.35 points per trade, 95% range [-1.07, +3.76]**. At 0.4: +1.77 [-1.34, +4.88]. At 0.8 it never triggers.
- A plain tighter stop on the same trades: +0.84 [-1.51, +3.18] at 2%, less at wider stops. So the model looks a little better than just tightening the stop, but every range includes zero.
- The model leans mostly on "how far below entry is the price" (31 of 40 trees). That is the honest reason it can't be trusted yet: it may be a fancier stop.
- Sells in the replay are assumed to cost the same as the real sells (small approximation).
Conclusion: not proven. Shadow mode exists to gather new out-of-sample evidence at zero risk.

## Retrain / re-evaluate
```
npm run softrug:train -- data/paper/price-tape            # path of the price-tape folder (or one .jsonl)
npm run softrug:train -- <dir> --label -10 --no-write      # evaluate only
```
Prints the hold-out report first (with the plain-stop comparison), then fits on all trades and writes `models/softrug-model.json`.
The shipped model was trained on the Oct 9-12 tape (162 trades). Retrain only after a block of new trades; judge the hold-out range, not the training fit.

## Comparing shadow results
Each shadow line has the position id, symbol, time held, score, mark and features at the first crossing. With the tape (`price-tape/*.jsonl`) you can compute what selling at that mark would have done versus the real exit. Send `softrug-shadow.jsonl` back with `journal.json` and the tape.

## Limits
- Not for live sells. Live needs a proven paper result first.
- Needs on-chain marks (`SOLANA_RPC_URL`); positions without them are not scored.
- Sudden one-read crashes (bundled dumps) are not stopped by any exit rule; `EXIT_RESERVE_DROP_PCT` and the entry rug filter are the tools for those.
