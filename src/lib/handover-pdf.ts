import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { STATUS_LABELS, fmtDate, fmtDateTime } from "@/lib/icu";
import { courseDays, type Antimicrobial } from "@/lib/antimicrobials";

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

import type { Patient } from "@/lib/domain-types";

export type HandoverPatient = Partial<Patient> & Record<string, any>;

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
  const discharged = p.status === "discharged";
  return joinNonEmpty([
    p.ward ? `${p.ward}${p.bed ? ` · Bed ${p.bed}` : ""}` : "No location",
    STATUS_LABELS[p.status] ?? p.status,
    discharged && p.discharge_destination ? `To ${p.discharge_destination}` : null,
    `Adm ${fmtDate(p.admission_date)}`,
  ]);
}

function flags(p: HandoverPatient): string {
  const f: string[] = [];
  if (p.dnacpr_decision) f.push(`DNACPR${p.dnacpr_details ? `: ${p.dnacpr_details}` : ""}`);
  if (p.tep_in_place) f.push(`TEP${p.tep_details ? `: ${p.tep_details}` : ""}`);
  if (p.nok_name) {
    const spoken = p.nok_last_updated
      ? ` [Spoken to ${fmtDateTime(p.nok_last_updated)}${p.nok_last_updated_by ? ` by ${p.nok_last_updated_by}` : ""}]`
      : "";
    f.push(`NOK: ${p.nok_name}${p.nok_relationship ? ` (${p.nok_relationship})` : ""}${p.nok_contact ? ` ${p.nok_contact}` : ""}${spoken}`);
  }
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

/** Stable string for a deterministic final tie-break (never throws). */
function tieBreakKey(rec: Record<string, any>): string {
  const id = rec?.id;
  if (id != null) return String(id);
  const created = rec?.created_at;
  if (created != null) return String(created);
  return String(rec?.findings ?? "");
}

/**
 * Deterministic "is `a` at least as recent as `b`?" for picking the newest
 * record. Ordering is total and independent of input array order:
 *   1. Newer `result_at` wins. Missing/invalid dates sort oldest.
 *   2. Ties on `result_at` (including two missing dates) break on the newer
 *      `created_at` (missing/invalid sorts oldest).
 *   3. Remaining ties break on a stable key (id, else created_at, else
 *      findings) using string comparison, so the result never depends on the
 *      order the records happened to arrive in.
 */
function isAtLeastAsRecent(a: Record<string, any>, b: Record<string, any>): boolean {
  const ta = parseTime(a?.result_at);
  const tb = parseTime(b?.result_at);
  if (ta !== tb) return ta > tb;
  const ca = parseTime(a?.created_at);
  const cb = parseTime(b?.created_at);
  if (ca !== cb) return ca > cb;
  return tieBreakKey(a) >= tieBreakKey(b);
}

/**
 * Pick the newest investigation for `category` from a patient's investigation
 * list. Selection is deterministic even when several results share the same
 * `result_at` (or all have missing dates) — see `isAtLeastAsRecent`. Returns
 * undefined when none exist.
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
      return isAtLeastAsRecent(cur, best) ? cur : best;
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


// Combine the systems-based review into a single labelled block for the PDF,
// skipping any system with no notes.
const SYSTEMS_FIELDS: [keyof HandoverPatient, string][] = [
  ["systems_resp", "Resp"],
  ["systems_cvs", "CVS"],
  ["systems_neuro", "CNS/Neuro"],
  ["systems_renal", "Renal"],
  ["systems_gastro", "Gastro/Nutri"],
  ["systems_haem", "Haem"],
  ["systems_micro", "Micro"],
  ["systems_other", "Other"],
];

/**
 * Summarise a patient's antimicrobial agents for the handover sheet. Each agent
 * shows its name, start date, and either the running course day (ongoing) or the
 * total completed course length. Returns "" when none are recorded.
 */
export function antimicrobialsSummary(p: HandoverPatient): string {
  const list: Antimicrobial[] = Array.isArray(p.antimicrobials)
    ? p.antimicrobials
    : [];
  if (!list.length) return "";
  return list
    .map((a) => {
      const name = (a?.name ?? "").trim() || "Agent";
      const started = a?.started_on || "";
      const days = courseDays(started, a?.ended_on);
      if (!started) return name;
      if (a?.ended_on) {
        const total = days != null ? `, ${days}d total` : "";
        return `${name} (${started}→${a.ended_on}${total})`;
      }
      const dayStr = days != null ? `, day ${days}` : "";
      return `${name} (from ${started}${dayStr})`;
    })
    .join("; ");
}




/** Renal support flags (diuretics / RRT) as a short suffix, or "". */
export function renalSupportSummary(p: HandoverPatient): string {
  const flags: string[] = [];
  if (p.renal_diuretics) flags.push("Diuretics");
  if (p.renal_rrt) flags.push("RRT");
  return flags.join(", ");
}

function systemsReview(p: HandoverPatient): string {
  const renalSupport = renalSupportSummary(p);
  const antimicrobials = antimicrobialsSummary(p);
  const lines = SYSTEMS_FIELDS.map(([key, label]) => {
    let val = typeof p[key] === "string" ? (p[key] as string).trim() : "";
    // Both the structured renal support flags (diuretics / RRT) and the
    // antimicrobial course data are folded into the Systems review column so
    // they only print when this column is included in the selected preset.
    if (key === "systems_renal" && renalSupport) {
      val = val ? `${val} · ${renalSupport}` : renalSupport;
    }
    if (key === "systems_micro" && antimicrobials) {
      const abx = `Abx: ${antimicrobials}`;
      val = val ? `${val}\n${abx}` : abx;
    }
    return val ? `${label}: ${val}` : "";
  }).filter(Boolean);
  return lines.length ? lines.join("\n") : "—";
}








export type HandoverPageSize = "a4" | "letter";

export type HandoverOrientation = "landscape" | "portrait";

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
  /** Page orientation. Default "landscape". */
  orientation?: HandoverOrientation;
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
  /**
   * Which columns to include, in display order. Defaults to all columns.
   * An empty selection also falls back to all columns so the sheet is never
   * blank.
   */
  columns?: HandoverColumnKey[];
};


const DEFAULT_TITLE = "ICU Handover Sheet";
const DEFAULT_FOOTER = "Confidential — patient identifiable information";

/** Stable identifiers for each selectable handover column. */
export type HandoverColumnKey =
  | "patient"
  | "location"
  | "pmh"
  | "admission"
  | "management"
  | "systems"
  | "investigations"
  | "microbiology"
  | "tasks"
  | "flags";

/**
 * The full set of handover columns in display order, each with a header, a
 * proportional width weight, and a renderer. The user can choose which of
 * these appear in the exported PDF; unselected columns are dropped and the
 * remaining widths re-distribute to fill the page.
 */
export const HANDOVER_COLUMNS: {
  key: HandoverColumnKey;
  header: string;
  weight: number;
  render: (p: HandoverPatient) => string;
}[] = [
  { key: "patient", header: "Patient", weight: 28, render: identity },
  { key: "location", header: "Location / status", weight: 26, render: location },
  { key: "pmh", header: "Past medical history", weight: 32, render: (p) => p.past_medical_history || "—" },
  { key: "admission", header: "Current admission", weight: 36, render: (p) => p.current_admission || "—" },
  { key: "management", header: "Management", weight: 36, render: (p) => p.current_management || "—" },
  { key: "systems", header: "Systems review", weight: 42, render: systemsReview },
  { key: "investigations", header: "Most recent investigations", weight: 44, render: investigations },
  { key: "microbiology", header: "Key microbiology", weight: 36, render: microbiology },
  { key: "tasks", header: "Outstanding tasks", weight: 36, render: (p) => p.outstanding_tasks || "—" },
  { key: "flags", header: "TEP / DNACPR / NOK", weight: 30, render: flags },
];

/** All column keys, used as the default (everything shown). */
export const ALL_HANDOVER_COLUMN_KEYS: HandoverColumnKey[] = HANDOVER_COLUMNS.map(
  (c) => c.key,
);


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

export function buildHandoverPdf(patients: HandoverPatient[], opts?: HandoverPdfOptions): jsPDF {
  const pageSize: HandoverPageSize = opts?.pageSize ?? "a4";
  const orientation: HandoverOrientation = opts?.orientation ?? "landscape";
  const doc = new jsPDF({ orientation, unit: "mm", format: pageSize });
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



