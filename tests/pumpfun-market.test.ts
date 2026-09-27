import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PumpFunMarketData,
  priceFromPumpCoin,
  liquidityFromPumpCoin,
  PUMPFUN_FRONTEND_API_BASE_DEFAULT,
} from "../src/market/pumpfun.js";
import { createMarketData } from "../src/market/data.js";
import type { BotConfig } from "../src/types.js";

function baseCfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true,
    bankrollUsd: 20,
    maxOpenTrades: 1,
    stopLossPct: 10,
    takeProfitPct: 25,
    positionSizePct: 0.95,
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
    runner: { pollIntervalMs: 1000, scanLimit: 10, maxCycles: 0 },
    maxHoldMinutes: 20,
    dailyLossUsd: 5,
    marketDataSource: "pumpfun",
    ledgerDir: "data",
    ...over,
  };
}

const sampleCoin = {
  mint: "TestMint111111111111111111111111111111pump",
  symbol: "TST",
  name: "Test Coin",
  usd_market_cap: 50_000,
  total_supply: 1_000_000_000_000_000, // 1e9 tokens @ 6 decimals
  base_decimals: 6,
  real_sol_reserves: 10_000_000_000, // 10 SOL
  virtual_sol_reserves: 30_000_000_000,
  complete: false,
  is_banned: false,
};

describe("pumpfun helpers", () => {
  it("derives price from mcap / supply", () => {
    // 50000 / 1e9 = 0.00005
    assert.ok(Math.abs(priceFromPumpCoin(sampleCoin) - 0.00005) < 1e-12);
  });

  it("derives liquidity from real SOL reserves × SOL/USD", () => {
    assert.equal(liquidityFromPumpCoin(sampleCoin, 100), 1000);
  });
});

describe("PumpFunMarketData (mocked HTTP)", () => {
  it("constructs and scan() maps coins without crashing", async () => {
    const calls: string[] = [];
    const fetchImpl = async (input: string): Promise<Response> => {
      calls.push(input);
      if (input.includes("/sol-price")) {
        return new Response(JSON.stringify({ solPrice: 100 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (input.includes("/coins?")) {
        return new Response(JSON.stringify([sampleCoin]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // Dex enrich — empty pairs so we keep pump-derived fields
      if (input.includes("dexscreener.com")) {
        return new Response(JSON.stringify({ pairs: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    };

    const provider = new PumpFunMarketData({
      fetchImpl,
      dexEnrich: true,
      dexFallback: false,
      enrichDelayMs: 0,
      windowMinutes: 5,
    });

    const snaps = await provider.scan(5);
    assert.ok(snaps.length >= 1);
    assert.equal(snaps[0]!.mint, sampleCoin.mint);
    assert.equal(snaps[0]!.symbol, "TST");
    assert.ok(snaps[0]!.priceUsd > 0);
    assert.equal(snaps[0]!.liquidityUsd, 1000);
    assert.ok(calls.some((u) => u.startsWith(PUMPFUN_FRONTEND_API_BASE_DEFAULT)));

    const px = await provider.getPrice(sampleCoin.mint);
    assert.ok(px !== null && px > 0);
  });

  it("falls back to DexScreener pumpfun/pumpswap when frontend fails", async () => {
    const fetchImpl = async (input: string): Promise<Response> => {
      if (input.includes("frontend-api")) {
        return new Response("nope", { status: 530 });
      }
      if (input.includes("dexscreener.com/latest/dex/search")) {
        return new Response(
          JSON.stringify({
            pairs: [
              {
                chainId: "solana",
                dexId: "pumpfun",
                baseToken: {
                  address: "FbMintPump11111111111111111111111111111pump",
                  symbol: "FB",
                  name: "Fallback",
                },
                priceUsd: "0.001",
                liquidity: { usd: 20_000 },
                volume: { m5: 9_000, h24: 100_000 },
                priceChange: { m5: 12.5 },
              },
              {
                chainId: "solana",
                dexId: "raydium",
                baseToken: {
                  address: "IgnoreMe",
                  symbol: "NO",
                  name: "No",
                },
                priceUsd: "1",
                liquidity: { usd: 1_000_000 },
                volume: { m5: 1, h24: 1 },
                priceChange: { m5: 1 },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200 });
    };

    const provider = new PumpFunMarketData({
      fetchImpl,
      dexEnrich: false,
      dexFallback: true,
      enrichDelayMs: 0,
    });
    const snaps = await provider.scan(10);
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0]!.symbol, "FB");
    assert.equal(snaps[0]!.changeWindowPct, 12.5);
    assert.equal(snaps[0]!.volumeWindowUsd, 9_000);
  });

  it("createMarketData(pumpfun) returns a provider", () => {
    const prev = process.env.MARKET_DATA_SOURCE;
    process.env.PUMPFUN_DEXSCREENER_ENRICH = "false";
    process.env.PUMPFUN_DEXSCREENER_FALLBACK = "false";
    try {
      const m = createMarketData(baseCfg({ marketDataSource: "pumpfun" }));
      assert.ok(m);
      assert.equal(typeof m.scan, "function");
      assert.equal(typeof m.getPrice, "function");
    } finally {
      if (prev === undefined) delete process.env.MARKET_DATA_SOURCE;
      else process.env.MARKET_DATA_SOURCE = prev;
      delete process.env.PUMPFUN_DEXSCREENER_ENRICH;
      delete process.env.PUMPFUN_DEXSCREENER_FALLBACK;
    }
  });
});
