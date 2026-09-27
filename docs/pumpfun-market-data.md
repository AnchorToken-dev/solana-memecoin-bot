# Pump.fun paper market data

`MARKET_DATA_SOURCE=pumpfun` feeds the **paper** momentum scanner with
Pump.fun-related candidates. Fills still go through `PaperBroker` only.
Live Pump.fun / Jupiter swaps remain stubbed — no wallet keys.

## What is used under the hood

### Primary — unofficial Pump.fun frontend API (v3)

Base (override with `PUMPFUN_API_BASE`):

```text
https://frontend-api-v3.pump.fun
```

| Method | URL | Purpose |
|--------|-----|---------|
| GET | `/coins?offset=0&limit=N&sort=last_trade_timestamp&order=DESC&includeNsfw=false` | “Hot” / recently traded bonding-curve + graduated listings |
| GET | `/coins?offset=0&limit=N&sort=created_timestamp&order=DESC&includeNsfw=false&complete=false` | Newest pre-graduation coins |
| GET | `/sol-price` | SOL/USD for reserve → liquidity USD |

These are the same host the pump.fun web UI has historically called. They are
**not** an official documented product API:

- Paths, auth, and Cloudflare rules can change without notice (403 / 530 / JWT).
- Community mirrors sometimes claim Bearer JWT is required; list + `sol-price`
  often still answer anonymously with browser-like `Origin` / `Referer`.
- **Do not** rely on this for production live trading.

Suggested poll cadence: keep `POLL_INTERVAL_MS≥15000` to stay polite.

### Field mapping → `TokenSnapshot`

| Snapshot field | Source |
|----------------|--------|
| `mint` / `symbol` / `name` | coin payload |
| `priceUsd` | `usd_market_cap ÷ (total_supply / 10^base_decimals)` |
| `liquidityUsd` | `(real_sol_reserves \|\| virtual_sol_reserves) / 1e9 × solPrice` |
| `changeWindowPct` | DexScreener `priceChange.m5` when enrich works; else in-memory price ring over `MOMENTUM_WINDOW_MINUTES` |
| `volumeWindowUsd` / `volume24hUsd` / `volumeAvgUsd` | DexScreener pair enrich (`volume.m5` / `h24`; avg ≈ h24/288). List API has **no** short-window volume. |
| `createdAt` | `created_timestamp` (normalized to epoch ms); used by `MIN_AGE_MINUTES` age filter |

### Optional enrich — DexScreener (default on)

```text
GET https://api.dexscreener.com/latest/dex/tokens/{mint}
```

Prefers pools with `dexId` ∈ `{pumpfun, pumpswap}`. Disable with
`PUMPFUN_DEXSCREENER_ENRICH=false`.

Public DexScreener REST is rate-limited (order of tens–hundreds req/min;
429s happen). Enrich uses a small inter-call delay.

### Labeled fallback — DexScreener pump filter (default on)

If the frontend API errors or returns zero coins:

```text
GET https://api.dexscreener.com/latest/dex/search?q=pumpfun
GET https://api.dexscreener.com/latest/dex/search?q=pumpswap
```

Keep Solana pairs whose `dexId` is `pumpfun` or `pumpswap`. Logs clearly
label this as **fallback, not Pump.fun frontend**. Disable with
`PUMPFUN_DEXSCREENER_FALLBACK=false`.

## Env knobs

```bash
MARKET_DATA_SOURCE=pumpfun
# or: CONFIG_FILE=config/pumpfun-preset.json
# PUMPFUN_API_BASE=https://frontend-api-v3.pump.fun
# PUMPFUN_DEXSCREENER_ENRICH=true
# PUMPFUN_DEXSCREENER_FALLBACK=true
# Looser paper gates (see config/pumpfun-preset.json):
# MOMENTUM_MIN_PCT=5 MIN_LIQUIDITY_USD=5000 MIN_VOLUME_24H_USD=8000
# MIN_AGE_MINUTES=3 TRAIL_ACTIVATE_PCT=10 TRAIL_DISTANCE_PCT=7
# MAX_HOLD_MINUTES=20 DAILY_LOSS_USD=5
```

## Paper vs live

- Paper: `PAPER_MODE=true` (default) — simulated slippage/fees only.
- Live Pump.fun curve buys / Jupiter swaps: **still stubbed**. Do not set
  `PAPER_MODE=false`; do not paste wallet keys.
