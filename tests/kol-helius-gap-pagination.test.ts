import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHeliusHistoryClient, HeliusHttpError, HeliusWalletWatch } from "../src/kol/heliusWatch.js";

const W = "9jyqFiLnruggwNn4EQwBNFXwpbLM9hrA4hV59ytyAVVz";
const SIG = (n: number) => `${"5".repeat(60)}${String(n).padStart(4, "1").replace(/0/g, "A")}`;
const tx = (n: number) => ({ signature: SIG(n) });
/** Newest first: n, n-1, ... */
const range = (hi: number, lo: number) => { const out = []; for (let n = hi; n >= lo; n--) out.push(tx(n)); return out; };

/** Fake Helius: history is sigs 1..top, newest first, paged by `limit` with `before`. */
function fakeHistory(limit: number) {
  let top = 0;
  const calls: Array<string | undefined> = [];
  return {
    calls,
    setTop(n: number) { top = n; },
    client: {
      async getTransactions(_w: string, opts?: { before?: string }) {
        calls.push(opts?.before);
        let hi = top;
        if (opts?.before) {
          const b = Array.from({ length: top }, (_, k) => k + 1).find((n) => SIG(n) === opts.before);
          if (b == null) return [];
          hi = b - 1;
        }
        return range(hi, Math.max(1, hi - limit + 1));
      },
    },
  };
}

const quiet = { pollMs: 1_000, minIntervalMs: 0, sleep: async () => undefined };

describe("HeliusWalletWatch older-page paging", () => {
  it("pages past a full all-new page until it reaches a seen signature", async () => {
    const h = fakeHistory(3);
    h.setTop(2);
    const watch = new HeliusWalletWatch(h.client, [W], () => undefined, quiet);
    await watch.pollOnce(); // baseline: sigs 1..2
    h.setTop(7); // 5 new: 3..7
    h.calls.length = 0;
    await watch.pollOnce();
    assert.deepEqual(h.calls, [undefined, SIG(5)]);
    assert.equal(watch.stats.rows, 5);
    assert.equal(watch.stats.olderPages, 1);
    assert.equal(watch.stats.possibleGaps, 0);
  });

  it("stops at the page cap and counts a possible gap", async () => {
    const h = fakeHistory(2);
    h.setTop(1);
    const watch = new HeliusWalletWatch(h.client, [W], () => undefined, { ...quiet, maxPagesPerWallet: 3 });
    await watch.pollOnce();
    h.setTop(20);
    h.calls.length = 0;
    await watch.pollOnce();
    assert.equal(h.calls.length, 3);
    assert.equal(watch.stats.rows, 6);
    assert.equal(watch.stats.possibleGaps, 1);
  });

  it("keeps collected txs and counts a gap when an older page is rate limited", async () => {
    let n = 0;
    const watch = new HeliusWalletWatch({
      async getTransactions(_w, opts) {
        n++;
        if (n === 1) return [tx(1)];
        if (opts?.before) throw new HeliusHttpError(429, 2_000);
        return [tx(3), tx(2)];
      },
    }, [W], () => undefined, quiet);
    await watch.pollOnce();
    await watch.pollOnce();
    assert.equal(watch.stats.rows, 2);
    assert.equal(watch.stats.rateLimits, 1);
    assert.equal(watch.stats.possibleGaps, 1);
  });

  it("adds before-signature to the Helius URL", async () => {
    const urls: string[] = [];
    const client = createHeliusHistoryClient("k", async (url) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => "[]" };
    });
    await client.getTransactions(W);
    await client.getTransactions(W, { before: SIG(9) });
    assert.equal(urls[0]!.includes("before-signature"), false);
    assert.match(urls[1]!, new RegExp(`&before-signature=${SIG(9)}$`));
  });
});
