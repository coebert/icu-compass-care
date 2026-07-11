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
