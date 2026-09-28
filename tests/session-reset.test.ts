import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { createControlApp } from "../src/api/server.js";
import type { BotConfig, Fill } from "../src/types.js";
import type { Server } from "node:http";

function baseCfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true,
    bankrollUsd: 20,
    maxOpenTrades: 1,
    stopLossPct: 10,
    takeProfitPct: 25,
    positionSizePct: 0.95,
    maxPositionUsd: 25,
    momentum: {
      minPct: 8,
      windowMinutes: 5,
      volumeSpikeMult: 2,
      minLiquidityUsd: 15_000,
      minVolume24hUsd: 25_000,
      minAgeMinutes: 3,
    },
    trailingTakeProfit: { activatePct: 15, distancePct: 5 },
    paperBroker: { slippageBps: 50, feeBps: 30 },
    runner: { pollIntervalMs: 50, scanLimit: 5, maxCycles: 0 },
    maxHoldMinutes: 20,
    dailyLossUsd: 5,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "custom",
    requireChecklistGo: false,
    ...over,
  };
}

function lossFill(): Fill {
  return {
    id: "fill-loss",
    positionId: "pos-gone",
    mint: "MintLoss",
    symbol: "LOSS",
    side: "sell",
    qty: 0,
    price: 0,
    notionalUsd: 0,
    feesUsd: 0,
    slippageUsd: 0,
    reason: "stop_loss",
    timestamp: Date.now(),
    paper: true,
  };
}

/** Wait until engine is stopped (or timeout). */
async function waitStopped(engine: BotEngine, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (engine.getStatus().state === "stopped") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `engine did not stop in time; state=${engine.getStatus().state} reason=${engine.getStatus().stopReason}`,
  );
}

describe("session reset clears daily-loss lock", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "paper-reset-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("start dies immediately on daily_loss_cap; reset unlocks a fresh start", async () => {
    const cfg = baseCfg({ ledgerDir: dir, dailyLossUsd: 5, bankrollUsd: 20 });
    const ledger = new PaperLedger(cfg.bankrollUsd, dir);
    // Simulate a rugged session: realized ≤ −DAILY_LOSS_USD
    ledger.recordSell(lossFill(), -6.25, 0);
    assert.ok(ledger.realizedPnl <= -cfg.dailyLossUsd);

    const engine = new BotEngine(cfg, {
      ledger,
      broker: new PaperBroker(cfg),
    });

    const started = await engine.start();
    assert.equal(started.ok, true);
    await waitStopped(engine);
    const locked = engine.getStatus();
    assert.equal(locked.state, "stopped");
    assert.match(locked.stopReason ?? "", /daily_loss_cap/);

    // Start alone must NOT clear the ledger — dies again.
    const again = await engine.start();
    assert.equal(again.ok, true);
    await waitStopped(engine);
    assert.match(engine.getStatus().stopReason ?? "", /daily_loss_cap/);
    assert.ok(ledger.realizedPnl <= -5);

    const reset = await engine.reset();
    assert.equal(reset.ok, true);
    assert.equal(reset.status.stopReason, null);
    assert.equal(reset.status.cycle, 0);
    assert.equal(reset.portfolio.cashUsd, 20);
    assert.equal(reset.portfolio.realizedPnlUsd, 0);
    assert.equal(reset.portfolio.tradeCount, 0);
    assert.equal(reset.portfolio.openPositions.length, 0);
    assert.equal(ledger.cash, 20);
    assert.equal(ledger.realizedPnl, 0);

    // Disk trades cleared
    const jsonPath = join(dir, "trades.json");
    assert.equal(existsSync(jsonPath), true);
    assert.deepEqual(JSON.parse(readFileSync(jsonPath, "utf8")), []);

    // After reset, start must stay running (no immediate daily-loss halt).
    const fresh = await engine.start();
    assert.equal(fresh.ok, true);
    await new Promise((r) => setTimeout(r, 150));
    const st = engine.getStatus();
    assert.equal(st.state, "running");
    assert.equal(st.stopReason, null);
    await engine.stop();
  });

  it("start({ reset: true }) clears the lock in one call", async () => {
    const sub = join(dir, "start-reset");
    const cfg = baseCfg({ ledgerDir: sub, dailyLossUsd: 5 });
    const ledger = new PaperLedger(cfg.bankrollUsd, sub);
    ledger.recordSell(lossFill(), -50, 0);

    const engine = new BotEngine(cfg, {
      ledger,
      broker: new PaperBroker(cfg),
    });

    const started = await engine.start({ reset: true });
    assert.equal(started.ok, true);
    assert.equal(ledger.realizedPnl, 0);
    assert.equal(ledger.cash, cfg.bankrollUsd);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(engine.getStatus().state, "running");
    assert.equal(engine.getStatus().stopReason, null);
    await engine.stop();
  });
});

describe("POST /runner/reset (control API)", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let engine: BotEngine;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "paper-api-reset-"));
    const cfg = baseCfg({ ledgerDir: dir, dailyLossUsd: 5, bankrollUsd: 20 });
    const ledger = new PaperLedger(cfg.bankrollUsd, dir);
    ledger.recordSell(lossFill(), -12, 0);
    engine = new BotEngine(cfg, {
      ledger,
      broker: new PaperBroker(cfg),
    });
    const app = createControlApp(engine);
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no address");
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((e) => (e ? reject(e) : resolve()));
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("resets ledger and returns portfolio/status so start can succeed", async () => {

    const beforeStart = await fetch(`${base}/runner/start`, { method: "POST" });
    const beforeBody = (await beforeStart.json()) as {
      ok: boolean;
      status: { stopReason: string | null };
    };
    assert.equal(beforeBody.ok, true);
    await waitStopped(engine);
    assert.match(engine.getStatus().stopReason ?? "", /daily_loss_cap/);

    const res = await fetch(`${base}/runner/reset`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      message: string;
      status: { stopReason: string | null; cycle: number; state: string };
      portfolio: {
        cashUsd: number;
        realizedPnlUsd: number;
        tradeCount: number;
      };
    };
    assert.equal(body.ok, true);
    assert.equal(body.status.stopReason, null);
    assert.equal(body.status.cycle, 0);
    assert.equal(body.status.state, "stopped");
    assert.equal(body.portfolio.cashUsd, 20);
    assert.equal(body.portfolio.realizedPnlUsd, 0);
    assert.equal(body.portfolio.tradeCount, 0);

    const after = await fetch(`${base}/runner/start`, { method: "POST" });
    const afterBody = (await after.json()) as { ok: boolean };
    assert.equal(after.ok, true);
    assert.equal(afterBody.ok, true);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(engine.getStatus().state, "running");
    await engine.stop();
  });
});
