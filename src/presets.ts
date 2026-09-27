/**
 * Named paper-trading presets.
 * Numbers are documented in README § Named presets.
 */
import type { BotConfig } from "./types.js";

export type PresetName = "momentum" | "sniper";

export const PRESET_NAMES: readonly PresetName[] = ["momentum", "sniper"] as const;

/** Fields a preset overwrites (paper knobs only — never paperMode / market / ledger). */
export type PresetKnobs = Pick<
  BotConfig,
  | "bankrollUsd"
  | "stopLossPct"
  | "takeProfitPct"
  | "positionSizePct"
  | "momentum"
  | "trailingTakeProfit"
  | "maxHoldMinutes"
  | "dailyLossUsd"
> & {
  runner: Pick<BotConfig["runner"], "pollIntervalMs">;
};

/**
 * Momentum — current Pump.fun research defaults (config/pumpfun-preset.json).
 * Slightly looser entry floors vs stock default.json; standard 10% stop / 25% TP.
 */
export const MOMENTUM_PRESET: PresetKnobs = {
  bankrollUsd: 20,
  stopLossPct: 10,
  takeProfitPct: 25,
  positionSizePct: 0.95,
  momentum: {
    minPct: 5,
    windowMinutes: 5,
    volumeSpikeMult: 2.0,
    minLiquidityUsd: 5_000,
    minVolume24hUsd: 8_000,
    minAgeMinutes: 3,
  },
  trailingTakeProfit: {
    activatePct: 10,
    distancePct: 7,
  },
  maxHoldMinutes: 20,
  dailyLossUsd: 5,
  runner: {
    pollIntervalMs: 15_000,
  },
};

/**
 * Sniper — newer coins OK, lower age/liq floors, tighter stop, lower TP / faster trail.
 */
export const SNIPER_PRESET: PresetKnobs = {
  bankrollUsd: 20,
  stopLossPct: 8,
  takeProfitPct: 15,
  positionSizePct: 0.95,
  momentum: {
    minPct: 4,
    windowMinutes: 5,
    volumeSpikeMult: 1.5,
    minLiquidityUsd: 2_000,
    minVolume24hUsd: 3_000,
    minAgeMinutes: 0,
  },
  trailingTakeProfit: {
    activatePct: 8,
    distancePct: 4,
  },
  maxHoldMinutes: 10,
  dailyLossUsd: 5,
  runner: {
    pollIntervalMs: 10_000,
  },
};

export const PRESETS: Record<PresetName, PresetKnobs> = {
  momentum: MOMENTUM_PRESET,
  sniper: SNIPER_PRESET,
};

export function isPresetName(v: unknown): v is PresetName {
  return v === "momentum" || v === "sniper";
}

/** Deep-apply preset knobs onto a mutable BotConfig (in place). */
export function applyPresetKnobs(cfg: BotConfig, preset: PresetName): void {
  const knobs = PRESETS[preset];
  cfg.bankrollUsd = knobs.bankrollUsd;
  cfg.stopLossPct = knobs.stopLossPct;
  cfg.takeProfitPct = knobs.takeProfitPct;
  cfg.positionSizePct = knobs.positionSizePct;
  cfg.momentum = { ...knobs.momentum };
  cfg.trailingTakeProfit = { ...knobs.trailingTakeProfit };
  cfg.maxHoldMinutes = knobs.maxHoldMinutes;
  cfg.dailyLossUsd = knobs.dailyLossUsd;
  cfg.runner = {
    ...cfg.runner,
    pollIntervalMs: knobs.runner.pollIntervalMs,
  };
  cfg.activePreset = preset;
}
