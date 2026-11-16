import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { History, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { findPreviousAdmissions } from "@/lib/patients.functions";
import type { PatientFormValues } from "@/components/PatientForm";
import {
  admissionPeriodLabel,
  historicalPmhPatch,
  normaliseHospitalNumber,
  verifiedPreviousAdmissions,
  type PreviousAdmission,
} from "@/lib/previous-admission";

type Lookup = { mrn: string; rows: PreviousAdmission[] };

const yesNo = (v: boolean | null) => (v === true ? "Yes" : v === false ? "No" : "Not recorded");

/**
 * Previous critical care admissions for the person being added — matched ONLY
 * by an exact (normalised) hospital number the clinician can read. Initials
 * and age are never used. The only thing that can be copied is past medical
 * history, into a blank field, labelled with its source and dates for review.
 * Historical TEP / DNACPR are shown for review and never copied: any current
 * decision is a fresh entry by the clinician.
 */
export function PreviousAdmissionBanner({
  values,
  onApply,
}: {
  values: PatientFormValues;
  /** `verifiedFor` is the normalised hospital number the patch was checked against. */
  onApply: (patch: Partial<PatientFormValues>, verifiedFor: string) => void;
}) {
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ mrn: string; id: string } | null>(null);
  const [appliedFor, setAppliedFor] = useState<{ mrn: string; id: string } | null>(null);
  const find = useServerFn(findPreviousAdmissions);

  const mrn = normaliseHospitalNumber(values.hospital_number);
  const dismissed = !!mrn && dismissedFor === mrn;

  const q = useQuery({
    queryKey: ["previous-admissions", mrn],
    enabled: !!mrn && !dismissed,
    queryFn: async (): Promise<Lookup> => ({
      mrn,
      rows: (await find({ data: { hospital_number: mrn } })) as PreviousAdmission[],
    }),
    staleTime: 60_000,
  });

  // Only a result for the number currently entered, and only exact matches.
  const rows = q.data && q.data.mrn === mrn ? verifiedPreviousAdmissions(mrn, q.data.rows) : [];
  if (!mrn || dismissed || rows.length === 0) return null;

  const unique = rows.length === 1;
  const chosenId = unique ? rows[0]!.id : selected?.mrn === mrn ? selected.id : null;
  const prev = rows.find((r) => r.id === chosenId) ?? null;
  const patch = prev ? historicalPmhPatch(values, prev) : null;
  const applied = !!prev && appliedFor?.mrn === mrn && appliedFor.id === prev.id;

  function apply() {
    // Re-verify against what is on screen right now before touching the form.
    if (!prev || !patch) return;
    if (normaliseHospitalNumber(values.hospital_number) !== mrn) return;
    if (normaliseHospitalNumber(prev.hospital_number) !== mrn) return;
    onApply(patch, mrn);
    setAppliedFor({ mrn, id: prev.id });
  }

  const outcome = (r: PreviousAdmission) => (r.status === "died" ? "Died" : "Discharged");

  return (
    <section
      aria-label="Previous admissions with this hospital number"
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-500/40 dark:bg-amber-500/10"
    >
      <div className="flex items-start gap-2">
        <History
          className="mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300"
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-3 text-amber-900 dark:text-amber-100">
          <p className="font-medium">
            {unique
              ? "Previous critical care admission with this hospital number"
              : `${rows.length} previous critical care admissions with this hospital number`}
          </p>

          {unique ? (
            <p className="text-amber-900/80 dark:text-amber-100/80">
              {rows[0]!.full_name || "Initials not recorded"} · {outcome(rows[0]!)} ·{" "}
              {admissionPeriodLabel(rows[0]!)}
            </p>
          ) : (
            <fieldset className="space-y-1.5">
              <legend className="mb-1 text-amber-900/80 dark:text-amber-100/80">
                Choose which admission to review:
              </legend>
              {rows.map((r) => (
                <label
                  key={r.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md border border-amber-300/70 bg-background/60 px-2 py-2 dark:border-amber-500/30"
                >
                  <input
                    type="radio"
                    name="previous-admission"
                    className="h-4 w-4 accent-primary"
                    checked={chosenId === r.id}
                    onChange={() => setSelected({ mrn, id: r.id })}
                  />
                  <span>
                    {admissionPeriodLabel(r)} · {outcome(r)}
                  </span>
                </label>
              ))}
            </fieldset>
          )}

          {prev && (
            <div className="space-y-1 rounded-md border border-amber-300/70 bg-background/60 p-2 dark:border-amber-500/30">
              <p className="text-xs font-semibold uppercase">
                Historical record ({admissionPeriodLabel(prev)}) — for review only
              </p>
              <p>
                <span className="font-medium">TEP then:</span> {yesNo(prev.tep_in_place)}
                {prev.tep_details ? ` — ${prev.tep_details}` : ""}
              </p>
              <p>
                <span className="font-medium">DNACPR then:</span> {yesNo(prev.dnacpr_decision)}
                {prev.dnacpr_details ? ` — ${prev.dnacpr_details}` : ""}
              </p>
              <p className="text-xs text-amber-900/80 dark:text-amber-100/80">
                Not copied. Record any current TEP or DNACPR decision yourself.
              </p>
            </div>
          )}

          {applied ? (
            <p role="status" className="flex items-center gap-1 text-xs">
              <Info className="h-3 w-3" aria-hidden />
              Past medical history copied from this admission and marked for review.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" onClick={apply} disabled={!patch}>
                Copy past medical history
              </Button>
              {prev && !patch && (
                <span className="text-xs text-amber-900/80 dark:text-amber-100/80">
                  {values.past_medical_history.trim()
                    ? "Past medical history already entered — kept."
                    : "No past medical history on that admission."}
                </span>
              )}
              {!prev && (
                <span className="text-xs text-amber-900/80 dark:text-amber-100/80">
                  Choose an admission first.
                </span>
              )}
              {prev && (
                <Button type="button" size="sm" variant="ghost" asChild>
                  <Link to="/patients/$patientId" params={{ patientId: prev.id }} target="_blank">
                    View previous record
                  </Link>
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={() => setDismissedFor(mrn)}>
                Dismiss
              </Button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
