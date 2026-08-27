import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeDbError } from "@/lib/db-error";
import { assertAdmin } from "@/lib/roles.server";

/**
 * Hospital / ICU unit scope administration.
 *
 * Reads go through the caller's own client so row-level security applies;
 * grants and revocations are admin-only and additionally guarded by RLS
 * (only administrators may write user_unit_access).
 */

// Hospitals with their ICU units — visible to any signed-in clinical user.
export const listUnits = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("icu_units")
      .select("id, name, code, bed_capacity, hospital_id, hospitals(id, name, code)")
      .order("code");
    if (error) throw safeDbError(error);
    return data ?? [];
  });

// The units the signed-in user may read and write.
export const listMyUnits = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("user_unit_access")
      .select("unit_id, created_at, icu_units(id, name, code, hospitals(name))")
      .eq("user_id", context.userId);
    if (error) throw safeDbError(error);
    return data ?? [];
  });

// Every grant across the unit estate (admin only).
export const listUnitAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const { data, error } = await context.supabase
      .from("user_unit_access")
      .select("id, user_id, unit_id, reason, created_at, icu_units(name, code, hospitals(name))")
      .order("created_at", { ascending: false });
    if (error) throw safeDbError(error);
    return data ?? [];
  });

export const grantUnitAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        user_id: z.string().uuid(),
        unit_id: z.string().uuid(),
        reason: z.string().trim().min(3, "Record why access is being granted.").max(300),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context);
    const { error } = await context.supabase.from("user_unit_access").insert({
      user_id: data.user_id,
      unit_id: data.unit_id,
      reason: data.reason,
      granted_by: context.userId,
    });
    if (error) throw safeDbError(error);
    return { ok: true };
  });

export const revokeUnitAccess = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ user_id: z.string().uuid(), unit_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context);
    const { error } = await context.supabase
      .from("user_unit_access")
      .delete()
      .eq("user_id", data.user_id)
      .eq("unit_id", data.unit_id);
    if (error) throw safeDbError(error);
    return { ok: true };
  });
