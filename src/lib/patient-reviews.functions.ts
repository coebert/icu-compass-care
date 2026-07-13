import { createServerFn } from "@tanstack/react-start";
import { safeDbError } from "@/lib/db-error";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { zTimestamp } from "@/lib/datetime";

export const REVIEW_SPECIALTIES = [
  "General surgery",
  "Neurology",
  "Neurosurgery",
  "Plastic surgery",
  "Cardiology",
  "Respiratory",
  "Renal",
  "Gastroenterology",
  "Haematology",
  "Microbiology / ID",
  "Vascular surgery",
  "Orthopaedics",
  "ENT",
  "Urology",
  "Endocrinology",
  "Palliative care",
  "Other",
] as const;

const reviewInput = z.object({
  patient_id: z.string().uuid(),
  specialty: z.string().trim().min(1).max(100),
  review: z.string().trim().max(20000).optional().nullable(),
  plan: z.string().trim().max(20000).optional().nullable(),
  reviewed_at: zTimestamp,
});

export const listPatientReviews = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patientId: string }) =>
    z.object({ patientId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("patient_reviews")
      .select("*")
      .eq("patient_id", data.patientId)
      .order("reviewed_at", { ascending: false });
    if (error) throw safeDbError(error);
    return rows;
  });

export const addPatientReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => reviewInput.parse(input))
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("patient_reviews")
      .insert({
        ...data,
        review: data.review || null,
        plan: data.plan || null,
        created_by: context.userId,
      } as never)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const updatePatientReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        specialty: z.string().trim().min(1).max(100),
        review: z.string().trim().max(20000).optional().nullable(),
        plan: z.string().trim().max(20000).optional().nullable(),
        reviewed_at: zTimestamp,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { id, ...rest } = data;
    const { data: row, error } = await context.supabase
      .from("patient_reviews")
      .update({ ...rest, review: rest.review || null, plan: rest.plan || null } as never)
      .eq("id", id)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const deletePatientReview = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("patient_reviews").delete().eq("id", data.id);
    if (error) throw safeDbError(error);
    return { ok: true };
  });
