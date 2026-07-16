import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { History, ChevronDown, ChevronUp } from "lucide-react";
import { getPatientFieldChanges } from "@/lib/patients.functions";
import { fmtDateTime } from "@/lib/icu";

// The Demographics-tab audit fields (matches TRACKED_PATIENT_FIELDS labels
// in src/lib/audit.ts). Anything not in this map is excluded from this view —
// clinical/systems edits show up in the timeline/ribbon instead.
const DEMOGRAPHIC_LABELS: Record<string, string> = {
  initials: "Initials / name",
  age: "Age",
  sex: "Sex",
  hospital_number: "Hospital number",
  weight_kg: "Weight (kg)",
  height_m: "Height (m)",
  bmi: "BMI",
  ibw: "Ideal body weight",
  location_type: "Location",
  ward: "Ward",
  bed: "Bed",
  status: "Status",
  admission_date: "Admission date",
  discharge_date: "Discharge date",
  discharge_destination: "Discharge destination",
  date_of_death: "Date of death",
  nok_name: "Next of kin — name",
  nok_relationship: "Next of kin — relationship",
  nok_contact: "Next of kin — contact",
  nok_last_updated_by: "NOK — last spoken to by",
};

function displayValue(v: string | null): string {
  if (v === null || v === "") return "—";
  return v;
}

export function DemographicsHistory({ patientId }: { patientId: string }) {
  const fetchChanges = useServerFn(getPatientFieldChanges);
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ["patient-field-changes", patientId],
    queryFn: () => fetchChanges({ data: { id: patientId } }),
  });

  const rows = (data ?? []).filter((r) => r.field_name in DEMOGRAPHIC_LABELS);
  const visible = expanded ? rows : rows.slice(0, 8);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="h-4 w-4" /> Edit history
          {rows.length > 0 && (
            <Badge variant="secondary" className="ml-1">{rows.length}</Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading history…</p>
        ) : isError ? (
          <p className="text-sm text-destructive">
            Couldn't load history: {(error as { message?: string })?.message ?? "unknown error"}
          </p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No demographic edits recorded yet. Changes to these fields will appear here.
          </p>
        ) : (
          <>
            <ol className="divide-y">
              {visible.map((row) => {
                const label = DEMOGRAPHIC_LABELS[row.field_name] ?? row.field_name;
                const who =
                  row.changed_by_email?.trim() ||
                  (row.changed_by ? "Staff member" : "Unknown user");
                return (
                  <li key={row.id} className="py-2 text-sm">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                      <span className="font-medium">{label}</span>
                      <span className="text-xs text-muted-foreground">
                        {row.changed_at ? fmtDateTime(row.changed_at) : "unknown time"} · {who}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                      <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground line-through">
                        {displayValue(row.old_value)}
                      </span>
                      <span aria-hidden>→</span>
                      <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200">
                        {displayValue(row.new_value)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
            {rows.length > 8 && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="mt-2 h-8"
                onClick={() => setExpanded((v) => !v)}
              >
                {expanded ? (
                  <><ChevronUp className="mr-1 h-4 w-4" /> Show fewer</>
                ) : (
                  <><ChevronDown className="mr-1 h-4 w-4" /> Show all {rows.length}</>
                )}
              </Button>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
