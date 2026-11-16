// Browser-safe vocabulary for atomic bed moves (move / swap / undo), shared
// by the board and the server function. The database routine
// public.move_patient_beds (staged migration 0005) does the work in one
// transaction; there is deliberately NO fallback to separate updates.

export type BedMove = {
  id: string;
  expected_updated_at: string;
  location_type: "icu" | "outlier";
  bed: string | null;
};

export type BedMoveResult = {
  id: string;
  bed: string | null;
  location_type: "icu" | "outlier";
  updated_at: string;
  previous_bed: string | null;
  previous_location_type: "icu" | "outlier";
  previous_updated_at: string;
};

export type BedMoveErrorCode =
  | "conflict"
  | "bed_occupied"
  | "not_found"
  | "not_authorised"
  | "not_eligible"
  | "unknown_bed"
  | "isolation_side_room_only"
  | "not_a_swap"
  | "no_change"
  | "invalid_request"
  | "unavailable"
  | "failed";

export const BED_MOVE_MESSAGES: Record<BedMoveErrorCode, string> = {
  conflict:
    "Someone else changed this patient's bed since you loaded the board. The board has been refreshed — check it and try again.",
  bed_occupied: "That bed has just been taken. The board has been refreshed — check it and try again.",
  not_found: "That patient isn't available to you any more. The board has been refreshed.",
  not_authorised: "Your session isn't active. Unlock or sign in again, then retry.",
  not_eligible: "Only admitted or referred patients can be placed in an ICU bed.",
  unknown_bed: "That bed isn't on the unit's bed list.",
  isolation_side_room_only: "This patient needs isolation, so they can only go in a side room.",
  not_a_swap: "Those two patients can't be swapped as requested. Refresh and try again.",
  no_change: "The patient is already in that bed.",
  invalid_request: "That move couldn't be understood. Refresh and try again.",
  unavailable:
    "Moving and swapping beds is switched off until a pending update is installed. Nothing was changed.",
  failed: "The move couldn't be saved. Nothing was changed — please try again.",
};

/** Message prefix the client uses to recognise a bed-move refusal. */
export const BED_MOVE_PREFIX = "BED_MOVE:";

/** Codes after which the board must refetch before the user retries. */
export const BED_MOVE_RELOAD: ReadonlySet<BedMoveErrorCode> = new Set([
  "conflict",
  "bed_occupied",
  "not_found",
  "not_a_swap",
]);

const KNOWN = new Set(Object.keys(BED_MOVE_MESSAGES));

/** Map a database error (code + message only) to a safe code. */
export function bedMoveErrorCode(err: { code?: string; message?: string } | null): BedMoveErrorCode {
  const code = err?.code ?? "";
  const msg = (err?.message ?? "").trim();
  // Routine not installed yet: PostgREST "not found in schema cache" / Postgres undefined_function.
  if (code === "PGRST202" || code === "42883") return "unavailable";
  if (/^PT\d{3}$/.test(code) && KNOWN.has(msg)) return msg as BedMoveErrorCode;
  if (code === "23505") return "bed_occupied";
  return "failed";
}

export function bedMoveError(code: BedMoveErrorCode): Error {
  return new Error(`${BED_MOVE_PREFIX}${code}`);
}

/** Client side: decode a thrown server error into a code + safe message. */
export function readBedMoveError(e: unknown): { code: BedMoveErrorCode; message: string } {
  const raw = e instanceof Error ? e.message : String(e ?? "");
  const code = raw.startsWith(BED_MOVE_PREFIX) ? (raw.slice(BED_MOVE_PREFIX.length) as BedMoveErrorCode) : "failed";
  const safe = KNOWN.has(code) ? code : "failed";
  return { code: safe, message: BED_MOVE_MESSAGES[safe] };
}

/** Build the request to put things back after a move, checked against the post-move revision. */
export function undoMoves(results: readonly BedMoveResult[]): BedMove[] {
  return results.map((r) => ({
    id: r.id,
    expected_updated_at: r.updated_at,
    location_type: r.previous_location_type,
    bed: r.previous_bed,
  }));
}
