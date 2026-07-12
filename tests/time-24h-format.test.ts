import { describe, it, expect, afterEach, vi } from "vitest";
import { fmtDate, fmtDateTime } from "@/lib/icu";
import { londonParts } from "@/lib/handover-shift";
import { normalizeTime24 } from "@/components/ui/date-picker";
import { buildHandoverPdf, type HandoverPatient } from "@/lib/handover-pdf";

// A 24-hour clock time is HH:mm with hours 00-23 and minutes 00-59.
const TIME_24H = /\b([01]\d|2[0-3]):[0-5]\d\b/;
// Any 12-hour AM/PM marker must never appear in a rendered time.
const AMPM = /\b([AaPp])\.?[Mm]\.?\b/;

function expectNoAmPm(value: string) {
  expect(value).not.toMatch(AMPM);
}

describe("fmtDateTime renders 24-hour clock", () => {
  const cases: Array<{ label: string; iso: string; expectHour: string }> = [
    { label: "midnight", iso: "2026-07-12T00:00:00", expectHour: "00" },
    { label: "01:05", iso: "2026-07-12T01:05:00", expectHour: "01" },
    { label: "noon", iso: "2026-07-12T12:00:00", expectHour: "12" },
    { label: "afternoon", iso: "2026-07-12T13:30:00", expectHour: "13" },
    { label: "late evening", iso: "2026-07-12T23:59:00", expectHour: "23" },
  ];

  for (const c of cases) {
    it(`${c.label} → 24-hour`, () => {
      const out = fmtDateTime(c.iso);
      expect(out).toMatch(TIME_24H);
      expectNoAmPm(out);
      // The hour segment must be the expected 24-hour hour (never 12h re-mapped).
      const time = out.match(TIME_24H)![0];
      expect(time.slice(0, 2)).toBe(c.expectHour);
    });
  }

  it("midnight is 00:xx, never 24:xx", () => {
    const out = fmtDateTime("2026-07-12T00:15:00");
    expect(out).toContain("00:15");
    expect(out).not.toContain("24:15");
  });
});

describe("fmtDate stays date-only (no stray time)", () => {
  it("has no am/pm marker", () => {
    expectNoAmPm(fmtDate("2026-07-12"));
  });
});

describe("londonParts hour is 24-hour", () => {
  it("midnight London → hour 00, never 24", () => {
    // 2026-01-15 00:30 GMT (London == UTC in winter)
    const parts = londonParts(new Date("2026-01-15T00:30:00Z"));
    expect(parts.hour).toBe(0);
  });

  it("afternoon London → 24-hour hour value", () => {
    const parts = londonParts(new Date("2026-01-15T15:00:00Z"));
    expect(parts.hour).toBe(15);
    expect(parts.hour).toBeGreaterThanOrEqual(0);
    expect(parts.hour).toBeLessThanOrEqual(23);
  });
});

describe("normalizeTime24 always yields a 24-hour HH:mm value", () => {
  const cases: Array<[string, string]> = [
    ["9", "09:00"],
    ["930", "09:30"],
    ["1345", "13:45"],
    ["9:30", "09:30"],
    ["00:00", "00:00"],
    ["2359", "23:59"],
    ["25:99", "23:59"],
    ["12:00", "12:00"],
    ["", ""],
  ];

  for (const [input, expected] of cases) {
    it(`"${input}" → "${expected}"`, () => {
      const out = normalizeTime24(input);
      expect(out).toBe(expected);
      if (out) {
        expect(out).toMatch(/^([01]\d|2[0-3]):[0-5]\d$/);
        expectNoAmPm(out);
      }
    });
  }
});

describe("generated PDF timestamp is 24-hour", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function generatedText(): string {
    const doc = buildHandoverPdf([
      { id: "1", full_name: "Test Patient", status: "admitted" } as HandoverPatient,
    ]);
    const raw = doc.output("arraybuffer");
    const s = Buffer.from(raw as ArrayBuffer).toString("latin1");
    const match = s.match(/Generated[^)]*/);
    expect(match, "PDF should contain a 'Generated' timestamp").toBeTruthy();
    return match![0];
  }

  it("afternoon system time renders in 24-hour format", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T22:06:41"));
    const gen = generatedText();
    expect(gen).toMatch(TIME_24H);
    expectNoAmPm(gen);
  });

  it("midnight system time renders as 00:xx, never 12:xx AM or 24:xx", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T00:07:00"));
    const gen = generatedText();
    const time = gen.match(TIME_24H)?.[0];
    expect(time).toBeTruthy();
    expect(time!.slice(0, 2)).toBe("00");
    expectNoAmPm(gen);
    expect(gen).not.toContain("24:07");
  });
});
