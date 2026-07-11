import { describe, it, expect } from "vitest";
import {
  decideShiftGate,
  londonParts,
  shiftForHour,
  labelFor,
} from "@/lib/handover-shift";

// Build a Date at a specific UTC wall-clock. The whole point of the gating is
// that a FIXED UTC hour maps to a DIFFERENT London hour depending on whether
// GMT (winter) or BST (summer) is in effect, so we always assert against real
// UTC instants.
function utc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi = 0,
): Date {
  return new Date(Date.UTC(y, mo - 1, d, h, mi, 0));
}

// UK DST 2026:
//   spring forward — Sun 29 Mar 2026, 01:00 GMT -> 02:00 BST
//   fall back      — Sun 25 Oct 2026, 02:00 BST -> 01:00 GMT

describe("londonParts resolves the correct wall-clock across DST", () => {
  it("treats 08:00 UTC as 08:00 London in winter (GMT)", () => {
    const p = londonParts(utc(2026, 1, 15, 8));
    expect(p.hour).toBe(8);
    expect(p.isoDate).toBe("2026-01-15");
  });

  it("treats 08:00 UTC as 09:00 London in summer (BST, +1)", () => {
    const p = londonParts(utc(2026, 7, 15, 8));
    expect(p.hour).toBe(9);
  });

  it("treats 07:00 UTC as 08:00 London in summer (BST, +1)", () => {
    const p = londonParts(utc(2026, 7, 15, 7));
    expect(p.hour).toBe(8);
  });
});

describe("scheduled gating (force = false) is DST-aware for the 08:00 shift", () => {
  it("captures the AM shift at 08:00 UTC in winter", () => {
    const g = decideShiftGate(utc(2026, 1, 15, 8), false);
    expect(g.capture).toBe(true);
    if (g.capture) expect(g.shift).toBe("am");
  });

  it("does NOT capture at 08:00 UTC in summer (that is 09:00 London)", () => {
    const g = decideShiftGate(utc(2026, 7, 15, 8), false);
    expect(g.capture).toBe(false);
    if (!g.capture) expect(g.reason).toContain("09:00");
  });

  it("captures the AM shift at 07:00 UTC in summer (that is 08:00 London)", () => {
    const g = decideShiftGate(utc(2026, 7, 15, 7), false);
    expect(g.capture).toBe(true);
    if (g.capture) expect(g.shift).toBe("am");
  });

  it("does NOT capture at 07:00 UTC in winter (that is 07:00 London)", () => {
    const g = decideShiftGate(utc(2026, 1, 15, 7), false);
    expect(g.capture).toBe(false);
    if (!g.capture) expect(g.reason).toContain("07:00");
  });
});

describe("scheduled gating (force = false) is DST-aware for the 20:00 shift", () => {
  it("captures the PM shift at 20:00 UTC in winter", () => {
    const g = decideShiftGate(utc(2026, 1, 15, 20), false);
    expect(g.capture).toBe(true);
    if (g.capture) expect(g.shift).toBe("pm");
  });

  it("does NOT capture at 20:00 UTC in summer (that is 21:00 London)", () => {
    const g = decideShiftGate(utc(2026, 7, 15, 20), false);
    expect(g.capture).toBe(false);
    if (!g.capture) expect(g.reason).toContain("21:00");
  });

  it("captures the PM shift at 19:00 UTC in summer (that is 20:00 London)", () => {
    const g = decideShiftGate(utc(2026, 7, 15, 19), false);
    expect(g.capture).toBe(true);
    if (g.capture) expect(g.shift).toBe("pm");
  });
});

describe("across the spring-forward boundary (29 Mar 2026)", () => {
  // The day before the change is still GMT.
  it("Sat 28 Mar: 08:00 UTC captures AM (still GMT)", () => {
    const g = decideShiftGate(utc(2026, 3, 28, 8), false);
    expect(g.capture).toBe(true);
    if (g.capture) expect(g.shift).toBe("am");
  });

  // On/after the change, BST is in effect: 08:00 UTC is now 09:00 London.
  it("Mon 30 Mar: 08:00 UTC no longer captures (now BST -> 09:00 London)", () => {
    const g = decideShiftGate(utc(2026, 3, 30, 8), false);
    expect(g.capture).toBe(false);
  });

  it("Mon 30 Mar: 07:00 UTC captures AM (BST -> 08:00 London)", () => {
    const g = decideShiftGate(utc(2026, 3, 30, 7), false);
    expect(g.capture).toBe(true);
    if (g.capture) expect(g.shift).toBe("am");
  });
});

describe("across the fall-back boundary (25 Oct 2026)", () => {
  // Before the change, BST is in effect: 07:00 UTC is 08:00 London.
  it("Sat 24 Oct: 07:00 UTC captures AM (still BST)", () => {
    const g = decideShiftGate(utc(2026, 10, 24, 7), false);
    expect(g.capture).toBe(true);
    if (g.capture) expect(g.shift).toBe("am");
  });

  // On/after the change, GMT is in effect: 08:00 UTC is 08:00 London.
  it("Mon 26 Oct: 08:00 UTC captures AM (back to GMT)", () => {
    const g = decideShiftGate(utc(2026, 10, 26, 8), false);
    expect(g.capture).toBe(true);
    if (g.capture) expect(g.shift).toBe("am");
  });

  it("Mon 26 Oct: 07:00 UTC no longer captures (GMT -> 07:00 London)", () => {
    const g = decideShiftGate(utc(2026, 10, 26, 7), false);
    expect(g.capture).toBe(false);
  });
});

describe("a full DST year: exactly two capture instants per day", () => {
  // For a representative winter day and summer day, sweep all 24 UTC hours and
  // confirm the scheduled gate fires exactly twice (once AM, once PM).
  function captureHoursForDay(y: number, mo: number, d: number) {
    const hits: Array<{ hour: number; shift: string }> = [];
    for (let h = 0; h < 24; h++) {
      const g = decideShiftGate(utc(y, mo, d, h), false);
      if (g.capture) hits.push({ hour: h, shift: g.shift });
    }
    return hits;
  }

  it("winter day (GMT): fires at 08:00 and 20:00 UTC", () => {
    const hits = captureHoursForDay(2026, 1, 15);
    expect(hits).toEqual([
      { hour: 8, shift: "am" },
      { hour: 20, shift: "pm" },
    ]);
  });

  it("summer day (BST): fires at 07:00 and 19:00 UTC", () => {
    const hits = captureHoursForDay(2026, 7, 15);
    expect(hits).toEqual([
      { hour: 7, shift: "am" },
      { hour: 19, shift: "pm" },
    ]);
  });
});

describe("forced capture (admin 'Capture now') ignores the handover hour", () => {
  it("captures even at a non-handover UTC hour, picking the nearest shift", () => {
    const morning = decideShiftGate(utc(2026, 1, 15, 3), true); // 03:00 London
    expect(morning.capture).toBe(true);
    if (morning.capture) expect(morning.shift).toBe("am");

    const evening = decideShiftGate(utc(2026, 1, 15, 15), true); // 15:00 London
    expect(evening.capture).toBe(true);
    if (evening.capture) expect(evening.shift).toBe("pm");
  });
});

describe("supporting helpers", () => {
  it("shiftForHour splits at 14:00 London", () => {
    expect(shiftForHour(0)).toBe("am");
    expect(shiftForHour(13)).toBe("am");
    expect(shiftForHour(14)).toBe("pm");
    expect(shiftForHour(23)).toBe("pm");
  });

  it("labelFor uses the handover clock time, not the raw hour", () => {
    const p = londonParts(utc(2026, 7, 15, 7)); // 08:00 London, BST
    expect(labelFor(p, "am")).toBe("08:00 · 15 Jul 2026");
    expect(labelFor(p, "pm")).toBe("20:00 · 15 Jul 2026");
  });
});
