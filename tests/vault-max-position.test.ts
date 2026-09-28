import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { sizePosition } from "../src/risk/manager.js";
import { createControlApp } from "../src/api/server.js";
import { applyPresetKnobs } from "../src/presets.js";
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
    momentum: {
      minPct: 5,
      windowMinutes: 5,
      volumeSpikeMult: 2,
      minLiquidityUsd: 5_000,
      minVolume24hUsd: 8_000,
      minAgeMinutes: 3,
    },
    trailingTakeProfit: { activatePct: 10, distancePct: 7 },
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

describe("vault skim reduces tradable cash", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-skim-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skim moves cash to vault; sizing uses tradable only", () => {
    const ledger = new PaperLedger(100, dir);
    assert.equal(ledger.cash, 100);
    assert.equal(ledger.vault, 0);

    const skim = ledger.skim(40);
    assert.equal(skim.ok, true);
    assert.equal(skim.skimmedUsd, 40);
    assert.equal(ledger.cash, 60);
    assert.equal(ledger.vault, 40);
    assert.equal(ledger.tradableCash, 60);

    const snap = ledger.snapshot(new Map());
    assert.equal(snap.cashUsd, 60);
    assert.equal(snap.tradableCashUsd, 60);
    assert.equal(snap.vaultUsd, 40);
    assert.equal(snap.equityUsd, 60);
    assert.equal(snap.totalEquityUsd, 100);

    const sized = sizePosition(
      { cashUsd: ledger.cash, markPrice: 0.001, openCount: 0 },
      baseCfg({ maxPositionUsd: 0 }),
    );
    assert.equal(sized.ok, true);
    // 95% of tradable 60 = 57 — vault 40 never enters sizing
    assert.equal(sized.notionalUsd, 60 * 0.95);

    assert.equal(existsSync(join(dir, "vault.json")), true);
    const disk = JSON.parse(readFileSync(join(dir, "vault.json"), "utf8")) as {
      vaultUsd: number;
    };
    assert.equal(disk.vaultUsd, 40);
  });
});

describe("vault survives /runner/reset", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "vault-reset-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reset restores bankroll cash but keeps vault", async () => {
    const cfg = baseCfg({ ledgerDir: dir, bankrollUsd: 100 });
    const ledger = new PaperLedger(cfg.bankrollUsd, dir);
    ledger.skim(35);
    assert.equal(ledger.vault, 35);
    assert.equal(ledger.cash, 65);

    const engine = new BotEngine(cfg, {
      ledger,
      broker: new PaperBroker(cfg),
    });
    const reset = await engine.reset();
    assert.equal(reset.ok, true);
    assert.equal(reset.portfolio.cashUsd, 100);
    assert.equal(reset.portfolio.vaultUsd, 35);
    assert.equal(reset.portfolio.tradableCashUsd, 100);
    assert.equal(ledger.vault, 35);
    assert.equal(ledger.cash, 100);
    assert.match(reset.message, /vault/i);

    // Reload ledger from same dir — vault.json still has 35
    const reloaded = new PaperLedger(100, dir);
    assert.equal(reloaded.vault, 35);
  });
});

describe("maxPositionUsd caps entry size", () => {
  it("caps notional to maxPositionUsd", () => {
    const cfg = baseCfg({ positionSizePct: 0.95, maxPositionUsd: 25, bankrollUsd: 100 });
    const sized = sizePosition(
      { cashUsd: 100, markPrice: 0.01, openCount: 0 },
      cfg,
    );
    assert.equal(sized.ok, true);
    // min(95, 25, 100) = 25
    assert.equal(sized.notionalUsd, 25);
  });

  it("maxPositionUsd=0 disables the hard cap", () => {
    const cfg = baseCfg({ positionSizePct: 0.95, maxPositionUsd: 0 });
    const sized = sizePosition(
      { cashUsd: 100, markPrice: 0.01, openCount: 0 },
      cfg,
    );
    assert.equal(sized.ok, true);
    assert.equal(sized.notionalUsd, 95);
  });

  it("never exceeds tradable cash even if max is higher", () => {
    const cfg = baseCfg({ positionSizePct: 1, maxPositionUsd: 50 });
    const sized = sizePosition(
      { cashUsd: 20, markPrice: 0.01, openCount: 0 },
      cfg,
    );
    assert.equal(sized.ok, true);
    assert.equal(sized.notionalUsd, 20);
  });
});

describe("maxPositionUsd sticky on preset switch", () => {
  it("applyPresetKnobs preserves maxPositionUsd", () => {
    const cfg = baseCfg({ maxPositionUsd: 20 });
    applyPresetKnobs(cfg, "sniper");
    assert.equal(cfg.maxPositionUsd, 20);
    applyPresetKnobs(cfg, "momentum");
    assert.equal(cfg.maxPositionUsd, 20);
  });
});

describe("vault + max position control API", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let engine: BotEngine;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "vault-api-"));
    const cfg = baseCfg({ ledgerDir: dir, bankrollUsd: 100, maxPositionUsd: 25 });
    engine = new BotEngine(cfg, {
      ledger: new PaperLedger(cfg.bankrollUsd, dir),
      broker: new PaperBroker(cfg),
      runtimeConfigPath: join(dir, "runtime-config.json"),
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

  it("POST /vault/skim amountUsd + GET /portfolio show vault", async () => {
    let res = await fetch(`${base}/vault/skim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUsd: 30 }),
    });
    assert.equal(res.status, 200);
    let body = (await res.json()) as {
      ok: boolean;
      skimmedUsd: number;
      portfolio: { cashUsd: number; vaultUsd: number; tradableCashUsd: number };
    };
    assert.equal(body.ok, true);
    assert.equal(body.skimmedUsd, 30);
    assert.equal(body.portfolio.cashUsd, 70);
    assert.equal(body.portfolio.vaultUsd, 30);
    assert.equal(body.portfolio.tradableCashUsd, 70);

    res = await fetch(`${base}/portfolio`);
    assert.equal(res.status, 200);
    const port = (await res.json()) as {
      bankrollUsd: number;
      maxPositionUsd: number;
      vaultUsd: number;
      tradableCashUsd: number;
      portfolio: { vaultUsd: number; cashUsd: number };
    };
    assert.equal(port.bankrollUsd, 100);
    assert.equal(port.maxPositionUsd, 25);
    assert.equal(port.vaultUsd, 30);
    assert.equal(port.tradableCashUsd, 70);
    assert.equal(port.portfolio.vaultUsd, 30);
  });

  it("percentOfProfit skims cash above bankroll floor", async () => {
    // Return the 30 we skimmed → cash 100, vault 0
    let res = await fetch(`${base}/vault/return`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amountUsd: 30 }),
    });
    assert.equal(res.status, 200);

    // At exactly bankroll — no skimable profit
    res = await fetch(`${base}/vault/skim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ percentOfProfit: 50 }),
    });
    assert.equal(res.status, 400);

    // Inflate cash via a flat sell of proceeds (simulates realized profit in cash)
    engine.ledger.recordSell(
      {
        id: "f1",
        positionId: "none",
        mint: "m",
        symbol: "X",
        side: "sell",
        qty: 0,
        price: 1,
        notionalUsd: 0,
        feesUsd: 0,
        slippageUsd: 0,
        reason: "manual_exit",
        timestamp: Date.now(),
        paper: true,
      },
      80,
      80,
    );
    // cash was 100 + 80 = 180
    res = await fetch(`${base}/vault/skim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ percentOfProfit: 50 }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      skimmedUsd: number;
      portfolio: { cashUsd: number; vaultUsd: number };
    };
    assert.equal(body.ok, true);
    // profit above floor = 180 - 100 = 80; 50% = 40
    assert.equal(body.skimmedUsd, 40);
    assert.equal(body.portfolio.vaultUsd, 40);
    assert.equal(body.portfolio.cashUsd, 140);
  });

  it("reset keeps vault; maxPosition sticky on preset", async () => {
    const beforeVault = (await (await fetch(`${base}/portfolio`)).json()) as {
      vaultUsd: number;
    };
    assert.ok(beforeVault.vaultUsd > 0);

    const reset = await fetch(`${base}/runner/reset`, { method: "POST" });
    assert.equal(reset.status, 200);
    const resetBody = (await reset.json()) as {
      ok: boolean;
      portfolio: { cashUsd: number; vaultUsd: number };
    };
    assert.equal(resetBody.ok, true);
    assert.equal(resetBody.portfolio.cashUsd, 100);
    assert.equal(resetBody.portfolio.vaultUsd, beforeVault.vaultUsd);

    let res = await fetch(`${base}/config`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxPositionUsd: 20 }),
    });
    assert.equal(res.status, 200);

    res = await fetch(`${base}/config/preset`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset: "sniper" }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { config: BotConfig; message: string };
    assert.equal(body.config.maxPositionUsd, 20);
    assert.equal(body.config.bankrollUsd, 100);
    assert.match(body.message, /sticky/i);
  });
});
