// Pure, client-safe validators for what Critical Care Connect (CCC) sends us.
// No I/O. Every failure is a safe code — never row values.
//
// Two shapes exist:
//  - sync v1 (scheduled imports): GET /api/public/bridge/<resource>?sync=1&limit=500
//    -> { schema_version: 1, records: [...], snapshot_at, pagination: { next_cursor, complete } }
//  - legacy review feeds (audit / notifications): { records: [...] }
// A missing or wrong list is NEVER treated as "no records".
import type { SyncErrorCode } from "@/lib/sync-status";

export class ContractError extends Error {
  constructor(readonly code: SyncErrorCode) {
    super(code);
    this.name = "ContractError";
  }
}
const fail = (code: SyncErrorCode): never => {
  throw new ContractError(code);
};

export const SYNC_V1_PAGE_LIMIT = 500;
export const SYNC_V1_BUDGET = {
  maxPages: 60,
  maxRecords: 25_000,
  maxMillis: 50_000,
  requestTimeoutMs: 15_000,
  maxPageBytes: 8 * 1024 * 1024,
} as const;
/** Rows requested from a legacy review feed (sent as ?limit=). */
export const LEGACY_REVIEW_LIMIT = 200;
const MAX_CURSOR_LENGTH = 1024;
const CURSOR_RE = /^[A-Za-z0-9._~+/=:-]+$/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Full instant with an explicit zone; up to microseconds (Postgres precision).
const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

/**
 * Microsecond-exact sort key for a timestamp (JS Date alone drops µs, which
 * would make distinct Postgres revisions look equal). null when invalid.
 */
export function tsKey(v: unknown): bigint | null {
  if (typeof v !== "string") return null;
  const m = ISO_RE.exec(v.replace(" ", "T"));
  if (!m) return null;
  const ms = Date.parse(`${m[1]}${m[3]}`);
  if (!Number.isFinite(ms)) return null;
  // Reject impossible calendar values that Date silently rolls over.
  const [, base] = m;
  const back = new Date(Date.parse(`${base}Z`)).toISOString().slice(0, 19);
  if (back !== base) return null;
  const frac = (m[2] ?? "").padEnd(6, "0");
  return BigInt(ms) * 1000n + BigInt(frac);
}
export const isInstant = (v: unknown): v is string => tsKey(v) !== null;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// ---------------------------------------------------------------- sync v1 ---

export type SyncPage = {
  records: Record<string, unknown>[];
  snapshotAt: string;
  nextCursor: string | null;
  complete: boolean;
};

/** Validate one page envelope (not the rows themselves). */
export function parseSyncPage(body: unknown, limit = SYNC_V1_PAGE_LIMIT): SyncPage {
  if (!isPlainObject(body)) return fail("contract_mismatch");
  if (body.schema_version !== 1) return fail("contract_mismatch");
  if (!Array.isArray(body.records)) return fail("contract_mismatch");
  if (!isInstant(body.snapshot_at)) return fail("contract_mismatch");
  const pg = body.pagination;
  if (!isPlainObject(pg) || typeof pg.complete !== "boolean") return fail("contract_mismatch");
  const next = pg.next_cursor;
  if (!(next === null || typeof next === "string")) return fail("contract_mismatch");
  if (pg.complete && next !== null) return fail("pagination_invalid");
  if (!pg.complete && next === null) return fail("pagination_invalid");
  if (
    typeof next === "string" &&
    (next.length === 0 || next.length > MAX_CURSOR_LENGTH || !CURSOR_RE.test(next))
  ) {
    return fail("pagination_invalid");
  }
  if (body.records.length > limit) return fail("pagination_invalid");
  // An incomplete page with nothing on it cannot make progress.
  if (!pg.complete && body.records.length === 0) return fail("pagination_invalid");
  for (const r of body.records) if (!isPlainObject(r)) return fail("malformed_record");
  return {
    records: body.records as Record<string, unknown>[],
    snapshotAt: body.snapshot_at as string,
    nextCursor: next as string | null,
    complete: pg.complete,
  };
}

/**
 * Accumulates pages and enforces the cross-page rules: one snapshot, strictly
 * progressing (updated_at, id) order, no repeated cursor or id, budgets.
 * Nothing is written until finish() returns the whole validated set.
 */
export class SyncPageCollector {
  private records: Record<string, unknown>[] = [];
  private snapshotAt: string | null = null;
  private snapshotKey: bigint | null = null;
  private cursors = new Set<string>();
  private ids = new Set<string>();
  private lastKey: { ts: bigint; id: string } | null = null;
  private pages = 0;
  private done = false;
  private readonly started: number;

  constructor(
    private readonly budget: {
      maxPages: number;
      maxRecords: number;
      maxMillis: number;
    } = SYNC_V1_BUDGET,
    private readonly now: () => number = Date.now,
  ) {
    this.started = now();
  }

  /** Returns the cursor for the next request, or null when complete. */
  add(page: SyncPage): string | null {
    if (this.done) return fail("pagination_invalid");
    this.pages++;
    if (this.pages > this.budget.maxPages) return fail("budget_exceeded");
    if (this.now() - this.started > this.budget.maxMillis) return fail("budget_exceeded");
    if (this.snapshotAt === null) {
      this.snapshotAt = page.snapshotAt;
      this.snapshotKey = tsKey(page.snapshotAt);
    } else if (tsKey(page.snapshotAt) !== this.snapshotKey) {
      return fail("snapshot_changed");
    }
    for (const r of page.records) {
      if (!isUuid(r.id)) return fail("malformed_record");
      const ts = tsKey(r.updated_at);
      if (ts === null) return fail("malformed_record");
      if (ts > (this.snapshotKey as bigint)) return fail("pagination_invalid");
      const id = (r.id as string).toLowerCase();
      if (this.ids.has(id)) return fail("pagination_invalid");
      if (
        this.lastKey &&
        (ts < this.lastKey.ts || (ts === this.lastKey.ts && id <= this.lastKey.id))
      ) {
        return fail("pagination_invalid");
      }
      this.ids.add(id);
      this.lastKey = { ts, id };
      this.records.push(r);
    }
    if (this.records.length > this.budget.maxRecords) return fail("budget_exceeded");
    if (page.complete) {
      this.done = true;
      return null;
    }
    const next = page.nextCursor as string;
    if (this.cursors.has(next)) return fail("pagination_invalid");
    this.cursors.add(next);
    return next;
  }

  finish(): { records: Record<string, unknown>[]; snapshotAt: string } {
    if (!this.done || this.snapshotAt === null) return fail("pagination_invalid");
    return { records: this.records, snapshotAt: this.snapshotAt };
  }
}

// ----------------------------------------------------------- legacy review ---

/**
 * Legacy `{ records: [...] }` review feed (audit / notifications). Read-only.
 *
 * The request asks for at most `limit` rows. A response with MORE rows breaks
 * the contract; a response with EXACTLY `limit` rows may have been cut short,
 * so it is refused unless the partner explicitly proves it is complete
 * (`pagination: { complete: true, next_cursor: null }`). A truncated feed is
 * never shown as empty or complete.
 */
export function parseLegacyRecords(
  body: unknown,
  limit = LEGACY_REVIEW_LIMIT,
): Record<string, unknown>[] {
  return parseLegacyReview(body, limit).records;
}

/**
 * Same checks, plus whether the partner PROVED the list is complete
 * (pagination.complete === true and next_cursor === null). A shorter list
 * without that proof may still have been capped by the partner's own row
 * limit, so a caller must not claim "only here" or "in sync" from it.
 */
export function parseLegacyReview(
  body: unknown,
  limit = LEGACY_REVIEW_LIMIT,
): { records: Record<string, unknown>[]; complete: boolean } {
  if (!isPlainObject(body) || !Array.isArray(body.records)) return fail("malformed_response");
  const pg = body.pagination;
  if (
    body.truncated === true ||
    body.has_more === true ||
    (isPlainObject(pg) &&
      (pg.complete === false || (pg.next_cursor != null && pg.next_cursor !== "")))
  ) {
    return fail("review_truncated");
  }
  if (body.records.length > limit) return fail("budget_exceeded");
  const provenComplete = isPlainObject(pg) && pg.complete === true && pg.next_cursor === null;
  if (body.records.length === limit && !provenComplete) return fail("review_truncated");
  for (const r of body.records) {
    if (!isPlainObject(r) || typeof r.id !== "string" || r.id === "")
      return fail("malformed_record");
  }
  return { records: body.records as Record<string, unknown>[], complete: provenComplete };
}

// ------------------------------------------------------- canonical records ---

const ENUMS = {
  referral_status: ["pending", "declined", "admitted"],
  sex: ["male", "female", "other", "unknown"],
  reason_category: [
    "respiratory_failure",
    "sepsis",
    "shock",
    "post_op",
    "neurology",
    "trauma",
    "gi_bleed",
    "metabolic",
    "overdose",
    "other",
  ],
  ceiling_of_care: ["full_escalation", "no_cpr", "ward_based", "symptom_control", "not_documented"],
  resus_status: ["for_cpr", "dnacpr", "not_documented"],
  admission_urgency: ["within_15_min", "within_30_min", "within_1_hour", "within_1_2_hours"],
  infection_status: ["none", "suspected", "confirmed", "unknown"],
} as const;

type FieldRule = (v: unknown) => boolean;
const nullable =
  (rule: FieldRule): FieldRule =>
  (v) =>
    v === null || rule(v);
const str =
  (max: number): FieldRule =>
  (v) =>
    typeof v === "string" && v.length <= max;
const nonEmptyStr =
  (max: number): FieldRule =>
  (v) =>
    typeof v === "string" && v.trim().length > 0 && v.length <= max;
const int =
  (min: number, max: number): FieldRule =>
  (v) =>
    typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const num =
  (min: number, max: number): FieldRule =>
  (v) =>
    typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const oneOf =
  (vals: readonly string[]): FieldRule =>
  (v) =>
    typeof v === "string" && vals.includes(v);
const bool: FieldRule = (v) => typeof v === "boolean";
const instant: FieldRule = (v) => isInstant(v);
const uuid: FieldRule = (v) => isUuid(v);
const textArray =
  (maxItems: number, maxLen: number): FieldRule =>
  (v) =>
    Array.isArray(v) &&
    v.length <= maxItems &&
    v.every((x) => typeof x === "string" && x.length > 0 && x.length <= maxLen);

/**
 * Referral fields copied into this app. Everything else on the source row —
 * encrypted text (*_enc), lookup hashes (*_hash), source user ids
 * (created_by/updated_by/deleted_by: a different sign-in system), the local
 * post-op booking link (origin_booking_id) and source history links
 * (previous_referral_id) — is dropped. Detailed referral history stays in CCC.
 */
export const REFERRAL_IMPORT_RULES: Record<string, FieldRule> = {
  id: uuid,
  created_at: instant,
  updated_at: instant,
  // Live rows carry deleted_at: null explicitly (tombstones are separate).
  deleted_at: (v) => v === null,
  status: oneOf(ENUMS.referral_status),
  referral_received_at: instant,
  age: nullable(int(0, 130)),
  sex: nullable(oneOf(ENUMS.sex)),
  current_ward: nullable(str(100)),
  current_bed: nullable(str(50)),
  referring_specialty: nullable(str(100)),
  reason_category: nullable(oneOf(ENUMS.reason_category)),
  ceiling_of_care: nullable(oneOf(ENUMS.ceiling_of_care)),
  resus_status: nullable(oneOf(ENUMS.resus_status)),
  dnacpr_respect: bool,
  anticipated_interventions: textArray(20, 50),
  allergies: nullable(str(2000)),
  weight_kg: nullable(num(0.1, 500)),
  admission_urgency: nullable(oneOf(ENUMS.admission_urgency)),
  infection_status: nullable(oneOf(ENUMS.infection_status)),
  news2_score: nullable(int(0, 20)),
};
export const REFERRAL_IMPORT_FIELDS = Object.keys(REFERRAL_IMPORT_RULES);

/** A live referral: every allowlisted field present, deleted_at explicitly null. */
export type ImportedLiveReferral = {
  kind: "live";
  id: string;
  updated_at: string;
  deleted_at: null;
} & Record<string, unknown>;
/** CCC's intentionally minimal tombstone: exactly {id, updated_at, deleted_at}. */
export type ImportedTombstone = {
  kind: "tombstone";
  id: string;
  updated_at: string;
  deleted_at: string;
};
export type ImportedReferral = ImportedLiveReferral | ImportedTombstone;

const TOMBSTONE_KEYS = ["id", "updated_at", "deleted_at"] as const;

/**
 * Validate one sync v1 referral. A row with a non-null deleted_at is a
 * tombstone and is checked as one FIRST (it carries no live fields); every
 * other row must be a complete live row with deleted_at: null. Anything else
 * fails the whole batch before any write.
 */
export function mapReferral(src: Record<string, unknown>): ImportedReferral {
  if (!("deleted_at" in src)) return fail("malformed_record");
  if (src.deleted_at !== null) {
    const keys = Object.keys(src);
    if (keys.length !== TOMBSTONE_KEYS.length || !TOMBSTONE_KEYS.every((k) => k in src)) {
      return fail("malformed_record");
    }
    if (!isUuid(src.id) || !isInstant(src.updated_at) || !isInstant(src.deleted_at)) {
      return fail("malformed_record");
    }
    return {
      kind: "tombstone",
      id: src.id.toLowerCase(),
      updated_at: src.updated_at,
      deleted_at: src.deleted_at,
    };
  }
  const out: Record<string, unknown> = {};
  for (const [k, rule] of Object.entries(REFERRAL_IMPORT_RULES)) {
    if (!(k in src)) return fail("malformed_record");
    const v = src[k];
    if (!rule(v)) return fail("malformed_record");
    out[k] = v;
  }
  out.id = (out.id as string).toLowerCase();
  return { ...out, kind: "live" } as ImportedLiveReferral;
}

/** The exact payload sent to the import helper: allowlisted keys only. */
export function referralImportPayload(r: ImportedReferral): Record<string, unknown> {
  if (r.kind === "tombstone")
    return { id: r.id, updated_at: r.updated_at, deleted_at: r.deleted_at };
  const out: Record<string, unknown> = {};
  for (const k of REFERRAL_IMPORT_FIELDS) out[k] = r[k];
  return out;
}

export type ResultKind = "investigations" | "microbiology";
export type ImportedResult = {
  id: string;
  patient_id: string;
  /** investigations.category or microbiology_results.specimen_type */
  type: string;
  findings: string;
  result_at: string;
  created_at: string;
  updated_at: string;
  deleted: boolean;
};

/**
 * Canonical v1 result rows. Microbiology arrives already projected by CCC
 * (sample_type -> specimen_type, reported_at -> result_at, findings = labelled
 * source narrative); nothing is inferred or defaulted here.
 */
export function mapResult(kind: ResultKind, src: Record<string, unknown>): ImportedResult {
  const typeKey = kind === "investigations" ? "category" : "specimen_type";
  const rules: Record<string, FieldRule> = {
    id: uuid,
    patient_id: uuid,
    [typeKey]: nonEmptyStr(200),
    findings: nonEmptyStr(20_000),
    result_at: instant,
    created_at: instant,
    updated_at: instant,
  };
  for (const [k, rule] of Object.entries(rules)) {
    if (!(k in src) || !rule(src[k])) return fail("malformed_record");
  }
  if ("deleted_at" in src && !(src.deleted_at === null || isInstant(src.deleted_at))) {
    return fail("malformed_record");
  }
  return {
    // A tombstoned result can't be represented here; the importer never
    // inserts it and flags a local copy as a conflict instead.
    deleted: src.deleted_at != null,
    id: (src.id as string).toLowerCase(),
    patient_id: (src.patient_id as string).toLowerCase(),
    type: src[typeKey] as string,
    findings: src.findings as string,
    result_at: src.result_at as string,
    created_at: src.created_at as string,
    updated_at: src.updated_at as string,
  };
}

/** Content equality used to recognise an already-imported identical result. */
export function sameResult(
  a: { patient_id: string; type: string; findings: string; result_at: string },
  b: { patient_id: string; type: string; findings: string; result_at: string },
): boolean {
  return (
    a.patient_id.toLowerCase() === b.patient_id.toLowerCase() &&
    a.type === b.type &&
    a.findings === b.findings &&
    tsKey(a.result_at) === tsKey(b.result_at)
  );
}
