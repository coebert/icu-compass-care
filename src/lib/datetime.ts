import { z } from "zod";

/**
 * Canonical stored form for date+time values in this app: a full ISO 8601 UTC
 * timestamp (e.g. "2026-07-11T22:00:00.000Z").
 *
 * This is the only form that round-trips losslessly through Postgres
 * `timestamptz` columns. A naive wall-clock string like "2026-07-11T23:00"
 * (what the old `<input type="datetime-local">` / picker emitted) is silently
 * reinterpreted as UTC on write and then shifts by the local (London) offset
 * when read back and displayed — so 23:00 entered would reappear as 00:00.
 * Storing an absolute UTC instant keeps entry and display identical.
 *
 * Accepts any string `new Date()` can parse — a full ISO instant, or a naive
 * `yyyy-MM-ddTHH:mm` from an older client — and returns the canonical UTC
 * instant. Returns `null` for empty/blank input, and `null` for unparseable
 * input so callers can validate.
 */
export function toCanonicalTimestamp(input?: string | null): string | null {
  if (input == null) return null;
  const s = String(input).trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** True when `input` is absent/blank or a value `new Date()` can parse. */
export function isValidTimestamp(input?: string | null): boolean {
  if (input == null) return true;
  const s = String(input).trim();
  if (!s) return true;
  return !Number.isNaN(new Date(s).getTime());
}

/** Required timestamp: non-empty, parseable, normalised to canonical UTC ISO. */
export const zTimestamp = z
  .string()
  .refine((v) => toCanonicalTimestamp(v) !== null, {
    message: "A valid date and time is required",
  })
  .transform((v) => toCanonicalTimestamp(v) as string);

/** Optional/nullable timestamp: null/blank → null, otherwise canonical UTC ISO. */
export const zTimestampNullish = z
  .string()
  .nullish()
  .refine((v) => v == null || v === "" || isValidTimestamp(v), {
    message: "Invalid date and time",
  })
  .transform((v) => toCanonicalTimestamp(v ?? null));
