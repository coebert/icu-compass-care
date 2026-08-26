import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { decryptPatientRows, withCryptoColumns } from "@/lib/patient-crypto.server";
import { safeDbError } from "@/lib/db-error";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { missingCriticalFields } from "@/lib/handover-validation";

/**
 * Server-side guard for handover PDF generation.
 *
 * The PDF itself is rendered in the browser, but a user could bypass the UI's
 * amber "Missing" warning (e.g. by calling the export directly). This server
 * function is the authoritative check: it re-loads the requested patients from
 * the database (RLS-scoped to the caller) and rejects the whole request if any
 * patient is missing a critical field. The client MUST await a successful
 * response before building the PDF.
 */
export const validateHandoverExport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patientIds: string[] }) =>
    z
      .object({
        patientIds: z.array(z.string().uuid()).min(1).max(500),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("patients")
      .select(
        withCryptoColumns("id, full_name, hospital_number, ward, bed, current_admission"),
      )
      .in("id", data.patientIds);
    if (error) throw safeDbError(error);

    const found = new Map(
      decryptPatientRows(rows as unknown as Array<Record<string, unknown>> | null).map((r) => [
        r.id as string,
        r as { id: string; full_name?: string | null },
      ]),
    );

    // Any requested id that RLS/deletion hides is treated as an incomplete
    // record so we never silently export a patient we cannot verify.
    const problems = data.patientIds.map((id) => {
      const patient = found.get(id);
      return {
        patientId: id,
        name: patient?.full_name?.trim() || null,
        missing: patient
          ? missingCriticalFields(patient)
          : ["Patient record"],
      };
    });

    const blocking = problems.filter((p) => p.missing.length > 0);
    if (blocking.length > 0) {
      throw new Error(
        `Handover export blocked: ${blocking.length} patient(s) missing critical fields. ` +
          blocking
            .map(
              (p) =>
                `${p.name ?? p.patientId}: ${p.missing.join(", ")}`,
            )
            .join("; "),
      );
    }

    return { ok: true as const, validated: problems.length };
  });
