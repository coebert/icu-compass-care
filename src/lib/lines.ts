export interface PatientLine {
  id: string;
  patient_id: string;
  device_type: string;
  site: string | null;
  laterality: string | null;
  size: string | null;
  inserted_on: string | null;
  removed_on: string | null;
  status: string;
  inserted_in_unit: boolean;
  indication: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Whole days a device has been in situ (or was in situ, if removed).
export function daysInSitu(line: Pick<PatientLine, "inserted_on" | "removed_on" | "status">): number | null {
  if (!line.inserted_on) return null;
  const start = new Date(line.inserted_on + "T00:00:00Z").getTime();
  const endStr = line.status === "removed" ? line.removed_on : null;
  const end = endStr ? new Date(endStr + "T00:00:00Z").getTime() : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.floor((end - start) / 86_400_000));
}
