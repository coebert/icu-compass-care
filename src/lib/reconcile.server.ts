// Server-only cross-project reconciliation review.
//
// Compares LOCAL rows against the PARTNER's copy, keyed by stable id, and
// classifies each as matched / diverged / local_only / remote_only.
//
// Only referrals can be pulled from here, and only through the same validated
// sync v1 import as the scheduled job (allowlisted fields, revision
// compare-and-set, tombstones). Notifications and the audit log are review
// only: the partner's rows are never copied into this backend.
import {
  fetchPartnerNotificationsForReview,
  fetchPartnerAuditLogForReview,
  fetchSyncV1,
  BridgeFetchError,
} from "@/lib/bridge-client.server";
import { ContractError, mapReferral, tsKey, type ImportedReferral } from "@/lib/bridge-contract";
import { importReferrals, ImportStepError } from "@/lib/bridge-import.server";
import { SYNC_ERROR_TEXT } from "@/lib/sync-status";
import { safeDbError } from "@/lib/db-error";
import type { ReconEntity, EntityRecon, ReconRow, ReconcileResult } from "@/lib/reconcile.functions";
import { getAdmin } from "@/lib/admin-db.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;
type Record0 = Record<string, unknown>;

function ms(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : 0;
}

type Spec = {
  entity: ReconEntity;
  table: string;
  localColumns: string;
  importable: boolean;
  fetchRemote: () => Promise<Record0[]>;
  // Version marker shown to the reviewer (null = append-only / no version).
  version: (r: Record0) => string | null;
  /** Do the two copies agree? Defaults to equal version markers. */
  same?: (local: Record0, remote: Record0) => boolean;
  label: (r: Record0) => string;
  sub: (r: Record0) => string;
};

const SPECS: Spec[] = [
  {
    entity: "notifications",
    table: "notifications",
    localColumns: "id, kind, message, read_at, created_at",
    importable: false,
    fetchRemote: fetchPartnerNotificationsForReview,
    version: (r) => (r.read_at as string) ?? (r.created_at as string) ?? null,
    label: (r) => String(r.kind ?? "notification"),
    sub: (r) => String(r.message ?? "").slice(0, 80),
  },
  {
    entity: "referrals",
    table: "referrals",
    localColumns: `id, updated_at, ${REFERRAL_CONTENT_FIELDS.join(", ")}`,
    importable: true,
    // Validated v1 snapshot, allowlist-mapped: no raw partner row is used.
    fetchRemote: async () =>
      (await fetchSyncV1("referrals")).records.map((r) => mapReferral(r) as Record0),
    version: (r) => (r.updated_at as string) ?? null,
    // The local updated_at is this app's own revision, not CCC's, so the
    // copies are compared on the imported content itself.
    same: (l, r) => referralContentKey(l) === referralContentKey(r),
    label: (r) => String(r.referring_specialty ?? "Referral"),
    sub: (r) => (r.deleted_at ? "removed in Critical Care Connect" : String(r.status ?? "")),
  },
  {
    entity: "audit_log",
    table: "audit_log",
    localColumns: "id, action, entity, entity_id",
    importable: false,
    fetchRemote: fetchPartnerAuditLogForReview,
    version: () => null, // append-only: presence-only comparison
    label: (r) => `${r.action ?? "?"} · ${r.entity ?? "?"}`,
    sub: (r) => String(r.entity_id ?? ""),
  },
];

const REFERRAL_CONTENT_FIELDS = [
  "deleted_at", "status", "referral_received_at", "age", "sex", "current_ward", "current_bed",
  "referring_specialty", "reason_category", "ceiling_of_care", "resus_status", "dnacpr_respect",
  "anticipated_interventions", "allergies", "weight_kg", "admission_urgency", "infection_status",
  "news2_score",
] as const;

/** Comparable form of a referral's imported content (a tombstone is just "deleted"). */
export function referralContentKey(r: Record0 | ImportedReferral): string {
  if (r.deleted_at != null) return "deleted";
  return JSON.stringify(
    REFERRAL_CONTENT_FIELDS.map((k) => {
      const v = (r as Record0)[k];
      if (k === "referral_received_at") return v == null ? null : String(tsKey(v));
      if (k === "weight_kg") return v == null ? null : Number(v);
      if (k === "anticipated_interventions") return Array.isArray(v) ? v : [];
      return v ?? null;
    }),
  );
}

function safeText(e: unknown): string {
  if (e instanceof BridgeFetchError || e instanceof ContractError || e instanceof ImportStepError) {
    return SYNC_ERROR_TEXT[e.code];
  }
  return "Records could not be compared right now.";
}

async function compareEntity(admin: Admin, spec: Spec): Promise<EntityRecon> {
  const [remote, localRes] = await Promise.all([
    spec.fetchRemote(),
    admin.from(spec.table).select(spec.localColumns).limit(5000),
  ]);
  if (localRes.error) throw safeDbError(localRes.error, "read local records for reconciliation");
  const local: Record0[] = localRes.data ?? [];

  const localById = new Map(local.map((r) => [String(r.id).toLowerCase(), r]));
  const remoteById = new Map(remote.map((r) => [String(r.id).toLowerCase(), r]));
  const allIds = new Set<string>([...localById.keys(), ...remoteById.keys()]);

  const mismatches: ReconRow[] = [];
  let matched = 0;
  for (const id of allIds) {
    const l = localById.get(id);
    const r = remoteById.get(id);
    const source = r ?? l!;
    const base: Omit<ReconRow, "state"> = {
      id,
      label: spec.label(source),
      sub: spec.sub(source),
      localVersion: l ? spec.version(l) : null,
      remoteVersion: r ? spec.version(r) : null,
    };
    if (l && !r) mismatches.push({ ...base, state: "local_only" });
    else if (!l && r) mismatches.push({ ...base, state: "remote_only" });
    else if (spec.same ? spec.same(l!, r!) : spec.version(l!) === spec.version(r!)) matched++;
    else mismatches.push({ ...base, state: "diverged" });
  }
  mismatches.sort((a, b) => ms(b.remoteVersion) - ms(a.remoteVersion));
  return {
    entity: spec.entity,
    localCount: local.length,
    remoteCount: remote.length,
    matched,
    mismatches,
    importable: spec.importable,
  };
}

export async function buildReconciliation(): Promise<EntityRecon[]> {
  const admin = await getAdmin();
  const out: EntityRecon[] = [];
  for (const spec of SPECS) {
    try {
      out.push(await compareEntity(admin, spec));
    } catch (e) {
      out.push({
        entity: spec.entity,
        localCount: 0,
        remoteCount: 0,
        matched: 0,
        mismatches: [],
        importable: spec.importable,
        // Never surface raw partner/DB text (it can carry record values).
        error: safeText(e),
      });
    }
  }
  return out;
}

/**
 * Pull partner referrals (all, or specific ids) through the validated import.
 * The whole snapshot is validated first; only then are the chosen ids applied.
 */
export async function reconcilePullReferrals(
  ids: string[] | "all",
  adminOverride?: Admin,
): Promise<ReconcileResult> {
  const admin = adminOverride ?? (await getAdmin());
  let records: Record0[];
  try {
    records = (await fetchSyncV1("referrals")).records;
  } catch (e) {
    return { applied: 0, failed: 0, skipped: 0, conflicts: 0, errors: [safeText(e)] };
  }
  if (ids !== "all") {
    const want = new Set(ids.map((i) => i.toLowerCase()));
    records = records.filter((r) => want.has(String(r.id).toLowerCase()));
  }
  try {
    const c = await importReferrals(admin, records);
    const errors: string[] = [];
    if (c.conflicts > 0) errors.push(SYNC_ERROR_TEXT.record_conflict);
    if (c.failed > 0) errors.push(SYNC_ERROR_TEXT.partial_write_failure);
    return { applied: c.applied, failed: c.failed, skipped: c.skipped, conflicts: c.conflicts, errors };
  } catch (e) {
    return { applied: 0, failed: 0, skipped: 0, conflicts: 0, errors: [safeText(e)] };
  }
}
