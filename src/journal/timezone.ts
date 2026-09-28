/**
 * Calendar-period helpers in a named IANA timezone (default America/New_York).
 * No external deps — uses Intl + iterative UTC correction.
 */

export const JOURNAL_TZ_DEFAULT = "America/New_York";

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string; // short en-US: Sun Mon ...
}

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function getZonedParts(ms: number, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const map: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(ms))) {
    if (p.type !== "literal") map[p.type] = p.value;
  }
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: map.weekday ?? "Sun",
  };
}

/**
 * UTC epoch ms for y-m-d h:mi:s as wall time in `timeZone`.
 */
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number {
  // Initial guess: treat components as UTC, then correct toward the zone.
  let utc = Date.UTC(year, month - 1, day, hour, minute, second);
  for (let i = 0; i < 4; i++) {
    const p = getZonedParts(utc, timeZone);
    const asIfUtc = Date.UTC(
      p.year,
      p.month - 1,
      p.day,
      p.hour,
      p.minute,
      p.second,
    );
    const desired = Date.UTC(year, month - 1, day, hour, minute, second);
    const delta = desired - asIfUtc;
    if (delta === 0) break;
    utc += delta;
  }
  return utc;
}

/** Local midnight (00:00:00) for the calendar day containing `ms` in `timeZone`. */
export function startOfDay(ms: number, timeZone: string): number {
  const p = getZonedParts(ms, timeZone);
  return zonedWallTimeToUtc(p.year, p.month, p.day, 0, 0, 0, timeZone);
}

/**
 * Start of the calendar week containing `ms` (Monday 00:00 local).
 * Trading-week style; documented on the journal summary API.
 */
export function startOfWeekMonday(ms: number, timeZone: string): number {
  const dayStart = startOfDay(ms, timeZone);
  const p = getZonedParts(dayStart, timeZone);
  const dow = WEEKDAY_TO_INDEX[p.weekday] ?? 0; // 0=Sun … 6=Sat
  const daysFromMonday = dow === 0 ? 6 : dow - 1;
  // Step back in local calendar days (handle DST by re-deriving midnight).
  const approx = dayStart - daysFromMonday * 24 * 60 * 60 * 1000;
  return startOfDay(approx, timeZone);
}

/** Start of calendar month (day 1 00:00 local) containing `ms`. */
export function startOfMonth(ms: number, timeZone: string): number {
  const p = getZonedParts(ms, timeZone);
  return zonedWallTimeToUtc(p.year, p.month, 1, 0, 0, 0, timeZone);
}
