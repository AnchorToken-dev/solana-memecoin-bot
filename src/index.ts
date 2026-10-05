#!/usr/bin/env node
/**
 * Solana memecoin momentum bot — PAPER mode by default.
 *
 *   npm start          # CLI paper loop (same as before)
 *   npm run api        # HTTP control API for mobile UI (starts stopped)
 *   npm run paper      # explicit PAPER_MODE=true CLI loop
 *
 * No private keys required. Live swaps are stubbed.
 */
import { loadConfig, assertPaperOrStubLive } from "./config.js";
import { BotEngine } from "./engine/botEngine.js";
import { startControlApi } from "./api/server.js";
import { log } from "./logging.js";

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
  Portfolio: http://127.0.0.1:${port}/portfolio
  Trades:    http://127.0.0.1:${port}/trades
  Journal:   http://127.0.0.1:${port}/journal  (P&L summary + charts + USD/SOL; survives reset; PATCH note)
  Checklist: http://127.0.0.1:${port}/checklist  (research GO/NO-GO; POST create)
  Alerts:    http://127.0.0.1:${port}/alerts?since=0  (session events for phone notifications)
  Config:    http://127.0.0.1:${port}/config
  Patch:     PATCH http://127.0.0.1:${port}/config  (paper knobs; stop runner first)
  Preset:    POST  http://127.0.0.1:${port}/config/preset  { "preset": "momentum"|"sniper" }

Phone: set API base URL in the app Settings.
  Emulator / USB: adb reverse tcp:${port} tcp:${port}  → http://127.0.0.1:${port}
  Same LAN:       http://<laptop-lan-ip>:${port}
Listening on ${host}:${port}. Runner starts STOPPED — use the app or POST /runner/start.
`);

    const shutdown = async () => {
      log.info("Shutting down API…");
      await engine.stop();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown());
    process.on("SIGTERM", () => void shutdown());
    // Keep process alive
    await new Promise(() => undefined);
    return;
  }

  // CLI: auto-start paper loop
  const shutdown = async () => {
    log.info("Shutting down…");
    await engine.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

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
