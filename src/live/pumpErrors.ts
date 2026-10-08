/**
 * Turn a failed buy/sell (simulation error, PumpPortal HTTP error) into a
 * plain-English reason + a failure "kind" the engine uses to decide whether
 * to retry the coin soon, later, or not at all.
 */
import { PUMP_CURVE_ERRORS, PUMPSWAP_ERRORS } from "./pumpErrorCodes.js";
import { PUMP_CURVE_PROGRAM_ID, PUMPSWAP_PROGRAM_ID } from "./pumpswapPool.js";

/** Router PumpPortal's bonding-curve buys go through; it CPIs into the pump.fun program. */
export const PUMP_CURVE_ROUTER_IDS = new Set(["FAdo9NCw1ssek6Z6yeWzWjhLVsr8uiCwcWNUnKgzTnHe"]);

export type BuyFailureKind =
  /** Price needed more SOL than the slippage cap allowed (the chain protected us). */
  | "slippage"
  /** Coin left the bonding curve (graduated to PumpSwap) — must trade on PumpSwap. */
  | "migrated"
  /** Coin is paired with a non-SOL token (PUMP, USDC, tokenized stock…); PumpPortal can't buy it with SOL. */
  | "unsupported_quote"
  /** PumpPortal refused to build a tx for this coin (HTTP 400). */
  | "build_rejected"
  /** PumpSwap pool is too thin / quote gap too big to buy safely. */
  | "pool_too_thin"
  /** Sent but outcome unknown — never re-buy quickly (could double up). */
  | "unconfirmed"
  /** Not about this coin (balance, SOL price, network, RPC). */
  | "not_coin_specific"
  | "other";

export type ProgramName = "pump" | "pumpswap" | "other";

export interface DecodedProgramError {
  instruction: number;
  code: number;
  program: ProgramName;
  programId: string | null;
  name: string | null;
  kind: BuyFailureKind;
  /** One plain-English sentence. */
  plain: string;
  /** e.g. "needed 0.1301 SOL, cap was 0.1150 SOL, 13% over". */
  detail?: string;
}

const PLAIN: Record<string, { kind: BuyFailureKind; text: string }> = {
  // pump.fun bonding curve
  "pump:TooMuchSolRequired": { kind: "slippage", text: "price moved up past the slippage limit before the buy landed" },
  "pump:BuySlippageBelowMinTokensOut": { kind: "slippage", text: "price moved up past the slippage limit before the buy landed" },
  "pump:TooLittleSolReceived": { kind: "slippage", text: "price moved down past the slippage limit before the sell landed" },
  "pump:BondingCurveComplete": { kind: "migrated", text: "coin already graduated off the pump.fun curve to PumpSwap, but the tx was built for the curve" },
  "pump:BondingCurveAlreadyMigrated": { kind: "migrated", text: "coin already graduated off the pump.fun curve to PumpSwap, but the tx was built for the curve" },
  "pump:QuoteCurveAwaitingMigration": { kind: "migrated", text: "coin is mid-graduation to PumpSwap" },
  "pump:UnsupportedQuoteMint": { kind: "unsupported_quote", text: "coin is paired with a non-SOL token, and PumpPortal built a plain SOL buy" },
  "pump:QuoteMintNotWhitelisted": { kind: "unsupported_quote", text: "coin is paired with a non-SOL token PumpPortal can't trade" },
  "pump:BuyNotEnoughSolToCoverRent": { kind: "not_coin_specific", text: "not enough SOL left for account rent" },
  "pump:BuyNotEnoughSolToCoverFees": { kind: "not_coin_specific", text: "not enough SOL to cover fees" },
  // PumpSwap AMM
  "pumpswap:ExceededSlippage": { kind: "slippage", text: "buy needed more SOL than the slippage cap allowed" },
  "pumpswap:BuySlippageBelowMinBaseAmountOut": { kind: "slippage", text: "buy would get fewer tokens than the slippage limit allows" },
  "pumpswap:UnsupportedBaseMint": { kind: "build_rejected", text: "PumpSwap doesn't support this coin" },
  "pumpswap:DisabledBuy": { kind: "other", text: "buying is disabled on this PumpSwap pool" },
  "pumpswap:InsufficientRealQuoteReserves": { kind: "pool_too_thin", text: "pool doesn't hold enough real SOL for this trade" },
};

function programNameFor(id: string | null): ProgramName {
  if (!id) return "other";
  if (id === PUMP_CURVE_PROGRAM_ID || PUMP_CURVE_ROUTER_IDS.has(id)) return "pump";
  if (id === PUMPSWAP_PROGRAM_ID) return "pumpswap";
  return "other";
}

function customError(err: unknown): { instruction: number; code: number } | null {
  let e = err;
  if (typeof e === "string") {
    try {
      e = JSON.parse(e);
    } catch {
      return null;
    }
  }
  const ie = (e as { InstructionError?: unknown })?.InstructionError;
  if (!Array.isArray(ie) || ie.length !== 2) return null;
  const code = (ie[1] as { Custom?: unknown })?.Custom;
  if (typeof ie[0] !== "number" || typeof code !== "number") return null;
  return { instruction: ie[0], code };
}

const FAILED_RE = /^Program (\w{32,44}) failed: custom program error: 0x([0-9a-fA-F]+)/;

/** Innermost program that raised the custom error, from simulation logs. */
function failingProgramFromLogs(logs: string[] | null | undefined, code: number): string | null {
  for (const l of logs ?? []) {
    const m = FAILED_RE.exec(l);
    if (m && parseInt(m[2]!, 16) === code) return m[1]!;
  }
  for (const l of logs ?? []) {
    if (l.includes("programs/pump-amm/")) return PUMPSWAP_PROGRAM_ID;
    if (/programs\/pump\//.test(l)) return PUMP_CURVE_PROGRAM_ID;
  }
  return null;
}

function slippageDetail(logs: string[] | null | undefined): string | undefined {
  let left: number | null = null;
  let right: number | null = null;
  for (const l of logs ?? []) {
    const lm = /Left:\s*(\d+)/.exec(l);
    const rm = /Right:\s*(\d+)/.exec(l);
    if (lm) left = Number(lm[1]);
    if (rm) right = Number(rm[1]);
  }
  if (left == null || right == null || !(left > 0)) return undefined;
  const over = ((right / left - 1) * 100).toFixed(0);
  return `needed ${(right / 1e9).toFixed(4)} SOL, cap was ${(left / 1e9).toFixed(4)} SOL, ${over}% over`;
}

/**
 * Decode a simulateTransaction / on-chain error. `programIds` (optional) is
 * the outer program of each instruction in the tx, for when logs are missing.
 */
export function decodeProgramError(
  err: unknown,
  logs?: string[] | null,
  programIds?: (string | null)[] | null,
): DecodedProgramError | null {
  const ce = customError(err);
  if (!ce) return null;
  const programId = failingProgramFromLogs(logs, ce.code) ?? programIds?.[ce.instruction] ?? null;
  const program = programNameFor(programId);
  const table = program === "pump" ? PUMP_CURVE_ERRORS : program === "pumpswap" ? PUMPSWAP_ERRORS : null;
  const name = table?.[ce.code] ?? null;
  const p = name ? PLAIN[`${program}:${name}`] : undefined;
  const venue = program === "pump" ? "pump.fun curve" : program === "pumpswap" ? "PumpSwap" : "unknown program";
  const out: DecodedProgramError = {
    instruction: ce.instruction,
    code: ce.code,
    program,
    programId,
    name,
    kind: p?.kind ?? "other",
    plain: p ? `${venue} ${name}: ${p.text}` : `${venue} error ${ce.code}${name ? ` (${name})` : ""}`,
  };
  if (out.kind === "slippage") {
    const d = slippageDetail(logs);
    if (d) out.detail = d;
  }
  return out;
}

/** Classify a build-stage failure message (PumpPortal HTTP / network). */
export function classifyBuildFailure(message: string): { kind: BuyFailureKind; plain: string } {
  if (/HTTP 400\b/.test(message)) {
    return {
      kind: "build_rejected",
      plain:
        "PumpPortal refused to build a buy for this coin (HTTP 400) — usually a coin paired with a non-SOL token (PUMP, USDC, a tokenized stock) or a pool PumpPortal can't route",
    };
  }
  return { kind: "not_coin_specific", plain: "couldn't reach PumpPortal or sign the tx" };
}

/** Classify a free-text failure reason (for results that carry no structured kind). */
export function classifyReason(reason: string): BuyFailureKind {
  if (/HTTP 400\b/.test(reason)) return "build_rejected";
  if (/insufficient SOL|SOL\/USD|balance check|zero notional|PumpPortal request failed|simulate: |HTTP 5\d\d|HTTP 429/.test(reason)) {
    return "not_coin_specific";
  }
  const d = decodeProgramError((/simulation failed: (.*)$/.exec(reason) ?? [])[1] ?? null);
  return d?.kind ?? "other";
}
