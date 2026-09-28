import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { createControlApp } from "../src/api/server.js";
import { applyPresetKnobs, MOMENTUM_PRESET, SNIPER_PRESET } from "../src/presets.js";
import type { BotConfig } from "../src/types.js";
import type { Server } from "node:http";

function baseCfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true,
    bankrollUsd: 100,
    maxOpenTrades: 1,
    stopLossPct: 10,
    takeProfitPct: 25,
    positionSizePct: 0.95,
    maxPositionUsd: 25,
    momentum: { ...MOMENTUM_PRESET.momentum },
    trailingTakeProfit: { ...MOMENTUM_PRESET.trailingTakeProfit },
    paperBroker: { slippageBps: 50, feeBps: 30 },
    runner: { pollIntervalMs: 15_000, scanLimit: 5, maxCycles: 0 },
    maxHoldMinutes: 20,
    dailyLossUsd: 25,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "momentum",
    requireChecklistGo: false,
    ...over,
  };
}

describe("sticky session risk across presets", () => {
  it("applyPresetKnobs keeps bankroll 100, dailyLoss 25, maxPosition 25", () => {
    const cfg = baseCfg({ maxPositionUsd: 25 });
    assert.equal(cfg.bankrollUsd, 100);
    assert.equal(cfg.dailyLossUsd, 25);
    assert.equal(cfg.maxPositionUsd, 25);

    applyPresetKnobs(cfg, "sniper");
    assert.equal(cfg.activePreset, "sniper");
    assert.equal(cfg.stopLossPct, SNIPER_PRESET.stopLossPct);
    assert.equal(cfg.takeProfitPct, SNIPER_PRESET.takeProfitPct);
    assert.equal(cfg.momentum.minAgeMinutes, 0);
    assert.equal(cfg.bankrollUsd, 100, "bankroll must stay sticky");
    assert.equal(cfg.dailyLossUsd, 25, "daily loss must stay sticky");
    assert.equal(cfg.maxPositionUsd, 25, "max position must stay sticky");

    applyPresetKnobs(cfg, "momentum");
    assert.equal(cfg.activePreset, "momentum");
    assert.equal(cfg.stopLossPct, MOMENTUM_PRESET.stopLossPct);
    assert.equal(cfg.bankrollUsd, 100);
    assert.equal(cfg.dailyLossUsd, 25);
    assert.equal(cfg.maxPositionUsd, 25);
  });
});

describe("POST /config/preset keeps sticky risk", () => {
  let dir: string;
  let overlayPath: string;
  let server: Server;
  let base: string;
  let engine: BotEngine;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "sticky-risk-"));
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

  it("sniper then momentum keep 100/25/25 on config + disk", async () => {
    let res = await fetch(`${base}/config/preset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "sniper" }),
    });
    assert.equal(res.status, 200);
    let body = (await res.json()) as { ok: boolean; config: BotConfig; message: string };
    assert.equal(body.ok, true);
    assert.equal(body.config.activePreset, "sniper");
    assert.equal(body.config.bankrollUsd, 100);
    assert.equal(body.config.dailyLossUsd, 25);
    assert.equal(body.config.maxPositionUsd, 25);
    assert.equal(body.config.stopLossPct, 8);
    assert.match(body.message, /sticky/i);

    res = await fetch(`${base}/config/preset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "momentum" }),
    });
    assert.equal(res.status, 200);
    body = (await res.json()) as { ok: boolean; config: BotConfig; message: string };
    assert.equal(body.config.activePreset, "momentum");
    assert.equal(body.config.bankrollUsd, 100);
    assert.equal(body.config.dailyLossUsd, 25);
    assert.equal(body.config.maxPositionUsd, 25);
    assert.equal(body.config.stopLossPct, 10);

    const disk = JSON.parse(readFileSync(overlayPath, "utf8")) as {
      bankrollUsd: number;
      dailyLossUsd: number;
      maxPositionUsd: number;
      activePreset: string;
      stopLossPct: number;
    };
    assert.equal(disk.bankrollUsd, 100);
    assert.equal(disk.dailyLossUsd, 25);
    assert.equal(disk.maxPositionUsd, 25);
    assert.equal(disk.activePreset, "momentum");
    assert.equal(disk.stopLossPct, 10);
  });
});
