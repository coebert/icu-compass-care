import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { HANDOVER_COLUMNS } from "@/lib/handover-columns";
import { formatHandoverFilename } from "@/lib/handover-filename";
import type {
  HandoverColumnKey,
  HandoverOrientation,
  HandoverPageSize,
  HandoverPatient,
  HandoverPdfOptions,
} from "@/lib/handover-types";

// Re-export the public surface so existing importers of "@/lib/handover-pdf"
// keep working after the internal split into focused modules.
export type {
  HandoverColumnKey,
  HandoverInvestigation,
  HandoverMicrobiology,
  HandoverOrientation,
  HandoverPageSize,
  HandoverPatient,
  HandoverPdfOptions,
} from "@/lib/handover-types";
export {
  ALL_HANDOVER_COLUMN_KEYS,
  HANDOVER_COLUMNS,
  antimicrobialsSummary,
  renalSupportSummary,
} from "@/lib/handover-columns";
export {
  RECENT_INVESTIGATION_CATEGORIES,
  latestMicrobiologyPerSpecimen,
  mostRecentInvestigation,
} from "@/lib/handover-recency";
export {
  formatHandoverFilename,
  sanitizeContentDispositionFilename,
} from "@/lib/handover-filename";

const DEFAULT_TITLE = "ICU Handover Sheet";
const DEFAULT_FOOTER = "Confidential — patient identifiable information";

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Sanitise a string for use inside the PDF's internal document-info dictionary
 * (Title/Subject/Author). PDF text strings are delimited by parentheses and use
 * backslash escapes, and the info dictionary must never contain control
 * characters (CR/LF/TAB/NUL) that could break the PDF header or be abused for
 * metadata injection. This strips control characters and neutralises the PDF
 * string delimiters/escape character, collapsing whitespace runs.
 */
export function sanitizePdfMetadataText(input: string, fallback = ""): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = (input ?? "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[()\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
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
  const orientation: HandoverOrientation = opts?.orientation ?? "landscape";
  const doc = new jsPDF({ orientation, unit: "mm", format: pageSize });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const generated = new Date().toLocaleString("en-GB", { hour12: false, hourCycle: "h23" });
  const title = opts?.title?.trim() || DEFAULT_TITLE;
  const subtitle = opts?.subtitle?.trim() || "";
  const footerText = opts?.footerText?.trim() || DEFAULT_FOOTER;
  const showTimestamp = opts?.showTimestamp ?? true;
  const showPageNumbers = opts?.showPageNumbers ?? true;
  const marginX = clamp(opts?.marginX ?? 8, 2, 30);
  const fontScale = clamp(opts?.fontScale ?? 1, 0.6, 1.6);
  const PAGE_TOKEN = "{{TOTAL_PAGES}}";

  // Populate the internal document-info dictionary with sanitised text so
  // hostile characters in the title/subtitle can never leak into the PDF
  // header or the embedded metadata.
  doc.setDocumentProperties({
    title: sanitizePdfMetadataText(title, DEFAULT_TITLE),
    subject: sanitizePdfMetadataText(subtitle, DEFAULT_TITLE),
    author: sanitizePdfMetadataText(footerText, DEFAULT_FOOTER),
    creator: "ICU Handover",
  });

  const bodyFontSize = 7 * fontScale;
  const headFontSize = 7.5 * fontScale;

  // Resolve which columns to render (default to all; empty selection falls
  // back to all so the sheet is never blank), keeping display order.
  const requested = opts?.columns;
  const selectedCols =
    requested && requested.length > 0
      ? HANDOVER_COLUMNS.filter((c) => requested.includes(c.key))
      : HANDOVER_COLUMNS;
  const cols = selectedCols.length > 0 ? selectedCols : HANDOVER_COLUMNS;
  const columnTotal = cols.reduce((a, c) => a + c.weight, 0);

  // Distribute the proportional weights across the available content width so
  // the columns always span the page exactly, whatever the size/margin.
  const contentWidth = pageWidth - marginX * 2;
  const columnStyles: Record<number, { cellWidth: number; fontStyle?: "bold" }> = {};
  cols.forEach((c, i) => {
    columnStyles[i] = { cellWidth: (c.weight / columnTotal) * contentWidth };
  });
  // Bold the leading column (patient identity) when it is present first.
  if (cols[0]?.key === "patient") columnStyles[0].fontStyle = "bold";

  autoTable(doc, {
    head: [cols.map((c) => c.header)],
    body: patients.map((p) => cols.map((c) => c.render(p))),
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

/**
 * Build the handover sheet and trigger a download using a fresh, self-contained
 * object URL. The URL is created just for the download and revoked immediately
 * afterwards so it never leaks browser memory — independent of any preview URL
 * still bound to an on-screen iframe.
 */
export function downloadHandover(
  patients: HandoverPatient[],
  opts?: HandoverPdfOptions,
): void {
  const generatedAt = new Date();
  const filename = formatHandoverFilename(opts?.title ?? DEFAULT_TITLE, opts?.filenameFormat, generatedAt);
  const blob = buildHandoverPdf(patients, opts).output("blob");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the browser has grabbed the blob for the
  // download; this releases the object URL and prevents a memory leak.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
