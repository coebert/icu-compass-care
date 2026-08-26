// Client-safe audit helper. No server-only imports so it can be referenced
// from server-function modules that are part of the client module graph.
// It is only ever CALLED inside server handlers, with a Supabase client passed in.

import { formatBmiSummary, computeIbw, formatIbwValue } from "@/lib/patient-schema";

function formatIbwAudit(heightM: unknown, sex: unknown): string | null {
  const ibw = computeIbw(heightM, sex);
  if (ibw == null) return null;
  const s = typeof sex === "string" && (sex === "male" || sex === "female") ? sex : "averaged";
  return `${formatIbwValue(ibw)} kg (Devine, ${s})`;
}

export type AuditEntity = "patients" | "investigations" | "referrals" | "microbiology";
export type AuditAction = "insert" | "update" | "delete";
export type AuditSource = "app" | "bridge";

export type AuditActor = {
  id?: string | null;
  role?: string | null;
  email?: string | null;
};

// Fields that never count as a meaningful change.
const IGNORED = new Set(["updated_at", "created_at", "updated_by", "created_by", "id"]);

export function diffFields(
  before: Record<string, unknown> | null | undefined,
  after: Record<string, unknown> | null | undefined,
): string[] {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const k of keys) {
    if (IGNORED.has(k)) continue;
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null)) changed.push(k);
  }
  return changed;
}

// Accept any Supabase-like client (browser or admin); the shapes differ
// structurally but both support .from(table).insert(values).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MinimalClient = any;

export async function writeAudit(
  client: MinimalClient,
  params: {
    entity: AuditEntity;
    recordId: string;
    action: AuditAction;
    source: AuditSource;
    actor: AuditActor;
    before?: Record<string, unknown> | null;
    after?: Record<string, unknown> | null;
    // Encrypted columns cannot be diffed byte-wise (each write gets a fresh
    // nonce), so callers holding the readable values pass the field list in.
    changedFields?: string[];
  },
): Promise<void> {
  const changed =
    params.changedFields ??
    (params.action === "update" ? diffFields(params.before, params.after) : []);
  try {
    await client.from("record_audit").insert({
      entity: params.entity,
      record_id: params.recordId,
      action: params.action,
      source: params.source,
      actor_id: params.actor.id ?? null,
      actor_role: params.actor.role ?? null,
      actor_email: params.actor.email ?? null,
      changed_fields: changed,
      before: params.before ?? null,
      after: params.after ?? null,
    });
  } catch {
    // best-effort; auditing must never break the primary operation
  }
}

// Field-level auditing for a defined set of patient columns. Each changed field
// produces its own row capturing old/new value, the editing user, and a timestamp.
const TRACKED_PATIENT_FIELDS: { column: string; label: string }[] = [
  // Demographics — surfaced in the Demographics tab's edit history.
  { column: "full_name", label: "initials" },
  { column: "age", label: "age" },
  { column: "sex", label: "sex" },
  { column: "hospital_number", label: "hospital_number" },
  { column: "weight_kg", label: "weight_kg" },
  { column: "height_m", label: "height_m" },
  { column: "location_type", label: "location_type" },
  { column: "ward", label: "ward" },
  { column: "bed", label: "bed" },
  { column: "status", label: "status" },
  { column: "admission_date", label: "admission_date" },
  { column: "discharge_date", label: "discharge_date" },
  { column: "discharge_destination", label: "discharge_destination" },
  { column: "date_of_death", label: "date_of_death" },
  { column: "nok_name", label: "nok_name" },
  { column: "nok_relationship", label: "nok_relationship" },
  { column: "nok_contact", label: "nok_contact" },
  { column: "nok_last_updated_by", label: "nok_last_updated_by" },
  // Clinical fields — surfaced in the "what changed" ribbon for the incoming team.
  { column: "current_admission", label: "current_admission" },
  { column: "current_management", label: "current_management" },
  { column: "past_medical_history", label: "past_medical_history" },
  { column: "dnacpr_decision", label: "dnacpr_decision" },
  { column: "dnacpr_details", label: "dnacpr_details" },
  { column: "tep_in_place", label: "tep_in_place" },
  { column: "tep_details", label: "tep_details" },
  { column: "isolation_required", label: "isolation_required" },
  { column: "airway_type", label: "airway_type" },
  { column: "nutrition_route", label: "nutrition_route" },
  { column: "systems_resp", label: "systems_resp" },
  { column: "resp_fio2", label: "resp_fio2" },
  { column: "systems_cvs", label: "systems_cvs" },
  { column: "systems_neuro", label: "systems_neuro" },
  { column: "systems_renal", label: "systems_renal" },
  { column: "systems_gastro", label: "systems_gastro" },
  { column: "systems_micro", label: "systems_micro" },
  { column: "systems_haem", label: "systems_haem" },
  { column: "systems_other", label: "systems_other" },
];


function toStr(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

export async function writePatientFieldChanges(
  client: MinimalClient,
  params: {
    patientId: string;
    before: Record<string, unknown> | null | undefined;
    after: Record<string, unknown> | null | undefined;
    actor: AuditActor;
    // Optional sealing hook: values of `sealedColumns` are stored encrypted so
    // the audit trail never becomes a readable copy of the clinical record.
    sealValue?: (value: string | null) => string | null;
    sealedColumns?: ReadonlySet<string>;
  },
): Promise<void> {
  const { before, after } = params;
  const seal = (column: string, value: string | null): string | null =>
    params.sealValue && params.sealedColumns?.has(column) ? params.sealValue(value) : value;
  if (!before || !after) return;
  const rows = TRACKED_PATIENT_FIELDS.flatMap(({ column, label }) => {
    const oldVal = toStr(before[column]);
    const newVal = toStr(after[column]);
    if (oldVal === newVal) return [];
    return [
      {
        patient_id: params.patientId,
        field_name: label,
        old_value: seal(column, oldVal),
        new_value: seal(column, newVal),
        changed_by: params.actor.id ?? null,
        changed_by_email: params.actor.email ?? null,
      },
    ];
  });
  // Synthesize a derived BMI row when weight or height changed, so the
  // Demographics edit history shows the resulting BMI + WHO category change
  // alongside the raw weight/height entries.
  if (before.weight_kg !== after.weight_kg || before.height_m !== after.height_m) {
    const oldBmi = formatBmiSummary(before.weight_kg, before.height_m);
    const newBmi = formatBmiSummary(after.weight_kg, after.height_m);
    if (oldBmi !== newBmi) {
      rows.push({
        patient_id: params.patientId,
        field_name: "bmi",
        old_value: oldBmi,
        new_value: newBmi,
        changed_by: params.actor.id ?? null,
        changed_by_email: params.actor.email ?? null,
      });
    }
  }
  // Synthesize a derived IBW row when height or sex changed, so the
  // Demographics edit history captures the resulting Devine ideal body
  // weight (used for ventilator tidal-volume estimates) alongside the raw
  // height/sex entries.
  if (before.height_m !== after.height_m || before.sex !== after.sex) {
    const oldIbw = formatIbwAudit(before.height_m, before.sex);
    const newIbw = formatIbwAudit(after.height_m, after.sex);
    if (oldIbw !== newIbw) {
      rows.push({
        patient_id: params.patientId,
        field_name: "ibw",
        old_value: oldIbw,
        new_value: newIbw,
        changed_by: params.actor.id ?? null,
        changed_by_email: params.actor.email ?? null,
      });
    }
  }
  if (rows.length === 0) return;
  try {
    await client.from("patient_field_changes").insert(rows);
  } catch {
    // best-effort; auditing must never break the primary operation
  }
}
