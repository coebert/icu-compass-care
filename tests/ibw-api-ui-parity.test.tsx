import { describe, it, expect } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PatientMetaLine } from "@/components/PatientSummary";
import { computeIbw, formatIbwValue } from "@/lib/patient-schema";

// API-level parity: the server persists raw height_m + sex, and every
// consumer derives IBW via the shared computeIbw helper. This test locks
// in that the value returned from the server round-trip is the 1-dp Devine
// number AND that the UI, once re-rendered from that server row (simulating
// a page reload), shows exactly that string with no divergence.

// Simulates the Supabase round-trip: numeric columns come back as numbers,
// sex as the stored enum, and any client-side coercions have already been
// applied by patientInput before persistence.
function serverRoundTrip(input: { height_m: number | null; sex: string | null }) {
  // JSON transport preserves finite numbers exactly, so the round-trip is
  // an identity for the fields we care about.
  return JSON.parse(JSON.stringify(input)) as typeof input;
}

// The canonical 1-dp Devine value the server contract promises.
function expectedIbw(heightM: number | null, sex: string | null): number | null {
  if (heightM == null) return null;
  const inches = heightM * 39.3700787;
  const over60 = Math.max(0, inches - 60);
  const male = 50 + 2.3 * over60;
  const female = 45.5 + 2.3 * over60;
  const raw = sex === "male" ? male : sex === "female" ? female : (male + female) / 2;
  return Math.round(raw * 10) / 10;
}

describe("Server IBW contract + UI reload parity", () => {
  const cases: { height_m: number; sex: string }[] = [
    { height_m: 1.75, sex: "male" },
    { height_m: 1.6, sex: "female" },
    { height_m: 1.9, sex: "male" },
    { height_m: 1.55, sex: "female" },
    { height_m: 1.5, sex: "unknown" }, // averaged Devine
    { height_m: 1.7, sex: "other" },   // averaged Devine
  ];

  it.each(cases)(
    "server row h=$height_m sex=$sex → IBW is 1-dp Devine and UI matches after reload",
    ({ height_m, sex }) => {
      const row = serverRoundTrip({ height_m, sex });

      // 1) API contract: computeIbw against the returned row equals the
      // hand-derived 1-dp Devine reference value.
      const ibw = computeIbw(row.height_m, row.sex);
      const reference = expectedIbw(row.height_m, row.sex)!;
      expect(ibw).toBe(reference);
      // The number is truly at 1dp (no floating-point tail).
      expect(Number.isInteger(ibw! * 10)).toBe(true);
      const expectedString = reference.toFixed(1);
      expect(formatIbwValue(ibw!)).toBe(expectedString);

      // 2) UI reload parity: rendering PatientMetaLine directly from the
      // "server row" (as happens after a page reload) shows exactly the
      // same 1-dp string, prefixed with "IBW " and suffixed with " kg".
      cleanup();
      render(
        <PatientMetaLine
          patient={{
            full_name: "T.P.",
            age: 40,
            sex: row.sex,
            height_m: row.height_m,
            weight_kg: 70,
          }}
        />,
      );
      const meta = screen.getByText((_, el) =>
        !!el && el.tagName === "P" && el.textContent!.includes("IBW "),
      );
      expect(meta.textContent).toContain(`IBW ${expectedString} kg`);
      // And critically, no un-rounded floating-point tail leaked in.
      expect(meta.textContent).not.toMatch(/IBW \d+\.\d{2,} kg/);
    },
  );

  it("server row with null height reloads as the missing-value placeholder", () => {
    const row = serverRoundTrip({ height_m: null, sex: "male" });
    expect(computeIbw(row.height_m, row.sex)).toBeNull();
    cleanup();
    render(
      <PatientMetaLine
        patient={{ full_name: "T.P.", age: 40, sex: row.sex, height_m: row.height_m, weight_kg: 70 }}
      />,
    );
    const meta = screen.getByText((_, el) =>
      !!el && el.tagName === "P" && el.textContent!.includes("IBW"),
    );
    expect(meta.textContent).toContain("IBW —");
    expect(meta.textContent).not.toMatch(/IBW \d/);
  });
});
