# Solana Memecoin Momentum Bot (Paper First)

Paper / simulation trading bot for **Solana memecoins** (DEX-style).  
Style: **momentum** — buy short-window strength, manage with a **trailing take-profit** and a **hard stop**.

> **Not financial advice. No profit is promised.** Paper results do not predict live results. Memecoins can go to zero. This repo ships **dry-run by default** and does **not** require (or accept) live wallet private keys to run.

The **engine stays on a laptop/server**. The optional **Android APK** is only a control UI (status, start/stop paper runner, bankroll/PnL, trades, API URL). No private keys in the app.

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
| Control API | `0.0.0.0:8787` | `API_HOST` / `API_PORT` |

### Strategy (readable for tweaking)

1. **Entry** — token passes liquidity + 24h volume floors, short-window `%` change ≥ `MOMENTUM_MIN_PCT`, and window volume ≥ `VOLUME_SPIKE_MULT ×` recent average. Strongest signal wins; only one open trade.
2. **Hard stop** — if mark ≤ entry × `(1 - STOP_LOSS_PCT/100)`, sell.
3. **Trailing TP** — after unrealized gain ≥ `TRAIL_ACTIVATE_PCT`, arm a trail; sell if mark ≤ high-water × `(1 - TRAIL_DISTANCE_PCT/100)`.

## Quick start (paper mode, Linux)

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

### Control API (for the phone UI)

```bash
npm run api
# → http://127.0.0.1:8787  (runner starts STOPPED)
```

| Method | Path | Notes |
|--------|------|--------|
| GET | `/health` | Liveness |
| GET | `/status` | Runner state, cycle, errors |
| POST | `/runner/start` | **PAPER_MODE only** |
| POST | `/runner/stop` | Stop loop |
| GET | `/portfolio` | Bankroll / cash / equity / PnL / positions |
| GET | `/config` | Public config (no secrets) |
| GET | `/trades?limit=50` | Recent fills |

CORS is open for local mobile / LAN browsers. Writes that start trading refuse unless `PAPER_MODE=true`. Live trading stays stubbed.

Other scripts:

```bash
npm run paper      # explicit PAPER_MODE=true CLI loop
npm run api        # HTTP control API
npm test           # risk unit tests (max 1 trade, -10% stop)
npm run typecheck
npm run build
```

Ledger output (under `data/`):

- `trades.json` — full fill records  
- `trades.csv` — spreadsheet-friendly log  
- Cash / positions / PnL printed each exit and at shutdown  

## Android APK (Capacitor control UI)

Location: `mobile/` — Vite + Capacitor Android shell. **No wallet / no private keys.** Paper control only.

### How the phone talks to the paper bot

1. On the **Linux laptop**, in the repo root: `npm install && npm run api` (listens on `0.0.0.0:8787` by default).
2. On the **phone app** → **Settings** → set API base URL:
   - **USB debugging / emulator:**  
     `adb reverse tcp:8787 tcp:8787`  
     then API URL `http://127.0.0.1:8787`
   - **Same Wi‑Fi LAN:**  
     find laptop IP (`ip -4 addr` or `hostname -I`)  
     then API URL `http://<laptop-lan-ip>:8787`  
     (allow port 8787 in the laptop firewall if needed)
3. **Status** / **Run** / **PnL** / **Trades** tabs hit that API. Start paper bot from **Run** (server must have `PAPER_MODE=true`).

### Build a debug APK on Linux

**Prereqs (Debian/Ubuntu-ish):**

- Node.js 18+ (`node -v`)
- JDK 21 (or 17): `sudo apt install openjdk-21-jdk`
- Android SDK command-line tools **or** Android Studio

**Option A — Android Studio (simplest GUI)**

```bash
cd solana-memecoin-bot/mobile
npm install
npm run build
npx cap sync android
npx cap open android
# In Android Studio: Build → Build Bundle(s) / APK(s) → Build APK(s)
# Debug APK: android/app/build/outputs/apk/debug/app-debug.apk
```

**Option B — CLI (SDK + Gradle)**

```bash
# Example SDK location
export ANDROID_HOME="$HOME/Android/Sdk"
export PATH="$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools"

# (First-time SDK) install platform-tools + a platform + build-tools via sdkmanager
# sdkmanager "platform-tools" "platforms;android-35" "build-tools;35.0.0"

cd solana-memecoin-bot/mobile
npm install
npm run build
npx cap sync android
cd android
./gradlew assembleDebug
```

Debug APK path:

```text
mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Install on a device:

```bash
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
# or copy the APK to the phone and open it (enable install from unknown sources)
```

Release AAB (Play-style), when you are ready:

```bash
cd mobile/android
./gradlew bundleRelease
# requires a signing config — not set up in this starter; use debug for paper UI
```

> **Blocker note:** building the APK needs JDK + Android SDK on the machine that runs Gradle. This repo already includes the `mobile/android` Capacitor project; CI/dev boxes without the SDK can still develop the web UI (`cd mobile && npm run dev`) and the Node engine.

## What this is NOT

- **Not** a guaranteed 5× (or any) return system  
- **Not** live trading out of the box  
- **Not** MEV-aware, rug-proof, or tax software  
- **Not** a place to paste private keys (`.gitignore` blocks key/wallet files)  
- **Not** an on-phone trading engine — the APK is a remote control for the paper server  

## Project layout

```
src/
  config.ts           # env + config/default.json
  market/data.ts      # mock + DexScreener (public, no key)
  strategy/momentum.ts
  risk/manager.ts     # sizing + max trades + stop helper
  broker/paper.ts     # sim fills (slippage/fees); live stub throws
  ledger/ledger.ts    # cash, positions, JSON/CSV
  engine/botEngine.ts # start/stop controllable runner
  api/server.ts       # Express control API (CORS for mobile)
  runner/loop.ts      # thin CLI wrapper around BotEngine
  index.ts            # CLI (`npm start`) or API (`npm run api`)
mobile/               # Capacitor Android control UI
  src/                # Status, Run, PnL, Trades, Settings
  android/            # Gradle project (assembleDebug → APK)
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

Live mode **refuses to start** (`assertPaperOrStubLive`). API `POST /runner/start` also refuses unless `PAPER_MODE=true`. When you are ready *after* paper validation:

1. Keep keys **out of git** — load a keypair path from env (`LIVE_WALLET_KEYPAIR_PATH`), never commit it.  
2. Replace `liveSwapStub` in `src/broker/paper.ts` with:
   - **Jupiter** quote + swap API, or  
   - **Raydium** SDK swap helpers  
3. Add an RPC URL (`LIVE_RPC_URL`), confirm slippage/fee reality, and gate with an explicit `PAPER_MODE=false` + second confirmation flag.  
4. Start tiny; assume fills, latency, and rugs are worse than paper.

Until that exists, `PAPER_MODE=true` is the only supported path. The APK must not (and does not) require a wallet for paper.

## Risk reminder

`$20` bankroll, **one** position, **10%** hard stop still means you can lose a large share of the account on a single bad tape. Paper first. Tweak specs in `.env` / `config/default.json` — code is kept readable on purpose.

## License

MIT
