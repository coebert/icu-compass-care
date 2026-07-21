import { STATUS_LABELS, fmtDate, fmtDateTime } from "@/lib/icu";
import { courseDays, type Antimicrobial } from "@/lib/antimicrobials";
import type {
  HandoverColumnKey,
  HandoverInvestigation,
  HandoverMicrobiology,
  HandoverPatient,
} from "@/lib/handover-types";
import {
  RECENT_INVESTIGATION_CATEGORIES,
  latestMicrobiologyPerSpecimen,
  mostRecentInvestigation,
} from "@/lib/handover-recency";
import { summariseAllergies, summariseTepExclusions } from "@/lib/patient-safety";
import {
  latestObservation,
  meanArterialPressure,
  type Observation,
} from "@/lib/observations";

function joinNonEmpty(parts: (string | null | undefined | false)[], sep = "\n"): string {
  return parts.filter(Boolean).join(sep);
}

const SEX_SHORT: Record<string, string> = { male: "♂", female: "♀", other: "⚧", unknown: "?" };

function identity(p: HandoverPatient): string {
  const allergies = summariseAllergies((p as Record<string, unknown>).allergies);
  const sex = SEX_SHORT[String((p as Record<string, unknown>).sex ?? "")] ?? "U";
  const ageParts = [p.age != null ? `Age ${p.age}` : null, sex].filter(Boolean).join(" · ");
  return joinNonEmpty([
    p.full_name?.trim() || "—",
    ageParts || null,
    (p as Record<string, unknown>).weight_kg != null ? `Wt ${(p as Record<string, unknown>).weight_kg}kg` : null,
    p.hospital_number ? `MRN ${p.hospital_number}` : null,
    allergies ? `Allergies: ${allergies}` : "Allergies: NKDA",
  ]);
}


function location(p: HandoverPatient): string {
  const discharged = p.status === "discharged";
  return joinNonEmpty([
    p.ward ? `${p.ward}${p.bed ? ` · Bed ${p.bed}` : ""}` : "No location",
    p.status ? STATUS_LABELS[p.status] ?? p.status : null,
    discharged && p.discharge_destination ? `To ${p.discharge_destination}` : null,
    `Adm ${fmtDate(p.admission_date)}`,
    discharged && p.discharge_date ? `Disch ${fmtDate(p.discharge_date)}` : null,
  ]);
}

function flags(p: HandoverPatient): string {
  const f: string[] = [];
  if (p.dnacpr_decision) f.push(`DNACPR${p.dnacpr_details ? `: ${p.dnacpr_details}` : ""}`);
  if (p.tep_in_place) {
    const notFor = summariseTepExclusions(p.tep_exclusions);
    f.push(
      `TEP${p.tep_details ? `: ${p.tep_details}` : ""}${notFor ? ` (Not for: ${notFor})` : ""}`,
    );
  }
  if (p.nok_name) {
    const spoken = p.nok_last_updated
      ? ` [Spoken to ${fmtDateTime(p.nok_last_updated)}${p.nok_last_updated_by ? ` by ${p.nok_last_updated_by}` : ""}]`
      : "";
    f.push(`NOK: ${p.nok_name}${p.nok_relationship ? ` (${p.nok_relationship})` : ""}${p.nok_contact ? ` ${p.nok_contact}` : ""}${spoken}`);
  }
  return f.length ? f.join("\n") : "—";
}

/**
 * Render the "most recent" investigations column: one line per key category
 * (Bloods / CXR / CT chest) showing the newest findings and its result time.
 */
function investigations(p: HandoverPatient): string {
  const list: HandoverInvestigation[] = Array.isArray(p.investigations) ? p.investigations : [];
  const lines = RECENT_INVESTIGATION_CATEGORIES.map((category) => {
    const latest = mostRecentInvestigation(list, category);
    if (!latest) return `${category}: —`;
    const when = latest.result_at ? ` (${fmtDateTime(latest.result_at)})` : "";
    return `${category}: ${latest.findings || "—"}${when}`;
  });
  return lines.join("\n");
}

/**
 * Render the "key microbiology" column: the newest result for each specimen
 * type that has any recorded finding, most recent first.
 */
function microbiology(p: HandoverPatient): string {
  const list: HandoverMicrobiology[] = Array.isArray(p.microbiology_results)
    ? p.microbiology_results
    : Array.isArray(p.microbiology)
      ? p.microbiology
      : [];
  const latest = latestMicrobiologyPerSpecimen(list);
  if (!latest.length) return "—";
  return latest
    .map((r) => {
      const specimen = (r.specimen_type ?? "").trim() || "Other";
      const when = r.result_at ? ` (${fmtDateTime(r.result_at)})` : "";
      return `${specimen}: ${r.findings || "—"}${when}`;
    })
    .join("\n");
}

/**
 * Render the "latest observations" column: a single deterministic vitals block
 * from the most recent observation (by recorded_at). Purely a function of the
 * recorded data — no wall-clock dependency — so the same inputs always produce
 * the same output.
 */
function observations(p: HandoverPatient): string {
  const list: Observation[] = Array.isArray(p.patient_observations)
    ? (p.patient_observations as Observation[])
    : Array.isArray(p.observations)
      ? (p.observations as Observation[])
      : [];
  const latest = latestObservation(list);
  if (!latest) return "—";
  const map = meanArterialPressure(latest);
  const parts: (string | false | null)[] = [
    latest.hr != null && `HR ${latest.hr}`,
    latest.sbp != null && latest.dbp != null
      ? `BP ${latest.sbp}/${latest.dbp}`
      : map != null && `MAP ${map}`,
    map != null && latest.sbp != null && latest.dbp != null && `MAP ${map}`,
    latest.spo2 != null && `SpO₂ ${latest.spo2}%`,
    latest.fio2 != null && `FiO₂ ${latest.fio2}`,
    latest.rr != null && `RR ${latest.rr}`,
    latest.temp != null && `T ${latest.temp}°C`,
    latest.gcs != null && `GCS ${latest.gcs}`,
    latest.lactate != null && `Lac ${latest.lactate}`,
    latest.urine_ml != null && `UO ${latest.urine_ml}mL/h`,
    latest.vent_mode && `Vent ${latest.vent_mode}${latest.peep != null ? ` PEEP ${latest.peep}` : ""}`,
    latest.vasopressor &&
      `Pressor ${latest.vasopressor}${latest.vasopressor_dose != null ? ` ${latest.vasopressor_dose}` : ""}`,
  ];
  const vitals = parts.filter(Boolean).join(" · ") || "—";
  // Include the selected observation's timestamp and id so it is unambiguous
  // which row was chosen during PDF generation (important when several rows
  // share the same recorded_at and a tie-breaker picked one).
  const idSuffix = latest.id ? ` · id ${latest.id}` : "";
  return `${vitals}\n(${fmtDateTime(latest.recorded_at)}${idSuffix})`;
}

// Combine the systems-based review into a single labelled block for the PDF,
// skipping any system with no notes.
const SYSTEMS_FIELDS: [keyof HandoverPatient, string][] = [
  ["systems_resp", "Resp"],
  ["systems_cvs", "CVS"],
  ["systems_neuro", "CNS/Neuro"],
  ["systems_renal", "Renal"],
  ["systems_gastro", "Gastro/Nutri"],
  ["systems_haem", "Haem"],
  ["systems_micro", "Micro"],
  ["systems_other", "Other"],
];

/**
 * Summarise a patient's antimicrobial agents for the handover sheet. Each agent
 * shows its name, start date, and either the running course day (ongoing) or the
 * total completed course length. Returns "" when none are recorded.
 */
export function antimicrobialsSummary(p: HandoverPatient): string {
  const list: Antimicrobial[] = Array.isArray(p.antimicrobials)
    ? (p.antimicrobials as Antimicrobial[])
    : [];
  if (!list.length) return "";
  return list
    .map((a) => {
      const name = (a?.name ?? "").trim() || "Agent";
      const started = a?.started_on || "";
      const days = courseDays(started, a?.ended_on);
      if (!started) return name;
      if (a?.ended_on) {
        const total = days != null ? `, ${days}d total` : "";
        return `${name} (${started}→${a.ended_on}${total})`;
      }
      const dayStr = days != null ? `, day ${days}` : "";
      return `${name} (from ${started}${dayStr})`;
    })
    .join("; ");
}

/** Renal support flags (diuretics / RRT) as a short suffix, or "". */
export function renalSupportSummary(p: HandoverPatient): string {
  const flags: string[] = [];
  if (p.renal_diuretics) flags.push("Diuretics");
  if (p.renal_rrt) flags.push("RRT");
  return flags.join(", ");
}

function systemsReview(p: HandoverPatient): string {
  const renalSupport = renalSupportSummary(p);
  const antimicrobials = antimicrobialsSummary(p);
  const lines = SYSTEMS_FIELDS.map(([key, label]) => {
    let val = typeof p[key] === "string" ? (p[key] as string).trim() : "";
    // Both the structured renal support flags (diuretics / RRT) and the
    // antimicrobial course data are folded into the Systems review column so
    // they only print when this column is included in the selected preset.
    if (key === "systems_renal" && renalSupport) {
      val = val ? `${val} · ${renalSupport}` : renalSupport;
    }
    if (key === "systems_micro" && antimicrobials) {
      const abx = `Abx: ${antimicrobials}`;
      val = val ? `${val}\n${abx}` : abx;
    }
    return val ? `${label}: ${val}` : "";
  }).filter(Boolean);
  return lines.length ? lines.join("\n") : "—";
}

/**
 * The full set of handover columns in display order, each with a header, a
 * proportional width weight, and a renderer. The user can choose which of
 * these appear in the exported PDF; unselected columns are dropped and the
 * remaining widths re-distribute to fill the page.
 */
export const HANDOVER_COLUMNS: {
  key: HandoverColumnKey;
  header: string;
  weight: number;
  render: (p: HandoverPatient) => string;
}[] = [
  { key: "patient", header: "Patient", weight: 28, render: identity },
  { key: "location", header: "Location / status", weight: 26, render: location },
  { key: "pmh", header: "Past medical history", weight: 32, render: (p) => p.past_medical_history || "—" },
  { key: "admission", header: "Current admission", weight: 36, render: (p) => p.current_admission || "—" },
  { key: "management", header: "Management", weight: 36, render: (p) => p.current_management || "—" },
  { key: "systems", header: "Systems review", weight: 42, render: systemsReview },
  { key: "observations", header: "Latest observations", weight: 38, render: observations },
  { key: "investigations", header: "Most recent investigations", weight: 44, render: investigations },
  { key: "microbiology", header: "Key microbiology", weight: 36, render: microbiology },
  { key: "tasks", header: "Outstanding tasks", weight: 36, render: (p) => p.outstanding_tasks || "—" },
  { key: "flags", header: "TEP / DNACPR / NOK", weight: 30, render: flags },
];

/** All column keys, used as the default (everything shown). */
export const ALL_HANDOVER_COLUMN_KEYS: HandoverColumnKey[] = HANDOVER_COLUMNS.map(
  (c) => c.key,
);
