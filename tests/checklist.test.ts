import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ResearchChecklistStore,
  computeVerdict,
  defaultItemStates,
  type ChecklistItemState,
} from "../src/checklist/checklist.js";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import { TradeJournal } from "../src/journal/journal.js";
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
    maxPositionUsd: 25,
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
    chaseLockoutHours: 12,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "custom",
    requireChecklistGo: false,
    ...over,
  };
}

function allPass(items: ChecklistItemState[]): ChecklistItemState[] {
  return items.map((i) => ({ ...i, status: "pass" as const }));
}

function mockMarket(priceByMint: Map<string, number>): MarketDataProvider {
  return {
    async scan(): Promise<TokenSnapshot[]> {
      return [...priceByMint.entries()].map(([mint, priceUsd]) => ({
        mint,
        symbol: mint.slice(0, 4).toUpperCase(),
        name: mint,
        priceUsd,
        changeWindowPct: 20,
        volumeWindowUsd: 10_000,
        volumeAvgUsd: 1_000,
        volume24hUsd: 50_000,
        liquidityUsd: 50_000,
        timestamp: Date.now(),
        createdAt: Date.now() - 60_000,
      }));
    },
    async getPrice(mint: string) {
      return priceByMint.get(mint) ?? null;
    },
  };
}

describe("computeVerdict GO / NO-GO / INCOMPLETE", () => {
  it("returns INCOMPLETE when thesis or invalidation empty", () => {
    const items = allPass(defaultItemStates());
    assert.equal(
      computeVerdict({ items, thesis: "", invalidation: "dump" }),
      "INCOMPLETE",
    );
    assert.equal(
      computeVerdict({ items, thesis: "pump", invalidation: "" }),
      "INCOMPLETE",
    );
  });

  it("returns INCOMPLETE when a required item is unset or skip", () => {
    const items = allPass(defaultItemStates());
    const age = items.find((i) => i.id === "token_age")!;
    age.status = "unset";
    assert.equal(
      computeVerdict({ items, thesis: "t", invalidation: "i" }),
      "INCOMPLETE",
    );
    age.status = "skip";
    assert.equal(
      computeVerdict({ items, thesis: "t", invalidation: "i" }),
      "INCOMPLETE",
    );
  });

  it("returns NO-GO when any item fails", () => {
    const items = allPass(defaultItemStates());
    items.find((i) => i.id === "not_clone")!.status = "fail";
    assert.equal(
      computeVerdict({ items, thesis: "t", invalidation: "i" }),
      "NO-GO",
    );
  });

  it("returns GO when all required pass, optional skip, texts set", () => {
    const items = allPass(defaultItemStates());
    items.find((i) => i.id === "holders")!.status = "skip";
    items.find((i) => i.id === "mint_freeze")!.status = "skip";
    assert.equal(
      computeVerdict({
        items,
        thesis: "momentum continuation",
        invalidation: "lose 8% or volume dies",
      }),
      "GO",
    );
  });

  it("optional fail still yields NO-GO", () => {
    const items = allPass(defaultItemStates());
    items.find((i) => i.id === "holders")!.status = "fail";
    assert.equal(
      computeVerdict({ items, thesis: "t", invalidation: "i" }),
      "NO-GO",
    );
  });
});

describe("ResearchChecklistStore unit", () => {
  it("creates, lists, persists, and hasGoForMint", () => {
    const dir = mkdtempSync(join(tmpdir(), "checklist-unit-"));
    try {
      const store = new ResearchChecklistStore(dir);
      const items = allPass(defaultItemStates());
      const created = store.create({
        mint: "MintGO1",
        symbol: "GO1",
        link: "https://dexscreener.com/solana/MintGO1",
        items,
        thesis: "strength",
        invalidation: "stop hit",
      });
      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.equal(created.entry.verdict, "GO");
      assert.equal(existsSync(join(dir, "checklists.json")), true);

      const listed = store.list({ limit: 10 });
      assert.equal(listed.total, 1);
      assert.equal(listed.entries[0]!.verdict, "GO");
      assert.equal(store.hasGoForMint("MintGO1"), true);
      assert.equal(store.hasGoForMint("other"), false);

      const noGo = store.create({
        mint: "MintNO",
        symbol: "NO",
        items: items.map((i) =>
          i.id === "liquidity" ? { ...i, status: "fail" as const } : i,
        ),
        thesis: "x",
        invalidation: "y",
      });
      assert.equal(noGo.ok, true);
      if (noGo.ok) assert.equal(noGo.entry.verdict, "NO-GO");
      assert.equal(store.hasGoForMint("MintNO"), false);

      const reloaded = new ResearchChecklistStore(dir);
      assert.equal(reloaded.list().total, 2);
      assert.equal(reloaded.hasGoForMint("MintGO1"), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("checklist HTTP API", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let engine: BotEngine;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "checklist-api-"));
    const cfg = baseCfg({ ledgerDir: dir });
    engine = new BotEngine(cfg, {
      ledger: new PaperLedger(cfg.bankrollUsd, dir),
      broker: new PaperBroker(cfg),
      journal: new TradeJournal(dir),
      checklist: new ResearchChecklistStore(dir),
      market: mockMarket(new Map([["mint1", 1]])),
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

  it("GET /checklist/template returns default items", async () => {
    const res = await fetch(`${base}/checklist/template`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      items: Array<{ id: string; status: string }>;
      verdict: string;
    };
    assert.ok(body.items.length >= 5);
    assert.equal(body.items[0]!.status, "unset");
    assert.equal(body.verdict, "INCOMPLETE");
  });

  it("POST /checklist creates GO and lists it", async () => {
    const items = allPass(defaultItemStates());
    const res = await fetch(`${base}/checklist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mint: "AbcMint123",
        symbol: "ABC",
        link: "https://pump.fun/coin/AbcMint123",
        items,
        thesis: "continuation",
        invalidation: "break structure",
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      ok: boolean;
      entry: { verdict: string; mint: string; id: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.entry.verdict, "GO");
    assert.equal(body.entry.mint, "AbcMint123");

    const list = (await (await fetch(`${base}/checklist?limit=10`)).json()) as {
      total: number;
      entries: Array<{ id: string; verdict: string }>;
    };
    assert.equal(list.total, 1);
    assert.equal(list.entries[0]!.verdict, "GO");

    const one = await fetch(`${base}/checklist/${body.entry.id}`);
    assert.equal(one.status, 200);
  });

  it("POST /checklist with fail yields NO-GO", async () => {
    const items = allPass(defaultItemStates());
    items.find((i) => i.id === "volume_real")!.status = "fail";
    const res = await fetch(`${base}/checklist`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mint: "BadMint",
        symbol: "BAD",
        items,
        thesis: "nope",
        invalidation: "already no",
      }),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { entry: { verdict: string } };
    assert.equal(body.entry.verdict, "NO-GO");
  });

  it("survives runner reset (file kept)", async () => {
    await engine.reset();
    const disk = JSON.parse(
      readFileSync(join(dir, "checklists.json"), "utf8"),
    ) as unknown[];
    assert.ok(disk.length >= 2);
    const listed = engine.getChecklist({ limit: 50 });
    assert.ok(listed.total >= 2);
  });
});

describe("requireChecklistGo gate", () => {
  it("skips entry when gate on and no GO checklist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checklist-gate-"));
    try {
      const prices = new Map([["mintGate", 1.0]]);
      const cfg = baseCfg({
        ledgerDir: dir,
        requireChecklistGo: true,
        runner: { pollIntervalMs: 20, scanLimit: 5, maxCycles: 1 },
      });
      const engine = new BotEngine(cfg, {
        ledger: new PaperLedger(cfg.bankrollUsd, dir),
        broker: new PaperBroker(cfg),
        journal: new TradeJournal(dir),
        checklist: new ResearchChecklistStore(dir),
        market: mockMarket(prices),
      });
      const started = await engine.start();
      assert.equal(started.ok, true);
      // Wait for maxCycles stop
      for (let i = 0; i < 40; i++) {
        if (engine.getStatus().state === "stopped") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(engine.getStatus().state, "stopped");
      const port = await engine.getPortfolio();
      assert.equal(port.openPositions.length, 0, "must not enter without GO");
      assert.equal(port.tradeCount, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows entry when gate on and GO checklist exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "checklist-gate-go-"));
    try {
      const prices = new Map([["mintGate", 1.0]]);
      const cfg = baseCfg({
        ledgerDir: dir,
        requireChecklistGo: true,
        runner: { pollIntervalMs: 20, scanLimit: 5, maxCycles: 2 },
      });
      const checklist = new ResearchChecklistStore(dir);
      checklist.create({
        mint: "mintGate",
        symbol: "MINT",
        items: allPass(defaultItemStates()),
        thesis: "ok",
        invalidation: "stop",
      });
      const engine = new BotEngine(cfg, {
        ledger: new PaperLedger(cfg.bankrollUsd, dir),
        broker: new PaperBroker(cfg),
        journal: new TradeJournal(dir),
        checklist,
        market: mockMarket(prices),
      });
      const started = await engine.start();
      assert.equal(started.ok, true);
      for (let i = 0; i < 50; i++) {
        if (engine.getStatus().state === "stopped") break;
        await new Promise((r) => setTimeout(r, 50));
      }
      const port = await engine.getPortfolio();
      assert.ok(
        port.openPositions.length === 1 || port.tradeCount >= 1,
        "expected an entry when GO checklist present",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("journal ↔ checklist link", () => {
  it("snapshots latest checklist onto journal close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-checklist-"));
    try {
      const mint = "MintLink1";
      const prices = new Map([[mint, 1.0]]);
      const cfg = baseCfg({
        ledgerDir: dir,
        runner: { pollIntervalMs: 20, scanLimit: 5, maxCycles: 0 },
      });
      const checklist = new ResearchChecklistStore(dir);
      const created = checklist.create({
        mint,
        symbol: "LNK",
        items: allPass(defaultItemStates()),
        thesis: "continuation after reclaim",
        invalidation: "loss of local high",
      });
      assert.equal(created.ok, true);
      if (!created.ok) return;

      const journal = new TradeJournal(dir);
      const engine = new BotEngine(cfg, {
        ledger: new PaperLedger(cfg.bankrollUsd, dir),
        broker: new PaperBroker(cfg),
        journal,
        checklist,
        market: mockMarket(prices),
      });

      // Seed an open position via broker/ledger, then manual exit.
      const { fill, position } = engine.broker.applyBuy({
        mint,
        symbol: "LNK",
        markPrice: 1.0,
        notionalUsd: 20,
      });
      engine.ledger.recordBuy(fill, position);

      prices.set(mint, 1.1);
      const exited = await engine.exitNow();
      assert.equal(exited.ok, true);

      const listed = await engine.getJournal({ limit: 10 });
      assert.equal(listed.total, 1);
      const row = listed.entries[0]!;
      assert.equal(row.mint, mint);
      assert.equal(row.checklistId, created.entry.id);
      assert.equal(row.checklistVerdict, "GO");
      assert.match(row.checklistThesis ?? "", /continuation/);

      // Disk round-trip keeps checklist snapshot.
      const disk = JSON.parse(
        readFileSync(join(dir, "journal.json"), "utf8"),
      ) as Array<{ checklistId?: string; checklistVerdict?: string }>;
      assert.equal(disk[0]!.checklistId, created.entry.id);
      assert.equal(disk[0]!.checklistVerdict, "GO");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("journals null checklist fields when no research row exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "journal-nocheck-"));
    try {
      const mint = "MintNoCl";
      const prices = new Map([[mint, 1.0]]);
      const cfg = baseCfg({ ledgerDir: dir });
      const engine = new BotEngine(cfg, {
        ledger: new PaperLedger(cfg.bankrollUsd, dir),
        broker: new PaperBroker(cfg),
        journal: new TradeJournal(dir),
        checklist: new ResearchChecklistStore(dir),
        market: mockMarket(prices),
      });
      const { fill, position } = engine.broker.applyBuy({
        mint,
        symbol: "NOC",
        markPrice: 1.0,
        notionalUsd: 10,
      });
      engine.ledger.recordBuy(fill, position);
      const exited = await engine.exitNow();
      assert.equal(exited.ok, true);
      const listed = await engine.getJournal({ limit: 5 });
      const row = listed.entries[0]!;
      assert.equal(row.checklistId, null);
      assert.equal(row.checklistVerdict, null);
      assert.equal(row.checklistThesis, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
