/**
 * PumpPortal Local Transaction API: returns an UNSIGNED serialized tx that we
 * verify + sign locally and send through our own HTTPS RPC. No API key, no
 * custody — PumpPortal never sees the private key. Fee: 0.5% per trade.
 * Docs: https://pumpportal.fun/local-trading-api/trading-api
 */
import { fetchWithTimeout, type FetchLike } from "../market/http.js";
import { redactSecrets } from "./redact.js";

export const PUMPPORTAL_TRADE_LOCAL_URL = "https://pumpportal.fun/api/trade-local";

export interface SwapRequest {
  publicKey: string;
  action: "buy" | "sell";
  mint: string;
  /** SOL amount for buys; "100%" for full-position sells. */
  amount: number | string;
  denominatedInSol: boolean;
  slippageBps: number;
  priorityFeeSol: number;
  pool: string;
}

export interface SwapTxBuilder {
  buildTx(req: SwapRequest): Promise<Uint8Array>;
}

export class PumpPortalBuilder implements SwapTxBuilder {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 8_000,
    private readonly url = PUMPPORTAL_TRADE_LOCAL_URL,
  ) {}

  async buildTx(req: SwapRequest): Promise<Uint8Array> {
    const body = {
      publicKey: req.publicKey,
      action: req.action,
      mint: req.mint,
      amount: req.amount,
      denominatedInSol: req.denominatedInSol ? "true" : "false",
      // PumpPortal takes PERCENT, we configure bps.
      slippage: Math.round(req.slippageBps) / 100,
      priorityFee: req.priorityFeeSol,
      pool: req.pool,
    };
    let res: Response;
    try {
      res = await fetchWithTimeout(
        this.url,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
        this.timeoutMs,
        this.fetchImpl,
      );
    } catch (err) {
      throw new Error(`PumpPortal request failed: ${redactSecrets(err)}`);
    }
    if (res.status !== 200) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new Error(`PumpPortal HTTP ${res.status}${detail ? `: ${redactSecrets(detail)}` : ""}`);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length < 100) throw new Error("PumpPortal returned an empty/invalid transaction");
    return buf;
  }
}
