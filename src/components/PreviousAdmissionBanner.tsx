import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { History, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { findPreviousAdmissions } from "@/lib/patients.functions";
import { fmtDate } from "@/lib/icu";
import type { PatientFormValues } from "@/components/PatientForm";
import { parseTepExclusions } from "@/lib/patient-safety";

type PreviousAdmission = {
  id: string;
  full_name: string | null;
  hospital_number: string | null;
  age: number | null;
  status: string | null;
  admission_date: string | null;
  discharge_date: string | null;
  date_of_death: string | null;
  past_medical_history: string | null;
  tep_in_place: boolean | null;
  tep_details: string | null;
  tep_exclusions: unknown;
  dnacpr_decision: boolean | null;
  dnacpr_details: string | null;
  dnacpr_date: string | null;
};

/**
 * Surfaces prior critical care admissions for the person being added, matched
 * by hospital number (preferred) or initials + age. Offers one-click prefill
 * of PMH, TEP and DNACPR fields — but only for fields that are still empty
 * on the new record, so the clinician's in-progress entry is never overwritten.
 */
export function PreviousAdmissionBanner({
  values,
  onApply,
}: {
  values: PatientFormValues;
  onApply: (patch: Partial<PatientFormValues>) => void;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [appliedFor, setAppliedFor] = useState<string | null>(null);
  const find = useServerFn(findPreviousAdmissions);

  const mrn = values.hospital_number.trim();
  const name = values.full_name.trim();
  const ageNum = values.age.trim() === "" ? null : Number(values.age);
  const canQuery = mrn.length > 0 || (name.length > 0 && ageNum !== null && Number.isFinite(ageNum));

  const key = useMemo(
    () => ["previous-admissions", mrn.toLowerCase(), name.toLowerCase(), ageNum] as const,
    [mrn, name, ageNum],
  );

  const { data: rows = [] } = useQuery({
    queryKey: key,
    enabled: canQuery && !dismissed,
    queryFn: () =>
      find({
        data: {
          hospital_number: mrn || undefined,
          full_name: name || undefined,
          age: ageNum ?? undefined,
        },
      }) as Promise<PreviousAdmission[]>,
    staleTime: 60_000,
  });

  if (dismissed || rows.length === 0) return null;
  const prev = rows[0];

  const endDateLabel = fmtDate(prev.discharge_date ?? prev.date_of_death ?? null);
  const outcome = prev.status === "died" ? "Died" : "Discharged";

  function apply() {
    const patch: Partial<PatientFormValues> = {};
    if (!values.past_medical_history.trim() && prev.past_medical_history) {
      patch.past_medical_history = prev.past_medical_history;
    }
    if (!values.tep_in_place && prev.tep_in_place) {
      patch.tep_in_place = true;
      if (!values.tep_details.trim() && prev.tep_details) patch.tep_details = prev.tep_details;
      if ((values.tep_exclusions?.length ?? 0) === 0) {
        const excl = parseTepExclusions(prev.tep_exclusions);
        if (excl.length > 0) patch.tep_exclusions = excl;
      }
    }
    if (!values.dnacpr_decision && prev.dnacpr_decision) {
      patch.dnacpr_decision = true;
      if (!values.dnacpr_details.trim() && prev.dnacpr_details)
        patch.dnacpr_details = prev.dnacpr_details;
      if (!values.dnacpr_date && prev.dnacpr_date) patch.dnacpr_date = prev.dnacpr_date;
    }
    onApply(patch);
    setAppliedFor(prev.id);
  }

  return (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-500/40 dark:bg-amber-500/10">
      <div className="flex items-start gap-2">
        <History className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300" />
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium text-amber-900 dark:text-amber-100">
            Previous critical care admission found
          </p>
          <p className="text-amber-900/80 dark:text-amber-100/80">
            {prev.full_name || "Unknown"}
            {prev.hospital_number ? ` · MRN ${prev.hospital_number}` : ""}
            {prev.age != null ? ` · Age ${prev.age}` : ""} — {outcome}
            {endDateLabel ? ` ${endDateLabel}` : ""}
            {rows.length > 1 ? ` (+${rows.length - 1} earlier)` : ""}
          </p>
          {appliedFor === prev.id ? (
            <p className="flex items-center gap-1 text-xs text-amber-900/80 dark:text-amber-100/80">
              <Info className="h-3 w-3" />
              Prefilled from previous admission — review before saving. Existing entries were kept.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" onClick={apply}>
                Prefill PMH, TEP &amp; DNACPR
              </Button>
              <Button type="button" size="sm" variant="ghost" asChild>
                <Link to="/patients/$patientId" params={{ patientId: prev.id }} target="_blank">
                  View previous record
                </Link>
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setDismissed(true)}>
                Dismiss
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
