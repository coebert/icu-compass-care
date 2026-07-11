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

export type HandoverVersionPage = {
  rows: HandoverVersionSummary[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
};

// Browse saved handover versions, newest first, with server-side pagination.
// Supports free-text / patient search over the stored search_text plus
// date-range and shift filters. Returns the total match count so the UI can
// paginate large histories without loading everything at once.
export const listHandoverVersions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (input: {
      q?: string;
      from?: string;
      to?: string;
      shift?: string;
      page?: number;
      pageSize?: number;
    }) =>
      z
        .object({
          q: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          shift: z.string().optional(),
          page: z.number().int().min(1).optional(),
          pageSize: z.number().int().min(1).max(100).optional(),
        })
        .parse(input ?? {}),
  )
  .handler(async ({ context, data }): Promise<HandoverVersionPage> => {
    const page = data.page ?? 1;
    const pageSize = data.pageSize ?? 25;
    const fromIdx = (page - 1) * pageSize;
    const toIdx = fromIdx + pageSize - 1;

    let query = context.supabase
      .from("handover_versions")
      .select("id, local_date, shift, captured_at, label, patient_count", {
        count: "exact",
      })
      .order("local_date", { ascending: false })
      .order("shift", { ascending: false })
      .range(fromIdx, toIdx);

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

    const { data: rows, error, count } = await query;
    if (error) throw safeDbError(error, "load saved handover versions");
    const total = count ?? 0;
    return {
      rows: (rows ?? []) as HandoverVersionSummary[],
      total,
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
    };
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
