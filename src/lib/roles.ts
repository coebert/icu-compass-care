// Client-safe labels for the four permission-matrix roles. The rights described
// here are enforced server-side by RLS (see src/lib/roles.server.ts).
export const ROLE_ORDER = ["clinician", "unit_admin", "trust_admin", "auditor"] as const;
export type UiRole = (typeof ROLE_ORDER)[number];

export const ROLE_LABELS: Record<string, string> = {
  clinician: "Clinician",
  unit_admin: "Unit administrator",
  trust_admin: "Trust administrator",
  auditor: "Auditor",
  admin: "Trust administrator",
};

export const ROLE_DESCRIPTIONS: Record<UiRole, string> = {
  clinician: "View and record clinical information for patients in their own ICU units.",
  unit_admin:
    "Everything a clinician can do, plus managing accounts, bed layout and partner sharing for their own units.",
  trust_admin:
    "Configuration everywhere and view-only break-glass access to clinical records across all units. Cannot author clinical entries.",
  auditor:
    "Read-only access to audit trails, the access change log and account listings. No access to clinical information.",
};

export function primaryRoleLabel(roles: string[]): string {
  for (const r of ["trust_admin", "admin", "unit_admin", "auditor", "clinician"]) {
    if (roles.includes(r)) return ROLE_LABELS[r] ?? r;
  }
  return "No role";
}
