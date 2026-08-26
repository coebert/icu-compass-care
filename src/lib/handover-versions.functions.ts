import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeDbError } from "@/lib/db-error";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertAdmin } from "@/lib/roles.server";
import { decryptFieldSafe } from "@/lib/crypto.server";

// Saved snapshots are stored encrypted as { enc: "enc:v1:..." }. Legacy rows
// captured before encryption hold the plain array, so both shapes are read.
function readSnapshot(snapshot: unknown): unknown[] {
  if (Array.isArray(snapshot)) return snapshot;
  const enc = (snapshot as { enc?: unknown } | null)?.enc;
  if (typeof enc !== "string") return [];
  const plain = decryptFieldSafe(enc);
  if (!plain) return [];
  try {
    const parsed: unknown = JSON.parse(plain);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

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

    // The search index is encrypted, so a text query is resolved by decrypting
    // the (small) set of version indexes and restricting to the matching ids.
    const q = data.q?.trim();
    if (q) {
      let idQuery = context.supabase
        .from("handover_versions")
        .select("id, search_text")
        .limit(2000);
      if (data.from) idQuery = idQuery.gte("local_date", data.from);
      if (data.to) idQuery = idQuery.lte("local_date", data.to);
      const { data: idxRows, error: idxErr } = await idQuery;
      if (idxErr) throw safeDbError(idxErr, "search saved handover versions");
      const needle = q.toLowerCase();
      const matching = (idxRows ?? [])
        .filter((r) =>
          (decryptFieldSafe(r.search_text) ?? "").toLowerCase().includes(needle),
        )
        .map((r) => r.id);
      if (matching.length === 0) {
        return { rows: [], total: 0, page, pageSize, pageCount: 1 };
      }
      query = query.in("id", matching);
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
    // Hand the readable snapshot back so the saved handover can be re-rendered,
    // and never return the encrypted search index.
    const { search_text, ...rest } = row as Record<string, unknown>;
    void search_text;
    return { ...rest, snapshot: readSnapshot(row.snapshot) } as typeof row;
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
