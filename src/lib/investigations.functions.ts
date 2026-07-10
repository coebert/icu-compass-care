import { createServerFn } from "@tanstack/react-start";
import { safeDbError } from "@/lib/db-error";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const investigationInput = z.object({
  patient_id: z.string().uuid(),
  category: z.string().trim().min(1).max(100),
  findings: z.string().trim().min(1).max(20000),
  result_at: z.string(),
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
        result_at: z.string(),
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
