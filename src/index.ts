#!/usr/bin/env node
/**
 * Solana memecoin momentum bot — PAPER mode by default.
 *
 *   npm start          # CLI paper loop (same as before)
 *   npm run api        # HTTP control API for mobile UI (starts stopped)
 *   npm run paper      # explicit PAPER_MODE=true CLI loop
 *
 * No private keys required for paper. Live (opt-in, gated) loads a local
 * keypair FILE path only — see README "Going live".
 */
import { loadConfig, assertPaperOrStubLive } from "./config.js";
import { BotEngine } from "./engine/botEngine.js";
import { startControlApi } from "./api/server.js";
import { log } from "./logging.js";

/**
 * Ctrl+C / kill / closed terminal: write the open-positions file FIRST (sync),
 * then stop the runner, write again, exit. A second signal exits at once (file
 * already written). Open positions are restored on the next start.
 */
function installGracefulShutdown(engine: BotEngine, what: string): void {
  let shuttingDown = false;
  const flush = () => {
    try {
      engine.flushOpenPositions();
    } catch (err) {
      log.error("Could not write open positions on shutdown", err);
    }
  };
  const shutdown = async (sig: string) => {
    flush();
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    const n = engine.getOpenPositionsReport().count;
    log.info(`${sig}: shutting down ${what}… ${n > 0 ? `${n} open position(s) saved; they resume on next start` : "flat"}`);
    await Promise.race([engine.dispose(), new Promise((r) => setTimeout(r, 5_000))]).catch(() => undefined);
    flush();
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) {
    try {
      process.on(sig, () => void shutdown(sig));
    } catch {
      /* signal not supported on this OS */
    }
  }
  // Last chance on any other exit path (sync write only).
  process.on("exit", flush);
}

function modeFromArgs(): "cli" | "api" {
  const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (arg === "api" || process.env.CONTROL_API === "1" || process.env.CONTROL_API === "true") {
    return "api";
  }
  return "cli";
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  assertPaperOrStubLive(cfg);
  const mode = modeFromArgs();
  if (cfg.tradingMode && cfg.tradingMode !== "paper") {
    const label = cfg.tradingMode === "live" ? "LIVE — REAL MONEY" : "LIVE DRY-RUN — simulate only, nothing is sent";
    console.log(`\n  >>> MODE: ${label} <<<\n  Caps: $${cfg.live?.maxPositionUsd}/trade · ${cfg.live?.maxOpenPositions} open · daily loss $${cfg.live?.dailyLossLimitUsd} · rug filter ON\n`);
  }

  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Solana Memecoin Momentum Bot  ·  PAPER SIMULATION       ║
║  Bankroll $${cfg.bankrollUsd.toFixed(2).padEnd(6)} · maxOpen=${cfg.maxOpenTrades} · stop=${cfg.stopLossPct}%          ║
║  No profit guarantee. No live keys. Dry-run by default.  ║
╚══════════════════════════════════════════════════════════╝
`);

  const engine = new BotEngine(cfg);

  if (mode === "api") {
    const { host, port } = await startControlApi(engine);
    console.log(`Control API ready.
  Health:    http://127.0.0.1:${port}/health
  Status:    http://127.0.0.1:${port}/status
  Start:     POST http://127.0.0.1:${port}/runner/start  (?reset=1 clears ledger first)
  Stop:      POST http://127.0.0.1:${port}/runner/stop
  Reset:     POST http://127.0.0.1:${port}/runner/reset  (PAPER: clear ledger / daily-loss lock)
  Positions: http://127.0.0.1:${port}/positions  (open positions; "flat": true = safe to restart)
  Portfolio: http://127.0.0.1:${port}/portfolio
  Trades:    http://127.0.0.1:${port}/trades
  Journal:   http://127.0.0.1:${port}/journal  (P&L summary + charts + USD/SOL; survives reset; PATCH note)
  Checklist: http://127.0.0.1:${port}/checklist  (research GO/NO-GO; POST create)
  Alerts:    http://127.0.0.1:${port}/alerts?since=0  (session events for phone notifications)
  Config:    http://127.0.0.1:${port}/config
  Sell all:  POST http://127.0.0.1:${port}/runner/sell-all  (halt buys + flatten)
  Patch:     PATCH http://127.0.0.1:${port}/config  (paper knobs; stop runner first)
  Preset:    POST  http://127.0.0.1:${port}/config/preset  { "preset": "momentum"|"sniper" }

Phone: set API base URL in the app Settings.
  Emulator / USB: adb reverse tcp:${port} tcp:${port}  → http://127.0.0.1:${port}
  Same LAN:       http://<laptop-lan-ip>:${port}
Listening on ${host}:${port}. Runner starts STOPPED — use the app or POST /runner/start.
`);

    installGracefulShutdown(engine, "API");
    // Keep process alive
    await new Promise(() => undefined);
    return;
  }

  // CLI: auto-start paper loop
  installGracefulShutdown(engine, "CLI");

  const started = await engine.start();
  if (!started.ok) {
    throw new Error(started.message);
  }

  while (true) {
    const st = engine.getStatus();
    if (st.state === "stopped") break;
    await new Promise((r) => setTimeout(r, 250));
  }
}

main().catch((err) => {
  log.error("Fatal", err);
  process.exit(1);
});
