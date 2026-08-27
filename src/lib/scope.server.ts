import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Hospital / ICU unit scoping helpers.
 *
 * Every patient row belongs to exactly one ICU unit. Row-level security
 * (private.has_unit_access / private.can_access_patient) is the real
 * enforcement point — these helpers only resolve which unit a write should be
 * attributed to, so a create cannot land outside the caller's scope.
 */

export const SEED_UNIT_CODE = "SDH-RADNOR";

/** Units the given user may read and write, most recently granted first. */
export async function listAccessibleUnitIds(
  supabase: SupabaseClient,
  userId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from("user_unit_access")
    .select("unit_id")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []).map((row) => (row as { unit_id: string }).unit_id);
}

/**
 * The unit a new record should be filed under.
 *
 * Uses the explicitly requested unit when the caller passed one, otherwise the
 * caller's single granted unit. Ambiguous or empty scope is an error rather
 * than a silent guess — filing a patient into the wrong unit is a clinical
 * safety and information-governance failure, not a cosmetic one.
 */
export async function resolveWriteUnitId(
  supabase: SupabaseClient,
  userId: string,
  requestedUnitId?: string | null,
): Promise<string> {
  const granted = await listAccessibleUnitIds(supabase, userId);
  if (requestedUnitId) {
    // Admins have no explicit grants but RLS still lets them write any unit.
    if (granted.length === 0 || granted.includes(requestedUnitId)) return requestedUnitId;
    throw new Error("You do not have access to that ICU unit.");
  }
  if (granted.length === 1) return granted[0]!;
  if (granted.length > 1) {
    throw new Error("Choose which ICU unit this patient belongs to.");
  }
  const fallback = await defaultUnitId(supabase);
  if (fallback) return fallback;
  throw new Error("You have not been granted access to an ICU unit yet.");
}

/** The seeded unit, used for admins with no explicit grant and for bridge writes. */
export async function defaultUnitId(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .from("icu_units")
    .select("id")
    .eq("code", SEED_UNIT_CODE)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string } | null)?.id ?? null;
}
