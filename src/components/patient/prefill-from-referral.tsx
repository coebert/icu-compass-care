import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { fmtDate } from "@/lib/icu";
import {
  getPartnerReferralBase,
  listReferralCandidates,
  prefillPatientFromReferral,
  previewReferralPrefill,
} from "@/lib/referral-prefill.functions";
import {
  referralCandidateSummary,
  PREFILL_FIELD_LABEL,
  type PrefillDecision,
  type PrefillLinkState,
  PREFILL_STALE_MESSAGE,
  REFERRAL_LINK_REQUIRED_MESSAGE,
  partnerReferralUrl,
} from "@/lib/referral-prefill";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, ClipboardPlus, ExternalLink, Info, RefreshCw } from "lucide-react";
import { toast } from "sonner";

type LinkedPreview = {
  link: "linked";
  applied_fields: string[];
  skipped_fields: string[];
  patch: Record<string, string | boolean>;
  decisions?: PrefillDecision[];
  patient_updated_at: string;
  referral_updated_at: string | null;
};
type BlockedPreview = {
  link: Exclude<PrefillLinkState, "linked">;
  partner_referral_url: string | null;
};
type PrefillPreview = LinkedPreview | BlockedPreview;
/** A preview tagged with the exact target it was fetched for. */
type TaggedPreview = { patientId: string; referralId: string; result: PrefillPreview };

/**
 * The exact identity a confirmation is bound to: target patient, referral,
 * both revisions and the documented decisions offered. Any change means a
 * different preview, so earlier ticks never carry over.
 */
export function previewIdentity(patientId: string, referralId: string, p: LinkedPreview): string {
  return JSON.stringify([
    patientId,
    referralId,
    p.patient_updated_at,
    p.referral_updated_at,
    (p.decisions ?? []).map((d) => [d.field, d.value]),
  ]);
}

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

/** Opens the referral in Critical Care Connect (opaque referral id only). */
function OpenInCcc({ href, compact }: { href: string | null; compact?: boolean }) {
  if (!href) {
    return (
      <span className="text-xs text-muted-foreground">
        Open it in Critical Care Connect (link not configured here).
      </span>
    );
  }
  return (
    <Button
      asChild
      variant="outline"
      size="sm"
      className={compact ? "h-10 gap-1.5 sm:h-8" : "h-11 gap-1.5 sm:h-10"}
    >
      <a href={href} target="_blank" rel="noopener noreferrer">
        <ExternalLink className="h-3.5 w-3.5" aria-hidden />
        Open in Critical Care Connect
        <span className="sr-only"> (opens in a new tab)</span>
      </a>
    </Button>
  );
}

function LinkRequired({ href, state }: { href: string | null; state: PrefillLinkState }) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm"
    >
      <div className="flex gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
        <p>
          {state === "mismatch"
            ? "This patient is linked to a different referral, so nothing can be copied from this one."
            : "This patient isn't linked to this referral, so nothing can be copied here."}{" "}
          Confirm the match in Critical Care Connect, which checks the hospital number against this
          record. Nothing has been changed.
        </p>
      </div>
      <div>
        <OpenInCcc href={href} />
      </div>
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
  linkedReferralId,
  onDone,
}: {
  patientId: string;
  /** The referral this patient is already linked to (set via Critical Care Connect), if any. */
  linkedReferralId: string | null;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [stale, setStale] = useState(false);
  const [linkLost, setLinkLost] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  // Referral-documented decisions the user has explicitly ticked, bound to the
  // exact preview identity they were ticked against.
  const [accepted, setAccepted] = useState<{ identity: string; fields: string[] } | null>(null);
  // Bumped on every open, close and target change. A late response or
  // mutation from an earlier session must not touch the current dialog.
  const sessionRef = useRef(0);
  const targetRef = useRef({ patientId, linkedReferralId });
  const qc = useQueryClient();
  const listFn = useServerFn(listReferralCandidates);
  const previewFn = useServerFn(previewReferralPrefill);
  const prefillFn = useServerFn(prefillPatientFromReferral);
  const baseFn = useServerFn(getPartnerReferralBase);
  const linked = !!linkedReferralId;

  const baseQ = useQuery({
    queryKey: ["partner-referral-base"],
    queryFn: () => baseFn() as Promise<{ origin: string | null }>,
    enabled: open,
    staleTime: 10 * 60_000,
    retry: 1,
  });
  const linkFor = (id: string) => partnerReferralUrl(baseQ.data?.origin ?? null, id);

  // Unlinked: the list only helps find the referral in CCC; nothing is copied.
  const candidatesQ = useQuery({
    queryKey: ["referral-candidates"],
    queryFn: () => listFn() as Promise<ReferralCandidate[]>,
    enabled: open && !linked,
    retry: 1,
  });
  const candidates = candidatesQ.data;

  const previewQ = useQuery({
    queryKey: ["referral-prefill-preview", patientId, linkedReferralId],
    queryFn: async (): Promise<TaggedPreview> => ({
      patientId,
      referralId: linkedReferralId!,
      result: (await previewFn({
        data: { patient_id: patientId, referral_id: linkedReferralId! },
      })) as PrefillPreview,
    }),
    enabled: open && linked,
    retry: 1,
    // A preview is only good for the version it was computed from.
    gcTime: 0,
  });
  // Only a preview fetched for THIS patient and referral is ever shown.
  const tagged = previewQ.data;
  const preview: PrefillPreview | undefined =
    tagged && tagged.patientId === patientId && tagged.referralId === linkedReferralId
      ? tagged.result
      : undefined;
  const previewLoading = previewQ.isFetching;
  const ready: LinkedPreview | null =
    preview?.link === "linked" ? (preview as LinkedPreview) : null;
  const identity =
    ready && linkedReferralId ? previewIdentity(patientId, linkedReferralId, ready) : null;
  // Ticks from any other preview (earlier revision, other patient/referral,
  // previous opening) are ignored rather than inherited.
  const acceptedFields = identity && accepted?.identity === identity ? accepted.fields : [];

  const clearSessionState = () => {
    setStale(false);
    setLinkLost(false);
    setApplyError(null);
    setAccepted(null);
  };
  const dropPreview = () => {
    // A late in-flight preview must not populate the next opening.
    void qc.cancelQueries({ queryKey: ["referral-prefill-preview"] });
    qc.removeQueries({ queryKey: ["referral-prefill-preview"] });
  };

  const openDialog = () => {
    sessionRef.current += 1;
    clearSessionState();
    dropPreview();
    setOpen(true);
  };
  const resetAndClose = () => {
    sessionRef.current += 1;
    setOpen(false);
    clearSessionState();
    dropPreview();
  };

  // A different target patient or referral is a new session: close, forget.
  useEffect(() => {
    const prev = targetRef.current;
    targetRef.current = { patientId, linkedReferralId };
    if (prev.patientId === patientId && prev.linkedReferralId === linkedReferralId) return;
    sessionRef.current += 1;
    setOpen(false);
    setStale(false);
    setLinkLost(false);
    setApplyError(null);
    setAccepted(null);
    void qc.cancelQueries({ queryKey: ["referral-prefill-preview"] });
    qc.removeQueries({ queryKey: ["referral-prefill-preview"] });
  }, [patientId, linkedReferralId, qc]);

  const reloadPreview = async () => {
    setStale(false);
    setApplyError(null);
    // A decision must be re-ticked against the fresh preview.
    setAccepted(null);
    await previewQ.refetch();
  };

  type PrefillVars = {
    session: number;
    patient_id: string;
    referral_id: string;
    preview: LinkedPreview;
    accept: string[];
  };
  /** True only while the dialog that started this write is still the one on screen. */
  const isCurrent = (v: PrefillVars) =>
    v.session === sessionRef.current &&
    v.patient_id === targetRef.current.patientId &&
    v.referral_id === targetRef.current.linkedReferralId;

  const prefillMut = useMutation({
    mutationFn: (p: PrefillVars) =>
      prefillFn({
        data: {
          patient_id: p.patient_id,
          referral_id: p.referral_id,
          expected_patient_updated_at: p.preview.patient_updated_at,
          expected_referral_updated_at: p.preview.referral_updated_at,
          accept_decisions: p.accept as "dnacpr_decision"[],
        },
      }),
    onSuccess: (res: { applied_fields: string[]; skipped_fields: string[] }, vars) => {
      if (!isCurrent(vars)) {
        // The record changed behind a dialog that is no longer this one:
        // refresh data only; never close, toast or mark another target done.
        if (vars.patient_id === targetRef.current.patientId) onDone();
        void qc.invalidateQueries({ queryKey: ["referral-prefill-preview"] });
        return;
      }
      const applied = res.applied_fields.map((f) => PREFILL_FIELD_LABEL[f] ?? f);
      if (applied.length) {
        toast.success("Prefilled from referral", { description: applied.join(", ") });
      } else {
        toast.info("Nothing to fill", { description: "Existing entries were kept." });
      }
      resetAndClose();
      onDone();
    },
    onError: (e: Error, vars) => {
      if (!isCurrent(vars)) return;
      if (e.message === PREFILL_STALE_MESSAGE) {
        // Refresh the record behind the dialog; the user reloads and reconfirms.
        setStale(true);
        onDone();
        return;
      }
      if (e.message === REFERRAL_LINK_REQUIRED_MESSAGE) {
        setLinkLost(true);
        onDone();
        return;
      }
      setApplyError(e.message || "The prefill could not be saved.");
    },
  });

  // Decisions and confirm are locked while anything is in flight, so a tick
  // can only ever be made against the preview currently on screen.
  const controlsLocked = previewLoading || prefillMut.isPending;
  const canConfirm =
    !!ready &&
    !!identity &&
    previewQ.isSuccess &&
    !previewLoading &&
    !stale &&
    !linkLost &&
    !prefillMut.isPending;

  const fmtPatchValue = (v: string | boolean): string =>
    typeof v === "boolean" ? (v ? "Yes" : "No") : v;

  return (
    <>
      <Button variant="outline" className="gap-1.5" onClick={openDialog}>
        <ClipboardPlus className="h-4 w-4" /> {linked ? "Referral" : "From referral"}
      </Button>
      <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : resetAndClose())}>
        <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {linked ? "Review fields to be populated" : "Prefill from critical care referral"}
            </DialogTitle>
          </DialogHeader>

          {!linked && (
            <>
              <div
                role="status"
                className="flex gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm"
              >
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
                <p>
                  This patient isn't linked to a referral yet, so nothing can be copied here. Find
                  the referral below and open it in Critical Care Connect to confirm the match — it
                  checks the hospital number against this record. Once linked, come back here to
                  fill blank fields.
                </p>
              </div>
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
              <ul className="space-y-2" aria-label="Referrals">
                {(candidatesQ.isError ? [] : (candidates ?? [])).map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-col gap-2 rounded-lg border p-3 text-sm sm:flex-row sm:items-center"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{referralCandidateSummary(r)}</div>
                      <div className="text-xs text-muted-foreground">
                        {r.status ?? "referral"}
                        {r.referral_received_at
                          ? ` · received ${fmtDate(r.referral_received_at)}`
                          : ""}
                      </div>
                    </div>
                    <OpenInCcc href={linkFor(r.id)} compact />
                  </li>
                ))}
              </ul>
              <div className="flex justify-end gap-2 border-t pt-4">
                <Button variant="outline" className="h-11 sm:h-10" onClick={resetAndClose}>
                  Close
                </Button>
              </div>
            </>
          )}

          {linked && (
            <>
              {!(preview && preview.link !== "linked") && !linkLost && (
                <p className="text-sm text-muted-foreground">
                  These are the exact fields that will be populated from the linked referral. Fields
                  already containing data are left untouched. Filled text is marked as referral
                  information that needs review. Detailed referral history stays in Critical Care
                  Connect.
                </p>
              )}
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
              {preview && preview.link !== "linked" && !previewLoading && (
                <LinkRequired href={preview.partner_referral_url} state={preview.link} />
              )}
              {linkLost && <LinkRequired href={linkFor(linkedReferralId!)} state="unlinked" />}
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
              {ready && !previewQ.isError && !stale && !linkLost && (
                <div className="space-y-4">
                  <div>
                    <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                      Will be filled ({ready.applied_fields.length})
                    </div>
                    {ready.applied_fields.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        Nothing to fill — all mapped fields already have values.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {ready.applied_fields.map((f) => (
                          <div key={f} className="rounded-lg border p-3 text-sm">
                            <div className="font-medium">{PREFILL_FIELD_LABEL[f] ?? f}</div>
                            <div className="whitespace-pre-wrap text-muted-foreground">
                              {fmtPatchValue(ready.patch[f])}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  {(ready.decisions ?? []).length > 0 && (
                    <fieldset className="space-y-2">
                      <legend className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                        Decision recorded on the referral — not applied unless you tick it
                      </legend>
                      {(ready.decisions ?? []).map((d) => {
                        const id = `prefill-decision-${d.field}`;
                        const on = acceptedFields.includes(d.field);
                        return (
                          <label
                            key={d.field}
                            htmlFor={id}
                            className="flex cursor-pointer items-start gap-3 rounded-lg border border-primary/40 bg-primary/5 p-3 text-sm"
                          >
                            <input
                              id={id}
                              type="checkbox"
                              className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
                              checked={on}
                              disabled={controlsLocked}
                              onChange={(e) => {
                                if (!identity || controlsLocked) return;
                                const cur = accepted?.identity === identity ? accepted.fields : [];
                                setAccepted({
                                  identity,
                                  fields: e.target.checked
                                    ? [...cur.filter((x) => x !== d.field), d.field]
                                    : cur.filter((x) => x !== d.field),
                                });
                              }}
                            />
                            <span>
                              <span className="block font-medium">
                                Also record {PREFILL_FIELD_LABEL[d.field] ?? d.field}:{" "}
                                {d.value ? "Yes" : "No"}
                              </span>
                              <span className="block text-muted-foreground">
                                {d.label} This field is currently blank here. Only tick if you have
                                confirmed it.
                              </span>
                            </span>
                          </label>
                        );
                      })}
                    </fieldset>
                  )}
                  {ready.skipped_fields.length > 0 && (
                    <div>
                      <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
                        Kept as-is ({ready.skipped_fields.length})
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {ready.skipped_fields.map((f) => (
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
                <Button variant="outline" className="h-11 sm:h-10" onClick={resetAndClose}>
                  Cancel
                </Button>
                <Button
                  className="h-11 sm:h-10"
                  disabled={!canConfirm}
                  onClick={() => {
                    if (!linkedReferralId || !ready || !identity || !canConfirm) return;
                    setApplyError(null);
                    // Exactly what is on screen: this preview and the ticks made on it.
                    prefillMut.mutate({
                      session: sessionRef.current,
                      patient_id: patientId,
                      referral_id: linkedReferralId,
                      preview: ready,
                      accept: acceptedFields,
                    });
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
