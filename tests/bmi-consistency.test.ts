import { describe, it, expect } from "vitest";
import {
  computeBmi,
  bmiCategory,
  formatBmiValue,
  formatBmiSummary,
  BMI_MIN,
  BMI_MAX,
  patientInput,
} from "@/lib/patient-schema";

// These tests lock in the invariant that the number the user sees in the
// Demographics tab (formatBmiValue), the summary meta line (formatBmiSummary),
// the edit-history audit rows (formatBmiSummary), and the server-side sanity
// check (computeBmi + BMI_MIN..BMI_MAX in patientInput) all agree exactly.
// Any drift would let a value be accepted server-side but rendered differently
// client-side, or vice versa.

describe("BMI display vs stored value parity", () => {
  const cases: { w: number; h: number; bmi: number; label: string }[] = [
    { w: 70, h: 1.75, bmi: 22.9, label: "Healthy weight" },
    { w: 45, h: 1.7, bmi: 15.6, label: "Underweight" },
    { w: 80, h: 1.7, bmi: 27.7, label: "Overweight" },
    { w: 95, h: 1.7, bmi: 32.9, label: "Obese" },
    { w: 130, h: 1.7, bmi: 45, label: "Severely obese" },
    // Boundary cases — WHO cut-offs must land in the higher class.
    { w: 53.35, h: 1.7, bmi: 18.5, label: "Healthy weight" },
    { w: 72.25, h: 1.7, bmi: 25, label: "Overweight" },
    { w: 86.7, h: 1.7, bmi: 30, label: "Obese" },
    { w: 115.6, h: 1.7, bmi: 40, label: "Severely obese" },
  ];

  it.each(cases)("w=$w h=$h → bmi=$bmi ($label)", ({ w, h, bmi, label }) => {
    const computed = computeBmi(w, h);
    expect(computed).toBe(bmi);
    // 1dp string used everywhere on screen.
    expect(formatBmiValue(computed!)).toBe(bmi.toFixed(1));
    expect(bmiCategory(computed!)).toBe(label);
    expect(formatBmiSummary(w, h)).toBe(`${bmi.toFixed(1)} kg/m² (${label})`);
  });

  it("returns null when either input is missing / invalid", () => {
    expect(computeBmi(null, 1.75)).toBeNull();
    expect(computeBmi(70, null)).toBeNull();
    expect(computeBmi(70, 0)).toBeNull();
    expect(computeBmi(-1, 1.75)).toBeNull();
    expect(computeBmi("abc", 1.75)).toBeNull();
    expect(formatBmiSummary(null, 1.75)).toBeNull();
  });

  it("accepts numeric strings identically to numbers (edit-form parity)", () => {
    expect(computeBmi("70", "1.75")).toBe(computeBmi(70, 1.75));
    expect(formatBmiSummary("70", "1.75")).toBe(formatBmiSummary(70, 1.75));
  });

  it("rounding is stable to 1dp across neighbouring inputs", () => {
    // Values that would differ if rendered from raw division must all agree
    // once passed through the shared computeBmi → formatBmiValue pipeline.
    for (let w = 60; w <= 90; w += 0.1) {
      const bmi = computeBmi(w, 1.75)!;
      expect(formatBmiValue(bmi)).toBe(bmi.toFixed(1));
      // The category shown next to the number is derived from the SAME
      // rounded value, not from the raw division.
      expect(bmiCategory(bmi)).toBe(bmiCategory(Math.round((w / (1.75 * 1.75)) * 10) / 10));
    }
  });
});

describe("server-side BMI sanity check uses the same value", () => {
  const base = {
    full_name: "T.P.",
    age: 40,
    sex: "male" as const,
    status: "admitted" as const,
    location_type: "icu" as const,
    isolation_required: false,
    tep_in_place: false,
    dnacpr_decision: false,
  };

  it("accepts weight/height that yield a BMI inside BMI_MIN..BMI_MAX", () => {
    const parsed = patientInput.parse({ ...base, weight_kg: 70, height_m: 1.75 });
    expect(parsed.weight_kg).toBe(70);
    expect(parsed.height_m).toBe(1.75);
    const bmi = computeBmi(parsed.weight_kg, parsed.height_m)!;
    expect(bmi).toBeGreaterThanOrEqual(BMI_MIN);
    expect(bmi).toBeLessThanOrEqual(BMI_MAX);
  });

  it("rejects out-of-range weight before BMI is computed (client message parity)", () => {
    expect(() => patientInput.parse({ ...base, weight_kg: 0.5, height_m: 1.7 })).toThrow(
      /Weight must be between 1 and 600 kg/,
    );
  });

  it("rejects centimetre height entries with the same message the field shows", () => {
    expect(() => patientInput.parse({ ...base, weight_kg: 70, height_m: 175 })).toThrow(
      /Height must be between 0.3 and 2.5 m/,
    );
  });
});
