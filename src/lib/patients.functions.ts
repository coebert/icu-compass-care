import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeDbError } from "@/lib/db-error";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { writeAudit, writePatientFieldChanges } from "@/lib/audit";
import {
  patientInput,
  clean,
  validatePatientState,
  type PatientStatus,
} from "@/lib/patient-schema";
import { getAdmin } from "@/lib/admin-db.server";
import { normalizeBed } from "@/lib/icu-beds";

// Reject bed collisions before writing so two active patients can't share a
// bed via the form, drag-and-drop, or the bridge write path. `excludeId` skips
// the patient being edited so re-saving their own row doesn't self-conflict.
async function assertBedFree(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  bed: string,
  excludeId: string | null,
): Promise<void> {
  const target = normalizeBed(bed);
  if (!target) return;
  let q = supabase
    .from("patients")
    .select("id, full_name, hospital_number")
    .eq("location_type", "icu")
    .in("status", ["admitted", "referred"])
    .ilike("bed", bed.trim());
  if (excludeId) q = q.neq("id", excludeId);
  const { data, error } = await q.limit(1);
  if (error) throw safeDbError(error);
  const other = data?.[0];
  if (other) {
    const who = other.full_name ?? other.hospital_number ?? "another patient";
    throw new Error(
      `Bed ${bed} is already occupied by ${who}. Move or discharge them first.`,
    );
  }
}

export const listPatients = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("patients")
      .select("*, investigations(category, findings, result_at), microbiology_results(specimen_type, findings, result_at), patient_observations(id, patient_id, recorded_at, recorded_by, hr, sbp, dbp, map, spo2, fio2, rr, temp, gcs, lactate, vent_mode, peep, vt, vasopressor, vasopressor_dose, urine_ml, fluid_in_ml, fluid_out_ml, notes)")
      .order("updated_at", { ascending: false });
    if (error) throw safeDbError(error);
    return data;
  });

export const getPatient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { data: patient, error } = await context.supabase
      .from("patients")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw safeDbError(error);
    return patient;
  });

export const createPatient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => patientInput.parse(input))
  .handler(async ({ context, data }) => {
    const cleaned = clean(data as Record<string, unknown>);
    validatePatientState(cleaned);
    const status = cleaned.status as string | undefined;
    const locType = cleaned.location_type as string | undefined;
    const bed = cleaned.bed as string | null | undefined;
    if (bed && locType === "icu" && (status === "admitted" || status === "referred")) {
      await assertBedFree(context.supabase, bed, null);
    }
    const { data: row, error } = await context.supabase
      .from("patients")
      .insert({ ...cleaned, created_by: context.userId, updated_by: context.userId } as never)
      .select()
      .single();
    if (error) throw safeDbError(error);
    const supabaseAdmin = await getAdmin();
    await writeAudit(supabaseAdmin, {
      entity: "patients",
      recordId: row.id,
      action: "insert",
      source: "app",
      actor: { id: context.userId, email: (context.claims.email as string) ?? null },
      after: row as Record<string, unknown>,
    });
    return row;
  });

export const updatePatient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({ id: z.string().uuid(), expected_updated_at: z.string().optional() })
      .and(patientInput.partial())
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { id, expected_updated_at, ...rest } = data as {
      id: string;
      expected_updated_at?: string;
    } & Record<string, unknown>;

    // Load current row for conflict detection + audit "before" snapshot.
    const { data: current, error: readErr } = await context.supabase
      .from("patients")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (readErr) throw safeDbError(readErr);
    if (!current) throw new Error("Patient not found");

    // Optimistic concurrency — block overwriting a newer change from either app.
    if (expected_updated_at && current.updated_at !== expected_updated_at) {
      throw new Error(
        "CONFLICT: This patient was updated by someone else (possibly the linked app). Reload to see the latest before saving.",
      );
    }

    // Validate the lifecycle transition + per-status required fields against
    // the effective row (current values overlaid with the incoming changes).
    const merged = { ...current, ...clean(rest) };
    validatePatientState(merged, current.status as PatientStatus);

    // After merging, reject moves that would put two active patients in the
    // same bed. Only enforce when the effective row is an active ICU occupant.
    const mBed = merged.bed as string | null | undefined;
    if (
      mBed &&
      merged.location_type === "icu" &&
      (merged.status === "admitted" || merged.status === "referred")
    ) {
      await assertBedFree(context.supabase, mBed, id);
    }

    const { data: row, error } = await context.supabase
      .from("patients")
      .update({ ...clean(rest), updated_by: context.userId } as never)
      .eq("id", id)
      .select()
      .single();
    if (error) throw safeDbError(error);

    const supabaseAdmin = await getAdmin();
    const actor = { id: context.userId, email: (context.claims.email as string) ?? null };
    await writeAudit(supabaseAdmin, {
      entity: "patients",
      recordId: row.id,
      action: "update",
      source: "app",
      actor,
      before: current as Record<string, unknown>,
      after: row as Record<string, unknown>,
    });
    await writePatientFieldChanges(supabaseAdmin, {
      patientId: row.id,
      before: current as Record<string, unknown>,
      after: row as Record<string, unknown>,
      actor,
    });
    return row;
  });

export const deletePatient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { data: current } = await context.supabase
      .from("patients")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    const { error } = await context.supabase.from("patients").delete().eq("id", data.id);
    if (error) throw safeDbError(error);
    const supabaseAdmin = await getAdmin();
    await writeAudit(supabaseAdmin, {
      entity: "patients",
      recordId: data.id,
      action: "delete",
      source: "app",
      actor: { id: context.userId, email: (context.claims.email as string) ?? null },
      before: (current ?? undefined) as Record<string, unknown> | undefined,
    });
    return { ok: true };
  });

// Audit history for a patient record (most recent first).
export const getPatientAudit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("record_audit")
      .select("*")
      .eq("entity", "patients")
      .eq("record_id", data.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw safeDbError(error);
    return rows ?? [];
  });

// Field-level change history (initials / age / hospital number), most recent first.
export const getPatientFieldChanges = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("patient_field_changes")
      .select("*")
      .eq("patient_id", data.id)
      .order("changed_at", { ascending: false })
      .limit(100);
    if (error) throw safeDbError(error);
    return rows ?? [];
  });

// Unit-wide recent field changes across every patient, for the dashboard
// "what changed" ribbon. Most recent first.
export const listRecentFieldChanges = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: rows, error } = await context.supabase
      .from("patient_field_changes")
      .select("id, patient_id, field_name, changed_at, changed_by_email")
      .order("changed_at", { ascending: false })
      .limit(60);
    if (error) throw safeDbError(error);
    return rows ?? [];
  });


// Status-change history for the Timeline, showing who made each change.
// record_audit is admin-only via RLS, so this reads through the service-role
// client, but stays gated behind requireSupabaseAuth (any signed-in clinician
// may view the shared patient record's status history).
export type PatientStatusChange = {
  id: string;
  at: string | null;
  from: string | null;
  to: string | null;
  changedBy: string | null;
};

export const getPatientStatusChanges = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }): Promise<PatientStatusChange[]> => {
    const supabaseAdmin = await getAdmin();
    const { data: rows, error } = await supabaseAdmin
      .from("record_audit")
      .select("id, created_at, before, after, changed_fields, actor_id, actor_email")
      .eq("entity", "patients")
      .eq("record_id", data.id)
      .eq("action", "update")
      .contains("changed_fields", ["status"])
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw safeDbError(error);

    const list = rows ?? [];
    const actorIds = Array.from(
      new Set(list.map((r) => r.actor_id).filter((v): v is string => !!v)),
    );
    const names = new Map<string, string>();
    if (actorIds.length > 0) {
      const { data: profiles } = await supabaseAdmin
        .from("profiles")
        .select("id, display_name, full_name")
        .in("id", actorIds);
      for (const p of profiles ?? []) {
        const label = (p.full_name || p.display_name || "").trim();
        if (label) names.set(p.id, label);
      }
    }

    return list.map((r) => {
      const before = (r.before ?? {}) as Record<string, unknown>;
      const after = (r.after ?? {}) as Record<string, unknown>;
      const changedBy =
        (r.actor_id && names.get(r.actor_id)) || r.actor_email || null;
      return {
        id: r.id as string,
        at: (r.created_at as string) ?? null,
        from: (before.status as string) ?? null,
        to: (after.status as string) ?? null,
        changedBy,
      };
    });
  });

// Distinct antimicrobial agent names previously entered across all patients,
// offered as suggestions when recording/editing an antimicrobial course.
export const listAntimicrobialNames = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [{ data, error }, library] = await Promise.all([
      context.supabase.from("patients").select("antimicrobials"),
      context.supabase.from("antimicrobial_library").select("name"),
    ]);
    if (error) throw safeDbError(error);
    if (library.error) throw safeDbError(library.error);
    // De-duplicate case-insensitively (first spelling seen wins) so the
    // library's canonical spellings and any patient-entered names combine into
    // a single suggestion list without casing duplicates.
    const byLower = new Map<string, string>();
    const add = (name: unknown) => {
      if (typeof name === "string" && name.trim()) {
        const trimmed = name.trim();
        const key = trimmed.toLowerCase();
        if (!byLower.has(key)) byLower.set(key, trimmed);
      }
    };
    for (const row of library.data ?? []) add((row as { name?: unknown }).name);
    for (const row of data ?? []) {
      const list = (row as { antimicrobials?: unknown }).antimicrobials;
      if (!Array.isArray(list)) continue;
      for (const a of list) add((a as { name?: unknown })?.name);
    }
    return Array.from(byLower.values()).sort((a, b) => a.localeCompare(b));
  });

// Look up previous critical care admissions for the same person when a new
// patient is being added. Matched by hospital number (preferred) or by
// initials + age when no MRN is available. Returns discharged/died records
// only — an active admission with the same MRN is a data-entry error, not a
// readmission, and we surface that through the normal patient list.
export const findPreviousAdmissions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        hospital_number: z.string().trim().optional(),
        full_name: z.string().trim().optional(),
        age: z.union([z.string(), z.number()]).optional(),
        exclude_id: z.string().uuid().optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const mrn = data.hospital_number?.trim();
    const name = data.full_name?.trim();
    const age =
      typeof data.age === "number"
        ? data.age
        : typeof data.age === "string" && data.age.trim() !== ""
          ? Number(data.age)
          : null;

    // Need at least an MRN, or (initials + age) — otherwise the match would
    // be too broad and could surface unrelated patients.
    if (!mrn && !(name && age != null && Number.isFinite(age))) return [];

    let query = context.supabase
      .from("patients")
      .select(
        "id, full_name, hospital_number, age, status, admission_date, discharge_date, discharge_destination, date_of_death, past_medical_history, allergies, tep_in_place, tep_details, tep_exclusions, dnacpr_decision, dnacpr_details, dnacpr_date, updated_at",
      )
      .in("status", ["discharged", "died"])
      .order("updated_at", { ascending: false })
      .limit(5);

    if (mrn) {
      query = query.ilike("hospital_number", mrn);
    } else if (name && age != null) {
      query = query.ilike("full_name", name).eq("age", age);
    }
    if (data.exclude_id) query = query.neq("id", data.exclude_id);

    const { data: rows, error } = await query;
    if (error) throw safeDbError(error);
    return rows ?? [];
  });



