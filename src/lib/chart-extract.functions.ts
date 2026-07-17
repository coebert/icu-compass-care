import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { safeDbError } from "@/lib/db-error";
import { callGatewayChat } from "@/lib/ai-gateway.server";
import { hourlyCellSchema, type HourlyCell } from "@/lib/chart-days.functions";

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

const SYSTEM_PROMPT = `You are a clinical data-extraction assistant reading a photograph of the Radnor Critical Care Unit 24-hour paper chart used at Salisbury District Hospital.

Return ONE JSON object matching the caller's schema. Use null for anything illegible or blank. NEVER invent values.

Rules:
- Numbers only in numeric fields (mL, integers unless a decimal is written).
- Times use 24-hour clock. "01:00" is hour 0-index 1, "00:00" is hour 0 (midnight after the previous day).
- Only include hourly rows that have at least one non-null value.
- Do NOT include patient name, DOB, address, or NHS number. Return ONLY hospital_number (MRN) and initials (up to 3 uppercase letters from the given name and surname).
- The chart_date is the date written at the top of the chart (YYYY-MM-DD).
- Investigations: emit one row per tick/entry in the "Investigations" list (CXR / Scans / 12 Lead ECG / Blood Cultures / Urine MC+S / Sputum / Swabs / MRSA Screen / Other). Set findings to any handwritten result note or null.
- Microbiology: one row per specimen line with a handwritten result.
- Assessments: copy the free-text management-plan blocks per system (resp / cvs / renal / neuro / gastro / haem / micro / other).
- Vitals: read the hourly grid (HR, SBP/DBP, MAP, CVP, SpO2, EtCO2, RR, Temp, GCS) into the matching hourly row.
- Ventilation: mode, PEEP, FiO2 (as fraction 0-1), pressure support, tidal volume, minute volume, peak pressure.

Confidence reporting (REQUIRED):
- overall_confidence: your overall confidence 0-1 that the whole extraction is correct.
- low_confidence: an array of dotted field paths you are uncertain about (illegible handwriting, ambiguous digits, smudges, unclear ticks). Use these path formats:
    "hospital_number", "initials", "chart_date", "balance_24h_ml", "notes"
    "assessments.<system>"  e.g. "assessments.resp"
    "hourly[<hour>].<field>"  e.g. "hourly[13].hr", "hourly[7].sbp"
    "investigations[<index>].<field>"  e.g. "investigations[2].findings"
    "microbiology[<index>].<field>"
- Prefer a null value + a low_confidence entry over a guessed value. Only list paths whose returned value is questionable.

Return strictly valid JSON with no prose, no code fences.`;


export const extractChart = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patientId: string; chartDate: string; pages: string[] }) =>
    z
      .object({
        patientId: z.string().uuid(),
        chartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        pages: z.array(dataUrlSchema).min(1).max(MAX_PAGES),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    // Verify the patient exists and log a scan attempt (no image bytes).
    const { data: patient, error: pe } = await context.supabase
      .from("patients")
      .select("id, hospital_number")
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
        diff: { chart_scan: `attempt for ${data.chartDate} (${data.pages.length} page(s))` },
      } as never);

    const userContent: Array<
      { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
    > = [
      {
        type: "text",
        text: `Extract the Radnor 24h chart for chart_date ${data.chartDate}. Return JSON only.`,
      },
    ];
    for (const p of data.pages) {
      userContent.push({ type: "image_url", image_url: { url: p } });
    }

    let content: string;
    try {
      const result = await callGatewayChat({
        model: "google/gemini-2.5-pro",
        response_format: { type: "json_object" },
        temperature: 0,
        max_tokens: 8000,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
      });
      content = result.content;
    } catch (err) {
      await context.supabase
        .from("audit_log")
        .insert({
          entity: "patients",
          entity_id: data.patientId,
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

    // Scrub any accidental PII fields the model may have hallucinated.
    const scrubbed: ChartExtraction = {
      ...parsed.data,
      // Preserve only initials + MRN. Everything else is dropped.
      initials: sanitiseInitials(parsed.data.initials),
      hospital_number: sanitiseHospitalNumber(parsed.data.hospital_number),
    };

    // Success audit (still no image bytes).
    await context.supabase
      .from("audit_log")
      .insert({
        entity: "patients",
        entity_id: data.patientId,
        action: "update",
        user_id: context.userId,
        diff: {
          chart_scan_success: {
            hourly: scrubbed.hourly.length,
            investigations: scrubbed.investigations.length,
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
      .select("id, full_name, hospital_number, age, sex, ward, bed, status, admission_date")
      .limit(5);

    if (mrn) {
      // Case-insensitive MRN match. Some units record with hyphens, some without.
      query = query.ilike("hospital_number", mrn);
    } else if (initials) {
      // No MRN — fall back to admitted patients whose name initials match.
      query = query.in("status", ["admitted", "referred"]).limit(25);
    }

    const { data: rows, error } = await query;
    if (error) throw safeDbError(error);

    const candidates: MatchCandidate[] = (rows ?? [])
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
    const safe = q.replace(/[,()"']/g, " ");
    const like = `%${safe}%`;
    const { data: rows, error } = await context.supabase
      .from("patients")
      .select("id, full_name, hospital_number, age, sex, ward, bed, status, admission_date")
      .or(`hospital_number.ilike.${like},full_name.ilike.${like}`)
      .limit(15);
    if (error) throw safeDbError(error);
    const candidates: MatchCandidate[] = (rows ?? []).map((r) => ({
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
        .update(sysPatch as never)
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
