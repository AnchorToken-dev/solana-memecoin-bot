# Research go/no-go checklist

Human research half of Mark’s paper memecoin workflow. The bot already filters age / liquidity / volume; this form captures judgment before sizing.

## Verdict rules

- **GO** — every *required* row is Pass; optional rows are Pass or Skip; thesis and invalidation are non-empty; no Fail anywhere.
- **NO-GO** — any row is Fail (including optional).
- **INCOMPLETE** — required row unset/skip, optional unset, or empty thesis/invalidation.

Default required rows: token age, liquidity, volume realism, not a clone, size within bankroll. Optional (Skip OK): holders concentration, mint/freeze authority.

## Persistence

`data/checklists.json` — survives `/runner/reset`. Clear only via `DELETE /checklist`.

## Advisory vs gate

v1 is **advisory**: saving NO-GO does **not** auto-block the paper bot.

Optional Settings toggle **Require GO before entry** (`requireChecklistGo`, default `false`, also `REQUIRE_CHECKLIST_GO` env / `PATCH /config`) makes the engine skip paper entries when the latest checklist for that mint is missing or not GO.

## Journal

Light follow-up: journal does not yet store `checklistId`. Nice-to-have later.
