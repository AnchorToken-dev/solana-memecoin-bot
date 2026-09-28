import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fetchWithTimeout,
  isAbortError,
  marketHttpTimeoutMs,
} from "../src/market/http.js";
import { PumpFunMarketData } from "../src/market/pumpfun.js";

describe("fetchWithTimeout", () => {
  it("aborts a hung fetch within timeoutMs", async () => {
    const hung: typeof fetch = async (_input, init) => {
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          { once: true },
        );
      });
      return new Response("never");
    };
    const t0 = Date.now();
    await assert.rejects(
      () => fetchWithTimeout("https://example.test/hang", undefined, 80, hung),
      (err: unknown) => isAbortError(err),
    );
    assert.ok(Date.now() - t0 < 1500, "should not hang for seconds");
  });

  it("marketHttpTimeoutMs clamps invalid env", () => {
    const prev = process.env.MARKET_HTTP_TIMEOUT_MS;
    try {
      process.env.MARKET_HTTP_TIMEOUT_MS = "50";
      assert.equal(marketHttpTimeoutMs(8000), 8000);
      process.env.MARKET_HTTP_TIMEOUT_MS = "12000";
      assert.equal(marketHttpTimeoutMs(), 12000);
    } finally {
      if (prev === undefined) delete process.env.MARKET_HTTP_TIMEOUT_MS;
      else process.env.MARKET_HTTP_TIMEOUT_MS = prev;
    }
  });
});

describe("PumpFunMarketData getPrice cache-first on Dex hang", () => {
  it("returns cached mark when Dex enrich hangs past timeout", async () => {
    const sample = {
      mint: "HangMint111111111111111111111111111111pump",
      symbol: "HANG",
      name: "Hang",
      usd_market_cap: 50_000,
      total_supply: 1_000_000_000_000_000,
      base_decimals: 6,
      real_sol_reserves: 10_000_000_000,
      complete: false,
      is_banned: false,
    };

    let dexCalls = 0;
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      if (input.includes("/sol-price")) {
        return new Response(JSON.stringify({ solPrice: 100 }), { status: 200 });
      }
      if (input.includes("/coins?")) {
        return new Response(JSON.stringify([sample]), { status: 200 });
      }
      if (input.includes("dexscreener.com")) {
        dexCalls += 1;
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
      httpTimeoutMs: 60,
    });

    // Seed cache via scan (enrich times out → keeps pump price)
    const snaps = await provider.scan(1);
    assert.equal(snaps.length, 1);
    assert.ok(snaps[0]!.priceUsd > 0);

    const t0 = Date.now();
    const px = await provider.getPrice(sample.mint);
    assert.ok(px !== null && px > 0);
    assert.ok(Date.now() - t0 < 2000, "getPrice must not hang");
    assert.ok(dexCalls >= 1);
  });
});
