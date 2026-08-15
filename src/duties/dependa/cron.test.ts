/**
 * Tests for cron schedule matching in the dependa duty.
 *
 * Covers: field matching (exact, range, step, comma list), named months/days,
 * DOM/DOW interaction semantics, and malformed expression handling.
 */
import { describe, expect, it } from "vitest";

import { cronFieldMatches, cronMatches } from "./main.js";

// ── cronFieldMatches ────────────────────────────────────────────────────────

describe("cronFieldMatches", () => {
  it("matches wildcard *", () => {
    expect(cronFieldMatches("*", 0, 59)).toBe(true);
    expect(cronFieldMatches("*", 30, 59)).toBe(true);
    expect(cronFieldMatches("*", 59, 59)).toBe(true);
  });

  it("matches exact value", () => {
    expect(cronFieldMatches("15", 15, 59)).toBe(true);
    expect(cronFieldMatches("15", 14, 59)).toBe(false);
    expect(cronFieldMatches("0", 0, 59)).toBe(true);
  });

  it("matches ranges", () => {
    expect(cronFieldMatches("1-5", 3, 59)).toBe(true);
    expect(cronFieldMatches("1-5", 1, 59)).toBe(true);
    expect(cronFieldMatches("1-5", 5, 59)).toBe(true);
    expect(cronFieldMatches("1-5", 0, 59)).toBe(false);
    expect(cronFieldMatches("1-5", 6, 59)).toBe(false);
  });

  it("matches step expressions with wildcard base", () => {
    // */2 matches even numbers from 0
    expect(cronFieldMatches("*/2", 0, 59)).toBe(true);
    expect(cronFieldMatches("*/2", 2, 59)).toBe(true);
    expect(cronFieldMatches("*/2", 1, 59)).toBe(false);
    expect(cronFieldMatches("*/2", 3, 59)).toBe(false);
  });

  it("matches step expressions with range base", () => {
    // 1-10/3 matches 1, 4, 7, 10
    expect(cronFieldMatches("1-10/3", 1, 59)).toBe(true);
    expect(cronFieldMatches("1-10/3", 4, 59)).toBe(true);
    expect(cronFieldMatches("1-10/3", 7, 59)).toBe(true);
    expect(cronFieldMatches("1-10/3", 10, 59)).toBe(true);
    expect(cronFieldMatches("1-10/3", 2, 59)).toBe(false);
    expect(cronFieldMatches("1-10/3", 5, 59)).toBe(false);
    expect(cronFieldMatches("1-10/3", 11, 59)).toBe(false);
  });

  it("matches step expressions with single start base", () => {
    // 5/10 matches 5, 15, 25, ... up to max
    expect(cronFieldMatches("5/10", 5, 59)).toBe(true);
    expect(cronFieldMatches("5/10", 15, 59)).toBe(true);
    expect(cronFieldMatches("5/10", 25, 59)).toBe(true);
    expect(cronFieldMatches("5/10", 6, 59)).toBe(false);
    expect(cronFieldMatches("5/10", 10, 59)).toBe(false);
  });

  it("rejects invalid step values", () => {
    expect(cronFieldMatches("*/0", 0, 59)).toBe(false);
    expect(cronFieldMatches("*/-1", 0, 59)).toBe(false);
    expect(cronFieldMatches("*/abc", 0, 59)).toBe(false);
  });

  it("matches comma-separated lists", () => {
    expect(cronFieldMatches("1,3,5", 1, 59)).toBe(true);
    expect(cronFieldMatches("1,3,5", 3, 59)).toBe(true);
    expect(cronFieldMatches("1,3,5", 5, 59)).toBe(true);
    expect(cronFieldMatches("1,3,5", 2, 59)).toBe(false);
    expect(cronFieldMatches("1,3,5", 4, 59)).toBe(false);
  });

  it("handles whitespace in comma lists", () => {
    expect(cronFieldMatches("1, 3, 5", 3, 59)).toBe(true);
  });

  it("supports named month aliases (case-insensitive)", () => {
    const MONTHS: Record<string, number> = {
      jan: 1,
      feb: 2,
      mar: 3,
      apr: 4,
      may: 5,
      jun: 6,
      jul: 7,
      aug: 8,
      sep: 9,
      oct: 10,
      nov: 11,
      dec: 12,
    };

    expect(cronFieldMatches("JAN", 1, 12, MONTHS)).toBe(true);
    expect(cronFieldMatches("jan", 1, 12, MONTHS)).toBe(true);
    expect(cronFieldMatches("Jan", 1, 12, MONTHS)).toBe(true);
    expect(cronFieldMatches("DEC", 12, 12, MONTHS)).toBe(true);
    expect(cronFieldMatches("MAR", 3, 12, MONTHS)).toBe(true);
    expect(cronFieldMatches("MAR", 4, 12, MONTHS)).toBe(false);
  });

  it("supports named day-of-week aliases", () => {
    const DOW: Record<string, number> = {
      sun: 0,
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
    };

    expect(cronFieldMatches("MON", 1, 6, DOW)).toBe(true);
    expect(cronFieldMatches("mon", 1, 6, DOW)).toBe(true);
    expect(cronFieldMatches("FRI", 5, 6, DOW)).toBe(true);
    expect(cronFieldMatches("SUN", 0, 6, DOW)).toBe(true);
    expect(cronFieldMatches("SAT", 6, 6, DOW)).toBe(true);
    expect(cronFieldMatches("WED", 2, 6, DOW)).toBe(false);
  });

  it("supports named days in ranges", () => {
    const DOW: Record<string, number> = {
      sun: 0,
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
    };

    // MON-FRI should match 1 through 5
    expect(cronFieldMatches("MON-FRI", 1, 6, DOW)).toBe(true);
    expect(cronFieldMatches("MON-FRI", 3, 6, DOW)).toBe(true);
    expect(cronFieldMatches("MON-FRI", 5, 6, DOW)).toBe(true);
    expect(cronFieldMatches("MON-FRI", 0, 6, DOW)).toBe(false);
    expect(cronFieldMatches("MON-FRI", 6, 6, DOW)).toBe(false);
  });

  it("supports named days in comma lists", () => {
    const DOW: Record<string, number> = {
      sun: 0,
      mon: 1,
      tue: 2,
      wed: 3,
      thu: 4,
      fri: 5,
      sat: 6,
    };

    expect(cronFieldMatches("MON,WED,FRI", 1, 6, DOW)).toBe(true);
    expect(cronFieldMatches("MON,WED,FRI", 3, 6, DOW)).toBe(true);
    expect(cronFieldMatches("MON,WED,FRI", 5, 6, DOW)).toBe(true);
    expect(cronFieldMatches("MON,WED,FRI", 2, 6, DOW)).toBe(false);
  });

  it("returns false for non-matching bare values", () => {
    expect(cronFieldMatches("42", 43, 59)).toBe(false);
    expect(cronFieldMatches("abc", 0, 59)).toBe(false);
  });
});

// ── cronMatches — full expression ───────────────────────────────────────────

describe("cronMatches", () => {
  // Helper to create a date at a specific time (local timezone)
  function makeDate(year: number, month: number, day: number, hour: number, minute: number): Date {
    return new Date(year, month - 1, day, hour, minute);
  }

  it("matches when all fields are wildcards", () => {
    const date = makeDate(2026, 8, 15, 10, 30);
    expect(cronMatches("* * * * *", date)).toBe(true);
  });

  it("matches exact minute and hour", () => {
    const date = makeDate(2026, 8, 15, 10, 30);
    expect(cronMatches("30 10 * * *", date)).toBe(true);
    expect(cronMatches("31 10 * * *", date)).toBe(false);
    expect(cronMatches("30 11 * * *", date)).toBe(false);
  });

  it("matches month field", () => {
    const date = makeDate(2026, 8, 15, 10, 30);
    expect(cronMatches("30 10 * 8 *", date)).toBe(true);
    expect(cronMatches("30 10 * 9 *", date)).toBe(false);
  });

  it("matches named months", () => {
    const date = makeDate(2026, 8, 15, 10, 30);
    expect(cronMatches("30 10 * AUG *", date)).toBe(true);
    expect(cronMatches("30 10 * aug *", date)).toBe(true);
    expect(cronMatches("30 10 * SEP *", date)).toBe(false);
  });

  // ── DOM/DOW interaction (the key bug fix) ────────────────────────────────

  it("respects DOW when DOM is wildcard (was previously ignored)", () => {
    // 2026-08-15 is a Saturday (day 6)
    const saturday = makeDate(2026, 8, 15, 10, 30);
    // 2026-08-17 is a Monday (day 1)
    const monday = makeDate(2026, 8, 17, 10, 30);

    // "every Monday" — DOM is *, DOW is restricted
    expect(cronMatches("30 10 * * 1", saturday)).toBe(false);
    expect(cronMatches("30 10 * * 1", monday)).toBe(true);
  });

  it("respects DOM when DOW is wildcard (was previously ignored)", () => {
    // 2026-08-15 is the 15th
    const fifteenth = makeDate(2026, 8, 15, 10, 30);
    // 2026-08-16 is the 16th
    const sixteenth = makeDate(2026, 8, 16, 10, 30);

    // "on the 15th of every month" — DOM restricted, DOW is *
    expect(cronMatches("30 10 15 * *", fifteenth)).toBe(true);
    expect(cronMatches("30 10 15 * *", sixteenth)).toBe(false);
  });

  it("uses OR when both DOM and DOW are restricted", () => {
    // 2026-08-15 is Saturday (day 6), 15th of month
    const saturday15th = makeDate(2026, 8, 15, 10, 30);
    // 2026-08-17 is Monday (day 1), 17th of month
    const monday17th = makeDate(2026, 8, 17, 10, 30);
    // 2026-08-18 is Tuesday (day 2), 18th of month
    const tuesday18th = makeDate(2026, 8, 18, 10, 30);

    // "on the 15th OR on Mondays"
    expect(cronMatches("30 10 15 * 1", saturday15th)).toBe(true); // matches DOM=15
    expect(cronMatches("30 10 15 * 1", monday17th)).toBe(true); // matches DOW=1
    expect(cronMatches("30 10 15 * 1", tuesday18th)).toBe(false); // neither
  });

  it("always matches day when both DOM and DOW are wildcard", () => {
    const anyDate = makeDate(2026, 8, 15, 10, 30);
    expect(cronMatches("30 10 * * *", anyDate)).toBe(true);
  });

  it("matches named DOW in expressions", () => {
    // 2026-08-17 is a Monday
    const monday = makeDate(2026, 8, 17, 10, 30);
    // 2026-08-15 is a Saturday
    const saturday = makeDate(2026, 8, 15, 10, 30);

    expect(cronMatches("30 10 * * MON", monday)).toBe(true);
    expect(cronMatches("30 10 * * MON", saturday)).toBe(false);
  });

  it("matches named DOW ranges", () => {
    // 2026-08-17 is Monday, 2026-08-19 is Wednesday, 2026-08-22 is Saturday
    const monday = makeDate(2026, 8, 17, 10, 30);
    const wednesday = makeDate(2026, 8, 19, 10, 30);
    const saturday = makeDate(2026, 8, 22, 10, 30);

    // MON-FRI (weekdays only)
    expect(cronMatches("30 10 * * MON-FRI", monday)).toBe(true);
    expect(cronMatches("30 10 * * MON-FRI", wednesday)).toBe(true);
    expect(cronMatches("30 10 * * MON-FRI", saturday)).toBe(false);
  });

  // ── Malformed expressions ────────────────────────────────────────────────

  it("degrades gracefully for expressions with wrong field count", () => {
    // Too few fields
    expect(cronMatches("* * *", new Date())).toBe(true);
    // Too many fields
    expect(cronMatches("* * * * * *", new Date())).toBe(true);
    // Empty
    expect(cronMatches("", new Date())).toBe(true);
  });

  it("handles extra whitespace", () => {
    const date = makeDate(2026, 8, 15, 10, 30);
    expect(cronMatches("  30  10  *  *  *  ", date)).toBe(true);
  });

  // ── Edge cases ───────────────────────────────────────────────────────────

  it("matches midnight correctly", () => {
    const midnight = makeDate(2026, 8, 15, 0, 0);
    expect(cronMatches("0 0 * * *", midnight)).toBe(true);
    expect(cronMatches("0 1 * * *", midnight)).toBe(false);
  });

  it("matches end-of-day correctly", () => {
    const lateNight = makeDate(2026, 8, 15, 23, 59);
    expect(cronMatches("59 23 * * *", lateNight)).toBe(true);
    expect(cronMatches("58 23 * * *", lateNight)).toBe(false);
  });

  it("matches step-based minutes", () => {
    // Every 15 minutes: 0, 15, 30, 45
    const at0 = makeDate(2026, 8, 15, 10, 0);
    const at15 = makeDate(2026, 8, 15, 10, 15);
    const at30 = makeDate(2026, 8, 15, 10, 30);
    const at10 = makeDate(2026, 8, 15, 10, 10);

    expect(cronMatches("*/15 * * * *", at0)).toBe(true);
    expect(cronMatches("*/15 * * * *", at15)).toBe(true);
    expect(cronMatches("*/15 * * * *", at30)).toBe(true);
    expect(cronMatches("*/15 * * * *", at10)).toBe(false);
  });
});
