import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

// First-run setup: create the very first admin account, and ONLY if the system
// has no users yet. Self-disables permanently once any account exists, so it is
// safe to leave in place. Requires no auth because there is no one to authorise.
export const setupStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (error) throw new Error(error.message);
  return { needsSetup: (data?.users?.length ?? 0) === 0 };
});

export const bootstrapAdmin = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        email: z.string().trim().email().max(255),
        password: z.string().min(8).max(200),
        display_name: z.string().trim().min(1).max(200),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: existing, error: listErr } = await supabaseAdmin.auth.admin.listUsers({
      page: 1,
      perPage: 1,
    });
    if (listErr) throw new Error(listErr.message);
    if ((existing?.users?.length ?? 0) > 0) {
      throw new Error("Setup already completed. Ask an administrator to create your account.");
    }
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { display_name: data.display_name },
    });
    if (error) throw new Error(error.message);
    const id = created.user!.id;
    await supabaseAdmin.from("profiles").update({ display_name: data.display_name }).eq("id", id);
    const { error: roleErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: id, role: "admin" });
    if (roleErr) throw new Error(roleErr.message);
    return { ok: true };
  });
