import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export type ReconEntity = "notifications" | "referrals" | "audit_log";

export type ReconState = "matched" | "diverged" | "local_only" | "remote_only";

export type ReconRow = {
  id: string;
  label: string;
  sub: string;
  localVersion: string | null;
  remoteVersion: string | null;
  state: ReconState;
};

export type EntityRecon = {
  entity: ReconEntity;
  localCount: number;
  remoteCount: number;
  matched: number;
  mismatches: ReconRow[];
  error?: string;
};

export type ReconcileResult = {
  applied: number;
  failed: number;
  errors: string[];
};

// assertAdmin is imported from roles.server (see import at top).

// Review synced state across both projects (admin only).
export const getReconciliation = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<EntityRecon[]> => {
    await assertAdmin(context);
    const { buildReconciliation } = await import("@/lib/reconcile.server");
    return buildReconciliation();
  });

// Pull the partner's copy of one or more rows into this backend (admin only).
export const reconcilePartner = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        entity: z.enum(["notifications", "referrals", "audit_log"]),
        ids: z.union([z.literal("all"), z.array(z.string().uuid()).min(1)]),
      })
      .parse(input),
  )
  .handler(async ({ context, data }): Promise<ReconcileResult> => {
    await assertAdmin(context);
    const { reconcilePull } = await import("@/lib/reconcile.server");
    return reconcilePull(data.entity, data.ids);
  });
