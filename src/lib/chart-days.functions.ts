import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeDbError } from "@/lib/db-error";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const HOURLY_COLUMNS =
  "chart_day_id, hour, intake_ml, flushes_ml, ng_aspirate_ml, ng_free_ml, urine_ml, bowels, target_removal_ml, actual_removal_ml, hourly_balance_ml, cumulative_balance_ml, hr, sbp, dbp, map, cvp, spo2, etco2, rr, temp, gcs, cam_icu, pupils_l, pupils_r, vent_mode, peep, fio2, p_support, tv, mv, peak_pressure, updated_at";

const num = z.number().finite().nullish();
const intN = z.number().int().nullish();
const str = z.string().trim().max(200).nullish();

export const hourlyCellSchema = z.object({
  intake_ml: intN,
  flushes_ml: intN,
  ng_aspirate_ml: intN,
  ng_free_ml: intN,
  urine_ml: intN,
  bowels: str,
  target_removal_ml: intN,
  actual_removal_ml: intN,
  hourly_balance_ml: intN,
  cumulative_balance_ml: intN,
  hr: intN,
  sbp: intN,
  dbp: intN,
  map: intN,
  cvp: intN,
  spo2: intN,
  etco2: intN,
  rr: intN,
  temp: num,
  gcs: intN,
  cam_icu: str,
  pupils_l: str,
  pupils_r: str,
  vent_mode: str,
  peep: intN,
  fio2: num,
  p_support: intN,
  tv: intN,
  mv: num,
  peak_pressure: intN,
});

export type HourlyCell = z.infer<typeof hourlyCellSchema>;

export const listChartDays = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patientId: string }) =>
    z.object({ patientId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("chart_days")
      .select("id, patient_id, chart_date, source, notes, balance_24h_ml, created_at, updated_at")
      .eq("patient_id", data.patientId)
      .order("chart_date", { ascending: false })
      .limit(120);
    if (error) throw safeDbError(error);
    return rows ?? [];
  });

export const getChartDay = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patientId: string; chartDate: string }) =>
    z.object({ patientId: z.string().uuid(), chartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: day, error } = await context.supabase
      .from("chart_days")
      .select("id, patient_id, chart_date, source, notes, balance_24h_ml, created_at, updated_at")
      .eq("patient_id", data.patientId)
      .eq("chart_date", data.chartDate)
      .maybeSingle();
    if (error) throw safeDbError(error);
    if (!day) return { day: null, hourly: [] as never[] };
    const { data: hourly, error: he } = await context.supabase
      .from("chart_hourly")
      .select(HOURLY_COLUMNS)
      .eq("chart_day_id", day.id)
      .order("hour", { ascending: true });
    if (he) throw safeDbError(he);
    return { day, hourly: hourly ?? [] };
  });

export const ensureChartDay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patientId: string; chartDate: string; source?: "scan" | "manual" }) =>
    z
      .object({
        patientId: z.string().uuid(),
        chartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        source: z.enum(["scan", "manual"]).optional(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const existing = await context.supabase
      .from("chart_days")
      .select("id")
      .eq("patient_id", data.patientId)
      .eq("chart_date", data.chartDate)
      .maybeSingle();
    if (existing.data) return { id: existing.data.id };
    const { data: row, error } = await context.supabase
      .from("chart_days")
      .insert({
        patient_id: data.patientId,
        chart_date: data.chartDate,
        source: data.source ?? "manual",
        created_by: context.userId,
      } as never)
      .select("id")
      .single();
    if (error) throw safeDbError(error);
    return { id: row.id };
  });

export const upsertHourlyCell = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { chartDayId: string; hour: number; patch: HourlyCell }) =>
    z
      .object({
        chartDayId: z.string().uuid(),
        hour: z.number().int().min(0).max(23),
        patch: hourlyCellSchema,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("chart_hourly")
      .upsert(
        { chart_day_id: data.chartDayId, hour: data.hour, ...data.patch } as never,
        { onConflict: "chart_day_id,hour" },
      )
      .select(HOURLY_COLUMNS)
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const updateChartDay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; notes?: string | null; balance_24h_ml?: number | null }) =>
    z
      .object({
        id: z.string().uuid(),
        notes: z.string().max(4000).nullish(),
        balance_24h_ml: z.number().int().nullish(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { id, ...rest } = data;
    const { error } = await context.supabase.from("chart_days").update(rest as never).eq("id", id);
    if (error) throw safeDbError(error);
    return { ok: true };
  });

export const deleteChartDay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("chart_days").delete().eq("id", data.id);
    if (error) throw safeDbError(error);
    return { ok: true };
  });
