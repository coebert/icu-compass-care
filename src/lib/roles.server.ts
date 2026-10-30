import { safeDbError } from "@/lib/db-error";

/**
 * Role model — the code-side mirror of the published permission matrix
 * (Critical_Care_Permission_Matrix_v1.docx).
 *
 *   clinician    clinical view + edit, only in the ICU units they are a member of
 *   unit_admin   the same clinical rights, plus accounts / unit configuration
 *                for their own units only
 *   trust_admin  full clinical view + edit across every unit, plus
 *                configuration everywhere
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
  claims?: Record<string, unknown> | null;
};

/**
 * Server/database-enforced session state. A session that was locked (manual
 * lock, passkey lock screen) or has been idle past the limit is refused here
 * as well as by every role-gated RLS policy (private.has_role checks
 * private.session_active()). Browser storage plays no part in this decision.
 */
export async function assertSessionActive(context: Ctx): Promise<void> {
  const { data, error } = await context.supabase.rpc("session_status");
  if (error) throw safeDbError(error, "verify your session");
  if (data !== "active") {
    throw new Error(
      data === "locked"
        ? "SESSION_LOCKED: this session is locked. Unlock or sign in again."
        : "SESSION_ENDED: this session is no longer valid. Please sign in again.",
    );
  }
}

/** How recent a genuine re-authentication must be for sensitive admin actions. */
export const REAUTH_MAX_AGE_SECONDS = 10 * 60;

/**
 * Require a recent, verified re-authentication. Reads the `amr` claim of the
 * signature-verified access token: Supabase Auth stamps it with the time the
 * user actually proved a credential (password / OTP / MFA). Token refreshes
 * keep the original stamp, so only a fresh sign-in satisfies this — nothing
 * the caller supplies in the request body is trusted.
 */
export function assertRecentReauth(
  claims: Record<string, unknown> | null | undefined,
  nowSeconds = Math.floor(Date.now() / 1000),
  maxAgeSeconds = REAUTH_MAX_AGE_SECONDS,
): void {
  const amr = Array.isArray(claims?.["amr"]) ? (claims!["amr"] as unknown[]) : [];
  const strong = new Set(["password", "otp", "totp", "mfa/totp", "webauthn", "mfa/webauthn", "magiclink"]);
  const newest = amr.reduce<number>((acc, entry) => {
    if (!entry || typeof entry !== "object") return acc;
    const m = (entry as { method?: unknown }).method;
    const t = (entry as { timestamp?: unknown }).timestamp;
    if (typeof m !== "string" || !strong.has(m) || typeof t !== "number") return acc;
    return Math.max(acc, t);
  }, 0);
  if (!newest || nowSeconds - newest > maxAgeSeconds || newest > nowSeconds + 60) {
    throw new Error(
      "REAUTH_REQUIRED: please confirm your password to continue with this administrative action.",
    );
  }
}

/**
 * Load the caller's roles and unit memberships through their own client, so
 * RLS ("users can view own roles" / "own unit access") is what answers.
 */
export async function loadActor(context: Ctx): Promise<Actor> {
  await assertSessionActive(context);
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
    canEditClinical: isClinician || isUnitAdmin || isTrustAdmin,
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
 * Target-aware authorisation for every global account action (role change,
 * password reset, suspension, deletion). The decision is made by the database
 * (private.can_manage_account) through the CALLER's own client, so it is the
 * same rule RLS applies to direct Data API writes:
 *   - Trust admins may manage any account except their own;
 *   - unit admins may manage only non-privileged accounts (no trust_admin /
 *     legacy admin / auditor role) that have at least one unit and whose
 *     units all fall inside the unit admin's own units.
 */
export async function assertCanManageAccount(context: Ctx, targetUserId: string): Promise<void> {
  const { data, error } = await context.supabase.rpc("can_manage_account", {
    _target: targetUserId,
  });
  if (error) throw safeDbError(error, "verify account permissions");
  if (data !== true) {
    throw new Error("Forbidden: that account is outside your administrative scope");
  }
}

/**
 * Legacy guard kept for call sites that only need "an administrator".
 * Prefer assertConfigAdmin / assertTrustAdmin, which say which kind.
 */
export async function assertAdmin(context: Ctx): Promise<Actor> {
  return assertConfigAdmin(context);
}

/**
 * Password reset gate: Trust administrator (active session, checked by
 * loadActor) plus recent verified reauthentication; never your own account.
 */
export async function authorizePasswordReset(
  context: Ctx,
  targetUserId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<Actor> {
  const actor = await assertTrustAdmin(context);
  assertRecentReauth(context.claims, nowSeconds);
  if (targetUserId === context.userId) {
    throw new Error("Change your own password from My profile instead");
  }
  return actor;
}
