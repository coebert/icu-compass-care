import { ListSkeleton, RowSkeleton, TextSkeleton } from "@/components/LoadingSkeleton";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  listPatientSharing,
  setPatientsShared,
  type PatientSharingRow,
} from "@/lib/sharing.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowLeft, Search, Share2, ShieldOff } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/patients/sharing")({
  component: SharingManager,
});

function locationLabel(p: PatientSharingRow): string {
  const bed = p.bed ? ` · Bed ${p.bed}` : "";
  if (p.location_type === "icu") return `ICU${bed}`;
  if (p.ward) return `${p.ward}${bed}`;
  if (p.bed) return `Bed ${p.bed}`;
  return "No location";
}

function SharingManager() {
  const qc = useQueryClient();
  const list = useServerFn(listPatientSharing);
  const setShared = useServerFn(setPatientsShared);

  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: patients = [], isLoading, error } = useQuery({
    queryKey: ["patient-sharing"],
    queryFn: () => list() as Promise<PatientSharingRow[]>,
    retry: false,
  });

  const shareMut = useMutation({
    mutationFn: (v: { ids: string[]; shared: boolean }) => setShared({ data: v }),
    onSuccess: (_res, v) => {
      qc.invalidateQueries({ queryKey: ["patient-sharing"] });
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["patient"] });
      setSelected(new Set());
      toast.success(
        v.shared
          ? `Shared ${v.ids.length} patient${v.ids.length === 1 ? "" : "s"} with the partner app`
          : `Stopped sharing ${v.ids.length} patient${v.ids.length === 1 ? "" : "s"}`,
      );
    },
    onError: (e: Error) => toast.error("Could not update sharing", { description: e.message }),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return patients;
    return patients.filter(
      (p) =>
        p.full_name?.toLowerCase().includes(q) ||
        p.hospital_number?.toLowerCase().includes(q) ||
        p.ward?.toLowerCase().includes(q),
    );
  }, [patients, search]);

  const sharedCount = patients.filter((p) => p.shared_with_partner).length;
  const allVisibleSelected = filtered.length > 0 && filtered.every((p) => selected.has(p.id));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) filtered.forEach((p) => next.delete(p.id));
      else filtered.forEach((p) => next.add(p.id));
      return next;
    });
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          You do not have permission to manage patient sharing.
        </CardContent>
      </Card>
    );
  }

  const selectedIds = Array.from(selected);

  return (
    <div className="space-y-4">
      <Button asChild variant="outline" size="sm" className="gap-1.5">
        <Link to="/admin">
          <ArrowLeft className="h-4 w-4" /> Back to admin
        </Link>
      </Button>

      <div className="min-w-0">
        <h1 className="text-2xl font-bold">Partner sharing</h1>
        <p className="text-sm text-muted-foreground">
          Choose which patient records are shared with the linked partner app. Only shared
          patients — and their investigations and microbiology — are visible across the bridge.
          {" "}
          <span className="font-medium text-foreground">{sharedCount}</span> currently shared.
        </p>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, hospital number or ward"
          className="pl-9"
        />
      </div>

      {selectedIds.length > 0 && (
        <div className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3 shadow-sm">
          <span className="text-sm font-medium">{selectedIds.length} selected</span>
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              className="gap-1.5"
              disabled={shareMut.isPending}
              onClick={() => shareMut.mutate({ ids: selectedIds, shared: true })}
            >
              <Share2 className="h-4 w-4" /> Share
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={shareMut.isPending}
              onClick={() => shareMut.mutate({ ids: selectedIds, shared: false })}
            >
              <ShieldOff className="h-4 w-4" /> Stop sharing
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <ListSkeleton rows={4} />
      ) : filtered.length === 0 ? (

        <p className="text-sm text-muted-foreground">No patients found.</p>
      ) : (
        <div className="space-y-2">
          <label className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
            <Checkbox checked={allVisibleSelected} onCheckedChange={toggleAllVisible} />
            Select all {search ? "matching" : ""}
          </label>
          <div className="grid gap-2">
            {filtered.map((p) => (
              <Card key={p.id}>
                <CardContent className="flex flex-wrap items-center gap-3 p-3">
                  <Checkbox
                    checked={selected.has(p.id)}
                    onCheckedChange={() => toggle(p.id)}
                    aria-label={`Select ${p.full_name}`}
                  />
                  <div className="min-w-0">
                    <p className="truncate font-medium">{p.full_name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {p.hospital_number ? `${p.hospital_number} · ` : ""}
                      {locationLabel(p)}
                    </p>
                  </div>
                  {p.shared_with_partner ? (
                    <Badge className="ml-auto gap-1">
                      <Share2 className="h-3 w-3" /> Shared
                    </Badge>
                  ) : (
                    <Badge variant="secondary" className="ml-auto">
                      Not shared
                    </Badge>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
