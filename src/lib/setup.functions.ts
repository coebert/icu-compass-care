import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeDbError } from "@/lib/db-error";
import { getAdmin } from "@/lib/admin-db.server";

// First-run setup: create the very first admin account, and ONLY if the system
// has no users yet. Self-disables permanently once any account exists, so it is
// safe to leave in place. Requires no auth because there is no one to authorise.
export const setupStatus = createServerFn({ method: "GET" }).handler(async () => {
  const supabaseAdmin = await getAdmin();
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error) throw safeDbError(error, "check setup status");
  return { needsSetup: (data?.users?.length ?? 0) === 0 };
});

export const bootstrapAdmin = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        email: z.string().trim().email().max(255),
        // Strong admin password policy: min 12 chars with upper, lower,
        // number, and symbol. The admin account is the highest-privilege
        // credential in a PHI system, so enforce complexity at creation.
        password: z
          .string()
          .min(12, "Password must be at least 12 characters")
          .max(200)
          .regex(/[a-z]/, "Password must include a lowercase letter")
          .regex(/[A-Z]/, "Password must include an uppercase letter")
          .regex(/[0-9]/, "Password must include a number")
          .regex(/[^A-Za-z0-9]/, "Password must include a symbol"),
        display_name: z.string().trim().min(1).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const supabaseAdmin = await getAdmin();
    const { data: existing, error: listErr } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 1,
    });
    if (listErr) throw safeDbError(listErr, "complete setup");
    if ((existing?.users?.length ?? 0) > 0) {
      throw new Error("Setup already completed. Ask an administrator to create your account.");
    }
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { display_name: data.display_name },
    });
    if (error) throw safeDbError(error, "create the admin account");
    const id = created.user!.id;
    await supabaseAdmin.from("profiles").update({ display_name: data.display_name }).eq("id", id);
    // The founding account needs both: Trust administrator for platform-wide
    // configuration, and unit administrator so it can also run a unit clinically.
    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .insert([
        { user_id: id, role: "trust_admin" },
        { user_id: id, role: "unit_admin" },
      ]);
    if (roleErr) throw safeDbError(roleErr, "assign the administrator roles");
    return { ok: true };
  });
