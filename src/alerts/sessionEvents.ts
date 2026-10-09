/**
 * In-memory ring of paper session events for phone alerts.
 * Survives within one API process; clients poll GET /alerts?since=
 */
export type SessionEventType =
  | "bot_started"
  | "bot_stopped"
  | "position_opened"
  | "position_closed"
  | "daily_loss_cap"
  | "chase_lockout"
  | "exit_take_profit"
  | "exit_stop_loss"
  | "exit_trail"
  | "exit_manual"
  | "exit_time"
  | "exit_other"
  | "live_sell_failed"
  | "live_buy_unconfirmed"
  | "vault_sweep"
  | "vault_sweep_failed"
  | "buying_paused"
  | "buying_resumed"
  | "positions_restored"
  | "positions_restore_failed"
  | "position_adopted"
  | "position_missing"
  | "position_adjusted"
  | "orphan_not_adopted"
  | "reconcile_failed";

export interface SessionEvent {
  id: string;
  type: SessionEventType;
  title: string;
  body: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

const MAX = 100;

export class SessionEventBus {
  private events: SessionEvent[] = [];
  private seq = 0;

  push(
    type: SessionEventType,
    title: string,
    body: string,
    meta?: Record<string, unknown>,
  ): SessionEvent {
    this.seq += 1;
    const lastTs =
      this.events.length > 0
        ? this.events[this.events.length - 1]!.timestamp
        : 0;
    const now = Date.now();
    // Monotonic so rapid events are not collapsed by since= filters.
    const timestamp = Math.max(now, lastTs + 1);
    const ev: SessionEvent = {
      id: `evt-${this.seq}-${timestamp}`,
      type,
      title,
      body,
      timestamp,
      meta,
    };
    this.events.push(ev);
    if (this.events.length > MAX) {
      this.events = this.events.slice(-MAX);
    }
    return ev;
  }

  /** Events with timestamp > since (exclusive), oldest first. */
  since(sinceMs: number, limit = 50): SessionEvent[] {
    const lim = Math.min(Math.max(1, Math.floor(limit)), 100);
    return this.events.filter((e) => e.timestamp > sinceMs).slice(-lim);
  }

  clear(): void {
    this.events = [];
  }
}

export function exitEventType(
  reason: string | undefined,
): SessionEventType {
  switch (reason) {
    case "take_profit":
      return "exit_take_profit";
    case "stop_loss":
      return "exit_stop_loss";
    case "trailing_take_profit":
      return "exit_trail";
    case "manual_exit":
      return "exit_manual";
    case "time_stop":
      return "exit_time";
    default:
      return "exit_other";
  }
}

export function exitTitle(reason: string | undefined): string {
  switch (reason) {
    case "take_profit":
      return "Take-profit hit";
    case "stop_loss":
      return "Stop-loss hit";
    case "trailing_take_profit":
      return "Trail exit";
    case "manual_exit":
      return "Manual exit";
    case "time_stop":
      return "Time stop";
    default:
      return "Position closed";
  }
}
