import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeDbError } from "@/lib/db-error";
import { DEFAULT_BEDS, type BedSlot } from "@/lib/icu-beds";
import { assertAdmin } from "@/lib/roles.server";
import { getAdmin } from "@/lib/admin-db.server";


export type Bed = { id: string; label: string; position: number; is_side_room: boolean };

// List the bed roster in display order. Any signed-in staff may read it.
// Falls back to the default roster if the table is somehow empty.
export const listBeds = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<Bed[]> => {
    const { data, error } = await context.supabase
      .from("icu_beds")
      .select("id, label, position, is_side_room")
      .order("position", { ascending: true });
    if (error) throw safeDbError(error, "load beds");
    if (!data || data.length === 0) {
      return DEFAULT_BEDS.map((b, i) => ({
        id: `default-${i}`,
        label: b.label,
        position: i + 1,
        is_side_room: b.is_side_room,
      }));
    }
    return data as Bed[];
  });

const bedInput = z.object({
  label: z.string().trim().min(1, "Bed name is required").max(20),
  is_side_room: z.boolean(),
});

// Replace the entire bed roster (admin only). Positions are derived from the
// order of the submitted array so admins can reorder beds freely.
export const saveBeds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({ beds: z.array(bedInput).min(1, "At least one bed is required").max(60) })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context);

    // Reject duplicate labels (case-insensitive) before touching the DB.
    const seen = new Set<string>();
    for (const b of data.beds) {
      const key = b.label.trim().toUpperCase();
      if (seen.has(key)) throw new Error(`Duplicate bed name: ${b.label}`);
      seen.add(key);
    }

    const supabaseAdmin = await getAdmin();

    // Full replace keeps positions contiguous and honours reordering.
    const { error: delErr } = await supabaseAdmin
      .from("icu_beds")
      .delete()
      .not("id", "is", null);
    if (delErr) throw safeDbError(delErr, "update beds");

    const rows = data.beds.map((b, i) => ({
      label: b.label.trim(),
      position: i + 1,
      is_side_room: b.is_side_room,
    }));
    const { error: insErr } = await supabaseAdmin.from("icu_beds").insert(rows);
    if (insErr) throw safeDbError(insErr, "update beds");

    return { ok: true, count: rows.length };
  });
