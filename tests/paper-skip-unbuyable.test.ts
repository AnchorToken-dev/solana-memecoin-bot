/**
 * Paper skips coins LIVE can't buy (non-SOL pairs, thin PumpSwap pools), using
 * only scan data, and cools them down like live. PAPER_SKIP_UNBUYABLE=false
 * restores the old "paper buys anything" behaviour.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPaperBuyable } from "../src/risk/paperBuyable.js";
import { PUMPSWAP_THIN_POOL_FLOOR_SOL } from "../src/live/pumpswapPool.js";
import { dexPoolFields } from "../src/market/pumpfun.js";
import { loadConfig } from "../src/config.js";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";

const WSOL = "So11111111111111111111111111111111111111112";
const SYS = "11111111111111111111111111111111";
const SPYX = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

describe("checkPaperBuyable", () => {
  it("SOL pairs (wSOL / System Program id / unknown) are buyable", () => {
    assert.ok(checkPaperBuyable({ quoteMint: WSOL }).ok);
    assert.ok(checkPaperBuyable({ quoteMint: SYS }).ok);
    assert.ok(checkPaperBuyable({}).ok);
    assert.ok(checkPaperBuyable(undefined).ok);
  });
  it("non-SOL pair → unsupported_quote", () => {
    const r = checkPaperBuyable({ quoteMint: SPYX, venue: "bonding_curve" });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.kind, "unsupported_quote");
  });
  it("PumpSwap pool under the ~29 SOL floor → pool_too_thin; curve coins and unknown depth pass", () => {
    assert.ok(Math.abs(PUMPSWAP_THIN_POOL_FLOOR_SOL - 29.33) < 0.01);
    const thin = checkPaperBuyable({ venue: "pumpswap", poolQuoteSol: 20 });
    assert.equal(!thin.ok && thin.kind, "pool_too_thin");
    assert.ok(checkPaperBuyable({ venue: "pumpswap", poolQuoteSol: 40 }).ok);
    assert.ok(checkPaperBuyable({ venue: "bonding_curve", poolQuoteSol: 5 }).ok);
    assert.ok(checkPaperBuyable({ venue: "pumpswap" }).ok);
  });
});

describe("DexScreener pool fields (from the pair we already fetch)", () => {
  it("SOL-quoted pumpswap → quote mint + real SOL; other pairs → quote mint only", () => {
    assert.deepEqual(dexPoolFields({ dexId: "pumpswap", quoteToken: { address: WSOL }, liquidity: { quote: 54.7 } }), { quoteMint: WSOL, poolQuoteSol: 54.7 });
    assert.deepEqual(dexPoolFields({ dexId: "pumpswap", quoteToken: { address: SPYX }, liquidity: { quote: 162 } }), { quoteMint: SPYX });
    assert.deepEqual(dexPoolFields({ dexId: "pumpfun", quoteToken: { address: WSOL } }), { quoteMint: WSOL });
    assert.deepEqual(dexPoolFields({}), {});
  });
});

describe("PAPER_SKIP_UNBUYABLE switch", () => {
  it("on by default; false/0/off turns it off", () => {
    const old = process.env.PAPER_SKIP_UNBUYABLE;
    try {
      delete process.env.PAPER_SKIP_UNBUYABLE;
      assert.equal(loadConfig({ skipRuntimeOverlay: true }).paperBroker.skipUnbuyable, true);
      for (const v of ["false", "0", "OFF", "no"]) {
        process.env.PAPER_SKIP_UNBUYABLE = v;
        assert.equal(loadConfig({ skipRuntimeOverlay: true }).paperBroker.skipUnbuyable, false, v);
      }
      process.env.PAPER_SKIP_UNBUYABLE = "true";
      assert.equal(loadConfig({ skipRuntimeOverlay: true }).paperBroker.skipUnbuyable, true);
    } finally {
      if (old === undefined) delete process.env.PAPER_SKIP_UNBUYABLE;
      else process.env.PAPER_SKIP_UNBUYABLE = old;
    }
  });
});

// ---------- engine ----------
function snap(mint: string, change: number, extra: Partial<TokenSnapshot> = {}): TokenSnapshot {
  return {
    mint, symbol: mint.slice(0, 4), name: mint, priceUsd: 0.0001, changeWindowPct: change, volumeWindowUsd: 100_000,
    volumeAvgUsd: 1000, volume24hUsd: 1_000_000, liquidityUsd: 1_000_000, timestamp: Date.now(), createdAt: Date.now() - 3_600_000,
    ...extra,
  };
}
class ThreeCoins implements MarketDataProvider {
  scans = 0;
  async scan(): Promise<TokenSnapshot[]> {
    this.scans++;
    return [
      snap("StockPairedCoin11111111111111111111111111", 90, { quoteMint: SPYX }),
      snap("ThinPoolCoin1111111111111111111111111111111", 80, { venue: "pumpswap", poolQuoteSol: 12 }),
      snap("GoodCoin11111111111111111111111111111111111", 50, { venue: "pumpswap", poolQuoteSol: 120, quoteMint: SYS }),
    ];
  }
  async getPrice() { return 0.0001; }
  async getQuoteUsdRate() { return 150; }
}
function paperCfg(ledgerDir: string, skipUnbuyable: boolean | undefined): BotConfig {
  return {
    paperMode: true, bankrollUsd: 200, maxOpenTrades: 1, stopLossPct: 8, takeProfitPct: 15, positionSizePct: 0.95, maxPositionUsd: 50,
    momentum: { minPct: 1, windowMinutes: 5, volumeSpikeMult: 1, minLiquidityUsd: 0, minVolume24hUsd: 0, minAgeMinutes: 0 },
    trailingTakeProfit: { activatePct: 10, distancePct: 5 },
    paperBroker: { slippageBps: 50, feeBps: 30, ...(skipUnbuyable === undefined ? {} : { skipUnbuyable }) },
    runner: { pollIntervalMs: 10, scanLimit: 5, maxCycles: 0 }, maxHoldMinutes: 0, dailyLossUsd: 0, chaseLockoutHours: 0,
    marketDataSource: "mock", ledgerDir, activePreset: "custom", requireChecklistGo: false,
    solanaRpcConfigured: false, solanaRpcWssConfigured: false, rugFilterEnabled: false, rugFilterMaxTopHolderPct: 30, rugFilterMaxSameSlotBuys: 3,
  };
}
async function runOnce(skipUnbuyable: boolean | undefined) {
  const d = mkdtempSync(join(tmpdir(), "paper-unbuyable-"));
  try {
    const e = new BotEngine(paperCfg(d, skipUnbuyable), { market: new ThreeCoins(), solanaWs: null, solanaRpc: null, ledger: new PaperLedger(200, join(d, "paper")) });
    const started = await e.start();
    assert.ok(started.ok, started.message);
    await new Promise((r) => setTimeout(r, 150));
    await e.stop();
    await e.stop();
    const opened = e.ledger.openPositions.map((p) => p.mint);
    const blocked = ["StockPairedCoin11111111111111111111111111", "ThinPoolCoin1111111111111111111111111111111"].map((m) => e.buyCooldowns.blocked(m, Date.now())?.kind ?? null);
    await e.dispose();
    return { opened, blocked };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

describe("engine in PAPER", () => {
  it("skips the non-SOL pair and the thin pool, buys the next coin, and cools the skipped ones down", async () => {
    const r = await runOnce(true);
    assert.deepEqual(r.opened, ["GoodCoin11111111111111111111111111111111111"]);
    assert.deepEqual(r.blocked, ["unsupported_quote", "pool_too_thin"]);
  });
  it("switch off (or absent in an old config) → old behaviour: buys the strongest signal", async () => {
    for (const v of [false, undefined]) {
      const r = await runOnce(v);
      assert.deepEqual(r.opened, ["StockPairedCoin11111111111111111111111111"]);
      assert.deepEqual(r.blocked, [null, null]);
    }
  });
});
