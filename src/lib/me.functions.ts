import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeDbError } from "@/lib/db-error";

// Returns the signed-in user's profile, roles, unit memberships and the
// capability flags the UI uses to decide what to offer. The authoritative
// checks live in RLS (see src/lib/roles.server.ts for the role model).
export const getMe = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const [{ data: profile }, { data: roles }, { data: units }] = await Promise.all([
      context.supabase.from("profiles").select("*").eq("id", context.userId).maybeSingle(),
      context.supabase.from("user_roles").select("role").eq("user_id", context.userId),
      context.supabase.from("user_unit_access").select("unit_id").eq("user_id", context.userId),
    ]);
    // 'admin' is the pre-matrix spelling of the Trust administrator role.
    const list = (roles ?? []).map((r) => (r.role === "admin" ? "trust_admin" : r.role));
    const isTrustAdmin = list.includes("trust_admin");
    const isUnitAdmin = list.includes("unit_admin");
    const isAuditor = list.includes("auditor");
    const canEditClinical = list.includes("clinician") || isUnitAdmin;
    return {
      userId: context.userId,
      email: (context.claims.email as string) ?? null,
      profile,
      roles: list,
      unitIds: (units ?? []).map((u) => u.unit_id),
      isTrustAdmin,
      isUnitAdmin,
      isAuditor,
      canEditClinical,
      // "Administrator" for UI purposes = holds configuration rights somewhere.
      isAdmin: isUnitAdmin || isTrustAdmin,
    };
  });


export const updateMyProfile = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ display_name: z.string().trim().min(1).max(200) }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("profiles")
      .update({ display_name: data.display_name })
      .eq("id", context.userId);
    if (error) throw safeDbError(error, "update your profile");
    return { ok: true };
  });
