import { describe, it, expect } from "vitest";
import { buildHandoverPdf, type HandoverPatient } from "@/lib/handover-pdf";
import type { Observation } from "@/lib/observations";

/**
 * Integration test: the "Latest observations" cell that a clinician sees in the
 * on-screen preview iframe MUST match, character-for-character, the cell in the
 * PDF they download.
 *
 * Both surfaces are backed by the same generator:
 *   - preview iframe  → handoverPdfPreviewUrl(patients, opts) → buildHandoverPdf(...).output("blob")
 *   - download button → downloadHandover(patients, opts)      → buildHandoverPdf(...).output("blob")
 *
 * Rather than trust that they share code, this test independently renders each
 * surface's PDF bytes, extracts the *actual rendered* "Latest observations"
 * column text out of the PDF (via pdfjs, positionally), and compares them across
 * several patient scenarios — including the tie-break case where two
 * observations share the same recorded_at.
 */

// ---- PDF text extraction (positional, isolates a single column) -------------

interface TextItem {
  x: number;
  y: number;
  str: string;
}

async function pdfTextItems(bytes: ArrayBuffer): Promise<TextItem[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
  const items: TextItem[] = [];
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const tc = await page.getTextContent();
    for (const it of tc.items as { str: string; transform: number[] }[]) {
      if (!it.str.trim()) continue;
      // Offset y by page so multi-page rows never collide.
      items.push({ x: it.transform[4], y: it.transform[5] + pageNum * 10000, str: it.str });
    }
  }
  return items;
}

/**
 * Extract the rendered text of the "Latest observations" column by locating its
 * header, using the next column header to the right as the x-boundary, then
 * collecting all body items within that x-band and reconstructing lines.
 */
function extractObservationsCell(items: TextItem[]): string {
  const header = items.find((i) => i.str.trim() === "Latest observations");
  if (!header) throw new Error('Could not find "Latest observations" header in PDF');

  // The right edge of the column = x of the nearest header to the right on the
  // same header row. Any body item at x >= that belongs to the next column.
  const sameRowHeaders = items.filter((i) => Math.abs(i.y - header.y) < 2);
  const rightHeaders = sameRowHeaders
    .filter((i) => i.x > header.x + 1)
    .sort((a, b) => a.x - b.x);
  const xEnd = rightHeaders.length ? rightHeaders[0].x - 1 : Number.POSITIVE_INFINITY;
  const xStart = header.x - 1;

  // Body items: within the column x-band and strictly below the header row.
  const body = items.filter(
    (i) => i.x >= xStart && i.x < xEnd && i.y < header.y - 1,
  );

  // Group into visual lines by y, then order left-to-right within a line.
  const rows = new Map<number, TextItem[]>();
  for (const it of body) {
    const key = Math.round(it.y);
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key)!.push(it);
  }
  return [...rows.entries()]
    .sort((a, b) => b[0] - a[0]) // top of page first (higher y)
    .map(([, line]) =>
      line
        .sort((a, b) => a.x - b.x)
        .map((i) => i.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .join(" | ");
}

// ---- The two surfaces (both wrap buildHandoverPdf identically) --------------

const OPTS = { title: "ICU Handover Sheet", showTimestamp: false } as const;

/** What the preview iframe renders: handoverPdfPreviewUrl(patients, opts). */
function previewBytes(patients: HandoverPatient[]): ArrayBuffer {
  return buildHandoverPdf(patients, OPTS).output("arraybuffer");
}
/** What the download button saves: downloadHandover(patients, opts). */
function downloadBytes(patients: HandoverPatient[]): ArrayBuffer {
  return buildHandoverPdf(patients, OPTS).output("arraybuffer");
}

// ---- Scenario fixtures ------------------------------------------------------

function obs(partial: Partial<Observation>): Observation {
  return {
    id: partial.id ?? crypto.randomUUID(),
    patient_id: "p1",
    recorded_at: partial.recorded_at ?? "2026-07-10T08:00:00.000Z",
    recorded_by: null,
    hr: null, sbp: null, dbp: null, map: null, spo2: null, fio2: null,
    rr: null, temp: null, gcs: null, lactate: null, vent_mode: null,
    peep: null, vt: null, vasopressor: null, vasopressor_dose: null,
    urine_ml: null, fluid_in_ml: null, fluid_out_ml: null, notes: null,
    ...partial,
  };
}

function patient(name: string, observations: Observation[]): HandoverPatient {
  return {
    full_name: name,
    hospital_number: "RN" + name.length,
    ward: "Critical Care Unit",
    bed: "3",
    status: "admitted",
    admission_date: "2026-07-01",
    current_admission: "Admitted for management.",
    patient_observations: observations,
  } as unknown as HandoverPatient;
}

const SAME_TIME = "2026-07-10T08:00:00.000Z";

const SCENARIOS: {
  name: string;
  patient: HandoverPatient;
  /** Empty string = the "no observations" placeholder case. */
  expectFragment: string;
  /** Substrings that MUST appear (whitespace-insensitive). */
  expectContains?: string[];
  /** Substrings that MUST NOT appear (whitespace-insensitive). */
  expectAbsent?: string[];
}[] = [
  {
    name: "single observation",
    patient: patient("Single Obs", [
      obs({ id: "z-single", recorded_at: SAME_TIME, hr: 88, spo2: 95 }),
    ]),
    expectFragment: "z-single",
  },
  {
    name: "distinct timestamps → most recent wins",
    patient: patient("Distinct Times", [
      obs({ id: "old-1", recorded_at: "2026-07-10T06:00:00.000Z", hr: 60 }),
      obs({ id: "new-1", recorded_at: "2026-07-10T09:30:00.000Z", hr: 130 }),
    ]),
    expectFragment: "new-1",
  },
  {
    name: "tie-break: identical recorded_at, greater id wins",
    patient: patient("Tie Break", [
      obs({ id: "obs-aaaa", recorded_at: SAME_TIME, hr: 70, spo2: 98 }),
      obs({ id: "obs-bbbb", recorded_at: SAME_TIME, hr: 120, spo2: 88 }),
    ]),
    expectFragment: "obs-bbbb",
  },
  {
    name: "no observations",
    patient: patient("No Obs", []),
    expectFragment: "",
  },
  // ---- Partial / missing vital fields ----
  {
    name: "no SpO2 (HR + RR only)",
    patient: patient("No Spo2", [
      obs({ id: "no-spo2", recorded_at: SAME_TIME, hr: 92, rr: 18 }),
    ]),
    expectFragment: "no-spo2",
    expectContains: ["HR 92", "RR 18"],
    expectAbsent: ["SpO"],
  },
  {
    name: "BP present, no HR (MAP derived not shown without map)",
    patient: patient("Bp Only", [
      obs({ id: "bp-only", recorded_at: SAME_TIME, sbp: 90, dbp: 60 }),
    ]),
    expectFragment: "bp-only",
    expectContains: ["BP 90/60"],
    expectAbsent: ["HR ", "SpO"],
  },
  {
    name: "MAP only, no systolic/diastolic",
    patient: patient("Map Only", [
      obs({ id: "map-only", recorded_at: SAME_TIME, map: 65 }),
    ]),
    expectFragment: "map-only",
    expectContains: ["MAP 65"],
    expectAbsent: ["BP ", "HR "],
  },
  {
    name: "support-only: vent + pressor, no basic vitals",
    patient: patient("Support Only", [
      obs({
        id: "support-1",
        recorded_at: SAME_TIME,
        vent_mode: "SIMV",
        peep: 8,
        vasopressor: "Noradrenaline",
        vasopressor_dose: 0.12,
      }),
    ]),
    expectFragment: "support-1",
    expectContains: ["Vent SIMV", "PEEP 8", "Pressor Noradrenaline"],
    expectAbsent: ["HR ", "BP ", "SpO"],
  },
  {
    name: "observation with all vitals null → placeholder vitals, still timestamped",
    patient: patient("Empty Vitals", [
      obs({ id: "empty-vitals", recorded_at: SAME_TIME }),
    ]),
    expectFragment: "empty-vitals",
    // No vitals render, but the timestamp + id line is still present.
    expectContains: ["id empty-vitals"],
    expectAbsent: ["HR ", "BP ", "SpO", "MAP "],
  },
  {
    name: "mixed completeness across rows → latest (fullest) chosen",
    patient: patient("Mixed Rows", [
      obs({ id: "old-sparse", recorded_at: "2026-07-10T05:00:00.000Z", hr: 70 }),
      obs({
        id: "new-full",
        recorded_at: "2026-07-10T10:00:00.000Z",
        hr: 105,
        spo2: 92,
        rr: 22,
        temp: 38.4,
      }),
    ]),
    expectFragment: "new-full",
    expectContains: ["HR 105", "RR 22"],
    expectAbsent: ["HR 70"],
  },
  // ---- Very long text: wrapping / ellipses inside a narrow cell ----
  {
    // A long free-text pressor name forces autoTable to wrap the vitals block
    // across many visual lines inside the narrow column. The extractor stitches
    // those lines back with " | "; normalizePdfText must fold them so the full
    // content is still recoverable and identical across both surfaces.
    name: "very long pressor text wraps across many lines",
    patient: patient("Long Pressor", [
      obs({
        id: "long-pressor",
        recorded_at: SAME_TIME,
        hr: 110,
        vasopressor:
          "Noradrenaline plus Vasopressin plus Adrenaline plus Dobutamine titrated to MAP target with escalating multi-agent haemodynamic support regimen",
        vasopressor_dose: 0.45,
      }),
    ]),
    expectFragment: "long-pressor",
    expectContains: [
      "HR 110",
      // The entire long string survives wrapping when whitespace is folded.
      "PressorNoradrenalineplusVasopressinplusAdrenalineplusDobutamine",
      "haemodynamicsupportregimen",
    ],
  },
  {
    // Every vital present AND a long note-like vent descriptor: a maximally
    // dense cell that wraps heavily. Preview and download must still be equal.
    name: "maximal-density cell with long vent descriptor wraps heavily",
    patient: patient("Dense Cell", [
      obs({
        id: "dense-cell",
        recorded_at: SAME_TIME,
        hr: 118, sbp: 95, dbp: 55, spo2: 89, fio2: 0.8, rr: 28,
        temp: 39.1, gcs: 6, lactate: 4.2, urine_ml: 15, peep: 12,
        vent_mode: "Pressure-controlled SIMV with recruitment and prone positioning",
      }),
    ]),
    expectFragment: "dense-cell",
    expectContains: [
      "HR 118",
      "BP 95/55",
      "SpO₂ 89%",
      "FiO₂ 0.8",
      "VentPressure-controlledSIMVwithrecruitmentandpronepositioning",
    ],
  },
];



// ---- Tests ------------------------------------------------------------------

/**
 * Normalize rendered PDF text for whitespace-insensitive substring matching.
 *
 * pdfjs is a hostile source for naive string comparison:
 *   - Narrow table cells are emitted one glyph (or glyph-cluster) at a time, so
 *     "HR 120" can arrive as "H","R"," ","1","2","0" with arbitrary spacing.
 *   - Line wrapping inside a cell surfaces as separate text items, and our
 *     extractor joins visual lines with " | ".
 *   - Fonts can inject non-breaking spaces, narrow no-break spaces, thin
 *     spaces, zero-width joiners, soft hyphens, and BOMs between glyphs.
 *
 * This helper collapses every one of those artifacts so a substring check tests
 * the *content* of the cell, not pdfjs's per-glyph layout. It deliberately does
 * NOT touch the core preview===download equality assertion, which stays verbatim.
 */
function normalizePdfText(s: string): string {
  return (
    s
      // Drop the "|" visual-line separator our extractor inserts.
      .replace(/\|/g, "")
      // Strip zero-width / formatting characters pdfjs can interleave:
      // ZWSP, ZWNJ, ZWJ, BOM/ZWNBSP, and soft hyphen.
      .replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/g, "")
      // Fold every unicode whitespace variant (NBSP, thin/narrow spaces,
      // newlines, tabs) away entirely so inter-glyph spacing can't defeat a
      // substring match.
      .replace(/\s/g, "")
  );
}

// Back-compat alias for the assertions below.
const noSpace = normalizePdfText;


describe("Latest observations: preview iframe vs downloaded PDF", () => {
  for (const scenario of SCENARIOS) {
    it(`renders identical cell text — ${scenario.name}`, async () => {
      const previewItems = await pdfTextItems(previewBytes([scenario.patient]));
      const downloadItems = await pdfTextItems(downloadBytes([scenario.patient]));

      const previewCell = extractObservationsCell(previewItems);
      const downloadCell = extractObservationsCell(downloadItems);

      // The core assertion: both surfaces show the exact same cell text.
      expect(previewCell).toBe(downloadCell);

      if (scenario.expectFragment) {
        // And it reflects the deterministically-selected observation.
        expect(noSpace(previewCell)).toContain(noSpace(scenario.expectFragment));
      } else {
        // No observations → placeholder, never a stray id.
        expect(previewCell).toContain("—");
        expect(previewCell).not.toContain("id ");
      }

      // Partial / missing vitals must render exactly the fields present and omit
      // the absent ones — consistently in both surfaces (already asserted equal).
      for (const frag of scenario.expectContains ?? []) {
        expect(noSpace(previewCell)).toContain(noSpace(frag));
      }
      for (const frag of scenario.expectAbsent ?? []) {
        expect(noSpace(previewCell)).not.toContain(noSpace(frag));
      }
    });
  }

  it("tie-break selection is order-independent across both surfaces", async () => {
    const a = obs({ id: "obs-aaaa", recorded_at: SAME_TIME, hr: 70, spo2: 98 });
    const b = obs({ id: "obs-bbbb", recorded_at: SAME_TIME, hr: 120, spo2: 88 });

    const forward = extractObservationsCell(
      await pdfTextItems(previewBytes([patient("Order A", [a, b])])),
    );
    const reversed = extractObservationsCell(
      await pdfTextItems(downloadBytes([patient("Order B", [b, a])])),
    );

    expect(forward).toBe(reversed);
    expect(noSpace(forward)).toContain(noSpace("obs-bbbb"));
    expect(noSpace(forward)).toContain(noSpace("HR 120"));
  });
});
