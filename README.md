# Solana Memecoin Momentum Bot (Paper First)

Paper / simulation trading bot for **Solana memecoins** (DEX-style).  
Style: **momentum** — buy short-window strength, manage with a **trailing take-profit** and a **hard stop**.

> **Not financial advice. No profit is promised.** Paper results do not predict live results. Memecoins can go to zero. This repo ships **dry-run by default** and does **not** require (or accept) live wallet private keys to run.

The **engine stays on a laptop/server**. The optional **Android APK** is only a control UI (status, start/stop, PnL with exit-now/reset + live chart, **Check** research go/no-go, journal, **Settings** with Momentum/Sniper presets + paper knobs). No private keys in the app.

## Specs (locked defaults)

| Setting | Default | Env |
|--------|---------|-----|
| Mode | Paper / simulation | `PAPER_MODE=true` |
| Bankroll | `$20` | `BANKROLL_USD` |
| Max open trades | `1` | `MAX_OPEN_TRADES` |
| Hard stop | `10%` | `STOP_LOSS_PCT` |
| Hard take-profit | `+25%` from entry | `TAKE_PROFIT_PCT` (0 = off) |
| Max hold (time stop) | `20` minutes | `MAX_HOLD_MINUTES` (0 = off) |
| Daily loss cap | `$5` realized | `DAILY_LOSS_USD` (0 = off; stops runner) |
| Position size | `95%` of **tradable** cash | `POSITION_SIZE_PCT` |
| Max position (hard) | `$25` per open trade | `MAX_POSITION_USD` (0 = off; sticky) |
| Momentum window | `5` minutes | `MOMENTUM_WINDOW_MINUTES` |
| Min window change | `+8%` | `MOMENTUM_MIN_PCT` |
| Volume spike | `2.0×` avg | `VOLUME_SPIKE_MULT` |
| Min liquidity | `$15,000` | `MIN_LIQUIDITY_USD` |
| Min 24h volume | `$25,000` | `MIN_VOLUME_24H_USD` |
| Min age | `3` minutes | `MIN_AGE_MINUTES` (when `createdAt` known; 0 = off) |
| Trail activate | `+15%` from entry | `TRAIL_ACTIVATE_PCT` |
| Trail distance | `5%` from HWM | `TRAIL_DISTANCE_PCT` |
| Slippage (sim) | `50` bps | `SLIPPAGE_BPS` |
| Fee (sim) | `30` bps | `FEE_BPS` |
| Market data | `mock` | `MARKET_DATA_SOURCE=mock\|dexscreener\|pumpfun` |
| Config file | `config/default.json` | `CONFIG_FILE` (e.g. `config/pumpfun-preset.json`) |
| Control API | `0.0.0.0:8787` | `API_HOST` / `API_PORT` |

### Named presets (Momentum | Sniper)

**Session risk is sticky:** applying Momentum or Sniper changes strategy knobs (stops, trail, TP, poll, liq/vol, min age, hold) but **preserves** current `bankrollUsd`, `dailyLossUsd`, and `maxPositionUsd` (e.g. Mark’s $100 / $25 daily loss / $25 max position). Edit those via PATCH `/config` or Settings Save.

**Vault / skim:** move paper profit into `vaultUsd` (`POST /vault/skim`) so sizing cannot use it. **Vault survives `/runner/reset`** (like journal). See [docs/vault-max-position.md](docs/vault-max-position.md).


In-app / API presets for paper research. Apply via **Settings** tab or `POST /config/preset`. Requires the runner **stopped**. Values persist in `data/runtime-config.json` (overlay wins over file/env on restart).

| Knob | Momentum (Pump.fun research) | Sniper |
|------|------------------------------|--------|
| `STOP_LOSS_PCT` | **10** | **8** |
| `TAKE_PROFIT_PCT` | **25** | **15** |
| `TRAIL_ACTIVATE_PCT` | **10** | **8** |
| `TRAIL_DISTANCE_PCT` | **7** | **4** |
| `MAX_HOLD_MINUTES` | **20** | **10** |
| `POLL_INTERVAL_MS` | **15000** | **10000** |
| `MOMENTUM_MIN_PCT` | **5** | **4** |
| `VOLUME_SPIKE_MULT` | **2.0** | **1.5** |
| `MIN_LIQUIDITY_USD` | **5000** | **2000** |
| `MIN_VOLUME_24H_USD` | **8000** | **3000** |
| `MIN_AGE_MINUTES` | **3** | **0** (newer coins OK) |
| `BANKROLL_USD` | 20 (sticky — not applied) | 20 (sticky) |
| `DAILY_LOSS_USD` | 5 (sticky) | 5 (sticky) |
| `MAX_POSITION_USD` | 25 (sticky) | 25 (sticky) |
| `POSITION_SIZE_PCT` | 0.95 | 0.95 |

Presets never change `PAPER_MODE`, `MARKET_DATA_SOURCE`, or ledger/wallet paths. PATCH `/config` rejects those live-dangerous fields.

### Strategy (readable for tweaking)

1. **Entry** — skip too-new coins when `createdAt` is known (`MIN_AGE_MINUTES`); then liquidity + 24h volume floors, short-window `%` change ≥ `MOMENTUM_MIN_PCT`, and window volume ≥ `VOLUME_SPIKE_MULT ×` recent average. Skip/reject reasons are logged (`too_new`, `low_liquidity`, `no_momentum`, …). Strongest signal wins; only one open trade.
2. **Hard stop** — if mark ≤ entry × `(1 - STOP_LOSS_PCT/100)`, sell (`stop_loss`).
3. **Hard take-profit** — if unrealized gain ≥ `TAKE_PROFIT_PCT` (default `25`), sell (`take_profit`). `0` disables. Works alongside the trailing TP.
4. **Time stop** — if held ≥ `MAX_HOLD_MINUTES`, sell (`time_stop`).
5. **Trailing TP** — after unrealized gain ≥ `TRAIL_ACTIVATE_PCT`, arm a trail; sell if mark ≤ high-water × `(1 - TRAIL_DISTANCE_PCT/100)` (`trailing_take_profit`).
6. **Manual exit** — `POST /runner/exit` (or `/position/exit`) / app **Exit now** (PnL tab) flattens the open paper position at the current mark (`manual_exit`).
7. **Daily loss cap** — when session realized PnL ≤ `−DAILY_LOSS_USD`, the runner stops (no new paper entries). **Start does not clear the ledger** — use `POST /runner/reset` (or Start with `?reset=1`) / the app **Reset** button on the **PnL** tab to restore `BANKROLL_USD` cash and unlock another session.
8. **Vault skim** — `POST /vault/skim` locks cash into `vaultUsd` (excluded from sizing). Survives Reset. Optional `POST /vault/return`.
9. **Max position** — entry notional ≤ `MAX_POSITION_USD` (default `$25`) in addition to `POSITION_SIZE_PCT` × tradable cash.

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

Paper-trade against **Pump.fun-style** listings (unofficial frontend API + DexScreener enrich/fallback). Fills stay simulated.

Looser paper preset (copy or point `CONFIG_FILE` at it):

```bash
# Option A — preset file (recommended)
cp config/pumpfun-preset.json config/default.json   # or:
CONFIG_FILE=config/pumpfun-preset.json MARKET_DATA_SOURCE=pumpfun npm start

# Option B — env (same numbers as the preset)
MARKET_DATA_SOURCE=pumpfun PAPER_MODE=true \
  MOMENTUM_MIN_PCT=5 MIN_LIQUIDITY_USD=5000 MIN_VOLUME_24H_USD=8000 \
  MIN_AGE_MINUTES=3 TRAIL_ACTIVATE_PCT=10 TRAIL_DISTANCE_PCT=7 \
  MAX_HOLD_MINUTES=20 DAILY_LOSS_USD=5 MAX_CYCLES=5 npm start

# Control API:
CONFIG_FILE=config/pumpfun-preset.json npm run api
```

Preset values: `MIN_LIQUIDITY_USD=5000`, `MIN_VOLUME_24H_USD=8000`, `MOMENTUM_MIN_PCT=5`, `MIN_AGE_MINUTES=3`, `TRAIL_ACTIVATE_PCT=10`, `TRAIL_DISTANCE_PCT=7`, `MAX_HOLD_MINUTES=20`, `DAILY_LOSS_USD=5`.

See [docs/pumpfun-market-data.md](docs/pumpfun-market-data.md) for exact URLs, field mapping, and rate-limit / fragility notes.

### Control API (for the phone UI)

```bash
npm run api
# → http://127.0.0.1:8787  (runner starts STOPPED)
```

| Method | Path | Notes |
|--------|------|--------|
| GET | `/health` | Liveness |
| GET | `/status` | Runner state, cycle, `stopReason`, errors |
| POST | `/runner/start` | **PAPER_MODE only**. Optional `?reset=1` or JSON `{ "reset": true }` clears the paper session first |
| POST | `/runner/stop` | Stop loop |
| POST | `/runner/reset` | **PAPER_MODE only**: stop if running, rebuild ledger to `BANKROLL_USD`, clear `stopReason` / cycles, empty trades. **Vault is kept.** Response includes `status` + `portfolio` |
| GET | `/portfolio` | Bankroll / tradable cash / vault / equity / PnL / positions (`openPositions[].mint` + `.symbol`); also top-level `vaultUsd`, `tradableCashUsd`, `maxPositionUsd` |
| POST | `/vault/skim` | **PAPER_MODE**: `{ "amountUsd" }` or `{ "percentOfProfit" }` — lock cash out of sizing |
| POST | `/vault/return` | **PAPER_MODE**: `{ "amountUsd" }` — vault → tradable |
| GET | `/config` | Public config + `activePreset` + `availablePresets` (no secrets) |
| PATCH / PUT | `/config` | **PAPER_MODE only**: update paper knobs (bankroll, max position, stops, trail, TP, momentum filters, min age, max hold, daily loss, poll). Persists `data/runtime-config.json`. **409** if runner running — stop first. Rejects `paperMode` / wallet / live fields |
| POST | `/config/preset` | Body `{ "preset": "momentum" \| "sniper" }` — apply named preset + persist. **409** if runner running |
| GET | `/trades?limit=50` | Recent fills (session ledger; cleared by Reset) |
| GET | `/journal?limit=&offset=` | **Trade journal** — closed paper trades newest first (survives Reset) |
| PATCH | `/journal/:id` | Body `{ "note": "…" }` — edit learning note |
| DELETE | `/journal` | Explicit journal clear only (Reset does **not** clear journal) |
| GET | `/alerts?since=` | Session events for phone local notifications (start/stop/open/close/daily loss) |
| GET | `/checklist/template` | Default research checklist rows (pass/fail/skip) |
| GET | `/checklist?limit=&offset=&mint=` | Saved checklists newest first (`data/checklists.json`, survives Reset) |
| GET | `/checklist/:id` | One checklist by id |
| POST | `/checklist` | Create checklist (`mint`, items, thesis, invalidation) → computes **GO / NO-GO / INCOMPLETE** |
| PATCH | `/checklist/:id` | Update checklist (recomputes verdict) |
| DELETE | `/checklist` | Explicit clear of all checklists |


**Research checklist (Check tab):** Mark fills a human go/no-go form (age, liq, volume realism, holders, mint/freeze, clone name, size, thesis, invalidation) before sizing. Verdict is **GO** only when all required rows pass (optional rows may skip), thesis + invalidation are non-empty, and nothing failed. Persists in `data/checklists.json` (survives Reset). **Advisory by default** — does not block the paper bot. Optional Settings toggle **Require GO before entry** (`requireChecklistGo`, default off) makes the engine skip entries without a GO checklist for that mint.

**Session alerts:** Android app Settings toggle (default on) polls `/alerts` and fires Capacitor Local Notifications while the app process is alive. Grant notification permission on first Start or via Settings.

CORS is open for local mobile / LAN browsers. Writes that start trading refuse unless `PAPER_MODE=true`. Live trading stays stubbed.

**After a `daily_loss_cap` stop:** calling Start alone leaves realized PnL in the ledger, so the runner exits again on the next cycle. Hit **Reset** on the Android **PnL** tab (confirm dialog) or `POST /runner/reset` first. Reset clears the session ledger but **keeps** `data/journal.json` (learning history) and **`data/vault.json`** (skimmed funds).

Other scripts:

```bash
npm run paper      # explicit PAPER_MODE=true CLI loop
npm run api        # HTTP control API
npm test           # risk unit tests (max 1 trade, -10% stop)
npm run typecheck
npm run build
```

Ledger output (under `data/`):

- `trades.json` — full fill records (session; cleared by Reset)  
- `trades.csv` — spreadsheet-friendly log  
- `journal.json` — append-only closed-trade journal + notes (survives Reset)  
- `vault.json` — skimmed / vaulted USD (survives Reset; not used for sizing)  
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
3. **Status** / **Run** / **PnL** / **Check** / **Journal** / **Settings** tabs hit that API. **Start / Stop** on **Run**; **Exit now** / **Reset** / **Skim $ · Skim % · Return** on **PnL**; **Momentum | Sniper** + editable paper knobs (incl. sticky **Max position USD**) on **Settings** (stop runner before applying). Server must have `PAPER_MODE=true`. Reset clears the ledger and any `stopReason` (e.g. daily-loss lock) but **keeps the vault**. With an open position, **PnL** embeds a **DexScreener** live chart (`mint` from `/portfolio`); Pump.fun blocks iframes — use **Open on Pump.fun**. See `docs/pnl-chart.md` and `docs/vault-max-position.md`.

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
  market/data.ts      # mock + DexScreener + Pump.fun factory
  market/pumpfun.ts   # Pump.fun frontend API (paper) + Dex fallback
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
tests/*.test.ts
docs/pumpfun-market-data.md
docs/pnl-chart.md      # PnL live chart: DexScreener embed; Pump.fun iframe blocked
config/default.json
config/pumpfun-preset.json
.env.example
```

## Data sources

| Source | Key? | Notes |
|--------|------|-------|
| **mock** (default) | No | Deterministic fixtures for offline / CI |
| **DexScreener** | No | Public REST; rate-limited; best-effort |
| **pumpfun** | No | Unofficial `frontend-api-v3.pump.fun` coin lists + `sol-price`; optional DexScreener enrich (`pumpfun`/`pumpswap` pools) and labeled DexScreener search fallback. **Paper fills only.** May break without notice. Details: [docs/pumpfun-market-data.md](docs/pumpfun-market-data.md) |
| Birdeye / Jupiter | Optional later | Stub + document only — set `BIRDEYE_API_KEY` / `JUPITER_API_KEY` in `.env` when you wire them; not used in paper path |

### Pump.fun paper mode (what runs under the hood)

1. **Primary:** `GET https://frontend-api-v3.pump.fun/coins?...` (hot by `last_trade_timestamp` + new by `created_timestamp`) and `GET .../sol-price`.
2. **Enrich (default):** DexScreener `/latest/dex/tokens/{mint}` for m5 % change / volume (Pump list payloads lack those windows).
3. **Fallback (default, labeled in logs):** DexScreener search filtered to `dexId` ∈ `{pumpfun, pumpswap}` if the frontend API fails or is empty.
4. **Broker:** still `PaperBroker` — no wallet, no live Pump.fun/Jupiter swap.

## Live wiring (stub only)

Live mode **refuses to start** (`assertPaperOrStubLive`). API `POST /runner/start` also refuses unless `PAPER_MODE=true`. When you are ready *after* paper validation:

1. Keep keys **out of git** — load a keypair path from env (`LIVE_WALLET_KEYPAIR_PATH`), never commit it.  
2. Replace `liveSwapStub` in `src/broker/paper.ts` with:
   - **Jupiter** quote + swap API, or  
   - **Raydium** / **PumpSwap** SDK swap helpers (Pump.fun bonding-curve buys are a separate integration — still not wired)  
3. Add an RPC URL (`LIVE_RPC_URL`), confirm slippage/fee reality, and gate with an explicit `PAPER_MODE=false` + second confirmation flag.  
4. Start tiny; assume fills, latency, and rugs are worse than paper.

Until that exists, `PAPER_MODE=true` is the only supported path. The APK must not (and does not) require a wallet for paper.

## Risk reminder

`$20` bankroll, **one** position, **10%** hard stop, **+25%** hard take-profit (optional), plus optional **time stop** / **daily loss cap**, still means you can lose a large share of the account on a single bad tape. Paper first. Tweak specs in `.env`, `config/default.json`, or `config/pumpfun-preset.json` — code is kept readable on purpose.

## License

MIT
