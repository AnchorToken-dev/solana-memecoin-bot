import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BotEngine } from "../src/engine/botEngine.js";
import { loadConfig } from "../src/config.js";
import type { BotConfig } from "../src/types.js";
import { base58Encode } from "../src/solana/base58.js";
import {
  READ_ONLY_RPC_METHODS,
  ReadOnlySolanaRpc,
  parseSplMint,
} from "../src/solana/rpc.js";
import type { FetchLike } from "../src/market/http.js";

const SECRET_URL = "https://rpc.example/secret-key-abc";

function cfg(over: Partial<BotConfig> = {}): BotConfig {
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
    runner: { pollIntervalMs: 15_000, scanLimit: 5, maxCycles: 0 },
    maxHoldMinutes: 20,
    dailyLossUsd: 5,
    chaseLockoutHours: 12,
    marketDataSource: "mock",
    ledgerDir: "data",
    activePreset: "custom",
    requireChecklistGo: false,
    ...over,
  };
}

function pubkey(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

function writeCOption(buf: Buffer, offset: number, pk: Uint8Array | null): void {
  buf.writeUInt32LE(pk ? 1 : 0, offset);
  if (pk) buf.set(pk, offset + 4);
}

function mintBytes(opts: {
  freeze: Uint8Array | null;
  supply: bigint;
  decimals?: number;
}): Buffer {
  const buf = Buffer.alloc(82);
  writeCOption(buf, 0, pubkey(2));
  buf.writeBigUInt64LE(opts.supply, 36);
  buf[44] = opts.decimals ?? 6;
  buf[45] = 1;
  writeCOption(buf, 46, opts.freeze);
  return buf;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("base58 + SPL mint parse", () => {
  it("encodes 32 zero bytes as the well-known system-program style string", () => {
    assert.equal(base58Encode(new Uint8Array(32)), "1".repeat(32));
    assert.equal(base58Encode(new Uint8Array([1])), "2");
  });

  it("reads freeze authority none vs set", () => {
    const none = parseSplMint(mintBytes({ freeze: null, supply: 1_000_000n }));
    assert.ok(none);
    assert.equal(none!.freezeAuthority, null);
    assert.equal(none!.supply, 1_000_000n);
    assert.equal(none!.decimals, 6);
    const freezePk = pubkey(9);
    const some = parseSplMint(
      mintBytes({ freeze: freezePk, supply: 5n, decimals: 6 }),
    );
    assert.equal(some!.freezeAuthority, base58Encode(freezePk));
  });
});

describe("ReadOnlySolanaRpc mocked HTTP", () => {
  it("exposes only read methods (no send, sign, or keypair)", () => {
    const blocked = ["sendTransaction", "signTransaction", "requestAirdrop"];
    for (const m of blocked) {
      assert.equal(
        (READ_ONLY_RPC_METHODS as readonly string[]).includes(m),
        false,
        m,
      );
    }
    const names = Object.getOwnPropertyNames(ReadOnlySolanaRpc.prototype);
    assert.deepEqual(
      names.filter((n) => /sendTransaction|signTransaction|keypair|privateKey/i.test(n)),
      [],
    );
  });

  it("parses account info, mint, signatures, transaction, and largest accounts", async () => {
    const freeze = pubkey(7);
    const mint = mintBytes({ freeze, supply: 2_000_000n });
    const methods: string[] = [];
    const fetchImpl: FetchLike = async (_input, init) => {
      const req = JSON.parse(String(init?.body)) as {
        method: string;
        params: unknown[];
      };
      methods.push(req.method);
      if (req.method === "getAccountInfo") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            context: { slot: 9 },
            value: {
              lamports: 1_000_000,
              owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
              executable: false,
              data: [mint.toString("base64"), "base64"],
            },
          },
        });
      }
      if (req.method === "getSignaturesForAddress") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: [
            { signature: "sigB", slot: 12, err: null, blockTime: 100 },
            { signature: "sigA", slot: 11, err: null, blockTime: 90 },
          ],
        });
      }
      if (req.method === "getTransaction") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            slot: 11,
            blockTime: 90,
            transaction: { signatures: ["sigA"] },
            meta: { err: null },
          },
        });
      }
      if (req.method === "getTokenLargestAccounts") {
        return jsonResponse({
          jsonrpc: "2.0",
          id: 1,
          result: {
            context: { slot: 12 },
            value: [
              { address: "HolderA", amount: "100", decimals: 6, uiAmount: 0.0001 },
            ],
          },
        });
      }
      throw new Error(`unexpected method ${req.method}`);
    };

    const rpc = new ReadOnlySolanaRpc(SECRET_URL, fetchImpl);
    const info = await rpc.getAccountInfo("Mint111");
    assert.equal(info.ok, true);
    if (info.ok && info.value) {
      assert.equal(info.value.owner.startsWith("Tokenkeg"), true);
      assert.equal(info.value.data.length, 82);
    }
    const parsed = await rpc.getMintAccount("Mint111");
    assert.equal(parsed.ok, true);
    if (parsed.ok && parsed.value) {
      assert.equal(parsed.value.freezeAuthority, base58Encode(freeze));
      assert.equal(parsed.value.supply, 2_000_000n);
    }
    const sigs = await rpc.getSignaturesForAddress("Mint111", { limit: 10 });
    assert.equal(sigs.ok, true);
    if (sigs.ok) {
      assert.equal(sigs.value.length, 2);
      assert.equal(sigs.value[1]!.slot, 11);
    }
    const tx = await rpc.getTransaction("sigA");
    assert.equal(tx.ok, true);
    if (tx.ok && tx.value) assert.equal(tx.value.slot, 11);
    const largest = await rpc.getTokenLargestAccounts("Mint111");
    assert.equal(largest.ok, true);
    if (largest.ok) {
      assert.equal(largest.value[0]!.address, "HolderA");
      assert.equal(largest.value[0]!.amount, 100n);
    }
    assert.deepEqual(methods, [
      "getAccountInfo",
      "getAccountInfo",
      "getSignaturesForAddress",
      "getTransaction",
      "getTokenLargestAccounts",
    ]);
    assert.ok(!methods.includes("sendTransaction"));
  });

  it("returns ok:false on HTTP and RPC errors and never echoes the URL", async () => {
    const httpFail: FetchLike = async () =>
      jsonResponse({ error: "nope" }, 500);
    const rpc = new ReadOnlySolanaRpc(SECRET_URL, httpFail);
    const httpRes = await rpc.getAccountInfo("Mint111");
    assert.equal(httpRes.ok, false);
    if (!httpRes.ok) {
      assert.equal(httpRes.error.includes("secret-key-abc"), false);
      assert.equal(httpRes.error.includes("rpc.example"), false);
      assert.match(httpRes.error, /HTTP 500/);
    }

    const rpcFail: FetchLike = async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32600, message: `boom calling ${SECRET_URL}` },
      });
    const rpc2 = new ReadOnlySolanaRpc(SECRET_URL, rpcFail);
    const rpcRes = await rpc2.getSignaturesForAddress("Mint111");
    assert.equal(rpcRes.ok, false);
    if (!rpcRes.ok) {
      assert.equal(rpcRes.error.includes("secret-key-abc"), false);
      assert.equal(rpcRes.error.includes("rpc.example"), false);
      assert.match(rpcRes.error, /boom calling \[rpc\]/);
    }

    const thrown: FetchLike = async () => {
      throw new Error(`connect failed ${SECRET_URL}`);
    };
    const rpc3 = new ReadOnlySolanaRpc(SECRET_URL, thrown);
    const thrownRes = await rpc3.getTransaction("sig");
    assert.equal(thrownRes.ok, false);
    if (!thrownRes.ok) {
      assert.equal(thrownRes.error.includes("secret"), false);
      assert.equal(thrownRes.error.includes("http"), false);
    }
  });

  it("treats a missing account as null, not a throw", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { context: { slot: 1 }, value: null },
      });
    const rpc = new ReadOnlySolanaRpc(SECRET_URL, fetchImpl);
    const res = await rpc.getMintAccount("Missing");
    assert.deepEqual(res, { ok: true, value: null });
  });
});

describe("SOLANA_RPC_URL config surface", () => {
  it("unset keeps solanaRpcConfigured false and does not require an RPC", () => {
    const prev = process.env.SOLANA_RPC_URL;
    delete process.env.SOLANA_RPC_URL;
    try {
      const loaded = loadConfig({ skipRuntimeOverlay: true });
      assert.equal(loaded.solanaRpcConfigured, false);
      assert.equal(loaded.marketDataSource === "mock" || loaded.marketDataSource === "pumpfun" || loaded.marketDataSource === "dexscreener", true);
      assert.equal(JSON.stringify(loaded).includes("SOLANA_RPC_URL"), false);
    } finally {
      if (prev === undefined) delete process.env.SOLANA_RPC_URL;
      else process.env.SOLANA_RPC_URL = prev;
    }
  });

  it("set marks configured on /config and /status without printing the URL", () => {
    const prev = process.env.SOLANA_RPC_URL;
    process.env.SOLANA_RPC_URL = SECRET_URL;
    try {
      const loaded = loadConfig({ skipRuntimeOverlay: true });
      assert.equal(loaded.solanaRpcConfigured, true);
      const blob = JSON.stringify(loaded);
      assert.equal(blob.includes("secret-key-abc"), false);
      assert.equal(blob.includes("rpc.example"), false);
      assert.equal(ReadOnlySolanaRpc.fromEnv() instanceof ReadOnlySolanaRpc, true);

      const engine = new BotEngine({ ...cfg(), solanaRpcConfigured: true });
      const status = engine.getStatus();
      assert.equal(status.solanaRpcConfigured, true);
      const statusBlob = JSON.stringify(status);
      assert.equal(statusBlob.includes("secret-key-abc"), false);
      const pub = JSON.stringify(engine.getPublicConfig());
      assert.equal(pub.includes("secret-key-abc"), false);
      assert.equal(pub.includes(SECRET_URL), false);
    } finally {
      if (prev === undefined) delete process.env.SOLANA_RPC_URL;
      else process.env.SOLANA_RPC_URL = prev;
    }
  });

  it("fromEnv is null when the variable is blank", () => {
    const prev = process.env.SOLANA_RPC_URL;
    process.env.SOLANA_RPC_URL = "   ";
    try {
      assert.equal(ReadOnlySolanaRpc.fromEnv(), null);
    } finally {
      if (prev === undefined) delete process.env.SOLANA_RPC_URL;
      else process.env.SOLANA_RPC_URL = prev;
    }
  });
});
