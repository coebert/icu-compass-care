import { describe, it, expect } from "vitest";
import { buildHandoverPdf, type HandoverPatient } from "@/lib/handover-pdf";

/**
 * End-to-end test for the landscape handover PDF export.
 *
 * Exercises the full document build used by the "Download PDF" / preview flow
 * and verifies the produced bytes are a genuine, well-formed PDF laid out in
 * landscape orientation.
 *
 * Run:  bunx vitest run tests/handover-pdf.test.ts
 */

const SAMPLE_PATIENTS: HandoverPatient[] = [
  {
    full_name: "A.B.",
    age: 71,
    hospital_number: "H-PDF-1",
    ward: "ICU",
    bed: "3",
    status: "admitted",
    admission_date: new Date().toISOString(),
    past_medical_history: "COPD, hypertension, type 2 diabetes",
    current_admission: "Community-acquired pneumonia with type 1 respiratory failure",
    current_management:
      "HFNO, IV co-amoxiclav + clarithromycin, cautious fluid resuscitation, hourly obs",
    outstanding_tasks: "Repeat ABG at 18:00; chase blood cultures; physio review",
    dnacpr_decision: true,
    dnacpr_details: "Discussed with family",
    tep_in_place: true,
    nok_name: "Jane B.",
    nok_relationship: "Daughter",
    nok_contact: "07000 000000",
  },
  {
    full_name: "C.D.",
    age: 58,
    hospital_number: "H-PDF-2",
    ward: "Farley",
    status: "outlier" in {} ? "referred" : "referred",
    admission_date: new Date().toISOString(),
    past_medical_history: "Nil of note",
    current_admission: "Post-op monitoring following emergency laparotomy",
    current_management: "Epidural analgesia, DVT prophylaxis, early mobilisation",
    outstanding_tasks: "Remove catheter tomorrow",
  },
];

function isPdfMagic(bytes: Uint8Array): boolean {
  // A valid PDF starts with the ASCII bytes "%PDF-".
  return (
    bytes[0] === 0x25 && // %
    bytes[1] === 0x50 && // P
    bytes[2] === 0x44 && // D
    bytes[3] === 0x46 && // F
    bytes[4] === 0x2d // -
  );
}

describe("handover PDF export (e2e)", () => {
  it("exports a landscape PDF whose bytes are a valid PDF file", async () => {
    const doc = buildHandoverPdf(SAMPLE_PATIENTS, {
      title: "ICU Handover Sheet",
      subtitle: "Critical Care Unit",
    });

    // 1. Landscape orientation — width must exceed height.
    const width = doc.internal.pageSize.getWidth();
    const height = doc.internal.pageSize.getHeight();
    expect(width, "page width should exceed height (landscape)").toBeGreaterThan(height);

    // 2. The document produced at least one page.
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);

    // 3. The exported blob has the PDF MIME type and non-trivial size.
    const blob = doc.output("blob") as Blob;
    expect(blob.type).toBe("application/pdf");
    expect(blob.size, "PDF blob should not be empty").toBeGreaterThan(1000);

    // 4. The raw bytes begin with the PDF magic number and end with the EOF marker.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(isPdfMagic(bytes), "blob must start with %PDF-").toBe(true);

    const tail = new TextDecoder().decode(bytes.slice(-1024));
    expect(tail.includes("%%EOF"), "PDF must contain the %%EOF trailer").toBe(true);
  });

  it("produces a valid landscape PDF for Letter page size with heavy scaling", async () => {
    const doc = buildHandoverPdf(SAMPLE_PATIENTS, {
      pageSize: "letter",
      marginX: 12,
      fontScale: 1.4,
    });

    const width = doc.internal.pageSize.getWidth();
    const height = doc.internal.pageSize.getHeight();
    expect(width).toBeGreaterThan(height);

    const dataUri = doc.output("datauristring");
    expect(dataUri.startsWith("data:application/pdf")).toBe(true);
  });
});
