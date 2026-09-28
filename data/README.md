# Paper ledger / runtime overlay

- `trades.json` / `trades.csv` — paper fills (gitignored)
- `runtime-config.json` — in-app paper settings overlay from PATCH `/config` and POST `/config/preset` (gitignored). Survives restart; never contains wallet keys.
- `checklists.json` — research go/no-go checklists (survives Reset; gitignored runtime data)
- `journal.json` — closed-trade journal with mint/CA + notes (survives Reset; gitignored runtime data)
