import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { decryptPatientRows, withCryptoColumns } from "@/lib/patient-crypto.server";
import { safeDbError } from "@/lib/db-error";
import { assertConfigAdmin } from "@/lib/roles.server";

// Governance layer for cross-project sharing: an administrator explicitly marks
// which patient records may be read by the linked partner app. The bridge
// endpoints only expose patients whose `shared_with_partner` flag is true, so
// this is the single control that decides what care data leaves this backend.
//
// Only administrators may change it: a unit administrator for patients in their
// own units, a Trust administrator anywhere. The database enforces the same rule
// with a BEFORE UPDATE trigger (patients_guard_share_flag) that calls
// private.can_admin_unit, so the flag can never be flipped through a direct Data
// API call, and RLS limits which patients each administrator can even see.

export type PatientSharingRow = {
  id: string;
  full_name: string;
  hospital_number: string | null;
  ward: string | null;
  bed: string | null;
  location_type: string | null;
  status: string;
  shared_with_partner: boolean;
  shared_with_partner_at: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function assertAdmin(context: { supabase: any; userId: string }) {
  await assertConfigAdmin(context);
}

// Admin-only list used by the bulk sharing manager. Returns just the fields the
// manager needs to identify a patient and show its current sharing state.
export const listPatientSharing = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PatientSharingRow[]> => {
    await assertAdmin(context);
    const { data, error } = await context.supabase
      .from("patients")
      .select(
        withCryptoColumns(
          "id, full_name, hospital_number, ward, bed, location_type, status, shared_with_partner, shared_with_partner_at",
        ),
      )
      .order("shared_with_partner", { ascending: false });
    if (error) throw safeDbError(error, "load patient sharing");
    // Initials live in an encrypted column, so ordering happens after decryption.
    return (decryptPatientRows(data as unknown as Array<Record<string, unknown>> | null) as unknown as PatientSharingRow[]).sort(
      (a, b) =>
        Number(b.shared_with_partner) - Number(a.shared_with_partner) ||
        (a.full_name ?? "").localeCompare(b.full_name ?? ""),
    );
  });

// Admin-only: turn sharing on/off for one or many patients at once. The
// single-patient toggle on the detail page calls this with one id; the bulk
// manager calls it with a selection.
export const setPatientsShared = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(500),
        shared: z.boolean(),
      })
      .parse(input),
  )
  .handler(async ({ data, context }): Promise<{ updated: number }> => {
    await assertAdmin(context);
    const { data: rows, error } = await context.supabase
      .from("patients")
      .update({ shared_with_partner: data.shared })
      .in("id", data.ids)
      .select("id");
    if (error) throw safeDbError(error, "update patient sharing");
    return { updated: rows?.length ?? 0 };
  });
