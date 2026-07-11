import { describe, it, expect } from "vitest";
import {
  computeAcuity,
  fluidBalance24h,
  meanArterialPressure,
  trendSeries,
  latestObservation,
  type Observation,
} from "@/lib/observations";

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

describe("meanArterialPressure", () => {
  it("prefers explicit MAP", () => {
    expect(meanArterialPressure({ map: 70, sbp: 120, dbp: 60 })).toBe(70);
  });
  it("derives from SBP/DBP", () => {
    expect(meanArterialPressure({ map: null, sbp: 120, dbp: 60 })).toBe(80);
  });
  it("returns null without inputs", () => {
    expect(meanArterialPressure({ map: null, sbp: null, dbp: null })).toBeNull();
  });
});

describe("computeAcuity", () => {
  it("is low with no support and normal obs", () => {
    const a = computeAcuity(obs({ map: 80, gcs: 15, lactate: 1 }), {});
    expect(a.band).toBe("low");
    expect(a.score).toBe(0);
  });

  it("counts multi-organ support as high", () => {
    const a = computeAcuity(obs({ map: 55, gcs: 8, lactate: 5, fio2: 0.6 }), {
      ventilated: true,
      rrt: true,
      vasoactive: true,
    });
    expect(a.band).toBe("high");
    expect(a.supports).toContain("Cardiovascular");
    expect(a.supports).toContain("Renal");
  });

  it("flags oliguria when not on RRT", () => {
    const a = computeAcuity(obs({ urine_ml: 10 }), {});
    expect(a.supports).toContain("Oliguria");
  });
});

describe("fluidBalance24h", () => {
  it("nets input against output and urine", () => {
    const now = Date.now();
    const b = fluidBalance24h(
      [
        obs({ fluid_in_ml: 1000, fluid_out_ml: 200, urine_ml: 300, recorded_at: new Date(now - 3600_000).toISOString() }),
        obs({ fluid_in_ml: 500, urine_ml: 100, recorded_at: new Date(now - 7200_000).toISOString() }),
      ],
      now,
    );
    expect(b.inMl).toBe(1500);
    expect(b.outMl).toBe(600);
    expect(b.balanceMl).toBe(900);
  });

  it("ignores entries older than 24h", () => {
    const now = Date.now();
    const b = fluidBalance24h(
      [obs({ fluid_in_ml: 9999, recorded_at: new Date(now - 48 * 3600_000).toISOString() })],
      now,
    );
    expect(b.inMl).toBe(0);
  });
});

describe("trendSeries & latestObservation", () => {
  it("returns ascending, non-null series", () => {
    const now = Date.now();
    const series = trendSeries(
      [
        obs({ hr: 90, recorded_at: new Date(now - 1000).toISOString() }),
        obs({ hr: null, recorded_at: new Date(now - 500).toISOString() }),
        obs({ hr: 100, recorded_at: new Date(now).toISOString() }),
      ],
      "hr",
    );
    expect(series.map((p) => p.v)).toEqual([90, 100]);
  });

  it("picks the most recent observation", () => {
    const now = Date.now();
    const latest = latestObservation([
      obs({ id: "old", recorded_at: new Date(now - 1000).toISOString() }),
      obs({ id: "new", recorded_at: new Date(now).toISOString() }),
    ]);
    expect(latest?.id).toBe("new");
  });
});
