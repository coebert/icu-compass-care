import { describe, it, expect } from "vitest";
import { buildHandoverPdf, formatHandoverFilename, type HandoverPatient } from "@/lib/handover-pdf";

/**
 * Decode the readable text content of a jsPDF document. jsPDF writes text as
 * uncompressed `(...) Tj` operators, so the drawn strings (title, subtitle,
 * timestamp, footer, page numbers) appear verbatim in the raw bytes.
 */
async function pdfText(doc: ReturnType<typeof buildHandoverPdf>): Promise<string> {
  const bytes = new Uint8Array(await (doc.output("blob") as Blob).arrayBuffer());
  return new TextDecoder("latin1").decode(bytes);
}


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
    status: "referred",
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

  it("formats the download filename from title, timestamp and date placeholders", () => {
    const generatedAt = new Date("2026-07-10T16:45:00.000Z");
    const filename = formatHandoverFilename(
      "ICU Handover Sheet",
      "{title}_{date}_{timestamp}.pdf",
      generatedAt,
    );

    expect(filename).toBe("ICU_Handover_Sheet_2026-07-10_2026-07-10-16-45.pdf");
  });

  it("appends .pdf to the filename format when missing", () => {
    const generatedAt = new Date("2026-07-10T16:45:00.000Z");
    const filename = formatHandoverFilename("Critical Care", "{title}-{date}", generatedAt);

    expect(filename).toBe("Critical_Care-2026-07-10.pdf");
  });

  it("renders the custom header/footer options into the PDF text content", async () => {
    // Enough patients to force the table across more than one page so the
    // "Page X of Y" numbering can be verified for a multi-page document.
    const many: HandoverPatient[] = Array.from({ length: 60 }, (_, i) => ({
      full_name: `Patient ${i + 1}`,
      age: 40 + (i % 40),
      hospital_number: `H-${i + 1}`,
      ward: "ICU",
      bed: String(i + 1),
      status: "admitted",
      admission_date: new Date().toISOString(),
      past_medical_history: "COPD, hypertension, chronic kidney disease stage 3",
      current_admission: "Severe community-acquired pneumonia with respiratory failure",
      current_management: "HFNO, broad-spectrum antibiotics, hourly observations",
      outstanding_tasks: "Chase cultures; repeat ABG; family update; physio review",
    }));

    const doc = buildHandoverPdf(many, {
      title: "Night ICU Handover",
      subtitle: "Salisbury Critical Care Unit",
      footerText: "Confidential do not distribute",
      showTimestamp: true,
      showPageNumbers: true,
    });

    const totalPages = doc.getNumberOfPages();
    expect(totalPages, "sample should span multiple pages").toBeGreaterThan(1);

    const text = await pdfText(doc);

    // Custom title and subtitle.
    expect(text.includes("Night ICU Handover"), "title should appear").toBe(true);
    expect(text.includes("Salisbury Critical Care Unit"), "subtitle should appear").toBe(true);

    // Generated timestamp stamp.
    expect(/Generated\s/.test(text), "generated timestamp should appear").toBe(true);

    // Custom footer text.
    expect(text.includes("Confidential do not distribute"), "footer should appear").toBe(true);

    // Page numbering: first page and resolved total (not the placeholder token).
    expect(text.includes(`Page 1 of ${totalPages}`), "page 1 numbering").toBe(true);
    expect(text.includes(`Page ${totalPages} of ${totalPages}`), "last page numbering").toBe(true);
    expect(text.includes("{{TOTAL_PAGES}}"), "placeholder must be resolved").toBe(false);
  });

  it("omits the timestamp and page numbers when those toggles are off", async () => {
    const doc = buildHandoverPdf(
      [
        {
          full_name: "A.B.",
          status: "admitted",
          admission_date: new Date().toISOString(),
        },
      ],
      {
        title: "Day Handover",
        footerText: "Ward round summary",
        showTimestamp: false,
        showPageNumbers: false,
      },
    );

    const text = await pdfText(doc);

    expect(text.includes("Day Handover"), "title still renders").toBe(true);
    expect(text.includes("Ward round summary"), "footer still renders").toBe(true);
    expect(/Generated\s/.test(text), "timestamp suppressed").toBe(false);
    expect(/Page \d+ of/.test(text), "page numbers suppressed").toBe(false);
  });

});

