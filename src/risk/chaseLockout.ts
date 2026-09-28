/**
 * Paper-mode chase lockout (preview for future live).
 *
 * When a session loses the FULL original deposit/bankroll (not peak equity),
 * trading locks for a cool-down (default 12h). State lives on the laptop/API
 * side in data/chase-lockout.json so phone/tablet restarts cannot bypass it.
 *
 * Reset does NOT clear an active lockout — timer-only unlock for paper preview.
 * No easy manual unlock endpoint (hard to misuse).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../logging.js";

/** Disk shape — keep stable for paper preview. */
export interface ChaseLockoutDisk {
  lockedAt: number;
  unlockAt: number;
  originalDepositUsd: number;
  reason: string;
  lockoutHours: number;
}

/** Public status for API / UI. */
export interface ChaseLockoutStatus {
  /** True while now < unlockAt. */
  active: boolean;
  lockedAt: number | null;
  unlockAt: number | null;
  originalDepositUsd: number | null;
  reason: string | null;
  lockoutHours: number | null;
  /** Milliseconds remaining (0 if unlocked). */
  remainingMs: number;
}

const DUST_USD = 0.01;

/**
 * True when session realized PnL has wiped the ORIGINAL deposit/bankroll.
 * Threshold is originalDepositUsd (e.g. $100), never growing equity/HWM.
 */
export function isFullDepositLoss(
  realizedPnlUsd: number,
  originalDepositUsd: number,
): boolean {
  if (!(originalDepositUsd > 0) || !Number.isFinite(originalDepositUsd)) {
    return false;
  }
  if (!Number.isFinite(realizedPnlUsd)) return false;
  return realizedPnlUsd <= -originalDepositUsd + 1e-9;
}

/**
 * Session effectively zeroed vs original deposit:
 * flat, tradable cash dust, and realized loss covers the deposit.
 * Vault is ignored (skimmed funds are not "chasing" capital).
 */
export function isSessionZeroed(opts: {
  cashUsd: number;
  openCount: number;
  realizedPnlUsd: number;
  originalDepositUsd: number;
}): boolean {
  if (!(opts.originalDepositUsd > 0)) return false;
  if (opts.openCount > 0) return false;
  if (opts.cashUsd > DUST_USD) return false;
  return isFullDepositLoss(opts.realizedPnlUsd, opts.originalDepositUsd);
}

export class ChaseLockoutStore {
  private readonly path: string;
  private readonly nowFn: () => number;
  private disk: ChaseLockoutDisk | null = null;

  constructor(
    ledgerDir: string,
    opts?: { now?: () => number; fileName?: string },
  ) {
    this.path = join(ledgerDir, opts?.fileName ?? "chase-lockout.json");
    this.nowFn = opts?.now ?? (() => Date.now());
    mkdirSync(dirname(this.path), { recursive: true });
    this.disk = this.load();
  }

  /** Absolute path of the persisted lock file (laptop/API side). */
  get filePath(): string {
    return this.path;
  }

  getStatus(nowMs = this.nowFn()): ChaseLockoutStatus {
    this.expireIfDue(nowMs);
    if (!this.disk) {
      return {
        active: false,
        lockedAt: null,
        unlockAt: null,
        originalDepositUsd: null,
        reason: null,
        lockoutHours: null,
        remainingMs: 0,
      };
    }
    const remainingMs = Math.max(0, this.disk.unlockAt - nowMs);
    const active = remainingMs > 0;
    if (!active) {
      // Expired — drop disk so status is clean.
      this.clearDisk();
      return {
        active: false,
        lockedAt: null,
        unlockAt: null,
        originalDepositUsd: null,
        reason: null,
        lockoutHours: null,
        remainingMs: 0,
      };
    }
    return {
      active: true,
      lockedAt: this.disk.lockedAt,
      unlockAt: this.disk.unlockAt,
      originalDepositUsd: this.disk.originalDepositUsd,
      reason: this.disk.reason,
      lockoutHours: this.disk.lockoutHours,
      remainingMs,
    };
  }

  isLocked(nowMs = this.nowFn()): boolean {
    return this.getStatus(nowMs).active;
  }

  /**
   * Engage (or refresh) a chase lockout. No-op when hours <= 0 (feature off).
   * If already locked with a later unlockAt, keeps the existing lock.
   */
  engage(opts: {
    originalDepositUsd: number;
    lockoutHours: number;
    reason: string;
    nowMs?: number;
  }): ChaseLockoutStatus {
    const hours = opts.lockoutHours;
    if (!(hours > 0) || !Number.isFinite(hours)) {
      return this.getStatus(opts.nowMs);
    }
    const now = opts.nowMs ?? this.nowFn();
    const existing = this.getStatus(now);
    if (existing.active && existing.unlockAt != null) {
      // Already locked — do not shorten; keep the stricter (later) unlock.
      return existing;
    }
    const unlockAt = now + hours * 3_600_000;
    this.disk = {
      lockedAt: now,
      unlockAt,
      originalDepositUsd: opts.originalDepositUsd,
      reason: opts.reason,
      lockoutHours: hours,
    };
    this.persist();
    log.warn("Chase lockout engaged (paper)", {
      unlockAt: new Date(unlockAt).toISOString(),
      originalDepositUsd: opts.originalDepositUsd,
      lockoutHours: hours,
      reason: opts.reason,
      path: this.path,
    });
    return this.getStatus(now);
  }

  /**
   * Evaluate ledger state and engage if full original deposit is gone.
   * Returns status after evaluation (may newly engage).
   */
  evaluateAndMaybeEngage(opts: {
    realizedPnlUsd: number;
    cashUsd: number;
    openCount: number;
    originalDepositUsd: number;
    lockoutHours: number;
    nowMs?: number;
  }): ChaseLockoutStatus {
    const now = opts.nowMs ?? this.nowFn();
    if (!(opts.lockoutHours > 0)) {
      return this.getStatus(now);
    }
    const fullLoss = isFullDepositLoss(
      opts.realizedPnlUsd,
      opts.originalDepositUsd,
    );
    const zeroed = isSessionZeroed({
      cashUsd: opts.cashUsd,
      openCount: opts.openCount,
      realizedPnlUsd: opts.realizedPnlUsd,
      originalDepositUsd: opts.originalDepositUsd,
    });
    if (!fullLoss && !zeroed) {
      return this.getStatus(now);
    }
    const reason = fullLoss
      ? `chase_lockout: full original deposit lost (realized $${opts.realizedPnlUsd.toFixed(2)} ≤ −$${opts.originalDepositUsd.toFixed(2)})`
      : `chase_lockout: session zeroed vs original deposit $${opts.originalDepositUsd.toFixed(2)}`;
    return this.engage({
      originalDepositUsd: opts.originalDepositUsd,
      lockoutHours: opts.lockoutHours,
      reason,
      nowMs: now,
    });
  }

  /**
   * Intentionally NOT exposed on the control API for paper preview.
   * Tests may call this to clean temp dirs; production unlock is timer-only.
   */
  forceClearForTests(): void {
    this.clearDisk();
  }

  private expireIfDue(nowMs: number): void {
    if (!this.disk) return;
    if (nowMs >= this.disk.unlockAt) {
      log.info("Chase lockout expired (timer)", {
        unlockAt: new Date(this.disk.unlockAt).toISOString(),
        path: this.path,
      });
      this.clearDisk();
    }
  }

  private clearDisk(): void {
    this.disk = null;
    try {
      if (existsSync(this.path)) {
        writeFileSync(this.path, "{}\n", "utf8");
      }
    } catch {
      // ignore
    }
  }

  private load(): ChaseLockoutDisk | null {
    if (!existsSync(this.path)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<ChaseLockoutDisk>;
      const lockedAt = Number(raw.lockedAt);
      const unlockAt = Number(raw.unlockAt);
      const originalDepositUsd = Number(raw.originalDepositUsd);
      const lockoutHours = Number(raw.lockoutHours);
      const reason = typeof raw.reason === "string" ? raw.reason : "chase_lockout";
      if (
        !Number.isFinite(lockedAt) ||
        !Number.isFinite(unlockAt) ||
        unlockAt <= lockedAt ||
        !Number.isFinite(originalDepositUsd) ||
        originalDepositUsd <= 0
      ) {
        return null;
      }
      return {
        lockedAt,
        unlockAt,
        originalDepositUsd,
        reason,
        lockoutHours: Number.isFinite(lockoutHours) && lockoutHours > 0 ? lockoutHours : 12,
      };
    } catch {
      return null;
    }
  }

  private persist(): void {
    if (!this.disk) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(
      this.path,
      `${JSON.stringify({ ...this.disk, updatedAt: this.nowFn() }, null, 2)}\n`,
      "utf8",
    );
  }
}
