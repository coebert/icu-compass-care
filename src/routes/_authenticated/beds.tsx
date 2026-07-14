import { ListSkeleton, RowSkeleton, TextSkeleton } from "@/components/LoadingSkeleton";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listBeds, saveBeds, type Bed } from "@/lib/beds.functions";
import { listPatients } from "@/lib/patients.functions";
import { getMe } from "@/lib/me.functions";
import { ConfirmDestructive } from "@/components/ui/confirm-destructive";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { BedDouble, Plus, Trash2, ArrowUp, ArrowDown, Save, RotateCcw } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/beds")({
  component: BedsAdminPage,
});

type Draft = { key: string; label: string; is_side_room: boolean };

let keySeq = 0;
const newKey = () => `bed-${keySeq++}-${Date.now()}`;

function toDraft(beds: Bed[]): Draft[] {
  return beds.map((b) => ({ key: newKey(), label: b.label, is_side_room: b.is_side_room }));
}

function BedsAdminPage() {
  const qc = useQueryClient();
  const list = useServerFn(listBeds);
  const save = useServerFn(saveBeds);
  const me = useServerFn(getMe);

  const { data: profile } = useQuery({ queryKey: ["me"], queryFn: () => me() });
  const isAdmin = profile?.isAdmin ?? false;

  const { data: beds = [], isLoading } = useQuery({
    queryKey: ["beds"],
    queryFn: () => list() as Promise<Bed[]>,
  });

  const patientsFn = useServerFn(listPatients);
  const { data: activePatients = [] } = useQuery({
    queryKey: ["patients", "active"],
    queryFn: () => patientsFn() as Promise<Array<Record<string, any>>>,
  });

  const occupancyByLabel = new Map<string, string[]>();
  for (const p of activePatients) {
    if (!p?.bed || (p.status !== "admitted" && p.status !== "referred")) continue;
    const key = String(p.bed).trim().toUpperCase();
    const list = occupancyByLabel.get(key) ?? [];
    list.push(p.display_name ?? p.name ?? "Patient");
    occupancyByLabel.set(key, list);
  }
  const occupantsFor = (label: string) => occupancyByLabel.get(label.trim().toUpperCase()) ?? [];

  const [draft, setDraft] = useState<Draft[]>([]);
  const [dirty, setDirty] = useState(false);

  // Sync the editable draft whenever the saved roster changes (and not mid-edit).
  useEffect(() => {
    if (!dirty) setDraft(toDraft(beds));
  }, [beds, dirty]);

  const saveMut = useMutation({
    mutationFn: () =>
      save({ data: { beds: draft.map((d) => ({ label: d.label.trim(), is_side_room: d.is_side_room })) } }),
    onSuccess: () => {
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["beds"] });
      toast.success("Bed board saved");
    },
    onError: (e: Error) => toast.error("Could not save", { description: e.message }),
  });

  function mutate(next: Draft[]) {
    setDraft(next);
    setDirty(true);
  }

  function update(key: string, patch: Partial<Draft>) {
    mutate(draft.map((d) => (d.key === key ? { ...d, ...patch } : d)));
  }
  function remove(key: string) {
    mutate(draft.filter((d) => d.key !== key));
  }
  function addBed() {
    mutate([...draft, { key: newKey(), label: "", is_side_room: false }]);
  }
  function move(index: number, dir: -1 | 1) {
    const next = [...draft];
    const target = index + dir;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    mutate(next);
  }
  function reset() {
    setDraft(toDraft(beds));
    setDirty(false);
  }

  const labels = draft.map((d) => d.label.trim().toUpperCase());
  const hasEmpty = draft.some((d) => !d.label.trim());
  const hasDup = labels.some((l, i) => l && labels.indexOf(l) !== i);
  const canSave = isAdmin && dirty && draft.length > 0 && !hasEmpty && !hasDup;

  if (!isAdmin) {
    return (
      <Card>
        <CardContent className="py-12 text-center text-muted-foreground">
          You do not have permission to manage the bed board.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <BedDouble className="h-6 w-6 text-primary" /> Bed board layout
          </h1>
          <p className="text-sm text-muted-foreground">
            Add, rename, reorder or remove beds. Changes apply to the whole unit.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Beds ({draft.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <>
              {draft.map((d, i) => {
                const label = d.label.trim().toUpperCase();
                const duplicate = !!label && labels.indexOf(label) !== i;
                return (
                  <div key={d.key} className="flex flex-wrap items-center gap-2 rounded-lg border p-2.5">
                    <div className="flex flex-col">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-7"
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                        aria-label="Move up"
                      >
                        <ArrowUp className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-7"
                        disabled={i === draft.length - 1}
                        onClick={() => move(i, 1)}
                        aria-label="Move down"
                      >
                        <ArrowDown className="h-4 w-4" />
                      </Button>
                    </div>
                    <div className="min-w-[8rem] flex-1">
                      <Input
                        value={d.label}
                        onChange={(e) => update(d.key, { label: e.target.value })}
                        placeholder="Bed name (e.g. 3 or SR1)"
                        aria-label={`Bed ${i + 1} name`}
                        aria-invalid={duplicate || undefined}
                        className={duplicate ? "border-destructive" : undefined}
                        maxLength={20}
                      />
                      {duplicate && <p className="mt-1 text-xs text-destructive">Duplicate name</p>}
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        id={`sr-${d.key}`}
                        checked={d.is_side_room}
                        onCheckedChange={(v) => update(d.key, { is_side_room: v })}
                      />
                      <Label htmlFor={`sr-${d.key}`} className="text-xs text-muted-foreground">
                        Side room
                      </Label>
                    </div>
                    {(() => {
                      const occupants = occupantsFor(d.label);
                      const button = (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="text-destructive"
                          aria-label="Remove bed"
                          onClick={occupants.length === 0 ? () => remove(d.key) : undefined}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      );
                      if (occupants.length === 0) return button;
                      return (
                        <ConfirmDestructive
                          title="This bed is currently occupied"
                          description={
                            <>
                              <p className="mb-2">
                                Bed <span className="font-medium">{d.label || "(unnamed)"}</span> currently has{" "}
                                {occupants.length === 1 ? "an active patient" : `${occupants.length} active patients`}:
                              </p>
                              <ul className="mb-2 list-disc pl-5 text-sm">
                                {occupants.map((n) => (
                                  <li key={n}>{n}</li>
                                ))}
                              </ul>
                              <p>
                                Removing it here will only take effect when you press <span className="font-medium">Save changes</span>. Move
                                the patient to another bed first to avoid an orphaned occupant on the board.
                              </p>
                            </>
                          }
                          confirmLabel="Remove anyway"
                          onConfirm={() => remove(d.key)}
                        >
                          {button}
                        </ConfirmDestructive>
                      );
                    })()}
                  </div>
                );
              })}

              <Button variant="outline" className="w-full gap-1.5" onClick={addBed}>
                <Plus className="h-4 w-4" /> Add bed
              </Button>

              {draft.length === 0 && (
                <p className="text-center text-sm text-muted-foreground">
                  No beds yet — add at least one.
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <div className="flex items-center gap-2">
        <Button className="gap-1.5" disabled={!canSave || saveMut.isPending} onClick={() => saveMut.mutate()}>
          <Save className="h-4 w-4" /> {saveMut.isPending ? "Saving…" : "Save changes"}
        </Button>
        <Button variant="outline" className="gap-1.5" disabled={!dirty || saveMut.isPending} onClick={reset}>
          <RotateCcw className="h-4 w-4" /> Reset
        </Button>
        {hasDup && <span className="text-xs text-destructive">Resolve duplicate names to save.</span>}
        {hasEmpty && !hasDup && <span className="text-xs text-destructive">Every bed needs a name.</span>}
      </div>
    </div>
  );
}
