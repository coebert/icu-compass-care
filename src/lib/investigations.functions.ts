import { createServerFn } from "@tanstack/react-start";
import { safeDbError } from "@/lib/db-error";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { zTimestamp } from "@/lib/datetime";

const investigationInput = z.object({
  patient_id: z.string().uuid(),
  category: z.string().trim().min(1).max(100),
  findings: z.string().trim().min(1).max(20000),
  result_at: zTimestamp,
});

export const listInvestigations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patientId: string }) =>
    z.object({ patientId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("investigations")
      .select("*")
      .eq("patient_id", data.patientId)
      .order("result_at", { ascending: false });
    if (error) throw safeDbError(error);
    return rows;
  });

// Categories surfaced as quick-glance fields on the bed board hover summary.
export const QUICK_GLANCE_CATEGORIES = ["Bloods", "CXR", "CT chest"] as const;

// Latest investigation per patient for each quick-glance category — powers the
// bed board hover summary without an N+1 fetch per card.
export const listLatestKeyInvestigations = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: rows, error } = await context.supabase
      .from("investigations")
      .select("id, patient_id, category, findings, result_at")
      .in("category", QUICK_GLANCE_CATEGORIES as unknown as string[])
      .order("result_at", { ascending: false })
      .limit(2000);
    if (error) throw safeDbError(error);
    // Keep only the most recent row per (patient, category).
    const seen = new Set<string>();
    const latest: NonNullable<typeof rows> = [];
    for (const r of rows ?? []) {
      const key = `${r.patient_id}::${r.category}`;
      if (seen.has(key)) continue;
      seen.add(key);
      latest.push(r);
    }
    return latest;
  });

export const addInvestigation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => investigationInput.parse(input))
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("investigations")
      .insert({ ...data, created_by: context.userId } as never)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const updateInvestigation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        category: z.string().trim().min(1).max(100),
        findings: z.string().trim().min(1).max(20000),
        result_at: zTimestamp,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { id, ...rest } = data;
    const { data: row, error } = await context.supabase
      .from("investigations")
      .update(rest as never)
      .eq("id", id)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const deleteInvestigation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("investigations").delete().eq("id", data.id);
    if (error) throw safeDbError(error);
    return { ok: true };
  });
