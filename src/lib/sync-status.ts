// Client-safe sync vocabulary shared by the sync job, the status server
// function and the header panel. Error codes are the ONLY error detail ever
// stored or shown — never raw partner responses, row values or DB messages.

export const SYNC_RESOURCES = ["patients", "investigations", "referrals", "microbiology"] as const;
export type SyncResource = (typeof SYNC_RESOURCES)[number];

export const SYNC_ERROR_CODES = [
  "not_configured",
  "partner_unreachable",
  "partner_http_error",
  "malformed_response",
  "malformed_record",
  "local_read_failed",
  "partial_write_failure",
  "contract_mismatch",
  "pagination_invalid",
  "snapshot_changed",
  "budget_exceeded",
  "record_conflict",
  "unlinked_records",
  "import_unavailable",
  "review_truncated",
  "bridge_unit_unavailable",
  "unexpected",
] as const;
export type SyncErrorCode = (typeof SYNC_ERROR_CODES)[number];

export const SYNC_ERROR_TEXT: Record<SyncErrorCode | "unknown", string> = {
  not_configured: "The partner link is not configured.",
  partner_unreachable: "The partner system could not be reached.",
  partner_http_error: "The partner system returned an error.",
  malformed_response: "The partner system sent an unexpected response.",
  malformed_record: "The partner system sent a record in an unexpected format.",
  local_read_failed: "Local records could not be read for comparison.",
  partial_write_failure: "Some records could not be saved. The rest were updated.",
  contract_mismatch:
    "The partner system sent a different data format than agreed. Nothing was imported.",
  pagination_invalid: "The partner system's pages didn't line up. Nothing was imported.",
  snapshot_changed:
    "The partner data changed part-way through. Nothing was imported; it will retry.",
  budget_exceeded: "The partner sent more than one update can safely take. Nothing was imported.",
  record_conflict:
    "Some records differ from the copy here and were not overwritten. The rest were updated.",
  unlinked_records: "Some results are for patients not shared to this unit and were not imported.",
  import_unavailable: "Importing is switched off until a pending database update is applied.",
  review_truncated:
    "The partner's list may have been cut short, so it can't be compared here. It is not shown as complete.",
  bridge_unit_unavailable: "This unit's partner link isn't set up correctly. Nothing was imported.",
  unexpected: "The update stopped unexpectedly.",
  unknown: "The update failed (details withheld).",
};

/** Map any stored error_message to a safe code; legacy free text becomes "unknown". */
export function safeSyncErrorCode(message: unknown): SyncErrorCode | "unknown" {
  return typeof message === "string" && (SYNC_ERROR_CODES as readonly string[]).includes(message)
    ? (message as SyncErrorCode)
    : "unknown";
}

/** Marker on sync events written by THIS app's inbound pull job. Not a bridge
 * READ/WRITE role, so a partner request can never produce an event with it. */
export const INBOUND_SYNC_ACTOR_ROLE = "inbound_sync";

/**
 * Streams this app is the source of truth for. Nothing is imported for them;
 * the partner reads them from here. Shown as "Managed in Handover Hub", never
 * as a sync success or a never-synced alarm.
 */
export const SOURCE_OWNED_RESOURCES: readonly SyncResource[] = ["patients"];
export const isSourceOwned = (r: SyncResource) => SOURCE_OWNED_RESOURCES.includes(r);

/** Codes meaning "some records were not taken", as opposed to a failed pass. */
const INCOMPLETE_CODES = new Set<string>([
  "partial_write_failure",
  "record_conflict",
  "unlinked_records",
]);

export type ResourceEvidence = {
  entity: SyncResource;
  /** Recorded here; never imported. */
  sourceOwned?: boolean;
  /** The evidence query for this resource failed. */
  unavailable: boolean;
  lastAttemptAt: string | null;
  lastAttemptOk: boolean | null;
  lastAttemptCode: SyncErrorCode | "unknown" | null;
  lastSuccessAt: string | null;
  lastSuccessCount: number | null;
};

export type ResourceState =
  | "ok"
  | "source_owned"
  | "delayed"
  | "incomplete"
  | "failed"
  | "never"
  | "unavailable";

export function resourceState(
  r: ResourceEvidence,
  now: number,
  delayedAfterMinutes: number,
): ResourceState {
  if (r.sourceOwned) return "source_owned";
  if (r.unavailable) return "unavailable";
  if (!r.lastAttemptAt) return "never";
  if (r.lastAttemptOk === false) {
    return INCOMPLETE_CODES.has(r.lastAttemptCode ?? "") ? "incomplete" : "failed";
  }
  const last = r.lastSuccessAt ? Date.parse(r.lastSuccessAt) : NaN;
  if (!Number.isFinite(last)) return "never";
  return now - last > delayedAfterMinutes * 60_000 ? "delayed" : "ok";
}

const SEVERITY: Record<ResourceState, number> = {
  ok: 0,
  source_owned: 0,
  delayed: 2,
  never: 2,
  incomplete: 3,
  failed: 4,
  unavailable: 4,
};

/** Worst state wins: one healthy stream can never hide another's failure. */
export function overallState(states: ResourceState[]): ResourceState {
  if (states.length === 0) return "unavailable";
  return states.reduce(
    (worst, s) => (SEVERITY[s] > SEVERITY[worst] ? s : worst),
    "ok" as ResourceState,
  );
}

export const RESOURCE_STATE_TEXT: Record<ResourceState, string> = {
  ok: "Up to date",
  source_owned: "Managed in Handover Hub",
  delayed: "Delayed",
  incomplete: "Incomplete",
  failed: "Last update failed",
  never: "No update recorded",
  unavailable: "Status unavailable",
};
