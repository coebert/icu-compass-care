import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeDbError } from "@/lib/db-error";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertConfigAdmin } from "@/lib/roles.server";
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
  /** Unit the snapshot belongs to; null only for quarantined legacy rows. */
  unit_id: string | null;
};

// Unit-scoped snapshots (RLS: private.can_view_unit). Legacy mixed-unit rows
// stay in handover_versions, readable by Trust administrators only.
const UNIT_TABLE = "handover_unit_versions" as const;
const LEGACY_TABLE = "handover_versions" as const;

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
      legacy?: boolean;
    }) =>
      z
        .object({
          q: z.string().optional(),
          from: z.string().optional(),
          to: z.string().optional(),
          shift: z.string().optional(),
          page: z.number().int().min(1).optional(),
          pageSize: z.number().int().min(1).max(100).optional(),
          legacy: z.boolean().optional(),
        })
        .parse(input ?? {}),
  )
  .handler(async ({ context, data }): Promise<HandoverVersionPage> => {
    const page = data.page ?? 1;
    const pageSize = data.pageSize ?? 25;
    const fromIdx = (page - 1) * pageSize;
    const toIdx = fromIdx + pageSize - 1;

    const table = data.legacy ? LEGACY_TABLE : UNIT_TABLE;
    const columns = data.legacy
      ? "id, local_date, shift, captured_at, label, patient_count"
      : "id, local_date, shift, captured_at, label, patient_count, unit_id";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let query = (context.supabase as any)
      .from(table)
      .select(columns, {
        count: "exact",
      })
      .order("local_date", { ascending: false })
      .order("shift", { ascending: false });
    // Deterministic tie-break so pages never repeat or skip rows.
    if (!data.legacy) query = query.order("unit_id", { ascending: true });
    query = query.order("id", { ascending: true }).range(fromIdx, toIdx);

    // The search index is encrypted, so a text query is resolved by decrypting
    // the (small) set of version indexes and restricting to the matching ids.
    const q = data.q?.trim();
    if (q) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let idQuery = (context.supabase as any).from(table).select("id, search_text").limit(2000);
      if (data.from) idQuery = idQuery.gte("local_date", data.from);
      if (data.to) idQuery = idQuery.lte("local_date", data.to);
      const { data: idxRows, error: idxErr } = await idQuery;
      if (idxErr) throw safeDbError(idxErr, "search saved handover versions");
      const needle = q.toLowerCase();
      const matching = (idxRows ?? [])
        .filter((r: { search_text: string }) =>
          (decryptFieldSafe(r.search_text) ?? "").toLowerCase().includes(needle),
        )
        .map((r: { id: string }) => r.id);
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
      rows: ((rows ?? []) as HandoverVersionSummary[]).map((r) => ({
        ...r,
        unit_id: r.unit_id ?? null,
      })),
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
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    // RLS decides: unit snapshots for unit members / Trust admins; legacy
    // mixed-unit rows only for Trust admins.
    let { data: row, error } = await context.supabase
      .from(UNIT_TABLE)
      .select("*")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw safeDbError(error, "load the saved handover version");
    if (!row) {
      const legacy = await context.supabase
        .from(LEGACY_TABLE)
        .select("*")
        .eq("id", data.id)
        .maybeSingle();
      if (legacy.error) throw safeDbError(legacy.error, "load the saved handover version");
      row = legacy.data as typeof row;
    }
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
    const actor = await assertConfigAdmin(context);
    const { captureHandoverSnapshot } = await import("@/lib/handover-snapshot.server");
    // Trust admins may capture every unit; a unit administrator only their own
    // units (counts and ids returned are for those units only).
    return captureHandoverSnapshot({
      force: true,
      ...(actor.isTrustAdmin ? {} : { unitIds: actor.unitIds }),
    });
  });
