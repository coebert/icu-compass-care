import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  listHandoverVersions,
  getHandoverVersion,
  captureHandoverVersionNow,
  type HandoverVersionSummary,
} from "@/lib/handover-versions.functions";
import { getMe } from "@/lib/me.functions";
import { handoverPdfPreviewUrl, downloadHandover, type HandoverPatient } from "@/lib/handover-pdf";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { ArrowLeft, Camera, FileDown, History, Search, Sunrise, Sunset } from "lucide-react";

export const Route = createFileRoute("/_authenticated/patients/history")({
  component: HandoverHistoryPage,
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


  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [shift, setShift] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Debounce the free-text box so we don't hit the server on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const { data: versions = [], isLoading } = useQuery({
    queryKey: ["handover-versions", debouncedQ, from, to, shift],
    queryFn: () =>
      list({
        data: {
          q: debouncedQ || undefined,
          from: from || undefined,
          to: to || undefined,
          shift: shift === "all" ? undefined : shift,
        },
      }) as Promise<HandoverVersionSummary[]>,
  });

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
            <Input id="hv-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="hv-to" className="text-xs">To</Label>
            <Input id="hv-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
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
