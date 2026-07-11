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
];


// ---- Tests ------------------------------------------------------------------

// pdfjs may emit narrow cells one glyph at a time; compare ignoring whitespace
// so a substring check is not defeated by inter-glyph spacing. This does not
// weaken the core preview===download equality, which is compared verbatim.
const noSpace = (s: string) => s.replace(/\s+/g, "");

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
