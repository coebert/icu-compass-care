import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { fmtDate } from "@/lib/icu";
import {
  listReferralCandidates,
  prefillPatientFromReferral,
  previewReferralPrefill,
} from "@/lib/referral-prefill.functions";
import { referralCandidateSummary, PREFILL_FIELD_LABEL } from "@/lib/referral-prefill";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ClipboardPlus } from "lucide-react";
import { toast } from "sonner";

type ReferralCandidate = {
  id: string;
  age: number | null;
  sex: string | null;
  current_ward: string | null;
  current_bed: string | null;
  referring_specialty: string | null;
  referral_received_at: string | null;
  status: string | null;
  reason_category: string | null;
};

export function PrefillFromReferral({
  patientId,
  linked,
  onDone,
}: {
  patientId: string;
  linked: boolean;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [step, setStep] = useState<"pick" | "preview">("pick");
  const listFn = useServerFn(listReferralCandidates);
  const previewFn = useServerFn(previewReferralPrefill);
  const prefillFn = useServerFn(prefillPatientFromReferral);

  const { data: candidates, isLoading } = useQuery({
    queryKey: ["referral-candidates"],
    queryFn: () => listFn() as Promise<ReferralCandidate[]>,
    enabled: open,
  });

  const { data: preview, isFetching: previewLoading } = useQuery({
    queryKey: ["referral-prefill-preview", patientId, selected],
    queryFn: () =>
      previewFn({ data: { patient_id: patientId, referral_id: selected! } }) as Promise<{
        applied_fields: string[];
        skipped_fields: string[];
        patch: Record<string, string | boolean>;
      }>,
    enabled: open && step === "preview" && !!selected,
  });

  const resetAndClose = () => {
    setOpen(false);
    setSelected(null);
    setStep("pick");
  };

  const prefillMut = useMutation({
    mutationFn: (referral_id: string) =>
      prefillFn({ data: { patient_id: patientId, referral_id } }),
    onSuccess: (res: { applied_fields: string[]; skipped_fields: string[] }) => {
      const applied = res.applied_fields.map((f) => PREFILL_FIELD_LABEL[f] ?? f);
      if (applied.length) {
        toast.success("Prefilled from referral", { description: applied.join(", ") });
      } else {
        toast.info("Linked to referral", {
          description: "No blank fields to fill — existing entries were kept.",
        });
      }
      resetAndClose();
      onDone();
    },
    onError: (e: Error) => toast.error("Prefill failed", { description: e.message }),
  });

  const fmtPatchValue = (v: string | boolean): string =>
    typeof v === "boolean" ? (v ? "Yes" : "No") : v;

  return (
    <>
      <Button variant="outline" className="gap-1.5" onClick={() => setOpen(true)}>
        <ClipboardPlus className="h-4 w-4" /> {linked ? "Referral" : "From referral"}
      </Button>
      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : resetAndClose())}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {step === "pick"
                ? "Prefill from critical care referral"
                : "Review fields to be populated"}
            </DialogTitle>
          </DialogHeader>

          {step === "pick" && (
            <>
              <p className="text-sm text-muted-foreground">
                Select the referral that matches this patient. Only blank fields are filled —
                existing entries are never overwritten. Free-text history from the referral is
                populated separately by the referring app.
              </p>
              {isLoading && <p className="text-sm text-muted-foreground">Loading referrals…</p>}
              {candidates && candidates.length === 0 && (
                <p className="text-sm text-muted-foreground">No synced referrals available.</p>
              )}
              <div className="space-y-2">
                {(candidates ?? []).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setSelected(r.id)}
                    className={`w-full rounded-lg border p-3 text-left text-sm transition ${
                      selected === r.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                    }`}
                  >
                    <div className="font-medium">{referralCandidateSummary(r)}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.status ?? "referral"}
                      {r.referral_received_at ? ` · received ${fmtDate(r.referral_received_at)}` : ""}
                    </div>
                  </button>
                ))}
              </div>
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button variant="outline" onClick={resetAndClose}>
                  Cancel
                </Button>
                <Button disabled={!selected} onClick={() => setStep("preview")}>
                  Preview changes
                </Button>
              </div>
            </>
          )}

          {step === "preview" && (
            <>
              <p className="text-sm text-muted-foreground">
                These are the exact fields that will be populated. Fields already containing data
                are left untouched.
              </p>
              {previewLoading && <p className="text-sm text-muted-foreground">Checking fields…</p>}
              {preview && (
                <div className="space-y-4">
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                      Will be filled ({preview.applied_fields.length})
                    </div>
                    {preview.applied_fields.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        Nothing to fill — all mapped fields already have values. Confirming will
                        just link this patient to the referral.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {preview.applied_fields.map((f) => (
                          <div key={f} className="rounded-lg border p-3 text-sm">
                            <div className="font-medium">{PREFILL_FIELD_LABEL[f] ?? f}</div>
                            <div className="whitespace-pre-wrap text-muted-foreground">
                              {fmtPatchValue(preview.patch[f])}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {preview.skipped_fields.length > 0 && (
                    <div>
                      <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                        Kept as-is ({preview.skipped_fields.length})
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {preview.skipped_fields.map((f) => (
                          <Badge key={f} variant="outline">
                            {PREFILL_FIELD_LABEL[f] ?? f}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button variant="outline" onClick={() => setStep("pick")}>
                  Back
                </Button>
                <Button
                  disabled={!selected || prefillMut.isPending || previewLoading}
                  onClick={() => selected && prefillMut.mutate(selected)}
                >
                  {prefillMut.isPending ? "Prefilling…" : "Confirm prefill"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
