// Pure, client-safe helpers for structured patient observations: an organ-support
// / SOFA-lite acuity score, fluid-balance maths, and trend extraction. No I/O.

export interface Observation {
  id: string;
  patient_id: string;
  recorded_at: string;
  recorded_by: string | null;
  hr: number | null;
  sbp: number | null;
  dbp: number | null;
  map: number | null;
  spo2: number | null;
  fio2: number | null;
  rr: number | null;
  temp: number | null;
  gcs: number | null;
  lactate: number | null;
  vent_mode: string | null;
  peep: number | null;
  vt: number | null;
  vasopressor: string | null;
  vasopressor_dose: number | null;
  urine_ml: number | null;
  fluid_in_ml: number | null;
  fluid_out_ml: number | null;
  notes: string | null;
}

// Numeric vitals that make sense to trend as a sparkline.
export const TREND_METRICS = [
  { key: "hr", label: "HR", unit: "bpm" },
  { key: "map", label: "MAP", unit: "mmHg" },
  { key: "spo2", label: "SpO₂", unit: "%" },
  { key: "rr", label: "RR", unit: "/min" },
  { key: "temp", label: "Temp", unit: "°C" },
  { key: "lactate", label: "Lactate", unit: "mmol/L" },
] as const;

export type TrendKey = (typeof TREND_METRICS)[number]["key"];

export function meanArterialPressure(obs: Pick<Observation, "map" | "sbp" | "dbp">): number | null {
  if (obs.map != null) return obs.map;
  if (obs.sbp != null && obs.dbp != null) {
    return Math.round((obs.sbp + 2 * obs.dbp) / 3);
  }
  return null;
}

export interface AcuityScore {
  score: number;
  band: "low" | "moderate" | "high";
  label: string;
  supports: string[];
}

// SOFA-lite: a pragmatic organ-support count (not the full validated SOFA).
// Uses the latest observation plus known organ-support flags on the patient.
export function computeAcuity(
  latest: Observation | null | undefined,
  support: {
    ventilated?: boolean | null;
    rrt?: boolean | null;
    vasoactive?: boolean | null;
  },
): AcuityScore {
  let score = 0;
  const supports: string[] = [];

  const map = latest ? meanArterialPressure(latest) : null;
  const onPressor =
    support.vasoactive === true || (latest?.vasopressor_dose != null && latest.vasopressor_dose > 0);
  if (onPressor || (map != null && map < 65)) {
    score += 2;
    supports.push("Cardiovascular");
  }

  if (support.ventilated === true || (latest?.fio2 != null && latest.fio2 >= 0.4) || latest?.vent_mode) {
    score += 2;
    supports.push("Respiratory");
  }

  if (support.rrt === true) {
    score += 2;
    supports.push("Renal");
  } else if (latest?.urine_ml != null && latest.urine_ml < 20) {
    score += 1;
    supports.push("Oliguria");
  }

  if (latest?.gcs != null && latest.gcs < 13) {
    score += 1;
    supports.push("Neurological");
  }

  if (latest?.lactate != null && latest.lactate >= 4) {
    score += 2;
    supports.push("Lactate ≥4");
  } else if (latest?.lactate != null && latest.lactate >= 2) {
    score += 1;
    supports.push("Lactate ≥2");
  }

  const band: AcuityScore["band"] = score >= 5 ? "high" : score >= 2 ? "moderate" : "low";
  const label = band === "high" ? "High acuity" : band === "moderate" ? "Moderate" : "Low acuity";
  return { score, band, label, supports };
}

export interface FluidBalance {
  inMl: number;
  outMl: number;
  balanceMl: number;
  since: string | null;
}

// 24h running fluid balance from observations within the trailing window.
export function fluidBalance24h(observations: Observation[], now: number = Date.now()): FluidBalance {
  const cutoff = now - 24 * 60 * 60 * 1000;
  let inMl = 0;
  let outMl = 0;
  let earliest: number | null = null;
  for (const o of observations) {
    const t = new Date(o.recorded_at).getTime();
    if (Number.isNaN(t) || t < cutoff) continue;
    if (o.fluid_in_ml != null) inMl += o.fluid_in_ml;
    if (o.fluid_out_ml != null) outMl += o.fluid_out_ml;
    if (o.urine_ml != null) outMl += o.urine_ml;
    if (earliest == null || t < earliest) earliest = t;
  }
  return {
    inMl,
    outMl,
    balanceMl: inMl - outMl,
    since: earliest != null ? new Date(earliest).toISOString() : null,
  };
}

// Ascending-by-time series of a single metric, dropping null readings.
export function trendSeries(
  observations: Observation[],
  key: TrendKey,
): { t: number; v: number }[] {
  return observations
    .map((o) => ({ t: new Date(o.recorded_at).getTime(), v: o[key] as number | null }))
    .filter((p): p is { t: number; v: number } => p.v != null && !Number.isNaN(p.t))
    .sort((a, b) => a.t - b.t);
}

export function latestObservation(observations: Observation[]): Observation | null {
  if (!observations.length) return null;
  return [...observations].sort((a, b) => {
    const byTime = new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime();
    if (byTime !== 0) return byTime;
    // Deterministic tie-breaker when recorded_at values are identical: pick the
    // observation with the greater id so selection is order-independent.
    const aId = a.id ?? "";
    const bId = b.id ?? "";
    return bId < aId ? -1 : bId > aId ? 1 : 0;
  })[0];
}
