/**
 * Trading-mode gate. PAPER is the default and wins on ANY doubt.
 *
 * LIVE (dry-run or real) requires ALL of:
 *   PAPER_MODE=false
 *   LIVE_TRADING_ENABLED=true
 *   LIVE_CONFIRM=I_UNDERSTAND   (exact, case-sensitive)
 * Then LIVE_DRY_RUN decides dry-run vs real sends. Dry-run stays ON unless
 * LIVE_DRY_RUN is exactly "false".
 */
export type TradingMode = "paper" | "live_dry_run" | "live";

export const LIVE_CONFIRM_PHRASE = "I_UNDERSTAND";

export type Env = Record<string, string | undefined>;

export interface ModeDecision {
  mode: TradingMode;
  /** Why we ended up in paper (empty for live modes). Safe to log. */
  paperReasons: string[];
}

function isExplicitFalse(v: string | undefined): boolean {
  return v != null && ["false", "0", "no", "off"].includes(v.trim().toLowerCase());
}
function isExplicitTrue(v: string | undefined): boolean {
  return v != null && ["true", "1", "yes", "on"].includes(v.trim().toLowerCase());
}

export function resolveTradingMode(env: Env = process.env): ModeDecision {
  const reasons: string[] = [];
  if (!isExplicitFalse(env.PAPER_MODE)) reasons.push("PAPER_MODE is not false");
  if (!isExplicitTrue(env.LIVE_TRADING_ENABLED)) reasons.push("LIVE_TRADING_ENABLED is not true");
  if ((env.LIVE_CONFIRM ?? "") !== LIVE_CONFIRM_PHRASE) {
    reasons.push(`LIVE_CONFIRM is not ${LIVE_CONFIRM_PHRASE}`);
  }
  if (reasons.length > 0) return { mode: "paper", paperReasons: reasons };
  // Only the literal word "false" turns dry-run off. Anything else = dry-run.
  const dry = (env.LIVE_DRY_RUN ?? "").trim().toLowerCase() !== "false";
  return { mode: dry ? "live_dry_run" : "live", paperReasons: [] };
}

export function modeLabel(mode: TradingMode): "PAPER" | "LIVE DRY-RUN" | "LIVE" {
  return mode === "paper" ? "PAPER" : mode === "live_dry_run" ? "LIVE DRY-RUN" : "LIVE";
}

export interface LiveSettings {
  maxPositionUsd: number;
  maxOpenPositions: number;
  dailyLossLimitUsd: number;
  minSolReserve: number;
  slippageBps: number;
  sellMaxSlippageBps: number;
  sellMaxAttempts: number;
  priorityFeeSol: number;
  priorityFeeMaxSol: number;
  confirmTimeoutMs: number;
  confirmPollMs: number;
  pool: string;
}

function num(env: Env, k: string, d: number, min: number, max: number): number {
  const raw = env[k];
  if (raw == null || raw.trim() === "") return d;
  const n = Number(raw);
  if (!Number.isFinite(n)) return d;
  return Math.min(Math.max(n, min), max);
}

/** Live hard caps — separate from paper knobs, env only (never PATCH-able). */
export function loadLiveSettings(env: Env = process.env): LiveSettings {
  const priorityFeeMaxSol = num(env, "LIVE_PRIORITY_FEE_MAX_SOL", 0.001, 0, 0.01);
  const slippageBps = num(env, "LIVE_SLIPPAGE_BPS", 1500, 10, 5000);
  const pool = (env.LIVE_POOL ?? "auto").trim();
  return {
    maxPositionUsd: num(env, "LIVE_MAX_POSITION_USD", 60, 1, 1000),
    maxOpenPositions: Math.floor(num(env, "LIVE_MAX_OPEN_POSITIONS", 1, 1, 5)),
    dailyLossLimitUsd: num(env, "LIVE_DAILY_LOSS_LIMIT_USD", 30, 1, 10_000),
    minSolReserve: num(env, "LIVE_MIN_SOL_RESERVE", 0.05, 0.01, 10),
    slippageBps,
    sellMaxSlippageBps: Math.max(slippageBps, num(env, "LIVE_SELL_MAX_SLIPPAGE_BPS", 4000, 10, 9000)),
    sellMaxAttempts: Math.floor(num(env, "LIVE_SELL_MAX_ATTEMPTS", 4, 1, 10)),
    // Clamped to the hard cap no matter what the env says.
    priorityFeeSol: Math.min(num(env, "LIVE_PRIORITY_FEE_SOL", 0.0002, 0, 0.01), priorityFeeMaxSol),
    priorityFeeMaxSol,
    confirmTimeoutMs: num(env, "LIVE_CONFIRM_TIMEOUT_MS", 60_000, 5_000, 180_000),
    confirmPollMs: num(env, "LIVE_CONFIRM_POLL_MS", 1_500, 100, 10_000),
    pool: ["pump", "pump-amm", "raydium", "auto"].includes(pool) ? pool : "auto",
  };
}

/** Slippage ladder for sell retries: base → … → cap, length = attempts. */
export function sellSlippageLadder(s: Pick<LiveSettings, "slippageBps" | "sellMaxSlippageBps" | "sellMaxAttempts">): number[] {
  const n = Math.max(1, s.sellMaxAttempts);
  if (n === 1) return [s.slippageBps];
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(Math.round(s.slippageBps + ((s.sellMaxSlippageBps - s.slippageBps) * i) / (n - 1)));
  }
  return out;
}
