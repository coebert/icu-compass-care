import { createServerFn } from "@tanstack/react-start";
import { safeDbError } from "@/lib/db-error";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const LINE_TYPES = [
  "central_venous_catheter",
  "arterial_line",
  "peripheral_cannula",
  "vascath",
  "picc",
  "midline",
  "urinary_catheter",
  "ng_tube",
  "chest_drain",
  "surgical_drain",
  "epidural",
  "tracheostomy",
  "ett",
  "other",
] as const;
export type LineType = (typeof LINE_TYPES)[number];

export const LINE_TYPE_LABEL: Record<LineType, string> = {
  central_venous_catheter: "Central venous catheter",
  arterial_line: "Arterial line",
  peripheral_cannula: "Peripheral cannula",
  vascath: "Vascath / dialysis line",
  picc: "PICC",
  midline: "Midline",
  urinary_catheter: "Urinary catheter",
  ng_tube: "NG / OG tube",
  chest_drain: "Chest drain",
  surgical_drain: "Surgical drain",
  epidural: "Epidural",
  tracheostomy: "Tracheostomy",
  ett: "Endotracheal tube",
  other: "Other",
};

// Recommended maximum dwell (days) before review/replacement per device type.
export const LINE_REVIEW_DAYS: Partial<Record<LineType, number>> = {
  central_venous_catheter: 7,
  arterial_line: 7,
  peripheral_cannula: 3,
  vascath: 21,
  urinary_catheter: 28,
  ng_tube: 30,
  chest_drain: 14,
};

export const LINE_STATUSES = ["in_situ", "removed"] as const;
export type LineStatus = (typeof LINE_STATUSES)[number];

export const listPatientLines = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patientId: string }) =>
    z.object({ patientId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("patient_lines")
      .select("*")
      .eq("patient_id", data.patientId)
      .order("status", { ascending: true })
      .order("inserted_on", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false });
    if (error) throw safeDbError(error);
    return rows ?? [];
  });

// All in-situ lines across every patient, for the infection-surveillance view.
export const listInSituLines = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: rows, error } = await context.supabase
      .from("patient_lines")
      .select("id, patient_id, device_type, site, laterality, inserted_on, inserted_in_unit")
      .eq("status", "in_situ")
      .order("inserted_on", { ascending: true, nullsFirst: false });
    if (error) throw safeDbError(error);
    return rows ?? [];
  });

const lineInput = {
  device_type: z.enum(LINE_TYPES),
  site: z.string().trim().max(200).nullish(),
  laterality: z.string().trim().max(40).nullish(),
  size: z.string().trim().max(60).nullish(),
  inserted_on: z.string().date().nullish(),
  removed_on: z.string().date().nullish(),
  status: z.enum(LINE_STATUSES).optional(),
  inserted_in_unit: z.boolean().optional(),
  indication: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(2000).nullish(),
};

export const addPatientLine = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ patient_id: z.string().uuid(), ...lineInput }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("patient_lines")
      .insert({
        patient_id: data.patient_id,
        device_type: data.device_type,
        site: data.site ?? null,
        laterality: data.laterality ?? null,
        size: data.size ?? null,
        inserted_on: data.inserted_on ?? null,
        removed_on: data.removed_on ?? null,
        status: data.status ?? "in_situ",
        inserted_in_unit: data.inserted_in_unit ?? true,
        indication: data.indication ?? null,
        notes: data.notes ?? null,
        created_by: context.userId,
      } as never)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const updatePatientLine = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ id: z.string().uuid() }).extend(lineInput).partial({ device_type: true }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { id, ...rest } = data;
    const { data: row, error } = await context.supabase
      .from("patient_lines")
      .update(rest as never)
      .eq("id", id)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const removePatientLine = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({ id: z.string().uuid(), removed_on: z.string().date().nullish() })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("patient_lines")
      .update({
        status: "removed",
        removed_on: data.removed_on ?? new Date().toISOString().slice(0, 10),
      } as never)
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const deletePatientLine = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("patient_lines").delete().eq("id", data.id);
    if (error) throw safeDbError(error);
    return { ok: true };
  });
