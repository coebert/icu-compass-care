import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { assertReconcileAccess } from "@/lib/roles.server";

export type ReconEntity = "notifications" | "referrals" | "audit_log";

export type ReconState =
  | "matched"
  /** The partner has a newer version that the checked import will apply. */
  | "diverged"
  | "local_only"
  | "remote_only"
  /** Ownership conflict: the import will refuse it; a person must review. */
  | "conflict"
  /** Copies differ, but the partner's isn't newer: pulling changes nothing. */
  | "held";

/** Why a row is in its state. Client-safe codes only; no record values. */
export type ReconReason =
  | "new_on_partner"
  | "partner_deletion"
  | "partner_newer"
  | "not_imported"
  | "local_edit"
  | "local_missing"
  | "watermark_reused"
  | "partner_not_newer"
  | "deletion_stands"
  | "imported_not_listed"
  | "local_record"
  | "partner_list_unconfirmed"
  | "review_only";

export type ReconRow = {
  id: string;
  label: string;
  sub: string;
  localVersion: string | null;
  remoteVersion: string | null;
  state: ReconState;
  reason: ReconReason;
  /** True only when the checked import would actually change something. */
  pullable: boolean;
};

export type EntityRecon = {
  entity: ReconEntity;
  localCount: number;
  remoteCount: number;
  matched: number;
  mismatches: ReconRow[];
  /** False = review only; the partner's rows are never copied here. */
  importable: boolean;
  /**
   * False when the partner did not prove its list is complete: "only here"
   * and "everything in sync" can't be claimed from it.
   */
  partnerListComplete: boolean;
  error?: string;
};

export type ReconcileResult = {
  applied: number;
  failed: number;
  skipped: number;
  conflicts: number;
  errors: string[];
};

// Trust administrators only: the review reads every unit's notifications and
// audit metadata, and pulling writes referrals, so a unit administrator's
// scope is not enough.
// Review synced state across both projects.
export const getReconciliation = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<EntityRecon[]> => {
    await assertReconcileAccess(context);
    const { buildReconciliation } = await import("@/lib/reconcile.server");
    return buildReconciliation();
  });

// Pull partner referrals through the validated import (Trust admin only). Other
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
    await assertReconcileAccess(context);
    const { reconcilePullReferrals } = await import("@/lib/reconcile.server");
    return reconcilePullReferrals(data.ids);
  });
