import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeDbError } from "@/lib/db-error";
import { getAdmin } from "@/lib/admin-db.server";

// First-run setup: create the very first admin account, and ONLY if the system
// has no users yet. Self-disables permanently once any account exists, so it is
// safe to leave in place. Requires no auth because there is no one to authorise.
export const setupStatus = createServerFn({ method: "GET" }).handler(async () => {
  const supabaseAdmin = await getAdmin();
  const { data: sealed, error: sealErr } = await supabaseAdmin.rpc("bootstrap_sealed");
  if (sealErr) throw safeDbError(sealErr, "check setup status");
  if (sealed) return { needsSetup: false };
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
    // Permanent seal: once bootstrap has happened (or any account existed when
    // the seal was introduced) this flow can never reopen, even if roles or
    // accounts are later removed.
    const { data: sealed, error: sealErr } = await supabaseAdmin.rpc("bootstrap_sealed");
    if (sealErr) throw safeDbError(sealErr, "complete setup");
    if (sealed) {
      throw new Error("Setup already completed. Ask an administrator to create your account.");
    }
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
    // Roles + seal are written in ONE locked transaction. A concurrent second
    // bootstrap fails here (other account exists / already sealed) and its
    // just-created account is removed again.
    const { error: bootErr } = await supabaseAdmin.rpc("complete_bootstrap", { _user: id });
    if (bootErr) {
      await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {});
      throw new Error("Setup already completed. Ask an administrator to create your account.");
    }
    return { ok: true };
  });
