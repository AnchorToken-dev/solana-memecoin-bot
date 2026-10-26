/**
 * Broad paper discovery adds graduated / Raydium / Gecko candidates.
 * The pump-only scan still drops Raydium pairs.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PumpFunMarketData } from "../src/market/pumpfun.js";
import { isBroadDex, mergeWithReserve, snapshotsFromGeckoTrending } from "../src/market/broadDiscovery.js";
import type { TokenSnapshot } from "../src/types.js";

function coin(mint: string, symbol: string, complete: boolean) {
  return {
    mint,
    symbol,
    name: symbol,
    usd_market_cap: 80_000,
    total_supply: 1_000_000_000_000_000,
    base_decimals: 6,
    real_sol_reserves: 40_000_000_000,
    virtual_sol_reserves: 40_000_000_000,
    complete,
    is_banned: false,
  };
}

describe("broad discovery helpers", () => {
  it("reserves half the board for non-pump supplements, then backfills", () => {
    const p = (mint: string): TokenSnapshot => ({
      mint,
      symbol: mint,
      name: mint,
      priceUsd: 1,
      changeWindowPct: 0,
      volumeWindowUsd: 1,
      volumeAvgUsd: 1,
      volume24hUsd: 1,
      liquidityUsd: 1,
      timestamp: 0,
    });
    const merged = mergeWithReserve([p("a"), p("b"), p("c"), p("d")], [p("ray"), p("gecko")], 4);
    assert.deepEqual(merged.map((s) => s.mint), ["a", "b", "ray", "gecko"]);
    assert.deepEqual(mergeWithReserve([p("a"), p("b")], [], 4).map((s) => s.mint), ["a", "b"]);
  });

  it("keeps Raydium-class dex ids and parses a Gecko trending pool", () => {
    assert.equal(isBroadDex("raydium"), true);
    assert.equal(isBroadDex("raydium-clmm"), true);
    assert.equal(isBroadDex("pumpswap"), true);
    assert.equal(isBroadDex("moonshot"), false);
    const snaps = snapshotsFromGeckoTrending({
      data: [
        {
          attributes: {
            name: "GECKO / SOL",
            base_token_price_usd: "0.002",
            reserve_in_usd: "25000",
            pool_created_at: "2026-10-01T00:00:00Z",
            price_change_percentage: { m5: "6.5" },
            volume_usd: { m5: "4000", h24: "90000" },
          },
          relationships: {
            base_token: { data: { id: "solana_GeckoMint1111111111111111111111111111111" } },
            dex: { data: { id: "raydium" } },
          },
        },
        {
          attributes: { name: "SOL / USDC", base_token_price_usd: "150" },
          relationships: { base_token: { data: { id: "solana_So11111111111111111111111111111111111111112" } } },
        },
      ],
    });
    assert.equal(snaps.length, 1);
    assert.equal(snaps[0]!.symbol, "GECKO");
    assert.equal(snaps[0]!.priceUsd, 0.002);
    assert.equal(snaps[0]!.changeWindowPct, 6.5);
    assert.equal(snaps[0]!.liquidityUsd, 25000);
    assert.ok(snaps[0]!.createdAt && snaps[0]!.createdAt > 1e12);
  });
});

describe("PumpFunMarketData discovery", () => {
  it("broad scan includes a graduated coin, a Raydium pair, and a Gecko pool", async () => {
    const fetchImpl = async (input: string): Promise<Response> => {
      if (input.includes("/sol-price")) {
        return new Response(JSON.stringify({ solPrice: 100 }), { status: 200 });
      }
      if (input.includes("/coins?")) {
        if (input.includes("complete=true")) {
          return new Response(JSON.stringify([coin("GradMint111111111111111111111111111111111", "GRAD", true)]), { status: 200 });
        }
        if (input.includes("complete=false")) {
          return new Response(JSON.stringify([coin("CurveMint11111111111111111111111111111111", "CURVE", false)]), { status: 200 });
        }
        return new Response(JSON.stringify([coin("HotMint1111111111111111111111111111111111", "HOT", false)]), { status: 200 });
      }
      if (input.includes("dex/search") && input.includes("raydium")) {
        return new Response(
          JSON.stringify({
            pairs: [
              {
                chainId: "solana",
                dexId: "raydium",
                baseToken: { address: "RayMint1111111111111111111111111111111111", symbol: "RAYD", name: "Ray" },
                priceUsd: "0.01",
                liquidity: { usd: 40_000 },
                volume: { m5: 8_000, h24: 100_000 },
                priceChange: { m5: 9 },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (input.includes("geckoterminal")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                attributes: {
                  name: "GECK / SOL",
                  base_token_price_usd: "0.004",
                  reserve_in_usd: "12000",
                  price_change_percentage: { m5: "3" },
                  volume_usd: { m5: "1000", h24: "20000" },
                },
                relationships: {
                  base_token: { data: { id: "solana_GeckMint111111111111111111111111111111111" } },
                  dex: { data: { id: "orca" } },
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ pairs: [] }), { status: 200 });
    };

    const provider = new PumpFunMarketData({
      fetchImpl,
      dexEnrich: false,
      dexFallback: true,
      enrichDelayMs: 0,
      discovery: "broad",
    });
    const snaps = await provider.scan(6);
    const symbols = snaps.map((s) => s.symbol).sort();
    assert.ok(symbols.includes("GRAD"), symbols.join(","));
    assert.ok(symbols.includes("RAYD"), symbols.join(","));
    assert.ok(symbols.includes("GECK"), symbols.join(","));
    assert.equal(snaps.find((s) => s.symbol === "GRAD")?.venue, "pumpswap");
  });
});
