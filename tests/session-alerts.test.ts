import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { SessionEventBus } from "../src/alerts/sessionEvents.js";
import { createControlApp } from "../src/api/server.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";
import type { Server } from "node:http";

function baseCfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true,
    bankrollUsd: 100,
    maxOpenTrades: 1,
    stopLossPct: 10,
    takeProfitPct: 25,
    positionSizePct: 0.95,
    momentum: {
      minPct: 1,
      windowMinutes: 5,
      volumeSpikeMult: 1,
      minLiquidityUsd: 0,
      minVolume24hUsd: 0,
      minAgeMinutes: 0,
    },
    trailingTakeProfit: { activatePct: 50, distancePct: 5 },
    paperBroker: { slippageBps: 0, feeBps: 0 },
    runner: { pollIntervalMs: 50, scanLimit: 5, maxCycles: 0 },
    maxHoldMinutes: 0,
    dailyLossUsd: 25,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "custom",
    ...over,
  };
}

describe("SessionEventBus", () => {
  it("filters by since timestamp", () => {
    const bus = new SessionEventBus();
    const a = bus.push("bot_started", "Started", "go");
    const b = bus.push("bot_stopped", "Stopped", "done");
    assert.equal(bus.since(0).length, 2);
    assert.equal(bus.since(a.timestamp).length, 1);
    assert.equal(bus.since(a.timestamp)[0]!.id, b.id);
    assert.equal(bus.since(b.timestamp).length, 0);
  });
});

describe("engine emits session alerts", () => {
  let dir: string;
  let engine: BotEngine;
  let prices: Map<string, number>;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), "alerts-eng-"));
    prices = new Map([["mint1", 1.0]]);
    const market: MarketDataProvider = {
      async scan(): Promise<TokenSnapshot[]> {
        return [];
      },
      async getPrice(mint: string) {
        return prices.get(mint) ?? null;
      },
    };
    const cfg = baseCfg({ ledgerDir: dir });
    engine = new BotEngine(cfg, {
      ledger: new PaperLedger(cfg.bankrollUsd, dir),
      broker: new PaperBroker(cfg),
      market,
      events: new SessionEventBus(),
    });
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits bot_started, position close exit_manual, bot_stopped", async () => {
    const t0 = Date.now() - 1;
    const started = await engine.start();
    assert.equal(started.ok, true);
    let ev = engine.getAlerts(t0).events;
    assert.ok(ev.some((e) => e.type === "bot_started"));

    const { fill, position } = engine.broker.applyBuy({
      mint: "mint1",
      symbol: "AAA",
      markPrice: 1,
      notionalUsd: 40,
    });
    engine.ledger.recordBuy(fill, position);
    prices.set("mint1", 1.1);
    const exited = await engine.exitNow();
    assert.equal(exited.ok, true);
    ev = engine.getAlerts(t0).events;
    assert.ok(
      ev.some((e) => e.type === "exit_manual"),
      "manual exit event",
    );
    assert.ok(ev.some((e) => e.body.includes("AAA")));

    await engine.stop();
    ev = engine.getAlerts(t0).events;
    assert.ok(ev.some((e) => e.type === "bot_stopped"));
  });
});

describe("GET /alerts", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let engine: BotEngine;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "alerts-api-"));
    const cfg = baseCfg({ ledgerDir: dir });
    engine = new BotEngine(cfg, {
      ledger: new PaperLedger(cfg.bankrollUsd, dir),
      broker: new PaperBroker(cfg),
      events: new SessionEventBus(),
    });
    await engine.start();
    await engine.stop();
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

  it("returns events after start/stop", async () => {
    const res = await fetch(`${base}/alerts?since=0`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      events: Array<{ type: string }>;
    };
    assert.ok(body.events.some((e) => e.type === "bot_started"));
    assert.ok(body.events.some((e) => e.type === "bot_stopped"));
  });
});
