// Pure, client-safe contract for the fenced partner "ready for ward" update:
//   POST /api/public/bridge/patients/wardable
// Full protocol: docs/bridge/wardable-protocol.md. No I/O here.
import { isInstant, isUuid } from "@/lib/bridge-contract";

/** Fields only this protocol may change; the generic partner POST refuses them. */
export const BRIDGE_WARDABLE_FIELDS = ["wardable", "wardable_at", "wardable_by"] as const;

/** Largest Postgres bigint. Revisions are never converted through JS Number. */
export const MAX_DESIRED_REVISION = 9223372036854775807n;
const CANONICAL_REVISION = /^[1-9][0-9]{0,18}$/;

/** A canonical positive decimal string in 1..2^63-1, or null. */
export function parseDesiredRevision(v: unknown): string | null {
  if (typeof v !== "string" || !CANONICAL_REVISION.test(v)) return null;
  return BigInt(v) <= MAX_DESIRED_REVISION ? v : null;
}

export type WardableRequest = {
  id: string;
  expected_updated_at: string;
  wardable: boolean;
  desired_revision: string;
};
const REQUEST_KEYS = ["id", "expected_updated_at", "wardable", "desired_revision"] as const;

/** Exactly the four agreed keys, each valid. Anything else (incl. wardable_at/_by) is refused. */
export function parseWardableRequest(raw: unknown): WardableRequest | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== REQUEST_KEYS.length || !REQUEST_KEYS.every((k) => k in o)) return null;
  if (!isUuid(o.id)) return null;
  if (typeof o.expected_updated_at !== "string" || o.expected_updated_at.length > 64) return null;
  if (!isInstant(o.expected_updated_at)) return null;
  if (typeof o.wardable !== "boolean") return null;
  const rev = parseDesiredRevision(o.desired_revision);
  if (rev === null) return null;
  return { id: o.id.toLowerCase(), expected_updated_at: o.expected_updated_at, wardable: o.wardable, desired_revision: rev };
}

export const WARDABLE_CONFLICT_CODES = ["superseded", "revision_conflict", "intent_conflict", "target_changed"] as const;
export type WardableConflictCode = (typeof WARDABLE_CONFLICT_CODES)[number];

export type WardablePatient = { id: string; wardable: boolean; wardable_at: string | null; updated_at: string };
export type WardableSuccess = {
  ok: true;
  status: "applied" | "already_applied";
  desired_revision: string;
  patient: WardablePatient;
};
export type WardableConflict = { ok: false; code: WardableConflictCode; desired_revision: string };
export type WardableError = { ok: false; code: "not_found" | "invalid_request" | "unavailable" | "replay" };
export type WardableResponse = WardableSuccess | WardableConflict | WardableError;

/** Map the database helper's jsonb result to the exact HTTP contract. */
export function wardableHttp(result: unknown): { status: number; body: WardableResponse } {
  const unavailable = { status: 503, body: { ok: false as const, code: "unavailable" as const } };
  if (!result || typeof result !== "object") return unavailable;
  const r = result as Record<string, unknown>;
  if (r.ok === true) {
    const p = r.patient as Record<string, unknown> | undefined;
    const rev = parseDesiredRevision(r.desired_revision);
    if (
      (r.status !== "applied" && r.status !== "already_applied") ||
      rev === null ||
      !p ||
      !isUuid(p.id) ||
      typeof p.wardable !== "boolean" ||
      !(p.wardable_at === null || isInstant(p.wardable_at)) ||
      !isInstant(p.updated_at)
    ) {
      return unavailable;
    }
    return {
      status: 200,
      body: {
        ok: true,
        status: r.status,
        desired_revision: rev,
        patient: {
          id: p.id,
          wardable: p.wardable,
          wardable_at: (p.wardable_at as string | null) ?? null,
          updated_at: p.updated_at as string,
        },
      },
    };
  }
  if (r.code === "not_found") return { status: 404, body: { ok: false, code: "not_found" } };
  if ((WARDABLE_CONFLICT_CODES as readonly unknown[]).includes(r.code)) {
    const rev = parseDesiredRevision(r.desired_revision);
    if (rev === null) return unavailable;
    return { status: 409, body: { ok: false, code: r.code as WardableConflictCode, desired_revision: rev } };
  }
  return unavailable;
}

/**
 * Typed reader for the response (what the partner should implement). Any
 * shape outside the contract is "unknown" — treat as an unknown outcome and
 * retry only with the SAME desired_revision and intent.
 */
export function parseWardableResponse(
  status: number,
  body: unknown,
): WardableResponse | { ok: false; code: "unknown" } {
  const b = body as Record<string, unknown> | null;
  if (status === 200 && b?.ok === true) {
    const m = wardableHttp(b);
    return m.status === 200 ? m.body : { ok: false, code: "unknown" };
  }
  if (status === 409 && b?.ok === false && (WARDABLE_CONFLICT_CODES as readonly unknown[]).includes(b.code)) {
    const rev = parseDesiredRevision(b.desired_revision);
    if (rev !== null && !("patient" in b)) return { ok: false, code: b.code as WardableConflictCode, desired_revision: rev };
  }
  if (status === 404 && b?.ok === false && b.code === "not_found") return { ok: false, code: "not_found" };
  if (status === 503) return { ok: false, code: "unavailable" };
  return { ok: false, code: "unknown" };
}
