import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChaseLockoutStore,
  isFullDepositLoss,
  isSessionZeroed,
} from "../src/risk/chaseLockout.js";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { createControlApp } from "../src/api/server.js";
import { applyPresetKnobs } from "../src/presets.js";
import type { BotConfig, Fill } from "../src/types.js";
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
    dailyLossUsd: 25,
    chaseLockoutHours: 12,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "custom",
    requireChecklistGo: false,
    ...over,
  };
}

function lossFill(pnlTag = "full"): Fill {
  return {
    id: `fill-${pnlTag}`,
    positionId: `pos-${pnlTag}`,
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

describe("chase lockout helpers", () => {
  it("isFullDepositLoss uses ORIGINAL deposit, not growing equity", () => {
    // $100 original — lose $100 → lock. Peak equity $200 is irrelevant.
    assert.equal(isFullDepositLoss(-99.99, 100), false);
    assert.equal(isFullDepositLoss(-100, 100), true);
    assert.equal(isFullDepositLoss(-150, 100), true);
    assert.equal(isFullDepositLoss(-200, 0), false);
  });

  it("isSessionZeroed requires flat + dust cash + full deposit loss", () => {
    assert.equal(
      isSessionZeroed({
        cashUsd: 0,
        openCount: 0,
        realizedPnlUsd: -100,
        originalDepositUsd: 100,
      }),
      true,
    );
    assert.equal(
      isSessionZeroed({
        cashUsd: 50,
        openCount: 0,
        realizedPnlUsd: -100,
        originalDepositUsd: 100,
      }),
      false,
    );
    assert.equal(
      isSessionZeroed({
        cashUsd: 0,
        openCount: 1,
        realizedPnlUsd: -100,
        originalDepositUsd: 100,
      }),
      false,
    );
  });
});

describe("ChaseLockoutStore persistence (laptop/API side)", () => {
  let dir: string;
  let now = 1_700_000_000_000;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "chase-lock-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("engages, persists to disk, survives new store instance", () => {
    const store = new ChaseLockoutStore(dir, { now: () => now });
    const st = store.engage({
      originalDepositUsd: 100,
      lockoutHours: 12,
      reason: "test full loss",
      nowMs: now,
    });
    assert.equal(st.active, true);
    assert.equal(st.unlockAt, now + 12 * 3_600_000);
    assert.ok(existsSync(join(dir, "chase-lockout.json")));

    const reloaded = new ChaseLockoutStore(dir, { now: () => now + 60_000 });
    const again = reloaded.getStatus();
    assert.equal(again.active, true);
    assert.equal(again.unlockAt, now + 12 * 3_600_000);
    assert.equal(again.originalDepositUsd, 100);
  });

  it("timer unlocks without manual clear", () => {
    const sub = join(dir, "timer");
    const t0 = now + 10_000_000; // independent clock from prior case
    const store = new ChaseLockoutStore(sub, { now: () => t0 });
    store.engage({
      originalDepositUsd: 100,
      lockoutHours: 1,
      reason: "short",
      nowMs: t0,
    });
    assert.equal(store.isLocked(t0 + 30 * 60_000), true);
    assert.equal(store.isLocked(t0 + 61 * 60_000), false);
  });

  it("hours=0 disables engage", () => {
    const sub = join(dir, "disabled");
    const store = new ChaseLockoutStore(sub, { now: () => now });
    const st = store.engage({
      originalDepositUsd: 100,
      lockoutHours: 0,
      reason: "off",
      nowMs: now,
    });
    assert.equal(st.active, false);
  });
});

describe("engine: full deposit loss → chase lockout; reset does not clear", () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "chase-eng-"));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("start refuses while locked; reset clears ledger but NOT lockout", async () => {
    const cfg = baseCfg({
      ledgerDir: dir,
      bankrollUsd: 100,
      dailyLossUsd: 100, // allow full wipe via daily cap path too
      chaseLockoutHours: 12,
    });
    const ledger = new PaperLedger(cfg.bankrollUsd, dir);
    // Simulate blowing the full original $100 deposit (not peak equity).
    ledger.recordSell(lossFill(), -100, 0);
    assert.ok(ledger.realizedPnl <= -100);

    const engine = new BotEngine(cfg, {
      ledger,
      broker: new PaperBroker(cfg),
    });

    // Evaluate lockout as the loop would after a wipe.
    const engaged = engine.chaseLockout.evaluateAndMaybeEngage({
      realizedPnlUsd: ledger.realizedPnl,
      cashUsd: ledger.cash,
      openCount: ledger.openPositions.length,
      originalDepositUsd: cfg.bankrollUsd,
      lockoutHours: cfg.chaseLockoutHours,
    });
    assert.equal(engaged.active, true);
    assert.ok(engaged.unlockAt != null);

    const blocked = await engine.start();
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /chase lockout/i);
    assert.equal(blocked.status.chaseLockout.active, true);

    const reset = await engine.reset();
    assert.equal(reset.ok, true);
    assert.equal(reset.portfolio.cashUsd, 100);
    assert.equal(reset.portfolio.realizedPnlUsd, 0);
    assert.equal(reset.status.chaseLockout.active, true, "reset must NOT clear chase lockout");
    assert.match(reset.message, /chase lockout STILL ACTIVE/i);

    const stillBlocked = await engine.start();
    assert.equal(stillBlocked.ok, false);
    assert.match(stillBlocked.message, /chase lockout/i);

    // Disk lock file still present after reset
    const disk = JSON.parse(
      readFileSync(join(dir, "chase-lockout.json"), "utf8"),
    ) as { unlockAt?: number };
    assert.ok(typeof disk.unlockAt === "number");
  });

  it("partial daily loss does NOT engage chase lockout", async () => {
    const sub = join(dir, "partial");
    const cfg = baseCfg({
      ledgerDir: sub,
      bankrollUsd: 100,
      dailyLossUsd: 25,
      chaseLockoutHours: 12,
    });
    const ledger = new PaperLedger(cfg.bankrollUsd, sub);
    ledger.recordSell(lossFill("partial"), -25, 0);
    const engine = new BotEngine(cfg, {
      ledger,
      broker: new PaperBroker(cfg),
    });
    const st = engine.chaseLockout.evaluateAndMaybeEngage({
      realizedPnlUsd: ledger.realizedPnl,
      cashUsd: ledger.cash,
      openCount: 0,
      originalDepositUsd: cfg.bankrollUsd,
      lockoutHours: cfg.chaseLockoutHours,
    });
    assert.equal(st.active, false);
  });
});

describe("GET /lockout + /status expose unlock-at; sticky preset", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let engine: BotEngine;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "chase-api-"));
    const cfg = baseCfg({ ledgerDir: dir, chaseLockoutHours: 12, bankrollUsd: 100 });
    const ledger = new PaperLedger(cfg.bankrollUsd, dir);
    ledger.recordSell(lossFill("api"), -100, 0);
    engine = new BotEngine(cfg, {
      ledger,
      broker: new PaperBroker(cfg),
    });
    engine.chaseLockout.evaluateAndMaybeEngage({
      realizedPnlUsd: -100,
      cashUsd: ledger.cash,
      openCount: 0,
      originalDepositUsd: 100,
      lockoutHours: 12,
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

  it("GET /status and /lockout show active + unlockAt", async () => {
    const status = (await (await fetch(`${base}/status`)).json()) as {
      chaseLockout: { active: boolean; unlockAt: number | null };
    };
    assert.equal(status.chaseLockout.active, true);
    assert.ok(status.chaseLockout.unlockAt != null);

    const lock = (await (await fetch(`${base}/lockout`)).json()) as {
      chaseLockout: { active: boolean; unlockAt: number | null };
      originalDepositUsd: number;
    };
    assert.equal(lock.chaseLockout.active, true);
    assert.equal(lock.originalDepositUsd, 100);

    const port = (await (await fetch(`${base}/portfolio`)).json()) as {
      chaseLockout: { active: boolean };
    };
    assert.equal(port.chaseLockout.active, true);
  });

  it("POST /runner/start returns 403 while locked", async () => {
    const res = await fetch(`${base}/runner/start`, { method: "POST" });
    assert.equal(res.status, 403);
    const body = (await res.json()) as { ok: boolean; message: string };
    assert.equal(body.ok, false);
    assert.match(body.message, /chase lockout/i);
  });

  it("POST /runner/reset keeps lockout active", async () => {
    const res = await fetch(`${base}/runner/reset`, { method: "POST" });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok: boolean;
      message: string;
      status: { chaseLockout: { active: boolean } };
      portfolio: { cashUsd: number; realizedPnlUsd: number };
    };
    assert.equal(body.ok, true);
    assert.equal(body.portfolio.cashUsd, 100);
    assert.equal(body.portfolio.realizedPnlUsd, 0);
    assert.equal(body.status.chaseLockout.active, true);
    assert.match(body.message, /STILL ACTIVE/i);
  });

  it("chaseLockoutHours is sticky across presets", () => {
    const cfg = baseCfg({ chaseLockoutHours: 18, bankrollUsd: 100 });
    applyPresetKnobs(cfg, "sniper");
    assert.equal(cfg.chaseLockoutHours, 18);
    applyPresetKnobs(cfg, "momentum");
    assert.equal(cfg.chaseLockoutHours, 18);
    assert.equal(cfg.bankrollUsd, 100);
  });
});
