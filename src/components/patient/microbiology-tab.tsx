import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { Microbiology as DomainMicrobiology } from "@/lib/domain-types";
import {
  listMicrobiology,
  addMicrobiology,
  deleteMicrobiology,
} from "@/lib/microbiology.functions";
import { MICROBIOLOGY_SPECIMENS, fmtDate, fmtDateTime } from "@/lib/icu";
import { courseDays, type Antimicrobial } from "@/lib/antimicrobials";
import { SpecimenTypeCombobox } from "@/components/SpecimenTypeCombobox";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionUpdated } from "@/components/patient/section-updated";
import { Badge } from "@/components/ui/badge";
import { DateTimePicker } from "@/components/ui/date-picker";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Trash2, Plus, Microscope, Pill } from "lucide-react";
import { ConfirmDestructive } from "@/components/ui/confirm-destructive";
import { toast } from "sonner";

type Microbiology = DomainMicrobiology & Record<string, any>;

export function MicrobiologyTab({
  patientId,
  patient,
  focusId = null,
  focusSeq = 0,
}: {
  patientId: string;
  patient: Record<string, any>;
  focusId?: string | null;
  focusSeq?: number;
}) {
  const qc = useQueryClient();
  const list = useServerFn(listMicrobiology);
  const add = useServerFn(addMicrobiology);
  const del = useServerFn(deleteMicrobiology);
  const [open, setOpen] = useState(false);
  const [specimenType, setSpecimenType] = useState(MICROBIOLOGY_SPECIMENS[0]);
  const [findings, setFindings] = useState("");
  const [resultAt, setResultAt] = useState(() => new Date().toISOString().slice(0, 16));

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["microbiology", patientId],
    queryFn: () => list({ data: { patientId } }) as Promise<Microbiology[]>,
  });

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  useEffect(() => {
    if (!focusId) return;
    const t = setTimeout(() => {
      const el = containerRef.current?.querySelector<HTMLElement>(`[data-focus-id="${focusId}"]`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlightId(focusId);
        setTimeout(() => setHighlightId(null), 2000);
      }
    }, 50);
    return () => clearTimeout(t);
  }, [focusId, focusSeq, items.length]);

  const addMut = useMutation({
    mutationFn: () =>
      add({
        data: {
          patient_id: patientId,
          specimen_type: specimenType,
          findings,
          result_at: new Date(resultAt).toISOString(),
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["microbiology", patientId] });
      setOpen(false);
      setFindings("");
      toast.success("Microbiology result saved");
    },
    onError: (e: Error) => toast.error("Could not save", { description: e.message }),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["microbiology", patientId] });
      toast.success("Deleted");
    },
  });

  // Most recent per specimen type
  const mostRecent = useMemo(() => {
    const map = new Map<string, Microbiology>();
    for (const it of items) {
      if (!map.has(it.specimen_type)) map.set(it.specimen_type, it);
    }
    return Array.from(map.values());
  }, [items]);

  // Combined timeline: key micro results (point events) + antimicrobial
  // courses (start, and stop when ended), interleaved most-recent-first.
  const agents: Antimicrobial[] = Array.isArray(patient.antimicrobials)
    ? patient.antimicrobials
    : [];
  const timeline = useMemo(() => {
    type TL = {
      key: string;
      at: string;
      sort: number;
      kind: "result" | "abx-start" | "abx-stop";
      title: string;
      detail?: string;
    };
    const events: TL[] = [];
    for (const it of items) {
      const t = new Date(it.result_at).getTime();
      events.push({
        key: `micro-${it.id}`,
        at: it.result_at,
        sort: isNaN(t) ? 0 : t,
        kind: "result",
        title: it.specimen_type,
        detail: it.findings,
      });
    }
    agents.forEach((a, i) => {
      if (a.started_on) {
        const t = new Date(a.started_on + "T00:00:00").getTime();
        const days = courseDays(a.started_on, a.ended_on);
        events.push({
          key: `abx-start-${i}`,
          at: a.started_on,
          sort: isNaN(t) ? 0 : t,
          kind: "abx-start",
          title: `Started ${a.name ?? "antimicrobial"}`,
          detail:
            days != null
              ? `Day ${days}${a.ended_on ? "" : " (ongoing)"}`
              : undefined,
        });
      }
      if (a.ended_on) {
        const t = new Date(a.ended_on + "T00:00:00").getTime();
        const days = courseDays(a.started_on, a.ended_on);
        events.push({
          key: `abx-stop-${i}`,
          at: a.ended_on,
          sort: isNaN(t) ? 0 : t,
          kind: "abx-stop",
          title: `Stopped ${a.name ?? "antimicrobial"}`,
          detail: days != null ? `${days}-day course` : undefined,
        });
      }
    });
    return events.sort((x, y) => y.sort - x.sort);
  }, [items, agents]);

  return (
    <div ref={containerRef} className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Key microbiology results
          </h2>
          <p className="text-xs text-muted-foreground">
            Blood cultures, swabs, CSF and other significant micro findings.
          </p>
          <SectionUpdated items={items} className="mt-0.5" />
        </div>
        <Button size="sm" className="h-11 gap-1.5 sm:h-9" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> Add result
        </Button>
      </div>

      {mostRecent.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No microbiology results recorded.</CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {mostRecent.map((it) => (
            <Card key={it.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <Microscope className="h-4 w-4 text-primary" /> Latest {it.specimen_type}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                <p className="whitespace-pre-wrap text-sm">{it.findings}</p>
                <p className="text-xs text-muted-foreground">{fmtDateTime(it.result_at)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Combined timeline
          </h2>
          <p className="text-xs text-muted-foreground">
            Key micro results and antimicrobial courses, most recent first.
          </p>
        </div>
        {timeline.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No micro results or antimicrobial courses recorded yet.
            </CardContent>
          </Card>
        ) : (
          <ol className="relative space-y-4 border-l pl-6">
            {timeline.map((ev) => {
              const isResult = ev.kind === "result";
              const isStart = ev.kind === "abx-start";
              return (
                <li key={ev.key} className="relative">
                  <span
                    className={
                      "absolute -left-[27px] flex h-5 w-5 items-center justify-center rounded-full ring-4 ring-background " +
                      (isResult
                        ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                        : isStart
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : "bg-muted text-muted-foreground")
                    }
                  >
                    {isResult ? (
                      <Microscope className="h-3 w-3" />
                    ) : (
                      <Pill className="h-3 w-3" />
                    )}
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{ev.title}</span>
                    {ev.detail && !isResult && (
                      <Badge variant="secondary" className="text-xs">
                        {ev.detail}
                      </Badge>
                    )}
                    <span className="ml-auto text-xs text-muted-foreground">
                      {isResult ? fmtDateTime(ev.at) : fmtDate(ev.at)}
                    </span>
                  </div>
                  {ev.detail && isResult && (
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                      {ev.detail}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Full history
        </h2>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entries.</p>
        ) : (
          <div className="space-y-2">
            {items.map((it) => (
              <Card
                key={it.id}
                data-focus-id={it.id}
                className={
                  highlightId === it.id
                    ? "ring-2 ring-primary ring-offset-2 transition-shadow"
                    : "transition-shadow"
                }
              >
                <CardContent className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{it.specimen_type}</Badge>
                      <span className="text-xs text-muted-foreground">{fmtDateTime(it.result_at)}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{it.findings}</p>
                  </div>
                  <ConfirmDestructive
                    title="Delete this microbiology result?"
                    description={`Removes the ${it.specimen_type} result from ${fmtDateTime(it.result_at)} permanently.`}
                    onConfirm={() => delMut.mutate(it.id)}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Delete microbiology result"
                      className="shrink-0 text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </ConfirmDestructive>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add microbiology result</DialogTitle></DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addMut.mutate();
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label htmlFor="specimen-type">Specimen type</Label>
              <SpecimenTypeCombobox
                id="specimen-type"
                value={specimenType}
                onChange={setSpecimenType}
                options={MICROBIOLOGY_SPECIMENS}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Date / time of result</Label>
              <DateTimePicker value={resultAt} onChange={setResultAt} />
            </div>
            <div className="space-y-1.5">
              <Label>Findings</Label>
              <Textarea rows={4} value={findings} onChange={(e) => setFindings(e.target.value)} placeholder="Organism, sensitivities, source, action taken…" required />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={addMut.isPending}>{addMut.isPending ? "Saving…" : "Save"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
