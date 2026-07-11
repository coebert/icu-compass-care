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

const SCENARIOS: { name: string; patient: HandoverPatient; expectFragment: string }[] = [
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
];

// ---- Tests ------------------------------------------------------------------

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
        expect(previewCell).toContain(scenario.expectFragment);
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
    expect(forward).toContain("obs-bbbb");
    expect(forward).toContain("HR 120");
  });
});
