# Solana Memecoin Momentum Bot (Paper First)

Paper / simulation trading bot for **Solana memecoins** (DEX-style).  
Style: **momentum** — buy short-window strength, manage with a **trailing take-profit** and a **hard stop**.

> **Not financial advice. No profit is promised.** Paper results do not predict live results. Memecoins can go to zero. This repo ships **dry-run by default** and does **not** require (or accept) live wallet private keys to run.

## Specs (locked defaults)

| Setting | Default | Env |
|--------|---------|-----|
| Mode | Paper / simulation | `PAPER_MODE=true` |
| Bankroll | `$20` | `BANKROLL_USD` |
| Max open trades | `1` | `MAX_OPEN_TRADES` |
| Hard stop | `10%` | `STOP_LOSS_PCT` |
| Position size | `95%` of cash | `POSITION_SIZE_PCT` |
| Momentum window | `5` minutes | `MOMENTUM_WINDOW_MINUTES` |
| Min window change | `+8%` | `MOMENTUM_MIN_PCT` |
| Volume spike | `2.0×` avg | `VOLUME_SPIKE_MULT` |
| Min liquidity | `$15,000` | `MIN_LIQUIDITY_USD` |
| Min 24h volume | `$25,000` | `MIN_VOLUME_24H_USD` |
| Trail activate | `+15%` from entry | `TRAIL_ACTIVATE_PCT` |
| Trail distance | `5%` from HWM | `TRAIL_DISTANCE_PCT` |
| Slippage (sim) | `50` bps | `SLIPPAGE_BPS` |
| Fee (sim) | `30` bps | `FEE_BPS` |
| Market data | `mock` | `MARKET_DATA_SOURCE=mock\|dexscreener` |

### Strategy (readable for tweaking)

1. **Entry** — token passes liquidity + 24h volume floors, short-window `%` change ≥ `MOMENTUM_MIN_PCT`, and window volume ≥ `VOLUME_SPIKE_MULT ×` recent average. Strongest signal wins; only one open trade.
2. **Hard stop** — if mark ≤ entry × `(1 - STOP_LOSS_PCT/100)`, sell.
3. **Trailing TP** — after unrealized gain ≥ `TRAIL_ACTIVATE_PCT`, arm a trail; sell if mark ≤ high-water × `(1 - TRAIL_DISTANCE_PCT/100)`.

## Quick start (paper mode)

```bash
git clone <this-repo>
cd solana-memecoin-bot
npm install
cp .env.example .env   # optional; defaults already paper-safe
npm start
```

Short demo (stops after N poll cycles):

```bash
MAX_CYCLES=12 POLL_INTERVAL_MS=500 npm start
```

Use public DexScreener data instead of the mock feed:

```bash
MARKET_DATA_SOURCE=dexscreener MAX_CYCLES=5 npm start
```

Other scripts:

```bash
npm run paper      # explicit PAPER_MODE=true
npm test           # risk unit tests (max 1 trade, -10% stop)
npm run typecheck
npm run build
```

Ledger output (under `data/`):

- `trades.json` — full fill records  
- `trades.csv` — spreadsheet-friendly log  
- Cash / positions / PnL printed each exit and at shutdown  

## What this is NOT

- **Not** a guaranteed 5× (or any) return system  
- **Not** live trading out of the box  
- **Not** MEV-aware, rug-proof, or tax software  
- **Not** a place to paste private keys (`.gitignore` blocks key/wallet files)

## Project layout

```
src/
  config.ts           # env + config/default.json
  market/data.ts      # mock + DexScreener (public, no key)
  strategy/momentum.ts
  risk/manager.ts     # sizing + max trades + stop helper
  broker/paper.ts     # sim fills (slippage/fees); live stub throws
  ledger/ledger.ts    # cash, positions, JSON/CSV
  runner/loop.ts      # poll → manage exits → maybe enter
  index.ts            # CLI entry
tests/risk.test.ts
config/default.json
.env.example
```

## Data sources

| Source | Key? | Notes |
|--------|------|-------|
| **mock** (default) | No | Deterministic fixtures for offline / CI |
| **DexScreener** | No | Public REST; rate-limited; best-effort |
| Birdeye / Jupiter | Optional later | Stub + document only — set `BIRDEYE_API_KEY` / `JUPITER_API_KEY` in `.env` when you wire them; not used in paper path |

## Live wiring (stub only)

Live mode **refuses to start** (`assertPaperOrStubLive`). When you are ready *after* paper validation:

1. Keep keys **out of git** — load a keypair path from env (`LIVE_WALLET_KEYPAIR_PATH`), never commit it.  
2. Replace `liveSwapStub` in `src/broker/paper.ts` with:
   - **Jupiter** quote + swap API, or  
   - **Raydium** SDK swap helpers  
3. Add an RPC URL (`LIVE_RPC_URL`), confirm slippage/fee reality, and gate with an explicit `PAPER_MODE=false` + second confirmation flag.  
4. Start tiny; assume fills, latency, and rugs are worse than paper.

Until that exists, `PAPER_MODE=true` is the only supported path.

## Risk reminder

`$20` bankroll, **one** position, **10%** hard stop still means you can lose a large share of the account on a single bad tape. Paper first. Tweak specs in `.env` / `config/default.json` — code is kept readable on purpose.

## License

MIT
