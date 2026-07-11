import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeDbError } from "@/lib/db-error";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const OBS_COLUMNS =
  "id, patient_id, recorded_at, recorded_by, hr, sbp, dbp, map, spo2, fio2, rr, temp, gcs, lactate, vent_mode, peep, vt, vasopressor, vasopressor_dose, urine_ml, fluid_in_ml, fluid_out_ml, notes";

const numField = z.number().finite().nullish();
const intField = z.number().int().nullish();

export const listObservations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patientId: string }) =>
    z.object({ patientId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("patient_observations")
      .select(OBS_COLUMNS)
      .eq("patient_id", data.patientId)
      .order("recorded_at", { ascending: false })
      .limit(200);
    if (error) throw safeDbError(error);
    return rows ?? [];
  });

// Latest observation per patient — for the board / unit acuity badges.
export const listLatestObservations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: rows, error } = await context.supabase
      .from("patient_observations")
      .select(OBS_COLUMNS)
      .order("recorded_at", { ascending: false })
      .limit(1000);
    if (error) throw safeDbError(error);
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows ?? []) {
      if (!latest.has(r.patient_id)) latest.set(r.patient_id, r);
    }
    return Array.from(latest.values());
  });

const observationInput = z.object({
  recorded_at: z.string().datetime().optional(),
  hr: intField,
  sbp: intField,
  dbp: intField,
  map: intField,
  spo2: intField,
  fio2: numField,
  rr: intField,
  temp: numField,
  gcs: intField,
  lactate: numField,
  vent_mode: z.string().trim().max(60).nullish(),
  peep: intField,
  vt: intField,
  vasopressor: z.string().trim().max(60).nullish(),
  vasopressor_dose: numField,
  urine_ml: intField,
  fluid_in_ml: intField,
  fluid_out_ml: intField,
  notes: z.string().trim().max(2000).nullish(),
});

export const addObservation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    observationInput.extend({ patient_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("patient_observations")
      .insert({ ...data, recorded_by: context.userId } as never)
      .select(OBS_COLUMNS)
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const deleteObservation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("patient_observations")
      .delete()
      .eq("id", data.id);
    if (error) throw safeDbError(error);
    return { ok: true };
  });
