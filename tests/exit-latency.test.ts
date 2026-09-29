import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BotEngine } from "../src/engine/botEngine.js";
import { PaperLedger } from "../src/ledger/ledger.js";
import { PaperBroker } from "../src/broker/paper.js";
import type { BotConfig, TokenSnapshot } from "../src/types.js";
import type { MarketDataProvider } from "../src/market/data.js";
import { PumpFunMarketData } from "../src/market/pumpfun.js";
import {
  CACHED_PRICE_REFRESH_TIMEOUT_MS,
} from "../src/market/http.js";

function baseCfg(over: Partial<BotConfig> = {}): BotConfig {
  return {
    paperMode: true,
    bankrollUsd: 20,
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
    runner: { pollIntervalMs: 40, scanLimit: 5, maxCycles: 4 },
    maxHoldMinutes: 20,
    dailyLossUsd: 0,
    chaseLockoutHours: 0,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "custom",
    requireChecklistGo: false,
    ...over,
  };
}

class CountingMarket implements MarketDataProvider {
  scanCalls = 0;
  priceCalls = 0;
  constructor(
    private readonly price: number,
    private readonly snaps: TokenSnapshot[] = [],
  ) {}
  async scan(_limit: number): Promise<TokenSnapshot[]> {
    this.scanCalls += 1;
    return this.snaps;
  }
  async getPrice(_mint: string): Promise<number | null> {
    this.priceCalls += 1;
    return this.price;
  }
}

describe("exit path skips entry scan while maxOpen", () => {
  let dir: string;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "exit-lat-"));
  });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not call scan while a position is open (maxOpen=1)", async () => {
    const cfg = baseCfg({ ledgerDir: dir, maxHoldMinutes: 0 });
    const market = new CountingMarket(1.0);
    const ledger = new PaperLedger(cfg.bankrollUsd, dir);
    const broker = new PaperBroker(cfg);
    const engine = new BotEngine(cfg, { ledger, broker, market });

    const { fill, position } = broker.applyBuy({
      mint: "ExitFastMint1",
      symbol: "FAST",
      markPrice: 1.0,
      notionalUsd: 10,
    });
    ledger.recordBuy(fill, position);
    assert.equal(ledger.openPositions.length, 1);

    const started = await engine.start();
    assert.equal(started.ok, true);

    const deadline = Date.now() + 2500;
    while (Date.now() < deadline && market.priceCalls < 2) {
      await new Promise((r) => setTimeout(r, 30));
    }
    await engine.stop();

    assert.ok(market.priceCalls >= 1, "exit path must poll getPrice");
    assert.equal(
      market.scanCalls,
      0,
      "must not scan candidates while at maxOpen with an open position",
    );
  });
});

describe("getPrice cached refresh uses short timeout", () => {
  it("falls back to cache well under full 8s HTTP timeout", async () => {
    const sample = {
      mint: "CacheMint111111111111111111111111111111pump",
      symbol: "CACHE",
      name: "Cache",
      usd_market_cap: 50_000,
      total_supply: 1_000_000_000_000_000,
      base_decimals: 6,
      real_sol_reserves: 10_000_000_000,
      complete: false,
      is_banned: false,
    };

    let dexMode: "miss" | "hang" = "miss";
    const fetchImpl = async (
      input: string,
      init?: RequestInit,
    ): Promise<Response> => {
      if (input.includes("/sol-price")) {
        return new Response(JSON.stringify({ solPrice: 100 }), { status: 200 });
      }
      if (input.includes("/coins?")) {
        return new Response(JSON.stringify([sample]), { status: 200 });
      }
      if (input.includes("dexscreener.com")) {
        if (dexMode === "miss") {
          return new Response("nope", { status: 404 });
        }
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
            { once: true },
          );
        });
        return new Response("never");
      }
      return new Response("nope", { status: 404 });
    };

    const provider = new PumpFunMarketData({
      fetchImpl,
      dexEnrich: true,
      dexFallback: false,
      enrichDelayMs: 0,
      httpTimeoutMs: 8_000,
    });

    // Seed priceCache from pump fields (Dex 404 → keep pump price).
    const snaps = await provider.scan(1);
    assert.equal(snaps.length, 1);
    assert.ok(snaps[0]!.priceUsd > 0);

    dexMode = "hang";
    const t0 = Date.now();
    const px = await provider.getPrice(sample.mint);
    const elapsed = Date.now() - t0;
    assert.ok(px !== null && px > 0);
    assert.ok(
      elapsed < CACHED_PRICE_REFRESH_TIMEOUT_MS + 1500,
      `expected ~${CACHED_PRICE_REFRESH_TIMEOUT_MS}ms refresh cap, got ${elapsed}ms`,
    );
    assert.ok(
      elapsed < 5_000,
      "must not wait full 8s HTTP timeout when cache exists",
    );
  });
});

