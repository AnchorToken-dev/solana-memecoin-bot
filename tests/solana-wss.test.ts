import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { BotEngine } from "../src/engine/botEngine.js";
import { loadConfig } from "../src/config.js";
import type { BotConfig } from "../src/types.js";
import {
  READ_ONLY_WSS_METHODS,
  ReadOnlySolanaWs,
  emptySolanaWsStatus,
  type WebSocketLike,
} from "../src/solana/ws.js";

const SECRET_WSS = "wss://rpc.example/secret-wss-key-xyz";

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
    solanaRpcConfigured: false,
    solanaRpcWssConfigured: false,
    ...over,
  };
}

class FakeSocket extends EventEmitter implements WebSocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    if (this.readyState !== 1) throw new Error(`send while state=${this.readyState}`);
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.emit("close", 1000, Buffer.from(""));
  }

  openNow(): void {
    this.readyState = 1;
    this.emit("open");
  }

  pushServer(msg: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(msg)));
  }

  removeAllListeners(): this {
    return super.removeAllListeners();
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("ReadOnlySolanaWs methods", () => {
  it("allows only subscribe/unsubscribe listen methods", () => {
    for (const blocked of [
      "sendTransaction",
      "signatureSubscribe", // not in allow-list for this client
      "requestAirdrop",
    ]) {
      assert.equal(
        (READ_ONLY_WSS_METHODS as readonly string[]).includes(blocked),
        false,
        blocked,
      );
    }
    assert.ok(READ_ONLY_WSS_METHODS.includes("slotSubscribe"));
    assert.ok(READ_ONLY_WSS_METHODS.includes("accountSubscribe"));
    assert.ok(READ_ONLY_WSS_METHODS.includes("logsSubscribe"));
  });
});

describe("ReadOnlySolanaWs mocked socket", () => {
  it("connects, slot-subscribes, tracks lastSlot, and never echoes the URL", async () => {
    let created = 0;
    let sock!: FakeSocket;
    const ws = new ReadOnlySolanaWs(
      SECRET_WSS,
      () => {
        created += 1;
        sock = new FakeSocket();
        queueMicrotask(() => sock.openNow());
        return sock;
      },
      [50, 50],
    );

    ws.start();
    await wait(20);
    assert.equal(created, 1);
    assert.equal(ws.getStatus().connected, true);
    assert.equal(ws.getStatus().state, "connected");

    // Respond to slotSubscribe
    assert.equal(sock.sent.length, 1);
    const req = JSON.parse(sock.sent[0]!) as {
      method: string;
      id: number;
    };
    assert.equal(req.method, "slotSubscribe");
    sock.pushServer({ jsonrpc: "2.0", id: req.id, result: 42 });
    await wait(10);
    assert.equal(ws.getStatus().slotSubscribed, true);

    sock.pushServer({
      jsonrpc: "2.0",
      method: "slotNotification",
      params: { result: { slot: 9_001 }, subscription: 42 },
    });
    assert.equal(ws.getStatus().lastSlot, 9_001);

    const blob = JSON.stringify(ws.getStatus());
    assert.equal(blob.includes("secret-wss-key-xyz"), false);
    assert.equal(blob.includes("rpc.example"), false);

    await ws.stop();
    assert.equal(ws.getStatus().connected, false);
    assert.equal(ws.getStatus().state, "disconnected");
  });

  it("redacts the URL from errors and reconnects after close", async () => {
    let sock!: FakeSocket;
    let n = 0;
    const ws = new ReadOnlySolanaWs(
      SECRET_WSS,
      () => {
        n += 1;
        sock = new FakeSocket();
        queueMicrotask(() => sock.openNow());
        return sock;
      },
      [30, 30],
    );
    ws.start();
    await wait(20);
    assert.equal(n, 1);

    // Force an error with the secret in the message
    sock.emit("error", new Error(`boom ${SECRET_WSS}`));
    await wait(5);
    const err = ws.getStatus().lastError;
    assert.ok(err);
    assert.equal(err!.includes("secret-wss-key-xyz"), false);
    assert.equal(err!.includes("rpc.example"), false);

    // Drop and expect reconnect
    sock.close();
    await wait(80);
    assert.ok(n >= 2, `expected reconnect, got ${n}`);
    await ws.stop();
  });

  it("accountSubscribe is fail-soft when disconnected", async () => {
    const ws = new ReadOnlySolanaWs(SECRET_WSS, () => {
      throw new Error(`cannot open ${SECRET_WSS}`);
    });
    // start will catch construct failure and schedule reconnect
    ws.start();
    await wait(5);
    const ok = await ws.ensureAccountSubscription("Mint11111111111111111111111111111111");
    assert.equal(ok, false);
    const st = ws.getStatus();
    assert.equal(st.connected, false);
    if (st.lastError) {
      assert.equal(st.lastError.includes("secret"), false);
    }
    await ws.stop();
  });

  it("fromEnv is null when blank", () => {
    const prev = process.env.SOLANA_RPC_WSS_URL;
    process.env.SOLANA_RPC_WSS_URL = "   ";
    try {
      assert.equal(ReadOnlySolanaWs.fromEnv(), null);
    } finally {
      if (prev === undefined) delete process.env.SOLANA_RPC_WSS_URL;
      else process.env.SOLANA_RPC_WSS_URL = prev;
    }
  });
});

describe("SOLANA_RPC_WSS_URL config surface", () => {
  it("unset keeps solanaRpcWssConfigured false", () => {
    const prev = process.env.SOLANA_RPC_WSS_URL;
    delete process.env.SOLANA_RPC_WSS_URL;
    try {
      const loaded = loadConfig({ skipRuntimeOverlay: true });
      assert.equal(loaded.solanaRpcWssConfigured, false);
      assert.equal(JSON.stringify(loaded).includes("SOLANA_RPC_WSS_URL"), false);
    } finally {
      if (prev === undefined) delete process.env.SOLANA_RPC_WSS_URL;
      else process.env.SOLANA_RPC_WSS_URL = prev;
    }
  });

  it("set marks configured on /status without printing the URL", () => {
    const prev = process.env.SOLANA_RPC_WSS_URL;
    process.env.SOLANA_RPC_WSS_URL = SECRET_WSS;
    try {
      const loaded = loadConfig({ skipRuntimeOverlay: true });
      assert.equal(loaded.solanaRpcWssConfigured, true);
      const blob = JSON.stringify(loaded);
      assert.equal(blob.includes("secret-wss-key-xyz"), false);
      assert.equal(blob.includes("rpc.example"), false);

      let sock!: FakeSocket;
      const fakeWs = new ReadOnlySolanaWs(SECRET_WSS, () => {
        sock = new FakeSocket();
        queueMicrotask(() => sock.openNow());
        return sock;
      });
      const engine = new BotEngine(
        { ...cfg(), solanaRpcWssConfigured: true },
        { solanaWs: fakeWs },
      );
      const status = engine.getStatus();
      assert.equal(status.solanaRpcWss.configured, true);
      const statusBlob = JSON.stringify(status);
      assert.equal(statusBlob.includes("secret-wss-key-xyz"), false);
      assert.equal(statusBlob.includes(SECRET_WSS), false);
      const pub = JSON.stringify(engine.getPublicConfig());
      assert.equal(pub.includes("secret-wss-key-xyz"), false);
      assert.equal(emptySolanaWsStatus().configured, false);
    } finally {
      if (prev === undefined) delete process.env.SOLANA_RPC_WSS_URL;
      else process.env.SOLANA_RPC_WSS_URL = prev;
    }
  });

  it("engine without WSS reports empty status and paper still starts", async () => {
    const engine = new BotEngine(cfg(), { solanaWs: null });
    const st = engine.getStatus();
    assert.deepEqual(st.solanaRpcWss, emptySolanaWsStatus());
    const started = await engine.start();
    assert.equal(started.ok, true);
    await engine.stop();
  });
});
