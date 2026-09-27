#!/usr/bin/env node
/**
 * Solana memecoin momentum bot — PAPER mode by default.
 *
 *   npm start
 *   npm run paper
 *   MAX_CYCLES=12 npm start   # short demo run
 *
 * No private keys required. Live swaps are stubbed.
 */
import { loadConfig, assertPaperOrStubLive } from "./config.js";
import { createMarketData } from "./market/data.js";
import { PaperBroker } from "./broker/paper.js";
import { PaperLedger } from "./ledger/ledger.js";
import { runLoop } from "./runner/loop.js";
import { log } from "./logging.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  assertPaperOrStubLive(cfg);

  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Solana Memecoin Momentum Bot  ·  PAPER SIMULATION       ║
║  Bankroll $${cfg.bankrollUsd.toFixed(2).padEnd(6)} · maxOpen=${cfg.maxOpenTrades} · stop=${cfg.stopLossPct}%          ║
║  No profit guarantee. No live keys. Dry-run by default.  ║
╚══════════════════════════════════════════════════════════╝
`);

  const market = createMarketData(cfg);
  const broker = new PaperBroker(cfg);
  const ledger = new PaperLedger(cfg.bankrollUsd, cfg.ledgerDir);

  const shutdown = () => {
    log.info("Shutting down…");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await runLoop({ cfg, market, broker, ledger });
}

main().catch((err) => {
  log.error("Fatal", err);
  process.exit(1);
});
