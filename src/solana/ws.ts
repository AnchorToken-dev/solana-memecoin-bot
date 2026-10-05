/**
 * Optional read-only Solana JSON-RPC WebSocket listener.
 *
 * When SOLANA_RPC_WSS_URL is set, connects and can subscribe to slots,
 * accounts, and logs. HTTPS (SOLANA_RPC_URL) stays the path for lookups
 * and (future) trade sends. This client never sends or signs transactions.
 *
 * Fail-soft: connect/message errors never throw out to the runner. The URL
 * is never included in status, logs, or errors.
 */
import WebSocket from "ws";
import { log } from "../logging.js";

export const SOLANA_RPC_WSS_URL_ENV = "SOLANA_RPC_WSS_URL";

/** Trimmed SOLANA_RPC_WSS_URL, or null when unset/blank. Never log the return. */
export function readSolanaRpcWssUrl(): string | null {
  const v = process.env[SOLANA_RPC_WSS_URL_ENV]?.trim();
  return v ? v : null;
}

export function solanaRpcWssIsConfigured(): boolean {
  return readSolanaRpcWssUrl() != null;
}

export type WsConnectionState =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting";

export interface SolanaWsPublicStatus {
  /** True when SOLANA_RPC_WSS_URL is set. Never the URL. */
  configured: boolean;
  state: WsConnectionState;
  connected: boolean;
  lastSlot: number | null;
  lastConnectedAt: number | null;
  /** Safe to log. Never contains the WSS URL. */
  lastError: string | null;
  reconnectAttempts: number;
  slotSubscribed: boolean;
  accountSubscriptionCount: number;
}

/** Minimal WebSocket surface we drive (real `ws` or a test double). */
export interface WebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): void;
  on(event: "close", listener: (code: number, reason: Buffer) => void): void;
  on(event: "error", listener: (err: Error) => void): void;
  on(event: "message", listener: (data: Buffer | ArrayBuffer | Buffer[] | string) => void): void;
  removeAllListeners?: () => void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const OPEN = 1;

/** Subscribe / unsubscribe methods this client may send. Anything else is blocked. */
export const READ_ONLY_WSS_METHODS = [
  "slotSubscribe",
  "slotUnsubscribe",
  "accountSubscribe",
  "accountUnsubscribe",
  "logsSubscribe",
  "logsUnsubscribe",
] as const;

const ALLOWED_METHODS = new Set<string>(READ_ONLY_WSS_METHODS);

const DEFAULT_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

function redact(message: string, secret: string): string {
  let m = message;
  if (secret) m = m.split(secret).join("[wss]");
  m = m.replace(/wss?:\/\/[^\s"'<>]+/gi, "[wss]");
  m = m.replace(/https?:\/\/[^\s"'<>]+/gi, "[rpc]");
  return m.slice(0, 240);
}

type Pending = {
  resolve: (id: number | null) => void;
  reject: (err: Error) => void;
  method: string;
};

/**
 * Read-only Solana WSS client. Construct via fromEnv() or with an explicit URL
 * (tests). Call start() to connect; stop() to tear down. Reconnects with backoff.
 */
export class ReadOnlySolanaWs {
  private socket: WebSocketLike | null = null;
  private state: WsConnectionState = "disconnected";
  private lastSlot: number | null = null;
  private lastConnectedAt: number | null = null;
  private lastError: string | null = null;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private slotSubId: number | null = null;
  private readonly accountSubs = new Map<
    string,
    { subId: number | null; pending: boolean }
  >();
  private readonly logSubs = new Map<
    string,
    { subId: number | null; pending: boolean }
  >();
  private started = false;

  constructor(
    private readonly endpoint: string,
    private readonly wsFactory: WebSocketFactory = (url) =>
      new WebSocket(url) as unknown as WebSocketLike,
    private readonly backoffMs: readonly number[] = DEFAULT_BACKOFF_MS,
  ) {}

  /** Null when SOLANA_RPC_WSS_URL is unset. Does not throw. */
  static fromEnv(wsFactory?: WebSocketFactory): ReadOnlySolanaWs | null {
    const url = readSolanaRpcWssUrl();
    if (!url) return null;
    return new ReadOnlySolanaWs(url, wsFactory);
  }

  getStatus(): SolanaWsPublicStatus {
    return {
      configured: true,
      state: this.state,
      connected: this.state === "connected" && this.socket?.readyState === OPEN,
      lastSlot: this.lastSlot,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      reconnectAttempts: this.reconnectAttempts,
      slotSubscribed: this.slotSubId != null,
      accountSubscriptionCount: [...this.accountSubs.values()].filter(
        (s) => s.subId != null,
      ).length,
    };
  }

  /** Begin connecting (idempotent). Never throws. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.intentionalClose = false;
    this.connect();
  }

  /** Tear down socket and cancel reconnect. Never throws. */
  async stop(): Promise<void> {
    this.started = false;
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectAllPending("wss stopped");
    this.slotSubId = null;
    for (const v of this.accountSubs.values()) {
      v.subId = null;
      v.pending = false;
    }
    for (const v of this.logSubs.values()) {
      v.subId = null;
      v.pending = false;
    }
    const sock = this.socket;
    this.socket = null;
    this.state = "disconnected";
    if (sock) {
      try {
        sock.removeAllListeners?.();
        sock.close();
      } catch {
        // ignore
      }
    }
  }

  /**
   * Ensure a slot subscription while connected. Safe to call repeatedly.
   * No-op when disconnected (will auto-subscribe on next open).
   */
  async ensureSlotSubscription(): Promise<void> {
    if (this.slotSubId != null) return;
    if (this.state !== "connected" || !this.socket) return;
    try {
      const id = await this.request("slotSubscribe", []);
      if (typeof id === "number") this.slotSubId = id;
    } catch (err) {
      const raw = err instanceof Error ? err.message : "slotSubscribe failed";
      this.lastError = redact(raw, this.endpoint);
      log.warn("Solana WSS slotSubscribe failed (paper continues on HTTPS)", {
        error: this.lastError,
      });
    }
  }

  /**
   * Subscribe to account changes for a pubkey (e.g. pinned mint).
   * Fail-soft: returns false on error; never throws.
   */
  async ensureAccountSubscription(pubkey: string): Promise<boolean> {
    const key = pubkey.trim();
    if (!key) return false;
    const existing = this.accountSubs.get(key);
    if (existing?.subId != null || existing?.pending) return existing.subId != null;
    this.accountSubs.set(key, { subId: null, pending: true });
    if (this.state !== "connected" || !this.socket) {
      this.accountSubs.set(key, { subId: null, pending: false });
      return false;
    }
    try {
      const id = await this.request("accountSubscribe", [
        key,
        { encoding: "base64", commitment: "confirmed" },
      ]);
      if (typeof id === "number") {
        this.accountSubs.set(key, { subId: id, pending: false });
        return true;
      }
      this.accountSubs.set(key, { subId: null, pending: false });
      return false;
    } catch (err) {
      const raw =
        err instanceof Error ? err.message : "accountSubscribe failed";
      this.lastError = redact(raw, this.endpoint);
      this.accountSubs.set(key, { subId: null, pending: false });
      return false;
    }
  }

  /**
   * Subscribe to logs that mention an address. Fail-soft; never throws.
   */
  async ensureLogsSubscription(mention: string): Promise<boolean> {
    const key = mention.trim();
    if (!key) return false;
    const existing = this.logSubs.get(key);
    if (existing?.subId != null || existing?.pending) return existing.subId != null;
    this.logSubs.set(key, { subId: null, pending: true });
    if (this.state !== "connected" || !this.socket) {
      this.logSubs.set(key, { subId: null, pending: false });
      return false;
    }
    try {
      const id = await this.request("logsSubscribe", [
        { mentions: [key] },
        { commitment: "confirmed" },
      ]);
      if (typeof id === "number") {
        this.logSubs.set(key, { subId: id, pending: false });
        return true;
      }
      this.logSubs.set(key, { subId: null, pending: false });
      return false;
    } catch (err) {
      const raw = err instanceof Error ? err.message : "logsSubscribe failed";
      this.lastError = redact(raw, this.endpoint);
      this.logSubs.set(key, { subId: null, pending: false });
      return false;
    }
  }

  private connect(): void {
    if (!this.started || this.intentionalClose) return;
    if (
      this.socket &&
      (this.state === "connecting" || this.state === "connected")
    ) {
      return;
    }
    this.state =
      this.reconnectAttempts > 0 ? "reconnecting" : "connecting";
    let sock: WebSocketLike;
    try {
      sock = this.wsFactory(this.endpoint);
    } catch (err) {
      const raw = err instanceof Error ? err.message : "wss construct failed";
      this.lastError = redact(raw, this.endpoint);
      this.scheduleReconnect();
      return;
    }
    this.socket = sock;

    sock.on("open", () => {
      if (this.socket !== sock) return;
      this.state = "connected";
      this.lastConnectedAt = Date.now();
      this.lastError = null;
      this.reconnectAttempts = 0;
      this.slotSubId = null;
      for (const v of this.accountSubs.values()) {
        v.subId = null;
        v.pending = false;
      }
      for (const v of this.logSubs.values()) {
        v.subId = null;
        v.pending = false;
      }
      log.info("Solana WSS connected (read-only listen)");
      void this.resubscribeAll();
    });

    sock.on("message", (data) => {
      if (this.socket !== sock) return;
      try {
        this.handleMessage(String(data));
      } catch (err) {
        const raw =
          err instanceof Error ? err.message : "wss message handler error";
        this.lastError = redact(raw, this.endpoint);
      }
    });

    sock.on("error", (err) => {
      if (this.socket !== sock) return;
      const raw = err instanceof Error ? err.message : "wss error";
      this.lastError = redact(raw || "wss error", this.endpoint);
      log.warn("Solana WSS error (falling back to HTTPS/poll)", {
        error: this.lastError,
      });
    });

    sock.on("close", () => {
      if (this.socket !== sock) return;
      this.socket = null;
      this.rejectAllPending("wss closed");
      this.slotSubId = null;
      for (const v of this.accountSubs.values()) {
        v.subId = null;
        v.pending = false;
      }
      for (const v of this.logSubs.values()) {
        v.subId = null;
        v.pending = false;
      }
      if (this.intentionalClose || !this.started) {
        this.state = "disconnected";
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (!this.started || this.intentionalClose) {
      this.state = "disconnected";
      return;
    }
    this.state = "reconnecting";
    const delay =
      this.backoffMs[
        Math.min(this.reconnectAttempts, this.backoffMs.length - 1)
      ] ?? 30_000;
    this.reconnectAttempts += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private async resubscribeAll(): Promise<void> {
    await this.ensureSlotSubscription();
    const accounts = [...this.accountSubs.keys()];
    for (const pk of accounts) {
      this.accountSubs.set(pk, { subId: null, pending: false });
      await this.ensureAccountSubscription(pk);
    }
    const logs = [...this.logSubs.keys()];
    for (const m of logs) {
      this.logSubs.set(m, { subId: null, pending: false });
      await this.ensureLogsSubscription(m);
    }
  }

  private request(method: string, params: unknown[]): Promise<number | null> {
    if (!ALLOWED_METHODS.has(method)) {
      return Promise.reject(new Error(`blocked wss method: ${method}`));
    }
    if (!this.socket || this.socket.readyState !== OPEN) {
      return Promise.reject(new Error("wss not connected"));
    }
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise<number | null>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.socket!.send(body);
      } catch (err) {
        this.pending.delete(id);
        const raw = err instanceof Error ? err.message : "wss send failed";
        reject(new Error(redact(raw, this.endpoint)));
      }
    });
  }

  private handleMessage(raw: string): void {
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      this.lastError = "wss message was not JSON";
      return;
    }
    if (!json || typeof json !== "object") return;
    const obj = json as {
      id?: unknown;
      result?: unknown;
      error?: { message?: string };
      method?: unknown;
      params?: { result?: unknown; subscription?: unknown };
    };

    if (typeof obj.id === "number" && this.pending.has(obj.id)) {
      const p = this.pending.get(obj.id)!;
      this.pending.delete(obj.id);
      if (obj.error) {
        const msg =
          typeof obj.error.message === "string"
            ? obj.error.message
            : "wss rpc error";
        p.reject(new Error(redact(msg, this.endpoint)));
        return;
      }
      p.resolve(typeof obj.result === "number" ? obj.result : null);
      return;
    }

    // Notifications
    if (obj.method === "slotNotification" && obj.params?.result) {
      const slot = (obj.params.result as { slot?: unknown }).slot;
      if (typeof slot === "number") this.lastSlot = slot;
      return;
    }
    // accountNotification / logsNotification: track liveness only for now
    if (
      obj.method === "accountNotification" ||
      obj.method === "logsNotification"
    ) {
      // Intentionally no trading side effects. Presence keeps the subscription live.
      return;
    }
  }

  private rejectAllPending(reason: string): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new Error(reason));
    }
  }
}

/** Status when WSS is not configured (safe for /status). */
export function emptySolanaWsStatus(): SolanaWsPublicStatus {
  return {
    configured: false,
    state: "disconnected",
    connected: false,
    lastSlot: null,
    lastConnectedAt: null,
    lastError: null,
    reconnectAttempts: 0,
    slotSubscribed: false,
    accountSubscriptionCount: 0,
  };
}
