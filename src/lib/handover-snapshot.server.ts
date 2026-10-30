// Server-only logic that captures a point-in-time snapshot of the live handover
// and stores it as a searchable version. Runs with the service-role client so it
// can be triggered by pg_cron (no user session) and always sees every patient.
//
// Never import this from a route or *.functions.ts module scope — it pulls in
// the admin client. Import it inside a handler with `await import(...)`.

import { getAdmin } from "@/lib/admin-db.server";
import {
  decideShiftGate,
  labelFor,
  type ShiftKey,
} from "@/lib/handover-shift";

export type { ShiftKey } from "@/lib/handover-shift";

// Mirrors the select used by listPatients so a saved version can be re-rendered
// into the exact same handover PDF later.
import { decryptPatientRows } from "@/lib/patient-crypto.server";
import { encryptField } from "@/lib/crypto.server";

const PATIENT_SELECT =
  "*, investigations(category, findings, result_at), microbiology_results(specimen_type, findings, result_at), patient_observations(id, patient_id, recorded_at, recorded_by, hr, sbp, dbp, map, spo2, fio2, rr, temp, gcs, lactate, vent_mode, peep, vt, vasopressor, vasopressor_dose, urine_ml, fluid_in_ml, fluid_out_ml, notes)";

function textField(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}


// Concatenate the fields a clinician might search old handovers by (patient
// identifiers plus the free-text clinical summary columns).
function buildSearchText(patients: Array<Record<string, unknown>>): string {
  const keys = [
    "full_name",
    "hospital_number",
    "ward",
    "bed",
    "location_type",
    "diagnosis",
    "current_admission",
    "current_management",
    "past_medical_history",
    "escalation_plan",
    "next_of_kin",
  ];
  const chunks: string[] = [];
  for (const p of patients) {
    for (const k of keys) {
      const val = textField(p[k]).trim();
      if (val) chunks.push(val);
    }
  }
  return chunks.join(" \u00b7 ").slice(0, 200000);
}

export type CaptureResult = {
  ok: boolean;
  captured: boolean;
  skipped?: string;
  shift?: ShiftKey;
  local_date?: string;
  patient_count?: number;
  id?: string;
};

// Capture the current active handover as a saved version.
//
// - `force: false` (scheduled): only captures when London local time is within
//   the 8am or 8pm handover hour, so an hourly cron produces exactly the two
//   intended versions per day.
// - `force: true` (admin "Capture now"): always captures, mapping to whichever
//   shift the current time is nearest.
//
// Re-runs for the same date+shift overwrite the existing row (idempotent), so a
// cron retry never creates duplicates.
export async function captureHandoverSnapshot(
  opts: { force?: boolean; now?: Date } = {},
): Promise<CaptureResult> {
  const now = opts.now ?? new Date();

  const decision = decideShiftGate(now, opts.force);
  const parts = decision.parts;
  if (!decision.capture) {
    return { ok: true, captured: false, skipped: decision.reason };
  }
  const shift: ShiftKey = decision.shift;


  const admin = await getAdmin();

  // One snapshot PER UNIT: a saved handover only ever contains the patients of
  // the unit it belongs to, so unit-scoped RLS on handover_unit_versions
  // decides who can list, count, search or open it.
  const { data: units, error: unitErr } = await admin.from("icu_units").select("id, code");
  if (unitErr) throw new Error(unitErr.message);

  const { data: patients, error } = await admin
    .from("patients")
    .select(PATIENT_SELECT)
    .in("status", ["admitted", "referred"])
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);

  // Snapshots are rendered later as PDFs, so store readable values — never
  // ciphertext — and never the fingerprint columns.
  const rows = decryptPatientRows(patients as Array<Record<string, unknown>> | null);
  const baseLabel = labelFor(parts, shift);
  let total = 0;
  let firstId: string | undefined;
  for (const unit of units ?? []) {
    const unitRows = rows.filter((r) => r["unit_id"] === unit.id);
    total += unitRows.length;
    const { data: inserted, error: upErr } = await admin
      .from("handover_unit_versions")
      .upsert(
        {
          unit_id: unit.id,
          local_date: parts.isoDate,
          shift,
          captured_at: now.toISOString(),
          label: unit.code ? `${unit.code} · ${baseLabel}` : baseLabel,
          patient_count: unitRows.length,
          snapshot: { enc: encryptField(JSON.stringify(unitRows)) } as unknown as never,
          search_text: encryptField(buildSearchText(unitRows)) ?? "",
          updated_at: now.toISOString(),
        },
        { onConflict: "local_date,shift,unit_id" },
      )
      .select("id")
      .single();
    if (upErr) throw new Error(upErr.message);
    firstId ??= inserted?.id as string | undefined;
  }
  const inserted = { id: firstId };
  const rowsCount = total;
  return {
    ok: true,
    captured: true,
    shift,
    local_date: parts.isoDate,
    patient_count: rowsCount,
    id: inserted?.id as string | undefined,
  };
}
