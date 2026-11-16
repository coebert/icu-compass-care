import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { fmtDate } from "@/lib/icu";
import {
  listReferralCandidates,
  prefillPatientFromReferral,
  previewReferralPrefill,
} from "@/lib/referral-prefill.functions";
import {
  referralCandidateSummary,
  PREFILL_FIELD_LABEL,
  PREFILL_STALE_MESSAGE,
} from "@/lib/referral-prefill";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, ClipboardPlus, RefreshCw } from "lucide-react";
import { toast } from "sonner";

type PrefillPreview = {
  applied_fields: string[];
  skipped_fields: string[];
  patch: Record<string, string | boolean>;
  patient_updated_at: string;
  referral_updated_at: string | null;
};

function InlineAlert({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm sm:flex-row sm:items-center"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-destructive" aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
      {action}
    </div>
  );
}

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
  // Set when "Confirm" was refused because the record changed after preview.
  const [stale, setStale] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const listFn = useServerFn(listReferralCandidates);
  const previewFn = useServerFn(previewReferralPrefill);
  const prefillFn = useServerFn(prefillPatientFromReferral);

  const candidatesQ = useQuery({
    queryKey: ["referral-candidates"],
    queryFn: () => listFn() as Promise<ReferralCandidate[]>,
    enabled: open,
    retry: 1,
  });
  const candidates = candidatesQ.data;

  const previewQ = useQuery({
    queryKey: ["referral-prefill-preview", patientId, selected],
    queryFn: () =>
      previewFn({
        data: { patient_id: patientId, referral_id: selected! },
      }) as Promise<PrefillPreview>,
    enabled: open && step === "preview" && !!selected,
    retry: 1,
    // A preview is only good for the version it was computed from.
    gcTime: 0,
  });
  const preview = previewQ.data;
  const previewLoading = previewQ.isFetching;

  const resetAndClose = () => {
    setOpen(false);
    setSelected(null);
    setStep("pick");
    setStale(false);
    setApplyError(null);
  };

  const reloadPreview = async () => {
    setStale(false);
    setApplyError(null);
    await previewQ.refetch();
  };

  const prefillMut = useMutation({
    mutationFn: (p: { referral_id: string; preview: PrefillPreview }) =>
      prefillFn({
        data: {
          patient_id: patientId,
          referral_id: p.referral_id,
          expected_patient_updated_at: p.preview.patient_updated_at,
          expected_referral_updated_at: p.preview.referral_updated_at,
        },
      }),
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
    onError: (e: Error) => {
      if (e.message === PREFILL_STALE_MESSAGE) {
        // Refresh the record behind the dialog; the user reloads and reconfirms.
        setStale(true);
        onDone();
        return;
      }
      setApplyError(e.message || "The prefill could not be saved.");
    },
  });

  const canConfirm =
    !!selected &&
    !!preview &&
    previewQ.isSuccess &&
    !previewLoading &&
    !stale &&
    !prefillMut.isPending;

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
              {candidatesQ.isPending && (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading referrals…
                </p>
              )}
              {candidatesQ.isError && (
                <InlineAlert
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-10 gap-1.5 sm:h-8"
                      onClick={() => void candidatesQ.refetch()}
                      disabled={candidatesQ.isFetching}
                    >
                      <RefreshCw
                        className={`h-3.5 w-3.5 ${candidatesQ.isFetching ? "animate-spin" : ""}`}
                        aria-hidden
                      />
                      Try again
                    </Button>
                  }
                >
                  Referrals couldn't be loaded. Nothing has been changed.
                </InlineAlert>
              )}
              {candidatesQ.isSuccess && candidates && candidates.length === 0 && (
                <p role="status" className="text-sm text-muted-foreground">
                  No synced referrals available.
                </p>
              )}
              <div className="space-y-2" role="group" aria-label="Referrals">
                {(candidatesQ.isError ? [] : (candidates ?? [])).map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    aria-pressed={selected === r.id}
                    onClick={() => setSelected(r.id)}
                    className={`w-full rounded-lg border p-3 text-left text-sm transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                      selected === r.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                    }`}
                  >
                    <div className="font-medium">{referralCandidateSummary(r)}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.status ?? "referral"}
                      {r.referral_received_at
                        ? ` · received ${fmtDate(r.referral_received_at)}`
                        : ""}
                    </div>
                  </button>
                ))}
              </div>
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button variant="outline" className="h-11 sm:h-10" onClick={resetAndClose}>
                  Cancel
                </Button>
                <Button
                  className="h-11 sm:h-10"
                  disabled={!selected || !candidates?.some((c) => c.id === selected)}
                  onClick={() => {
                    setStale(false);
                    setApplyError(null);
                    setStep("preview");
                  }}
                >
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
              {previewLoading && (
                <p role="status" className="text-sm text-muted-foreground">
                  Checking fields…
                </p>
              )}
              {previewQ.isError && !previewLoading && (
                <InlineAlert
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-10 gap-1.5 sm:h-8"
                      onClick={() => void reloadPreview()}
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                      Try again
                    </Button>
                  }
                >
                  The preview couldn't be loaded, so it can't be confirmed. Nothing has been
                  changed.
                </InlineAlert>
              )}
              {stale && (
                <InlineAlert
                  action={
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-10 gap-1.5 sm:h-8"
                      onClick={() => void reloadPreview()}
                      disabled={previewLoading}
                    >
                      <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                      Reload preview
                    </Button>
                  }
                >
                  {PREFILL_STALE_MESSAGE}
                </InlineAlert>
              )}
              {applyError && !stale && (
                <InlineAlert>The prefill could not be saved: {applyError}</InlineAlert>
              )}
              {preview && !previewQ.isError && !stale && (
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
                <Button
                  variant="outline"
                  className="h-11 sm:h-10"
                  onClick={() => {
                    setStale(false);
                    setApplyError(null);
                    setStep("pick");
                  }}
                >
                  Back
                </Button>
                <Button
                  className="h-11 sm:h-10"
                  disabled={!canConfirm}
                  onClick={() => {
                    if (!selected || !preview) return;
                    setApplyError(null);
                    prefillMut.mutate({ referral_id: selected, preview });
                  }}
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
