# Stuck-on-one-coin / API restart recovery

## Symptom

Paper Pump.fun runner stays on a single open position (`maxOpenTrades=1`),
exits (stop / trail / time-stop) stop firing for a long time, and restarting
the control API “fixes” it. Often after a few hours of uptime.

## Root causes (code)

1. **Hung market HTTP (primary)** — Pump.fun + DexScreener `fetch` calls had
   **no timeout**. `getPrice()` still awaited Dex enrich even when a cache
   mark existed (`src/market/pumpfun.ts`). A stalled Cloudflare/Dex socket
   blocked `tick()` forever. `AbortController` on stop only cancelled the
   poll **sleep**, not in-flight HTTP — so stop itself could hang until
   process kill.

2. **Null mark skips all exits (secondary)** — `BotEngine.tick` logged
   `No mark for …; skipping exit check` and `continue`d, which also skipped
   **time_stop** (`src/engine/botEngine.ts`). With `maxOpenTrades=1` that
   wedges the runner if marks never return.

3. **Restart only cleared memory** — open positions live in the in-memory
   ledger (not disk). Killing the API drops the wedged position without a
   journal close, which looks like a “fix” and shows as long gaps between
   journal closes.

## Mitigations (this fix)

- `fetchWithTimeout` + `MARKET_HTTP_TIMEOUT_MS` (default 8s) on market HTTP
- Cache-first `getPrice` (Dex hang/fail → last cache mark)
- Null-mark path still forces **time_stop** at HWM/entry fallback
- Manual exit uses the same fallback mark instead of refusing forever
- `stop()` waits at most 60s then forces stopped state
- `GET /status` exposes `cycleAgeMs` (ms since last completed tick)

## Ops check

While running, if `cycleAgeMs` grows far beyond `pollIntervalMs + scan budget`,
the tick is stalled — prefer stop/restart after this fix; hung HTTP should
self-recover within one timeout window.
