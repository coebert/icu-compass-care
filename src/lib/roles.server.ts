import { safeDbError } from "@/lib/db-error";

// Shared admin authorization guard for privileged server functions.
//
// Centralised so the role-check logic lives in exactly one place: any change to
// how admin is determined (or a fix) applies everywhere, avoiding the risk of a
// missed copy silently reopening a privilege-escalation gap.
//
// Verifies admin via the user_roles table directly (readable under the
// "Users can view own roles" policy) instead of an API-exposed RPC.
export async function assertAdmin(context: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  userId: string;
}): Promise<void> {
  const { data, error } = await context.supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", context.userId)
    .eq("role", "admin")
    .maybeSingle();
  if (error) throw safeDbError(error, "verify permissions");
  if (!data) throw new Error("Forbidden: admin only");
}
