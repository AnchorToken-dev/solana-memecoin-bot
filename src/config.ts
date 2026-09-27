import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import type { BotConfig } from "./types.js";

loadDotenv();

const MomentumSchema = z.object({
  minPct: z.number().positive(),
  windowMinutes: z.number().positive(),
  volumeSpikeMult: z.number().positive(),
  minLiquidityUsd: z.number().nonnegative(),
  minVolume24hUsd: z.number().nonnegative(),
  minAgeMinutes: z.number().nonnegative(),
});

const TrailSchema = z.object({
  activatePct: z.number().positive(),
  distancePct: z.number().positive(),
});

const ConfigSchema = z.object({
  paperMode: z.boolean(),
  bankrollUsd: z.number().positive(),
  maxOpenTrades: z.number().int().positive(),
  stopLossPct: z.number().positive(),
  takeProfitPct: z.number().nonnegative(),
  positionSizePct: z.number().gt(0).lte(1),
  momentum: MomentumSchema,
  trailingTakeProfit: TrailSchema,
  paperBroker: z.object({
    slippageBps: z.number().nonnegative(),
    feeBps: z.number().nonnegative(),
  }),
  runner: z.object({
    pollIntervalMs: z.number().int().positive(),
    scanLimit: z.number().int().positive(),
    maxCycles: z.number().int().nonnegative(),
  }),
  maxHoldMinutes: z.number().nonnegative(),
  dailyLossUsd: z.number().nonnegative(),
  marketDataSource: z.enum(["mock", "dexscreener", "pumpfun"]),
  ledgerDir: z.string().min(1),
});

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.toLowerCase());
}

function envNum(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid number for env ${key}: ${v}`);
  }
  return n;
}

function envStr<T extends string>(
  key: string,
  fallback: T,
  allowed?: readonly T[],
): T {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  if (allowed && !allowed.includes(v as T)) {
    throw new Error(
      `Invalid ${key}=${v}; allowed: ${allowed.join(", ")}`,
    );
  }
  return v as T;
}

/**
 * Load JSON defaults. Prefer `CONFIG_FILE` (e.g. config/pumpfun-preset.json),
 * else config/default.json.
 */
function loadFileDefaults(): Partial<BotConfig> {
  const override = process.env.CONFIG_FILE?.trim();
  const path = resolve(
    process.cwd(),
    override && override.length > 0 ? override : "config/default.json",
  );
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8")) as Partial<BotConfig>;
}

/** Merge config JSON + env overrides. Env wins. */
export function loadConfig(): BotConfig {
  const file = loadFileDefaults();

  const merged: BotConfig = {
    paperMode: envBool("PAPER_MODE", file.paperMode ?? true),
    bankrollUsd: envNum("BANKROLL_USD", file.bankrollUsd ?? 20),
    maxOpenTrades: envNum("MAX_OPEN_TRADES", file.maxOpenTrades ?? 1),
    stopLossPct: envNum("STOP_LOSS_PCT", file.stopLossPct ?? 10),
    takeProfitPct: envNum("TAKE_PROFIT_PCT", file.takeProfitPct ?? 25),
    positionSizePct: envNum("POSITION_SIZE_PCT", file.positionSizePct ?? 0.95),
    momentum: {
      minPct: envNum("MOMENTUM_MIN_PCT", file.momentum?.minPct ?? 8),
      windowMinutes: envNum(
        "MOMENTUM_WINDOW_MINUTES",
        file.momentum?.windowMinutes ?? 5,
      ),
      volumeSpikeMult: envNum(
        "VOLUME_SPIKE_MULT",
        file.momentum?.volumeSpikeMult ?? 2.0,
      ),
      minLiquidityUsd: envNum(
        "MIN_LIQUIDITY_USD",
        file.momentum?.minLiquidityUsd ?? 15_000,
      ),
      minVolume24hUsd: envNum(
        "MIN_VOLUME_24H_USD",
        file.momentum?.minVolume24hUsd ?? 25_000,
      ),
      minAgeMinutes: envNum(
        "MIN_AGE_MINUTES",
        file.momentum?.minAgeMinutes ?? 3,
      ),
    },
    trailingTakeProfit: {
      activatePct: envNum(
        "TRAIL_ACTIVATE_PCT",
        file.trailingTakeProfit?.activatePct ?? 15,
      ),
      distancePct: envNum(
        "TRAIL_DISTANCE_PCT",
        file.trailingTakeProfit?.distancePct ?? 5,
      ),
    },
    paperBroker: {
      slippageBps: envNum(
        "SLIPPAGE_BPS",
        file.paperBroker?.slippageBps ?? 50,
      ),
      feeBps: envNum("FEE_BPS", file.paperBroker?.feeBps ?? 30),
    },
    runner: {
      pollIntervalMs: envNum(
        "POLL_INTERVAL_MS",
        file.runner?.pollIntervalMs ?? 15_000,
      ),
      scanLimit: envNum("SCAN_LIMIT", file.runner?.scanLimit ?? 20),
      maxCycles: envNum("MAX_CYCLES", file.runner?.maxCycles ?? 0),
    },
    maxHoldMinutes: envNum(
      "MAX_HOLD_MINUTES",
      file.maxHoldMinutes ?? 20,
    ),
    dailyLossUsd: envNum("DAILY_LOSS_USD", file.dailyLossUsd ?? 5),
    marketDataSource: envStr(
      "MARKET_DATA_SOURCE",
      (file.marketDataSource as "mock" | "dexscreener" | "pumpfun") ?? "mock",
      ["mock", "dexscreener", "pumpfun"] as const,
    ),
    ledgerDir: envStr("LEDGER_DIR", file.ledgerDir ?? "data"),
  };

  return ConfigSchema.parse(merged);
}

export function assertPaperOrStubLive(cfg: BotConfig): void {
  if (cfg.paperMode) return;
  // Live path is intentionally stubbed — refuse to run without explicit future wiring.
  throw new Error(
    "LIVE mode is stubbed. Keep PAPER_MODE=true. See README § Live wiring (stub).",
  );
}
