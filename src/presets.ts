/**
 * Named paper-trading presets.
 * Numbers are documented in README § Named presets.
 */
import type { BotConfig } from "./types.js";

export type PresetName = "momentum" | "sniper";

export const PRESET_NAMES: readonly PresetName[] = ["momentum", "sniper"] as const;

/**
 * Fields a named preset overwrites (strategy knobs only).
 * Session risk — bankrollUsd / dailyLossUsd / maxPositionUsd — is NOT in a preset;
 * applyPresetKnobs preserves them from the current config
 * (Mark’s sticky $100 / $25 / $25 max position).
 */
export type PresetKnobs = Pick<
  BotConfig,
  | "stopLossPct"
  | "takeProfitPct"
  | "positionSizePct"
  | "momentum"
  | "trailingTakeProfit"
  | "maxHoldMinutes"
> & {
  runner: Pick<BotConfig["runner"], "pollIntervalMs">;
};

/** Optional documented defaults for display only — never applied by applyPresetKnobs. */
export const PRESET_DISPLAY_RISK = {
  bankrollUsd: 20,
  dailyLossUsd: 5,
  maxPositionUsd: 25,
} as const;

/**
 * Momentum — current Pump.fun research defaults (config/pumpfun-preset.json).
 * Slightly looser entry floors vs stock default.json; standard 10% stop / 25% TP.
 */
export const MOMENTUM_PRESET: PresetKnobs = {
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
  runner: {
    pollIntervalMs: 15_000,
  },
};

/**
 * Sniper — newer coins OK, lower age/liq floors, tighter stop, lower TP / faster trail.
 */
export const SNIPER_PRESET: PresetKnobs = {
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

/**
 * Deep-apply strategy knobs onto a mutable BotConfig (in place).
 * Preserves cfg.bankrollUsd, cfg.dailyLossUsd, and cfg.maxPositionUsd (session risk).
 */
export function applyPresetKnobs(cfg: BotConfig, preset: PresetName): void {
  const knobs = PRESETS[preset];
  // Sticky session risk — do not wipe Mark’s bankroll / daily loss / max position.
  const stickyBankroll = cfg.bankrollUsd;
  const stickyDailyLoss = cfg.dailyLossUsd;
  const stickyMaxPosition = cfg.maxPositionUsd;

  cfg.stopLossPct = knobs.stopLossPct;
  cfg.takeProfitPct = knobs.takeProfitPct;
  cfg.positionSizePct = knobs.positionSizePct;
  cfg.momentum = { ...knobs.momentum };
  cfg.trailingTakeProfit = { ...knobs.trailingTakeProfit };
  cfg.maxHoldMinutes = knobs.maxHoldMinutes;
  cfg.runner = {
    ...cfg.runner,
    pollIntervalMs: knobs.runner.pollIntervalMs,
  };
  cfg.bankrollUsd = stickyBankroll;
  cfg.dailyLossUsd = stickyDailyLoss;
  cfg.maxPositionUsd = stickyMaxPosition;
  cfg.activePreset = preset;
}
