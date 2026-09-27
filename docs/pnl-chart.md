# PnL tab live chart (open position)

When the paper bot has an open position, the Android **PnL** tab embeds a live chart using the position `mint` from `GET /portfolio` (`portfolio.openPositions[].mint` / `.symbol`).

## What works in Capacitor WebView

| Source | URL | In-app iframe? | Notes |
|--------|-----|----------------|-------|
| **DexScreener embed** | `https://dexscreener.com/solana/{mint}?embed=1&theme=dark&trades=0&info=0` | **Yes** | No `X-Frame-Options` / `frame-ancestors` block observed. Default embed in the app. |
| **Pump.fun coin page** | `https://pump.fun/coin/{mint}` | **No** | Sends `X-Frame-Options: SAMEORIGIN` and CSP `frame-ancestors 'self'`. Use the **Open on Pump.fun** external link (`target=_blank`) instead. |

There is no known public Pump.fun chart-only embed that allows third-party framing. Prefer DexScreener for in-app charts; keep Pump.fun as an external browser link.

## Portfolio API

`GET /portfolio` already returns full `Position` objects on `openPositions`, including `mint` and `symbol`. The mobile UI builds chart URLs from those fields (no extra endpoint required).
