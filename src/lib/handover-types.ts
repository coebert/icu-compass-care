import type { Patient } from "@/lib/domain-types";

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

export type HandoverPatient = Partial<Patient> & Record<string, any>;

export type HandoverPageSize = "a4" | "letter";

export type HandoverOrientation = "landscape" | "portrait";

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
