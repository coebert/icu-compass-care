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
  type ChartExtraction,
  type MatchCandidate,
} from "@/lib/chart-extract.functions";
import { fmtDate } from "@/lib/icu";
import { ChartReviewSheet } from "@/components/patient/chart-review-sheet";
import {
  ChartRedactor,
  bakeRedactions,
  loadPage,
  type RedactionPage,
} from "@/components/patient/chart-redactor";



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

export function ScanChartDialog({
  open,
  onOpenChange,
  patientId,
  chartDate,
  onCommitted,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  patientId: string;
  chartDate: string;
  onCommitted: () => void;
}) {
  const [stage, setStage] = useState<"pick" | "redact" | "reading" | "review">("pick");
  const [pageCount, setPageCount] = useState(0);
  const [redactPages, setRedactPages] = useState<RedactionPage[]>([]);
  const [extraction, setExtraction] = useState<ChartExtraction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const extractFn = useServerFn(extractChart);
  const commitFn = useServerFn(commitChart);

  const reset = () => {
    setStage("pick");
    setPageCount(0);
    setRedactPages([]);
    setExtraction(null);
    setError(null);
    if (fileInput.current) fileInput.current.value = "";
  };

  const extractMut = useMutation({
    mutationFn: async (pagesToSend: RedactionPage[]) => {
      // Bake redactions into each page BEFORE handing bytes to the server fn.
      const pages: string[] = [];
      for (const p of pagesToSend) pages.push(await bakeRedactions(p));
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
      commitFn({ data: { patientId, chartDate, extraction: ex } }),
    onSuccess: (res) => {
      toast.success(
        `Chart committed: ${res.observationsAdded} obs, ${res.investigationsAdded} investigations`,
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Camera className="h-4 w-4" /> Scan Radnor chart — {chartDate}
          </DialogTitle>
          <DialogDescription>
            The photo is sent to the extractor and immediately discarded. Only the
            structured values below are stored, and only hospital number and initials
            identify the patient.
          </DialogDescription>
        </DialogHeader>

        {stage === "pick" && (
          <div className="space-y-4">
            <div className="rounded border border-dashed p-4 text-sm text-muted-foreground">
              <p className="mb-2">Take a photo of each page of the paper chart (max 3 pages).</p>
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
              capture="environment"
              multiple
              className="hidden"
              onChange={(e) => onFiles(e.target.files)}
            />
            <Button
              className="w-full gap-2"
              onClick={() => fileInput.current?.click()}
            >
              <Camera className="h-4 w-4" /> Open camera / choose photos
            </Button>
          </div>
        )}

        {stage === "redact" && redactPages.length > 0 && (
          <div className="space-y-3">
            <ChartRedactor pages={redactPages} onChange={setRedactPages} />
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
                onClick={() => {
                  const total = redactPages.reduce((n, p) => n + p.boxes.length, 0);
                  if (total === 0) {
                    setError(
                      "Please cover the patient name and date of birth on at least one page before sending.",
                    );
                    return;
                  }
                  setError(null);
                  setStage("reading");
                  extractMut.mutate(redactPages);
                }}
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
            currentPatientId={patientId}
            onChange={setExtraction}
            onCancel={() => {
              reset();
              onOpenChange(false);
            }}
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
  currentPatientId,
  onChange,
  onCancel,
  onConfirm,
  committing,
}: {
  extraction: ChartExtraction;
  currentPatientId: string;
  onChange: (e: ChartExtraction) => void;
  onCancel: () => void;
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
  const currentMatched = candidates.find((c) => c.id === currentPatientId);
  const mismatched =
    !!currentMatched === false && (extraction.hospital_number || extraction.initials);

  const canConfirm = !committing && (!mismatched || override);

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
        <p className="mb-2 font-medium">Patient (from chart sticker)</p>
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
        currentPatientId={currentPatientId}
        currentMatched={!!currentMatched}
        hasStickerFields={!!(extraction.hospital_number || extraction.initials)}
      />

      {mismatched && (
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
          <ChartReviewSheet extraction={extraction} lowConf={lowConf} />
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

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={committing}>
          Discard
        </Button>
        <Button onClick={onConfirm} disabled={!canConfirm} className="gap-2">
          {committing && <Loader2 className="h-4 w-4 animate-spin" />}
          Confirm &amp; save
        </Button>
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
  currentPatientId,
  currentMatched,
  hasStickerFields,
}: {
  loading: boolean;
  candidates: MatchCandidate[];
  primary: MatchCandidate | undefined;
  currentPatientId: string;
  currentMatched: boolean;
  hasStickerFields: boolean;
}) {
  if (!hasStickerFields) {
    return (
      <div className="flex items-start gap-2 rounded border border-amber-500/40 bg-amber-500/5 p-3 text-xs">
        <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-600" />
        <span>
          No hospital number or initials were read from the sticker. Enter them above
          so the app can confirm the chart belongs to this patient.
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
  if (currentMatched) {
    const p = candidates.find((c) => c.id === currentPatientId)!;
    return (
      <div className="rounded border border-emerald-500/40 bg-emerald-500/5 p-3 text-sm">
        <p className="flex items-center gap-2 font-medium text-emerald-700 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" /> Matched patient
        </p>
        <CandidateLine c={p} />
        <p className="mt-1 text-xs text-muted-foreground">
          Sticker corresponds to the patient record you are filing against.
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
          Check the sticker values above, or add the patient in the app before filing
          this chart.
        </p>
      </div>
    );
  }
  return (
    <div className="rounded border border-destructive/50 bg-destructive/5 p-3 text-sm">
      <p className="flex items-center gap-2 font-medium text-destructive">
        <AlertTriangle className="h-4 w-4" /> Sticker does NOT match the current patient
      </p>
      {primary && (
        <>
          <p className="mt-2 text-xs">The sticker looks like:</p>
          <CandidateLine c={primary} />
        </>
      )}
      {candidates.length > 1 && (
        <ul className="mt-2 space-y-1 text-xs">
          {candidates.slice(1).map((c) => (
            <li key={c.id}>
              <CandidateLine c={c} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Open the correct patient and scan the chart from there, or tick the override
        box below if you are certain the sticker is wrong.
      </p>
    </div>
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
  if (c.sex) bits.push(String(c.sex).slice(0, 1).toUpperCase());
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

