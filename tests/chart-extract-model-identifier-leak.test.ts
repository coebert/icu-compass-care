import { describe, it, expect } from "vitest";
import { chartExtractionSchema, type ChartExtraction } from "@/lib/chart-extract.functions";
import { scrubExtractionIdentifiers } from "@/lib/chart-prompt.server";

/**
 * The identity sticker is redacted client-side and the outbound guard strips
 * metadata, so the model should never see an identifier. These tests assume it
 * returns them anyway (hallucination, or a poorly covered sticker) and prove the
 * structured extraction output drops every identifier and emits only the
 * allowed schema keys.
 */

const IDENTIFIERS = [
  "0752006",
  "RJ1234567",
  "Jonathan Bartholomew Smith",
  "1954-03-11",
  "943 476 5919",
  "12 Cathedral View, Salisbury",
];

// A hostile / sloppy model response: valid clinical payload, plus identifiers in
// the schema's identity fields, plus identity fields that are not in the schema
// at all, plus identifiers smuggled into nested rows and the confidence list.
const hostileModelJson = {
  chart_date: "2026-08-20",
  hospital_number: "0752006",
  initials: "Jonathan Bartholomew Smith",
  patient_name: "Jonathan Bartholomew Smith",
  patient_full_name: "Jonathan Bartholomew Smith",
  nhs_number: "943 476 5919",
  date_of_birth: "1954-03-11",
  address: "12 Cathedral View, Salisbury",
  next_of_kin: { name: "Margaret Smith", phone: "07700 900123" },
  sticker_text: "SMITH, Jonathan B — 0752006 — DOB 11/03/1954",
  balance_24h_ml: -320,
  hourly: [
    {
      hour: 8,
      hr: 96,
      sbp: 118,
      dbp: 64,
      urine_ml: 45,
      // Not in the hourly cell schema — must not survive parsing.
      patient_name: "Jonathan Bartholomew Smith",
      mrn: "0752006",
    },
  ],
  investigations: [
    {
      category: "ABG",
      findings: "pH 7.31, lactate 2.4",
      result_at: "2026-08-20T09:00:00.000Z",
      hospital_number: "0752006",
    },
  ],
  microbiology: [
    {
      specimen_type: "Sputum",
      findings: "Mixed respiratory flora",
      result_at: "2026-08-20T11:00:00.000Z",
      patient_name: "Jonathan Bartholomew Smith",
    },
  ],
  assessments: {
    resp: "Weaning PS 10/5",
    micro: "Day 3 co-amoxiclav",
    nhs_number: "943 476 5919",
  },
  notes: "Settled night.",
  overall_confidence: 0.82,
  low_confidence: ["hospital_number", "initials", "hourly.8.dbp"],
};

function parseAndScrub(): ChartExtraction {
  const parsed = chartExtractionSchema.safeParse(hostileModelJson);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw parsed.error;
  return scrubExtractionIdentifiers(parsed.data);
}

describe("structured extraction output drops model-returned identifiers", () => {
  it("nulls the identity fields the model filled in", () => {
    const out = parseAndScrub();
    expect(out.hospital_number).toBeNull();
    expect(out.initials).toBeNull();
  });

  it("emits only allowed top-level schema keys", () => {
    const out = parseAndScrub();
    expect(Object.keys(out).sort()).toEqual(
      [
        "assessments",
        "balance_24h_ml",
        "chart_date",
        "hospital_number",
        "hourly",
        "initials",
        "investigations",
        "low_confidence",
        "microbiology",
        "notes",
        "overall_confidence",
      ].sort(),
    );
  });

  it("strips unknown identity keys from nested rows and assessments", () => {
    const out = parseAndScrub();
    const hour = out.hourly[0] as Record<string, unknown>;
    expect(hour['patient_name']).toBeUndefined();
    expect(hour['mrn']).toBeUndefined();
    expect(hour.hr).toBe(96);

    expect((out.investigations[0] as Record<string, unknown>)['hospital_number']).toBeUndefined();
    expect((out.microbiology[0] as Record<string, unknown>)['patient_name']).toBeUndefined();
    expect((out.assessments as Record<string, unknown>)['nhs_number']).toBeUndefined();
    expect(out.assessments.micro).toBe("Day 3 co-amoxiclav");
  });

  it("removes identifier entries from the low-confidence list", () => {
    const out = parseAndScrub();
    expect(out.low_confidence).toEqual(["hourly.8.dbp"]);
  });

  it("contains no identifier substring anywhere in the emitted payload", () => {
    const serialised = JSON.stringify(parseAndScrub());
    for (const id of IDENTIFIERS) {
      expect(serialised).not.toContain(id);
    }
    for (const word of ["Jonathan", "Bartholomew", "Smith", "Margaret", "sticker_text", "date_of_birth"]) {
      expect(serialised).not.toContain(word);
    }
  });

  it("keeps the clinical payload intact after scrubbing", () => {
    const out = parseAndScrub();
    expect(out.chart_date).toBe("2026-08-20");
    expect(out.balance_24h_ml).toBe(-320);
    expect(out.hourly).toHaveLength(1);
    expect(out.investigations[0]?.findings).toBe("pH 7.31, lactate 2.4");
    expect(out.microbiology[0]?.specimen_type).toBe("Sputum");
    expect(out.notes).toBe("Settled night.");
  });
});
