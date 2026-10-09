# Vault (skim) + max position size

Paper risk controls so a hot overnight session cannot all-in every dollar.

## Vault / skim

| Concept | Meaning |
|---------|---------|
| **Configured bankroll** | `bankrollUsd` — session start / Reset target |
| **Tradable cash** | `cashUsd` / `tradableCashUsd` — funds sizing uses |
| **Vault** | `vaultUsd` — skimmed funds locked out of sizing |
| **Trading equity** | cash + open positions MTM (excludes vault) |
| **Total equity** | trading equity + vault |

### Actions

- **Skim $** — `POST /vault/skim { "amountUsd": N }` moves min(N, cash) from tradable → vault.
- **Skim %** — `POST /vault/skim { "percentOfProfit": P }` skims `P%` of  
  `max(0, cashUsd − bankrollUsd)`  
  (cash profit **above the bankroll floor**; does **not** use open-position unrealized MTM).
- **Return** — `POST /vault/return { "amountUsd": N }` moves vault → tradable (paper convenience).

Sizing always uses **tradable cash only** — vault never funds an entry. After a skim, if tradable cash can't cover the **full** selected trade size, buying pauses (`/status` → `buyingPaused`, one log line + one alert) until cash is added or the vault is returned. The bot never buys a smaller position with what's left.

### Reset behavior (documented choice)

**Vault survives `/runner/reset`** (and Start `?reset=1`), same design as the trade journal and research checklists.

- Reset restores cash to `bankrollUsd`, clears positions / session trades / `stopReason`.
- `data/vault.json` is **not** cleared.
- Explicit return (or deleting `data/vault.json` offline) is how you unlock vaulted paper funds.

Rationale: Mark locks overnight profit away; a session Reset for a fresh daily-loss window must not re-inject vaulted money into tradable sizing.

## Max position size

| Setting | Default | Env / PATCH |
|---------|---------|-------------|
| `maxPositionUsd` | `25` | `MAX_POSITION_USD` / PATCH `/config` |

Entry notional is **exactly the selected trade size** ($15 / $30 / $60, clamped to the active cap when the button is chosen) — full size or no buy:

```text
size = tradeSize.effectiveUsd
buy only if tradable cash ≥ size + costs charged on top of it (0 in the realistic model: fees come out of the size)
           and size ≤ maxPositionUsd (if > 0)
```

`0` disables the hard USD cap. `positionSizePct` no longer sizes buys (it could only shrink a buy below the selected size).

### Sticky with presets

Like `bankrollUsd` and `dailyLossUsd`, **`maxPositionUsd` is session risk** — Momentum / Sniper presets do **not** overwrite it. Edit via Settings Save or `PATCH /config`.

## API

| Method | Path | Notes |
|--------|------|--------|
| GET | `/portfolio` | Includes `vaultUsd`, `tradableCashUsd`, `maxPositionUsd`; portfolio object has the same + `totalEquityUsd` |
| POST | `/vault/skim` | `{ amountUsd }` **or** `{ percentOfProfit }` |
| POST | `/vault/return` | `{ amountUsd }` |
| PATCH | `/config` | `maxPositionUsd` paper-safe |

## UI

- **PnL** — Bankroll / Tradable / Vault / Equity / Total; Skim $ / Skim % / Return.
- **Settings** — Max position USD (session risk, sticky).

## Files

- `data/vault.json` — `{ "vaultUsd": number, "updatedAt": ms }` (survives Reset)
