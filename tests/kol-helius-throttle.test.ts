import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createHeliusHistoryClient,
  HeliusHttpError,
  HeliusWalletWatch,
  parseRetryAfterMs,
} from "../src/kol/heliusWatch.js";
import { WSOL_MINT } from "../src/kol/trades.js";

const W = "9jyqFiLnruggwNn4EQwBNFXwpbLM9hrA4hV59ytyAVVz";
const B = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const C = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MINT = "6qsFmXN58Y8YF6wWjNF36FSMh8nvfReo2V9ZmjFppump";

function backoffOf(watch: HeliusWalletWatch): number {
  return (watch as unknown as { backoffMs: number }).backoffMs;
}

async function waitFor(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (pred()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for condition");
}

describe("parseRetryAfterMs", () => {
  it("reads delta-seconds and HTTP dates, and ignores garbage", () => {
    assert.equal(parseRetryAfterMs("12", 0), 12_000);
    assert.equal(parseRetryAfterMs(" 0.5 ", 0), 500);
    assert.equal(parseRetryAfterMs("100000", 0), 300_000);
    const now = 1_700_000_000_000;
    assert.equal(parseRetryAfterMs(new Date(now + 15_000).toUTCString(), now), 15_000);
    assert.equal(parseRetryAfterMs(new Date(now - 5_000).toUTCString(), now), 0);
    assert.equal(parseRetryAfterMs("soon", now), null);
    assert.equal(parseRetryAfterMs("  ", now), null);
    assert.equal(parseRetryAfterMs(null, now), null);
  });
});

describe("createHeliusHistoryClient rate limits", () => {
  it("surfaces HTTP 429 and Retry-After without the response body or the API key", async () => {
    const secret = "super-secret-helius-key";
    const client = createHeliusHistoryClient(secret, async () => ({
      ok: false,
      status: 429,
      headers: { get: (name: string) => (name.toLowerCase() === "retry-after" ? "12" : null) },
      text: async () => `slow down ${secret}`,
    }));
    await assert.rejects(client.getTransactions(W), (err: unknown) => {
      assert.ok(err instanceof HeliusHttpError);
      assert.equal(err.status, 429);
      assert.equal(err.retryAfterMs, 12_000);
      assert.equal(err.message.includes(secret), false);
      assert.equal(err.message.includes("slow down"), false);
      return true;
    });
  });

  it("reads a Retry-After HTTP date", async () => {
    const when = Date.now() + 30_000;
    const client = createHeliusHistoryClient("k", async () => ({
      ok: false,
      status: 429,
      headers: { get: () => new Date(when).toUTCString() },
      text: async () => "",
    }));
    await assert.rejects(client.getTransactions(W), (err: unknown) => {
      assert.ok(err instanceof HeliusHttpError);
      assert.ok(err.retryAfterMs != null && err.retryAfterMs >= 28_000 && err.retryAfterMs <= 30_000);
      return true;
    });
  });
});

describe("HeliusWalletWatch pacing", () => {
  const quiet = { pollMs: 3_000, minIntervalMs: 0, concurrency: 1, sleep: async () => undefined };

  it("stops the sweep on HTTP 429, then resumes at that wallet and clears backoff", async () => {
    const calls: string[] = [];
    const hits = new Map<string, number>();
    const got: string[] = [];
    const watch = new HeliusWalletWatch(
      {
        async getTransactions(wallet: string) {
          calls.push(wallet);
          const n = (hits.get(wallet) ?? 0) + 1;
          hits.set(wallet, n);
          if (wallet === B && n === 1) throw new HeliusHttpError(429, 20_000);
          if (wallet === W && n === 2) {
            return [{
              signature: "sigBuy",
              timestamp: 1_700_000_200,
              type: "UNKNOWN",
              feePayer: W,
              tokenTransfers: [
                { fromUserAccount: W, toUserAccount: "pool", mint: WSOL_MINT, tokenAmount: 0.2 },
                { fromUserAccount: "pool", toUserAccount: W, mint: MINT, tokenAmount: 10 },
              ],
              instructions: [{ programId: "RouterNew111111111111111111111111111111111" }],
            }, { signature: `old-${wallet}`, feePayer: wallet }];
          }
          return [{ signature: `old-${wallet}`, feePayer: wallet }];
        },
      },
      [W, B, C],
      (buy) => got.push(buy.tx),
      quiet,
    );
    await watch.pollOnce();
    assert.deepEqual(calls, [W, B]);
    assert.equal(watch.stats.rateLimits, 1);
    assert.equal(watch.stats.errors, 0);
    assert.equal(watch.stats.buys, 0);
    assert.equal(backoffOf(watch), 20_000);
    assert.match(watch.stats.lastError ?? "", /HTTP 429/);
    assert.match(watch.stats.lastError ?? "", /retry after 20s/);

    await watch.pollOnce();
    assert.deepEqual(calls, [W, B, B, C, W]);
    assert.deepEqual(got, ["sigBuy"]);
    assert.equal(backoffOf(watch), 0);
    assert.equal(watch.stats.rateLimits, 1);
  });

  it("uses exponential backoff when it is longer than Retry-After, and caps it", async () => {
    const watch = new HeliusWalletWatch(
      { getTransactions: async () => { throw new HeliusHttpError(429, 1_000); } },
      ["a", "b"],
      () => undefined,
      { ...quiet, maxBackoffMs: 9_000 },
    );
    await watch.pollOnce();
    assert.equal(backoffOf(watch), 6_000);
    assert.equal(watch.stats.rateLimits, 1);
    await watch.pollOnce();
    assert.equal(backoffOf(watch), 9_000);
    await watch.pollOnce();
    assert.equal(backoffOf(watch), 9_000);
  });

  it("treats a plain HTTP 429 error as a rate limit and honours retryAfter seconds", async () => {
    const seen: string[] = [];
    const watch = new HeliusWalletWatch(
      {
        async getTransactions(wallet: string) {
          seen.push(wallet);
          if (wallet === "a") throw Object.assign(new Error("helius history HTTP 429"), { retryAfter: 8 });
          return [];
        },
      },
      ["a", "b"],
      () => undefined,
      quiet,
    );
    await watch.pollOnce();
    assert.deepEqual(seen, ["a"]);
    assert.equal(watch.stats.rateLimits, 1);
    assert.equal(watch.stats.errors, 0);
    assert.equal(backoffOf(watch), 8_000);
  });

  it("keeps going after a non-429 error, counts it separately, and clears backoff once a sweep is clean", async () => {
    let fail = true;
    const seen: string[] = [];
    const watch = new HeliusWalletWatch(
      {
        async getTransactions(wallet: string) {
          seen.push(wallet);
          if (fail && wallet === "b") throw new Error("helius history HTTP 500");
          return [];
        },
      },
      ["a", "b", "c"],
      () => undefined,
      quiet,
    );
    await watch.pollOnce();
    assert.deepEqual(seen, ["a", "b", "c"]);
    assert.equal(watch.stats.errors, 1);
    assert.equal(watch.stats.rateLimits, 0);
    assert.equal(backoffOf(watch), 6_000);
    fail = false;
    await watch.pollOnce();
    assert.equal(backoffOf(watch), 0);
    assert.equal(watch.stats.errors, 1);
  });

  it("counts a 500 and a later 429 separately and does not call the wallet after the 429", async () => {
    const seen: string[] = [];
    const watch = new HeliusWalletWatch(
      {
        async getTransactions(wallet: string) {
          seen.push(wallet);
          if (wallet === "b") throw new Error("helius history HTTP 500");
          if (wallet === "c") throw new HeliusHttpError(429, 0);
          return [];
        },
      },
      ["a", "b", "c", "d"],
      () => undefined,
      quiet,
    );
    await watch.pollOnce();
    assert.deepEqual(seen, ["a", "b", "c"]);
    assert.equal(watch.stats.errors, 1);
    assert.equal(watch.stats.rateLimits, 1);
  });

  it("waits the minimum interval between history-call starts and not after the last call", async () => {
    const log: string[] = [];
    let now = 1_000_000;
    const watch = new HeliusWalletWatch(
      {
        async getTransactions(wallet: string) {
          log.push(`fetch:${wallet}`);
          return [];
        },
      },
      ["a", "b", "c"],
      () => undefined,
      {
        pollMs: 3_000,
        minIntervalMs: 250,
        concurrency: 1,
        now: () => now,
        sleep: async (ms) => { log.push(`sleep:${ms}`); now += ms; },
      },
    );
    await watch.pollOnce();
    assert.deepEqual(log, ["fetch:a", "sleep:250", "fetch:b", "sleep:250", "fetch:c"]);
  });

  it("does not pace a wallet that a 429 already cancelled", async () => {
    const log: string[] = [];
    let now = 1_000_000;
    const watch = new HeliusWalletWatch(
      {
        async getTransactions(wallet: string) {
          log.push(`fetch:${wallet}`);
          if (wallet === "b") throw new HeliusHttpError(429, 5_000);
          return [];
        },
      },
      ["a", "b", "c"],
      () => undefined,
      {
        pollMs: 3_000,
        minIntervalMs: 250,
        concurrency: 1,
        now: () => now,
        sleep: async (ms) => { log.push(`sleep:${ms}`); now += ms; },
      },
    );
    await watch.pollOnce();
    assert.deepEqual(log, ["fetch:a", "sleep:250", "fetch:b"]);
    assert.equal(watch.stats.rateLimits, 1);
  });

  it("never has more history calls in flight than the concurrency cap", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let started = 0;
    const pending: Array<() => void> = [];
    const watch = new HeliusWalletWatch(
      {
        getTransactions: () => {
          started++;
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          return new Promise((resolve) => {
            pending.push(() => {
              inFlight--;
              resolve([]);
            });
          });
        },
      },
      ["a", "b", "c", "d"],
      () => undefined,
      { pollMs: 1_000, minIntervalMs: 0, concurrency: 2, sleep: async () => undefined },
    );
    const done = watch.pollOnce();
    await waitFor(() => pending.length >= 2 && started === 2);
    assert.equal(maxInFlight, 2);
    pending.shift()?.();
    await waitFor(() => started === 3);
    assert.equal(maxInFlight, 2);
    for (let i = 0; i < 10 && (started < 4 || pending.length > 0); i++) {
      const release = pending.shift();
      if (release) release();
      else await new Promise((resolve) => setImmediate(resolve));
    }
    if (started < 4 || pending.length > 0) {
      throw new Error(`in-flight cap did not drain (started ${started}, pending ${pending.length})`);
    }
    await done;
    assert.equal(started, 4);
    assert.equal(maxInFlight, 2);
    assert.equal(inFlight, 0);
  });

  it("does not start more wallets after a 429 while another call is still in flight", async () => {
    let started = 0;
    const pending: Array<(err?: Error) => void> = [];
    const watch = new HeliusWalletWatch(
      {
        getTransactions: () => {
          started++;
          return new Promise((resolve, reject) => {
            pending.push((err) => (err ? reject(err) : resolve([])));
          });
        },
      },
      ["a", "b", "c", "d"],
      () => undefined,
      { pollMs: 3_000, minIntervalMs: 0, concurrency: 2, sleep: async () => undefined },
    );
    const done = watch.pollOnce();
    await waitFor(() => pending.length === 2);
    const first = pending[0];
    const second = pending[1];
    first?.(new HeliusHttpError(429, 5_000));
    await waitFor(() => watch.stats.rateLimits === 1);
    assert.equal(started, 2);
    second?.();
    await done;
    assert.equal(started, 2);
    assert.equal(watch.stats.errors, 0);
    assert.equal(backoffOf(watch), 6_000);
  });

  it("schedules the next sweep on the 429 backoff instead of the steady poll interval", async () => {
    let calls = 0;
    const timers: number[] = [];
    const watch = new HeliusWalletWatch(
      {
        async getTransactions() {
          calls++;
          throw new HeliusHttpError(429, 20_000);
        },
      },
      ["a", "b"],
      () => undefined,
      {
        pollMs: 3_000,
        minIntervalMs: 0,
        concurrency: 1,
        sleep: async () => undefined,
        setTimer: (_fn, ms) => {
          timers.push(ms);
          return timers.length;
        },
        clearTimer: () => undefined,
      },
    );
    watch.start();
    await waitFor(() => timers.length === 1);
    assert.equal(calls, 1);
    assert.equal(timers[0], 20_000);
    assert.equal(watch.stats.rateLimits, 1);
    assert.equal(watch.stats.errors, 0);
    watch.stop();
  });
});
