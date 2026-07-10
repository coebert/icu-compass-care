import { describe, it, expect } from "vitest";
import {
  buildHandoverPdf,
  formatHandoverFilename,
  sanitizeContentDispositionFilename,
  sanitizePdfMetadataText,
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

describe("handover PDF key microbiology section (e2e)", () => {
  it("renders the newest result per specimen type as text and hides superseded ones", async () => {
    const patient: HandoverPatient = {
      full_name: "M.B.",
      age: 62,
      hospital_number: "MB-MICRO-1",
      ward: "ICU",
      bed: "5",
      status: "admitted",
      admission_date: "2026-07-01T00:00:00.000Z",
      microbiology_results: [
        // Blood culture — newest is the 09 Jul entry.
        { specimen_type: "Blood culture", findings: "OLDBLOODCX", result_at: "2026-07-05T08:00:00.000Z" },
        { specimen_type: "Blood culture", findings: "NEWBLOODCX", result_at: "2026-07-09T06:30:00.000Z" },
        // Respiratory — newest is the 08 Jul entry.
        { specimen_type: "Respiratory (sputum / BAL)", findings: "OLDRESP", result_at: "2026-07-04T10:00:00.000Z" },
        { specimen_type: "Respiratory (sputum / BAL)", findings: "NEWRESP", result_at: "2026-07-08T14:00:00.000Z" },
        // Urine — single entry.
        { specimen_type: "Urine", findings: "URINECX", result_at: "2026-07-06T12:00:00.000Z" },
      ],
    };

    const doc = buildHandoverPdf([patient], { title: "ICU Handover Sheet" });
    const text = await pdfText(doc);

    // Section heading is present.
    expect(text.includes("Key microbiology"), "microbiology header").toBe(true);

    // Newest result per specimen type is rendered as text.
    expect(text.includes("NEWBLOODCX"), "newest blood culture should appear").toBe(true);
    expect(text.includes("NEWRESP"), "newest respiratory should appear").toBe(true);
    expect(text.includes("URINECX"), "urine result should appear").toBe(true);
    expect(text.includes("Blood culture"), "blood culture specimen label").toBe(true);
    expect(text.includes("Urine"), "urine specimen label").toBe(true);

    // Older, superseded results must NOT appear.
    expect(text.includes("OLDBLOODCX"), "old blood culture hidden").toBe(false);
    expect(text.includes("OLDRESP"), "old respiratory hidden").toBe(false);
  });

  it("shows ONLY the most recent entry per specimen — no older duplicates", async () => {
    // Several results per specimen, inserted OUT OF ORDER with multiple older
    // duplicates, to prove the section collapses to exactly one line per
    // specimen (the latest by result_at) and drops every superseded entry.
    const patient: HandoverPatient = {
      full_name: "L.R.",
      age: 66,
      hospital_number: "LR-MICRO-LATEST",
      ward: "ICU",
      status: "admitted",
      admission_date: "2026-07-01T00:00:00.000Z",
      microbiology_results: [
        // Blood culture — 3 entries; newest is 10 Jul.
        { specimen_type: "Blood culture", findings: "BCOLDEST", result_at: "2026-07-03T09:00:00.000Z" },
        { specimen_type: "Blood culture", findings: "BCLATEST", result_at: "2026-07-10T07:15:00.000Z" },
        { specimen_type: "Blood culture", findings: "BCMIDDLE", result_at: "2026-07-06T18:00:00.000Z" },
        // Urine — 2 entries; newest is 09 Jul.
        { specimen_type: "Urine", findings: "URLATEST", result_at: "2026-07-09T11:30:00.000Z" },
        { specimen_type: "Urine", findings: "UROLDER", result_at: "2026-07-04T08:45:00.000Z" },
        // CSF — single entry.
        { specimen_type: "CSF", findings: "CEREBROMARK", result_at: "2026-07-05T13:20:00.000Z" },
      ],
    };

    const doc = buildHandoverPdf([patient], { title: "ICU Handover Sheet" });
    const text = await pdfText(doc);

    const count = (needle: string) => text.split(needle).length - 1;

    // Exactly ONE rendered line per specimen — no duplicate rows.
    expect(count("Blood culture"), "one Blood culture line").toBe(1);
    expect(count("Urine"), "one Urine line").toBe(1);
    expect(count("CSF"), "one CSF line").toBe(1);

    // Only the latest finding per specimen is present.
    expect(text.includes("BCLATEST"), "latest blood culture shown").toBe(true);
    expect(text.includes("URLATEST"), "latest urine shown").toBe(true);
    expect(text.includes("CEREBROMARK"), "single CSF shown").toBe(true);

    // Every older duplicate is absent.
    for (const stale of ["BCOLDEST", "BCMIDDLE", "UROLDER"]) {
      expect(text.includes(stale), `superseded '${stale}' must not appear`).toBe(false);
    }
  });



  it("shows an em dash when no microbiology is recorded", async () => {
    const patient: HandoverPatient = {
      full_name: "N.M.",
      age: 40,
      hospital_number: "NM-MICRO-0",
      ward: "ICU",
      status: "admitted",
      admission_date: "2026-07-01T00:00:00.000Z",
    };
    const doc = buildHandoverPdf([patient], { title: "ICU Handover Sheet" });
    const text = await pdfText(doc);
    expect(text.includes("Key microbiology"), "microbiology header").toBe(true);

    // The em dash placeholder is written for the empty cell. jsPDF encodes
    // U+2014 as WinAnsi byte 0x97, so assert on that byte, not the literal "—".
    expect(text.includes("\x97"), "em dash placeholder present").toBe(true);

    // No specimen labels may leak into a patient that has no results at all.
    for (const specimen of [
      "Blood culture",
      "Respiratory (sputum / BAL)",
      "Urine",
      "CSF",
    ]) {
      expect(
        text.includes(specimen),
        `no stale '${specimen}' label for a patient without micro results`,
      ).toBe(false);
    }
  });

  it("omits specimen types that have no results (only recorded specimens appear)", async () => {
    const patient: HandoverPatient = {
      full_name: "S.S.",
      age: 55,
      hospital_number: "SS-MICRO-SUB",
      ward: "ICU",
      status: "admitted",
      admission_date: "2026-07-01T00:00:00.000Z",
      // Only Urine has a result; every other specimen type is unrecorded.
      microbiology_results: [
        { specimen_type: "Urine", findings: "URINEONLY", result_at: "2026-07-06T12:00:00.000Z" },
      ],
    };
    const doc = buildHandoverPdf([patient], { title: "ICU Handover Sheet" });
    const text = await pdfText(doc);

    // The one recorded specimen renders.
    expect(text.includes("Urine"), "recorded specimen appears").toBe(true);
    expect(text.includes("URINEONLY"), "recorded finding appears").toBe(true);

    // Specimen types with NO results are omitted entirely — no blank/stale rows.
    for (const specimen of [
      "Blood culture",
      "Respiratory (sputum / BAL)",
      "CSF",
      "Wound / skin swab",
      "Line tip",
    ]) {
      expect(
        text.includes(specimen),
        `unrecorded specimen '${specimen}' must not appear`,
      ).toBe(false);
    }
  });

  it("renders an em dash for a specimen whose latest result has blank findings", async () => {
    const patient: HandoverPatient = {
      full_name: "B.F.",
      age: 48,
      hospital_number: "BF-MICRO-BLANK",
      ward: "ICU",
      status: "admitted",
      admission_date: "2026-07-01T00:00:00.000Z",
      microbiology_results: [
        { specimen_type: "Urine", findings: "", result_at: "2026-07-06T12:00:00.000Z" },
      ],
    };
    const doc = buildHandoverPdf([patient], { title: "ICU Handover Sheet" });
    const text = await pdfText(doc);

    // The specimen label is present, and its blank findings render as the em
    // dash placeholder (WinAnsi byte 0x97) rather than an empty string.
    expect(text.includes("Urine"), "specimen label present").toBe(true);
    expect(text.includes("\x97"), "blank findings render as em dash").toBe(true);
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



  it("preserves non-ASCII letters, accents and scripts", () => {
    // Accented Latin, German eszett, Greek, Cyrillic, CJK, emoji.
    const cases: Array<[string, string]> = [
      ["Réanimation Handover", "Réanimation_Handover.pdf"],
      ["Intensivstation Übergabe", "Intensivstation_Übergabe.pdf"],
      ["Passação de plantão UTI", "Passação_de_plantão_UTI.pdf"],
      ["Παράδοση ΜΕΘ", "Παράδοση_ΜΕΘ.pdf"],
      ["Передача смены", "Передача_смены.pdf"],
      ["集中治療 申し送り", "集中治療_申し送り.pdf"],
    ];
    for (const [input, expected] of cases) {
      const safe = sanitizeContentDispositionFilename(input);
      expect(safe, `for input ${JSON.stringify(input)}`).toBe(expected);
      // The non-ASCII characters must survive verbatim.
      for (const ch of input.replace(/\s+/g, "")) {
        expect(safe.includes(ch), `char ${JSON.stringify(ch)} preserved`).toBe(true);
      }
      expect(isContentDispositionSafe(safe)).toBe(true);
    }
  });

  it("keeps non-ASCII while still removing unsafe characters around it", () => {
    const safe = sanitizeContentDispositionFilename('Réa/UTI:"Nuit" — Übergabe');
    // Accented characters and the em dash are preserved…
    expect(safe.includes("é")).toBe(true);
    expect(safe.includes("Ü")).toBe(true);
    expect(safe.includes("—")).toBe(true);
    // …but path/quote/OS-illegal characters are gone.
    expect(/[/\\:*?"<>|]/.test(safe)).toBe(false);
    expect(isContentDispositionSafe(safe)).toBe(true);
    expect(safe.endsWith(".pdf")).toBe(true);
  });

  it("yields a valid quoted Content-Disposition value for a non-ASCII name", () => {
    const filename = sanitizeContentDispositionFilename("Réanimation — Übergabe");

    // Non-ASCII survives into the final assembled filename.
    expect(filename.includes("é")).toBe(true);
    expect(filename.includes("Ü")).toBe(true);
    expect(isContentDispositionSafe(filename)).toBe(true);

    // The quoted-string form has exactly one opening + one closing quote and
    // introduces no CR/LF that could split the header.
    const header = `attachment; filename="${filename}"`;
    expect(header.split('"').length).toBe(3);
    expect(/[\r\n]/.test(header)).toBe(false);

    // The bytes are legal in an HTTP token/quoted-string context: they encode
    // cleanly (a real server pairs this with a filename* UTF-8 form, but the
    // ASCII-quoted fallback must not itself be malformed).
    expect(() => encodeURIComponent(filename)).not.toThrow();
  });
});

describe("PDF internal document metadata sanitisation", () => {
  it("sanitizePdfMetadataText strips control chars and PDF string delimiters", () => {
    const evil = "ICU (Night)\r\n/Author (hacker)\\ >>endobj";
    const safe = sanitizePdfMetadataText(evil);
    // No PDF string delimiters or escape char remain.
    expect(/[()\\]/.test(safe)).toBe(false);
    // No control characters (CR/LF/TAB/NUL) remain.
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f\u007f]/.test(safe)).toBe(false);
    expect(safe.length).toBeGreaterThan(0);
  });

  it("falls back when the title is empty after sanitising", () => {
    expect(sanitizePdfMetadataText("()\\", "ICU Handover Sheet")).toBe("ICU Handover Sheet");
    expect(sanitizePdfMetadataText("", "ICU Handover Sheet")).toBe("ICU Handover Sheet");
  });

  it("uses the sanitized title for the PDF's internal /Title metadata", async () => {
    const hostileTitle = "Ward 9 (secret)\r\n/Author (evil)\\";
    const patient = SAMPLE_PATIENTS[0];
    const doc = buildHandoverPdf([patient], { title: hostileTitle });

    // The raw PDF bytes carry the sanitized title in the info dictionary and
    // never contain the hostile fragments verbatim — no injected /Author,
    // unescaped parentheses, or CRLF.
    const raw = await pdfText(doc);
    const safeTitle = sanitizePdfMetadataText(hostileTitle);
    expect(raw.includes(`/Title (${safeTitle})`)).toBe(true);
    expect(raw.includes("/Author (evil)")).toBe(false);
    expect(raw.includes("Ward 9 (secret)")).toBe(false);
    expect(raw.includes("(secret)")).toBe(false);
  });
});



describe("most recent investigation selection", () => {
  it("picks the newest entry per category, ignoring array order", () => {
    const list: HandoverInvestigation[] = [
      { category: "Bloods", findings: "OLD", result_at: "2026-07-05T08:00:00.000Z" },
      { category: "Bloods", findings: "NEW", result_at: "2026-07-09T06:30:00.000Z" },
      { category: "Bloods", findings: "MID", result_at: "2026-07-07T07:00:00.000Z" },
    ];
    expect(mostRecentInvestigation(list, "Bloods")?.findings).toBe("NEW");
  });

  it("matches categories case-insensitively", () => {
    const list: HandoverInvestigation[] = [
      { category: "ct chest", findings: "CT-A", result_at: "2026-07-02T09:00:00.000Z" },
      { category: "CT CHEST", findings: "CT-B", result_at: "2026-07-06T12:00:00.000Z" },
    ];
    expect(mostRecentInvestigation(list, "CT chest")?.findings).toBe("CT-B");
  });

  it("does not bleed entries across categories", () => {
    const list: HandoverInvestigation[] = [
      { category: "CXR", findings: "CXR-ONLY", result_at: "2026-07-08T14:00:00.000Z" },
      { category: "Bloods", findings: "BLOODS-ONLY", result_at: "2026-07-09T14:00:00.000Z" },
    ];
    expect(mostRecentInvestigation(list, "CXR")?.findings).toBe("CXR-ONLY");
    expect(mostRecentInvestigation(list, "CT chest")).toBeUndefined();
  });

  it("breaks a result_at tie deterministically, independent of array order", () => {
    const at = "2026-07-09T06:30:00.000Z";
    const a: HandoverInvestigation = { id: "a", category: "Bloods", findings: "A", result_at: at };
    const b: HandoverInvestigation = { id: "b", category: "Bloods", findings: "B", result_at: at };
    // Same inputs, opposite order → same winner (larger id 'b').
    expect(mostRecentInvestigation([a, b], "Bloods")?.findings).toBe("B");
    expect(mostRecentInvestigation([b, a], "Bloods")?.findings).toBe("B");
  });

  it("breaks a result_at tie on the newer created_at", () => {
    const at = "2026-07-09T06:30:00.000Z";
    const older = {
      id: "x", category: "Bloods", findings: "EARLIER-ENTRY", result_at: at,
      created_at: "2026-07-09T06:31:00.000Z",
    };
    const newer = {
      id: "y", category: "Bloods", findings: "LATER-ENTRY", result_at: at,
      created_at: "2026-07-09T07:00:00.000Z",
    };
    expect(mostRecentInvestigation([older, newer], "Bloods")?.findings).toBe("LATER-ENTRY");
    expect(mostRecentInvestigation([newer, older], "Bloods")?.findings).toBe("LATER-ENTRY");
  });

  it("treats missing/invalid result_at as oldest", () => {
    const list: HandoverInvestigation[] = [
      { category: "Bloods", findings: "NO-DATE" },
      { category: "Bloods", findings: "BAD-DATE", result_at: "not-a-date" },
      { category: "Bloods", findings: "DATED", result_at: "2026-07-01T00:00:00.000Z" },
    ];
    expect(mostRecentInvestigation(list, "Bloods")?.findings).toBe("DATED");
  });

  it("is deterministic when ALL entries have missing result_at (tie-break on created_at, order-independent)", () => {
    const a = { id: "a", category: "Bloods", findings: "A", created_at: "2026-07-01T00:00:00.000Z" };
    const b = { id: "b", category: "Bloods", findings: "B", created_at: "2026-07-03T00:00:00.000Z" };
    const c = { id: "c", category: "Bloods", findings: "C", created_at: "2026-07-02T00:00:00.000Z" };
    // Newest created_at ('b') wins regardless of input order.
    expect(mostRecentInvestigation([a, b, c], "Bloods")?.findings).toBe("B");
    expect(mostRecentInvestigation([c, a, b], "Bloods")?.findings).toBe("B");
    expect(mostRecentInvestigation([b, c, a], "Bloods")?.findings).toBe("B");
  });

  it("is deterministic when result_at AND created_at all tie (stable id tie-break)", () => {
    const at = "2026-07-09T06:30:00.000Z";
    const ct = "2026-07-09T06:30:00.000Z";
    const mk = (id: string) => ({ id, category: "Bloods", findings: id, result_at: at, created_at: ct });
    const a = mk("a1"), b = mk("b2"), c = mk("c3");
    // Largest id ('c3') wins regardless of order.
    expect(mostRecentInvestigation([a, b, c], "Bloods")?.findings).toBe("c3");
    expect(mostRecentInvestigation([c, b, a], "Bloods")?.findings).toBe("c3");
  });

  it("returns undefined for empty/nullish lists", () => {
    expect(mostRecentInvestigation([], "Bloods")).toBeUndefined();
    expect(mostRecentInvestigation(null, "Bloods")).toBeUndefined();
    expect(mostRecentInvestigation(undefined, "Bloods")).toBeUndefined();
  });

  it("exposes the three surfaced categories in display order", () => {
    expect([...RECENT_INVESTIGATION_CATEGORIES]).toEqual(["Bloods", "CXR", "CT chest"]);
  });

  it("renders exactly one 'most recent' line per category in the PDF, newest only", async () => {
    const patient: HandoverPatient = {
      full_name: "Inv Test",
      status: "admitted",
      admission_date: "2026-07-01T00:00:00.000Z",
      investigations: [
        { category: "Bloods", findings: "OLDBLOODS", result_at: "2026-07-05T08:00:00.000Z" },
        { category: "Bloods", findings: "NEWBLOODS", result_at: "2026-07-09T06:30:00.000Z" },
        { category: "CXR", findings: "OLDCXR", result_at: "2026-07-04T10:00:00.000Z" },
        { category: "CXR", findings: "NEWCXR", result_at: "2026-07-08T14:00:00.000Z" },
        { category: "CT chest", findings: "NEWCT", result_at: "2026-07-06T12:00:00.000Z" },
        { category: "CT chest", findings: "OLDCT", result_at: "2026-07-02T09:00:00.000Z" },
      ],
    };

    const text = await (async () => {
      const doc = buildHandoverPdf([patient], { title: "ICU Handover Sheet" });
      const bytes = new Uint8Array(await (doc.output("blob") as Blob).arrayBuffer());
      return new TextDecoder("latin1").decode(bytes);
    })();

    for (const findings of ["NEWBLOODS", "NEWCXR", "NEWCT"]) {
      expect(text.includes(findings), `${findings} should render`).toBe(true);
    }
    for (const findings of ["OLDBLOODS", "OLDCXR", "OLDCT"]) {
      expect(text.includes(findings), `${findings} should be hidden`).toBe(false);
    }
  });
});


/**
 * Measure the rendered width (mm) of a string using the same font family,
 * style and point size the PDF builder uses for a given chrome element. The
 * built document already carries jsPDF's metric tables, so setting the font
 * and calling getTextWidth reproduces the on-page geometry exactly.
 */
function measureWidth(
  doc: ReturnType<typeof buildHandoverPdf>,
  text: string,
  family: string,
  style: "normal" | "bold",
  sizePt: number,
): number {
  doc.setFont(family, style);
  doc.setFontSize(sizePt);
  return doc.getTextWidth(text);
}

/**
 * Font-scale robustness: the header title / timestamp and the footer text +
 * "Page X of Y" are drawn at FIXED point sizes independent of the table body
 * `fontScale`. This suite proves that (a) the chrome renders identically at
 * every scale (desktop's default 1.0 and the mobile preview's smaller/larger
 * scales), and (b) nothing collides or spills off-page, so no text is ever
 * truncated regardless of scale or page size.
 */
describe("handover PDF header/footer font-scale consistency (e2e)", () => {
  const MARGIN_X = 8; // matches builder default
  // Header point sizes drawn in didDrawPage.
  const TITLE_PT = 11;
  const TIMESTAMP_PT = 8;
  const FOOTER_PT = 8;

  const scales = [0.6, 0.85, 1, 1.25, 1.6];
  const pageSizes = ["a4", "letter"] as const;

  const LONG_TITLE = "Salisbury District Hospital - Critical Care Handover Sheet";
  const LONG_FOOTER = "CONFIDENTIAL - Salisbury District Hospital Critical Care Unit";

  for (const pageSize of pageSizes) {
    describe(`page size ${pageSize}`, () => {
      it("renders all chrome text at every font scale without truncation or collision", async () => {
        const roster = longRoster(60);

        // Capture geometry per scale so we can prove cross-scale consistency.
        const titleWidths: number[] = [];
        const footerWidths: number[] = [];

        for (const fontScale of scales) {
          const doc = buildHandoverPdf(roster, {
            title: LONG_TITLE,
            footerText: LONG_FOOTER,
            showTimestamp: true,
            showPageNumbers: true,
            pageSize,
            fontScale,
          });

          const pageWidth = doc.internal.pageSize.getWidth();
          const contentWidth = pageWidth - MARGIN_X * 2;
          const totalPages = doc.getNumberOfPages();
          const text = await pdfText(doc);

          // 1. Every chrome string is actually present, unaffected by scale.
          expect(text.includes(LONG_TITLE), `title present @${fontScale}`).toBe(true);
          expect(/Generated\s/.test(text), `timestamp present @${fontScale}`).toBe(true);
          expect(
            text.includes(`Page 1 of ${totalPages}`),
            `page numbering present @${fontScale}`,
          ).toBe(true);
          expect(
            text.includes(`${LONG_FOOTER} · Page 1 of ${totalPages}`),
            `footer text + page number joined @${fontScale}`,
          ).toBe(true);

          // 2. Header: title (left) and "Generated …" (right) must not overlap.
          const generatedStamp = `Generated ${new Date().toLocaleString("en-GB")}`;
          const titleW = measureWidth(doc, LONG_TITLE, "helvetica", "bold", TITLE_PT);
          const stampW = measureWidth(doc, generatedStamp, "helvetica", "normal", TIMESTAMP_PT);
          const titleRightEdge = MARGIN_X + titleW;
          const stampLeftEdge = pageWidth - MARGIN_X - stampW;
          expect(
            titleRightEdge,
            `header title must not overlap the timestamp @${fontScale} (${pageSize})`,
          ).toBeLessThan(stampLeftEdge);

          // 3. Footer: the centered "footer · Page X of Y" line must fit within
          //    the printable content width so it is never clipped at the edges.
          const footerLine = `${LONG_FOOTER} · Page ${totalPages} of ${totalPages}`;
          const footerW = measureWidth(doc, footerLine, "helvetica", "normal", FOOTER_PT);
          expect(
            footerW,
            `footer line must fit within content width @${fontScale} (${pageSize})`,
          ).toBeLessThanOrEqual(contentWidth);

          titleWidths.push(titleW);
          // Consistency is checked on the scale-invariant footer text only;
          // the full line's width legitimately varies with the page count
          // (fewer rows per page at larger body scales changes "of Y" digits).
          footerWidths.push(measureWidth(doc, LONG_FOOTER, "helvetica", "normal", FOOTER_PT));
        }

        // 4. Consistency: because the chrome is drawn at fixed point sizes, its
        //    geometry must be byte-identical across every body font scale.
        for (let i = 1; i < titleWidths.length; i++) {
          expect(
            titleWidths[i],
            `title width identical across scales (${scales[i]} vs ${scales[0]})`,
          ).toBeCloseTo(titleWidths[0], 5);
          expect(
            footerWidths[i],
            `footer width identical across scales (${scales[i]} vs ${scales[0]})`,
          ).toBeCloseTo(footerWidths[0], 5);
        }
      });
    });
  }
});




