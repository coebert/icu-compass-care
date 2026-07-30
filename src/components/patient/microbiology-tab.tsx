import { ListSkeleton, RowSkeleton, TextSkeleton } from "@/components/LoadingSkeleton";
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
import { Trash2, Plus, Microscope, Pill, Link2 } from "lucide-react";
import { ConfirmDestructive } from "@/components/ui/confirm-destructive";
import { toast } from "sonner";

type Microbiology = DomainMicrobiology & Record<string, any>;

type CrossLink = { key: string; label: string; reason: string; score: number };

/** Shows how many entries in the other lane relate to this one, and why. */
function LinkSummary({
  links,
  expanded,
  align,
}: {
  links: CrossLink[];
  expanded: boolean;
  align: "left" | "right";
}) {
  if (links.length === 0) return null;
  return (
    <div className={`mt-1.5 ${align === "right" ? "text-right" : "text-left"}`}>
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
        <Link2 className="h-3 w-3" />
        {links.length} linked
      </span>
      {expanded && (
        <ul className="mt-1 space-y-0.5 text-[11px] text-muted-foreground">
          {links.map((l, i) => (
            <li key={l.key}>
              {i === 0 && <span className="font-medium text-primary">Closest match: </span>}
              {l.label} — {l.reason}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


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
      /** Antimicrobial name (abx rows) used for cross-lane matching. */
      agent?: string;
      /** Raw findings text (result rows) used for cross-lane matching. */
      text?: string;
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
        text: `${it.specimen_type} ${it.findings ?? ""}`,
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
          agent: a.name ?? undefined,
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
          agent: a.name ?? undefined,
          detail: days != null ? `${days}-day course` : undefined,
        });
      }
    });
    return events.sort((x, y) => y.sort - x.sort);
  }, [items, agents]);

  // Group events into shared time rows so the two lanes line up on one
  // timescale (one row per calendar day, newest first).
  const rows = useMemo(() => {
    const byDay = new Map<
      string,
      { day: string; sort: number; abx: typeof timeline; micro: typeof timeline }
    >();
    for (const ev of timeline) {
      const d = new Date(ev.sort);
      const day = isNaN(d.getTime()) ? ev.at : d.toISOString().slice(0, 10);
      let row = byDay.get(day);
      if (!row) {
        row = { day, sort: new Date(day + "T00:00:00").getTime(), abx: [], micro: [] };
        byDay.set(day, row);
      }
      if (ev.kind === "result") row.micro.push(ev);
      else row.abx.push(ev);
    }
    return Array.from(byDay.values()).sort((a, b) => b.sort - a.sort);
  }, [timeline]);

  // Cross-lane links: an antimicrobial change is related to a micro result when
  // the result text names the agent, or when the two happened within 48 hours.
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const links = useMemo(() => {
    const map = new Map<string, CrossLink[]>();
    const abx = timeline.filter((e) => e.kind !== "result");
    const micro = timeline.filter((e) => e.kind === "result");
    const push = (
      a: (typeof timeline)[number],
      b: (typeof timeline)[number],
      reason: string,
      score: number,
    ) => {
      const list = map.get(a.key) ?? [];
      list.push({ key: b.key, label: b.title, reason, score });
      map.set(a.key, list);
    };
    for (const a of abx) {
      const name = (a.agent ?? "").trim().toLowerCase();
      for (const m of micro) {
        const text = (m.text ?? "").toLowerCase();
        const named = name.length >= 4 && text.includes(name);
        const hours = Math.abs(a.sort - m.sort) / 3_600_000;
        const close = hours <= 48;
        if (!named && !close) continue;
        const reason = named
          ? `Result mentions ${a.agent}`
          : `Within ${Math.round(hours)}h`;
        // Named matches always beat time-only ones; within each kind, closer in
        // time scores higher.
        const score = (named ? 1000 : 0) + Math.max(0, 48 - Math.min(hours, 48));
        push(a, m, reason, score);
        push(m, a, reason, score);
      }
    }
    // Best match first, so the top of each list is the closest relation.
    for (const list of map.values()) list.sort((x, y) => y.score - x.score);
    return map;
  }, [timeline]);

  const activeLinks = activeKey ? (links.get(activeKey) ?? []) : [];
  const bestKey = activeLinks[0]?.key ?? null;

  const linkedKeys = useMemo(() => {
    if (!activeKey) return null;
    return new Set([activeKey, ...(links.get(activeKey) ?? []).map((l) => l.key)]);
  }, [activeKey, links]);

  const linkClass = (key: string) => {
    if (!linkedKeys) return "";
    if (key === activeKey) return " ring-2 ring-primary ring-offset-1";
    if (key === bestKey)
      return " ring-2 ring-primary ring-offset-2 shadow-md scale-[1.01]";
    if (linkedKeys.has(key)) return " ring-2 ring-primary/40 ring-offset-1";
    return " opacity-40";
  };

  const ClosestBadge = ({ show }: { show: boolean }) =>
    show ? (
      <span className="mt-1 inline-flex items-center gap-1 rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-foreground">
        <Link2 className="h-3 w-3" /> Closest match
      </span>
    ) : null;


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
            Parallel timelines
          </h2>
          <p className="text-xs text-muted-foreground">
            Antimicrobials and microbiology results on one shared timescale, newest first — read
            across a row to cross-reference. Select an entry to highlight the antimicrobial changes
            and results that relate to it.
          </p>
        </div>
        {rows.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No micro results or antimicrobial courses recorded yet.
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardContent className="p-3 sm:p-4">
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-x-3 pb-2 sm:gap-x-4">
                <div className="flex items-center justify-end gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
                  <Pill className="h-3.5 w-3.5" /> Antimicrobials
                </div>
                <div className="w-16 text-center text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:w-24">
                  Date
                </div>
                <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-violet-700 dark:text-violet-300">
                  <Microscope className="h-3.5 w-3.5" /> Micro results
                </div>
              </div>

              <ol className="space-y-4">
                {rows.map((row) => (
                  <li
                    key={row.day}
                    className="grid grid-cols-[1fr_auto_1fr] items-stretch gap-x-3 sm:gap-x-4"
                  >
                    {/* Antimicrobial lane */}
                    <div className="flex flex-col items-end gap-2">
                      {row.abx.length === 0 ? (
                        <span className="text-xs text-muted-foreground/50">—</span>
                      ) : (
                        row.abx.map((ev) => (
                          <button
                            type="button"
                            key={ev.key}
                            onClick={() => setActiveKey((k) => (k === ev.key ? null : ev.key))}
                            aria-pressed={activeKey === ev.key}
                            className={
                              "w-full max-w-sm rounded-md border p-2 text-right transition " +
                              (ev.kind === "abx-start"
                                ? "border-emerald-200 bg-emerald-50/60 dark:border-emerald-900 dark:bg-emerald-950/40"
                                : "bg-muted/40") +
                              linkClass(ev.key)
                            }
                          >
                            <p className="text-sm font-medium">{ev.title}</p>
                            {ev.detail && (
                              <Badge variant="secondary" className="mt-1 text-xs">
                                {ev.detail}
                              </Badge>
                            )}
                            <ClosestBadge show={ev.key === bestKey} />
                            <LinkSummary
                              links={links.get(ev.key) ?? []}
                              expanded={activeKey === ev.key}
                              align="right"
                            />

                          </button>
                        ))
                      )}
                    </div>

                    {/* Shared time axis */}
                    <div className="relative flex w-16 flex-col items-center sm:w-24">
                      <span
                        aria-hidden
                        className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border"
                      />
                      <span className="relative mt-1 h-2.5 w-2.5 rounded-full bg-primary ring-4 ring-background" />
                      <span className="relative mt-1 text-center text-[11px] font-medium text-muted-foreground">
                        {fmtDate(row.day)}
                      </span>
                    </div>

                    {/* Microbiology lane */}
                    <div className="flex flex-col items-start gap-2">
                      {row.micro.length === 0 ? (
                        <span className="text-xs text-muted-foreground/50">—</span>
                      ) : (
                        row.micro.map((ev) => (
                          <button
                            type="button"
                            key={ev.key}
                            onClick={() => setActiveKey((k) => (k === ev.key ? null : ev.key))}
                            aria-pressed={activeKey === ev.key}
                            className={
                              "w-full max-w-sm rounded-md border border-violet-200 bg-violet-50/60 p-2 text-left transition dark:border-violet-900 dark:bg-violet-950/40" +
                              linkClass(ev.key)
                            }
                          >
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{ev.title}</span>
                              <span className="ml-auto text-[11px] text-muted-foreground">
                                {fmtDateTime(ev.at)}
                              </span>
                            </div>
                            {ev.detail && (
                              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                                {ev.detail}
                              </p>
                            )}
                            <ClosestBadge show={ev.key === bestKey} />
                            <LinkSummary
                              links={links.get(ev.key) ?? []}
                              expanded={activeKey === ev.key}
                              align="left"
                            />

                          </button>
                        ))
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            </CardContent>
          </Card>
        )}
      </div>


      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Full history
        </h2>
        {isLoading ? (
          <ListSkeleton rows={3} />
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
