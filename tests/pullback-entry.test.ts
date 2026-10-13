import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { PAPER_FEE_DEFAULTS } from "../src/broker/paperFees.js";
import { loadConfig } from "../src/config.js";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import type { MarketDataProvider } from "../src/market/data.js";
import { checkPullback, pullbackActive } from "../src/strategy/pullback.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";

describe("checkPullback (pure)", () => {
  const p = { pct: 5, windowSec: 60 };
  it("waits until the price is pct below the reference, fills at the threshold", () => {
    assert.equal(checkPullback(100, 100, 0, 1000, p), "wait");
    assert.equal(checkPullback(100, 96, 0, 1000, p), "wait");
    assert.equal(checkPullback(100, 95, 0, 1000, p), "fill");
    assert.equal(checkPullback(100, 80, 0, 1000, p), "fill");
  });
  it("expires after the window even if the price dips later; bad reads just wait", () => {
    assert.equal(checkPullback(100, 90, 0, 60_000, p), "fill");
    assert.equal(checkPullback(100, 90, 0, 60_001, p), "expired");
    assert.equal(checkPullback(100, null, 0, 1000, p), "wait");
    assert.equal(checkPullback(100, Number.NaN, 0, 1000, p), "wait");
    assert.equal(checkPullback(100, 0, 0, 1000, p), "wait");
  });
  it("pullbackActive is off for absent, zero or invalid settings", () => {
    assert.equal(pullbackActive(undefined), false);
    assert.equal(pullbackActive({ pct: 0, windowSec: 60 }), false);
    assert.equal(pullbackActive({ pct: 5, windowSec: 0 }), false);
    assert.equal(pullbackActive({ pct: 5, windowSec: 60 }), true);
  });
});

describe("pullback env wiring", () => {
  it("defaults off; env turns it on", () => {
    const keep = [process.env.ENTRY_PULLBACK_PCT, process.env.ENTRY_PULLBACK_WINDOW_S];
    try {
      delete process.env.ENTRY_PULLBACK_PCT;
      delete process.env.ENTRY_PULLBACK_WINDOW_S;
      assert.deepEqual(loadConfig({ skipRuntimeOverlay: true }).pullbackEntry, { pct: 0, windowSec: 60 });
      process.env.ENTRY_PULLBACK_PCT = "5";
      process.env.ENTRY_PULLBACK_WINDOW_S = "45";
      assert.deepEqual(loadConfig({ skipRuntimeOverlay: true }).pullbackEntry, { pct: 5, windowSec: 45 });
    } finally {
      if (keep[0] === undefined) delete process.env.ENTRY_PULLBACK_PCT; else process.env.ENTRY_PULLBACK_PCT = keep[0];
      if (keep[1] === undefined) delete process.env.ENTRY_PULLBACK_WINDOW_S; else process.env.ENTRY_PULLBACK_WINDOW_S = keep[1];
    }
  });
});

// ---------- engine ----------
const MINT = "PullCoin11111111111111111111111111111111111";
const snap = (): TokenSnapshot => ({
  mint: MINT, symbol: "PULL", name: "Pull", priceUsd: 0.0001, changeWindowPct: 50, volumeWindowUsd: 100_000,
  volumeAvgUsd: 1000, volume24hUsd: 1_000_000, liquidityUsd: 1_000_000, timestamp: Date.now(), createdAt: Date.now() - 3_600_000,
});
class OneCoin implements MarketDataProvider {
  async scan(): Promise<TokenSnapshot[]> { return [snap()]; }
  async getPrice() { return 0.0001; }
  async getQuoteUsdRate() { return 100; }
}
/** On-chain reader whose price (SOL) the test moves. 0.000001 SOL x 100 = $0.0001 = the signal price. */
class MovingReader {
  priceSol = 0.000001;
  reads = 0;
  async read(_mint: string) { this.reads++; return { priceSol: this.priceSol, venue: "pumpswap" as const }; }
  drop() {}
}
const cfg = (ledgerDir: string, pullback: { pct: number; windowSec: number } | undefined): BotConfig => ({
  paperMode: true, bankrollUsd: 200, maxOpenTrades: 1, stopLossPct: 8, takeProfitPct: 15, positionSizePct: 0.95, maxPositionUsd: 50,
  momentum: { minPct: 1, windowMinutes: 5, volumeSpikeMult: 1, minLiquidityUsd: 0, minVolume24hUsd: 0, minAgeMinutes: 0 },
  trailingTakeProfit: { activatePct: 10, distancePct: 5 },
  paperBroker: { slippageBps: 50, feeBps: 30, fees: { ...PAPER_FEE_DEFAULTS } },
  runner: { pollIntervalMs: 20, scanLimit: 5, maxCycles: 0 }, maxHoldMinutes: 0, dailyLossUsd: 0, chaseLockoutHours: 0,
  marketDataSource: "mock", ledgerDir, activePreset: "custom", requireChecklistGo: false,
  solanaRpcConfigured: false, solanaRpcWssConfigured: false, rugFilterEnabled: false, rugFilterMaxTopHolderPct: 30, rugFilterMaxSameSlotBuys: 3,
  memory: { enabled: false, minTrades: 40, neighbors: 15, skipAvgPnlPct: -8, maxTrades: 2000 },
  fastExitPollMs: 250,
  ...(pullback ? { pullbackEntry: pullback } : {}),
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withEngine(pullback: { pct: number; windowSec: number } | undefined, body: (e: BotEngine, r: MovingReader) => Promise<void>) {
  const d = mkdtempSync(join(tmpdir(), "pull-"));
  const reader = new MovingReader();
  const e = new BotEngine(cfg(d, pullback), { market: new OneCoin(), solanaWs: null, solanaRpc: null, ledger: new PaperLedger(200, join(d, "paper")), onchainPrice: reader as never });
  try {
    assert.ok((await e.start()).ok);
    await body(e, reader);
  } finally {
    await e.stop();
    await e.stop();
    await e.dispose();
    rmSync(d, { recursive: true, force: true });
  }
}

describe("pullback entry in the paper engine", () => {
  it("off: buys at the signal, no waiting", async () => {
    await withEngine(undefined, async (e) => {
      await sleep(300);
      assert.equal(e.ledger.openPositions.length, 1);
      assert.equal(e.getStatus().pullbackEntry.enabled, false);
      assert.equal(e.getStatus().pullbackEntry.armed, 0);
    });
  });

  it("on: waits while the price is flat or dips less than the threshold, buys after the dip at the dipped price", async () => {
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); origWarn(...a); };
    after(() => { console.warn = origWarn; });
    await withEngine({ pct: 5, windowSec: 10 }, async (e, r) => {
      await sleep(600);
      assert.equal(e.ledger.openPositions.length, 0, "must not buy at the signal");
      assert.equal(e.getStatus().pullbackEntry.waiting, 1);
      assert.equal(e.getStatus().pullbackEntry.enabled, true);
      r.priceSol = 0.00000098; // -2%: not enough
      await sleep(700);
      assert.equal(e.ledger.openPositions.length, 0);
      r.priceSol = 0.00000094; // -6%
      await sleep(900);
      assert.equal(e.ledger.openPositions.length, 1);
      const entry = e.ledger.openPositions[0]!.entryPrice;
      assert.ok(entry < 0.0001 * 0.96, `entry ${entry} should be near the dipped price, not the signal price`);
      assert.ok(entry > 0.0001 * 0.9, `entry ${entry}`);
      const st = e.getStatus().pullbackEntry;
      assert.deepEqual([st.armed, st.filled, st.expired, st.waiting], [1, 1, 0, 0]);
      // The whole buy path ran to the end (journal-side events fire last), and nothing warned.
      assert.ok(e.getAlerts(0).events.some((ev) => ev.type === "position_opened"), "position_opened event");
      assert.deepEqual(warnings.filter((w) => /Pullback|pullback/.test(w)), []);
    });
  });

  it("on: gives up after the window, buys nothing, and does not re-arm the same coin right away", async () => {
    await withEngine({ pct: 5, windowSec: 1 }, async (e) => {
      await sleep(2000);
      assert.equal(e.ledger.openPositions.length, 0);
      const st = e.getStatus().pullbackEntry;
      assert.equal(st.expired, 1);
      assert.equal(st.waiting, 0);
      await sleep(500);
      assert.equal(e.getStatus().pullbackEntry.armed, 1, "coin is in the re-entry cooldown");
    });
  });
});
