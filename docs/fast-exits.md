# Fast exits while holding

**Problem (Oct 2026).** Positions went +40% (PAUL ~+60%) on pump.fun and the
bot never sold. While holding, the runner checked exits every ~3 s, but the
price it used was DexScreener's `priceUsd`. Measured side by side with the
bonding curve on Oct 9: Dex updated a curve coin's price only every ~30 s and
was often far off — one coin was +68% on-chain while Dex showed +4..13%;
another fell -60% on-chain while Dex still showed +61% for 30 s. A spike that
lasts less than Dex's refresh never reaches take-profit or arms the trailing
stop, and stops fire late too.

**Fix.** While a position is open the runner reads that coin's price straight
from the chain every `FAST_EXIT_POLL_MS` (default 1000 ms) over the configured
HTTPS RPC — one `getMultipleAccounts` per held coin per tick:

- still on pump.fun: the bonding-curve account (virtual SOL / token reserves);
- graduated: the canonical PumpSwap pool (base vault, quote vault + the pool's
  virtual quote reserves) — switches automatically when the curve completes.

Each read runs the same `evaluateExit` (stop, take-profit, max hold, trailing)
and a hit sells immediately. The full ~3 s tick also uses the on-chain mark
(reusing a read under 1 s old). If the chain read fails, the old Dex/pump.fun
price is used. A failed live sell is retried at the old ~3 s cadence, not every
fast tick. No WebSocket subscription is added (WSS keeps its slot + pinned-mint
subscriptions). `FAST_EXIT_POLL_MS=0` or no `SOLANA_RPC_URL` = old behaviour.

Load: ~1 request/second while holding one coin, nothing while flat.
