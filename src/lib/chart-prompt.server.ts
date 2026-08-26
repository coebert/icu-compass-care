/**
 * Chart extraction prompt + identifier guards.
 *
 * Everything that decides WHAT TEXT is sent to the AI model, and what is
 * accepted back from it, lives here so it can be tested in isolation (see
 * tests/chart-extract-no-identifiers.test.ts). No patient identifier may ever
 * be interpolated into the prompt, and no identifier is ever accepted back.
 */

import { z } from "zod";

export const CHART_SYSTEM_PROMPT = `You are a clinical data-extraction assistant reading a photograph of the Radnor Critical Care Unit 24-hour paper chart used at Salisbury District Hospital.

Return ONE JSON object matching the caller's schema. Use null for anything illegible or blank. NEVER invent values.

Rules:
- Numbers only in numeric fields (mL, integers unless a decimal is written).
- Times use 24-hour clock. "01:00" is hour 0-index 1, "00:00" is hour 0 (midnight after the previous day).
- Only include hourly rows that have at least one non-null value.
- The patient identity sticker has been blacked out before this image was sent. Do NOT return ANY patient identifier: no name, initials, DOB, address, NHS number or hospital number. Never attempt to read or reconstruct redacted areas. Return null for hospital_number and initials always — the clinician enters those in the app.
- The chart_date is the date written at the top of the chart (YYYY-MM-DD).
- Investigations: emit one row per tick/entry in the "Investigations" list (CXR / Scans / 12 Lead ECG / Blood Cultures / Urine MC+S / Sputum / Swabs / MRSA Screen / Other). Set findings to any handwritten result note or null.
- Microbiology: one row per specimen line with a handwritten result.
- Assessments: copy the free-text management-plan blocks per system (resp / cvs / renal / neuro / gastro / haem / micro / other).
- Vitals: read the hourly grid (HR, SBP/DBP, MAP, CVP, SpO2, EtCO2, RR, Temp, GCS) into the matching hourly row.
- Ventilation: mode, PEEP, FiO2 (as fraction 0-1), pressure support, tidal volume, minute volume, peak pressure.

Confidence reporting (REQUIRED):
- overall_confidence: your overall confidence 0-1 that the whole extraction is correct.
- low_confidence: an array of dotted field paths you are uncertain about (illegible handwriting, ambiguous digits, smudges, unclear ticks). Use these path formats:
    "chart_date", "balance_24h_ml", "notes"
    "assessments.<system>"  e.g. "assessments.resp"
    "hourly[<hour>].<field>"  e.g. "hourly[13].hr", "hourly[7].sbp"
    "investigations[<index>].<field>"  e.g. "investigations[2].findings"
    "microbiology[<index>].<field>"
- Prefer a null value + a low_confidence entry over a guessed value. Only list paths whose returned value is questionable.

Return strictly valid JSON with no prose, no code fences.`;

export type ChartUserContent = Array<
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }
>;

/**
 * Build the outbound messages. The ONLY caller-derived value that can reach the
 * prompt text is `chartDate`, which is re-validated here as a bare ISO date, so
 * a patient id, MRN, initials or free text can never be interpolated.
 */
export function buildChartExtractionMessages(
  chartDate: string,
  sanitisedPages: string[],
): Array<
  { role: "system"; content: string } | { role: "user"; content: ChartUserContent }
> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(chartDate)) {
    throw new Error("chart_date must be an ISO date (YYYY-MM-DD)");
  }
  const userContent: ChartUserContent = [
    {
      type: "text",
      text: `Extract the Radnor 24h chart for chart_date ${chartDate}. Return JSON only.`,
    },
  ];
  for (const url of sanitisedPages) {
    userContent.push({ type: "image_url", image_url: { url } });
  }
  return [
    { role: "system", content: CHART_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

/**
 * Drop every identifier the model may have returned. The identity sticker is
 * redacted before upload, so anything here is a hallucination or a read of an
 * insufficiently covered sticker — either way it is discarded and the clinician
 * types the MRN/initials into the app on the review screen.
 */
export function scrubExtractionIdentifiers<
  T extends {
    initials?: string | null;
    hospital_number?: string | null;
    low_confidence?: string[];
  },
>(extraction: T): T {
  return {
    ...extraction,
    initials: null,
    hospital_number: null,
    low_confidence: (extraction.low_confidence ?? []).filter(
      (p) => p !== "initials" && p !== "hospital_number",
    ),
  };
}

// ---------------------------------------------------------------------------
// Upload validation + model-output parsing.
//
// Kept here (not in the server-fn file) so the whole upload → outbound →
// extraction pipeline can be exercised in tests without a request context.
// See tests/chart-extract-pipeline.test.ts.
// ---------------------------------------------------------------------------

export const MAX_CHART_PAGES = 3;
export const MAX_CHART_IMAGE_BYTES = 6 * 1024 * 1024; // 6 MB after client-side downscale

const chartPageSchema = z
  .string()
  .startsWith("data:image/")
  .refine((s) => {
    // Rough byte cap so a hostile client can't blow up the worker memory.
    const approxBytes = (s.length * 3) / 4;
    return approxBytes <= MAX_CHART_IMAGE_BYTES;
  }, `Each page must be under ${Math.round(MAX_CHART_IMAGE_BYTES / 1024 / 1024)} MB after downscale.`);

/**
 * Upload payload. `.strict()` means any extra key a caller invents
 * (name, mrn, dob, notes, prompt...) is rejected outright rather than silently
 * stripped, so no unvetted free text can reach the prompt builder.
 */
export const chartExtractInputSchema = z
  .object({
    patientId: z.string().uuid().optional(),
    chartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    pages: z.array(chartPageSchema).min(1).max(MAX_CHART_PAGES),
  })
  .strict();

/** Parse the model's reply, salvaging a JSON object if it wrapped it in prose. */
export function parseChartModelOutput(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Model returned unparseable output");
    return JSON.parse(match[0]);
  }
}
