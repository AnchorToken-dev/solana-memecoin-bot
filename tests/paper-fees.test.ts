import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAPER_FEE_DEFAULTS,
  computeBuyCosts,
  computeSellCosts,
  estimateRoundTripFeesUsd,
  exitLiquidityUsd,
  loadPaperFeeSettings,
  pumpSwapTierFeeBps,
  slippageBps,
  venueFeeBps,
  type PaperFeeSettings,
} from "../src/broker/paperFees.js";
import { PaperBroker } from "../src/broker/paper.js";
import { loadConfig } from "../src/config.js";
import { TradeJournal } from "../src/journal/journal.js";
import type { BotConfig } from "../src/types.js";

const SOL = 116;
const D: PaperFeeSettings = { ...PAPER_FEE_DEFAULTS };
const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b} (±${eps})`);

function cfg(fees?: PaperFeeSettings, slippageBps = 50, feeBps = 30): BotConfig {
  return {
    paperMode: true,
    bankrollUsd: 200,
    maxOpenTrades: 1,
    stopLossPct: 8,
    takeProfitPct: 15,
    positionSizePct: 0.95,
    maxPositionUsd: 15,
    momentum: { minPct: 4, windowMinutes: 5, volumeSpikeMult: 1.5, minLiquidityUsd: 2000, minVolume24hUsd: 3000, minAgeMinutes: 0 },
    trailingTakeProfit: { activatePct: 8, distancePct: 4 },
    paperBroker: { slippageBps, feeBps, ...(fees ? { fees } : {}) },
    runner: { pollIntervalMs: 1000, scanLimit: 10, maxCycles: 0 },
    maxHoldMinutes: 10,
    dailyLossUsd: 0,
    chaseLockoutHours: 0,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "custom",
    requireChecklistGo: false,
  };
}

describe("paper fees: documented defaults", () => {
  it("defaults match the documented rates", () => {
    assert.equal(D.model, "realistic");
    assert.equal(D.pumpCurveFeeBps, 125); // pump.fun bonding curve 1.25%
    assert.equal(D.pumpSwapFeeBps, null); // official tier table
    assert.equal(D.pumpPortalFeeBps, 50); // PumpPortal Local API 0.5%
    assert.equal(D.baseFeeSol, 0.000005); // 5,000 lamports / signature
    assert.equal(D.priorityFeeSol, 0.0002); // LIVE_PRIORITY_FEE_SOL default
    close(D.tokenAccountRentSol, 0.00148844); // live mainnet value, SIMD-0437 step 2
    assert.equal(D.slippageModel, "liquidity");
    assert.equal(D.defaultVenue, "bonding_curve");
  });

  it("a $15 round trip costs ≈ $0.74 in fees (≈ 5%) at SOL $116", () => {
    const fees = estimateRoundTripFeesUsd(D, 15, SOL);
    assert.ok(fees > 0.72 && fees < 0.76, `fees=${fees}`);
    // Old flat model was ~$0.09 fees + ~$0.15 slippage ≈ $0.24.
  });
});

describe("paper fees: buy math", () => {
  it("itemises every buy cost and buys tokens with the rest", () => {
    const b = computeBuyCosts(D, { notionalUsd: 15, markPrice: 0.001, solUsd: SOL, flatSlippageBps: 50 });
    const bd = b.breakdown;
    close(bd.venueFeeUsd, 15 * 0.0125);
    close(bd.pumpPortalFeeUsd, 15 * 0.005);
    close(bd.networkFeeUsd, (0.000005 + 0.0002) * SOL);
    close(bd.rentUsd, 0.00148844 * SOL);
    close(bd.totalFeesUsd, bd.venueFeeUsd + bd.pumpPortalFeeUsd + bd.networkFeeUsd + bd.rentUsd);
    // No liquidity → flat SLIPPAGE_BPS fallback.
    assert.equal(bd.slippageBps, 50);
    close(b.fillPrice, 0.001 * 1.005, 1e-12);
    close(b.qty, (15 - bd.totalFeesUsd) / b.fillPrice, 1e-3);
  });

  it("slippage moves the price only — never also counted as a fee", () => {
    const withSlip = computeBuyCosts(D, { notionalUsd: 15, markPrice: 1, solUsd: SOL, flatSlippageBps: 200 });
    const noSlip = computeBuyCosts(D, { notionalUsd: 15, markPrice: 1, solUsd: SOL, flatSlippageBps: 0 });
    close(withSlip.breakdown.totalFeesUsd, noSlip.breakdown.totalFeesUsd);
    assert.ok(withSlip.qty < noSlip.qty);
    close(withSlip.qty * 1.02, noSlip.qty, 1e-9);
  });

  it("falls back to solUsdFallback when no SOL price is known", () => {
    const b = computeBuyCosts(D, { notionalUsd: 15, markPrice: 1, solUsd: null, flatSlippageBps: 0 });
    assert.equal(b.breakdown.solUsd, D.solUsdFallback);
  });
});

describe("paper fees: sell math", () => {
  it("charges venue + PumpPortal on the sale and network fee, but no rent", () => {
    const s = computeSellCosts(D, { qty: 10_000, markPrice: 0.0015, solUsd: SOL, flatSlippageBps: 0 });
    close(s.grossUsd, 15);
    close(s.breakdown.venueFeeUsd, 15 * 0.0125);
    close(s.breakdown.pumpPortalFeeUsd, 15 * 0.005);
    close(s.breakdown.networkFeeUsd, 0.000205 * SOL);
    assert.equal(s.breakdown.rentUsd, 0);
    close(s.proceedsUsd, 15 - s.breakdown.totalFeesUsd);
  });

  it("dust sells never go negative", () => {
    const s = computeSellCosts(D, { qty: 1, markPrice: 0.0000001, solUsd: SOL, flatSlippageBps: 0 });
    assert.ok(s.proceedsUsd >= 0);
    close(s.proceedsUsd, 0);
  });
});

describe("paper fees: venue / PumpSwap tiers", () => {
  it("uses pump.fun's canonical PumpSwap tier table by market cap in SOL", () => {
    assert.equal(pumpSwapTierFeeBps(0), 125);
    assert.equal(pumpSwapTierFeeBps(419), 125);
    assert.equal(pumpSwapTierFeeBps(420), 120);
    assert.equal(pumpSwapTierFeeBps(5_000), 100);
    assert.equal(pumpSwapTierFeeBps(60_000), 50);
    assert.equal(pumpSwapTierFeeBps(1_000_000), 30);
  });

  it("bonding curve is always 1.25%; graduated coins use the tier (or a flat override)", () => {
    // price 0.0001 × 1B supply = $100k mcap ≈ 862 SOL → 1.20%
    assert.equal(venueFeeBps(D, "bonding_curve", 0.0001, SOL), 125);
    assert.equal(venueFeeBps(D, "pumpswap", 0.0001, SOL), 120);
    assert.equal(venueFeeBps({ ...D, pumpSwapFeeBps: 30 }, "pumpswap", 0.0001, SOL), 30);
  });
});

describe("paper fees: slippage model", () => {
  it("liquidity model = base + size/liquidity, capped", () => {
    close(slippageBps(D, 15, 5_000, 50), 25 + 30);
    close(slippageBps(D, 15, 2_000, 50), 25 + 75);
    assert.equal(slippageBps(D, 15, 10, 50), 300); // cap
    assert.equal(slippageBps(D, 15, undefined, 50), 50); // unknown → flat
    assert.equal(slippageBps(D, 15, 0, 50), 50);
  });

  it("bigger trades in the same pool slip more", () => {
    assert.ok(slippageBps(D, 60, 5_000, 50) > slippageBps(D, 15, 5_000, 50));
  });

  it("flat model ignores liquidity", () => {
    assert.equal(slippageBps({ ...D, slippageModel: "flat" }, 15, 5_000, 40), 40);
  });

  it("exit liquidity scales with √price in a constant-product pool", () => {
    close(exitLiquidityUsd(10_000, 1, 4)!, 20_000);
    assert.equal(exitLiquidityUsd(undefined, 1, 2), undefined);
  });
});

describe("paper fees: toggles from env", () => {
  it("empty env → documented defaults", () => {
    assert.deepEqual(loadPaperFeeSettings({}), { ...PAPER_FEE_DEFAULTS });
  });

  it("PumpPortal fee can be turned off", () => {
    const s = loadPaperFeeSettings({ PAPER_PUMPPORTAL_FEE_BPS: "0" });
    assert.equal(s.pumpPortalFeeBps, 0);
    const b = computeBuyCosts(s, { notionalUsd: 15, markPrice: 1, solUsd: SOL, flatSlippageBps: 0 });
    assert.equal(b.breakdown.pumpPortalFeeUsd, 0);
    assert.ok(estimateRoundTripFeesUsd(s, 15, SOL) < estimateRoundTripFeesUsd(D, 15, SOL) - 0.14);
  });

  it("reads every knob", () => {
    const s = loadPaperFeeSettings({
      PAPER_FEE_MODEL: "legacy",
      PAPER_PUMP_FEE_BPS: "100",
      PAPER_PUMPSWAP_FEE_BPS: "30",
      PAPER_BASE_FEE_SOL: "0.00001",
      PAPER_PRIORITY_FEE_SOL: "0.001",
      PAPER_TOKEN_ACCOUNT_RENT_SOL: "0",
      PAPER_SLIPPAGE_MODEL: "flat",
      PAPER_SLIPPAGE_BASE_BPS: "10",
      PAPER_SLIPPAGE_MAX_BPS: "500",
      PAPER_DEFAULT_VENUE: "pumpswap",
      PAPER_SOL_USD_FALLBACK: "200",
    });
    assert.deepEqual(s, {
      model: "legacy",
      pumpCurveFeeBps: 100,
      pumpSwapFeeBps: 30,
      pumpPortalFeeBps: 50,
      baseFeeSol: 0.00001,
      priorityFeeSol: 0.001,
      tokenAccountRentSol: 0,
      slippageModel: "flat",
      slippageBaseBps: 10,
      slippageMaxBps: 500,
      defaultVenue: "pumpswap",
      solUsdFallback: 200,
    });
  });

  it("priority fee follows LIVE_PRIORITY_FEE_SOL unless PAPER_PRIORITY_FEE_SOL is set", () => {
    assert.equal(loadPaperFeeSettings({ LIVE_PRIORITY_FEE_SOL: "0.0005" }).priorityFeeSol, 0.0005);
    assert.equal(
      loadPaperFeeSettings({ LIVE_PRIORITY_FEE_SOL: "0.0005", PAPER_PRIORITY_FEE_SOL: "0.0001" }).priorityFeeSol,
      0.0001,
    );
  });

  it("PAPER_PUMPSWAP_FEE_BPS=tiered or blank → tier table", () => {
    assert.equal(loadPaperFeeSettings({ PAPER_PUMPSWAP_FEE_BPS: "tiered" }).pumpSwapFeeBps, null);
    assert.equal(loadPaperFeeSettings({ PAPER_PUMPSWAP_FEE_BPS: "" }).pumpSwapFeeBps, null);
  });

  it("rejects bad values loudly", () => {
    assert.throws(() => loadPaperFeeSettings({ PAPER_FEE_MODEL: "free" }));
    assert.throws(() => loadPaperFeeSettings({ PAPER_PUMP_FEE_BPS: "abc" }));
    assert.throws(() => loadPaperFeeSettings({ PAPER_PUMPPORTAL_FEE_BPS: "-5" }));
    assert.throws(() => loadPaperFeeSettings({ PAPER_SLIPPAGE_MODEL: "magic" }));
  });

  it("loadConfig turns the realistic model on by default", () => {
    const saved = { ...process.env };
    try {
      for (const k of Object.keys(process.env)) if (k.startsWith("PAPER_") && k !== "PAPER_MODE") delete process.env[k];
      delete process.env.FEE_BPS;
      delete process.env.LIVE_PRIORITY_FEE_SOL;
      const c = loadConfig({ skipRuntimeOverlay: true });
      assert.deepEqual(c.paperBroker.fees, { ...PAPER_FEE_DEFAULTS });
      process.env.PAPER_FEE_MODEL = "legacy";
      assert.equal(loadConfig({ skipRuntimeOverlay: true }).paperBroker.fees?.model, "legacy");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

describe("PaperBroker with the realistic model", () => {
  it("round trip at an unchanged price loses ≈ fees + slippage, P&L net", () => {
    const broker = new PaperBroker(cfg(D));
    const { fill, position } = broker.applyBuy({
      mint: "M", symbol: "T", markPrice: 0.0001, notionalUsd: 15, solUsd: SOL, liquidityUsd: 5_000, venue: "bonding_curve",
    });
    assert.equal(fill.notionalUsd, 15); // the whole trade size leaves cash
    assert.ok(fill.feeBreakdown);
    assert.equal(position.venue, "bonding_curve");
    assert.equal(position.entryLiquidityUsd, 5_000);
    close(fill.feesUsd, fill.feeBreakdown!.totalFeesUsd);
    const sell = broker.applySell({ position, markPrice: 0.0001, reason: "manual_exit", solUsd: SOL });
    const fees = fill.feesUsd + sell.fill.feesUsd;
    const slip = fill.slippageUsd + sell.fill.slippageUsd;
    close(sell.realizedPnlUsd, sell.proceedsUsd - 15);
    close(-sell.realizedPnlUsd, fees + slip, 0.01);
    assert.ok(fees > 0.72 && fees < 0.76, `fees=${fees}`);
    assert.ok(slip > 0.1 && slip < 0.2, `slip=${slip}`);
  });

  it("legacy model / no fees block is byte-for-byte the old flat model", () => {
    for (const c of [cfg(undefined), cfg({ ...D, model: "legacy" })]) {
      const broker = new PaperBroker(c);
      const { fill, position } = broker.applyBuy({ mint: "M", symbol: "T", markPrice: 1, notionalUsd: 15, solUsd: SOL, liquidityUsd: 5_000 });
      close(fill.feesUsd, 15 * 0.003);
      close(fill.price, 1.005);
      close(position.qty, (15 - 0.045) / 1.005);
      assert.equal(fill.feeBreakdown, undefined);
      const s = broker.applySell({ position, markPrice: 1, reason: "manual_exit", solUsd: SOL });
      const gross = position.qty * 0.995;
      close(s.proceedsUsd, gross - gross * 0.003);
    }
  });

  it("journal row keeps net P&L and records the fee breakdown", () => {
    const dir = mkdtempSync(join(tmpdir(), "paper-fees-journal-"));
    try {
      const broker = new PaperBroker(cfg(D));
      const { position } = broker.applyBuy({ mint: "M", symbol: "T", markPrice: 1, notionalUsd: 15, solUsd: SOL });
      const sell = broker.applySell({ position, markPrice: 1.15, reason: "take_profit", solUsd: SOL });
      const j = new TradeJournal(dir);
      const e = j.appendClose({
        position, exitPrice: sell.fill.price, pnlUsd: sell.realizedPnlUsd, exitReason: "take_profit",
        fillId: sell.fill.id, exitFill: sell.fill,
      });
      close(e.pnlUsd, sell.realizedPnlUsd);
      close(e.feesUsd!, position.entryFeesUsd + sell.fill.feesUsd, 1e-5);
      assert.ok(e.feeBreakdown?.entry && e.feeBreakdown.exit);
      assert.ok(e.feeBreakdown.entry.rentUsd > 0);
      // Survives reload.
      const again = new TradeJournal(dir).list().entries[0]!;
      assert.equal(again.feesUsd, e.feesUsd);
      assert.equal(again.feeBreakdown?.exit?.side, "sell");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("engine: paper exit with the realistic model", () => {
  it("journal P&L is net and carries the fee breakdown; SOL price comes from the market", async () => {
    const { BotEngine } = await import("../src/engine/botEngine.js");
    const { PaperLedger } = await import("../src/ledger/ledger.js");
    const dir = mkdtempSync(join(tmpdir(), "paper-fees-engine-"));
    try {
      const mint = "MintFees1";
      let price = 0.0001;
      const market = {
        async scan() { return []; },
        async getPrice(m: string) { return m === mint ? price : null; },
        async getQuoteUsdRate() { return SOL; },
      };
      const c = { ...cfg(D), ledgerDir: dir };
      const ledger = new PaperLedger(c.bankrollUsd, dir);
      const broker = new PaperBroker(c);
      const engine = new BotEngine(c, { ledger, broker, market: market as never });
      const { fill, position } = broker.applyBuy({ mint, symbol: "FEE", markPrice: price, notionalUsd: 15, solUsd: SOL, liquidityUsd: 8_000 });
      ledger.recordBuy(fill, position);
      price = 0.000115; // +15%
      const res = await engine.exitNow();
      assert.equal(res.ok, true);
      const sell = res.fills![0]!;
      assert.equal(sell.feeBreakdown?.solUsd, SOL);
      const row = new TradeJournal(dir).list().entries[0]!;
      // Gross +$2.25 on $15; net must be lower by fees + slippage.
      assert.ok(row.pnlUsd < 2.25 - 0.7 && row.pnlUsd > 0.9, `pnl=${row.pnlUsd}`);
      close(row.pnlUsd, ledger.realizedPnl, 1e-9);
      assert.ok(row.feesUsd! > 0.72 && row.feesUsd! < 0.8, `fees=${row.feesUsd}`);
      close(ledger.cash, 200 + row.pnlUsd, 1e-9);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
