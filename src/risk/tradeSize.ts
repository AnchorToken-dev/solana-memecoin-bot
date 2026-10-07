/**
 * Trade-size hot buttons ($15 / $30 / $60). Applies to NEW buys only.
 * Persisted to <ledgerDir>/trade-size.json so restarts keep it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const TRADE_SIZES_USD = [15, 30, 60] as const;
export type TradeSizeUsd = (typeof TRADE_SIZES_USD)[number];
export const DEFAULT_TRADE_SIZE_USD: TradeSizeUsd = 15;

export function isTradeSize(v: unknown): v is TradeSizeUsd {
  return typeof v === "number" && (TRADE_SIZES_USD as readonly number[]).includes(v);
}

export interface TradeSizeOption {
  usd: TradeSizeUsd;
  enabled: boolean;
  /** Why the button is disabled (null when enabled). */
  reason: string | null;
}

export interface TradeSizeStatus {
  /** Button the user picked. */
  selectedUsd: TradeSizeUsd;
  /** What new buys will actually use (selected, clamped by the active cap). */
  effectiveUsd: number;
  /** Active cap name + value. null = no cap. */
  capUsd: number | null;
  capSource: "LIVE_MAX_POSITION_USD" | "MAX_POSITION_USD" | null;
  options: TradeSizeOption[];
  /** Set when the saved size is above a (lowered) cap. */
  warning: string | null;
}

export function tradeSizeStatus(selectedUsd: TradeSizeUsd, cap: { usd: number | null; source: TradeSizeStatus["capSource"] }): TradeSizeStatus {
  const capUsd = cap.usd != null && cap.usd > 0 ? cap.usd : null;
  const options = TRADE_SIZES_USD.map((usd) => {
    const over = capUsd != null && usd > capUsd;
    return {
      usd,
      enabled: !over,
      reason: over ? `Above ${cap.source} ($${capUsd})` : null,
    };
  });
  const effectiveUsd = capUsd != null ? Math.min(selectedUsd, capUsd) : selectedUsd;
  return {
    selectedUsd,
    effectiveUsd,
    capUsd,
    capSource: capUsd != null ? cap.source : null,
    options,
    warning:
      effectiveUsd < selectedUsd
        ? `Saved size $${selectedUsd} is above ${cap.source} ($${capUsd}); new buys use $${effectiveUsd}`
        : null,
  };
}

export class TradeSizeStore {
  readonly path: string;
  private selected: TradeSizeUsd = DEFAULT_TRADE_SIZE_USD;

  constructor(dataDir: string) {
    this.path = join(dataDir, "trade-size.json");
    if (existsSync(this.path)) {
      try {
        const raw = JSON.parse(readFileSync(this.path, "utf8")) as { usd?: unknown };
        if (isTradeSize(raw.usd)) this.selected = raw.usd;
      } catch {
        /* keep default */
      }
    }
  }

  get(): TradeSizeUsd {
    return this.selected;
  }

  set(usd: TradeSizeUsd): void {
    this.selected = usd;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, `${JSON.stringify({ usd, updatedAt: Date.now() }, null, 2)}\n`, "utf8");
  }
}
