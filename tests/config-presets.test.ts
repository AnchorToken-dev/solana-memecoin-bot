import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { createControlApp } from "../src/api/server.js";
import {
  loadConfig,
  loadRuntimeOverlay,
  overlayFromConfig,
  saveRuntimeOverlay,
} from "../src/config.js";
import { MOMENTUM_PRESET, SNIPER_PRESET } from "../src/presets.js";
import type { BotConfig } from "../src/types.js";
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

describe("named presets momentum vs sniper", () => {
  it("documents distinct sniper vs momentum numbers", () => {
    assert.equal(MOMENTUM_PRESET.stopLossPct, 10);
    assert.equal(SNIPER_PRESET.stopLossPct, 8);
    assert.equal(MOMENTUM_PRESET.takeProfitPct, 25);
    assert.equal(SNIPER_PRESET.takeProfitPct, 15);
    assert.equal(MOMENTUM_PRESET.momentum.minAgeMinutes, 3);
    assert.equal(SNIPER_PRESET.momentum.minAgeMinutes, 0);
    assert.equal(MOMENTUM_PRESET.momentum.minLiquidityUsd, 5_000);
    assert.equal(SNIPER_PRESET.momentum.minLiquidityUsd, 2_000);
    assert.equal(MOMENTUM_PRESET.trailingTakeProfit.activatePct, 10);
    assert.equal(SNIPER_PRESET.trailingTakeProfit.activatePct, 8);
    assert.equal(MOMENTUM_PRESET.trailingTakeProfit.distancePct, 7);
    assert.equal(SNIPER_PRESET.trailingTakeProfit.distancePct, 4);
    assert.equal(MOMENTUM_PRESET.maxHoldMinutes, 20);
    assert.equal(SNIPER_PRESET.maxHoldMinutes, 10);
    assert.equal(MOMENTUM_PRESET.runner.pollIntervalMs, 15_000);
    assert.equal(SNIPER_PRESET.runner.pollIntervalMs, 10_000);
  });
});

describe("POST /config/preset + PATCH persistence", () => {
  let dir: string;
  let overlayPath: string;
  let server: Server;
  let base: string;
  let engine: BotEngine;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "paper-cfg-"));
    overlayPath = join(dir, "runtime-config.json");
    const cfg = baseCfg({ ledgerDir: dir });
    engine = new BotEngine(cfg, {
      ledger: new PaperLedger(cfg.bankrollUsd, dir),
      broker: new PaperBroker(cfg),
      runtimeConfigPath: overlayPath,
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
    await engine.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((e) => (e ? reject(e) : resolve()));
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies sniper preset and persists overlay", async () => {
    const res = await fetch(`${base}/config/preset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "sniper" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      config: BotConfig;
    };
    assert.equal(body.ok, true);
    assert.equal(body.config.activePreset, "sniper");
    assert.equal(body.config.stopLossPct, SNIPER_PRESET.stopLossPct);
    assert.equal(body.config.takeProfitPct, SNIPER_PRESET.takeProfitPct);
    assert.equal(
      body.config.momentum.minAgeMinutes,
      SNIPER_PRESET.momentum.minAgeMinutes,
    );
    assert.equal(
      body.config.momentum.minLiquidityUsd,
      SNIPER_PRESET.momentum.minLiquidityUsd,
    );
    assert.equal(
      body.config.trailingTakeProfit.activatePct,
      SNIPER_PRESET.trailingTakeProfit.activatePct,
    );
    assert.equal(existsSync(overlayPath), true);
    const disk = JSON.parse(readFileSync(overlayPath, "utf8")) as {
      activePreset: string;
      stopLossPct: number;
    };
    assert.equal(disk.activePreset, "sniper");
    assert.equal(disk.stopLossPct, 8);
  });

  it("applies momentum preset after sniper", async () => {
    const res = await fetch(`${base}/config/preset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "momentum" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; config: BotConfig };
    assert.equal(body.config.activePreset, "momentum");
    assert.equal(body.config.stopLossPct, MOMENTUM_PRESET.stopLossPct);
    assert.equal(
      body.config.momentum.minLiquidityUsd,
      MOMENTUM_PRESET.momentum.minLiquidityUsd,
    );
  });

  it("PATCH persists bankroll/stop and marks custom", async () => {
    const res = await fetch(`${base}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bankrollUsd: 35, stopLossPct: 12 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; config: BotConfig };
    assert.equal(body.ok, true);
    assert.equal(body.config.bankrollUsd, 35);
    assert.equal(body.config.stopLossPct, 12);
    assert.equal(body.config.activePreset, "custom");

    const disk = loadRuntimeOverlay(overlayPath);
    assert.equal(disk.bankrollUsd, 35);
    assert.equal(disk.stopLossPct, 12);
    assert.equal(disk.activePreset, "custom");
  });

  it("rejects live-dangerous fields", async () => {
    const res = await fetch(`${base}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paperMode: false, stopLossPct: 9 }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as {
      ok: boolean;
      rejected?: string[];
    };
    assert.equal(body.ok, false);
    assert.ok(body.rejected?.includes("paperMode"));
    // Unchanged
    assert.equal(engine.cfg.paperMode, true);
    assert.equal(engine.cfg.stopLossPct, 12);
  });

  it("requires stop before preset while running", async () => {
    const started = await fetch(`${base}/runner/start`, { method: "POST" });
    assert.equal(started.status, 200);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(engine.getStatus().state, "running");

    const res = await fetch(`${base}/config/preset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "sniper" }),
    });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { ok: boolean; message: string };
    assert.equal(body.ok, false);
    assert.match(body.message, /Stop the paper runner/);

    await fetch(`${base}/runner/stop`, { method: "POST" });
  });

});

describe("loadConfig runtime overlay persistence", () => {
  let dir: string;
  let overlayPath: string;
  const prevLedger = process.env.LEDGER_DIR;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "paper-load-"));
    overlayPath = join(dir, "runtime-config.json");
    process.env.LEDGER_DIR = dir;
    // Clear env knobs that would fight overlay in this process
    for (const k of [
      "STOP_LOSS_PCT",
      "TAKE_PROFIT_PCT",
      "MIN_AGE_MINUTES",
      "MIN_LIQUIDITY_USD",
      "BANKROLL_USD",
      "TRAIL_ACTIVATE_PCT",
      "TRAIL_DISTANCE_PCT",
      "MAX_HOLD_MINUTES",
      "POLL_INTERVAL_MS",
      "MOMENTUM_MIN_PCT",
      "MIN_VOLUME_24H_USD",
      "VOLUME_SPIKE_MULT",
      "POSITION_SIZE_PCT",
      "DAILY_LOSS_USD",
    ]) {
      delete process.env[k];
    }
  });

  after(() => {
    if (prevLedger === undefined) delete process.env.LEDGER_DIR;
    else process.env.LEDGER_DIR = prevLedger;
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies sniper via saveRuntimeOverlay then loadConfig picks it up", () => {
    const seed = baseCfg({ ledgerDir: dir });
    // Mutate to sniper and save
    seed.stopLossPct = SNIPER_PRESET.stopLossPct;
    seed.takeProfitPct = SNIPER_PRESET.takeProfitPct;
    seed.positionSizePct = SNIPER_PRESET.positionSizePct;
    seed.bankrollUsd = 100; // session risk — not part of preset knobs
    seed.momentum = { ...SNIPER_PRESET.momentum };
    seed.trailingTakeProfit = { ...SNIPER_PRESET.trailingTakeProfit };
    seed.maxHoldMinutes = SNIPER_PRESET.maxHoldMinutes;
    seed.dailyLossUsd = 25;
    seed.runner.pollIntervalMs = SNIPER_PRESET.runner.pollIntervalMs;
    seed.activePreset = "sniper";
    saveRuntimeOverlay(overlayFromConfig(seed), overlayPath);

    const loaded = loadConfig({ runtimePath: overlayPath });
    assert.equal(loaded.activePreset, "sniper");
    assert.equal(loaded.stopLossPct, 8);
    assert.equal(loaded.takeProfitPct, 15);
    assert.equal(loaded.momentum.minAgeMinutes, 0);
    assert.equal(loaded.momentum.minLiquidityUsd, 2_000);
    assert.equal(loaded.trailingTakeProfit.distancePct, 4);
    assert.equal(loaded.maxHoldMinutes, 10);
    assert.equal(loaded.runner.pollIntervalMs, 10_000);
  });
});
