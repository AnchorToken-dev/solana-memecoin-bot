import type { BotConfig } from "../types.js";
import type { MarketDataProvider } from "../market/data.js";
import { PaperBroker } from "../broker/paper.js";
import { PaperLedger } from "../ledger/ledger.js";
import { BotEngine } from "../engine/botEngine.js";

export interface RunnerDeps {
  cfg: BotConfig;
  market: MarketDataProvider;
  broker: PaperBroker;
  ledger: PaperLedger;
}

/**
 * CLI-friendly loop: start the engine and wait until maxCycles or process signal.
 * Prefer BotEngine + control API for start/stop from mobile.
 */
export async function runLoop(deps: RunnerDeps): Promise<void> {
  const engine = new BotEngine(deps.cfg, {
    market: deps.market,
    broker: deps.broker,
    ledger: deps.ledger,
  });
  const started = await engine.start();
  if (!started.ok) {
    throw new Error(started.message);
  }

  // Poll until stopped (maxCycles or external stop).
  while (engine.getStatus().state === "running" || engine.getStatus().state === "starting") {
    await new Promise((r) => setTimeout(r, 200));
  }
}
