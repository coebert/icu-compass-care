import { createServerFn } from "@tanstack/react-start";
import { safeDbError } from "@/lib/db-error";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { zTimestamp } from "@/lib/datetime";

export const PATIENT_EVENT_TYPES = [
  "Surgical procedure",
  "Intubation",
  "Extubation",
  "Deterioration",
  "Tracheostomy",
  "Line insertion",
  "Cardiac arrest",
  "Transfer",
  "Antibiotics",
  "Other",
] as const;

const eventInput = z.object({
  patient_id: z.string().uuid(),
  event_type: z.string().trim().min(1).max(100),
  description: z.string().trim().max(20000).optional().nullable(),
  event_at: zTimestamp,
});

export const listPatientEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patientId: string }) =>
    z.object({ patientId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("patient_events")
      .select("*")
      .eq("patient_id", data.patientId)
      .order("event_at", { ascending: false });
    if (error) throw safeDbError(error);
    return rows;
  });

export const addPatientEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => eventInput.parse(input))
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("patient_events")
      .insert({
        ...data,
        description: data.description || null,
        created_by: context.userId,
      } as never)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const updatePatientEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        event_type: z.string().trim().min(1).max(100),
        description: z.string().trim().max(20000).optional().nullable(),
        event_at: zTimestamp,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { id, ...rest } = data;
    const { data: row, error } = await context.supabase
      .from("patient_events")
      .update({ ...rest, description: rest.description || null } as never)
      .eq("id", id)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const deletePatientEvent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("patient_events").delete().eq("id", data.id);
    if (error) throw safeDbError(error);
    return { ok: true };
  });
