import { cn } from "@/lib/utils";

/**
 * Shared patient identity primitives so initials, age, and hospital number
 * are formatted and displayed consistently across the list, detail, and any
 * card surfaces. Change formatting here once and every surface follows.
 */

export type PatientSex = "male" | "female" | "other" | "unknown";

export type PatientSummaryData = {
  full_name?: string | null;
  age?: number | null;
  sex?: string | null;
  hospital_number?: string | null;
};

export function formatInitials(patient: PatientSummaryData): string {
  return patient.full_name?.trim() || "—";
}

export function formatAge(age?: number | null): string {
  return age != null ? `${age}y` : "—";
}

// Short badge-style sex marker (F / M / O / U) to sit alongside age without
// crowding the compact patient cards. Returns null when sex isn't recorded.
export function formatSexShort(sex?: string | null): string | null {
  switch (sex) {
    case "female": return "F";
    case "male": return "M";
    case "other": return "O";
    case "unknown": return "U";
    default: return null;
  }
}

export function formatSexLong(sex?: string | null): string | null {
  switch (sex) {
    case "female": return "Female";
    case "male": return "Male";
    case "other": return "Other";
    case "unknown": return "Unknown";
    default: return null;
  }
}

export function formatHospitalNumber(hospitalNumber?: string | null): string | null {
  return hospitalNumber ? `MRN ${hospitalNumber}` : null;
}


/** Patient initials, optionally with age appended (used on cards). */
export function PatientName({
  patient,
  size = "md",
  showAge = false,
  className,
}: {
  patient: PatientSummaryData;
  size?: "md" | "lg";
  showAge?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn(
        size === "lg" ? "text-2xl font-bold" : "font-semibold leading-tight",
        className,
      )}
    >
      {formatInitials(patient)}
      {showAge && patient.age != null ? ` · ${formatAge(patient.age)}` : ""}
      {formatSexShort(patient.sex) ? ` · ${formatSexShort(patient.sex)}` : ""}
    </span>
  );
}


/**
 * Muted meta line joining hospital number and age with any extra segments.
 * `leading` segments render before the hospital number (e.g. ward / bed),
 * `trailing` after age (e.g. admission date). Empty segments are dropped.
 */
export function PatientMetaLine({
  patient,
  leading = [],
  trailing = [],
  showHospitalNumber = true,
  showAge = true,
  className,
}: {
  patient: PatientSummaryData;
  leading?: (string | null | undefined | false)[];
  trailing?: (string | null | undefined | false)[];
  showHospitalNumber?: boolean;
  showAge?: boolean;
  className?: string;
}) {
  const sexLabel = formatSexLong(patient.sex);
  const segments: (string | null | undefined | false)[] = [
    ...leading,
    showHospitalNumber ? formatHospitalNumber(patient.hospital_number) : null,
    showAge ? `Age ${patient.age != null ? patient.age : "—"}` : null,
    sexLabel,
    ...trailing,
  ];

  const text = segments.filter(Boolean).join(" · ");
  return <p className={cn("text-sm text-muted-foreground", className)}>{text}</p>;
}
