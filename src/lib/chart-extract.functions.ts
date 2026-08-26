import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  decryptPatientRow,
  decryptPatientRows,
  encryptPatientPayload,
  patientLookupHash,
  withCryptoColumns,
} from "@/lib/patient-crypto.server";
import { safeDbError } from "@/lib/db-error";
import { callGatewayChat } from "@/lib/ai-gateway.server";
import { hourlyCellSchema, type HourlyCell } from "@/lib/chart-days.functions";
import {
  buildChartExtractionMessages,
  scrubExtractionIdentifiers,
} from "@/lib/chart-prompt.server";

/**
 * Chart image extraction — the image is passed to the vision model IN MEMORY
 * only. No storage bucket write, no filesystem write, no logging of the raw
 * bytes. The base64 payload lives on the request only for the duration of the
 * upstream call and is dropped when this handler returns. Callers are
 * responsible for clearing the client-side buffer once the response arrives.
 */

const MAX_PAGES = 3;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6 MB after client-side downscale

const dataUrlSchema = z
  .string()
  .startsWith("data:image/")
  .refine((s) => {
    // Rough byte cap so a hostile client can't blow up the worker memory.
    const approxBytes = (s.length * 3) / 4;
    return approxBytes <= MAX_IMAGE_BYTES;
  }, `Each page must be under ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB after downscale.`);

export const chartExtractionSchema = z.object({
  chart_date: z.string().nullish(),
  hospital_number: z.string().nullish(),
  initials: z.string().nullish(),
  balance_24h_ml: z.number().int().nullish(),
  hourly: z.array(hourlyCellSchema.extend({ hour: z.number().int().min(0).max(23) })).default([]),
  investigations: z
    .array(
      z.object({
        category: z.string(),
        findings: z.string().nullish(),
        result_at: z.string().nullish(),
      }),
    )
    .default([]),
  microbiology: z
    .array(
      z.object({
        specimen_type: z.string(),
        findings: z.string().nullish(),
        result_at: z.string().nullish(),
      }),
    )
    .default([]),
  assessments: z
    .object({
      resp: z.string().nullish(),
      cvs: z.string().nullish(),
      renal: z.string().nullish(),
      neuro: z.string().nullish(),
      gastro: z.string().nullish(),
      haem: z.string().nullish(),
      micro: z.string().nullish(),
      other: z.string().nullish(),
    })
    .default({}),
  notes: z.string().nullish(),
  overall_confidence: z.number().min(0).max(1).nullish(),
  low_confidence: z.array(z.string()).default([]),
});

export type ChartExtraction = z.infer<typeof chartExtractionSchema>;




function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export const extractChart = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patientId?: string; chartDate?: string; pages: string[] }) =>
    z
      .object({
        patientId: z.string().uuid().optional(),
        chartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        pages: z.array(dataUrlSchema).min(1).max(MAX_PAGES),
      })
      // .strict(): any extra key a caller invents (name, mrn, notes, dob...) is
      // rejected outright rather than silently stripped, so no unvetted free
      // text can ever reach the prompt builder below.
      .strict()
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const chartDate = data.chartDate ?? todayISO();

    // When opened from a patient page we verify the record and audit against it.
    // When opened from the bed board without a pre-selected patient we still log
    // the scan attempt, but with no entity_id so no patient is implied.
    if (data.patientId) {
      const { data: patient, error: pe } = await context.supabase
        .from("patients")
        .select(withCryptoColumns("id, hospital_number"))
        .eq("id", data.patientId)
        .maybeSingle();
      if (pe) throw safeDbError(pe);
      if (!patient) throw new Error("Patient not found");

      await context.supabase
        .from("audit_log")
        .insert({
          entity: "patients",
          entity_id: data.patientId,
          action: "update",
          user_id: context.userId,
          diff: { chart_scan: `attempt for ${chartDate} (${data.pages.length} page(s))` },
        } as never);
    } else {
      await context.supabase
        .from("audit_log")
        .insert({
          entity: "chart_scan",
          entity_id: null,
          action: "update",
          user_id: context.userId,
          diff: { chart_scan: `attempt for ${chartDate} (${data.pages.length} page(s))` },
        } as never);
    }

    // OUTBOUND GUARD — nothing reaches the model except pixels. Every page is
    // rebuilt from its decoded bytes: unsupported formats are refused, data-URL
    // header parameters (e.g. `;name=SMITH_John.jpg`) are dropped, and JPEG
    // EXIF/XMP/IPTC/comment segments plus PNG/WebP text + metadata chunks are
    // removed, so device IDs, GPS, authors and captions cannot leak. The prompt
    // text itself is machine-built from the validated ISO date only — no patient
    // id, MRN, initials or caller-supplied string is interpolated into it.
    const { sanitiseOutboundImage, OutboundGuardError } = await import(
      "@/lib/chart-outbound.server"
    );

    const outboundPages: string[] = [];
    const strippedSegments: string[] = [];
    try {
      for (const p of data.pages) {
        const safe = sanitiseOutboundImage(p);
        outboundPages.push(safe.dataUrl);
        strippedSegments.push(...safe.strippedSegments);
      }
    } catch (err) {
      if (err instanceof OutboundGuardError) {
        await context.supabase
          .from("audit_log")
          .insert({
            entity: data.patientId ? "patients" : "chart_scan",
            entity_id: data.patientId ?? null,
            action: "update",
            user_id: context.userId,
            diff: { chart_scan_blocked: err.message.slice(0, 200) },
          } as never);
      }
      throw err instanceof Error ? err : new Error("Chart page rejected");
    }

    const messages = buildChartExtractionMessages(chartDate, outboundPages);

    let content: string;
    try {
      const result = await callGatewayChat({
        model: "google/gemini-2.5-pro",
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 8000,
        messages,
      });
      content = result.content;
    } catch (err) {
      await context.supabase
        .from("audit_log")
        .insert({
          entity: data.patientId ? "patients" : "chart_scan",
          entity_id: data.patientId ?? null,
          action: "update",
          user_id: context.userId,
          diff: { chart_scan_failed: err instanceof Error ? err.message.slice(0, 200) : "unknown" },
        } as never);
      throw err instanceof Error ? err : new Error("Extraction failed");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      // Try to salvage JSON if the model wrapped it (defensive).
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("Model returned unparseable output");
      parsedJson = JSON.parse(match[0]);
    }

    const parsed = chartExtractionSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new Error(`Extraction schema mismatch: ${parsed.error.issues[0]?.message ?? "unknown"}`);
    }

    // Belt-and-braces: no patient identifier is ever accepted back from the
    // model. The identity sticker is redacted client-side before upload, so any
    // identifier here could only be a hallucination or a read of an
    // insufficiently covered sticker. Either way it is discarded — the
    // clinician types the MRN/initials into the app on the review screen.
    const scrubbed: ChartExtraction = scrubExtractionIdentifiers(parsed.data);

    // Success audit (still no image bytes).
    await context.supabase
      .from("audit_log")
      .insert({
        entity: data.patientId ? "patients" : "chart_scan",
        entity_id: data.patientId ?? null,
        action: "update",
        user_id: context.userId,
        diff: {
          chart_scan_success: {
            hourly: scrubbed.hourly.length,
            investigations: scrubbed.investigations.length,
            // Which metadata carriers were removed before upload (types only,
            // never their contents).
            metadata_stripped: [...new Set(strippedSegments)],
          },

        },
      } as never);

    return { extraction: scrubbed };
  });

function sanitiseInitials(v: string | null | undefined): string | null {
  if (!v) return null;
  const clean = v.replace(/[^A-Za-z]/g, "").toUpperCase().slice(0, 3);
  return clean || null;
}
function sanitiseHospitalNumber(v: string | null | undefined): string | null {
  if (!v) return null;
  const clean = v.replace(/[^A-Za-z0-9-]/g, "").slice(0, 50);
  return clean || null;
}

/**
 * Look up a patient by the sticker fields the extractor pulled off the chart.
 * Matches on hospital_number (case-insensitive, hyphens stripped) and, when
 * both sides have initials, checks the initials agree. Returns at most a
 * handful of candidates so the reviewer can confirm the correct chart is
 * being filed against the correct patient.
 */
export const matchPatientBySticker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { hospital_number?: string | null; initials?: string | null }) =>
    z
      .object({
        hospital_number: z.string().nullish(),
        initials: z.string().nullish(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const mrn = sanitiseHospitalNumber(data.hospital_number);
    const initials = sanitiseInitials(data.initials);
    if (!mrn && !initials) {
      return { candidates: [] as MatchCandidate[], mrn: null, initials: null };
    }

    let query = context.supabase
      .from("patients")
      .select(
        withCryptoColumns(
          "id, full_name, hospital_number, age, sex, ward, bed, status, admission_date",
        ),
      )
      .limit(5);

    if (mrn) {
      // MRNs are encrypted, so match on the keyed-hash fingerprint of the
      // normalised value (equivalent to the old case-insensitive match).
      query = query.eq("hospital_number_hash", patientLookupHash(mrn) as string);
    } else if (initials) {
      // No MRN — fall back to admitted patients whose name initials match.
      query = query.in("status", ["admitted", "referred"]).limit(25);
    }

    const { data: rows, error } = await query;
    if (error) throw safeDbError(error);

    const candidates: MatchCandidate[] = decryptPatientRows(
      rows as unknown as Array<Record<string, unknown>> | null,
    )
      .map((r) => ({
        id: r.id as string,
        full_name: (r.full_name as string) ?? null,
        hospital_number: (r.hospital_number as string) ?? null,
        age: (r.age as number | null) ?? null,
        sex: (r.sex as string | null) ?? null,
        ward: (r.ward as string | null) ?? null,
        bed: (r.bed as string | null) ?? null,
        status: (r.status as string | null) ?? null,
        admission_date: (r.admission_date as string | null) ?? null,
        initials_match: matchesInitials(r.full_name as string | null, initials),
      }))
      .filter((r) => (initials ? r.initials_match !== false : true))
      .slice(0, 5);

    return { candidates, mrn, initials };
  });

/**
 * Free-text patient picker used by the chart scanner when the sticker match
 * fails and the reviewer needs to pin the extraction to the correct record.
 * Matches against hospital_number and full_name.
 */
export const searchPatientsForChart = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { q?: string | null }) =>
    z.object({ q: z.string().nullish() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const q = (data.q ?? "").trim();
    if (q.length < 2) return { candidates: [] as MatchCandidate[] };
    // Identifiers are encrypted at rest, so a substring search can't run in
    // SQL. Pull a bounded recent window and match on the decrypted values.
    const needle = q.toLowerCase();
    const { data: rows, error } = await context.supabase
      .from("patients")
      .select(
        withCryptoColumns(
          "id, full_name, hospital_number, age, sex, ward, bed, status, admission_date",
        ),
      )
      .order("updated_at", { ascending: false })
      .limit(300);
    if (error) throw safeDbError(error);
    const candidates: MatchCandidate[] = decryptPatientRows(
      rows as unknown as Array<Record<string, unknown>> | null,
    )
      .filter(
        (r) =>
          String(r.hospital_number ?? "").toLowerCase().includes(needle) ||
          String(r.full_name ?? "").toLowerCase().includes(needle),
      )
      .slice(0, 15)
      .map((r) => ({
      id: r.id as string,
      full_name: (r.full_name as string) ?? null,
      hospital_number: (r.hospital_number as string) ?? null,
      age: (r.age as number | null) ?? null,
      sex: (r.sex as string | null) ?? null,
      ward: (r.ward as string | null) ?? null,
      bed: (r.bed as string | null) ?? null,
      status: (r.status as string | null) ?? null,
      admission_date: (r.admission_date as string | null) ?? null,
      initials_match: null,
    }));
    return { candidates };
  });

export type MatchCandidate = {
  id: string;
  full_name: string | null;
  hospital_number: string | null;
  age: number | null;
  sex: string | null;
  ward: string | null;
  bed: string | null;
  status: string | null;
  admission_date: string | null;
  /** true if the sticker initials match the record's name initials; null when
   *  we don't have sticker initials to check against. */
  initials_match: boolean | null;
};

function nameInitials(fullName: string | null | undefined): string {
  if (!fullName) return "";
  return fullName
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 3);
}

function matchesInitials(fullName: string | null, sticker: string | null): boolean | null {
  if (!sticker) return null;
  const record = nameInitials(fullName);
  if (!record) return false;
  // Sticker often carries first + last initial only; accept as a match if the
  // sticker letters appear in order within the record initials.
  let i = 0;
  for (const ch of sticker) {
    const found = record.indexOf(ch, i);
    if (found === -1) return false;
    i = found + 1;
  }
  return true;
}

/**
 * Commit a reviewed extraction into the patient's structured tables.
 * Writes-through into patient_observations, investigations, microbiology_results,
 * patient systems fields, and stores the hourly grid on chart_days/chart_hourly.
 */
export const commitChart = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patientId: string; chartDate: string; extraction: unknown }) =>
    z
      .object({
        patientId: z.string().uuid(),
        chartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        extraction: chartExtractionSchema,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { patientId, chartDate, extraction } = data;

    // 1. Upsert chart_day
    const existing = await context.supabase
      .from("chart_days")
      .select("id")
      .eq("patient_id", patientId)
      .eq("chart_date", chartDate)
      .maybeSingle();
    let chartDayId: string;
    if (existing.data) {
      chartDayId = existing.data.id;
      await context.supabase
        .from("chart_days")
        .update({
          source: "scan",
          notes: extraction.notes ?? null,
          balance_24h_ml: extraction.balance_24h_ml ?? null,
        } as never)
        .eq("id", chartDayId);
    } else {
      const { data: newDay, error } = await context.supabase
        .from("chart_days")
        .insert({
          patient_id: patientId,
          chart_date: chartDate,
          source: "scan",
          notes: extraction.notes ?? null,
          balance_24h_ml: extraction.balance_24h_ml ?? null,
          created_by: context.userId,
        } as never)
        .select("id")
        .single();
      if (error) throw safeDbError(error);
      chartDayId = newDay.id;
    }

    // 2. Upsert hourly rows
    if (extraction.hourly.length) {
      const rows = extraction.hourly.map((h) => ({ chart_day_id: chartDayId, ...h }));
      const { error } = await context.supabase
        .from("chart_hourly")
        .upsert(rows as never, { onConflict: "chart_day_id,hour" });
      if (error) throw safeDbError(error);
    }

    // 3. Write-through into patient_observations (one per hour with vitals)
    const obsRows = extraction.hourly
      .filter(
        (h) =>
          h.hr != null ||
          h.sbp != null ||
          h.dbp != null ||
          h.map != null ||
          h.spo2 != null ||
          h.rr != null ||
          h.temp != null ||
          h.gcs != null ||
          h.fio2 != null ||
          h.peep != null,
      )
      .map((h) => {
        const [y, m, d] = chartDate.split("-").map(Number);
        const recorded = new Date(Date.UTC(y, m - 1, d, h.hour, 0, 0)).toISOString();
        const cell = h as HourlyCell & { hour: number };
        return {
          patient_id: patientId,
          recorded_at: recorded,
          recorded_by: context.userId,
          hr: cell.hr ?? null,
          sbp: cell.sbp ?? null,
          dbp: cell.dbp ?? null,
          map: cell.map ?? null,
          spo2: cell.spo2 ?? null,
          fio2: cell.fio2 ?? null,
          rr: cell.rr ?? null,
          temp: cell.temp ?? null,
          gcs: cell.gcs ?? null,
          vent_mode: cell.vent_mode ?? null,
          peep: cell.peep ?? null,
          vt: cell.tv ?? null,
          urine_ml: cell.urine_ml ?? null,
          fluid_in_ml: cell.intake_ml ?? null,
          fluid_out_ml: cell.urine_ml ?? null,
          notes: "From chart scan",
        };
      });
    if (obsRows.length) {
      const { error } = await context.supabase
        .from("patient_observations")
        .insert(obsRows as never);
      if (error) throw safeDbError(error);
    }

    // 4. Investigations
    const invRows = extraction.investigations
      .filter((i) => (i.findings ?? "").trim().length > 0)
      .map((i) => ({
        patient_id: patientId,
        category: i.category.slice(0, 100),
        findings: (i.findings ?? "").slice(0, 20000),
        result_at: i.result_at ?? new Date(`${chartDate}T12:00:00Z`).toISOString(),
        created_by: context.userId,
      }));
    if (invRows.length) {
      const { error } = await context.supabase
        .from("investigations")
        .insert(invRows as never);
      if (error) throw safeDbError(error);
    }

    // 5. Microbiology
    const microRows = extraction.microbiology
      .filter((m) => (m.findings ?? "").trim().length > 0)
      .map((m) => ({
        patient_id: patientId,
        specimen_type: m.specimen_type.slice(0, 100),
        findings: (m.findings ?? "").slice(0, 20000),
        result_at: m.result_at ?? new Date(`${chartDate}T12:00:00Z`).toISOString(),
        created_by: context.userId,
      }));
    if (microRows.length) {
      const { error } = await context.supabase
        .from("microbiology_results")
        .insert(microRows as never);
      if (error) throw safeDbError(error);
    }

    // 6. Systems review patch (only overwrite fields the scan actually populated)
    const sysPatch: Record<string, string> = {};
    const a = extraction.assessments ?? {};
    if (a.resp) sysPatch.systems_resp = a.resp;
    if (a.cvs) sysPatch.systems_cvs = a.cvs;
    if (a.renal) sysPatch.systems_renal = a.renal;
    if (a.neuro) sysPatch.systems_neuro = a.neuro;
    if (a.gastro) sysPatch.systems_gastro = a.gastro;
    if (a.haem) sysPatch.systems_haem = a.haem;
    if (a.micro) sysPatch.systems_micro = a.micro;
    if (a.other) sysPatch.systems_other = a.other;
    if (Object.keys(sysPatch).length) {
      const { error } = await context.supabase
        .from("patients")
        .update(encryptPatientPayload(sysPatch) as never)
        .eq("id", patientId);
      if (error) throw safeDbError(error);
    }

    return {
      ok: true,
      chartDayId,
      observationsAdded: obsRows.length,
      investigationsAdded: invRows.length,
      microbiologyAdded: microRows.length,
      systemsUpdated: Object.keys(sysPatch),
    };
  });
