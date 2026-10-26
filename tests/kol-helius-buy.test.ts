import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectProgramIds, formatHeliusFailure, parseHeliusWalletBuy } from "../src/kol/heliusBuy.js";
import { createHeliusHistoryClient, HeliusWalletWatch, redactSecrets } from "../src/kol/heliusWatch.js";
import { WSOL_MINT } from "../src/kol/trades.js";

const W = "9jyqFiLnruggwNn4EQwBNFXwpbLM9hrA4hV59ytyAVVz";
const MINT = "6qsFmXN58Y8YF6wWjNF36FSMh8nvfReo2V9ZmjFppump";
const OTHER = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const ROUTER = "RouterNew111111111111111111111111111111111";
const RAYDIUM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const COMPUTE = "ComputeBudget111111111111111111111111111111";

describe("parseHeliusWalletBuy", () => {
  it("reads a v0 buy whose program id is an index into object account keys", () => {
    // An allowlist that only accepts pump.fun / Jupiter never sees ROUTER.
    // Reading programIdIndex off the object itself yields "[object Object]".
    const tx = {
      blockTime: 1_700_000_000,
      meta: {
        err: null,
        fee: 5_000,
        preBalances: [2_000_000_000, 0, 0],
        postBalances: [1_000_000_000 - 5_000, 0, 0],
        preTokenBalances: [],
        postTokenBalances: [{
          owner: W,
          mint: MINT,
          uiTokenAmount: { uiAmountString: "1000", decimals: 6, amount: "1000000000" },
        }],
        innerInstructions: [{ index: 1, instructions: [{ programId: ROUTER, accounts: [] }] }],
      },
      transaction: {
        signatures: ["sigV0UnknownRouter"],
        message: {
          accountKeys: [
            { pubkey: W, signer: true, writable: true },
            { pubkey: COMPUTE, signer: false, writable: false },
            { pubkey: ROUTER, signer: false, writable: false },
          ],
          instructions: [
            { programIdIndex: 1, accounts: [] },
            { programIdIndex: 2, accounts: [] },
          ],
        },
      },
    };
    const ids = collectProgramIds(tx);
    assert.deepEqual(ids, [COMPUTE, ROUTER]);
    assert.equal(ids.some((id) => id.includes("object Object")), false);
    const r = parseHeliusWalletBuy(tx, W);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.buy.mint, MINT);
    assert.equal(r.buy.program, ROUTER);
    assert.deepEqual(r.buy.programIds, [ROUTER]);
    assert.ok(Math.abs(r.buy.priceSol! - 0.001) < 1e-12);
    assert.equal(r.buy.volumeSol, 1);
    assert.equal(r.buy.tradeTimeMs, 1_700_000_000_000);
  });

  it("reads an enhanced buy Helius labelled UNKNOWN, including an inner Raydium hop", () => {
    const tx = {
      signature: "sigEnhancedUnknown",
      timestamp: 1_700_000_100,
      type: "UNKNOWN",
      source: "UNKNOWN",
      fee: 5_000,
      feePayer: W,
      tokenTransfers: [
        { fromUserAccount: W, toUserAccount: "pool", mint: WSOL_MINT, tokenAmount: 0.5 },
        { fromUserAccount: "pool", toUserAccount: W, mint: MINT, tokenAmount: 2_500 },
      ],
      instructions: [
        { programId: COMPUTE, innerInstructions: [] },
        { programId: ROUTER, innerInstructions: [{ programId: RAYDIUM }] },
      ],
    };
    const r = parseHeliusWalletBuy(tx, W);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.buy.mint, MINT);
    assert.equal(r.buy.program, `${ROUTER}+raydium_amm_v4`);
    assert.deepEqual(r.buy.programIds, [ROUTER, RAYDIUM]);
    assert.ok(Math.abs(r.buy.priceSol! - 0.5 / 2_500) < 1e-12);
    assert.equal(r.buy.volumeSol, 0.5);
  });

  it("does not treat a sell as an unreadable buy", () => {
    const tx = {
      signature: "sigSell",
      type: "SWAP",
      source: "UNKNOWN",
      feePayer: W,
      fee: 5_000,
      tokenTransfers: [
        { fromUserAccount: W, toUserAccount: "pool", mint: MINT, tokenAmount: 2_500 },
        { fromUserAccount: "pool", toUserAccount: W, mint: WSOL_MINT, tokenAmount: 0.4 },
      ],
      instructions: [{ programId: ROUTER }],
    };
    const r = parseHeliusWalletBuy(tx, W);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "not_buy");
    assert.equal(r.report, false);
  });

  it("names the program id when a SWAP has no readable balance change", () => {
    const tx = {
      signature: "sigEmptySwap",
      type: "SWAP",
      source: "UNKNOWN",
      feePayer: W,
      instructions: [{ programId: COMPUTE }, { programId: ROUTER }],
    };
    const r = parseHeliusWalletBuy(tx, W);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "no_balance_change");
    assert.equal(r.report, true);
    assert.match(formatHeliusFailure(r), new RegExp(`reason=no_balance_change sig=sigEmptySwap programs=.*${ROUTER}`));
  });

  it("reports two similar received mints instead of guessing", () => {
    const tx = {
      signature: "sigAmbiguous",
      type: "SWAP",
      feePayer: W,
      tokenTransfers: [
        { fromUserAccount: W, toUserAccount: "pool", mint: WSOL_MINT, tokenAmount: 1 },
        { fromUserAccount: "pool", toUserAccount: W, mint: MINT, tokenAmount: 100 },
        { fromUserAccount: "pool", toUserAccount: W, mint: OTHER, tokenAmount: 80 },
      ],
      instructions: [{ programId: ROUTER }],
    };
    const r = parseHeliusWalletBuy(tx, W);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "ambiguous_mints");
    assert.equal(r.report, true);
    assert.ok(r.programIds.includes(ROUTER));
  });

  it("reads a USDC-quoted buy without inventing a SOL price", () => {
    const tx = {
      signature: "sigUsdc",
      type: "UNKNOWN",
      source: "UNKNOWN",
      feePayer: W,
      tokenTransfers: [
        { fromUserAccount: W, toUserAccount: "pool", mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", tokenAmount: 10 },
        { fromUserAccount: "pool", toUserAccount: W, mint: MINT, tokenAmount: 100 },
      ],
      instructions: [{ programId: ROUTER }],
    };
    const r = parseHeliusWalletBuy(tx, W);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.buy.priceSol ?? null, null);
    assert.equal(r.buy.kolPriceUsd, 0.1);
    assert.equal(r.buy.volumeSol, 0);
  });

  it("drops a failed transaction without calling it a missed buy", () => {
    const tx = {
      signature: "sigFail",
      transactionError: { InstructionError: [0, "Custom"] },
      feePayer: W,
      type: "SWAP",
      instructions: [{ programId: ROUTER }],
    };
    const r = parseHeliusWalletBuy(tx, W);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, "failed_tx");
    assert.equal(r.report, false);
    assert.ok(r.programIds.includes(ROUTER));
  });
});

describe("HeliusWalletWatch", () => {
  it("baselines the first page, then emits a new unknown-router buy and logs an empty SWAP", async () => {
    const buyTx = {
      signature: "sigBuy",
      timestamp: 1_700_000_200,
      type: "UNKNOWN",
      source: "UNKNOWN",
      feePayer: W,
      tokenTransfers: [
        { fromUserAccount: W, toUserAccount: "pool", mint: WSOL_MINT, tokenAmount: 0.2 },
        { fromUserAccount: "pool", toUserAccount: W, mint: MINT, tokenAmount: 10 },
      ],
      instructions: [{ programId: ROUTER }],
    };
    const sellTx = {
      signature: "sigSell2",
      type: "SWAP",
      feePayer: W,
      tokenTransfers: [
        { fromUserAccount: W, toUserAccount: "pool", mint: MINT, tokenAmount: 10 },
        { fromUserAccount: "pool", toUserAccount: W, mint: WSOL_MINT, tokenAmount: 0.2 },
      ],
      instructions: [{ programId: ROUTER }],
    };
    const emptyTx = {
      signature: "sigEmpty2",
      type: "SWAP",
      feePayer: W,
      instructions: [{ programId: ROUTER }],
    };
    const oldTx = { ...buyTx, signature: "sigOld" };
    const pages = [[oldTx], [emptyTx, sellTx, buyTx, oldTx]];
    let i = 0;
    const notes: string[] = [];
    const got: string[] = [];
    const watch = new HeliusWalletWatch(
      { getTransactions: async () => pages[Math.min(i++, pages.length - 1)]! },
      [W],
      (b) => got.push(b.tx),
      { pollMs: 1000, onNote: (line) => notes.push(line) },
    );
    await watch.pollOnce();
    assert.deepEqual(got, []);
    await watch.pollOnce();
    assert.deepEqual(got, ["sigBuy"]);
    assert.equal(watch.stats.buys, 1);
    assert.equal(watch.stats.rejected.not_buy, 1);
    assert.equal(watch.stats.unreadable, 1);
    assert.match(notes[0] ?? "", /reason=no_balance_change/);
    assert.match(notes[0] ?? "", new RegExp(ROUTER));
  });

  it("strips the API key from a failed history request", async () => {
    const secret = "super-secret-helius-key";
    const client = createHeliusHistoryClient(secret, async (url) => {
      throw new Error(`network down ${String(url)}`);
    });
    await assert.rejects(client.getTransactions(W), (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      assert.equal(msg.includes(secret), false);
      assert.match(msg, /\[url\]|helius history/);
      return true;
    });
    assert.equal(redactSecrets(`api-key=${secret}`).includes(secret), false);
  });
});
