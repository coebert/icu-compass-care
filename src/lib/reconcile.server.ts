// Server-only orchestration for cross-project reconciliation review.
//
// For each shared entity (notifications, referrals, audit_log) it compares the
// LOCAL rows against the PARTNER rows pulled over the HMAC bridge, keyed by the
// stable row id, and classifies each row as matched / diverged / local_only /
// remote_only. Reconciliation is PULL-based: it upserts the partner's copy into
// this backend (resolving remote_only and remote-newer diverged rows). Rows that
// exist only locally cannot be pushed from here — the partner runs the same job.
import {
  fetchPartnerNotifications,
  fetchPartnerReferrals,
  fetchPartnerAuditLog,
  bridgeSystemActor,
} from "@/lib/bridge-client.server";
import { safeDbError } from "@/lib/db-error";
import type { ReconEntity, EntityRecon, ReconRow, ReconcileResult } from "@/lib/reconcile.functions";
import { getAdmin } from "@/lib/admin-db.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;
type Record0 = Record<string, unknown>;

function ms(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : 0;
}

// A per-entity descriptor: how to read it and how to summarise a row.
type Spec = {
  entity: ReconEntity;
  table: string;
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
    fetchRemote: fetchPartnerNotifications as unknown as () => Promise<Record0[]>,
    version: (r) => (r.read_at as string) ?? (r.created_at as string) ?? null,
    label: (r) => String(r.kind ?? "notification"),
    sub: (r) => String(r.message ?? "").slice(0, 80),
  },
  {
    entity: "referrals",
    table: "referrals",
    fetchRemote: fetchPartnerReferrals as unknown as () => Promise<Record0[]>,
    version: (r) => (r.updated_at as string) ?? null,
    label: (r) => String(r.referring_specialty ?? "Referral"),
    sub: (r) => String(r.status ?? ""),
  },
  {
    entity: "audit_log",
    table: "audit_log",
    fetchRemote: fetchPartnerAuditLog as unknown as () => Promise<Record0[]>,
    version: () => null, // append-only: presence-only comparison
    label: (r) => `${r.action ?? "?"} · ${r.entity ?? "?"}`,
    sub: (r) => String(r.entity_id ?? ""),
  },
];

async function compareEntity(admin: Admin, spec: Spec): Promise<EntityRecon> {
  const [remote, localRes] = await Promise.all([
    spec.fetchRemote(),
    admin.from(spec.table).select("*").limit(5000),
  ]);
  if (localRes.error) throw safeDbError(localRes.error, "read local records for reconciliation");
  const local: Record0[] = localRes.data ?? [];

  const localById = new Map(local.map((r) => [String(r.id), r]));
  const remoteById = new Map(remote.map((r) => [String(r.id), r]));
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

    if (l && !r) {
      mismatches.push({ ...base, state: "local_only" });
    } else if (!l && r) {
      mismatches.push({ ...base, state: "remote_only" });
    } else {
      // present both sides
      const lv = spec.version(l!);
      const rv = spec.version(r!);
      if (lv === rv) matched++;
      else mismatches.push({ ...base, state: "diverged" });
    }
  }

  // Show most actionable mismatches first, newest remote version on top.
  mismatches.sort((a, b) => ms(b.remoteVersion) - ms(a.remoteVersion));

  return {
    entity: spec.entity,
    localCount: local.length,
    remoteCount: remote.length,
    matched,
    mismatches,
  };
}

export async function buildReconciliation(): Promise<EntityRecon[]> {
  const supabaseAdmin = await getAdmin();
  const out: EntityRecon[] = [];
  for (const spec of SPECS) {
    try {
      out.push(await compareEntity(supabaseAdmin, spec));
    } catch (e) {
      out.push({
        entity: spec.entity,
        localCount: 0,
        remoteCount: 0,
        matched: 0,
        mismatches: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

// Pull the partner's copy of specific ids into this backend (upsert by id).
export async function reconcilePull(
  entity: ReconEntity,
  ids: string[] | "all",
): Promise<ReconcileResult> {
  const spec = SPECS.find((s) => s.entity === entity);
  if (!spec) return { applied: 0, failed: 0, errors: ["Unknown entity"] };

  const supabaseAdmin = await getAdmin();
  const admin: Admin = supabaseAdmin;
  const remote = await spec.fetchRemote();

  let rows = remote;
  if (ids !== "all") {
    const want = new Set(ids);
    rows = remote.filter((r) => want.has(String(r.id)));
  }

  let applied = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const row of rows) {
    const { error } = await admin.from(spec.table).upsert(row, { onConflict: "id" });
    if (error) {
      failed++;
      // Log full detail server-side; surface only the row id to the admin report
      // so raw DB error text (schema/constraint names) is never leaked.
      console.error(`[reconcile] upsert failed for ${spec.table} row ${String(row.id)}:`, error);
      if (errors.length < 10) errors.push(`${String(row.id).slice(0, 8)}: upsert failed`);
    } else {
      applied++;
    }
  }

  // Record the reconciliation on the sync log (best-effort).
  try {
    await admin.from("bridge_sync_events").insert({
      direction: "pull",
      entity: entity === "referrals" ? "investigations" : "patients", // enum only has 2 values
      record_count: applied,
      actor_role: bridgeSystemActor.role,
      actor_email: bridgeSystemActor.email,
    });
  } catch {
    // ignore logging failure
  }

  return { applied, failed, errors };
}
