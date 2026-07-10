import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { STATUS_LABELS, fmtDate, fmtDateTime } from "@/lib/icu";

export type HandoverInvestigation = {
  category?: string | null;
  findings?: string | null;
  result_at?: string | null;
  [key: string]: any;
};

export type HandoverMicrobiology = {
  specimen_type?: string | null;
  findings?: string | null;
  result_at?: string | null;
  [key: string]: any;
};

export type HandoverPatient = Record<string, any>;

function joinNonEmpty(parts: (string | null | undefined | false)[], sep = "\n"): string {
  return parts.filter(Boolean).join(sep);
}

function identity(p: HandoverPatient): string {
  return joinNonEmpty([
    p.full_name?.trim() || "—",
    p.age != null ? `Age ${p.age}` : null,
    p.hospital_number ? `MRN ${p.hospital_number}` : null,
  ]);
}

function location(p: HandoverPatient): string {
  return joinNonEmpty([
    p.ward ? `${p.ward}${p.bed ? ` · Bed ${p.bed}` : ""}` : "No location",
    STATUS_LABELS[p.status] ?? p.status,
    `Adm ${fmtDate(p.admission_date)}`,
  ]);
}

function flags(p: HandoverPatient): string {
  const f: string[] = [];
  if (p.dnacpr_decision) f.push(`DNACPR${p.dnacpr_details ? `: ${p.dnacpr_details}` : ""}`);
  if (p.tep_in_place) f.push(`TEP${p.tep_details ? `: ${p.tep_details}` : ""}`);
  if (p.nok_name) f.push(`NOK: ${p.nok_name}${p.nok_relationship ? ` (${p.nok_relationship})` : ""}${p.nok_contact ? ` ${p.nok_contact}` : ""}`);
  return f.length ? f.join("\n") : "—";
}

/**
 * The investigation categories the handover sheet surfaces as dedicated
 * "most recent" lines, in display order. Their labels drive the text rendered
 * for each patient's investigations column.
 */
export const RECENT_INVESTIGATION_CATEGORIES = ["Bloods", "CXR", "CT chest"] as const;

function parseTime(value?: string | null): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

/**
 * Pick the newest investigation for `category` from a patient's investigation
 * list, comparing by `result_at`. Returns undefined when none exist.
 */
export function mostRecentInvestigation(
  investigations: HandoverInvestigation[] | null | undefined,
  category: string,
): HandoverInvestigation | undefined {
  if (!investigations?.length) return undefined;
  return investigations
    .filter((i) => (i.category ?? "").toLowerCase() === category.toLowerCase())
    .reduce<HandoverInvestigation | undefined>((best, cur) => {
      if (!best) return cur;
      return parseTime(cur.result_at) >= parseTime(best.result_at) ? cur : best;
    }, undefined);
}

/**
 * Render the "most recent" investigations column: one line per key category
 * (Bloods / CXR / CT chest) showing the newest findings and its result time.
 */
function investigations(p: HandoverPatient): string {
  const list: HandoverInvestigation[] = Array.isArray(p.investigations) ? p.investigations : [];
  const lines = RECENT_INVESTIGATION_CATEGORIES.map((category) => {
    const latest = mostRecentInvestigation(list, category);
    if (!latest) return `${category}: —`;
    const when = latest.result_at ? ` (${fmtDateTime(latest.result_at)})` : "";
    return `${category}: ${latest.findings || "—"}${when}`;
  });
  return lines.join("\n");
}

/**
 * Pick the newest microbiology result per specimen type from a patient's
 * microbiology list, comparing by `result_at`. Returns one entry per specimen
 * type that has any result, ordered by most recent result first.
 */
export function latestMicrobiologyPerSpecimen(
  results: HandoverMicrobiology[] | null | undefined,
): HandoverMicrobiology[] {
  if (!results?.length) return [];
  const bySpecimen = new Map<string, HandoverMicrobiology>();
  for (const r of results) {
    const specimen = (r.specimen_type ?? "").trim() || "Other";
    const existing = bySpecimen.get(specimen);
    if (!existing || parseTime(r.result_at) >= parseTime(existing.result_at)) {
      bySpecimen.set(specimen, r);
    }
  }
  return [...bySpecimen.values()].sort(
    (a, b) => parseTime(b.result_at) - parseTime(a.result_at),
  );
}

/**
 * Render the "key microbiology" column: the newest result for each specimen
 * type that has any recorded finding, most recent first.
 */
function microbiology(p: HandoverPatient): string {
  const list: HandoverMicrobiology[] = Array.isArray(p.microbiology_results)
    ? p.microbiology_results
    : Array.isArray(p.microbiology)
      ? p.microbiology
      : [];
  const latest = latestMicrobiologyPerSpecimen(list);
  if (!latest.length) return "—";
  return latest
    .map((r) => {
      const specimen = (r.specimen_type ?? "").trim() || "Other";
      const when = r.result_at ? ` (${fmtDateTime(r.result_at)})` : "";
      return `${specimen}: ${r.findings || "—"}${when}`;
    })
    .join("\n");
}




export type HandoverPageSize = "a4" | "letter";

export type HandoverPdfOptions = {
  /** Header title text (left of the header). Defaults to "ICU Handover Sheet". */
  title?: string;
  /** Optional subtitle shown under the title (e.g. unit / ward name). */
  subtitle?: string;
  /** Footer text shown centered. Defaults to a confidentiality notice. */
  footerText?: string;
  /** Show the "Generated <timestamp>" stamp in the header. Default true. */
  showTimestamp?: boolean;
  /** Show "Page X of Y" in the footer. Default true. */
  showPageNumbers?: boolean;
  /** Page size. Default "a4". */
  pageSize?: HandoverPageSize;
  /** Left/right page margin in mm. Default 8. */
  marginX?: number;
  /** Font scale multiplier for the table body. Default 1 (7pt). */
  fontScale?: number;
  /**
   * Download filename format. Placeholders:
   *   {title}     - the configured header title, sanitised for a filename
   *   {timestamp} - ISO-style timestamp, e.g. "2026-07-10-16-45"
   *   {date}      - date only, e.g. "2026-07-10"
   * Default: "{title} - {timestamp}.pdf"
   */
  filenameFormat?: string;
};


const DEFAULT_TITLE = "ICU Handover Sheet";
const DEFAULT_FOOTER = "Confidential — patient identifiable information";

// Proportional column weights (must fit within available content width).
const COLUMN_WEIGHTS = [30, 28, 34, 40, 40, 38, 40, 40, 32];
const COLUMN_TOTAL = COLUMN_WEIGHTS.reduce((a, b) => a + b, 0);

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Build a landscape handover sheet document. Every patient becomes one
 * row in a printable table; long free-text fields wrap within their column so
 * each patient's information is scaled to fit on the sheet across pages.
 * Page size (A4/Letter), horizontal margins, and body font scaling are
 * configurable via `opts` so the table always fits cleanly when text is long,
 * as are the header and footer contents.
 */
export function buildHandoverPdf(patients: HandoverPatient[], opts?: HandoverPdfOptions): jsPDF {
  const pageSize: HandoverPageSize = opts?.pageSize ?? "a4";
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: pageSize });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const generated = new Date().toLocaleString("en-GB");
  const title = opts?.title?.trim() || DEFAULT_TITLE;
  const subtitle = opts?.subtitle?.trim() || "";
  const footerText = opts?.footerText?.trim() || DEFAULT_FOOTER;
  const showTimestamp = opts?.showTimestamp ?? true;
  const showPageNumbers = opts?.showPageNumbers ?? true;
  const marginX = clamp(opts?.marginX ?? 8, 2, 30);
  const fontScale = clamp(opts?.fontScale ?? 1, 0.6, 1.6);
  const PAGE_TOKEN = "{{TOTAL_PAGES}}";

  const bodyFontSize = 7 * fontScale;
  const headFontSize = 7.5 * fontScale;

  // Distribute the proportional weights across the available content width so
  // the columns always span the page exactly, whatever the size/margin.
  const contentWidth = pageWidth - marginX * 2;
  const columnStyles: Record<number, { cellWidth: number; fontStyle?: "bold" }> = {};
  COLUMN_WEIGHTS.forEach((w, i) => {
    columnStyles[i] = { cellWidth: (w / COLUMN_TOTAL) * contentWidth };
  });
  columnStyles[0].fontStyle = "bold";

  autoTable(doc, {
    head: [[
      "Patient",
      "Location / status",
      "Past medical history",
      "Current admission",
      "Management",
      "Most recent investigations",
      "Outstanding tasks",
      "TEP / DNACPR / NOK",
    ]],
    body: patients.map((p) => [
      identity(p),
      location(p),
      p.past_medical_history || "—",
      p.current_admission || "—",
      p.current_management || "—",
      investigations(p),
      p.outstanding_tasks || "—",
      flags(p),
    ]),
    startY: subtitle ? 22 : 20,
    margin: { top: subtitle ? 22 : 18, left: marginX, right: marginX, bottom: 12 },
    tableWidth: contentWidth,
    styles: {
      fontSize: bodyFontSize,
      cellPadding: 1.5,
      overflow: "linebreak",
      valign: "top",
      lineColor: [180, 180, 180],
      lineWidth: 0.1,
    },
    headStyles: {
      fillColor: [15, 23, 42],
      textColor: [255, 255, 255],
      fontSize: headFontSize,
      fontStyle: "bold",
    },
    alternateRowStyles: { fillColor: [245, 247, 250] },
    columnStyles,
    didDrawPage: () => {
      // Header
      doc.setFont("helvetica", "bold");
      doc.setFontSize(11);
      doc.setTextColor(15, 23, 42);
      doc.text(title, marginX, 12);
      doc.setFont("helvetica", "normal");
      if (subtitle) {
        doc.setFontSize(8);
        doc.setTextColor(90, 90, 90);
        doc.text(subtitle, marginX, 17);
      }
      if (showTimestamp) {
        doc.setFontSize(8);
        doc.setTextColor(110, 110, 110);
        doc.text(`Generated ${generated}`, pageWidth - marginX, 12, { align: "right" });
      }

      // Footer
      doc.setFontSize(8);
      doc.setTextColor(110, 110, 110);
      const page = doc.getNumberOfPages();
      const footerSegments = [
        footerText,
        showPageNumbers ? `Page ${page} of ${PAGE_TOKEN}` : null,
      ].filter(Boolean);
      if (footerSegments.length > 0) {
        doc.text(footerSegments.join(" · "), pageWidth / 2, pageHeight - 5, { align: "center" });
      }
    },
  });

  // Replace the total-pages placeholder now that the page count is known.
  if (showPageNumbers && typeof doc.putTotalPages === "function") {
    doc.putTotalPages(PAGE_TOKEN);
  }

  return doc;
}

const DEFAULT_FILENAME_FORMAT = "{title} - {timestamp}.pdf";

/** Maximum length of the final filename (including the .pdf extension). */
const MAX_FILENAME_LENGTH = 180;

/** Windows device names that are illegal as bare filenames. */
const RESERVED_BASENAMES = new Set([
  "con", "prn", "aux", "nul",
  "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8", "com9",
  "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
]);

function slugifyFilename(value: string): string {
  return value
    .trim()
    .replace(/[^\w\s-]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^-+|-+$/g, "")
    || "ICU_Handover";
}

/**
 * Make an arbitrary string safe to use as a download filename inside an HTTP
 * `Content-Disposition` header and across Windows/macOS/Linux filesystems.
 *
 * Guarantees about the returned value:
 *  - contains no control characters (incl. CR/LF/TAB/NUL) — prevents header
 *    injection into `Content-Disposition`;
 *  - contains no path separators or characters illegal on common filesystems
 *    (`" \ / : * ? < > |`), and no double quotes/semicolons/commas that would
 *    terminate or confuse the header's quoted-string;
 *  - has no leading/trailing dots, spaces, or separators;
 *  - is not a reserved Windows device name;
 *  - is length-capped while preserving the extension;
 *  - always ends with `.pdf` and is never empty.
 */
export function sanitizeContentDispositionFilename(
  input: string,
  fallback = "ICU_Handover.pdf",
): string {
  // 1. Strip control characters (0x00-0x1F and 0x7F), including CR/LF/TAB.
  // eslint-disable-next-line no-control-regex
  let name = (input ?? "").replace(/[\u0000-\u001f\u007f]+/g, "");

  // 2. Replace filesystem/header-unsafe characters with a space.
  //    Covers path separators, Windows-illegal chars, and quoting chars.
  name = name.replace(/["'\\/:*?<>|;,`]+/g, " ");

  // 3. Collapse whitespace runs to a single underscore.
  name = name.replace(/\s+/g, "_").replace(/_{2,}/g, "_");

  // 4. Trim leading/trailing dots, underscores, hyphens and spaces.
  name = name.replace(/^[._\s-]+|[._\s-]+$/g, "");

  if (!name) return fallback;

  // 5. Split extension so length-capping and reserved-name checks keep .pdf.
  const dot = name.lastIndexOf(".");
  let base = dot > 0 ? name.slice(0, dot) : name;
  let ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (ext !== "pdf") {
    base = name;
    ext = "pdf";
  }

  base = base.replace(/^[._\s-]+|[._\s-]+$/g, "");
  if (!base || RESERVED_BASENAMES.has(base.toLowerCase())) {
    base = base ? `_${base}` : "ICU_Handover";
  }

  // 6. Length cap, reserving room for the ".pdf" extension.
  const maxBase = MAX_FILENAME_LENGTH - (ext.length + 1);
  if (base.length > maxBase) {
    base = base.slice(0, maxBase).replace(/[._\s-]+$/g, "");
    if (!base) base = "ICU_Handover";
  }

  return `${base}.${ext}`;
}

export function formatHandoverFilename(
  title: string,
  format: string | undefined,
  generatedAt: Date,
): string {
  const safeTitle = slugifyFilename(title || DEFAULT_TITLE);
  const timestamp = generatedAt.toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const date = generatedAt.toISOString().slice(0, 10);

  const filename = (format?.trim() || DEFAULT_FILENAME_FORMAT)
    .replace(/\{title\}/g, safeTitle)
    .replace(/\{timestamp\}/g, timestamp)
    .replace(/\{date\}/g, date);

  // Final defence: sanitize the whole assembled name so nothing from the
  // title, a custom format string, or the placeholders can break the
  // download or the Content-Disposition header.
  return sanitizeContentDispositionFilename(filename);
}


/** Build the handover sheet and trigger a download. */
export function exportHandoverPdf(patients: HandoverPatient[], opts?: HandoverPdfOptions): void {
  const generatedAt = new Date();
  const doc = buildHandoverPdf(patients, opts);
  const filename = formatHandoverFilename(opts?.title ?? DEFAULT_TITLE, opts?.filenameFormat, generatedAt);
  doc.save(filename);
}

/** Build the handover sheet and return an object URL for in-app preview. */
export function handoverPdfPreviewUrl(patients: HandoverPatient[], opts?: HandoverPdfOptions): string {
  const blob = buildHandoverPdf(patients, opts).output("blob");
  return URL.createObjectURL(blob);
}

/** Download from an already-built preview blob URL, using the configured name. */
export function downloadHandoverFromUrl(
  url: string,
  opts?: Pick<HandoverPdfOptions, "title" | "filenameFormat">,
): void {
  const generatedAt = new Date();
  const filename = formatHandoverFilename(opts?.title ?? DEFAULT_TITLE, opts?.filenameFormat, generatedAt);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}


