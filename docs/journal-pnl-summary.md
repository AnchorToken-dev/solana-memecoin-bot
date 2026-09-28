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
      { "period": "daily", "label": "Today", "pnlUsd": 0, "pnlQuote": 0, "tradeCount": 0, "winCount": 0, "lossCount": 0, "quoteBasis": "usd_only" }
    ]
  }
}
```

Existing CA / DexScreener / notes / clear behavior is unchanged. PATCH note and DELETE clear still work as before.
