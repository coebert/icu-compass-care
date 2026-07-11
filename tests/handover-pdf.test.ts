import { describe, it, expect } from "vitest";
import {
  buildHandoverPdf,
  type HandoverPatient,
  type HandoverPageSize,
} from "@/lib/handover-pdf";

// A long free-text blob to stress column wrapping / scaling.
const LONG_TEXT =
  "Patient admitted with severe community-acquired pneumonia complicated by " +
  "type 1 respiratory failure requiring intubation and lung-protective ventilation. " +
  "Background of ischaemic heart disease, type 2 diabetes, chronic kidney disease " +
  "stage 3b, and previous CVA. ".repeat(6);

function makePatient(i: number): HandoverPatient {
  return {
    id: `p-${i}`,
    full_name: `Test Patient Number ${i}`,
    age: 40 + (i % 40),
    hospital_number: `RN${100000 + i}`,
    ward: "Critical Care Unit",
    bed: `${i % 12}`,
    status: "admitted",
    admission_date: "2026-07-01",
    past_medical_history: LONG_TEXT,
    current_admission: LONG_TEXT,
    current_management: LONG_TEXT,
    systems_resp: LONG_TEXT,
    systems_cvs: LONG_TEXT,
    systems_neuro: LONG_TEXT,
    systems_renal: LONG_TEXT,
    systems_gastro: LONG_TEXT,
    systems_haem: LONG_TEXT,
    systems_micro: LONG_TEXT,
    systems_other: LONG_TEXT,
    outstanding_tasks: LONG_TEXT,
    dnacpr_decision: true,
    dnacpr_details: "Documented after family discussion",
    tep_in_place: true,
    tep_details: "Ward-based ceiling of care",
    nok_name: "Jane Doe",
    nok_relationship: "Daughter",
    nok_contact: "07000 000000",
    investigations: [
      { category: "Bloods", findings: "WCC 18, CRP 240", result_at: "2026-07-10T08:00:00Z" },
      { category: "CXR", findings: "Bilateral infiltrates", result_at: "2026-07-10T09:00:00Z" },
    ],
    microbiology_results: [
      { specimen_type: "Sputum", findings: "S. pneumoniae", result_at: "2026-07-09T10:00:00Z" },
    ],
  };
}

// jsPDF measures wrapped-line height in the same unit as the doc (mm here).
function pageHeightMm(doc: ReturnType<typeof buildHandoverPdf>): number {
  return doc.internal.pageSize.getHeight();
}
function pageWidthMm(doc: ReturnType<typeof buildHandoverPdf>): number {
  return doc.internal.pageSize.getWidth();
}

describe("handover PDF export", () => {
  it("produces a valid, non-empty PDF document", () => {
    const doc = buildHandoverPdf([makePatient(1)]);
    const out = doc.output("arraybuffer");
    const bytes = new Uint8Array(out);
    const header = String.fromCharCode(...bytes.slice(0, 5));
    expect(header).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(1000);
  });

  it("renders in landscape so wide clinical tables fit across the page", () => {
    const doc = buildHandoverPdf([makePatient(1)]);
    expect(pageWidthMm(doc)).toBeGreaterThan(pageHeightMm(doc));
  });

  it.each<HandoverPageSize>(["a4", "letter"])(
    "keeps the table within the printable width on %s",
    (pageSize) => {
      const marginX = 8;
      const doc = buildHandoverPdf([makePatient(1)], { pageSize, marginX });
      const table = (doc as any).lastAutoTable;
      expect(table).toBeTruthy();
      const contentWidth = pageWidthMm(doc) - marginX * 2;
      const tableWidth: number = table.settings.tableWidth;
      // Table must not overflow the printable content area (allow rounding).
      expect(tableWidth).toBeLessThanOrEqual(contentWidth + 0.5);
      // Right edge of the widest cell must stay inside the right margin.
      const cells = Object.values(table.body[0].cells) as any[];
      const rightEdge = Math.max(...cells.map((c) => c.x + c.width));
      expect(rightEdge).toBeLessThanOrEqual(pageWidthMm(doc) - marginX + 0.5);
    },
  );

  it("paginates long content across multiple printable pages", () => {
    // Many patients with long text must flow onto additional pages, not
    // spill off a single page.
    const patients = Array.from({ length: 30 }, (_, i) => makePatient(i));
    const doc = buildHandoverPdf(patients);
    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
  });

  it("respects a smaller font scale to fit denser handovers", () => {
    const patients = Array.from({ length: 30 }, (_, i) => makePatient(i));
    const normal = buildHandoverPdf(patients, { fontScale: 1 }).getNumberOfPages();
    const dense = buildHandoverPdf(patients, { fontScale: 0.6 }).getNumberOfPages();
    // A smaller font must fit at least as many rows per page.
    expect(dense).toBeLessThanOrEqual(normal);
  });

  it("keeps every cell positioned within the printable page height", () => {
    const patients = Array.from({ length: 12 }, (_, i) => makePatient(i));
    const marginBottom = 12;
    const marginTop = 22;
    const doc = buildHandoverPdf(patients);
    const table = (doc as any).lastAutoTable;
    const usableBottom = pageHeightMm(doc) - marginBottom;
    for (const row of table.body) {
      for (const cell of Object.values(row.cells) as any[]) {
        // Each cell begins on its page within the printable area.
        expect(cell.y).toBeGreaterThanOrEqual(marginTop - 6);
        expect(cell.y).toBeLessThanOrEqual(usableBottom + 0.5);
      }
    }
  });

  it("handles an empty patient list without throwing", () => {
    expect(() => buildHandoverPdf([])).not.toThrow();
  });
});

describe("handover PDF column selection", () => {
  it("renders only the selected columns", () => {
    const doc = buildHandoverPdf([makePatient(1)], {
      columns: ["patient", "systems"],
    });
    const table = (doc as any).lastAutoTable;
    const headers = table.head[0].cells;
    const headerTexts = Object.values(headers).map((c: any) => c.text.join(" "));
    expect(headerTexts).toEqual(["Patient", "Systems review"]);
  });

  it("falls back to all columns when selection is empty", () => {
    const doc = buildHandoverPdf([makePatient(1)], { columns: [] });
    const table = (doc as any).lastAutoTable;
    expect(Object.keys(table.head[0].cells).length).toBe(10);
  });

  it("keeps selected columns fitted within the printable width", () => {
    const marginX = 8;
    const doc = buildHandoverPdf([makePatient(1)], {
      columns: ["patient", "management", "tasks"],
      marginX,
    });
    const table = (doc as any).lastAutoTable;
    const cells = Object.values(table.body[0].cells) as any[];
    const rightEdge = Math.max(...cells.map((c) => c.x + c.width));
    expect(rightEdge).toBeLessThanOrEqual(
      doc.internal.pageSize.getWidth() - marginX + 0.5,
    );
  });
});
