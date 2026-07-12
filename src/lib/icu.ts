export const STATUS_LABELS: Record<string, string> = {
  referred: "Referred (outlier)",
  admitted: "Admitted",
  discharged: "Discharged",
  died: "Died",
};

export const STATUS_BADGE: Record<string, string> = {
  referred: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  admitted: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  discharged: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  died: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

// Investigation categories that get a "most recent" card.
export const INVESTIGATION_CATEGORIES = [
  "Bloods",
  "CXR",
  "CTAP",
  "CTPA",
  "CT chest",
  "CT head",
  "Echo",
  "ABG",
  "Cultures",
  "Other",
];

// Specimen types for the "key microbiology results" section.
export const MICROBIOLOGY_SPECIMENS = [
  "Blood culture",
  "Wound / skin swab",
  "Respiratory (sputum / BAL)",
  "Urine",
  "CSF",
  "Line tip",
  "Stool",
  "Screening (MRSA / CPE)",
  "Serology / antigen",
  "Other",
];

export function fmtDate(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
}

export function fmtDateTime(value?: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    hourCycle: "h23",
  });
}
