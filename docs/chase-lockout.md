# Paper chase lockout (preview for future live)

## Why

After wiping the **original deposit / bankroll** (e.g. $100), it is easy to hit Reset and immediately chase losses. This feature locks **new paper trading** for a cool-down (default **12 hours**) so the habit can be tested in paper before live.

## Rules

| Rule | Behavior |
|------|----------|
| Threshold | **Original deposit** = configured `BANKROLL_USD` / `bankrollUsd` — **not** peak equity / growing bankroll |
| Trigger | Session realized PnL ≤ `−bankrollUsd`, or session zeroed (flat + dust cash + full deposit loss) |
| Duration | `CHASE_LOCKOUT_HOURS` (default `12`; `0` = feature off) |
| Where it lives | Laptop / control API: `data/chase-lockout.json` — **phone/tablet restart cannot bypass** |
| Reset | `POST /runner/reset` clears the paper ledger / daily-loss stop **but does NOT clear** an active chase lockout |
| Unlock | **Timer only** in paper preview (no easy unlock API — hard to misuse) |
| Live | Still stubbed — start refuses unless `PAPER_MODE=true` |

## API / UI

- `GET /status` → `chaseLockout: { active, unlockAt, lockedAt, reason, originalDepositUsd, remainingMs, lockoutHours }`
- `GET /lockout` → same + `chaseLockoutHours` + note
- `GET /portfolio` → includes `chaseLockout`
- Mobile **PnL** / **Status** / **Settings**: lock banner + unlock-at; Settings has **Chase lockout hours** (sticky with bankroll / daily loss / max position)

## How to test (paper)

```bash
# Short cool-down for a quick preview (optional)
CHASE_LOCKOUT_HOURS=0.01  # ~36 seconds — or use Settings

# 1. Set bankroll to $100 (Settings or PATCH)
# 2. Simulate / trade until realized PnL ≤ −$100 (full original deposit)
# 3. Runner stops; GET /lockout shows active + unlockAt
# 4. POST /runner/reset — cash restored, but start still refused until unlockAt
# 5. Kill/restart the API process — lock file still on disk; still locked
# 6. Wait for timer (or set hours tiny) — lock expires; Start works again
```

Unit / API coverage: `tests/chase-lockout.test.ts`.
