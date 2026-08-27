import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeDbError } from "@/lib/db-error";
import {
  APP_ROLES,
  assertAssignableRole,
  assertCanManageAccount,
  assertConfigAdmin,
  assertOversight,
  assertUnitScope,
  type AppRole,
} from "@/lib/roles.server";
import { getAdmin } from "@/lib/admin-db.server";

// Provisioning actions recorded in the tamper-evident access log.
const ACTIONS = [
  "provisioned",
  "role_changed",
  "suspended",
  "reinstated",
  "password_reset",
  "deprovisioned",
] as const;

// Far-future ban window used to suspend an account indefinitely.
// Suspension blocks sign-in and token refresh immediately.
const SUSPEND_DURATION = "876000h";

type LogInput = {
  action: (typeof ACTIONS)[number];
  target_user_id?: string | null;
  target_email?: string | null;
  target_display_name?: string | null;
  role?: string | null;
  reason?: string | null;
  note?: string | null;
};

async function logAccessEvent(
  context: { userId: string; claims?: Record<string, unknown> | null },
  input: LogInput,
) {
  const claimEmail = context.claims?.["email"];
  const supabaseAdmin = await getAdmin();
  await supabaseAdmin.from("account_access_events").insert({
    action: input.action,
    target_user_id: input.target_user_id ?? null,
    target_email: input.target_email ?? null,
    target_display_name: input.target_display_name ?? null,
    role: input.role ?? null,
    reason: input.reason ?? null,
    note: input.note ?? null,
    actor_id: context.userId,
    actor_email: typeof claimEmail === "string" ? claimEmail : null,
  });
}

const reasonSchema = z.string().trim().min(3).max(300);
const roleSchema = z.enum(APP_ROLES);

// List all staff accounts with their access state (admin only).
export const listStaff = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const actor = await assertOversight(context);
    const supabaseAdmin = await getAdmin();
    const { data: profiles, error } = await supabaseAdmin
      .from("profiles")
      .select("*")
      .order("display_name");
    if (error) throw safeDbError(error);
    const { data: roles } = await supabaseAdmin.from("user_roles").select("user_id, role");
    const { data: grants } = await supabaseAdmin
      .from("user_unit_access")
      .select("user_id, unit_id, icu_units(name, code)");
    const { data: authList } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const authById = new Map((authList?.users ?? []).map((u) => [u.id, u]));
    const now = Date.now();
    // A unit administrator only ever sees accounts belonging to their own units
    // (plus their own account); Trust administrators and auditors see everyone.
    const visible = (id: string) => {
      if (actor.isTrustAdmin || actor.isAuditor) return true;
      if (id === actor.userId) return true;
      return (grants ?? []).some(
        (g) => g.user_id === id && actor.unitIds.includes(g.unit_id),
      );
    };
    return (profiles ?? []).filter((p) => visible(p.id)).map((p) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const au = authById.get(p.id) as any;
      const bannedUntil = au?.banned_until ? Date.parse(au.banned_until) : null;
      return {
        id: p.id,
        display_name: p.display_name,
        email: (au?.email as string | undefined) ?? null,
        job_title: p.job_title ?? null,
        roles: (roles ?? []).filter((r) => r.user_id === p.id).map((r) => r.role),
        units: (grants ?? [])
          .filter((g) => g.user_id === p.id)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((g) => ({ unit_id: g.unit_id, label: (g as any).icu_units?.code ?? null })),
        suspended: Boolean(bannedUntil && bannedUntil > now),
        last_sign_in_at: (au?.last_sign_in_at as string | undefined) ?? null,
        created_at: (au?.created_at as string | undefined) ?? p.created_at ?? null,
      };
    });
  });

// Recent onboarding / access-removal history (admin only).
export const listAccessEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const actor = await assertOversight(context);
    const supabaseAdmin = await getAdmin();
    const { data, error } = await supabaseAdmin
      .from("account_access_events")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw safeDbError(error);
    if (actor.isTrustAdmin || actor.isAuditor) return (data ?? []).slice(0, 100);
    // Unit administrators only see events about accounts in their own units.
    const { data: grants } = await supabaseAdmin
      .from("user_unit_access")
      .select("user_id, unit_id");
    const inScope = new Set(
      (grants ?? [])
        .filter((g) => actor.unitIds.includes(g.unit_id))
        .map((g) => g.user_id),
    );
    return (data ?? [])
      .filter(
        (e) =>
          e.actor_id === actor.userId ||
          (e.target_user_id ? inScope.has(e.target_user_id) : false),
      )
      .slice(0, 100);
  });

// Onboard a new staff account (admin only).
export const createStaff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        email: z.string().trim().email().max(255),
        password: z.string().min(8).max(200),
        display_name: z.string().trim().min(1).max(200),
        job_title: z.string().trim().max(120).optional(),
        role: roleSchema,
        // ICU units the new account may work in. Required for clinical roles:
        // without a membership the account can reach no patient data at all.
        unit_ids: z.array(z.string().uuid()).max(50).optional(),
        reason: reasonSchema,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const actor = await assertConfigAdmin(context);
    assertAssignableRole(actor, data.role as AppRole);
    // A unit administrator may only place people in units they administer, and
    // defaults to their own units when none are named.
    const unitIds =
      data.unit_ids && data.unit_ids.length > 0
        ? data.unit_ids
        : actor.isTrustAdmin
          ? []
          : actor.unitIds;
    for (const unitId of unitIds) assertUnitScope(actor, unitId);
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
    await supabaseAdmin
      .from("profiles")
      .update({ display_name: data.display_name, job_title: data.job_title ?? null })
      .eq("id", newId);
    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: newId, role: data.role });
    if (roleErr) throw safeDbError(roleErr);
    if (unitIds.length > 0) {
      const { error: unitErr } = await supabaseAdmin.from("user_unit_access").insert(
        unitIds.map((unit_id) => ({
          user_id: newId,
          unit_id,
          granted_by: context.userId,
          reason: data.reason,
        })),
      );
      if (unitErr) throw safeDbError(unitErr);
    }
    await logAccessEvent(context, {
      action: "provisioned",
      target_user_id: newId,
      target_email: data.email,
      target_display_name: data.display_name,
      role: data.role,
      reason: data.reason,
      note: data.job_title ?? null,
    });
    return { ok: true, id: newId };
  });

// Change a staff member's role (admin only).
export const setStaffRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        user_id: z.string().uuid(),
        role: roleSchema,
        // ICU units the new account may work in. Required for clinical roles:
        // without a membership the account can reach no patient data at all.
        unit_ids: z.array(z.string().uuid()).max(50).optional(),
        reason: reasonSchema,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const actor = await assertConfigAdmin(context);
    assertAssignableRole(actor, data.role as AppRole);
    // A unit administrator may only place people in units they administer, and
    // defaults to their own units when none are named.
    const unitIds =
      data.unit_ids && data.unit_ids.length > 0
        ? data.unit_ids
        : actor.isTrustAdmin
          ? []
          : actor.unitIds;
    for (const unitId of unitIds) assertUnitScope(actor, unitId);
    const supabaseAdmin = await getAdmin();
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.user_id);
    const { error } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: data.user_id, role: data.role });
    if (error) throw safeDbError(error);
    const { data: target } = await supabaseAdmin.auth.admin.getUserById(data.user_id);
    await logAccessEvent(context, {
      action: "role_changed",
      target_user_id: data.user_id,
      target_email: target?.user?.email ?? null,
      target_display_name:
        (target?.user?.user_metadata?.["display_name"] as string | undefined) ?? null,
      role: data.role,
      reason: data.reason,
    });
    return { ok: true };
  });

// Suspend or reinstate access (admin only). Suspension takes effect immediately:
// sign-in and token refresh are blocked, and clinical roles are stripped.
export const setStaffSuspended = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        user_id: z.string().uuid(),
        suspended: z.boolean(),
        role: roleSchema.optional(),
        reason: reasonSchema,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const actor = await assertConfigAdmin(context);
    if (data.role) assertAssignableRole(actor, data.role as AppRole);
    if (data.user_id === context.userId) throw new Error("You cannot suspend your own account");
    const supabaseAdmin = await getAdmin();
    await assertCanManageAccount(actor, data.user_id, supabaseAdmin);
    const { data: target } = await supabaseAdmin.auth.admin.getUserById(data.user_id);
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
      ban_duration: data.suspended ? SUSPEND_DURATION : "none",
    });
    if (error) throw safeDbError(error);
    if (data.suspended) {
      // Remove all role grants so nothing is authorised even if a session lingers.
      await supabaseAdmin.from("user_roles").delete().eq("user_id", data.user_id);
    } else {
      const role = data.role ?? "clinician";
      await supabaseAdmin.from("user_roles").delete().eq("user_id", data.user_id);
      const { error: roleErr } = await supabaseAdmin
        .from("user_roles")
        .insert({ user_id: data.user_id, role });
      if (roleErr) throw safeDbError(roleErr);
    }
    await logAccessEvent(context, {
      action: data.suspended ? "suspended" : "reinstated",
      target_user_id: data.user_id,
      target_email: target?.user?.email ?? null,
      target_display_name:
        (target?.user?.user_metadata?.["display_name"] as string | undefined) ?? null,
      role: data.suspended ? null : (data.role ?? "clinician"),
      reason: data.reason,
    });
    return { ok: true };
  });

// Set a new temporary password for a staff member (admin only).
export const resetStaffPassword = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        user_id: z.string().uuid(),
        password: z.string().min(8).max(200),
        reason: reasonSchema,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const actor = await assertConfigAdmin(context);
    const supabaseAdmin = await getAdmin();
    await assertCanManageAccount(actor, data.user_id, supabaseAdmin);
    const { data: target } = await supabaseAdmin.auth.admin.getUserById(data.user_id);
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.user_id, {
      password: data.password,
    });
    if (error) throw safeDbError(error);
    await logAccessEvent(context, {
      action: "password_reset",
      target_user_id: data.user_id,
      target_email: target?.user?.email ?? null,
      target_display_name:
        (target?.user?.user_metadata?.["display_name"] as string | undefined) ?? null,
      reason: data.reason,
    });
    return { ok: true };
  });

// Deprovision a staff account (admin only). Patient records are retained.
export const deleteStaff = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ user_id: z.string().uuid(), reason: reasonSchema }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const actor = await assertConfigAdmin(context);
    if (data.user_id === context.userId) throw new Error("You cannot delete your own account");
    const supabaseAdmin = await getAdmin();
    await assertCanManageAccount(actor, data.user_id, supabaseAdmin);
    const { data: target } = await supabaseAdmin.auth.admin.getUserById(data.user_id);
    const email = target?.user?.email ?? null;
    const displayName =
      (target?.user?.user_metadata?.["display_name"] as string | undefined) ?? null;
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.user_id);
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.user_id);
    if (error) throw safeDbError(error);
    await logAccessEvent(context, {
      action: "deprovisioned",
      target_user_id: null,
      target_email: email,
      target_display_name: displayName,
      reason: data.reason,
    });
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
      .in("role", ["admin", "trust_admin"]);
    if (countErr) throw safeDbError(countErr);
    if ((count ?? 0) > 0) return { ok: false, reason: "admin_exists" as const };
    const { error } = await supabaseAdmin.from("user_roles").insert([
      { user_id: context.userId, role: "trust_admin" },
      { user_id: context.userId, role: "unit_admin" },
    ]);
    if (error) throw safeDbError(error);
    return { ok: true };
  });
