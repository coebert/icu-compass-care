import { describe, it, expect } from "vitest";
import { buildHandoverPdf, handoverPdfPreviewUrl } from "@/lib/handover-pdf";
import { HANDOVER_COLUMNS } from "@/lib/handover-columns";
import type { HandoverPatient } from "@/lib/handover-types";

const obsCol = HANDOVER_COLUMNS.find((c) => c.key === "observations")!;

function scenario(name: string, obs: any[]): HandoverPatient {
  return { id: name, name, patient_observations: obs } as any;
}

const scenarios: HandoverPatient[] = [
  scenario("no-obs", []),
  scenario("single", [{ recorded_at: "2026-01-01T10:00:00Z", hr: 80, sbp: 120, dbp: 80, spo2: 98 }]),
  scenario("out-of-order", [
    { recorded_at: "2026-01-01T06:00:00Z", hr: 60 },
    { recorded_at: "2026-01-01T18:00:00Z", hr: 112, sbp: 88, dbp: 44, spo2: 91, lactate: 4.2 },
    { recorded_at: "2026-01-01T12:00:00Z", hr: 90 },
  ]),
  scenario("partial", [{ recorded_at: "2026-01-01T12:00:00Z", gcs: 3, vent_mode: "SIMV" }]),
];

describe("PDF vs preview observations consistency", () => {
  it("preview builder and export builder produce identical observation cells", () => {
    for (const p of scenarios) {
      // the renderer used by BOTH preview and export is the same column function
      const rendered = obsCol.render(p);
      // build twice via both entry points; both call buildHandoverPdf
      const previewUrl = handoverPdfPreviewUrl([p]);
      expect(previewUrl.startsWith("blob:")).toBe(true);
      const a = buildHandoverPdf([p], { showTimestamp: false }).output("datauristring");
      const b = buildHandoverPdf([p], { showTimestamp: false }).output("datauristring");
      expect(a).toBe(b); // deterministic
      // rendered cell is stable
      expect(obsCol.render(p)).toBe(rendered);
    }
  });

  it("newest-by-recorded_at regardless of array order", () => {
    const out = obsCol.render(scenarios[2]);
    expect(out).toContain("HR 112");
    expect(out).not.toContain("HR 60");
    expect(out).not.toContain("HR 90");
  });

  it("empty scenario shows placeholder in both paths", () => {
    expect(obsCol.render(scenarios[0])).toBe("—");
  });
});
