import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeDbError } from "@/lib/db-error";
import { assertAdmin } from "@/lib/roles.server";
import { getAdmin } from "@/lib/admin-db.server";


// List all staff accounts (admin only).
export const listStaff = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context);
    const supabaseAdmin = await getAdmin();
    const { data: profiles, error } = await context.supabase
      .from("profiles")
      .select("*")
      .order("display_name");
    if (error) throw safeDbError(error);
    const { data: roles } = await context.supabase.from("user_roles").select("user_id, role");
    const { data: authList } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const emailById = new Map((authList?.users ?? []).map((u) => [u.id, u.email]));
    return (profiles ?? []).map((p) => ({
      id: p.id,
      display_name: p.display_name,
      email: emailById.get(p.id) ?? null,
      roles: (roles ?? []).filter((r) => r.user_id === p.id).map((r) => r.role),
    }));
  });

// Create a new staff account (admin only).
export const createStaff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        email: z.string().trim().email().max(255),
        password: z.string().min(8).max(200),
        display_name: z.string().trim().min(1).max(200),
        role: z.enum(["admin", "clinician"]),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context);
    const supabaseAdmin = await getAdmin();
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { display_name: data.display_name },
    });
    if (error) throw safeDbError(error);
    const newId = created.user!.id;
    // profile is auto-created by trigger; ensure display name + role
    await supabaseAdmin.from("profiles").update({ display_name: data.display_name }).eq("id", newId);
    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: newId, role: data.role });
    if (roleErr) throw safeDbError(roleErr);
    return { ok: true, id: newId };
  });

// Change a staff member's role (admin only).
export const setStaffRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({ user_id: z.string().uuid(), role: z.enum(["admin", "clinician"]) })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context);
    const supabaseAdmin = await getAdmin();
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.user_id);
    const { error } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: data.user_id, role: data.role });
    if (error) throw safeDbError(error);
    return { ok: true };
  });

// Delete a staff account (admin only). Patient records are retained.
export const deleteStaff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { user_id: string }) =>
    z.object({ user_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertAdmin(context);
    if (data.user_id === context.userId) throw new Error("You cannot delete your own account");
    const supabaseAdmin = await getAdmin();
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.user_id);
    if (error) throw safeDbError(error);
    return { ok: true };
  });

// Bootstrap: promote the very first user to admin if there are no admins yet.
// Safe because it only succeeds when zero admins exist.
export const claimFirstAdmin = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const supabaseAdmin = await getAdmin();
    const { count, error: countErr } = await supabaseAdmin
      .from("user_roles")
      .select("id", { count: "exact", head: true })
      .eq("role", "admin");
    if (countErr) throw safeDbError(countErr);
    if ((count ?? 0) > 0) return { ok: false, reason: "admin_exists" as const };
    const { error } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: context.userId, role: "admin" });
    if (error) throw safeDbError(error);
    return { ok: true };
  });
