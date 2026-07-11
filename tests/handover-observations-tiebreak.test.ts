import { describe, it, expect } from "vitest";
import { HANDOVER_COLUMNS, type HandoverPatient } from "@/lib/handover-columns";
import { latestObservation, type Observation } from "@/lib/observations";

const renderObservations = HANDOVER_COLUMNS.find((c) => c.key === "observations")!.render;

function obs(partial: Partial<Observation>): Observation {
  return {
    id: partial.id ?? crypto.randomUUID(),
    patient_id: "p1",
    recorded_at: partial.recorded_at ?? new Date().toISOString(),
    recorded_by: null,
    hr: null,
    sbp: null,
    dbp: null,
    map: null,
    spo2: null,
    fio2: null,
    rr: null,
    temp: null,
    gcs: null,
    lactate: null,
    vent_mode: null,
    peep: null,
    vt: null,
    vasopressor: null,
    vasopressor_dose: null,
    urine_ml: null,
    fluid_in_ml: null,
    fluid_out_ml: null,
    notes: null,
    ...partial,
  };
}

describe("Latest observations tie-breaker (identical recorded_at)", () => {
  // Two observations sharing the exact same recorded_at but with different
  // vitals and ids. Selection must be order-independent.
  const SAME_TIME = "2026-07-10T08:00:00.000Z";
  const a = obs({ id: "obs-aaaa", recorded_at: SAME_TIME, hr: 70, spo2: 98 });
  const b = obs({ id: "obs-bbbb", recorded_at: SAME_TIME, hr: 120, spo2: 88 });

  it("latestObservation picks the same record regardless of array order", () => {
    const forward = latestObservation([a, b]);
    const reversed = latestObservation([b, a]);
    expect(forward?.id).toBe(reversed?.id);
    // Higher id wins deterministically.
    expect(forward?.id).toBe("obs-bbbb");
  });

  it("PDF observations block is identical regardless of array order", () => {
    const p1 = { patient_observations: [a, b] } as unknown as HandoverPatient;
    const p2 = { patient_observations: [b, a] } as unknown as HandoverPatient;
    const out1 = renderObservations(p1);
    const out2 = renderObservations(p2);
    expect(out1).toBe(out2);
    // Confirms it reflects the tie-break winner (b: HR 120, SpO₂ 88%).
    expect(out1).toContain("HR 120");
    expect(out1).toContain("SpO₂ 88%");
  });

  it("is stable across many shuffles", () => {
    const baseline = renderObservations({
      patient_observations: [a, b],
    } as unknown as HandoverPatient);
    for (let i = 0; i < 25; i++) {
      const shuffled = Math.random() < 0.5 ? [a, b] : [b, a];
      const out = renderObservations({
        patient_observations: shuffled,
      } as unknown as HandoverPatient);
      expect(out).toBe(baseline);
    }
  });
});
