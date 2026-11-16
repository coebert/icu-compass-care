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
  bridgeSystemActor,
  BridgeFetchError,
} from "@/lib/bridge-client.server";
import { ContractError, mapReferral } from "@/lib/bridge-contract";
import { importReferrals, ImportStepError } from "@/lib/bridge-import.server";
import { SYNC_ERROR_TEXT, INBOUND_SYNC_ACTOR_ROLE } from "@/lib/sync-status";
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
  // Version marker used to detect divergence (null = append-only / no version).
  version: (r: Record0) => string | null;
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
    localColumns: "id, updated_at, referring_specialty, status, deleted_at",
    importable: true,
    // Validated v1 snapshot, allowlist-mapped: no raw partner row is used.
    fetchRemote: async () => (await fetchSyncV1("referrals")).records.map(mapReferral),
    version: (r) => (r.updated_at as string) ?? null,
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
    else if (spec.version(l!) === spec.version(r!)) matched++;
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
    const c = await importReferrals(admin, records, {
      id: bridgeSystemActor.id,
      email: bridgeSystemActor.email,
      role: INBOUND_SYNC_ACTOR_ROLE,
    });
    const errors: string[] = [];
    if (c.conflicts > 0) errors.push(SYNC_ERROR_TEXT.record_conflict);
    if (c.failed > 0) errors.push(SYNC_ERROR_TEXT.partial_write_failure);
    return { applied: c.applied, failed: c.failed, skipped: c.skipped, conflicts: c.conflicts, errors };
  } catch (e) {
    return { applied: 0, failed: 0, skipped: 0, conflicts: 0, errors: [safeText(e)] };
  }
}
