import { createServerFn } from "@tanstack/react-start";
import { safeDbError } from "@/lib/db-error";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { writeAudit, writePatientFieldChanges } from "@/lib/audit";

// Age must be a real number within a plausible clinical range; empty/null is rejected.
const ageSchema = z
  .union([z.number(), z.string().trim().min(1)], {
    errorMap: () => ({ message: "Age is required" }),
  })
  .pipe(
    z.coerce
      .number({ invalid_type_error: "Age must be a valid number" })
      .int("Age must be a whole number")
      .min(0, "Age must be 0 or greater")
      .max(130, "Age must be 130 or less"),
  );

const patientInput = z.object({
  full_name: z.string().trim().min(1).max(10),
  hospital_number: z.string().trim().max(50).optional().nullable(),
  age: ageSchema,
  location_type: z.enum(["icu", "outlier"]),
  ward: z.string().trim().max(100).optional().nullable(),
  bed: z.string().trim().max(50).optional().nullable(),
  status: z.enum(["referred", "admitted", "discharged", "died"]),
  admission_date: z.string().optional().nullable(),
  discharge_date: z.string().optional().nullable(),
  discharge_destination: z.string().trim().max(300).optional().nullable(),
  date_of_death: z.string().optional().nullable(),
  past_medical_history: z.string().max(10000).optional().nullable(),
  current_admission: z.string().max(10000).optional().nullable(),
  current_management: z.string().max(10000).optional().nullable(),
  outstanding_tasks: z.string().max(10000).optional().nullable(),
  systems_resp: z.string().max(10000).optional().nullable(),
  airway_type: z.string().max(20).optional().nullable(),
  resp_support: z.array(z.string().max(20)).max(10).optional(),
  systems_cvs: z.string().max(10000).optional().nullable(),
  vasoactive_agents: z.array(z.string().max(20)).max(10).optional(),
  systems_neuro: z.string().max(10000).optional().nullable(),
  systems_renal: z.string().max(10000).optional().nullable(),
  systems_gastro: z.string().max(10000).optional().nullable(),
  systems_haem: z.string().max(10000).optional().nullable(),
  systems_micro: z.string().max(10000).optional().nullable(),
  systems_other: z.string().max(10000).optional().nullable(),
  isolation_required: z.boolean(),
  tep_in_place: z.boolean(),
  tep_details: z.string().max(10000).optional().nullable(),
  dnacpr_decision: z.boolean(),
  dnacpr_details: z.string().max(10000).optional().nullable(),
  dnacpr_date: z.string().optional().nullable(),
  nok_name: z.string().trim().max(200).optional().nullable(),
  nok_relationship: z.string().trim().max(100).optional().nullable(),
  nok_contact: z.string().trim().max(200).optional().nullable(),
  nok_last_updated: z.string().optional().nullable(),
  nok_last_updated_by: z.string().trim().max(200).optional().nullable(),
});

// Normalise empty strings to null for date/optional fields
function clean(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = v === "" ? null : v;
  }
  return out;
}

type PatientStatus = "referred" | "admitted" | "discharged" | "died";

// Allowed forward transitions between clinical statuses. Staying on the same
// status is always allowed (it lets staff edit other fields without changing
// the lifecycle). "discharged" and "died" are terminal — records are retained
// and stay editable, but the status cannot move to a different value.
const ALLOWED_TRANSITIONS: Record<PatientStatus, PatientStatus[]> = {
  referred: ["admitted", "discharged", "died"],
  admitted: ["discharged", "died"],
  discharged: [],
  died: [],
};

const STATUS_LABEL: Record<PatientStatus, string> = {
  referred: "Referred",
  admitted: "Admitted",
  discharged: "Discharged",
  died: "Died",
};

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

// Server-side guard for status lifecycle + per-status required fields.
// `merged` is the full effective row after the write (current row overlaid with
// the incoming changes for updates, or the incoming payload for creates).
// `previousStatus` is the status before this write (undefined on create).
function validatePatientState(
  merged: Record<string, unknown>,
  previousStatus?: PatientStatus,
) {
  const next = merged.status as PatientStatus | undefined;
  if (!next || !(next in ALLOWED_TRANSITIONS)) {
    throw new Error("A valid patient status is required.");
  }

  // Transition legality (only checked when the status actually changes).
  if (previousStatus && previousStatus !== next) {
    const allowed = ALLOWED_TRANSITIONS[previousStatus] ?? [];
    if (!allowed.includes(next)) {
      const options =
        allowed.length > 0
          ? allowed.map((s) => STATUS_LABEL[s]).join(" or ")
          : "no further status changes";
      throw new Error(
        `Invalid status change: a ${STATUS_LABEL[previousStatus]} patient cannot become ${STATUS_LABEL[next]} (allowed: ${options}).`,
      );
    }
  }

  // Per-status required fields.
  if (next === "discharged") {
    if (isBlank(merged.discharge_destination)) {
      throw new Error("A discharge destination is required to mark a patient as discharged.");
    }
    if (isBlank(merged.discharge_date)) {
      throw new Error("A discharge date is required to mark a patient as discharged.");
    }
  }
  if (next === "died") {
    if (isBlank(merged.date_of_death)) {
      throw new Error("A date of death is required to mark a patient as died.");
    }
  }
}


export const listPatients = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("patients")
      .select("*, investigations(category, findings, result_at), microbiology_results(specimen_type, findings, result_at)")
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
    validatePatientState(clean(data as Record<string, unknown>));
    const { data: row, error } = await context.supabase
      .from("patients")
      .insert({ ...clean(data as Record<string, unknown>), created_by: context.userId, updated_by: context.userId } as never)
      .select()
      .single();
    if (error) throw safeDbError(error);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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

    const { data: row, error } = await context.supabase
      .from("patients")
      .update({ ...clean(rest), updated_by: context.userId } as never)
      .eq("id", id)
      .select()
      .single();
    if (error) throw safeDbError(error);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
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
