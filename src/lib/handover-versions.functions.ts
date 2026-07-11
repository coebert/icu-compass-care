import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeDbError } from "@/lib/db-error";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertAdmin } from "@/lib/roles.server";

export type HandoverVersionSummary = {
  id: string;
  local_date: string;
  shift: "am" | "pm";
  captured_at: string;
  label: string;
  patient_count: number;
};

// Browse saved handover versions, newest first. Supports free-text / patient
// search over the stored search_text plus date-range and shift filters.
export const listHandoverVersions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { q?: string; from?: string; to?: string; shift?: string }) =>
    z
      .object({
        q: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        shift: z.string().optional(),
      })
      .parse(input ?? {}),
  )
  .handler(async ({ context, data }) => {
    let query = context.supabase
      .from("handover_versions")
      .select("id, local_date, shift, captured_at, label, patient_count")
      .order("local_date", { ascending: false })
      .order("shift", { ascending: false })
      .limit(500);

    const q = data.q?.trim();
    if (q) {
      // Escape PostgREST ilike wildcards so a literal search stays literal.
      const safe = q.replace(/[%,]/g, " ").trim();
      if (safe) query = query.ilike("search_text", `%${safe}%`);
    }
    if (data.from) query = query.gte("local_date", data.from);
    if (data.to) query = query.lte("local_date", data.to);
    if (data.shift === "am" || data.shift === "pm") {
      query = query.eq("shift", data.shift);
    }

    const { data: rows, error } = await query;
    if (error) throw safeDbError(error, "load saved handover versions");
    return (rows ?? []) as HandoverVersionSummary[];
  });

// Load a single saved version including its full patient snapshot so the exact
// handover can be re-rendered and re-exported.
export const getHandoverVersion = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) =>
    z.object({ id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("handover_versions")
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw safeDbError(error, "load the saved handover version");
    if (!row) throw new Error("Saved handover version not found");
    return row;
  });

// Admin-only manual capture, so a version can be saved on demand without waiting
// for the next scheduled 8am / 8pm snapshot.
export const captureHandoverVersionNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { captureHandoverSnapshot } = await import("@/lib/handover-snapshot.server");
    return captureHandoverSnapshot({ force: true });
  });
