/**
 * Jupiter paper fills: quoted route vs the pump.fun curve model, offline
 * fallback when the API is down, and skipping mints Jupiter cannot quote.
 * Live dry-run still uses computeBuyCosts (curve). This file never sends a swap.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PAPER_FEE_DEFAULTS,
  computeBuyCosts,
  type PaperFeeSettings,
} from "../src/broker/paperFees.js";
import { PaperBroker } from "../src/broker/paper.js";
import {
  inferTokenDecimals,
  loadPaperExecutionSettings,
  priceJupiterBuy,
  priceJupiterSell,
  solLamportsForBuy,
} from "../src/broker/jupiterFill.js";
import {
  fetchJupiterSwapQuote,
  selectJupiterQuotable,
  SOL_MINT,
  type JupiterQuoteResult,
  type JupiterRouteQuote,
  type JupiterSwapRequest,
} from "../src/broker/jupiterQuote.js";
import { loadConfig } from "../src/config.js";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";

const SOL = 116;
const D: PaperFeeSettings = { ...PAPER_FEE_DEFAULTS };

function curveCfg(fillVenue?: "jupiter" | "curve"): BotConfig {
  return {
    paperMode: true,
    bankrollUsd: 200,
    maxOpenTrades: 1,
    stopLossPct: 8,
    takeProfitPct: 15,
    positionSizePct: 0.95,
    maxPositionUsd: 50,
    momentum: { minPct: 1, windowMinutes: 5, volumeSpikeMult: 1, minLiquidityUsd: 0, minVolume24hUsd: 0, minAgeMinutes: 0 },
    trailingTakeProfit: { activatePct: 10, distancePct: 5 },
    paperBroker: {
      slippageBps: 50,
      feeBps: 30,
      fees: D,
      ...(fillVenue ? { fillVenue, jupiter: { timeoutMs: 2500, slippageBps: 50, fallbackFeeBps: 25, tokenDecimals: 6, quoteAttempts: 5 } } : {}),
    },
    runner: { pollIntervalMs: 10, scanLimit: 5, maxCycles: 0 },
    maxHoldMinutes: 0,
    dailyLossUsd: 0,
    chaseLockoutHours: 0,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "custom",
    requireChecklistGo: false,
    solanaRpcConfigured: false,
    solanaRpcWssConfigured: false,
    rugFilterEnabled: false,
    rugFilterMaxTopHolderPct: 30,
    rugFilterMaxSameSlotBuys: 3,
  };
}

function quote(over: Partial<JupiterRouteQuote> = {}): JupiterRouteQuote {
  return {
    source: "jupiter_build",
    inputMint: SOL_MINT,
    outputMint: "Mint",
    inAmountRaw: "100000000",
    outAmountRaw: "147000000000",
    priceImpactPct: 0.001,
    slippageBps: 50,
    route: "Raydium 100%",
    dexLabels: ["Raydium"],
    jupiterFeeBps: 0,
    ...over,
  };
}

describe("Jupiter paper fill vs pump curve", () => {
  it("offline fallback charges no Jupiter fee and no PumpPortal fee, and less than the 1.25% curve", () => {
    const curve = computeBuyCosts(D, { notionalUsd: 15, markPrice: 0.0001, solUsd: SOL, flatSlippageBps: 50 });
    assert.equal(curve.breakdown.venueFeeBps, 125);
    assert.ok(curve.breakdown.pumpPortalFeeUsd > 0.07);
    const jup = priceJupiterBuy(D, {
      notionalUsd: 15,
      markPrice: 0.0001,
      solUsd: SOL,
      flatSlippageBps: 50,
      fallbackReason: "jupiter timeout",
    });
    assert.equal(jup.breakdown.fillSource, "fallback");
    assert.equal(jup.breakdown.route, "offline_fallback");
    assert.equal(jup.breakdown.jupiterFeeBps, 0);
    assert.equal(jup.breakdown.pumpPortalFeeUsd, 0);
    assert.equal(jup.breakdown.venueFeeBps, 25);
    assert.ok(jup.breakdown.totalFeesUsd < curve.breakdown.totalFeesUsd - 0.15, `jup=${jup.breakdown.totalFeesUsd} curve=${curve.breakdown.totalFeesUsd}`);
    assert.equal(jup.breakdown.fallbackReason, "jupiter timeout");
  });

  it("a /build quote prices the fill from outAmount and records the route", () => {
    const sized = solLamportsForBuy(D, 15, SOL);
    assert.ok(sized);
    const q = quote();
    const jup = priceJupiterBuy(D, {
      notionalUsd: 15,
      markPrice: 0.0001,
      solUsd: SOL,
      flatSlippageBps: 50,
      quote: q,
    });
    assert.equal(jup.tokenDecimals, 6);
    assert.ok(Math.abs(jup.qty - 147_000) < 1);
    assert.equal(jup.breakdown.fillSource, "jupiter_build");
    assert.equal(jup.breakdown.route, "Raydium 100%");
    assert.equal(jup.breakdown.jupiterFeeBps, 0);
    assert.equal(jup.breakdown.pumpPortalFeeUsd, 0);
    assert.ok(jup.breakdown.slippageBps > 0 && jup.breakdown.slippageBps < 20);
    const curve = computeBuyCosts(D, { notionalUsd: 15, markPrice: 0.0001, solUsd: SOL, venue: "bonding_curve", flatSlippageBps: 50 });
    assert.ok(jup.breakdown.totalFeesUsd < curve.breakdown.totalFeesUsd);
    assert.notEqual(jup.breakdown.venueFeeBps, curve.breakdown.venueFeeBps);
  });

  it("sell quote is SOL out, still with a zero Jupiter fee", () => {
    const outLamports = Math.round((14.5 / SOL) * 1e9);
    const s = priceJupiterSell(D, {
      qty: 147_000,
      markPrice: 0.0001,
      solUsd: SOL,
      flatSlippageBps: 0,
      quote: quote({ outAmountRaw: String(outLamports), route: "Pump.fun Amm 70% → Raydium 30%", priceImpactPct: 0.002 }),
    });
    assert.equal(s.breakdown.jupiterFeeBps, 0);
    assert.equal(s.breakdown.pumpPortalFeeUsd, 0);
    assert.equal(s.breakdown.rentUsd, 0);
    assert.equal(s.breakdown.fillSource, "jupiter_build");
    assert.ok(s.proceedsUsd < 14.7);
    assert.ok(s.proceedsUsd > 14);
  });

  it("PaperBroker uses the quote only when fillVenue is jupiter; omitted venue stays on the curve", () => {
    const q = quote();
    const jBroker = new PaperBroker(curveCfg("jupiter"));
    const bought = jBroker.applyBuy({
      mint: "M",
      symbol: "T",
      markPrice: 0.0001,
      notionalUsd: 15,
      solUsd: SOL,
      jupiterQuote: q,
    });
    assert.equal(bought.fill.feeBreakdown?.fillSource, "jupiter_build");
    assert.equal(bought.fill.feeBreakdown?.route, "Raydium 100%");
    assert.equal(bought.position.tokenDecimals, 6);
    const curveBroker = new PaperBroker(curveCfg());
    const curveBuy = curveBroker.applyBuy({
      mint: "M",
      symbol: "T",
      markPrice: 0.0001,
      notionalUsd: 15,
      solUsd: SOL,
      venue: "bonding_curve",
      jupiterQuote: q,
    });
    assert.equal(curveBuy.fill.feeBreakdown?.venueFeeBps, 125);
    assert.equal(curveBuy.fill.feeBreakdown?.fillSource, undefined);
    assert.ok(curveBuy.fill.feeBreakdown!.pumpPortalFeeUsd > 0);
  });

  it("infers 6 decimals when the raw amount is near the mark", () => {
    assert.equal(inferTokenDecimals(147_000_000_000, 14.7, 0.0001, 9), 6);
  });
});

describe("Jupiter quote client", () => {
  const req: JupiterSwapRequest = {
    inputMint: SOL_MINT,
    outputMint: "TokenMint111111111111111111111111111111111",
    amountRaw: "100000000",
    slippageBps: 50,
    timeoutMs: 1000,
    apiBase: "https://api.jup.ag",
  };

  it("uses /build when it returns a route and does not call v1", async () => {
    const urls: string[] = [];
    const result = await fetchJupiterSwapQuote(req, {
      env: { JUPITER_API_KEY: "supersecret" },
      fetchImpl: async (url, init) => {
        urls.push(String(url));
        const headers = (init?.headers ?? {}) as Record<string, string>;
        assert.equal(headers["x-api-key"], "supersecret");
        assert.equal(String(url).includes("supersecret"), false);
        return new Response(
          JSON.stringify({
            inputMint: req.inputMint,
            outputMint: req.outputMint,
            inAmount: req.amountRaw,
            outAmount: "999",
            priceImpactPct: "0.002",
            slippageBps: 50,
            routePlan: [{ swapInfo: { label: "Raydium CLMM" }, bps: 10000, percent: 100 }],
          }),
          { status: 200 },
        );
      },
    });
    assert.equal(result.kind, "ok");
    if (result.kind !== "ok") return;
    assert.equal(result.quote.source, "jupiter_build");
    assert.equal(result.quote.route, "Raydium CLMM 100%");
    assert.equal(result.quote.jupiterFeeBps, 0);
    assert.equal(urls.length, 1);
    assert.ok(urls[0]!.includes("/swap/v2/build"));
  });

  it("no-route from /build does not throw and does not fall through", async () => {
    let calls = 0;
    const result = await fetchJupiterSwapQuote(req, {
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: "No routes found" }), { status: 400 });
      },
    });
    assert.equal(result.kind, "no_route");
    assert.equal(calls, 1);
    if (result.kind === "no_route") assert.match(result.reason, /No routes found/);
  });

  it("build 503 then v1 quote succeeds; both down is unreachable and does not throw", async () => {
    const v1 = await fetchJupiterSwapQuote(req, {
      fetchImpl: async (url) => {
        if (String(url).includes("/build")) return new Response("upstream", { status: 503 });
        return new Response(
          JSON.stringify({
            inputMint: req.inputMint,
            outputMint: req.outputMint,
            inAmount: req.amountRaw,
            outAmount: "50",
            priceImpactPct: "0",
            slippageBps: 50,
            routePlan: [{ swapInfo: { label: "Orca" }, percent: 100 }],
          }),
          { status: 200 },
        );
      },
    });
    assert.equal(v1.kind, "ok");
    if (v1.kind === "ok") assert.equal(v1.quote.source, "jupiter_quote_v1");

    const down = await fetchJupiterSwapQuote(req, {
      fetchImpl: async () => {
        throw new Error("socket hang up");
      },
    });
    assert.equal(down.kind, "unreachable");
    if (down.kind === "unreachable") assert.match(down.reason, /socket hang up/);
  });
});

describe("selectJupiterQuotable", () => {
  const rows = [
    { mint: "A", symbol: "A" },
    { mint: "B", symbol: "B" },
    { mint: "C", symbol: "C" },
  ];

  it("skips no_route and keeps the next quoted mint", async () => {
    const sel = await selectJupiterQuotable(
      rows,
      async (e) => (e.mint === "A" ? { kind: "no_route", reason: "No routes found" } : { kind: "ok", quote: quote({ outputMint: e.mint }) }),
      5,
    );
    assert.equal(sel.unreachable, false);
    assert.equal(sel.entries[0]?.mint, "B");
    assert.equal(sel.quote?.outputMint, "B");
    assert.deepEqual(sel.skipped.map((s) => s.entry.mint), ["A"]);
  });

  it("unreachable keeps the unproven tail and does not drop the cycle", async () => {
    const sel = await selectJupiterQuotable(rows, async () => ({ kind: "unreachable", reason: "timeout" }), 5);
    assert.equal(sel.unreachable, true);
    assert.equal(sel.quote, null);
    assert.deepEqual(sel.entries.map((e) => e.mint), ["A", "B", "C"]);
  });
});

describe("PAPER_FILL_VENUE / PAPER_DISCOVERY", () => {
  it("defaults to jupiter + broad, and curve restores the pump scan", () => {
    const saved = { ...process.env };
    try {
      for (const k of ["PAPER_FILL_VENUE", "PAPER_DISCOVERY", "PAPER_JUPITER_TAKER", "PAPER_JUPITER_FALLBACK_FEE_BPS"]) {
        delete process.env[k];
      }
      const d = loadPaperExecutionSettings({});
      assert.equal(d.fillVenue, "jupiter");
      assert.equal(d.discovery, "broad");
      assert.equal(d.jupiter.fallbackFeeBps, 25);
      const curve = loadPaperExecutionSettings({ PAPER_FILL_VENUE: "curve" });
      assert.equal(curve.fillVenue, "curve");
      assert.equal(curve.discovery, "pump");
      const mixed = loadPaperExecutionSettings({ PAPER_FILL_VENUE: "curve", PAPER_DISCOVERY: "broad" });
      assert.equal(mixed.discovery, "broad");
      assert.throws(() => loadPaperExecutionSettings({ PAPER_FILL_VENUE: "raydium" }));
      assert.throws(() => loadPaperExecutionSettings({ PAPER_DISCOVERY: "all" }));
      const cfg = loadConfig({ skipRuntimeOverlay: true });
      assert.equal(cfg.paperBroker.fillVenue, "jupiter");
      assert.equal(cfg.paperBroker.discovery, "broad");
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});

function snap(mint: string, change: number): TokenSnapshot {
  return {
    mint,
    symbol: mint.slice(0, 4),
    name: mint,
    priceUsd: 0.0001,
    changeWindowPct: change,
    volumeWindowUsd: 100_000,
    volumeAvgUsd: 1000,
    volume24hUsd: 1_000_000,
    liquidityUsd: 50_000,
    timestamp: Date.now(),
    createdAt: Date.now() - 3_600_000,
    venue: "pumpswap",
  };
}

class TwoCoins implements MarketDataProvider {
  async scan(): Promise<TokenSnapshot[]> {
    return [snap("NoRouteCoin111111111111111111111111111111", 40), snap("QuotedCoin1111111111111111111111111111111", 12)];
  }
  async getPrice() {
    return 0.0001;
  }
  async getQuoteUsdRate() {
    return SOL;
  }
}

function quotesFor(kindForFirst: "no_route" | "unreachable"): { quote(req: JupiterSwapRequest): Promise<JupiterQuoteResult> } {
  return {
    async quote(req) {
      if (req.outputMint.startsWith("NoRoute") || kindForFirst === "unreachable") {
        if (req.outputMint.startsWith("NoRoute") && kindForFirst === "no_route") {
          return { kind: "no_route", reason: "HTTP 400: No routes found" };
        }
        if (kindForFirst === "unreachable" && req.outputMint.startsWith("NoRoute")) {
          return { kind: "unreachable", reason: "timeout" };
        }
      }
      return { kind: "ok", quote: quote({ outputMint: req.outputMint, route: "Raydium 100%" }) };
    },
  };
}

async function runEngine(kind: "no_route" | "unreachable") {
  const dir = mkdtempSync(join(tmpdir(), "jup-paper-"));
  const cfg = { ...curveCfg("jupiter"), ledgerDir: dir };
  const engine = new BotEngine(cfg, {
    market: new TwoCoins(),
    solanaWs: null,
    solanaRpc: null,
    ledger: new PaperLedger(200, join(dir, "paper")),
    jupiterQuotes: quotesFor(kind),
  });
  try {
    const started = await engine.start();
    assert.ok(started.ok, started.message);
    await new Promise((r) => setTimeout(r, 400));
    await engine.stop();
    return engine.ledger.openPositions.map((p) => ({
      mint: p.mint,
      source: p.entryFeeBreakdown?.fillSource ?? null,
      route: p.entryFeeBreakdown?.route ?? null,
      portal: p.entryFeeBreakdown?.pumpPortalFeeUsd ?? null,
      jupFee: p.entryFeeBreakdown?.jupiterFeeBps ?? null,
    }));
  } finally {
    await engine.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("engine paper jupiter gate", () => {
  it("skips a mint Jupiter cannot quote and buys the next one at the quoted route", async () => {
    const opened = await runEngine("no_route");
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.mint.startsWith("Quoted"), true);
    assert.equal(opened[0]!.source, "jupiter_build");
    assert.equal(opened[0]!.route, "Raydium 100%");
    assert.equal(opened[0]!.portal, 0);
    assert.equal(opened[0]!.jupFee, 0);
  });

  it("API down does not stall: the top candidate fills on the offline model", async () => {
    const opened = await runEngine("unreachable");
    assert.equal(opened.length, 1);
    assert.equal(opened[0]!.mint.startsWith("NoRoute"), true);
    assert.equal(opened[0]!.source, "fallback");
    assert.equal(opened[0]!.route, "offline_fallback");
    assert.equal(opened[0]!.jupFee, 0);
    assert.equal(opened[0]!.portal, 0);
  });
});
