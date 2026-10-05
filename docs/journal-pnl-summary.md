# Journal P&L summary (USD + quote asset)

Paper trade journal (`data/journal.json`) now exposes **Daily / Weekly / Monthly / Overall** realized P&L on `GET /journal`, shown at the top of the mobile **Journal** tab.

## Periods (timezone)

Calendar windows use **`America/New_York`** by default (`summary.timezone`):

| Period | Window |
|--------|--------|
| **Daily** | Local midnight → now |
| **Weekly** | **Monday** 00:00 local → now |
| **Monthly** | 1st of month 00:00 local → now |
| **Overall** | Earliest closed trade → now |

Only **closed** journal rows (realized exits) are counted. Session Reset does **not** clear the journal.

Each period also includes **`winPct`**: `winCount / (winCount + lossCount) * 100`. Breakeven closes (`pnlUsd === 0`) are in `tradeCount` but not in the percentage. When there are no decided closes, `winPct` is **`null`** (the Journal tab shows **—**, not 0%). The mobile UI displays that field; it does not recompute it.


## USD + quote asset (SOL)

Paper fills stay **USD-primary**. Each new close also stores:

- `quoteAsset` — default `SOL` (multi-chain later: same field, e.g. another ticker)
- `chainId` — default `solana` (DexScreener path uses this)
- `quoteUsdRate` — USD per 1 quote unit at fill time (SOL/USD)
- `sizeQuote` / `pnlQuote` — size and PnL in quote units
- `quoteBasis` — `recorded` \| `estimated` \| `usd_only`

**Rate sources (in order):**

1. Env `SOL_USD_RATE` or `QUOTE_USD_RATE`
2. Market `getQuoteUsdRate()` (Pump.fun `/sol-price`, DexScreener WSOL pair, mock `150`)
3. If still missing at fill → row is `usd_only` (USD only)

On list/summary, if some rows lack a fill-time rate, the API may pass a current estimate rate (`summary.estimateQuoteUsdRate`) and mark those rollup cells `estimated`.

## Multi-chain readiness

UI and API use **`quoteAsset`** / **`chainId`** rather than hard-coding “SOL” forever. Solana/SOL is the immediate path; Robinhood Chain (or others) can add assets by setting the same fields at close time.

## API

`GET /journal?limit=&offset=` response now includes:

```json
{
  "entries": [ /* … existing fields + quote* … */ ],
  "total": 0,
  "summary": {
    "timezone": "America/New_York",
    "quoteAsset": "SOL",
    "chainId": "solana",
    "estimateQuoteUsdRate": 150,
    "periods": [
      { "period": "daily", "label": "Today", "pnlUsd": 0, "pnlQuote": 0, "tradeCount": 0, "winCount": 0, "lossCount": 0, "winPct": null, "quoteBasis": "usd_only" }
    ]
  }
}
```

Existing CA / DexScreener / notes / clear behavior is unchanged. PATCH note and DELETE clear still work as before.


## Tendency charts

`GET /journal` also includes `charts`, computed from **every stored closed row** (pagination does not drop older closes). Nothing new is collected, and trading logic is unchanged.

The journal does not store account equity. `charts.equity` is cumulative realized P&L in USD (`equityBasis: "cumulative_realized_pnl_usd"`), oldest close first, with a flat 0 at the first open when that open is earlier than the close.

`charts.winRateByHour` is win rate by **close hour** in `charts.timezone` (default America/New_York). A win is `pnlUsd > 0`, a loss is `pnlUsd < 0`, same as period `winPct`. Hours with no decided closes are listed in `skippedHours` and are **not** given a 0% point. Breakeven closes are not in the rate.

`charts.winLoss` is average win and average loss in USD. A missing side is `null`, not `$0`. `payoffRatio` is average win divided by the absolute average loss, or `null` when either side is missing.

The mobile Journal tab draws these with canvas (equity line, average win vs loss bars) and large-type hour bars. No chart library was added. Seeing them on a running bot means pulling this code and restarting the API yourself, then rebuilding the phone UI if it is an installed APK. This change does not restart anything.
