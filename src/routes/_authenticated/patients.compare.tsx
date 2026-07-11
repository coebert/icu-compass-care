import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listHandoverVersions,
  getHandoverVersion,
  type HandoverVersionSummary,
} from "@/lib/handover-versions.functions";
import { diffSnapshots, type PatientDiff } from "@/lib/handover-diff";
import { useClinicalAccess } from "@/hooks/use-clinical-access";
import { ClinicalAccessRequired } from "@/components/ClinicalAccessRequired";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ArrowLeft,
  ArrowRight,
  GitCompareArrows,
  History,
  Sunrise,
  Sunset,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/patients/compare")({
  head: () => ({
    meta: [
      { title: "Compare handover versions — ICU Handover" },
      {
        name: "description",
        content:
          "Compare two saved handover snapshots and highlight what changed per patient — management, escalation plan, outstanding tasks and more.",
      },
    ],
  }),
  component: CompareVersionsPage,
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

function versionLabel(v: HandoverVersionSummary): string {
  return `${v.label} · ${v.patient_count} patient${v.patient_count === 1 ? "" : "s"}`;
}

function PresenceBadge({ presence }: { presence: PatientDiff["presence"] }) {
  if (presence === "added") {
    return <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">New this version</Badge>;
  }
  if (presence === "removed") {
    return <Badge variant="destructive">No longer present</Badge>;
  }
  return null;
}

function CompareVersionsPage() {
  const list = useServerFn(listHandoverVersions);
  const getOne = useServerFn(getHandoverVersion);
  const { hasClinicalAccess, profile } = useClinicalAccess();

  const { data: versions = [], isLoading } = useQuery({
    queryKey: ["handover-versions", "compare-all"],
    queryFn: async () => (await list({ data: { pageSize: 100 } })).rows,
    enabled: hasClinicalAccess,
  });

  const [aId, setAId] = useState<string | null>(null);
  const [bId, setBId] = useState<string | null>(null);
  const [onlyChanged, setOnlyChanged] = useState(true);

  const aVersion = versions.find((v) => v.id === aId) ?? null;
  const bVersion = versions.find((v) => v.id === bId) ?? null;

  const { data: fullA, isFetching: loadingA } = useQuery({
    queryKey: ["handover-version", aId],
    queryFn: () => getOne({ data: { id: aId as string } }),
    enabled: !!aId,
  });
  const { data: fullB, isFetching: loadingB } = useQuery({
    queryKey: ["handover-version", bId],
    queryFn: () => getOne({ data: { id: bId as string } }),
    enabled: !!bId,
  });

  const diff = useMemo(() => {
    if (!fullA || !fullB) return null;
    const snapA = (fullA as { snapshot?: unknown }).snapshot;
    const snapB = (fullB as { snapshot?: unknown }).snapshot;
    return diffSnapshots(snapA, snapB);
  }, [fullA, fullB]);

  const visiblePatients = useMemo(() => {
    if (!diff) return [];
    if (!onlyChanged) return diff.patients;
    return diff.patients.filter(
      (p) => p.presence !== "both" || p.changedCount > 0,
    );
  }, [diff, onlyChanged]);

  const sameSelected = aId && bId && aId === bId;
  const bothLoaded = !!fullA && !!fullB && !loadingA && !loadingB;

  if (profile && !hasClinicalAccess) {
    return (
      <ClinicalAccessRequired
        backTo="/patients/history"
        backLabel="History"
        description="You need clinical access (clinician or admin) to compare saved handover snapshots."
      />
    );
  }


  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Button asChild variant="outline" size="sm" className="gap-1.5">
          <Link to="/patients/history">
            <ArrowLeft className="h-4 w-4" /> History
          </Link>
        </Button>
        <div>
          <h1 className="flex items-center gap-2 text-lg font-semibold">
            <GitCompareArrows className="h-5 w-5 text-primary" /> Compare handover versions
          </h1>
          <p className="text-xs text-muted-foreground">
            Pick an earlier and a later snapshot to see exactly what changed for each patient.
          </p>
        </div>
      </div>

      {/* Version pickers */}
      <Card>
        <CardContent className="grid items-end gap-3 p-4 sm:grid-cols-[1fr_auto_1fr]">
          <div className="space-y-1">
            <Label className="text-xs">Earlier version (before)</Label>
            <Select value={aId ?? undefined} onValueChange={setAId} disabled={isLoading}>
              <SelectTrigger>
                <SelectValue placeholder={isLoading ? "Loading…" : "Select a version"} />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {versionLabel(v)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="hidden pb-2 text-muted-foreground sm:block">
            <ArrowRight className="h-5 w-5" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Later version (after)</Label>
            <Select value={bId ?? undefined} onValueChange={setBId} disabled={isLoading}>
              <SelectTrigger>
                <SelectValue placeholder={isLoading ? "Loading…" : "Select a version"} />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {versionLabel(v)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Summary bar */}
      {aVersion && bVersion && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 p-3 text-sm">
          <span className="flex items-center gap-1.5 font-medium">
            {aVersion.label} <ShiftBadge shift={aVersion.shift} />
          </span>
          <ArrowRight className="h-4 w-4 text-muted-foreground" />
          <span className="flex items-center gap-1.5 font-medium">
            {bVersion.label} <ShiftBadge shift={bVersion.shift} />
          </span>
          {diff && (
            <span className="ml-auto flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <Badge variant="outline">{diff.changedPatientCount} changed</Badge>
              <Badge variant="outline">{diff.addedCount} added</Badge>
              <Badge variant="outline">{diff.removedCount} removed</Badge>
            </span>
          )}
        </div>
      )}

      {sameSelected && (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          Choose two different versions to compare.
        </p>
      )}

      {!sameSelected && aId && bId && !bothLoaded && (
        <p className="p-4 text-sm text-muted-foreground">Loading snapshots…</p>
      )}

      {!sameSelected && diff && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {visiblePatients.length} patient{visiblePatients.length === 1 ? "" : "s"} shown
            </p>
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={onlyChanged} onCheckedChange={setOnlyChanged} />
              Only show patients with changes
            </label>
          </div>

          {visiblePatients.length === 0 ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
              No differences between these two versions.
            </p>
          ) : (
            visiblePatients.map((p) => (
              <PatientDiffCard key={p.id} patient={p} />
            ))
          )}
        </div>
      )}

      {!aId && !bId && !isLoading && versions.length === 0 && (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          <History className="mx-auto mb-2 h-5 w-5" />
          No saved handover versions yet. Versions are captured at each shift handover.
        </p>
      )}
    </div>
  );
}

function PatientDiffCard({ patient }: { patient: PatientDiff }) {
  const changedFields = patient.fields.filter((f) => f.changed);
  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-base font-semibold">{patient.name}</span>
          <span className="text-xs text-muted-foreground">{patient.location}</span>
          <div className="ml-auto flex items-center gap-2">
            <PresenceBadge presence={patient.presence} />
            {patient.presence === "both" && (
              <Badge variant="secondary">
                {patient.changedCount} field{patient.changedCount === 1 ? "" : "s"} changed
              </Badge>
            )}
          </div>
        </div>

        {changedFields.length === 0 ? (
          <p className="text-sm text-muted-foreground">No field-level changes.</p>
        ) : (
          <div className="divide-y">
            {changedFields.map((f) => (
              <div key={f.key} className="grid gap-2 py-2 sm:grid-cols-[180px_1fr]">
                <div className="text-sm font-medium text-muted-foreground">{f.label}</div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm dark:border-red-900/50 dark:bg-red-950/30">
                    <p className="mb-1 text-[11px] uppercase tracking-wide text-red-700 dark:text-red-400">
                      Before
                    </p>
                    <p className="whitespace-pre-wrap break-words text-foreground/80">
                      {f.before || <span className="italic text-muted-foreground">empty</span>}
                    </p>
                  </div>
                  <div className="rounded-md border border-emerald-200 bg-emerald-50 p-2 text-sm dark:border-emerald-900/50 dark:bg-emerald-950/30">
                    <p className="mb-1 text-[11px] uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                      After
                    </p>
                    <p className="whitespace-pre-wrap break-words text-foreground">
                      {f.after || <span className="italic text-muted-foreground">empty</span>}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
