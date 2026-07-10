import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { STATUS_LABELS, fmtDate } from "@/lib/icu";

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
};

const DEFAULT_TITLE = "ICU Handover Sheet";
const DEFAULT_FOOTER = "Confidential — patient identifiable information";

// Proportional column weights (must fit within available content width).
const COLUMN_WEIGHTS = [32, 32, 42, 48, 48, 42, 37];
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
      "Outstanding tasks",
      "TEP / DNACPR / NOK",
    ]],
    body: patients.map((p) => [
      identity(p),
      location(p),
      p.past_medical_history || "—",
      p.current_admission || "—",
      p.current_management || "—",
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

function handoverFilename(): string {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `icu-handover-${stamp}.pdf`;
}

/** Build the handover sheet and trigger a download. */
export function exportHandoverPdf(patients: HandoverPatient[], opts?: HandoverPdfOptions): void {
  buildHandoverPdf(patients, opts).save(handoverFilename());
}

/** Build the handover sheet and return an object URL for in-app preview. */
export function handoverPdfPreviewUrl(patients: HandoverPatient[], opts?: HandoverPdfOptions): string {
  const blob = buildHandoverPdf(patients, opts).output("blob");
  return URL.createObjectURL(blob);
}


/** Download from an already-built preview blob URL, using the standard name. */
export function downloadHandoverFromUrl(url: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = handoverFilename();
  document.body.appendChild(a);
  a.click();
  a.remove();
}

