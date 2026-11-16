import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertAdmin } from "@/lib/roles.server";

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
  /** False = review only; the partner's rows are never copied here. */
  importable: boolean;
  error?: string;
};

export type ReconcileResult = {
  applied: number;
  failed: number;
  skipped: number;
  conflicts: number;
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

// Pull partner referrals through the validated import (admin only). Other
// entities are review-only and cannot be pulled.
export const reconcilePartner = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        entity: z.literal("referrals"),
        ids: z.union([z.literal("all"), z.array(z.string().uuid()).min(1).max(500)]),
      })
      .parse(input),
  )
  .handler(async ({ context, data }): Promise<ReconcileResult> => {
    await assertAdmin(context);
    const { reconcilePullReferrals } = await import("@/lib/reconcile.server");
    return reconcilePullReferrals(data.ids);
  });
