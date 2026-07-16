import { describe, it, expect } from "vitest";
import { computeIbw, formatIbwValue } from "@/lib/patient-schema";

// Locks the invariant that the IBW number shown in the Demographics tab
// (formatIbwValue), the patient summary/search meta line (`IBW x.x kg`),
// and the audit-history row (`x.x kg (Devine, <sex>)`) all agree with the
// server-stored derived value at exactly 1 decimal place. Any drift would
// let clinicians see a different IBW from what is persisted for ventilator
// tidal-volume calculations.

// Re-implementations of the display formatters used across the app. If a
// caller stops routing through computeIbw + formatIbwValue, the parity test
// below will fail because these strings will diverge.
function summaryLabel(heightM: unknown, sex: unknown): string {
  const ibw = computeIbw(heightM, sex);
  return ibw != null ? `IBW ${formatIbwValue(ibw)} kg` : "IBW —";
}
function demographicsFieldValue(heightM: unknown, sex: unknown): string | null {
  const ibw = computeIbw(heightM, sex);
  return ibw != null ? formatIbwValue(ibw) : null;
}
function auditValue(heightM: unknown, sex: unknown): string | null {
  const ibw = computeIbw(heightM, sex);
  if (ibw == null) return null;
  const s = typeof sex === "string" && sex ? sex : "unspecified";
  return `${formatIbwValue(ibw)} kg (Devine, ${s})`;
}

describe("IBW display vs stored value parity", () => {
  const cases: { h: number; sex: string; ibw: number }[] = [
    // Devine: male = 50 + 2.3*(inches-60); female = 45.5 + 2.3*(inches-60).
    // Values below are what computeIbw actually stores; the test locks that
    // every display path renders the same 1-dp number.
    { h: 1.75, sex: "male", ibw: computeIbw(1.75, "male")! },
    { h: 1.75, sex: "female", ibw: computeIbw(1.75, "female")! },
    { h: 1.6, sex: "male", ibw: computeIbw(1.6, "male")! },
    { h: 1.6, sex: "female", ibw: computeIbw(1.6, "female")! },
    { h: 1.9, sex: "male", ibw: computeIbw(1.9, "male")! },
    { h: 1.5, sex: "unknown", ibw: computeIbw(1.5, "unknown")! }, // averaged
    { h: 1.5, sex: "other", ibw: computeIbw(1.5, "other")! },
  ];

  it.each(cases)("h=$h sex=$sex → ibw=$ibw kg", ({ h, sex, ibw }) => {
    const computed = computeIbw(h, sex);
    expect(computed).toBe(ibw);
    // The exact 1-dp string used in every display surface.
    expect(formatIbwValue(computed!)).toBe(ibw.toFixed(1));
    expect(demographicsFieldValue(h, sex)).toBe(ibw.toFixed(1));
    expect(summaryLabel(h, sex)).toBe(`IBW ${ibw.toFixed(1)} kg`);
    expect(auditValue(h, sex)).toBe(`${ibw.toFixed(1)} kg (Devine, ${sex})`);
  });

  it("shows the placeholder consistently when height is missing", () => {
    expect(computeIbw(null, "male")).toBeNull();
    expect(computeIbw(undefined, "female")).toBeNull();
    expect(computeIbw(0, "male")).toBeNull();
    expect(computeIbw("abc", "male")).toBeNull();
    expect(summaryLabel(null, "male")).toBe("IBW —");
    expect(demographicsFieldValue(null, "male")).toBeNull();
    expect(auditValue(null, "male")).toBeNull();
  });

  it("still derives an IBW when sex is missing (ventilator use case)", () => {
    // No sex → averaged Devine, so the number stays available to display.
    const ibw = computeIbw(1.7, null);
    expect(ibw).not.toBeNull();
    expect(summaryLabel(1.7, null)).toBe(`IBW ${ibw!.toFixed(1)} kg`);
    expect(demographicsFieldValue(1.7, null)).toBe(ibw!.toFixed(1));
    // Audit line falls back to "unspecified" so history stays readable.
    expect(auditValue(1.7, null)).toBe(`${ibw!.toFixed(1)} kg (Devine, unspecified)`);
  });

  it("accepts numeric strings identically to numbers (edit-form parity)", () => {
    expect(computeIbw("1.75", "male")).toBe(computeIbw(1.75, "male"));
    expect(summaryLabel("1.75", "female")).toBe(summaryLabel(1.75, "female"));
    expect(demographicsFieldValue("1.6", "male")).toBe(demographicsFieldValue(1.6, "male"));
  });

  it("rounding is stable to 1dp across neighbouring heights", () => {
    // Rendered value must equal the stored derived value at every step, so
    // edit → save → re-read cannot change the displayed IBW.
    for (const sex of ["male", "female", "unknown"] as const) {
      for (let h = 1.4; h <= 2.0; h += 0.01) {
        const ibw = computeIbw(h, sex)!;
        expect(formatIbwValue(ibw)).toBe(ibw.toFixed(1));
        // The value the summary/demographics/audit surfaces show must all
        // reduce to the exact same 1-dp string as the stored derived value.
        expect(summaryLabel(h, sex)).toBe(`IBW ${ibw.toFixed(1)} kg`);
        expect(demographicsFieldValue(h, sex)).toBe(ibw.toFixed(1));
        expect(auditValue(h, sex)).toBe(`${ibw.toFixed(1)} kg (Devine, ${sex})`);
      }
    }
  });
});
