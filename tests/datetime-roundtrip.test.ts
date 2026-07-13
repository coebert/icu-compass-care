import { describe, it, expect } from "vitest";
import {
  toCanonicalTimestamp,
  isValidTimestamp,
  zTimestamp,
  zTimestampNullish,
} from "@/lib/datetime";
import { fmtDateTime } from "@/lib/icu";

const TIME_24H = /\b([01]\d|2[0-3]):[0-5]\d\b/;
const AM_PM = /\b(AM|PM|am|pm)\b/;

describe("toCanonicalTimestamp", () => {
  it("normalises a full ISO instant to canonical UTC", () => {
    expect(toCanonicalTimestamp("2026-07-11T22:00:00.000Z")).toBe(
      "2026-07-11T22:00:00.000Z",
    );
  });

  it("returns null for empty/blank/absent input", () => {
    expect(toCanonicalTimestamp("")).toBeNull();
    expect(toCanonicalTimestamp("   ")).toBeNull();
    expect(toCanonicalTimestamp(null)).toBeNull();
    expect(toCanonicalTimestamp(undefined)).toBeNull();
  });

  it("returns null for unparseable input", () => {
    expect(toCanonicalTimestamp("not-a-date")).toBeNull();
    expect(toCanonicalTimestamp("13/25/2026")).toBeNull();
  });

  it("is idempotent — a canonicalised value re-canonicalises unchanged", () => {
    const once = toCanonicalTimestamp("2026-01-01T09:30:00Z");
    expect(toCanonicalTimestamp(once)).toBe(once);
  });
});

describe("isValidTimestamp", () => {
  it("treats absence/blank as valid", () => {
    expect(isValidTimestamp(null)).toBe(true);
    expect(isValidTimestamp("")).toBe(true);
  });
  it("rejects garbage", () => {
    expect(isValidTimestamp("nope")).toBe(false);
  });
  it("accepts a real instant", () => {
    expect(isValidTimestamp("2026-07-11T22:00:00Z")).toBe(true);
  });
});

describe("zTimestamp / zTimestampNullish", () => {
  it("required: parses and normalises to canonical UTC ISO", () => {
    expect(zTimestamp.parse("2026-07-11T22:00:00Z")).toBe(
      "2026-07-11T22:00:00.000Z",
    );
  });

  it("required: rejects invalid values", () => {
    expect(zTimestamp.safeParse("garbage").success).toBe(false);
  });

  it("nullish: blank/absent → null", () => {
    expect(zTimestampNullish.parse(undefined)).toBeNull();
    expect(zTimestampNullish.parse(null)).toBeNull();
    expect(zTimestampNullish.parse("")).toBeNull();
  });

  it("nullish: valid value → canonical UTC ISO", () => {
    expect(zTimestampNullish.parse("2026-07-11T22:00:00Z")).toBe(
      "2026-07-11T22:00:00.000Z",
    );
  });

  it("nullish: rejects invalid values", () => {
    expect(zTimestampNullish.safeParse("garbage").success).toBe(false);
  });
});

describe("round-trip: picker emit → store → display", () => {
  // The picker builds a local Date from the picked date + 24-hour time, then
  // emits toISOString(). Stored verbatim in a timestamptz column, reading it
  // back and formatting must yield the SAME wall-clock the user entered.
  const cases = [
    { y: 2026, mo: 0, d: 1, h: 0, mi: 0 }, // midnight
    { y: 2026, mo: 0, d: 1, h: 9, mi: 5 },
    { y: 2026, mo: 6, d: 11, h: 23, mi: 0 }, // BST evening
    { y: 2026, mo: 6, d: 11, h: 13, mi: 30 },
    { y: 2026, mo: 11, d: 31, h: 23, mi: 59 }, // GMT year-end
  ];

  for (const c of cases) {
    it(`round-trips ${String(c.h).padStart(2, "0")}:${String(c.mi).padStart(2, "0")}`, () => {
      const local = new Date(c.y, c.mo, c.d, c.h, c.mi, 0, 0);
      const stored = local.toISOString(); // what the picker emits
      const back = new Date(stored); // what a timestamptz read yields
      expect(back.getHours()).toBe(c.h);
      expect(back.getMinutes()).toBe(c.mi);

      const display = fmtDateTime(stored);
      expect(display).toMatch(TIME_24H);
      expect(display).not.toMatch(AM_PM);
      expect(display).not.toMatch(/\b24:\d\d\b/); // midnight is 00:xx, never 24:xx
    });
  }
});
