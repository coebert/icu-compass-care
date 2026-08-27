import { safeDbError } from "@/lib/db-error";

/**
 * Role model — the code-side mirror of the published permission matrix
 * (Critical_Care_Permission_Matrix_v1.docx).
 *
 *   clinician    clinical view + edit, only in the ICU units they are a member of
 *   unit_admin   the same clinical rights, plus accounts / unit configuration
 *                for their own units only
 *   trust_admin  view-only clinical break-glass across every unit, plus
 *                configuration everywhere; never a clinical author
 *   auditor      audit trails, access log, edit history and account listings
 *                only — no clinical data at all
 *
 * Row-level security is the enforcement boundary (private.can_view_unit /
 * can_edit_unit / can_admin_unit). These helpers exist so privileged server
 * functions fail closed with a clear message *before* touching the service-role
 * client, and so unit administrators cannot act outside their own units.
 */

export const APP_ROLES = ["clinician", "unit_admin", "trust_admin", "auditor"] as const;
export type AppRole = (typeof APP_ROLES)[number];

// Roles a unit administrator is allowed to hand out (never a Trust-wide role).
export const UNIT_ASSIGNABLE_ROLES = ["clinician", "unit_admin"] as const;

export type Actor = {
  userId: string;
  roles: AppRole[];
  /** Units the actor is an explicit member of. */
  unitIds: string[];
  isClinician: boolean;
  isUnitAdmin: boolean;
  isTrustAdmin: boolean;
  isAuditor: boolean;
  /** May record clinical information (in member units). */
  canEditClinical: boolean;
  /** May change accounts / configuration somewhere. */
  canConfigure: boolean;
};

type Ctx = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  userId: string;
};

/**
 * Load the caller's roles and unit memberships through their own client, so
 * RLS ("users can view own roles" / "own unit access") is what answers.
 */
export async function loadActor(context: Ctx): Promise<Actor> {
  const [rolesRes, unitsRes] = await Promise.all([
    context.supabase.from("user_roles").select("role").eq("user_id", context.userId),
    context.supabase.from("user_unit_access").select("unit_id").eq("user_id", context.userId),
  ]);
  if (rolesRes.error) throw safeDbError(rolesRes.error, "verify permissions");
  if (unitsRes.error) throw safeDbError(unitsRes.error, "verify unit access");

  const raw = (rolesRes.data ?? []).map((r: { role: string }) => r.role);
  // 'admin' is the pre-matrix spelling of the Trust administrator role.
  const roles = raw.map((r: string) => (r === "admin" ? "trust_admin" : r)) as AppRole[];
  const unitIds = (unitsRes.data ?? []).map((u: { unit_id: string }) => u.unit_id);

  const isClinician = roles.includes("clinician");
  const isUnitAdmin = roles.includes("unit_admin");
  const isTrustAdmin = roles.includes("trust_admin");
  const isAuditor = roles.includes("auditor");

  return {
    userId: context.userId,
    roles,
    unitIds,
    isClinician,
    isUnitAdmin,
    isTrustAdmin,
    isAuditor,
    canEditClinical: isClinician || isUnitAdmin,
    canConfigure: isUnitAdmin || isTrustAdmin,
  };
}

/** Accounts / configuration rights somewhere (unit administrator or Trust). */
export async function assertConfigAdmin(context: Ctx): Promise<Actor> {
  const actor = await loadActor(context);
  if (!actor.canConfigure) throw new Error("Forbidden: administrators only");
  return actor;
}

/** Platform-wide rights: Trust / system administrator only. */
export async function assertTrustAdmin(context: Ctx): Promise<Actor> {
  const actor = await loadActor(context);
  if (!actor.isTrustAdmin) throw new Error("Forbidden: Trust administrators only");
  return actor;
}

/** Oversight surfaces (audit, access log, bridge security): admins + auditors. */
export async function assertOversight(context: Ctx): Promise<Actor> {
  const actor = await loadActor(context);
  if (!actor.isTrustAdmin && !actor.isUnitAdmin && !actor.isAuditor) {
    throw new Error("Forbidden: administrators and auditors only");
  }
  return actor;
}

/**
 * A unit administrator may only act inside their own units; a Trust
 * administrator may act on any unit.
 */
export function assertUnitScope(actor: Actor, unitId: string | null | undefined): void {
  if (actor.isTrustAdmin) return;
  if (!unitId || !actor.unitIds.includes(unitId)) {
    throw new Error("Forbidden: that ICU unit is outside your administrative scope");
  }
}

/** Roles this actor is allowed to assign to someone else. */
export function assignableRoles(actor: Actor): readonly AppRole[] {
  return actor.isTrustAdmin ? APP_ROLES : UNIT_ASSIGNABLE_ROLES;
}

export function assertAssignableRole(actor: Actor, role: AppRole): void {
  if (!assignableRoles(actor).includes(role)) {
    throw new Error(`Forbidden: only a Trust administrator can assign the ${role} role`);
  }
}

/**
 * A unit administrator may only manage accounts that belong to one of their own
 * units. Uses the service-role client because the target's memberships are not
 * otherwise readable. Returns the target's unit ids.
 */
export async function assertCanManageAccount(
  actor: Actor,
  targetUserId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabaseAdmin: any,
): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("user_unit_access")
    .select("unit_id")
    .eq("user_id", targetUserId);
  if (error) throw safeDbError(error, "verify unit access");
  const targetUnits = (data ?? []).map((u: { unit_id: string }) => u.unit_id);
  if (actor.isTrustAdmin) return targetUnits;
  const shares = targetUnits.some((unitId: string) => actor.unitIds.includes(unitId));
  if (!shares) {
    throw new Error("Forbidden: that account belongs to units outside your administrative scope");
  }
  return targetUnits;
}

/**
 * Legacy guard kept for call sites that only need "an administrator".
 * Prefer assertConfigAdmin / assertTrustAdmin, which say which kind.
 */
export async function assertAdmin(context: Ctx): Promise<Actor> {
  return assertConfigAdmin(context);
}
