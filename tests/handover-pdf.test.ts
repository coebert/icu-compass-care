import { describe, it, expect } from "vitest";
import {
  buildHandoverPdf,
  formatHandoverFilename,
  sanitizeContentDispositionFilename,
  mostRecentInvestigation,
  RECENT_INVESTIGATION_CATEGORIES,
  type HandoverInvestigation,
  type HandoverPatient,
} from "@/lib/handover-pdf";

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

  it("includes the patient name, consultant/ward and escalation plan fields as text", async () => {
    // A single, fully-populated patient exercising every field the handover
    // sheet must surface: identity, location (consultant/ward), and the key
    // escalation-plan flags (TEP + DNACPR) with their free-text detail.
    const patient: HandoverPatient = {
      full_name: "Zephyr Q.",
      age: 63,
      hospital_number: "ZQ-2026-9",
      ward: "Radnor",
      bed: "4",
      status: "admitted",
      admission_date: "2026-07-01T00:00:00.000Z",
      accepting_consultant: "Dr Okafor",
      past_medical_history: "Ischaemic heart disease, CKD stage 3",
      current_admission: "Septic shock secondary to urosepsis",
      current_management: "Noradrenaline, broad-spectrum antibiotics, CRRT",
      outstanding_tasks: "Chase cultures; review CRRT circuit at 20:00",
      dnacpr_decision: true,
      dnacpr_details: "WardCeiling",
      tep_in_place: true,
      tep_details: "HFNOonly",
      nok_name: "Marion Q.",
      nok_relationship: "Wife",
      nok_contact: "07000 111222",
    };

    const doc = buildHandoverPdf([patient], {
      title: "ICU Handover Sheet",
      subtitle: `Consultant: ${patient.accepting_consultant}`,
    });

    const text = await pdfText(doc);

    // Patient identity.
    expect(text.includes("Zephyr Q."), "patient name should appear").toBe(true);
    expect(text.includes("ZQ-2026-9"), "hospital number should appear").toBe(true);

    // Consultant / ward location.
    expect(text.includes("Dr Okafor"), "consultant should appear").toBe(true);
    expect(text.includes("Radnor"), "ward should appear").toBe(true);

    // Key escalation-plan fields: TEP and DNACPR with their detail text.
    expect(text.includes("DNACPR"), "DNACPR flag should appear").toBe(true);
    expect(
      text.includes("WardCeiling"),
      "DNACPR detail should appear",
    ).toBe(true);
    expect(text.includes("TEP"), "TEP flag should appear").toBe(true);
    expect(
      text.includes("HFNOonly"),
      "TEP detail should appear",
    ).toBe(true);
  });

  it("reflects the newest Bloods, CXR and CT chest investigation entries", async () => {
    // Each category has multiple entries deliberately supplied out of
    // chronological order; the sheet must surface the newest one per category
    // by result_at, not the first/last in the array.
    const patient: HandoverPatient = {
      full_name: "R.T.",
      age: 66,
      hospital_number: "RT-INV-1",
      ward: "ICU",
      bed: "2",
      status: "admitted",
      admission_date: "2026-07-01T00:00:00.000Z",
      investigations: [
        // Bloods — newest is the 09 Jul entry.
        { category: "Bloods", findings: "OLDBLOODS", result_at: "2026-07-05T08:00:00.000Z" },
        { category: "Bloods", findings: "NEWBLOODS", result_at: "2026-07-09T06:30:00.000Z" },
        { category: "Bloods", findings: "MIDBLOODS", result_at: "2026-07-07T07:00:00.000Z" },
        // CXR — newest is the 08 Jul entry.
        { category: "CXR", findings: "OLDCXR", result_at: "2026-07-04T10:00:00.000Z" },
        { category: "CXR", findings: "NEWCXR", result_at: "2026-07-08T14:00:00.000Z" },
        // CT chest — newest is the 06 Jul entry.
        { category: "CT chest", findings: "NEWCT", result_at: "2026-07-06T12:00:00.000Z" },
        { category: "CT chest", findings: "OLDCT", result_at: "2026-07-02T09:00:00.000Z" },
      ],
    };

    const doc = buildHandoverPdf([patient], { title: "ICU Handover Sheet" });
    const text = await pdfText(doc);

    // Section headings are present.
    expect(text.includes("Most recent investigations"), "investigations header").toBe(true);

    // Newest entry for each category is rendered.
    expect(text.includes("NEWBLOODS"), "newest bloods should appear").toBe(true);
    expect(text.includes("NEWCXR"), "newest CXR should appear").toBe(true);
    expect(text.includes("NEWCT"), "newest CT chest should appear").toBe(true);

    // Older, superseded entries must NOT be shown in the "most recent" section.
    expect(text.includes("OLDBLOODS"), "old bloods hidden").toBe(false);
    expect(text.includes("MIDBLOODS"), "mid bloods hidden").toBe(false);
    expect(text.includes("OLDCXR"), "old CXR hidden").toBe(false);
    expect(text.includes("OLDCT"), "old CT chest hidden").toBe(false);
  });

});

/**
 * Build a long roster that reliably spans several pages so multi-page
 * numbering can be exercised regardless of page size / scaling.
 */
function longRoster(count: number): HandoverPatient[] {
  return Array.from({ length: count }, (_, i) => ({
    full_name: `Patient ${i + 1}`,
    age: 30 + (i % 50),
    hospital_number: `H-LONG-${i + 1}`,
    ward: "ICU",
    bed: String((i % 24) + 1),
    status: "admitted",
    admission_date: new Date().toISOString(),
    past_medical_history: "COPD, hypertension, chronic kidney disease stage 3, atrial fibrillation",
    current_admission: "Severe community-acquired pneumonia with type 1 respiratory failure",
    current_management: "HFNO, broad-spectrum antibiotics, cautious fluids, hourly observations",
    outstanding_tasks: "Chase blood cultures; repeat ABG at 18:00; family update; physio review",
  }));
}

/** Count how many times a regex matches across the whole document text. */
function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

describe("handover PDF multi-page header/footer toggles (e2e)", () => {
  const toggleCases: Array<{
    name: string;
    showTimestamp: boolean;
    showPageNumbers: boolean;
    footerText?: string;
  }> = [
    { name: "timestamp + page numbers", showTimestamp: true, showPageNumbers: true },
    { name: "page numbers only (no timestamp)", showTimestamp: false, showPageNumbers: true },
    { name: "timestamp only (no page numbers)", showTimestamp: true, showPageNumbers: false },
    { name: "neither timestamp nor page numbers", showTimestamp: false, showPageNumbers: false },
    {
      name: "page numbers with custom footer",
      showTimestamp: true,
      showPageNumbers: true,
      footerText: "Confidential ward round summary",
    },
  ];

  for (const c of toggleCases) {
    it(`applies Page X of Y placement/suppression: ${c.name}`, async () => {
      const doc = buildHandoverPdf(longRoster(90), {
        title: "Long ICU Handover",
        subtitle: "Salisbury Critical Care Unit",
        showTimestamp: c.showTimestamp,
        showPageNumbers: c.showPageNumbers,
        ...(c.footerText ? { footerText: c.footerText } : {}),
      });

      const totalPages = doc.getNumberOfPages();
      // The roster is large enough to force a genuine multi-page document.
      expect(totalPages, "roster should span multiple pages").toBeGreaterThan(2);

      const text = await pdfText(doc);

      // The placeholder token must always be resolved (or never emitted).
      expect(text.includes("{{TOTAL_PAGES}}"), "placeholder must be resolved").toBe(false);

      if (c.showPageNumbers) {
        // Exactly one "Page N of TOTAL" appears per page — placement is the
        // centered footer drawn once per page via didDrawPage.
        expect(
          countMatches(text, /Page \d+ of \d+/g),
          "one page-number stamp per page",
        ).toBe(totalPages);

        // First, an interior and the last page are all numbered against the
        // resolved total — proving the running "X of Y" is correct throughout.
        expect(text.includes(`Page 1 of ${totalPages}`), "first page numbered").toBe(true);
        expect(text.includes(`Page 2 of ${totalPages}`), "second page numbered").toBe(true);
        expect(
          text.includes(`Page ${totalPages} of ${totalPages}`),
          "last page numbered",
        ).toBe(true);

        // No page is numbered beyond the true total (no off-by-one overflow).
        expect(
          text.includes(`Page ${totalPages + 1} of`),
          "no page beyond the total",
        ).toBe(false);

        if (c.footerText) {
          // Placement: the page number sits alongside the footer text on the
          // same centered footer line, joined by the " · " separator.
          expect(
            text.includes(`${c.footerText} · Page 1 of ${totalPages}`),
            "page number placed next to custom footer text",
          ).toBe(true);
        }
      } else {
        // Suppression: no page numbering anywhere in the document.
        expect(/Page \d+ of/.test(text), "page numbers fully suppressed").toBe(false);
      }

      // Timestamp toggle is independent of the page-number toggle.
      expect(/Generated\s/.test(text), "timestamp toggle honoured").toBe(c.showTimestamp);
    });
  }
});

/**
 * A filename is safe to embed in an HTTP `Content-Disposition` header's
 * quoted-string form: `attachment; filename="<name>"`. It must not contain
 * characters that could terminate the quoted string or inject a new header,
 * nor path separators / OS-illegal characters.
 */
function isContentDispositionSafe(name: string): boolean {
  // No control chars (incl. CR/LF/TAB/NUL) — blocks header injection.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return false;
  // No quoting/terminating or path/OS-illegal characters.
  if (/["'\\/:*?<>|;,`]/.test(name)) return false;
  // Round-trips unchanged through a quoted Content-Disposition value.
  const header = `attachment; filename="${name}"`;
  return header === `attachment; filename="${name}"` && !/[\r\n]/.test(header);
}

describe("handover filename sanitization", () => {
  const generatedAt = new Date("2026-07-10T16:45:00.000Z");

  it("always returns a non-empty name ending in .pdf", () => {
    expect(sanitizeContentDispositionFilename("")).toBe("ICU_Handover.pdf");
    expect(sanitizeContentDispositionFilename("   ")).toBe("ICU_Handover.pdf");
    expect(sanitizeContentDispositionFilename("Night Handover")).toBe("Night_Handover.pdf");
    expect(sanitizeContentDispositionFilename("report.pdf").endsWith(".pdf")).toBe(true);
  });

  it("strips CR/LF and control characters to prevent header injection", () => {
    const evil = 'ICU\r\nSet-Cookie: x=1\t\u0000 Handover';
    const safe = sanitizeContentDispositionFilename(evil);
    expect(/[\r\n\t\u0000]/.test(safe)).toBe(false);
    expect(isContentDispositionSafe(safe)).toBe(true);
    expect(safe.endsWith(".pdf")).toBe(true);
  });

  it("removes path separators and OS-illegal characters", () => {
    const messy = '../../etc/passwd:*?"<>|.pdf';
    const safe = sanitizeContentDispositionFilename(messy);
    expect(safe.includes("/")).toBe(false);
    expect(safe.includes("\\")).toBe(false);
    expect(/[:*?"<>|]/.test(safe)).toBe(false);
    expect(isContentDispositionSafe(safe)).toBe(true);
  });

  it("does not leave a bare double quote that would break the header", () => {
    const safe = sanitizeContentDispositionFilename('My "ICU" Handover');
    expect(safe.includes('"')).toBe(false);
    expect(isContentDispositionSafe(safe)).toBe(true);
  });

  it("neutralises reserved Windows device names", () => {
    expect(sanitizeContentDispositionFilename("CON").toLowerCase()).not.toBe("con.pdf");
    expect(sanitizeContentDispositionFilename("nul.pdf").toLowerCase()).not.toBe("nul.pdf");
    expect(isContentDispositionSafe(sanitizeContentDispositionFilename("LPT1"))).toBe(true);
  });

  it("caps very long titles while keeping the .pdf extension", () => {
    const longTitle = "A".repeat(500);
    const safe = sanitizeContentDispositionFilename(longTitle);
    expect(safe.length).toBeLessThanOrEqual(180);
    expect(safe.endsWith(".pdf")).toBe(true);
    expect(isContentDispositionSafe(safe)).toBe(true);
  });

  it("strips leading dots so the result is never a hidden/empty file", () => {
    const safe = sanitizeContentDispositionFilename("...");
    expect(safe).toBe("ICU_Handover.pdf");
    expect(sanitizeContentDispositionFilename(".hidden").startsWith(".")).toBe(false);
  });

  it("produces a Content-Disposition-safe name from a hostile handover title", () => {
    const hostileTitle = 'ICU/Handover: "Night"\r\nX-Injected: 1 \\ shift *?<>|';
    const filename = formatHandoverFilename(hostileTitle, undefined, generatedAt);

    expect(isContentDispositionSafe(filename)).toBe(true);
    expect(filename.endsWith(".pdf")).toBe(true);

    // The assembled header round-trips without introducing new lines/headers.
    const header = `attachment; filename="${filename}"`;
    expect(/[\r\n]/.test(header)).toBe(false);
    expect(header.split('"').length).toBe(3); // exactly one opening + one closing quote
  });

  it("keeps ordinary titles readable and unchanged in spirit", () => {
    const filename = formatHandoverFilename("Night ICU Handover", "{title}_{date}", generatedAt);
    expect(filename).toBe("Night_ICU_Handover_2026-07-10.pdf");
    expect(isContentDispositionSafe(filename)).toBe(true);
  });
});


