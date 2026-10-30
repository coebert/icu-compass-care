import { safeDbError } from "@/lib/db-error";

/** Map database-raised admin errors to clear messages; keep REAUTH_REQUIRED so the client can prompt. */
export function friendlyAdminError(error: { message?: string } | null | undefined): Error {
  const msg = error?.message ?? "";
  if (msg.includes("REAUTH_REQUIRED")) {
    return new Error("REAUTH_REQUIRED: please confirm your password to continue.");
  }
  if (msg.includes("SESSION_LOCKED")) {
    return new Error("SESSION_LOCKED: this session is locked. Unlock or sign in again.");
  }
  if (msg.includes("LAST_TRUST_ADMIN")) {
    return new Error("At least one active Trust administrator must remain. Appoint another first.");
  }
  if (msg.includes("TARGET_SUSPENDED")) {
    return new Error("That account is suspended. Reinstate it first.");
  }
  if (msg.includes("REASON_REQUIRED")) {
    return new Error("Please record a reason (3–300 characters).");
  }
  if (msg.includes("FORBIDDEN_TARGET")) {
    return new Error("Forbidden: that account is outside your administrative scope");
  }
  if (msg.includes("FORBIDDEN_ROLE")) {
    return new Error("Forbidden: only a Trust administrator can assign that role");
  }
  if (msg.includes("INVALID_ACTION")) {
    return new Error("That change is not allowed for this account's current state.");
  }
  return safeDbError(error as never);
}
