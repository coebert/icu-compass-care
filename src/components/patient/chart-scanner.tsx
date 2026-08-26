import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Camera, X, ShieldCheck, AlertTriangle, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import {
  extractChart,
  commitChart,
  matchPatientBySticker,
  searchPatientsForChart,
  type ChartExtraction,
  type MatchCandidate,
} from "@/lib/chart-extract.functions";
import { fmtDate } from "@/lib/icu";
import { formatSexShort } from "@/components/PatientSummary";

import { ChartReviewSheet } from "@/components/patient/chart-review-sheet";
import {
  ChartRedactor,
  bakeRedactions,
  loadPage,
  isRedactionReady,
  DEFAULT_REDACTION_SETTINGS,
  type RedactionPage,
  type RedactionSettings,
} from "@/components/patient/chart-redactor";
import { LiveCameraCapture } from "@/components/patient/live-camera-capture";



// Client-side downscale to ≤2000px longest edge, JPEG 0.85. Also strips EXIF
// (canvas re-encode discards metadata) so no GPS is uploaded with the photo.
async function fileToDownscaledDataUrl(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = reject;
      el.src = url;
    });
    const maxEdge = 2000;
    const scale = Math.min(1, maxEdge / Math.max(img.width, img.height));
    const w = Math.round(img.width * scale);
    const h = Math.round(img.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas not available");
    ctx.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function ScanChartDialog({
  open,
  onOpenChange,
  patientId,
  chartDate: chartDateProp,
  onCommitted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  patientId?: string;
  chartDate?: string;
  onCommitted: () => void;
}) {
  const chartDate = chartDateProp ?? todayISO();
  const [stage, setStage] = useState<"pick" | "camera" | "redact" | "reading" | "review">("pick");
  const [pageCount, setPageCount] = useState(0);
  const [redactPages, setRedactPages] = useState<RedactionPage[]>([]);
  const [extraction, setExtraction] = useState<ChartExtraction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [redactSettings, setRedactSettings] = useState<RedactionSettings>(DEFAULT_REDACTION_SETTINGS);
  // Which patient the chart will actually be filed against. Defaults to the
  // patient whose page opened the scanner, but when opened from the bed board
  // the reviewer must pick a patient via the sticker match or manual picker.
  const [selectedPatientId, setSelectedPatientId] = useState(patientId ?? "");
  const fileInput = useRef<HTMLInputElement | null>(null);

  const extractFn = useServerFn(extractChart);
  const commitFn = useServerFn(commitChart);

  const reset = () => {
    setStage("pick");
    setPageCount(0);
    setRedactPages([]);
    setExtraction(null);
    setError(null);
    setSelectedPatientId(patientId ?? "");
    if (fileInput.current) fileInput.current.value = "";
  };

  // Re-scan: drop extracted values and any in-memory page bytes, return to the
  // file picker for a fresh capture. Nothing is persisted to the app at this
  // point (images are only ever held in component state), so clearing state is
  // sufficient to guarantee no image survives.
  const rescan = () => {
    setExtraction(null);
    setRedactPages([]);
    setError(null);
    setPageCount(0);
    setSelectedPatientId(patientId ?? "");
    if (fileInput.current) fileInput.current.value = "";
    setStage("pick");
  };

  const extractMut = useMutation({
    mutationFn: async (pagesToSend: RedactionPage[]) => {
      // Bake redactions into each page BEFORE handing bytes to the server fn.
      const pages: string[] = [];
      for (const p of pagesToSend) pages.push(await bakeRedactions(p, redactSettings));
      try {
        const res = await extractFn({ data: { patientId, chartDate, pages } });
        return res;
      } finally {
        pages.length = 0;
      }
    },
    onSuccess: (res) => {
      setExtraction(res.extraction);
      setRedactPages([]); // drop original data URLs from memory
      setStage("review");
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Extraction failed");
      setStage("redact");
    },
  });

  const commitMut = useMutation({
    mutationFn: (ex: ChartExtraction) =>
      commitFn({ data: { patientId: selectedPatientId, chartDate, extraction: ex } }),
    onSuccess: (res) => {
      const reassigned = selectedPatientId !== patientId;
      toast.success(
        `Chart committed: ${res.observationsAdded} obs, ${res.investigationsAdded} investigations${
          reassigned ? " (filed against a different patient)" : ""
        }`,
      );
      onCommitted();
      reset();
      onOpenChange(false);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to save chart");
    },
  });

  const onFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    const files = Array.from(list).slice(0, 3);
    setPageCount(files.length);
    setError(null);
    try {
      const prepared: RedactionPage[] = [];
      for (const f of files) {
        const url = await fileToDownscaledDataUrl(f);
        prepared.push(await loadPage(url));
      }
      setRedactPages(prepared);
      setStage("redact");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read image");
    }
  };


  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-4 w-4" /> Scan Radnor chart — {chartDate}
          </DialogTitle>
          <DialogDescription>
            You must blur out the whole patient identity sticker — name, date of birth
            and hospital number — before the image is sent for extraction. No
            patient-identifiable data leaves this device: the extractor only ever sees
            the clinical grid. The photo is discarded immediately after, and you confirm
            the patient yourself on the review screen.
          </DialogDescription>
        </DialogHeader>


        {stage === "pick" && (
          <div className="space-y-4">
            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
              <p className="mb-2">Capture each page of the paper chart (max 3 pages). The live camera grabs frames directly from the device — no photo is saved to your camera roll. On the next screen you blur the entire identity sticker (name, date of birth and hospital number) before anything is sent to the extractor.</p>
              <p className="flex items-center gap-1 text-xs">
                <ShieldCheck className="h-3.5 w-3.5" /> Image is not stored, uploaded to
                any bucket, or logged.
              </p>
            </div>
            {error && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" /> {error}
              </p>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => onFiles(e.target.files)}
            />
            <Button
              className="w-full gap-2"
              onClick={() => setStage("camera")}
            >
              <Camera className="h-4 w-4" /> Scan with live camera
            </Button>
            <Button
              variant="outline"
              className="w-full gap-2"
              onClick={() => fileInput.current?.click()}
            >
              Choose existing photo(s) instead
            </Button>
          </div>
        )}

        {stage === "camera" && (
          <LiveCameraCapture
            maxPages={3}
            onCancel={() => setStage("pick")}
            onDone={(pages) => {
              setRedactPages(pages);
              setPageCount(pages.length);
              setError(null);
              setStage("redact");
            }}
          />
        )}

        {stage === "redact" && redactPages.length > 0 && (
          <div className="space-y-3">
            <ChartRedactor
              pages={redactPages}
              onChange={setRedactPages}
              settings={redactSettings}
              onSettingsChange={setRedactSettings}
            />
            {error && (
              <p className="flex items-center gap-2 text-sm text-destructive">
                <AlertTriangle className="h-4 w-4" /> {error}
              </p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button variant="ghost" size="sm" onClick={reset}>
                Start over
              </Button>
              <Button
                disabled={!isRedactionReady(redactPages)}
                onClick={() => {
                  if (!isRedactionReady(redactPages)) {
                    setError(
                      "Every page must have at least one black box AND 'name covered', 'DOB covered' and 'hospital number covered' all ticked before sending.",
                    );
                    return;
                  }
                  setError(null);
                  setStage("reading");
                  extractMut.mutate(redactPages);
                }}
                title={
                  isRedactionReady(redactPages)
                    ? "Send the redacted image to the extractor"
                    : "Confirm name, DOB and hospital number are covered on every page first"
                }
              >
                Send redacted image to extractor
              </Button>
            </div>
          </div>
        )}

        {stage === "reading" && (
          <div className="flex flex-col items-center justify-center gap-3 py-10 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm">
              Reading {pageCount} page{pageCount === 1 ? "" : "s"}…
            </p>
            <p className="text-xs text-muted-foreground">
              The redacted photo is being processed and will not be retained.
            </p>
          </div>
        )}


        {stage === "review" && extraction && (
          <ReviewPanel
            extraction={extraction}
            openedFromPatientId={patientId}
            selectedPatientId={selectedPatientId}
            onSelectPatient={setSelectedPatientId}
            onChange={setExtraction}
            onCancel={() => {
              reset();
              onOpenChange(false);
            }}
            onRescan={rescan}
            onConfirm={() => commitMut.mutate(extraction)}
            committing={commitMut.isPending}
          />
        )}

        {stage !== "review" && (
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                reset();
                onOpenChange(false);
              }}
              className="gap-1"
            >
              <X className="h-4 w-4" /> Cancel
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ReviewPanel({
  extraction,
  openedFromPatientId,
  selectedPatientId,
  onSelectPatient,
  onChange,
  onCancel,
  onRescan,
  onConfirm,
  committing,
}: {
  extraction: ChartExtraction;
  openedFromPatientId?: string;
  selectedPatientId: string;
  onSelectPatient: (id: string) => void;
  onChange: (e: ChartExtraction) => void;
  onCancel: () => void;
  onRescan: () => void;
  onConfirm: () => void;
  committing: boolean;
}) {
  const hourlyCount = extraction.hourly.length;
  const invCount = extraction.investigations.filter((i) => (i.findings ?? "").trim()).length;
  const microCount = extraction.microbiology.filter((m) => (m.findings ?? "").trim()).length;
  const assessCount = Object.values(extraction.assessments ?? {}).filter(
    (v) => typeof v === "string" && v.trim(),
  ).length;

  const lowConf = new Set(extraction.low_confidence ?? []);
  const isUncertain = (path: string) => lowConf.has(path);
  const countLowIn = (prefix: string) =>
    (extraction.low_confidence ?? []).filter(
      (p) => p === prefix || p.startsWith(`${prefix}.`) || p.startsWith(`${prefix}[`),
    ).length;
  const hourlyLow = countLowIn("hourly");
  const invLow = countLowIn("investigations");
  const microLow = countLowIn("microbiology");
  const assessLow = countLowIn("assessments");
  const balanceLow = isUncertain("balance_24h_ml");

  const patch = (k: keyof ChartExtraction, v: unknown) => onChange({ ...extraction, [k]: v });
  const clearUncertain = (path: string) => {
    const next = (extraction.low_confidence ?? []).filter((p) => p !== path);
    onChange({ ...extraction, low_confidence: next });
  };

  const [override, setOverride] = useState(false);
  // Reset the "file anyway" override whenever the sticker fields change so a
  // fresh mismatch always re-arms the safety gate.
  useEffect(() => {
    setOverride(false);
  }, [extraction.hospital_number, extraction.initials]);

  const matchFn = useServerFn(matchPatientBySticker);
  const matchQuery = useQuery({
    queryKey: [
      "sticker-match",
      extraction.hospital_number ?? "",
      extraction.initials ?? "",
    ],
    queryFn: () =>
      matchFn({
        data: {
          hospital_number: extraction.hospital_number ?? null,
          initials: extraction.initials ?? null,
        },
      }),
    enabled: !!(extraction.hospital_number || extraction.initials),
    staleTime: 30_000,
  });

  const candidates = matchQuery.data?.candidates ?? [];
  const primary: MatchCandidate | undefined = candidates[0];
  const stickerMatchedSelected = candidates.some((c) => c.id === selectedPatientId);
  const stickerMismatch =
    !stickerMatchedSelected && !!(extraction.hospital_number || extraction.initials);
  // When the reviewer has reassigned to a patient outside the current page,
  // treat that as an explicit manual pick — no override checkbox needed.
  const manuallyReassigned = selectedPatientId !== (openedFromPatientId ?? "");

  const hasSelectedPatient =
    selectedPatientId.length > 0 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selectedPatientId);
  const canConfirm =
    !committing && hasSelectedPatient && (!stickerMismatch || manuallyReassigned || override);

  const totalLow = (extraction.low_confidence ?? []).length;
  const conf = extraction.overall_confidence;
  const confPct = conf == null ? null : Math.round(conf * 100);
  const confTone =
    conf == null
      ? "bg-muted text-muted-foreground"
      : conf >= 0.85
        ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/40"
        : conf >= 0.6
          ? "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/40"
          : "bg-destructive/10 text-destructive border-destructive/40";

  return (
    <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded-full border px-2 py-0.5 font-medium ${confTone}`}>
          OCR confidence: {confPct == null ? "unknown" : `${confPct}%`}
        </span>
        <span className="text-muted-foreground">
          {totalLow === 0
            ? "No fields flagged as uncertain."
            : `${totalLow} field${totalLow === 1 ? "" : "s"} flagged for review.`}
        </span>
      </div>

      <div className="rounded border p-3 text-sm">
        <p className="mb-2 font-medium">Patient identifiers (type these from the paper chart)</p>
        <p className="mb-2 text-xs text-muted-foreground">
          The sticker was redacted before extraction, so no identifier was read from the
          image. Enter them here to match the chart to a patient record, or use the
          picker below.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs">
            <span className="flex items-center gap-1">
              Initials
              {isUncertain("initials") && <UncertainBadge onClear={() => clearUncertain("initials")} />}
            </span>
            <input
              className={`mt-1 w-full rounded border px-2 py-1 text-sm ${
                isUncertain("initials") ? "border-amber-500/60 bg-amber-500/5" : ""
              }`}
              value={extraction.initials ?? ""}
              maxLength={3}
              onChange={(e) => patch("initials", e.target.value.toUpperCase() || null)}
            />
          </label>
          <label className="text-xs">
            <span className="flex items-center gap-1">
              Hospital number
              {isUncertain("hospital_number") && (
                <UncertainBadge onClear={() => clearUncertain("hospital_number")} />
              )}
            </span>
            <input
              className={`mt-1 w-full rounded border px-2 py-1 text-sm ${
                isUncertain("hospital_number") ? "border-amber-500/60 bg-amber-500/5" : ""
              }`}
              value={extraction.hospital_number ?? ""}
              maxLength={50}
              onChange={(e) => patch("hospital_number", e.target.value || null)}
            />
          </label>
        </div>
      </div>

      <StickerMatchPanel
        loading={matchQuery.isLoading}
        candidates={candidates}
        primary={primary}
        selectedPatientId={selectedPatientId}
        onSelectPatient={onSelectPatient}
        openedFromPatientId={openedFromPatientId}
        hasStickerFields={!!(extraction.hospital_number || extraction.initials)}
        extractedMrn={extraction.hospital_number ?? null}
        extractedInitials={extraction.initials ?? null}
        onAutoFill={(mrn, initials) =>
          onChange({
            ...extraction,
            hospital_number: mrn,
            initials: initials,
            low_confidence: (extraction.low_confidence ?? []).filter(
              (p) => p !== "hospital_number" && p !== "initials",
            ),
          })
        }
      />


      <ManualPatientPicker
        selectedPatientId={selectedPatientId}
        openedFromPatientId={openedFromPatientId}
        onSelectPatient={onSelectPatient}
        defaultOpen={stickerMismatch || !openedFromPatientId}
      />

      {stickerMismatch && !manuallyReassigned && (
        <label className="flex items-start gap-2 rounded border border-destructive/50 bg-destructive/5 p-3 text-xs">
          <input
            type="checkbox"
            checked={override}
            onChange={(e) => setOverride(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I have checked the chart sticker and it does correspond to this patient
            record. File anyway.
          </span>
        </label>
      )}

      <SummaryRow label="Hourly rows extracted" count={hourlyCount} lowCount={hourlyLow} />
      <SummaryRow label="Investigations" count={invCount} lowCount={invLow} />
      <SummaryRow label="Microbiology results" count={microCount} lowCount={microLow} />
      <SummaryRow label="System assessments" count={assessCount} lowCount={assessLow} />
      <SummaryRow
        label="24h fluid balance (mL)"
        text={extraction.balance_24h_ml != null ? String(extraction.balance_24h_ml) : "—"}
        flagged={balanceLow}
      />

      <details className="rounded border p-3" open>
        <summary className="cursor-pointer text-sm font-medium">
          Detailed review — every extracted value with predicted ranges
        </summary>
        <div className="mt-3">
          <ChartReviewSheet extraction={extraction} lowConf={lowConf} onChange={onChange} />
        </div>
      </details>

      {totalLow > 0 && (
        <details className="rounded border border-amber-500/40 bg-amber-500/5 p-3 text-xs" open>
          <summary className="cursor-pointer text-sm font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mr-1 inline h-3.5 w-3.5" />
            Uncertain fields ({totalLow}) — review before saving
          </summary>
          <ul className="mt-2 space-y-1">
            {(extraction.low_confidence ?? []).map((p) => (
              <li key={p} className="flex items-center justify-between gap-2">
                <span className="font-mono text-[11px]">{p}</span>
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground">
                    {readByPath(extraction, p) ?? <em>(no value)</em>}
                  </span>
                  <button
                    type="button"
                    onClick={() => clearUncertain(p)}
                    className="rounded border px-1.5 py-0.5 text-[10px] hover:bg-background"
                    title="Mark this field as reviewed"
                  >
                    Mark reviewed
                  </button>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Edit values in the sections above or in the chart/system tabs after saving.
            Marking a field reviewed removes it from this list but does not change the value.
          </p>
        </details>
      )}

      <details className="rounded border p-3 text-xs">
        <summary className="cursor-pointer text-sm font-medium">
          View raw extracted data
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[11px]">
          {JSON.stringify(extraction, null, 2)}
        </pre>
      </details>

      <p className="text-xs text-muted-foreground">
        Confirm to save these values to the digital chart AND write them through to
        observations, investigations, microbiology, and systems review. You can edit
        any value from the chart / relevant tab after saving.
      </p>

      <DialogFooter className="gap-2 sm:justify-between">
        <Button variant="outline" onClick={onCancel} disabled={committing}>
          Discard
        </Button>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            onClick={onRescan}
            disabled={committing}
            className="gap-2"
            title="Discard these extracted values and upload a new photo for the same 24h chart. No image is retained."
          >
            <Camera className="h-4 w-4" /> Re-scan
          </Button>
          <Button onClick={onConfirm} disabled={!canConfirm} className="gap-2">
            {committing && <Loader2 className="h-4 w-4 animate-spin" />}
            Confirm &amp; save
          </Button>
        </div>
      </DialogFooter>
    </div>
  );
}

function UncertainBadge({ onClear }: { onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      title="Flagged as uncertain — click to mark reviewed"
      className="inline-flex items-center gap-0.5 rounded-full border border-amber-500/50 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:text-amber-400"
    >
      <AlertTriangle className="h-3 w-3" /> uncertain
    </button>
  );
}

function readByPath(obj: ChartExtraction, path: string): string | null {
  try {
    // Supports: a, a.b, a[0], a[0].b
    const parts = path.split(/\.|(?=\[)/g);
    let cur: unknown = obj;
    for (const raw of parts) {
      if (cur == null) return null;
      const m = raw.match(/^\[(\d+)\]$/);
      if (m) {
        cur = (cur as unknown[])[Number(m[1])];
      } else {
        cur = (cur as Record<string, unknown>)[raw];
      }
    }
    if (cur == null || cur === "") return null;
    const s = typeof cur === "object" ? JSON.stringify(cur) : String(cur);
    return s.length > 60 ? `${s.slice(0, 57)}…` : s;
  } catch {
    return null;
  }
}


function StickerMatchPanel({
  loading,
  candidates,
  primary,
  selectedPatientId,
  onSelectPatient,
  openedFromPatientId,
  hasStickerFields,
  extractedMrn,
  extractedInitials,
  onAutoFill,
}: {
  loading: boolean;
  candidates: MatchCandidate[];
  primary: MatchCandidate | undefined;
  selectedPatientId: string;
  onSelectPatient: (id: string) => void;
  openedFromPatientId?: string;
  hasStickerFields: boolean;
  extractedMrn: string | null;
  extractedInitials: string | null;
  onAutoFill: (mrn: string | null, initials: string | null) => void;
}) {
  if (!hasStickerFields) {
    return (
      <div className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
        <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" />
        <span>
          No hospital number or initials were read from the sticker. Enter them above,
          or use the patient picker below to assign this chart manually.
        </span>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded border p-3 text-xs text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Matching sticker to patient record…
      </div>
    );
  }
  const stickerMatched = candidates.find((c) => c.id === selectedPatientId);
  if (stickerMatched) {
    return (
      <div className="rounded border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
        <p className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" /> Matched patient
        </p>
        <CandidateLine c={stickerMatched} />
        <p className="mt-1 text-xs text-muted-foreground">
          Sticker corresponds to the patient this chart will be filed against.
        </p>
      </div>
    );
  }
  if (!candidates.length) {
    return (
      <div className="rounded border border-destructive/50 bg-destructive/5 p-3 text-sm">
        <p className="flex items-center gap-2 font-medium text-destructive">
          <AlertTriangle className="h-4 w-4" /> No patient record matches this sticker
        </p>
        <p className="mt-1 text-xs">
          Check the sticker values above, use the patient picker below to search for
          the correct record, or add the patient in the app before filing this chart.
        </p>
      </div>
    );
  }
  const mismatchLabel = openedFromPatientId
    ? "Sticker does NOT match the current patient"
    : "Sticker does NOT match the selected patient";
  return (
    <div className="rounded border border-destructive/50 bg-destructive/5 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-destructive">
        <AlertTriangle className="h-4 w-4" /> {mismatchLabel}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {candidates.length === 1
          ? "One candidate patient matches — compare the sticker to the record below."
          : `${candidates.length} candidate patients match — compare each side-by-side and pick the correct one.`}
      </p>
      <ul className="mt-3 space-y-3">
        {candidates.map((c, idx) => (
          <li key={c.id}>
            <CandidateCompareCard
              candidate={c}
              isPrimary={idx === 0 && !!primary && c.id === primary.id}
              extractedMrn={extractedMrn}
              extractedInitials={extractedInitials}
              onSelect={() => onSelectPatient(c.id)}
              onAutoFill={onAutoFill}
            />

          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        <span className="font-medium">File against this patient</span> commits the chart
        to that record. <span className="font-medium">Auto-fill from record</span> keeps
        the current patient but overwrites the extracted MRN/initials with values from
        the chosen record — use it when the OCR read the sticker wrong.
        {openedFromPatientId
          ? selectedPatientId === openedFromPatientId
            ? " Or tick the override box below if the sticker is wrong for this patient."
            : " Or tick the override box below if the sticker is wrong for your selection."
          : " Or tick the override box below if the sticker is wrong for the selected patient."}
      </p>
    </div>
  );
}

function deriveInitials(fullName: string | null): string | null {
  if (!fullName) return null;
  const s = fullName
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 3);
  return s || null;
}

function normaliseMrn(v: string | null): string {
  return (v ?? "").replace(/[-\s]/g, "").toUpperCase();
}

function CandidateCompareCard({
  candidate,
  isPrimary,
  extractedMrn,
  extractedInitials,
  onSelect,
  onAutoFill,
}: {
  candidate: MatchCandidate;
  isPrimary: boolean;
  extractedMrn: string | null;
  extractedInitials: string | null;
  onSelect: () => void;
  onAutoFill: (mrn: string | null, initials: string | null) => void;

}) {
  const recordInitials = deriveInitials(candidate.full_name);
  const mrnMatch =
    !!extractedMrn &&
    !!candidate.hospital_number &&
    normaliseMrn(extractedMrn) === normaliseMrn(candidate.hospital_number);
  const initialsMatch =
    !!extractedInitials &&
    !!recordInitials &&
    extractedInitials.toUpperCase() === recordInitials.toUpperCase();

  const location = [candidate.ward, candidate.bed ? `Bed ${candidate.bed}` : null]
    .filter(Boolean)
    .join(" · ") || "—";
  const demographics = [
    candidate.age != null ? `${candidate.age}y` : null,
    candidate.sex ? formatSexShort(String(candidate.sex)) : null,
    candidate.status,
  ]
    .filter(Boolean)
    .join(" · ") || "—";

  return (
    <div className="rounded border bg-background/60 p-2">
      {isPrimary && (
        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Closest match
        </p>
      )}
      <div className="overflow-hidden rounded border text-xs">
        <table className="w-full table-fixed">
          <thead className="bg-muted/40 text-[10px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th className="w-24 px-2 py-1 text-left font-medium">Field</th>
              <th className="px-2 py-1 text-left font-medium">Extracted (sticker)</th>
              <th className="px-2 py-1 text-left font-medium">Patient record</th>
            </tr>
          </thead>
          <tbody className="font-mono">
            <tr className={`border-t ${mrnMatch ? "bg-emerald-500/5" : extractedMrn && candidate.hospital_number ? "bg-destructive/10" : ""}`}>
              <td className="px-2 py-1 font-sans text-[10px] uppercase tracking-wide text-muted-foreground">MRN</td>
              <td className="px-2 py-1">
                <input
                  className="w-full rounded border bg-background px-1.5 py-0.5 font-mono text-xs"
                  value={extractedMrn ?? ""}
                  maxLength={50}
                  placeholder="—"
                  aria-label="Edit extracted MRN"
                  onChange={(e) => onAutoFill(e.target.value || null, extractedInitials)}
                />
              </td>
              <td className="px-2 py-1 break-all">
                <span className="flex items-center gap-1">
                  {candidate.hospital_number ?? "—"}
                  {extractedMrn && candidate.hospital_number && mrnMatch && (
                    <CheckCircle2 className="h-3 w-3 text-emerald-600" aria-label="matches sticker" />
                  )}
                  {extractedMrn && candidate.hospital_number && !mrnMatch && (
                    <AlertTriangle className="h-3 w-3 text-destructive" aria-label="differs from sticker" />
                  )}
                </span>
              </td>
            </tr>
            <tr className={`border-t ${initialsMatch ? "bg-emerald-500/5" : extractedInitials && recordInitials ? "bg-destructive/10" : ""}`}>
              <td className="px-2 py-1 font-sans text-[10px] uppercase tracking-wide text-muted-foreground">Initials</td>
              <td className="px-2 py-1">
                <input
                  className="w-full rounded border bg-background px-1.5 py-0.5 font-mono text-xs uppercase"
                  value={extractedInitials ?? ""}
                  maxLength={3}
                  placeholder="—"
                  aria-label="Edit extracted initials"
                  onChange={(e) => onAutoFill(extractedMrn, e.target.value.toUpperCase() || null)}
                />
              </td>
              <td className="px-2 py-1 break-all">
                <span className="flex items-center gap-1">
                  {recordInitials ?? "—"}
                  {extractedInitials && recordInitials && initialsMatch && (
                    <CheckCircle2 className="h-3 w-3 text-emerald-600" aria-label="matches sticker" />
                  )}
                  {extractedInitials && recordInitials && !initialsMatch && (
                    <AlertTriangle className="h-3 w-3 text-destructive" aria-label="differs from sticker" />
                  )}
                </span>
              </td>
            </tr>
            <CompareRow label="Age / sex / status" extracted="—" record={demographics} match={null} />
            <CompareRow label="Location" extracted="—" record={location} match={null} />
            <CompareRow
              label="Admitted"
              extracted="—"
              record={candidate.admission_date ? fmtDate(candidate.admission_date) : "—"}
              match={null}
            />
          </tbody>

        </table>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onSelect}
          className="rounded border border-destructive/50 bg-background px-2 py-1 text-xs font-medium hover:bg-destructive/10"
        >
          File against this patient
        </button>
        <button
          type="button"
          onClick={() => onAutoFill(candidate.hospital_number ?? null, recordInitials)}
          className="rounded border px-2 py-1 text-xs font-medium hover:bg-muted/60"
          title="Overwrite the extracted MRN and initials with the values from this patient record"
          disabled={mrnMatch && initialsMatch}
        >
          Auto-fill extracted MRN &amp; initials from record
        </button>
      </div>
    </div>
  );
}

function CompareRow({
  label,
  extracted,
  record,
  match,
}: {
  label: string;
  extracted: string;
  record: string;
  match: boolean | null;
}) {
  const tone =
    match === true
      ? "bg-emerald-500/5"
      : match === false
        ? "bg-destructive/10"
        : "";
  return (
    <tr className={`border-t ${tone}`}>
      <td className="px-2 py-1 font-sans text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </td>
      <td className="px-2 py-1 break-all">{extracted}</td>
      <td className="px-2 py-1 break-all">
        <span className="flex items-center gap-1">
          {record}
          {match === true && (
            <CheckCircle2 className="h-3 w-3 text-emerald-600" aria-label="matches sticker" />
          )}
          {match === false && (
            <AlertTriangle className="h-3 w-3 text-destructive" aria-label="differs from sticker" />
          )}
        </span>
      </td>
    </tr>
  );
}


function ManualPatientPicker({
  selectedPatientId,
  openedFromPatientId,
  onSelectPatient,
  defaultOpen,
}: {
  selectedPatientId: string;
  openedFromPatientId?: string;
  onSelectPatient: (id: string) => void;
  defaultOpen: boolean;
}) {
  const [q, setQ] = useState("");
  const searchFn = useServerFn(searchPatientsForChart);
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const results = useQuery({
    queryKey: ["chart-patient-search", debounced],
    queryFn: () => searchFn({ data: { q: debounced } }),
    enabled: debounced.length >= 2,
    staleTime: 15_000,
  });
  const reassigned =
    !!openedFromPatientId && selectedPatientId !== openedFromPatientId;
  return (
    <details className="rounded border p-3 text-sm" open={defaultOpen || reassigned}>
      <summary className="cursor-pointer text-sm font-medium">
        {openedFromPatientId ? "Assign to a different patient" : "Assign to a patient"}
        {reassigned ? " — reassigned" : ""}
      </summary>
      <div className="mt-3 space-y-2">
        <p className="text-xs text-muted-foreground">
          Search by name or hospital number. Selecting a patient files this chart
          against that record{openedFromPatientId ? " instead of the one you opened the scanner from" : ""}.
        </p>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name or hospital number…"
          className="w-full rounded border px-2 py-1 text-sm"
        />
        {debounced.length >= 2 && results.isLoading && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" /> Searching…
          </p>
        )}
        {debounced.length >= 2 && !results.isLoading && (results.data?.candidates.length ?? 0) === 0 && (
          <p className="text-xs text-muted-foreground">No patients match “{debounced}”.</p>
        )}
        <ul className="max-h-56 space-y-1 overflow-y-auto">
          {(results.data?.candidates ?? []).map((c) => {
            const isSelected = c.id === selectedPatientId;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelectPatient(c.id)}
                  className={`flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left hover:bg-muted/40 ${
                    isSelected ? "border-emerald-500/60 bg-emerald-500/5" : ""
                  }`}
                >
                  <CandidateLine c={c} />
                  {isSelected ? (
                    <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-400">
                      <CheckCircle2 className="h-3 w-3" /> Selected
                    </span>
                  ) : (
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Use
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
        {reassigned && openedFromPatientId && (
          <div className="flex items-center justify-between rounded border border-emerald-500/40 bg-emerald-500/5 px-2 py-1 text-xs">
            <span>Chart will be filed against the selected patient, not the one you opened.</span>
            <button
              type="button"
              onClick={() => onSelectPatient(openedFromPatientId)}
              className="rounded border px-2 py-0.5 text-[11px] hover:bg-background"
            >
              Reset
            </button>
          </div>
        )}
      </div>
    </details>
  );
}

function CandidateLine({ c }: { c: MatchCandidate }) {
  const initials = (c.full_name ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 3);
  const bits: string[] = [];
  if (c.hospital_number) bits.push(`MRN ${c.hospital_number}`);
  if (initials) bits.push(`Initials ${initials}`);
  if (c.age != null) bits.push(`${c.age}y`);
  if (c.sex) bits.push(formatSexShort(String(c.sex)));
  if (c.ward || c.bed) bits.push(`${c.ward ?? ""}${c.bed ? ` · Bed ${c.bed}` : ""}`.trim());
  if (c.status) bits.push(c.status);
  if (c.admission_date) bits.push(`Adm ${fmtDate(c.admission_date)}`);
  return <p className="font-mono text-xs">{bits.join(" · ")}</p>;
}

function SummaryRow({
  label,
  count,
  text,
  lowCount,
  flagged,
}: {
  label: string;
  count?: number;
  text?: string;
  lowCount?: number;
  flagged?: boolean;
}) {
  const showFlag = flagged || (lowCount ?? 0) > 0;
  return (
    <div
      className={`flex items-center justify-between rounded border px-3 py-2 text-sm ${
        showFlag ? "border-amber-500/50 bg-amber-500/5" : ""
      }`}
    >
      <span className="flex items-center gap-2">
        {label}
        {(lowCount ?? 0) > 0 && (
          <span className="inline-flex items-center gap-0.5 rounded-full border border-amber-500/50 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3" /> {lowCount} uncertain
          </span>
        )}
        {flagged && (lowCount ?? 0) === 0 && (
          <span className="inline-flex items-center gap-0.5 rounded-full border border-amber-500/50 bg-amber-500/10 px-1.5 py-0 text-[10px] font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3 w-3" /> uncertain
          </span>
        )}
      </span>
      <span className="font-mono text-xs tabular-nums text-muted-foreground">
        {text ?? String(count ?? 0)}
      </span>
    </div>
  );
}

