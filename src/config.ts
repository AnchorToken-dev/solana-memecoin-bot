import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { config as loadDotenv } from "dotenv";
import { z } from "zod";
import type { ActivePreset, BotConfig } from "./types.js";
import { PRESETS, isPresetName, type PresetName } from "./presets.js";
import { solanaRpcIsConfigured } from "./solana/rpc.js";
import { solanaRpcWssIsConfigured } from "./solana/ws.js";

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
  };

  if (!opts?.skipRuntimeOverlay) {
    const overlayPath =
      opts?.runtimePath ?? runtimeConfigPath(merged.ledgerDir);
    applyOverlay(merged, loadRuntimeOverlay(overlayPath));
  }

  merged.activePreset = inferActivePreset(merged);
  return ConfigSchema.parse(merged);
}

export function assertPaperOrStubLive(cfg: BotConfig): void {
  if (cfg.paperMode) return;
  // Live path is intentionally stubbed — refuse to run without explicit future wiring.
  throw new Error(
    "LIVE mode is stubbed. Keep PAPER_MODE=true. See README § Live wiring (stub).",
  );
}

export { isPresetName };
