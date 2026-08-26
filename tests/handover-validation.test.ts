import { describe, it, expect } from "vitest";
import {
  missingCriticalFields,
  canGenerateHandover,
  type HandoverCriticalPatient,
} from "@/lib/handover-validation";

/**
 * Confirms handover PDF generation is blocked exactly when a critical field is
 * missing, and that the reported missing-field list is correct — in order —
 * across a range of patient-data scenarios.
 */

const complete: HandoverCriticalPatient = {
  full_name: "J.S.",
  hospital_number: "RN123456",
  ward: "Critical Care Unit",
  bed: "3",
  current_admission: "Severe CAP, T1RF, intubated.",
};

describe("handover critical-field validation", () => {
  it("allows generation when every critical field is present", () => {
    expect(missingCriticalFields(complete)).toEqual([]);
    expect(canGenerateHandover(complete)).toBe(true);
  });

  const SCENARIOS: {
    name: string;
    patient: HandoverCriticalPatient | null | undefined;
    expected: string[];
  }[] = [
    {
      name: "null patient (record not loaded)",
      patient: null,
      expected: ["Patient record"],
    },
    {
      name: "undefined patient",
      patient: undefined,
      expected: ["Patient record"],
    },
    {
      name: "missing patient name",
      patient: { ...complete, full_name: "" },
      expected: ["Patient initials"],
    },
    {
      name: "whitespace-only name counts as missing",
      patient: { ...complete, full_name: "   " },
      expected: ["Patient initials"],
    },
    {
      name: "null hospital number",
      patient: { ...complete, hospital_number: null },
      expected: ["Hospital number"],
    },
    {
      name: "ward present, no bed → location OK",
      patient: { ...complete, bed: "" },
      expected: [],
    },
    {
      name: "bed present, no ward → location OK",
      patient: { ...complete, ward: null },
      expected: [],
    },
    {
      name: "neither ward nor bed → location missing",
      patient: { ...complete, ward: "  ", bed: "" },
      expected: ["Location (ward/bed)"],
    },
    {
      name: "missing current admission",
      patient: { ...complete, current_admission: "" },
      expected: ["Current admission"],
    },
    {
      name: "multiple missing fields reported in stable order",
      patient: {
        full_name: "",
        hospital_number: "",
        ward: "",
        bed: "",
        current_admission: "",
      },
      expected: [
        "Patient initials",
        "Hospital number",
        "Location (ward/bed)",
        "Current admission",
      ],
    },
    {
      name: "empty object → all fields missing",
      patient: {},
      expected: [
        "Patient initials",
        "Hospital number",
        "Location (ward/bed)",
        "Current admission",
      ],
    },
  ];

  for (const s of SCENARIOS) {
    it(`reports the correct missing list — ${s.name}`, () => {
      const missing = missingCriticalFields(s.patient);
      expect(missing).toEqual(s.expected);
      // Generation is blocked iff there is at least one missing field.
      expect(canGenerateHandover(s.patient)).toBe(s.expected.length === 0);
    });
  }

  it("does not mutate the input patient", () => {
    const p = { ...complete, full_name: "" };
    const snapshot = JSON.stringify(p);
    missingCriticalFields(p);
    expect(JSON.stringify(p)).toBe(snapshot);
  });
});
