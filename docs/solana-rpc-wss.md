# Optional Solana RPC WebSocket (listen only)

Default **off**. Leave `SOLANA_RPC_WSS_URL` unset and the bot behaves exactly as today: pump.fun HTTP hunt, HTTPS RPC for optional rug checks, no WebSocket.

This never sends a live trade. Paper mode stays the default. Live trading stays stubbed.

## Why a separate WSS env

`SOLANA_RPC_URL` is the **HTTPS** endpoint (lookups, rug filter, future trade sends).

`SOLANA_RPC_WSS_URL` is the **WebSocket** endpoint (listen / subscribe). Paste the WSS link from RPC Fast (or your provider) here. Do not reuse the HTTPS URL.

## What it does

When `SOLANA_RPC_WSS_URL` is set:

1. The engine connects (fail-soft — connect errors never stop the paper runner).
2. Subscribes to **slots** (`slotSubscribe`) so `/status` can show `lastSlot` and connection health.
3. When a coin is **pinned**, optionally `accountSubscribe`s that mint (listen only).
4. Reconnects with exponential backoff if the socket drops.
5. If WSS is down, paper **keeps** the existing HTTPS / poll path. No throw out of the runner.

`/status` and `/config` never print the WSS URL. They expose `solanaRpcWss`:

| Field | Meaning |
| --- | --- |
| `configured` | Env var is set |
| `connected` | Socket is open |
| `state` | `disconnected` / `connecting` / `connected` / `reconnecting` |
| `lastSlot` | Latest slot from `slotNotification`, or null |
| `lastError` | Redacted error string (no URL) |
| `reconnectAttempts` | Backoff counter |
| `slotSubscribed` | Slot subscription active |
| `accountSubscriptionCount` | Active account subscriptions |

## What it does **not** do

- Does **not** replace the pump.fun HTTP hunt.
- Does **not** replace HTTPS rug-filter lookups.
- Does **not** send, sign, or submit transactions.
- Does **not** enable live trading (`PAPER_MODE` stays required).
- Does **not** change paper defaults when unset.
- Merging this code does **not** restart a running paper bot — pull and restart later to pick it up.

## Live path (future)

When live wiring lands: **listen** over WSS; keep **lookups + trade sends** on HTTPS. This PR only adds the read-only listener scaffolding.

## After you change this

Restart the API/CLI process to load a new `SOLANA_RPC_WSS_URL`. Restart is a separate step from merging.
