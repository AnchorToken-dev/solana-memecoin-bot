import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clampHardDailyLoss,
  HardDailyLossStore,
  HARD_DAILY_LOSS_CEILING_USD,
  nextEtMidnight,
} from "../src/risk/hardDailyLoss.js";
import { loadLiveSettings } from "../src/live/mode.js";
import { loadConfig, applyPaperPatch, parsePaperConfigPatch } from "../src/config.js";
import { BotEngine } from "../src/engine/botEngine.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";

const DISABLE_ATTEMPTS: unknown[] = [0, "0", -1, "-5", -Infinity, Infinity, "Infinity", NaN, "NaN", "abc", "off", "false", "disabled", "none", 301, "1000", 1e12, true, false, {}, [], null];

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "hdl-"));
}

describe("hard daily loss: clamping", () => {
  it("ceiling is 300", () => assert.equal(HARD_DAILY_LOSS_CEILING_USD, 300));
  it("every disable / raise attempt clamps to 300 with a warning", () => {
    for (const v of DISABLE_ATTEMPTS) {
      const c = clampHardDailyLoss(v, "X");
      assert.equal(c.usd, 300, `value ${String(v)}`);
      if (v !== null) assert.ok(c.warning, `warning for ${String(v)}`);
    }
  });
  it("missing → 300 (no warning); valid lower values honoured", () => {
    assert.deepEqual(clampHardDailyLoss(undefined, "X"), { usd: 300, warning: null });
    assert.equal(clampHardDailyLoss(50, "X").usd, 50);
    assert.equal(clampHardDailyLoss("120", "X").usd, 120);
    assert.equal(clampHardDailyLoss(300, "X").usd, 300);
  });
  it("LIVE_DAILY_LOSS_LIMIT_USD defaults to 300 and clamps", () => {
    assert.equal(loadLiveSettings({}).dailyLossLimitUsd, 300);
    for (const v of ["0", "-1", "abc", "5000", "off"]) {
      const s = loadLiveSettings({ LIVE_DAILY_LOSS_LIMIT_USD: v });
      assert.equal(s.dailyLossLimitUsd, 300, v);
      assert.equal(s.warnings.length, 1);
    }
    assert.equal(loadLiveSettings({ LIVE_DAILY_LOSS_LIMIT_USD: "40" }).dailyLossLimitUsd, 40);
  });
  it("env HARD_DAILY_LOSS_USD can only lower; DAILY_LOSS_USD=0 does not disable it", () => {
    const saved = { h: process.env.HARD_DAILY_LOSS_USD, d: process.env.DAILY_LOSS_USD };
    try {
      for (const v of ["0", "-3", "abc", "999", "off", ""]) {
        process.env.HARD_DAILY_LOSS_USD = v;
        assert.equal(loadConfig({ skipRuntimeOverlay: true }).hardDailyLossUsd, 300, v);
      }
      process.env.HARD_DAILY_LOSS_USD = "75";
      assert.equal(loadConfig({ skipRuntimeOverlay: true }).hardDailyLossUsd, 75);
      delete process.env.HARD_DAILY_LOSS_USD;
      process.env.DAILY_LOSS_USD = "0";
      assert.equal(loadConfig({ skipRuntimeOverlay: true }).hardDailyLossUsd, 300);
    } finally {
      if (saved.h === undefined) delete process.env.HARD_DAILY_LOSS_USD; else process.env.HARD_DAILY_LOSS_USD = saved.h;
      if (saved.d === undefined) delete process.env.DAILY_LOSS_USD; else process.env.DAILY_LOSS_USD = saved.d;
    }
  });
  it("runtime overlay file can't raise/disable it", () => {
    const d = tmp();
    try {
      const p = join(d, "rc.json");
      for (const v of [0, -1, "off", 5000, null]) {
        writeFileSync(p, JSON.stringify({ hardDailyLossUsd: v }));
        assert.equal(loadConfig({ runtimePath: p }).hardDailyLossUsd, 300, String(v));
      }
      writeFileSync(p, JSON.stringify({ hardDailyLossUsd: 90 }));
      assert.equal(loadConfig({ runtimePath: p }).hardDailyLossUsd, 90);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("PATCH can't raise/disable it", () => {
    for (const v of [0, -1, "off", 5000, null, false]) {
      const parsed = parsePaperConfigPatch({ hardDailyLossUsd: v });
      assert.ok(parsed.ok, String(v));
      const cfg = { hardDailyLossUsd: 50 } as BotConfig;
      applyPaperPatch(cfg, (parsed as unknown as { patch: never }).patch);
      assert.equal(cfg.hardDailyLossUsd, 300, String(v));
      assert.ok(cfg.hardDailyLossWarnings?.length);
    }
  });
});

describe("hard daily loss: lock", () => {
  it("locks, survives restart, unlocks only at next ET midnight", () => {
    const d = tmp();
    try {
      let now = Date.parse("2026-10-07T15:00:00Z"); // 11:00 ET
      const clock = () => now;
      const a = new HardDailyLossStore(d, clock);
      a.recordClose("paper", -200);
      assert.equal(a.isLocked("paper"), false);
      a.recordClose("paper", -150);
      const st = a.status("paper", 300, 0, []);
      assert.equal(st.todayLossUsd, 350);
      a.lock("paper", 350);
      const b = new HardDailyLossStore(d, clock); // restart
      assert.equal(b.isLocked("paper"), true);
      assert.equal(b.status("paper", 300, 0, []).remainingUsd, 0);
      assert.equal(b.isLocked("live"), false, "modes are separate");
      now = nextEtMidnight(now) - 1;
      assert.equal(new HardDailyLossStore(d, clock).isLocked("paper"), true);
      now += 2;
      const c = new HardDailyLossStore(d, clock);
      assert.equal(c.isLocked("paper"), false);
      assert.equal(c.realizedToday("paper"), 0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("corrupt lock file fails closed for today", () => {
    const d = tmp();
    try {
      writeFileSync(join(d, "hard-daily-loss.json"), "{not json");
      assert.equal(new HardDailyLossStore(d).isLocked("paper"), true);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("unrealized losses count; wins offset realized losses", () => {
    const d = tmp();
    try {
      const s = new HardDailyLossStore(d);
      s.recordClose("paper", -100);
      s.recordClose("paper", 40);
      const st = s.status("paper", 300, 120, []);
      assert.equal(st.todayLossUsd, 180);
      assert.equal(st.remainingUsd, 120);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

class DropMarket implements MarketDataProvider {
  price = 1;
  async scan(): Promise<TokenSnapshot[]> {
    return [{ mint: "So1aMint1111111111111111111111111111111111", symbol: "TST", name: "T", priceUsd: this.price, changeWindowPct: 50, volumeWindowUsd: 1e5, volumeAvgUsd: 1e3, volume24hUsd: 1e6, liquidityUsd: 1e6, timestamp: Date.now(), createdAt: Date.now() - 3.6e6 }];
  }
  async getPrice() { return this.price; }
}

function paperCfg(ledgerDir: string, over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true, bankrollUsd: 1000, maxOpenTrades: 1, stopLossPct: 90, takeProfitPct: 0, positionSizePct: 0.95, maxPositionUsd: 100,
    momentum: { minPct: 1, windowMinutes: 5, volumeSpikeMult: 1, minLiquidityUsd: 0, minVolume24hUsd: 0, minAgeMinutes: 0 },
    trailingTakeProfit: { activatePct: 1000, distancePct: 5 }, paperBroker: { slippageBps: 0, feeBps: 0 },
    runner: { pollIntervalMs: 10, scanLimit: 5, maxCycles: 0 }, maxHoldMinutes: 0, dailyLossUsd: 0, chaseLockoutHours: 0,
    marketDataSource: "mock", ledgerDir, activePreset: "custom", requireChecklistGo: false,
    solanaRpcConfigured: false, solanaRpcWssConfigured: false, rugFilterEnabled: false, rugFilterMaxTopHolderPct: 30, rugFilterMaxSameSlotBuys: 3,
    tradingMode: "paper", hardDailyLossUsd: 20,
    ...over,
  };
}

describe("hard daily loss: engine (paper)", () => {
  it("unrealized drop locks new buys, keeps managing, Reset + restart don't clear", async () => {
    const d = tmp();
    try {
      const market = new DropMarket();
      const e = new BotEngine(paperCfg(d), { market, solanaWs: null, solanaRpc: null });
      e.setTradeSize(60);
      await e.start();
      await new Promise((r) => setTimeout(r, 80));
      assert.equal(e.ledger.openPositions.length, 1);
      market.price = 0.5; // −$30 unrealized on $60 > $20 limit
      await new Promise((r) => setTimeout(r, 3300));
      const st = e.getStatus().hardDailyLoss;
      assert.equal(st.locked, true);
      assert.equal(st.limitUsd, 20);
      assert.ok(e.getAlerts(0, 100).events.some((ev: { title: string }) => /HARD DAILY LOSS/.test(ev.title)));
      // Still managing: exit by hand works while locked.
      const ex = await e.exitNow();
      assert.ok(ex.ok);
      // Reset does not clear
      await e.reset();
      assert.equal(e.getStatus().hardDailyLoss.locked, true);
      // Restart: start again → no new buys
      await e.start();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(e.ledger.openPositions.length, 0);
      await e.stop();
      await e.dispose();
      const e2 = new BotEngine(paperCfg(d, { hardDailyLossUsd: 300 }), { market, solanaWs: null, solanaRpc: null });
      assert.equal(e2.getStatus().hardDailyLoss.locked, true, "raising the limit after a lock does not unlock");
      await e2.dispose();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
  it("default engine shows $300 limit, full room", async () => {
    const d = tmp();
    try {
      const e = new BotEngine(paperCfg(d, { hardDailyLossUsd: undefined }), { market: new DropMarket(), solanaWs: null, solanaRpc: null });
      const st = e.getStatus().hardDailyLoss;
      assert.equal(st.limitUsd, 300);
      assert.equal(st.remainingUsd, 300);
      assert.equal(st.locked, false);
      await e.dispose();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
