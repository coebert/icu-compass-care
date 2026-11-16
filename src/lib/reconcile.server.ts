// Server-only cross-project reconciliation review.
//
// Compares LOCAL rows against the PARTNER's copy, keyed by stable id.
// Referrals are classified the way the checked import would treat them,
// using the import ledger (staged 0010 read helper): equal content is not
// "in sync" unless the import owns the local copy, and a recorded partner
// deletion is not "only on partner". Ownership conflicts are shown for a
// person to review; nothing here adopts, overwrites, deletes or merges.
// This app owns its own records: a referral only here is not waiting for
// the partner.
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
  type LegacyReview,
} from "@/lib/bridge-client.server";
import { ContractError, mapReferral, tsKey, type ImportedReferral } from "@/lib/bridge-contract";
import { importReferrals, ImportStepError } from "@/lib/bridge-import.server";
import { SYNC_ERROR_TEXT } from "@/lib/sync-status";
import { safeDbError } from "@/lib/db-error";
import type {
  ReconEntity,
  EntityRecon,
  ReconRow,
  ReconcileResult,
} from "@/lib/reconcile.functions";
import { getAdmin } from "@/lib/admin-db.server";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;
type Record0 = Record<string, unknown>;

function ms(iso: string | null | undefined): number {
  return iso ? Date.parse(iso) : 0;
}

const REFERRAL_CONTENT_FIELDS = [
  "deleted_at",
  "status",
  "referral_received_at",
  "age",
  "sex",
  "current_ward",
  "current_bed",
  "referring_specialty",
  "reason_category",
  "ceiling_of_care",
  "resus_status",
  "dnacpr_respect",
  "anticipated_interventions",
  "allergies",
  "weight_kg",
  "admission_urgency",
  "infection_status",
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

/** Review-page-only failures (never stored in sync events). */
export const REVIEW_ERROR_TEXT = {
  ownership_unavailable:
    "Referrals can't be compared yet: the pending import update hasn't been applied, so it can't be checked which copies the import owns. Nothing is shown as in sync.",
  local_truncated:
    "This app has too many records to compare in one go, so the list isn't shown as complete.",
  local_read_failed: "Local records could not be read for comparison.",
} as const;
export class ReviewError extends Error {
  constructor(readonly code: keyof typeof REVIEW_ERROR_TEXT) {
    super(code);
    this.name = "ReviewError";
  }
}

type DbErr = { code?: string } | null | undefined;
const helperMissing = (err: DbErr) => err?.code === "PGRST202" || err?.code === "42883";

// Upper bound on local rows compared. Above it the review refuses rather than
// reporting false "only on one side" / "in sync".
export const LOCAL_REVIEW_LIMIT = 5000;
/** Page size for keyset reads; a REST row cap below this just means more pages. */
export const LOCAL_REVIEW_PAGE = 1000;
/** A row cap so small that this many pages can't reach the limit is refused. */
export const LOCAL_REVIEW_MAX_PAGES = 50;

/**
 * Read every local row by id keyset, page after page, until an EMPTY page.
 * A REST row cap (max_rows) silently shortens a single `.limit(n)` read, so
 * a short page is never taken as proof of the end.
 */
export async function readLocalBounded(
  admin: Admin,
  table: string,
  columns: string,
): Promise<Record0[]> {
  const out: Record0[] = [];
  let after: string | null = null;
  for (let page = 0; page < LOCAL_REVIEW_MAX_PAGES; page++) {
    let q = admin.from(table).select(columns).order("id", { ascending: true });
    if (after !== null) q = q.gt("id", after);
    const res = await q.limit(LOCAL_REVIEW_PAGE);
    if (res.error) throw safeDbError(res.error, "read local records for reconciliation");
    if (!Array.isArray(res.data)) throw new ReviewError("local_read_failed");
    if (res.data.length === 0) return out;
    if (res.data.length > LOCAL_REVIEW_PAGE) throw new ReviewError("local_read_failed");
    const last = String((res.data[res.data.length - 1] as Record0).id).toLowerCase();
    if (after !== null && !(last > after)) throw new ReviewError("local_read_failed");
    out.push(...(res.data as Record0[]));
    if (out.length > LOCAL_REVIEW_LIMIT) throw new ReviewError("local_truncated");
    after = last;
  }
  throw new ReviewError("local_truncated");
}

type ReviewSpec = {
  entity: "notifications" | "audit_log";
  table: string;
  localColumns: string;
  fetchRemote: () => Promise<LegacyReview>;
  // Version marker shown to the reviewer (null = append-only / no version).
  version: (r: Record0) => string | null;
  label: (r: Record0) => string;
  sub: (r: Record0) => string;
};

// Only what a reviewer needs to tell rows apart: no message text, no diffs.
const REVIEW_SPECS: ReviewSpec[] = [
  {
    entity: "notifications",
    table: "notifications",
    localColumns: "id, kind, read_at, created_at",
    fetchRemote: fetchPartnerNotificationsForReview,
    version: (r) => (r.read_at as string) ?? (r.created_at as string) ?? null,
    label: (r) => String(r.kind ?? "notification"),
    sub: () => "",
  },
  {
    entity: "audit_log",
    table: "audit_log",
    localColumns: "id, action, entity, entity_id",
    fetchRemote: fetchPartnerAuditLogForReview,
    version: () => null, // append-only: presence-only comparison
    label: (r) => `${r.action ?? "?"} · ${r.entity ?? "?"}`,
    sub: (r) => String(r.entity_id ?? ""),
  },
];

function safeText(e: unknown): string {
  if (e instanceof ReviewError) return REVIEW_ERROR_TEXT[e.code];
  if (e instanceof BridgeFetchError || e instanceof ContractError || e instanceof ImportStepError) {
    return SYNC_ERROR_TEXT[e.code];
  }
  return "Records could not be compared right now.";
}

const STATE_ORDER: Record<ReconRow["state"], number> = {
  conflict: 0,
  held: 1,
  diverged: 2,
  remote_only: 3,
  local_only: 4,
  matched: 5,
};
function sortRows(rows: ReconRow[]): ReconRow[] {
  return rows.sort(
    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || ms(b.remoteVersion) - ms(a.remoteVersion),
  );
}

async function compareReviewOnly(admin: Admin, spec: ReviewSpec): Promise<EntityRecon> {
  const [remote, local] = await Promise.all([
    spec.fetchRemote(),
    readLocalBounded(admin, spec.table, spec.localColumns),
  ]);
  const localById = new Map(local.map((r) => [String(r.id).toLowerCase(), r]));
  const remoteById = new Map(remote.records.map((r) => [String(r.id).toLowerCase(), r]));
  const allIds = new Set<string>([...localById.keys(), ...remoteById.keys()]);
  const mismatches: ReconRow[] = [];
  let matched = 0;
  for (const id of allIds) {
    const l = localById.get(id);
    const r = remoteById.get(id);
    const source = r ?? l!;
    const base = {
      id,
      label: spec.label(source),
      sub: spec.sub(source),
      localVersion: l ? spec.version(l) : null,
      remoteVersion: r ? spec.version(r) : null,
      pullable: false,
    };
    if (l && !r) {
      mismatches.push({
        ...base,
        state: "local_only",
        reason: remote.complete ? "review_only" : "partner_list_unconfirmed",
      });
    } else if (!l && r) mismatches.push({ ...base, state: "remote_only", reason: "review_only" });
    else if (spec.version(l!) === spec.version(r!)) matched++;
    else mismatches.push({ ...base, state: "diverged", reason: "review_only" });
  }
  return {
    entity: spec.entity,
    localCount: local.length,
    remoteCount: remote.records.length,
    matched,
    mismatches: sortRows(mismatches),
    importable: false,
    partnerListComplete: remote.complete,
  };
}

// ------------------------------------------------------------- referrals ---

export type ReviewProvenance = {
  source_revision: string;
  /** Only a tombstone watermark: no local row was ever written by the import. */
  watermark: boolean;
  /** The local row is still exactly what the import last wrote. */
  receiver_matches: boolean;
} | null;

type Verdict = { state: ReconRow["state"]; reason: ReconRow["reason"]; pullable: boolean };

/**
 * What the checked import (staged bridge_import_referral) would do with the
 * partner's copy, in the same order of checks, so the review never promises
 * a pull that the import will refuse or calls an untrusted copy "in sync".
 * null = nothing to show (a watermark with nothing on either side).
 */
export function classifyReferral(
  local: Record0 | null,
  prov: ReviewProvenance,
  remote: Record0 | null,
): Verdict | null {
  if (!remote) {
    if (!local) return null;
    return {
      state: "local_only",
      reason: prov && !prov.watermark ? "imported_not_listed" : "local_record",
      pullable: false,
    };
  }
  const tomb = remote.deleted_at != null;
  const fresh: Verdict = {
    state: "remote_only",
    reason: tomb ? "partner_deletion" : "new_on_partner",
    pullable: true,
  };
  if (!prov) {
    // Equal content is NOT enough: the import refuses a copy it didn't write.
    if (local) return { state: "conflict", reason: "not_imported", pullable: false };
    return fresh;
  }
  const rRev = tsKey(remote.updated_at);
  const pRev = tsKey(prov.source_revision);
  if (rRev === null || pRev === null) throw new ReviewError("local_read_failed");
  if (prov.watermark) {
    if (local) return { state: "conflict", reason: "watermark_reused", pullable: false };
    if (rRev <= pRev) {
      return tomb
        ? { state: "matched", reason: "partner_deletion", pullable: false }
        : { state: "held", reason: "deletion_stands", pullable: false };
    }
    return fresh;
  }
  if (!local) return { state: "conflict", reason: "local_missing", pullable: false };
  if (!prov.receiver_matches) return { state: "conflict", reason: "local_edit", pullable: false };
  if (referralContentKey(local) === referralContentKey(remote)) {
    return { state: "matched", reason: "partner_newer", pullable: false };
  }
  if (rRev <= pRev) return { state: "held", reason: "partner_not_newer", pullable: false };
  return { state: "diverged", reason: "partner_newer", pullable: true };
}

type ReviewRow = {
  id: string;
  local: Record0 | null;
  local_updated_at: string | null;
  provenance: ReviewProvenance;
};

function parseReview(data: unknown): ReviewRow[] {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ReviewError("local_read_failed");
  }
  const d = data as { complete?: unknown; rows?: unknown };
  if (d.complete === false) throw new ReviewError("local_truncated");
  if (d.complete !== true || !Array.isArray(d.rows)) throw new ReviewError("local_read_failed");
  if (d.rows.length > LOCAL_REVIEW_LIMIT) throw new ReviewError("local_truncated");
  for (const r of d.rows as Record0[]) {
    const p = r?.provenance as Record0 | null | undefined;
    if (
      !r ||
      typeof r.id !== "string" ||
      (r.local !== null && (typeof r.local !== "object" || Array.isArray(r.local))) ||
      (p != null &&
        (typeof p.source_revision !== "string" ||
          typeof p.watermark !== "boolean" ||
          typeof p.receiver_matches !== "boolean"))
    ) {
      throw new ReviewError("local_read_failed");
    }
  }
  return d.rows as ReviewRow[];
}

async function compareReferrals(admin: Admin): Promise<EntityRecon> {
  const [remote, reviewRes] = await Promise.all([
    // Validated v1 snapshot, allowlist-mapped: no raw partner row is used.
    fetchSyncV1("referrals").then((s) => s.records.map((r) => mapReferral(r) as Record0)),
    // One statement, one jsonb value: a REST row cap can't shorten it.
    admin.rpc("bridge_referral_review", { _limit: LOCAL_REVIEW_LIMIT }),
  ]);
  if (reviewRes.error) {
    if (helperMissing(reviewRes.error)) throw new ReviewError("ownership_unavailable");
    throw safeDbError(reviewRes.error, "read local records for reconciliation");
  }
  const rows = parseReview(reviewRes.data);
  const localById = new Map(rows.map((r) => [r.id.toLowerCase(), r]));
  const remoteById = new Map(remote.map((r) => [String(r.id).toLowerCase(), r]));
  const allIds = new Set<string>([...localById.keys(), ...remoteById.keys()]);
  const mismatches: ReconRow[] = [];
  let matched = 0;
  for (const id of allIds) {
    const lr = localById.get(id);
    const local = lr?.local ?? null;
    const remoteRow = remoteById.get(id) ?? null;
    const v = classifyReferral(local, lr?.provenance ?? null, remoteRow);
    if (!v) continue;
    if (v.state === "matched") {
      matched++;
      continue;
    }
    const shown = remoteRow && remoteRow.deleted_at == null ? remoteRow : local;
    mismatches.push({
      id,
      label: String(shown?.referring_specialty ?? "Referral"),
      sub:
        remoteRow?.deleted_at != null
          ? "removed in Critical Care Connect"
          : String((shown?.deleted_at ? "removed here" : shown?.status) ?? ""),
      localVersion: lr?.local_updated_at ?? null,
      remoteVersion: remoteRow ? String(remoteRow.updated_at) : null,
      ...v,
    });
  }
  return {
    entity: "referrals",
    localCount: rows.filter((r) => r.local !== null).length,
    remoteCount: remote.length,
    matched,
    mismatches: sortRows(mismatches),
    importable: true,
    partnerListComplete: true, // sync v1 proves completeness or fails
  };
}

const ENTITY_ORDER: ReconEntity[] = ["notifications", "referrals", "audit_log"];

export async function buildReconciliation(): Promise<EntityRecon[]> {
  const admin = await getAdmin();
  const out: EntityRecon[] = [];
  for (const entity of ENTITY_ORDER) {
    const spec = REVIEW_SPECS.find((s) => s.entity === entity);
    try {
      out.push(spec ? await compareReviewOnly(admin, spec) : await compareReferrals(admin));
    } catch (e) {
      out.push({
        entity,
        localCount: 0,
        remoteCount: 0,
        matched: 0,
        mismatches: [],
        importable: entity === "referrals",
        partnerListComplete: false,
        // Never surface raw partner/DB text (it can carry record values).
        error: safeText(e),
      });
    }
  }
  return out;
}

export const PULL_NOT_LISTED_TEXT =
  "Some chosen referrals are no longer in Critical Care Connect's list, so nothing was pulled for them.";

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
  const errors: string[] = [];
  if (ids !== "all") {
    const want = new Set(ids.map((i) => i.toLowerCase()));
    records = records.filter((r) => want.has(String(r.id).toLowerCase()));
    if (records.length < want.size) errors.push(PULL_NOT_LISTED_TEXT);
  }
  try {
    const c = await importReferrals(admin, records);
    if (c.conflicts > 0) errors.push(SYNC_ERROR_TEXT.record_conflict);
    if (c.failed > 0) errors.push(SYNC_ERROR_TEXT.partial_write_failure);
    return {
      applied: c.applied,
      failed: c.failed,
      skipped: c.skipped,
      conflicts: c.conflicts,
      errors,
    };
  } catch (e) {
    return { applied: 0, failed: 0, skipped: 0, conflicts: 0, errors: [safeText(e)] };
  }
}
