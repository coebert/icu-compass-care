const DEFAULT_TITLE = "ICU Handover Sheet";
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
