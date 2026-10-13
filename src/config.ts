import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import type { ActivePreset, BotConfig } from "./types.js";
import { PRESETS, isPresetName, type PresetName } from "./presets.js";
import { solanaRpcIsConfigured } from "./solana/rpc.js";
import { solanaRpcWssIsConfigured } from "./solana/ws.js";
import { clampHardDailyLoss } from "./risk/hardDailyLoss.js";
import { resolveTradingMode, loadLiveSettings } from "./live/mode.js";
import { LIVE_WALLET_KEYPAIR_PATH_ENV } from "./live/keypair.js";
import { loadPaperFeeSettings } from "./broker/paperFees.js";
import {
  DEFAULT_RUG_FILTER_FAIL_COOLDOWN_MINUTES,
  DEFAULT_RUG_FILTER_GRAD_MAX_HOLDER_PCT,
  DEFAULT_RUG_FILTER_GRAD_MAX_TOP10_PCT,
  DEFAULT_RUG_FILTER_GRAD_MIN_POOL_PCT,
} from "./risk/rugFilter.js";

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
  maxPositionUsd: z.number().nonnegative(),
  momentum: MomentumSchema,
  trailingTakeProfit: TrailSchema,
  paperBroker: z.object({
    slippageBps: z.number().nonnegative(),
    feeBps: z.number().nonnegative(),
    skipUnbuyable: z.boolean().optional(),
    fees: z
      .object({
        model: z.enum(["realistic", "legacy"]),
        pumpCurveFeeBps: z.number().nonnegative(),
        pumpSwapFeeBps: z.number().nonnegative().nullable(),
        pumpPortalFeeBps: z.number().nonnegative(),
        baseFeeSol: z.number().nonnegative(),
        priorityFeeSol: z.number().nonnegative(),
        tokenAccountRentSol: z.number().nonnegative(),
        slippageModel: z.enum(["liquidity", "flat"]),
        slippageBaseBps: z.number().nonnegative(),
        slippageMaxBps: z.number().nonnegative(),
        defaultVenue: z.enum(["bonding_curve", "pumpswap"]),
        solUsdFallback: z.number().positive(),
      })
      .optional(),
  }),
  runner: z.object({
    pollIntervalMs: z.number().int().positive(),
    scanLimit: z.number().int().positive(),
    maxCycles: z.number().int().nonnegative(),
  }),
  maxHoldMinutes: z.number().nonnegative(),
  dailyLossUsd: z.number().nonnegative(),
  chaseLockoutHours: z.number().nonnegative(),
  marketDataSource: z.enum(["mock", "dexscreener", "pumpfun"]),
  ledgerDir: z.string().min(1),
  activePreset: z.enum(["momentum", "sniper", "custom"]),
  requireChecklistGo: z.boolean(),
  /** Derived from SOLANA_RPC_URL presence. Never the URL itself. */
  solanaRpcConfigured: z.boolean(),
  /** Derived from SOLANA_RPC_WSS_URL presence. Never the URL itself. */
  solanaRpcWssConfigured: z.boolean(),
  rugFilterEnabled: z.boolean(),
  rugFilterMaxTopHolderPct: z.number().gt(0).lte(100),
  rugFilterMaxSameSlotBuys: z.number().int().nonnegative(),
  rugFilterGradMinPoolPct: z.number().gte(0).lte(100).optional(),
  rugFilterGradMaxHolderPct: z.number().gt(0).lte(100).optional(),
  rugFilterGradMaxTop10Pct: z.number().gt(0).lte(100).optional(),
  rugFilterFailCooldownMinutes: z.number().gte(0).optional(),
  fastExitPollMs: z.number().gte(0).optional(),
  entryGuard: z
    .object({
      maxRunupPct: z.number().gte(0),
      minCoinAgeMinutes: z.number().gte(0),
      maxWindowVolumeSharePct: z.number().gte(0).lte(100),
      maxPullbackPct: z.number().gte(0).lte(100),
      pullbackWindowSec: z.number().gt(0),
      maxDownTicks: z.number().int().gte(0),
    })
    .optional(),
  earlyExit: z
    .object({
      fastDropPct: z.number().gte(0).lte(100),
      fastDropWindowMs: z.number().gt(0),
      redTicks: z.number().int().gte(0),
      redTicksMinDropPct: z.number().gte(0).lte(100),
      givebackArmPct: z.number().gte(0),
      givebackPct: z.number().gt(0).lte(100),
      stallSeconds: z.number().gte(0),
      reserveDropPct: z.number().gte(0).lte(100).optional(),
    })
    .optional(),
  entryPriceCheck: z
    .object({
      enabled: z.boolean(),
      maxGapPct: z.number().gt(0),
      mismatchSkipMinutes: z.number().gte(0),
      fillAtOnchain: z.boolean(),
    })
    .optional(),
  reentryCooldown: z
    .object({
      minutes: z.number().gte(0),
      afterLossMinutes: z.number().gte(0),
    })
    .optional(),
  trailBreakeven: z
    .object({ enabled: z.boolean(), exitFeePct: z.number().gte(0).lte(50), minProfitPct: z.number().gte(0).lte(50) })
    .optional(),
  memory: z
    .object({
      enabled: z.boolean(),
      minTrades: z.number().int().gte(1),
      neighbors: z.number().int().gte(1),
      skipAvgPnlPct: z.number(),
      maxTrades: z.number().int().gte(10),
    })
    .optional(),
  priceTape: z
    .object({
      enabled: z.boolean(),
      postExitSeconds: z.number().gte(0).lte(1_800),
      postExitIntervalMs: z.number().gte(1_000),
      preCandles: z.boolean(),
    })
    .optional(),
  shadowTape: z
    .object({
      enabled: z.boolean(),
      seconds: z.number().gte(0).lte(3_600),
      intervalMs: z.number().gte(1_000),
      maxConcurrent: z.number().int().gte(0).lte(20),
      dedupeMinutes: z.number().gte(0),
    })
    .optional(),
  costGate: z
    .object({
      enabled: z.boolean(),
      minTrades: z.number().int().gte(5),
      neighbors: z.number().int().gte(3),
      quantile: z.number().gte(0).lte(1),
      marginMult: z.number().gt(0),
    })
    .optional(),
  sizeCompareUsd: z.number().gte(0).lte(1_000).optional(),
  softRug: z
    .object({ mode: z.enum(["off", "shadow", "exit"]), threshold: z.number().gt(0).lte(1), minHoldSec: z.number().gte(0), modelPath: z.string().min(1) })
    .optional(),
  pullbackEntry: z.object({ pct: z.number().gte(0).lte(50), windowSec: z.number().gte(5).lte(600) }).optional(),
});

/** Paper-safe knobs allowed on PATCH /config. */
export const PaperPatchSchema = z
  .object({
    bankrollUsd: z.number().positive().optional(),
    stopLossPct: z.number().positive().optional(),
    takeProfitPct: z.number().nonnegative().optional(),
    positionSizePct: z.number().gt(0).lte(1).optional(),
    maxPositionUsd: z.number().nonnegative().optional(),
    maxHoldMinutes: z.number().nonnegative().optional(),
    dailyLossUsd: z.number().nonnegative().optional(),
    /** Paper chase lockout hours after full original-deposit loss (0 = off). Sticky. */
    chaseLockoutHours: z.number().nonnegative().optional(),
    momentum: MomentumSchema.partial().optional(),
    trailingTakeProfit: TrailSchema.partial().optional(),
    runner: z
      .object({
        pollIntervalMs: z.number().int().positive().optional(),
        scanLimit: z.number().int().positive().optional(),
      })
      .optional(),
    /** Optional; usually set via POST /config/preset. */
    activePreset: z.enum(["momentum", "sniper", "custom"]).optional(),
    /** Gate paper entries on a GO checklist for the mint (default off / advisory). */
    requireChecklistGo: z.boolean().optional(),
    /** Pre-buy rug filter. Default off. Not a strategy preset knob. */
    rugFilterEnabled: z.boolean().optional(),
    rugFilterMaxTopHolderPct: z.number().gt(0).lte(100).optional(),
    rugFilterMaxSameSlotBuys: z.number().int().nonnegative().optional(),
    /** Hard daily loss limit: may only LOWER below $300. Anything else clamps to 300. */
    hardDailyLossUsd: z.unknown().optional(),
  })
  .strict();

export type PaperConfigPatch = z.infer<typeof PaperPatchSchema>;

/** Fields that must never be changed via the control API. */
export const REJECTED_CONFIG_FIELDS = [
  "paperMode",
  "ledgerDir",
  "marketDataSource",
  "paperBroker",
  "maxOpenTrades",
  "maxCycles",
] as const;

const LIVE_DANGEROUS_KEYS = new Set([
  ...REJECTED_CONFIG_FIELDS,
  "liveRpcUrl",
  "liveWalletKeypairPath",
  "wallet",
  "keypair",
  "privateKey",
  "secret",
  "rpcUrl",
  "LIVE_RPC_URL",
  "LIVE_WALLET_KEYPAIR_PATH",
  "SOLANA_RPC_URL",
  "solanaRpcUrl",
  "SOLANA_RPC_WSS_URL",
  "solanaRpcWssUrl",
]);

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

/** Absolute path for the runtime overlay (survives restart). */
export function runtimeConfigPath(ledgerDir?: string): string {
  const dir =
    ledgerDir?.trim() ||
    process.env.LEDGER_DIR?.trim() ||
    process.env.RUNTIME_CONFIG_DIR?.trim() ||
    "data";
  const file =
    process.env.RUNTIME_CONFIG_FILE?.trim() || "runtime-config.json";
  return resolve(process.cwd(), dir, file);
}

export type RuntimeOverlay = PaperConfigPatch & {
  activePreset?: ActivePreset;
};

export function loadRuntimeOverlay(path?: string): RuntimeOverlay {
  const p = path ?? runtimeConfigPath();
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as unknown;
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }
    // Strip rejected keys if someone hand-edited the file.
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (LIVE_DANGEROUS_KEYS.has(k)) continue;
      cleaned[k] = v;
    }
    const parsed = PaperPatchSchema.safeParse(cleaned);
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function saveRuntimeOverlay(
  overlay: RuntimeOverlay,
  path?: string,
): string {
  const p = path ?? runtimeConfigPath();
  mkdirSync(dirname(p), { recursive: true });
  // Never persist live-dangerous fields.
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(overlay)) {
    if (LIVE_DANGEROUS_KEYS.has(k)) continue;
    if (v !== undefined) safe[k] = v;
  }
  writeFileSync(p, `${JSON.stringify(safe, null, 2)}\n`, "utf8");
  return p;
}

/** Build overlay snapshot from current in-memory config (for persistence). */
export function overlayFromConfig(cfg: BotConfig): RuntimeOverlay {
  return {
    bankrollUsd: cfg.bankrollUsd,
    stopLossPct: cfg.stopLossPct,
    takeProfitPct: cfg.takeProfitPct,
    positionSizePct: cfg.positionSizePct,
    maxPositionUsd: cfg.maxPositionUsd,
    maxHoldMinutes: cfg.maxHoldMinutes,
    dailyLossUsd: cfg.dailyLossUsd,
    ...(typeof cfg.hardDailyLossUsd === "number" ? { hardDailyLossUsd: cfg.hardDailyLossUsd } : {}),
    chaseLockoutHours: cfg.chaseLockoutHours,
    momentum: { ...cfg.momentum },
    trailingTakeProfit: { ...cfg.trailingTakeProfit },
    runner: {
      pollIntervalMs: cfg.runner.pollIntervalMs,
      scanLimit: cfg.runner.scanLimit,
    },
    activePreset: cfg.activePreset,
    requireChecklistGo: cfg.requireChecklistGo,
    ...(typeof cfg.rugFilterEnabled === "boolean"
      ? { rugFilterEnabled: cfg.rugFilterEnabled }
      : {}),
    ...(typeof cfg.rugFilterMaxTopHolderPct === "number"
      ? { rugFilterMaxTopHolderPct: cfg.rugFilterMaxTopHolderPct }
      : {}),
    ...(typeof cfg.rugFilterMaxSameSlotBuys === "number"
      ? { rugFilterMaxSameSlotBuys: cfg.rugFilterMaxSameSlotBuys }
      : {}),
  };
}

function applyOverlay(cfg: BotConfig, overlay: RuntimeOverlay): void {
  if (overlay.bankrollUsd != null) cfg.bankrollUsd = overlay.bankrollUsd;
  if (overlay.stopLossPct != null) cfg.stopLossPct = overlay.stopLossPct;
  if (overlay.takeProfitPct != null) cfg.takeProfitPct = overlay.takeProfitPct;
  if (overlay.positionSizePct != null) {
    cfg.positionSizePct = overlay.positionSizePct;
  }
  if (overlay.maxPositionUsd != null) {
    cfg.maxPositionUsd = overlay.maxPositionUsd;
  }
  if (overlay.maxHoldMinutes != null) {
    cfg.maxHoldMinutes = overlay.maxHoldMinutes;
  }
  if (overlay.dailyLossUsd != null) cfg.dailyLossUsd = overlay.dailyLossUsd;
  if ((overlay as { hardDailyLossUsd?: unknown }).hardDailyLossUsd !== undefined) {
    const c = clampHardDailyLoss((overlay as { hardDailyLossUsd?: unknown }).hardDailyLossUsd, "runtime-config hardDailyLossUsd");
    cfg.hardDailyLossUsd = c.usd;
    if (c.warning) cfg.hardDailyLossWarnings = [...(cfg.hardDailyLossWarnings ?? []), c.warning];
  }
  if (overlay.chaseLockoutHours != null) {
    cfg.chaseLockoutHours = overlay.chaseLockoutHours;
  }
  if (overlay.momentum) {
    cfg.momentum = { ...cfg.momentum, ...overlay.momentum };
  }
  if (overlay.trailingTakeProfit) {
    cfg.trailingTakeProfit = {
      ...cfg.trailingTakeProfit,
      ...overlay.trailingTakeProfit,
    };
  }
  if (overlay.runner) {
    if (overlay.runner.pollIntervalMs != null) {
      cfg.runner.pollIntervalMs = overlay.runner.pollIntervalMs;
    }
    if (overlay.runner.scanLimit != null) {
      cfg.runner.scanLimit = overlay.runner.scanLimit;
    }
  }
  if (overlay.activePreset) {
    cfg.activePreset = overlay.activePreset;
  }
  if (overlay.requireChecklistGo != null) {
    cfg.requireChecklistGo = overlay.requireChecklistGo;
  }
  if (overlay.rugFilterEnabled != null) {
    cfg.rugFilterEnabled = overlay.rugFilterEnabled;
  }
  if (overlay.rugFilterMaxTopHolderPct != null) {
    cfg.rugFilterMaxTopHolderPct = overlay.rugFilterMaxTopHolderPct;
  }
  if (overlay.rugFilterMaxSameSlotBuys != null) {
    cfg.rugFilterMaxSameSlotBuys = overlay.rugFilterMaxSameSlotBuys;
  }
}

function inferActivePreset(cfg: BotConfig): ActivePreset {
  if (cfg.activePreset === "momentum" || cfg.activePreset === "sniper") {
    const knobs = PRESETS[cfg.activePreset];
    if (matchesPreset(cfg, knobs)) return cfg.activePreset;
  }
  for (const name of ["momentum", "sniper"] as PresetName[]) {
    if (matchesPreset(cfg, PRESETS[name])) return name;
  }
  return "custom";
}

function matchesPreset(
  cfg: BotConfig,
  knobs: (typeof PRESETS)[PresetName],
): boolean {
  // Strategy knobs only — bankroll / daily loss / max position are session risk and sticky.
  return (
    cfg.stopLossPct === knobs.stopLossPct &&
    cfg.takeProfitPct === knobs.takeProfitPct &&
    cfg.positionSizePct === knobs.positionSizePct &&
    cfg.maxHoldMinutes === knobs.maxHoldMinutes &&
    cfg.runner.pollIntervalMs === knobs.runner.pollIntervalMs &&
    cfg.momentum.minPct === knobs.momentum.minPct &&
    cfg.momentum.windowMinutes === knobs.momentum.windowMinutes &&
    cfg.momentum.volumeSpikeMult === knobs.momentum.volumeSpikeMult &&
    cfg.momentum.minLiquidityUsd === knobs.momentum.minLiquidityUsd &&
    cfg.momentum.minVolume24hUsd === knobs.momentum.minVolume24hUsd &&
    cfg.momentum.minAgeMinutes === knobs.momentum.minAgeMinutes &&
    cfg.trailingTakeProfit.activatePct ===
      knobs.trailingTakeProfit.activatePct &&
    cfg.trailingTakeProfit.distancePct ===
      knobs.trailingTakeProfit.distancePct
  );
}

/**
 * Validate a PATCH body: reject live-dangerous / unknown keys, return typed patch.
 */
export function parsePaperConfigPatch(body: unknown): {
  ok: true;
  patch: PaperConfigPatch;
} | {
  ok: false;
  message: string;
  rejected?: string[];
} {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Body must be a JSON object" };
  }
  const obj = body as Record<string, unknown>;
  const rejected = Object.keys(obj).filter((k) => LIVE_DANGEROUS_KEYS.has(k));
  if (rejected.length > 0) {
    return {
      ok: false,
      message: `Rejecting live-dangerous or non-paper fields: ${rejected.join(", ")}`,
      rejected,
    };
  }
  const parsed = PaperPatchSchema.safeParse(obj);
  if (!parsed.success) {
    return {
      ok: false,
      message: parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    };
  }
  if (Object.keys(parsed.data).length === 0) {
    return { ok: false, message: "No paper-safe fields to update" };
  }
  return { ok: true, patch: parsed.data };
}

/** Apply a validated patch onto cfg (mutates). Marks activePreset custom unless set. */
export function applyPaperPatch(cfg: BotConfig, patch: PaperConfigPatch): void {
  if (patch.bankrollUsd != null) cfg.bankrollUsd = patch.bankrollUsd;
  if (patch.stopLossPct != null) cfg.stopLossPct = patch.stopLossPct;
  if (patch.takeProfitPct != null) cfg.takeProfitPct = patch.takeProfitPct;
  if (patch.positionSizePct != null) cfg.positionSizePct = patch.positionSizePct;
  if (patch.maxPositionUsd != null) cfg.maxPositionUsd = patch.maxPositionUsd;
  if (patch.maxHoldMinutes != null) cfg.maxHoldMinutes = patch.maxHoldMinutes;
  if (patch.dailyLossUsd != null) cfg.dailyLossUsd = patch.dailyLossUsd;
  if ("hardDailyLossUsd" in patch) {
    const c = clampHardDailyLoss(patch.hardDailyLossUsd ?? "unset", "PATCH hardDailyLossUsd");
    cfg.hardDailyLossUsd = c.usd;
    cfg.hardDailyLossWarnings = c.warning ? [c.warning] : [];
  }
  if (patch.chaseLockoutHours != null) {
    cfg.chaseLockoutHours = patch.chaseLockoutHours;
  }
  if (patch.momentum) {
    cfg.momentum = { ...cfg.momentum, ...patch.momentum };
  }
  if (patch.trailingTakeProfit) {
    cfg.trailingTakeProfit = {
      ...cfg.trailingTakeProfit,
      ...patch.trailingTakeProfit,
    };
  }
  if (patch.runner) {
    if (patch.runner.pollIntervalMs != null) {
      cfg.runner.pollIntervalMs = patch.runner.pollIntervalMs;
    }
    if (patch.runner.scanLimit != null) {
      cfg.runner.scanLimit = patch.runner.scanLimit;
    }
  }
  if (patch.requireChecklistGo != null) {
    cfg.requireChecklistGo = patch.requireChecklistGo;
  }
  if (patch.rugFilterEnabled != null) {
    cfg.rugFilterEnabled = patch.rugFilterEnabled;
  }
  if (patch.rugFilterMaxTopHolderPct != null) {
    cfg.rugFilterMaxTopHolderPct = patch.rugFilterMaxTopHolderPct;
  }
  if (patch.rugFilterMaxSameSlotBuys != null) {
    cfg.rugFilterMaxSameSlotBuys = patch.rugFilterMaxSameSlotBuys;
  }
  if (patch.activePreset) {
    cfg.activePreset = patch.activePreset;
  } else {
    // Don't mark custom for a lone requireChecklistGo toggle (advisory gate).
    const knobsChanged =
      patch.bankrollUsd != null ||
      patch.stopLossPct != null ||
      patch.takeProfitPct != null ||
      patch.positionSizePct != null ||
      patch.maxPositionUsd != null ||
      patch.maxHoldMinutes != null ||
      patch.dailyLossUsd != null ||
      patch.chaseLockoutHours != null ||
      patch.momentum != null ||
      patch.trailingTakeProfit != null ||
      patch.runner != null;
    if (knobsChanged) cfg.activePreset = "custom";
  }
}

/** Merge config JSON + env + runtime overlay. Overlay wins (in-app settings stick). */
export function loadConfig(opts?: {
  runtimePath?: string;
  skipRuntimeOverlay?: boolean;
}): BotConfig {
  const file = loadFileDefaults();

  const merged: BotConfig = {
    paperMode: envBool("PAPER_MODE", file.paperMode ?? true),
    bankrollUsd: envNum("BANKROLL_USD", file.bankrollUsd ?? 20),
    maxOpenTrades: envNum("MAX_OPEN_TRADES", file.maxOpenTrades ?? 1),
    stopLossPct: envNum("STOP_LOSS_PCT", file.stopLossPct ?? 10),
    takeProfitPct: envNum("TAKE_PROFIT_PCT", file.takeProfitPct ?? 25),
    positionSizePct: envNum("POSITION_SIZE_PCT", file.positionSizePct ?? 0.95),
    maxPositionUsd: envNum("MAX_POSITION_USD", file.maxPositionUsd ?? 25),
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
      // Itemised realistic costs (env only). PAPER_FEE_MODEL=legacy → old flat model.
      fees: loadPaperFeeSettings(process.env),
      // Skip coins live can't buy (non-SOL pairs, thin PumpSwap pools). Default on.
      skipUnbuyable: !["false", "0", "no", "off"].includes(
        (process.env.PAPER_SKIP_UNBUYABLE ?? "").trim().toLowerCase(),
      ),
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
    chaseLockoutHours: envNum(
      "CHASE_LOCKOUT_HOURS",
      file.chaseLockoutHours ?? 12,
    ),
    marketDataSource: envStr(
      "MARKET_DATA_SOURCE",
      (file.marketDataSource as "mock" | "dexscreener" | "pumpfun") ?? "mock",
      ["mock", "dexscreener", "pumpfun"] as const,
    ),
    ledgerDir: envStr("LEDGER_DIR", file.ledgerDir ?? "data"),
    activePreset:
      (file.activePreset as ActivePreset | undefined) ?? "custom",
    requireChecklistGo: envBool(
      "REQUIRE_CHECKLIST_GO",
      file.requireChecklistGo ?? false,
    ),
    // Presence only. The URL stays in the environment and is not copied onto cfg.
    solanaRpcConfigured: solanaRpcIsConfigured(),
    solanaRpcWssConfigured: solanaRpcWssIsConfigured(),
    rugFilterEnabled: envBool(
      "RUG_FILTER_ENABLED",
      file.rugFilterEnabled ?? false,
    ),
    rugFilterMaxTopHolderPct: envNum(
      "RUG_FILTER_MAX_TOP_HOLDER_PCT",
      file.rugFilterMaxTopHolderPct ?? 30,
    ),
    rugFilterMaxSameSlotBuys: envNum(
      "RUG_FILTER_MAX_SAME_SLOT_BUYS",
      file.rugFilterMaxSameSlotBuys ?? 3,
    ),
    rugFilterGradMinPoolPct: envNum(
      "RUG_FILTER_GRAD_MIN_POOL_PCT",
      file.rugFilterGradMinPoolPct ?? DEFAULT_RUG_FILTER_GRAD_MIN_POOL_PCT,
    ),
    rugFilterGradMaxHolderPct: envNum(
      "RUG_FILTER_GRAD_MAX_HOLDER_PCT",
      file.rugFilterGradMaxHolderPct ?? DEFAULT_RUG_FILTER_GRAD_MAX_HOLDER_PCT,
    ),
    rugFilterGradMaxTop10Pct: envNum(
      "RUG_FILTER_GRAD_MAX_TOP10_PCT",
      file.rugFilterGradMaxTop10Pct ?? DEFAULT_RUG_FILTER_GRAD_MAX_TOP10_PCT,
    ),
    rugFilterFailCooldownMinutes: envNum(
      "RUG_FILTER_FAIL_COOLDOWN_MINUTES",
      file.rugFilterFailCooldownMinutes ?? DEFAULT_RUG_FILTER_FAIL_COOLDOWN_MINUTES,
    ),
    fastExitPollMs: envNum("FAST_EXIT_POLL_MS", file.fastExitPollMs ?? 1_000),
    // Oct 9 review filters/exits: env only, every one 0/off unless set.
    entryGuard: {
      maxRunupPct: envNum("ENTRY_MAX_RUNUP_PCT", 0),
      minCoinAgeMinutes: envNum("ENTRY_MIN_COIN_AGE_MINUTES", 0),
      maxWindowVolumeSharePct: envNum("ENTRY_MAX_WINDOW_VOLUME_SHARE_PCT", 0),
      maxPullbackPct: envNum("ENTRY_MAX_PULLBACK_PCT", 0),
      pullbackWindowSec: envNum("ENTRY_PULLBACK_WINDOW_SEC", 120),
      maxDownTicks: envNum("ENTRY_MAX_DOWN_TICKS", 0),
    },
    earlyExit: {
      fastDropPct: envNum("EXIT_FAST_DROP_PCT", 0),
      fastDropWindowMs: envNum("EXIT_FAST_DROP_WINDOW_MS", 3_000),
      redTicks: envNum("EXIT_RED_TICKS", 0),
      redTicksMinDropPct: envNum("EXIT_RED_TICKS_MIN_DROP_PCT", 3),
      givebackArmPct: envNum("EXIT_GIVEBACK_ARM_PCT", 0),
      givebackPct: envNum("EXIT_GIVEBACK_PCT", 50),
      stallSeconds: envNum("EXIT_STALL_SECONDS", 0),
      reserveDropPct: envNum("EXIT_RESERVE_DROP_PCT", 5),
    },
    // Oct 11 Nike review: ON by default (safety, not strategy).
    entryPriceCheck: {
      enabled: envBool("ENTRY_PRICE_CHECK", true),
      maxGapPct: envNum("ENTRY_PRICE_MAX_GAP_PCT", 25),
      mismatchSkipMinutes: envNum("ENTRY_PRICE_MISMATCH_SKIP_MINUTES", 10),
      fillAtOnchain: envBool("PAPER_FILL_AT_ONCHAIN", true),
    },
    reentryCooldown: {
      minutes: envNum("REENTRY_COOLDOWN_MINUTES", 30),
      afterLossMinutes: envNum("REENTRY_COOLDOWN_AFTER_LOSS_MINUTES", 120),
    },
    // Oct 12 memory review.
    trailBreakeven: {
      enabled: envBool("TRAIL_BREAKEVEN_FLOOR", true),
      exitFeePct: envNum("TRAIL_EXIT_FEE_PCT", 2),
      minProfitPct: envNum("TRAIL_MIN_PROFIT_PCT", 1),
    },
    memory: {
      enabled: envBool("MEMORY_ENABLED", true),
      minTrades: envNum("MEMORY_MIN_TRADES", 40),
      neighbors: envNum("MEMORY_NEIGHBORS", 15),
      skipAvgPnlPct: envNum("MEMORY_SKIP_AVG_PNL_PCT", -8),
      maxTrades: envNum("MEMORY_MAX_TRADES", 2000),
    },
    priceTape: {
      enabled: envBool("PRICE_TAPE", true),
      postExitSeconds: envNum("PRICE_TAPE_POST_EXIT_SECONDS", 180),
      postExitIntervalMs: envNum("PRICE_TAPE_POST_EXIT_INTERVAL_MS", 5_000),
      preCandles: envBool("PRICE_TAPE_PRE_CANDLES", true),
    },
    shadowTape: {
      enabled: envBool("SHADOW_TAPE", true),
      seconds: envNum("SHADOW_TAPE_SECONDS", 300),
      intervalMs: envNum("SHADOW_TAPE_INTERVAL_MS", 5_000),
      maxConcurrent: envNum("SHADOW_TAPE_MAX_CONCURRENT", 4),
      dedupeMinutes: envNum("SHADOW_TAPE_DEDUPE_MINUTES", 30),
    },
    costGate: {
      enabled: envBool("COST_GATE", false),
      minTrades: envNum("COST_GATE_MIN_TRADES", 40),
      neighbors: envNum("COST_GATE_NEIGHBORS", 15),
      quantile: envNum("COST_GATE_QUANTILE", 0.5),
      marginMult: envNum("COST_GATE_MARGIN", 1),
    },
    sizeCompareUsd: envNum("SIZE_COMPARE_USD", 30),
    // Not ENTRY_PULLBACK_WINDOW_SEC (that is the max-pullback entry filter above).
    // Shadow only: scores open positions and logs; never sells or blocks.
    softRug: {
      mode: envBool("SOFT_RUG_SHADOW", false) ? "shadow" : "off",
      threshold: envNum("SOFT_RUG_THRESHOLD", 0.6),
      minHoldSec: envNum("SOFT_RUG_MIN_HOLD_S", 3),
      modelPath: process.env.SOFT_RUG_MODEL?.trim() || "models/softrug-model.json",
    },
    pullbackEntry: { pct: envNum("ENTRY_PULLBACK_PCT", 0), windowSec: envNum("ENTRY_PULLBACK_WINDOW_S", 60) },
  };

  if (!opts?.skipRuntimeOverlay) {
    const overlayPath =
      opts?.runtimePath ?? runtimeConfigPath(merged.ledgerDir);
    applyOverlay(merged, loadRuntimeOverlay(overlayPath));
  }

  if (
    merged.paperBroker.fees?.model === "realistic" &&
    process.env.FEE_BPS !== undefined &&
    process.env.FEE_BPS !== ""
  ) {
    console.warn(
      "[paper-fees] FEE_BPS is ignored by the realistic paper cost model (PAPER_FEE_MODEL=legacy restores it). See .env.example → Paper trading costs.",
    );
  }

  merged.activePreset = inferActivePreset(merged);
  const parsed = ConfigSchema.parse(merged) as BotConfig;
  // Hard daily loss: env/file may only lower it. Overlay (applied above) wins if present.
  const fileOrEnv = clampHardDailyLoss(
    process.env.HARD_DAILY_LOSS_USD ?? (file as { hardDailyLossUsd?: unknown }).hardDailyLossUsd,
    process.env.HARD_DAILY_LOSS_USD !== undefined ? "HARD_DAILY_LOSS_USD" : "config hardDailyLossUsd",
  );
  const overlayVal = (merged as BotConfig).hardDailyLossUsd;
  parsed.hardDailyLossUsd =
    typeof overlayVal === "number" ? Math.min(overlayVal, fileOrEnv.usd) : fileOrEnv.usd;
  parsed.hardDailyLossWarnings = [
    ...(fileOrEnv.warning ? [fileOrEnv.warning] : []),
    ...((merged as BotConfig).hardDailyLossWarnings ?? []),
  ];
  for (const w of parsed.hardDailyLossWarnings) console.warn(`[hard-daily-loss] ${w}`);
  return applyTradingModeGates(parsed);
}

/**
 * Apply the live gates to a loaded config. Every gate must pass or we stay
 * PAPER (paperMode forced true). Exported for tests.
 */
export function applyTradingModeGates(
  cfg: BotConfig,
  env: Record<string, string | undefined> = process.env,
): BotConfig {
  const decision = resolveTradingMode(env);
  cfg.tradingMode = decision.mode;
  if (decision.mode === "paper") {
    if (!cfg.paperMode) {
      // PAPER_MODE=false alone is NOT enough — fall back to paper loudly.
      console.warn(
        `[live-gate] Staying in PAPER mode: ${decision.paperReasons.join("; ")}`,
      );
    }
    cfg.paperMode = true;
    delete cfg.live;
    return cfg;
  }
  cfg.paperMode = false;
  cfg.live = loadLiveSettings(env);
  // Rug filter is mandatory in any live mode.
  cfg.rugFilterEnabled = true;
  return cfg;
}

/** Throws (refuses to start) when live is selected but prerequisites are missing. */
export function assertPaperOrStubLive(
  cfg: BotConfig,
  env: Record<string, string | undefined> = process.env,
): void {
  if (cfg.paperMode || !cfg.tradingMode || cfg.tradingMode === "paper") return;
  const missing: string[] = [];
  if (!env[LIVE_WALLET_KEYPAIR_PATH_ENV]?.trim()) missing.push(LIVE_WALLET_KEYPAIR_PATH_ENV);
  if (!env.SOLANA_RPC_URL?.trim()) missing.push("SOLANA_RPC_URL");
  if (missing.length > 0) {
    throw new Error(
      `Refusing to start LIVE: missing ${missing.join(", ")}. Unset LIVE_TRADING_ENABLED to run paper.`,
    );
  }
}

export { isPresetName };
