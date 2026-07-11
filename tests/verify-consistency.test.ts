import { describe, it, expect } from "vitest";
import { buildHandoverPdf, handoverPdfPreviewUrl } from "@/lib/handover-pdf";
import { HANDOVER_COLUMNS } from "@/lib/handover-columns";
import type { HandoverPatient } from "@/lib/handover-types";

// The preview iframe (handoverPdfPreviewUrl) and the export (downloadHandover /
// exportHandoverPdf) both call buildHandoverPdf with the same HANDOVER_COLUMNS,
// so the "Latest observations" block is consistent by construction. These tests
// pin that invariant across a range of patient scenarios.

const obsCol = HANDOVER_COLUMNS.find((c) => c.key === "observations")!;

function obsCellText(doc: ReturnType<typeof buildHandoverPdf>): string {
  const table = (doc as any).lastAutoTable;
  const headerCells = table.head[0].cells as Record<string, any>;
  const idx = Object.entries(headerCells).find(
    ([, c]) => (c.text as string[]).join(" ") === "Latest observations",
  )?.[0];
  expect(idx).toBeTruthy();
  return (table.body[0].cells[idx!].text as string[]).join(" ");
}

function scenario(id: string, obs: any[]): HandoverPatient {
  return { id, name: id, patient_observations: obs } as any;
}

const scenarios: HandoverPatient[] = [
  scenario("no-obs", []),
  scenario("single", [
    { recorded_at: "2026-01-01T10:00:00Z", hr: 80, sbp: 120, dbp: 80, spo2: 98 },
  ]),
  scenario("out-of-order", [
    { recorded_at: "2026-01-01T06:00:00Z", hr: 60 },
    { recorded_at: "2026-01-01T18:00:00Z", hr: 112, sbp: 88, dbp: 44, spo2: 91, lactate: 4.2 },
    { recorded_at: "2026-01-01T12:00:00Z", hr: 90 },
  ]),
  scenario("partial", [
    { recorded_at: "2026-01-01T12:00:00Z", gcs: 3, vent_mode: "SIMV", peep: 8 },
  ]),
];

describe("Latest observations: PDF export vs preview consistency", () => {
  it("PDF cell text equals the shared renderer output for every scenario", () => {
    for (const p of scenarios) {
      // Preview builds via handoverPdfPreviewUrl → buildHandoverPdf; export
      // builds via buildHandoverPdf directly. Both funnel through obsCol.render.
      const previewUrl = handoverPdfPreviewUrl([p]);
      expect(previewUrl.startsWith("blob:")).toBe(true);

      const pdfCell = obsCellText(buildHandoverPdf([p]));
      // The rendered block joins vitals with " · " and appends the timestamp on
      // a new line; autotable wrapping re-joins with spaces in obsCellText.
      const rendered = obsCol.render(p).replace(/\n/g, " ");
      expect(pdfCell).toBe(rendered);
    }
  });

  it("selects the newest observation by recorded_at regardless of order", () => {
    const out = obsCol.render(scenarios[2]);
    expect(out).toContain("HR 112");
    expect(out).not.toContain("HR 60");
    expect(out).not.toContain("HR 90");
  });

  it("shows the placeholder when a patient has no observations", () => {
    expect(obsCol.render(scenarios[0])).toBe("—");
    expect(obsCellText(buildHandoverPdf([scenarios[0]]))).toBe("—");
  });

  it("is deterministic: repeated renders produce identical cell text", () => {
    for (const p of scenarios) {
      const a = obsCellText(buildHandoverPdf([p]));
      const b = obsCellText(buildHandoverPdf([p]));
      expect(a).toBe(b);
    }
  });
});
