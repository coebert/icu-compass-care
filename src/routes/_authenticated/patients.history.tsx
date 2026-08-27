import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import {
  listHandoverVersions,
  getHandoverVersion,
  captureHandoverVersionNow,
  
} from "@/lib/handover-versions.functions";
import { getMe } from "@/lib/me.functions";
import { ClinicalAccessRequired } from "@/components/ClinicalAccessRequired";
import { handoverPdfPreviewUrl, downloadHandover, type HandoverPatient } from "@/lib/handover-pdf";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DatePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Camera, FileDown, GitCompareArrows, History, Search, Sunrise, Sunset } from "lucide-react";

const historySearchSchema = z.object({
  q: fallback(z.string(), "").default(""),
  from: fallback(z.string(), "").default(""),
  to: fallback(z.string(), "").default(""),
  shift: fallback(z.string(), "all").default("all"),
  page: fallback(z.number().int(), 1).default(1),
  versionId: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/_authenticated/patients/history")({
  component: HandoverHistoryPage,
  validateSearch: zodValidator(historySearchSchema),
});


function ShiftBadge({ shift }: { shift: "am" | "pm" }) {
  return shift === "am" ? (
    <Badge variant="secondary" className="gap-1">
      <Sunrise className="h-3 w-3" /> 08:00
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1">
      <Sunset className="h-3 w-3" /> 20:00
    </Badge>
  );
}

function HandoverHistoryPage() {
  const qc = useQueryClient();
  const list = useServerFn(listHandoverVersions);
  const getOne = useServerFn(getHandoverVersion);
  const me = useServerFn(getMe);
  const captureNow = useServerFn(captureHandoverVersionNow);
  const [capturing, setCapturing] = useState(false);

  const { data: profile } = useQuery({ queryKey: ["me"], queryFn: () => me() });
  const isAdmin = profile?.isAdmin ?? false;
  // Clinical roles may author; Trust administrators have view-only break-glass.
  const hasClinicalAccess = Boolean(profile?.canEditClinical) || Boolean(profile?.isTrustAdmin);


  async function handleCaptureNow() {
    setCapturing(true);
    try {
      const r = await captureNow();
      if (r.captured) {
        toast.success(`Saved version — ${r.patient_count} patient(s)`);
        qc.invalidateQueries({ queryKey: ["handover-versions"] });
      } else {
        toast.message(r.skipped ?? "No version saved");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save version");
    } finally {
      setCapturing(false);
    }
  }


  const urlSearch = Route.useSearch();
  const navigate = useNavigate();
  type HistorySearch = z.infer<typeof historySearchSchema>;
  const updateSearch = (patch: Partial<HistorySearch>) =>
    navigate({
      to: "/patients/history",
      search: (prev: Partial<HistorySearch>) => ({ ...prev, ...patch }),
      replace: true,
    });
  const q = urlSearch.q;
  const setQ = (v: string) => updateSearch({ q: v, page: 1 });
  const from = urlSearch.from;
  const setFrom = (v: string) => updateSearch({ from: v, page: 1 });
  const to = urlSearch.to;
  const setTo = (v: string) => updateSearch({ to: v, page: 1 });
  const shift = urlSearch.shift;
  const setShift = (v: string) => updateSearch({ shift: v, page: 1 });
  const page = Math.max(1, urlSearch.page);
  const setPage = (fn: (prev: number) => number) => updateSearch({ page: fn(page) });
  const selectedId = urlSearch.versionId || null;
  const setSelectedId = (id: string | null) => updateSearch({ versionId: id ?? "" });
  const pageSize = 25;

  // Debounce the free-text query so we don't hit the server on every keystroke.
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);


  const { data: pageData, isLoading, isFetching } = useQuery({
    queryKey: ["handover-versions", debouncedQ, from, to, shift, page],
    queryFn: () =>
      list({
        data: {
          q: debouncedQ || undefined,
          from: from || undefined,
          to: to || undefined,
          shift: shift === "all" ? undefined : shift,
          page,
          pageSize,
        },
      }),
    placeholderData: (prev) => prev,
  });

  const versions = pageData?.rows ?? [];
  const total = pageData?.total ?? 0;
  const pageCount = pageData?.pageCount ?? 1;

  const selected = versions.find((v) => v.id === selectedId) ?? null;



  const { data: fullVersion } = useQuery({
    queryKey: ["handover-version", selectedId],
    queryFn: () => getOne({ data: { id: selectedId as string } }),
    enabled: !!selectedId,
  });

  const snapshotPatients = useMemo<HandoverPatient[]>(() => {
    const snap = (fullVersion as { snapshot?: unknown } | undefined)?.snapshot;
    return Array.isArray(snap) ? (snap as HandoverPatient[]) : [];
  }, [fullVersion]);

  const title = selected ? `ICU Handover — ${selected.label}` : "ICU Handover";

  // Build the preview object URL for the selected snapshot.
  const urlRef = useRef<string | null>(null);
  const url = useMemo(() => {
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
    if (!fullVersion || snapshotPatients.length === 0) return null;
    const objectUrl = handoverPdfPreviewUrl(snapshotPatients, {
      title,
      showTimestamp: true,
    });
    urlRef.current = objectUrl;
    return objectUrl;
  }, [fullVersion, snapshotPatients, title]);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  if (profile && !hasClinicalAccess) {
    return (
      <ClinicalAccessRequired
        backTo="/patients"
        backLabel="Patients"
        description="You need clinical access (clinician or admin) to view saved handover snapshot history."
      />
    );
  }


  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link to="/patients">
              <ArrowLeft className="h-4 w-4" /> Patients
            </Link>
          </Button>
          <div>
            <h1 className="flex items-center gap-2 text-lg font-semibold">
              <History className="h-5 w-5 text-primary" /> Handover history
            </h1>
            <p className="text-xs text-muted-foreground">
              Versions are saved automatically at each shift handover (08:00 &amp; 20:00).
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link to="/patients/compare">
              <GitCompareArrows className="h-4 w-4" /> Compare versions
            </Link>
          </Button>
          {isAdmin && (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              disabled={capturing}
              onClick={handleCaptureNow}
            >
              <Camera className="h-4 w-4" />
              {capturing ? "Saving…" : "Save version now"}
            </Button>
          )}
        </div>
      </div>



      {/* Filters */}
      <Card>
        <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-1 sm:col-span-2 lg:col-span-1">
            <Label htmlFor="hv-q" className="text-xs">Search (patient or text)</Label>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="hv-q"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Name, hospital no., diagnosis…"
                className="pl-8"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="hv-from" className="text-xs">From</Label>
            <DatePicker id="hv-from" value={from} onChange={setFrom} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hv-to" className="text-xs">To</Label>
            <DatePicker id="hv-to" value={to} onChange={setTo} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hv-shift" className="text-xs">Shift</Label>
            <Select value={shift} onValueChange={setShift}>
              <SelectTrigger id="hv-shift">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Both shifts</SelectItem>
                <SelectItem value="am">Morning (08:00)</SelectItem>
                <SelectItem value="pm">Evening (20:00)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        {/* Version list */}
        <div className="space-y-2">
          {isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading versions…</p>
          ) : versions.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No saved versions match your search yet.
            </p>
          ) : (
            versions.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => setSelectedId(v.id)}
                className={`w-full rounded-md border p-3 text-left transition-colors hover:bg-accent ${
                  selectedId === v.id ? "border-primary bg-accent" : "bg-background"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{v.label}</span>
                  <ShiftBadge shift={v.shift} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {v.patient_count} patient{v.patient_count === 1 ? "" : "s"}
                </p>
              </button>
            ))
          )}

          {total > 0 && (
            <div className="flex items-center justify-between gap-2 border-t pt-3 text-xs text-muted-foreground">
              <span>
                {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total}
                {isFetching ? " · updating…" : ""}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1 || isFetching}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Prev
                </Button>
                <span className="px-1">
                  {page}/{pageCount}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= pageCount || isFetching}
                  onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Selected version preview */}
        <div className="flex min-h-[60vh] flex-col rounded-md border bg-muted">
          {!selected ? (
            <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
              Select a version to preview and download it.
            </div>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 border-b bg-background p-3">
                <div className="text-sm font-medium">{selected.label}</div>
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={snapshotPatients.length === 0}
                  onClick={() =>
                    downloadHandover(snapshotPatients, { title, showTimestamp: true })
                  }
                >
                  <FileDown className="h-4 w-4" /> Download PDF
                </Button>
              </div>
              <div className="min-h-0 flex-1">
                {url ? (
                  <iframe
                    title="Saved handover preview"
                    src={`${url}#toolbar=1&view=FitH`}
                    className="h-full w-full"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    {snapshotPatients.length === 0 && fullVersion
                      ? "This version has no patients."
                      : "Preparing preview…"}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
