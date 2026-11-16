// Server-only bed-collision check shared by the app and the bridge.
// Scoped to ONE unit and compared with normalizeBed (trim + upper-case, the
// same rule as the database's unique active-bed index). Reads only id + bed —
// no names, numbers or clinical fields are fetched or decrypted.
import { normalizeBed } from "@/lib/icu-beds";

export const ACTIVE_BED_STATUSES = ["admitted", "referred"] as const;
const MAX_ACTIVE_ROWS = 1000;

export class BedCheckError extends Error {
  constructor() {
    super("bed_check_unavailable");
  }
}

/** True when another active ICU patient in `unitId` already holds `bed`. */
export async function bedTakenInUnit(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  unitId: string,
  bed: string | null | undefined,
  excludeId: string | null,
): Promise<boolean> {
  const key = normalizeBed(bed);
  if (!key) return false;
  const { data, error } = await client
    .from("patients")
    .select("id, bed")
    .eq("unit_id", unitId)
    .eq("location_type", "icu")
    .in("status", ACTIVE_BED_STATUSES as unknown as string[])
    .not("bed", "is", null)
    .limit(MAX_ACTIVE_ROWS);
  if (error || !Array.isArray(data)) throw new BedCheckError();
  return (data as Array<{ id: string; bed: string | null }>).some(
    (r) => r.id !== excludeId && normalizeBed(r.bed) === key,
  );
}

/** Would this (merged) row occupy a bed? */
export function occupiesBed(row: Record<string, unknown>): boolean {
  return (
    row.location_type === "icu" &&
    (ACTIVE_BED_STATUSES as readonly string[]).includes(String(row.status)) &&
    normalizeBed(row.bed) !== ""
  );
}

/** The unique active-bed index rejected a write (staged migration). */
export function isBedUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string; details?: string } | null;
  return (
    e?.code === "23505" &&
    /patients_active_unit_bed_uniq/.test(`${e?.message ?? ""} ${e?.details ?? ""}`)
  );
}
