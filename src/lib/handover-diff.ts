// Pure, framework-free diff between two saved handover snapshots.
//
// A snapshot is the array of patient rows stored on a `handover_versions` row
// (see handover-snapshot.server.ts). This module turns two snapshots into a
// per-patient, per-field diff so the UI can highlight exactly what a clinician
// changed between two shift handovers (management, escalation plan, outstanding
// tasks, etc.). It has no React / DOM / server dependencies so it is unit
// testable and safe to import anywhere.

import type { HandoverPatient } from "@/lib/handover-types";
import { STATUS_LABELS } from "@/lib/icu";
import { DAILY_GOAL_ITEMS, parseDailyGoals } from "@/lib/patient-safety";

/** A single comparable handover field with a human label and a renderer. */
type CompareField = {
  key: string;
  label: string;
  render: (p: HandoverPatient) => string;
};

function text(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.filter(Boolean).join(", ");
  return String(v).trim();
}

function joinLines(parts: Array<string | null | undefined | false>): string {
  return parts.filter((p): p is string => Boolean(p && p.trim())).join("\n");
}

function renderLocation(p: HandoverPatient): string {
  return joinLines([
    p.ward ? `${p.ward}${p.bed ? ` · Bed ${p.bed}` : ""}` : "No location",
    p.status ? STATUS_LABELS[p.status] ?? p.status : null,
    p.status === "discharged" && p.discharge_destination
      ? `To ${p.discharge_destination}`
      : null,
  ]);
}

function renderEscalation(p: HandoverPatient): string {
  const f: string[] = [];
  if (p.tep_in_place) f.push(`TEP${p.tep_details ? `: ${p.tep_details}` : ""}`);
  else f.push("No TEP recorded");
  if (p.dnacpr_decision) {
    f.push(`DNACPR${p.dnacpr_details ? `: ${p.dnacpr_details}` : ""}`);
  }
  return f.join("\n");
}

function renderDailyGoals(p: HandoverPatient): string {
  const goals = parseDailyGoals(p.daily_goals);
  const done = DAILY_GOAL_ITEMS.filter((i) => goals[i.key]).map((i) => i.label);
  return done.length ? done.join(", ") : "None ticked";
}

function renderNok(p: HandoverPatient): string {
  if (!p.nok_name) return "";
  return joinLines([
    `${p.nok_name}${p.nok_relationship ? ` (${p.nok_relationship})` : ""}`,
    p.nok_contact ? `Contact: ${p.nok_contact}` : null,
    p.nok_last_updated_by ? `Updated by ${p.nok_last_updated_by}` : null,
  ]);
}

// The fields shown in the comparison, in display order. Clinical narrative
// first (what changes most between shifts), then structured summaries.
export const COMPARE_FIELDS: CompareField[] = [
  { key: "location", label: "Location & status", render: renderLocation },
  { key: "current_admission", label: "Current admission", render: (p) => text(p.current_admission) },
  { key: "past_medical_history", label: "Past medical history", render: (p) => text(p.past_medical_history) },
  { key: "current_management", label: "Management", render: (p) => text(p.current_management) },
  { key: "escalation", label: "Escalation plan (TEP / DNACPR)", render: renderEscalation },
  { key: "outstanding_tasks", label: "Outstanding tasks", render: (p) => text(p.outstanding_tasks) },
  { key: "daily_goals", label: "Daily goals", render: renderDailyGoals },
  { key: "systems_resp", label: "Systems — Resp", render: (p) => text(p.systems_resp) },
  { key: "systems_cvs", label: "Systems — CVS", render: (p) => text(p.systems_cvs) },
  { key: "systems_neuro", label: "Systems — CNS / Neuro", render: (p) => text(p.systems_neuro) },
  { key: "systems_renal", label: "Systems — Renal", render: (p) => text(p.systems_renal) },
  { key: "systems_gastro", label: "Systems — Gastro / Nutrition", render: (p) => text(p.systems_gastro) },
  { key: "systems_haem", label: "Systems — Haem", render: (p) => text(p.systems_haem) },
  { key: "systems_micro", label: "Systems — Micro", render: (p) => text(p.systems_micro) },
  { key: "systems_other", label: "Systems — Other", render: (p) => text(p.systems_other) },
  { key: "next_of_kin", label: "Next of kin", render: renderNok },
];

export type FieldDiff = {
  key: string;
  label: string;
  before: string;
  after: string;
  changed: boolean;
};

export type PatientPresence = "both" | "added" | "removed";

export type PatientDiff = {
  id: string;
  name: string;
  location: string;
  presence: PatientPresence;
  changedCount: number;
  fields: FieldDiff[];
};

export type SnapshotDiff = {
  patients: PatientDiff[];
  changedPatientCount: number;
  addedCount: number;
  removedCount: number;
};

function patientId(p: HandoverPatient): string {
  return text((p as { id?: unknown }).id) || text(p.hospital_number) || text(p.full_name);
}

function toArray(snapshot: unknown): HandoverPatient[] {
  return Array.isArray(snapshot) ? (snapshot as HandoverPatient[]) : [];
}

function fieldDiffs(
  a: HandoverPatient | undefined,
  b: HandoverPatient | undefined,
): FieldDiff[] {
  return COMPARE_FIELDS.map((f) => {
    const before = a ? f.render(a) : "";
    const after = b ? f.render(b) : "";
    return { key: f.key, label: f.label, before, after, changed: before !== after };
  });
}

/**
 * Diff two snapshots. `a` is treated as the earlier ("before") version and `b`
 * as the later ("after") version. Patients are matched by stable id, then by
 * hospital number / name as a fallback for older rows.
 *
 * The returned patient list is ordered: changed patients first, then added,
 * removed, and finally unchanged — each group alphabetical by name.
 */
export function diffSnapshots(a: unknown, b: unknown): SnapshotDiff {
  const beforeRows = toArray(a);
  const afterRows = toArray(b);

  const beforeMap = new Map<string, HandoverPatient>();
  for (const p of beforeRows) beforeMap.set(patientId(p), p);
  const afterMap = new Map<string, HandoverPatient>();
  for (const p of afterRows) afterMap.set(patientId(p), p);

  const ids = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);

  const patients: PatientDiff[] = [];
  for (const id of ids) {
    const before = beforeMap.get(id);
    const after = afterMap.get(id);
    const presence: PatientPresence = before && after ? "both" : after ? "added" : "removed";
    const source = after ?? before!;
    const fields = fieldDiffs(before, after);
    // For added / removed patients every populated field is a "change".
    const changedCount =
      presence === "both"
        ? fields.filter((f) => f.changed).length
        : fields.filter((f) => (presence === "added" ? f.after : f.before)).length;

    patients.push({
      id,
      name: text(source.full_name) || "Unknown patient",
      location: renderLocation(source),
      presence,
      changedCount,
      fields,
    });
  }

  const rank = (p: PatientDiff): number => {
    if (p.presence === "both") return p.changedCount > 0 ? 0 : 3;
    if (p.presence === "added") return 1;
    return 2; // removed
  };
  patients.sort((x, y) => {
    const r = rank(x) - rank(y);
    if (r !== 0) return r;
    return x.name.localeCompare(y.name);
  });

  return {
    patients,
    changedPatientCount: patients.filter(
      (p) => (p.presence === "both" && p.changedCount > 0) || p.presence !== "both",
    ).length,
    addedCount: patients.filter((p) => p.presence === "added").length,
    removedCount: patients.filter((p) => p.presence === "removed").length,
  };
}
