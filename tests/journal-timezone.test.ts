import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  getZonedParts,
  startOfDay,
  startOfMonth,
  startOfWeekMonday,
  zonedWallTimeToUtc,
} from "../src/journal/timezone.js";

const TZ = "America/New_York";

describe("journal timezone helpers (America/New_York)", () => {
  it("startOfDay is local midnight", () => {
    // 2026-09-23 15:00 ET = 19:00 UTC (EDT)
    const now = Date.parse("2026-09-23T19:00:00.000Z");
    const sod = startOfDay(now, TZ);
    const parts = getZonedParts(sod, TZ);
    assert.equal(parts.year, 2026);
    assert.equal(parts.month, 9);
    assert.equal(parts.day, 23);
    assert.equal(parts.hour, 0);
    assert.equal(parts.minute, 0);
  });

  it("startOfWeekMonday lands on Monday", () => {
    const wed = Date.parse("2026-09-23T19:00:00.000Z");
    const week = startOfWeekMonday(wed, TZ);
    const parts = getZonedParts(week, TZ);
    assert.equal(parts.weekday, "Mon");
    assert.equal(parts.day, 21);
    assert.equal(parts.hour, 0);
  });

  it("startOfMonth is day 1 local", () => {
    const wed = Date.parse("2026-09-23T19:00:00.000Z");
    const month = startOfMonth(wed, TZ);
    const parts = getZonedParts(month, TZ);
    assert.equal(parts.day, 1);
    assert.equal(parts.month, 9);
    assert.equal(parts.hour, 0);
  });

  it("handles EST (winter) wall time", () => {
    // 2026-01-15 12:00 ET = 17:00 UTC (EST, UTC-5)
    const utc = zonedWallTimeToUtc(2026, 1, 15, 12, 0, 0, TZ);
    assert.equal(utc, Date.parse("2026-01-15T17:00:00.000Z"));
  });
});
