import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type {
  Patient as DomainPatient,
  Investigation as DomainInvestigation,
  Microbiology as DomainMicrobiology,
  PatientEvent as DomainPatientEvent,
} from "@/lib/domain-types";
import { getPatientStatusChanges } from "@/lib/patients.functions";
import { listInvestigations } from "@/lib/investigations.functions";
import { listMicrobiology } from "@/lib/microbiology.functions";
import {
  listPatientEvents,
  addPatientEvent,
  updatePatientEvent,
  deletePatientEvent,
  PATIENT_EVENT_TYPES,
} from "@/lib/patient-events.functions";
import { STATUS_LABELS, fmtDate, fmtDateTime } from "@/lib/icu";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { DateTimePicker } from "@/components/ui/date-picker";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Trash2,
  Plus,
  AlertTriangle,
  FlaskConical,
  Microscope,
  LogIn,
  LogOut,
  Clock,
  Activity,
  Stethoscope,
  UserRound,
  Scan,
  Scissors,
  GitBranch,
  Pill,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { ConfirmDestructive } from "@/components/ui/confirm-destructive";

type Patient = DomainPatient & Record<string, any>;
type Investigation = DomainInvestigation & Record<string, any>;
type Microbiology = DomainMicrobiology & Record<string, any>;
type PatientEvent = DomainPatientEvent & Record<string, any>;

type TimelineEvent = {
  key: string;
  at: string | null;
  icon: React.ReactNode;
  title: string;
  detail?: string | null;
  kind: "admission" | "discharge" | "investigation" | "microbiology" | "event";
  eventId?: string;
  eventType?: string;
  changedBy?: string | null;
  sourceId?: string;
};

const KIND_STYLE: Record<TimelineEvent["kind"], string> = {
  admission: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  discharge: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  investigation: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  microbiology: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  event: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

export type FilterKey = "scans" | "procedures" | "lines" | "micro" | "antibiotics";
export const TIMELINE_FILTER_KEYS: FilterKey[] = ["scans", "procedures", "lines", "micro", "antibiotics"];

const FILTERS: { key: FilterKey; label: string; icon: React.ReactNode }[] = [
  { key: "scans", label: "Scans", icon: <Scan className="h-3.5 w-3.5" /> },
  { key: "procedures", label: "Procedures", icon: <Scissors className="h-3.5 w-3.5" /> },
  { key: "lines", label: "Lines", icon: <GitBranch className="h-3.5 w-3.5" /> },
  { key: "micro", label: "Micro", icon: <Microscope className="h-3.5 w-3.5" /> },
  { key: "antibiotics", label: "Antibiotics", icon: <Pill className="h-3.5 w-3.5" /> },
];

const SCAN_KEYWORDS = ["ct", "cxr", "x-ray", "xray", "ultrasound", "echo", "echocardiogram", "mri", "pet", "angiogram", "fluoroscopy", "dexa", "scan"];
const ANTIBIOTIC_KEYWORDS = [
  "antibiotic",
  "antimicrobial",
  "antibacterial",
  "penicillin",
  "cephalosporin",
  "meropenem",
  "vancomycin",
  "gentamicin",
  "amoxicillin",
  "azithromycin",
  "ciprofloxacin",
  "metronidazole",
  "flucloxacillin",
  "co-amoxiclav",
  "augmentin",
  "tazocin",
  "piptazobactam",
];

function matchesFilter(ev: TimelineEvent, filter: FilterKey): boolean {
  const text = `${ev.title ?? ""} ${ev.detail ?? ""}`.toLowerCase();
  switch (filter) {
    case "scans":
      return ev.kind === "investigation" && SCAN_KEYWORDS.some((k) => text.includes(k));
    case "procedures":
      return ev.kind === "event" && (ev.eventType === "Surgical procedure" || ev.eventType === "Tracheostomy");
    case "lines":
      return ev.kind === "event" && ev.eventType === "Line insertion";
    case "micro":
      return ev.kind === "microbiology";
    case "antibiotics":
      return (ev.kind === "event" && ev.eventType === "Antibiotics") || ANTIBIOTIC_KEYWORDS.some((k) => text.includes(k));
    default:
      return false;
  }
}

export function TimelineTab({
  patient,
  patientId,
  onNavigate,
  filters,
  onFiltersChange,
}: {
  patient: Patient;
  patientId: string;
  onNavigate?: (tab: "investigations" | "microbiology", id: string) => void;
  filters?: FilterKey[];
  onFiltersChange?: (next: FilterKey[]) => void;
}) {
  const qc = useQueryClient();
  const listInv = useServerFn(listInvestigations);
  const listMicro = useServerFn(listMicrobiology);
  const listEvents = useServerFn(listPatientEvents);
  const addEvent = useServerFn(addPatientEvent);
  const editEvent = useServerFn(updatePatientEvent);
  const removeEvent = useServerFn(deletePatientEvent);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [type, setType] = useState<string>(PATIENT_EVENT_TYPES[0]);
  const [description, setDescription] = useState("");
  const [eventAt, setEventAt] = useState<string>("");
  const [uncontrolledFilters, setUncontrolledFilters] = useState<FilterKey[]>([]);
  const activeFilters = filters ?? uncontrolledFilters;
  const setActiveFilters = (next: FilterKey[] | ((prev: FilterKey[]) => FilterKey[])) => {
    const resolved = typeof next === "function" ? next(activeFilters) : next;
    if (onFiltersChange) onFiltersChange(resolved);
    else setUncontrolledFilters(resolved);
  };


  const { data: investigations = [] } = useQuery({
    queryKey: ["investigations", patientId],
    queryFn: () => listInv({ data: { patientId } }) as Promise<Investigation[]>,
  });
  const { data: micro = [] } = useQuery({
    queryKey: ["microbiology", patientId],
    queryFn: () => listMicro({ data: { patientId } }) as Promise<Microbiology[]>,
  });
  const { data: keyEvents = [] } = useQuery({
    queryKey: ["patient-events", patientId],
    queryFn: () => listEvents({ data: { patientId } }) as Promise<PatientEvent[]>,
  });
  const listStatusChanges = useServerFn(getPatientStatusChanges);
  const { data: statusChanges = [] } = useQuery({
    queryKey: ["patient-status-changes", patientId],
    queryFn: () => listStatusChanges({ data: { id: patientId } }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["patient-events", patientId] });

  const openAdd = () => {
    setEditId(null);
    setType(PATIENT_EVENT_TYPES[0]);
    setDescription("");
    setEventAt(new Date().toISOString());
    setDialogOpen(true);
  };


  const saveMut = useMutation({
    mutationFn: () =>
      editId
        ? editEvent({ data: { id: editId, event_type: type, description, event_at: eventAt } as never })
        : addEvent({ data: { patient_id: patientId, event_type: type, description, event_at: eventAt } as never }),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      toast.success(editId ? "Event updated" : "Event added");
    },
    onError: (e: Error) => toast.error("Could not save event", { description: e.message }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => removeEvent({ data: { id } }),
    onSuccess: () => {
      invalidate();
      toast.success("Event removed");
    },
    onError: (e: Error) => toast.error("Could not remove event", { description: e.message }),
  });

  const [selected, setSelected] = useState<TimelineEvent | null>(null);

  const [quickAt, setQuickAt] = useState<string>(() => new Date().toISOString());

  const quickAddMut = useMutation({
    mutationFn: async (at: string) =>
      (await addEvent({
        data: { patient_id: patientId, event_type: "Other", description: "", event_at: at } as never,
      })) as PatientEvent,
    onSuccess: async (row) => {
      await qc.invalidateQueries({ queryKey: ["patient-events", patientId] });
      toast.success("Event added — edit inline");
      // Open the details editor for the newly created event.
      setSelected({
        key: `event-${row.id}`,
        at: row.event_at,
        icon: <Stethoscope className="h-4 w-4" />,
        title: row.event_type,
        detail: row.description,
        kind: "event",
        eventId: row.id,
        eventType: row.event_type,
      });
    },
    onError: (e: Error) => toast.error("Could not add event", { description: e.message }),
  });

  const events = useMemo<TimelineEvent[]>(() => {
    const evs: TimelineEvent[] = [];

    const admissionAt = patient.admission_date ?? patient.created_at;
    if (admissionAt) {
      evs.push({
        key: "admission",
        at: admissionAt,
        icon: <LogIn className="h-4 w-4" />,
        title: "Admitted to critical care",
        detail: patient.ward
          ? `${patient.ward}${patient.bed ? ` · Bed ${patient.bed}` : ""}`
          : patient.admission_date
            ? null
            : "Admission date not recorded — using record creation date",
        kind: "admission",
      });
    }

    if (patient.status === "discharged" && (patient.discharge_date || patient.discharge_destination)) {
      evs.push({
        key: "discharge",
        at: patient.discharge_date ?? null,
        icon: <LogOut className="h-4 w-4" />,
        title: "Discharged",
        detail: patient.discharge_destination || null,
        kind: "discharge",
      });
    }

    if (patient.status === "died" && patient.date_of_death) {
      evs.push({
        key: "death",
        at: patient.date_of_death,
        icon: <AlertTriangle className="h-4 w-4" />,
        title: "Died",
        detail: null,
        kind: "discharge",
      });
    }

    for (const ev of keyEvents) {
      evs.push({
        key: `event-${ev.id}`,
        at: ev.event_at,
        icon: <Stethoscope className="h-4 w-4" />,
        title: ev.event_type,
        detail: ev.description,
        kind: "event",
        eventId: ev.id,
        eventType: ev.event_type,
      });
    }

    for (const it of investigations) {
      evs.push({
        key: `inv-${it.id}`,
        at: it.result_at,
        icon: <FlaskConical className="h-4 w-4" />,
        title: it.category,
        detail: it.findings,
        kind: "investigation",
        sourceId: it.id,
      });
    }

    for (const m of micro) {
      evs.push({
        key: `micro-${m.id}`,
        at: m.result_at,
        icon: <Microscope className="h-4 w-4" />,
        title: m.specimen_type,
        detail: m.findings,
        kind: "microbiology",
        sourceId: m.id,
      });
    }

    for (const sc of statusChanges) {
      const toStatus = sc.to as keyof typeof STATUS_LABELS | null;
      const label = toStatus && STATUS_LABELS[toStatus] ? STATUS_LABELS[toStatus] : sc.to ?? "Unknown";
      evs.push({
        key: `status-${sc.id}`,
        at: sc.at,
        icon: <UserRound className="h-4 w-4" />,
        title: `Status changed to ${label}`,
        detail: null,
        kind:
          toStatus === "discharged" || toStatus === "died"
            ? "discharge"
            : toStatus === "admitted"
              ? "admission"
              : "event",
        changedBy: sc.changedBy,
      });
    }

    return evs.sort((a, b) => {
      const ta = a.at ? new Date(a.at).getTime() : 0;
      const tb = b.at ? new Date(b.at).getTime() : 0;
      return tb - ta;
    });
  }, [patient, investigations, micro, keyEvents, statusChanges]);

  const isDate = (v: string | null) => !!v && v.length <= 10;

  const filteredEvents = useMemo(() => {
    if (activeFilters.length === 0) return events;
    return events.filter((ev) => activeFilters.some((f) => matchesFilter(ev, f)));
  }, [events, activeFilters]);

  // Trunk-and-branch timeline reads top (newest) to bottom (oldest).
  const ordered = filteredEvents;

  const TimelineBranch = ({ ev, side }: { ev: TimelineEvent; side: "left" | "right" }) => {
    const clickable =
      (onNavigate && ev.sourceId && (ev.kind === "investigation" || ev.kind === "microbiology")) ||
      (ev.kind === "event" && !!ev.eventId);
    const open = () => {
      if (onNavigate && ev.sourceId && (ev.kind === "investigation" || ev.kind === "microbiology")) {
        onNavigate(ev.kind === "investigation" ? "investigations" : "microbiology", ev.sourceId);
        return;
      }
      if (ev.kind === "event" && ev.eventId) setSelected(ev);
    };
    return (
      <li className="relative md:grid md:grid-cols-[1fr_auto_1fr] md:items-start md:gap-0">
        {/* node on the trunk */}
        <div className="absolute left-4 top-3 z-10 -translate-x-1/2 md:static md:col-start-2 md:row-start-1 md:translate-x-0 md:flex md:justify-center">

          <span
            className={`flex h-9 w-9 items-center justify-center rounded-full ring-4 ring-background ${KIND_STYLE[ev.kind]}`}
          >
            {ev.icon}
          </span>
        </div>
        <div
          className={`ml-10 md:ml-0 ${side === "left" ? "md:col-start-1 md:row-start-1 md:pr-8 md:text-right" : "md:col-start-3 md:row-start-1 md:pl-8"}`}
        >
          {/* branch stub connecting card to trunk */}
          <span
            aria-hidden
            className={`pointer-events-none absolute top-[1.9rem] hidden h-0.5 w-8 bg-border md:block ${
              side === "left" ? "left-[calc(50%-3.125rem)]" : "right-[calc(50%-3.125rem)]"
            }`}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute left-4 top-[1.9rem] h-0.5 w-6 bg-border md:hidden"
          />
          <div
            role={clickable ? "button" : undefined}
            tabIndex={clickable ? 0 : undefined}
            onClick={clickable ? open : undefined}
            onKeyDown={
              clickable
                ? (e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      open();
                    }
                  }
                : undefined
            }
            className={`rounded-lg border bg-card p-3 shadow-sm transition ${
              clickable ? "cursor-pointer hover:border-primary/50 hover:bg-accent/40" : ""
            }`}
          >
            <div
              className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 ${side === "left" ? "md:justify-end" : ""}`}
            >
              <span className="text-sm font-semibold leading-tight">{ev.title}</span>
              <span className="text-xs text-muted-foreground">
                {ev.at ? (isDate(ev.at) ? fmtDate(ev.at) : fmtDateTime(ev.at)) : "Date not recorded"}
              </span>
            </div>
            {ev.detail?.trim() ? (
              <p className="mt-1.5 whitespace-pre-wrap text-sm text-foreground/90">{ev.detail}</p>
            ) : (
              <p className="mt-1.5 text-sm italic text-muted-foreground">No further details recorded</p>
            )}
            {ev.changedBy && (
              <p
                className={`mt-1.5 flex items-center gap-1 text-xs text-muted-foreground ${side === "left" ? "md:justify-end" : ""}`}
              >
                <UserRound className="h-3 w-3" /> Changed by {ev.changedBy}
              </p>
            )}
          </div>
        </div>
      </li>
    );
  };


  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Activity className="h-4 w-4" />
          Key clinical events, admission, discharge and investigation snapshots — retained after discharge. Full details are shown on each branch; tap an event to edit.
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5 rounded-md border bg-muted/30 p-1 pl-2">
            <span className="text-xs text-muted-foreground whitespace-nowrap">Quick add at</span>
            <div className="w-[210px]">
              <DateTimePicker value={quickAt} onChange={(v) => setQuickAt(v ?? "")} />
            </div>
            <Button
              size="sm"
              variant="secondary"
              className="gap-1.5"
              disabled={!quickAt || quickAddMut.isPending}
              onClick={() => quickAddMut.mutate(quickAt)}
              title="Create event at this time and open the inline editor"
            >
              <Plus className="h-4 w-4" />
              {quickAddMut.isPending ? "Adding…" : "Quick add"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={() => setQuickAt(new Date().toISOString())}
              title="Reset to now"
            >
              Now
            </Button>
          </div>
          <Button size="sm" className="gap-1.5" onClick={openAdd}>
            <Plus className="h-4 w-4" /> Add event
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => {
          const active = activeFilters.includes(f.key);
          return (
            <button
              key={f.key}
              type="button"
              onClick={() =>
                setActiveFilters((prev) =>
                  prev.includes(f.key) ? prev.filter((k) => k !== f.key) : [...prev, f.key],
                )
              }
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition ${
                active
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border bg-background text-foreground hover:bg-accent"
              }`}
            >
              {f.icon}
              {f.label}
            </button>
          );
        })}
        {activeFilters.length > 0 && (
          <button
            type="button"
            onClick={() => setActiveFilters([])}
            className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        )}
      </div>

      {ordered.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {activeFilters.length > 0
              ? "No events match the selected filters."
              : "No timeline events recorded yet."}
          </CardContent>
        </Card>
      ) : (
        <div className="relative py-2">
          {/* trunk */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-2 left-4 w-0.5 bg-border md:left-1/2 md:-translate-x-1/2"
          />
          <ol className="relative space-y-4">
            {ordered.map((ev, i) => (
              <TimelineBranch key={ev.key} ev={ev} side={i % 2 === 0 ? "right" : "left"} />
            ))}
          </ol>
        </div>
      )}


      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {selected && (
                <span
                  className={`flex h-7 w-7 items-center justify-center rounded-full ${KIND_STYLE[selected.kind]}`}
                >
                  {selected.icon}
                </span>
              )}
              {selected?.kind === "event" && selected.eventId ? "Event details" : selected?.title}
            </DialogTitle>
          </DialogHeader>
          {selected && selected.kind === "event" && selected.eventId ? (
            <EventEditor
              key={selected.eventId}
              event={keyEvents.find((k) => k.id === selected.eventId) as PatientEvent | undefined}
              editEvent={editEvent}
              onSaved={() => qc.invalidateQueries({ queryKey: ["patient-events", patientId] })}
              onRemove={() => {
                deleteMut.mutate(selected.eventId as string);
                setSelected(null);
              }}
            />
          ) : selected ? (
            <div className="space-y-3 text-sm">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Clock className="h-3.5 w-3.5" />
                {selected.at
                  ? isDate(selected.at)
                    ? fmtDate(selected.at)
                    : fmtDateTime(selected.at)
                  : "Date not recorded"}
              </div>
              {selected.detail?.trim() && (
                <p className="whitespace-pre-wrap text-foreground">{selected.detail}</p>
              )}
              {selected.changedBy && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <UserRound className="h-3 w-3" /> Changed by {selected.changedBy}
                </p>
              )}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>



      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit event" : "Add key event"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Event type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PATIENT_EVENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Date &amp; time</Label>
              <DateTimePicker value={eventAt} onChange={(v) => setEventAt(v ?? "")} />
            </div>
            <div className="space-y-1.5">
              <Label>Details (optional)</Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="e.g. Emergency laparotomy for perforated viscus"
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending || !eventAt}>
                {saveMut.isPending ? "Saving…" : editId ? "Save changes" : "Add event"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EventEditor({
  event,
  editEvent,
  onSaved,
  onRemove,
}: {
  event: PatientEvent | undefined;
  editEvent: (args: { data: any }) => Promise<any>;
  onSaved: () => void;
  onRemove: () => void;
}) {
  const [type, setType] = useState<string>(event?.event_type ?? PATIENT_EVENT_TYPES[0]);
  const [eventAt, setEventAt] = useState<string>(event?.event_at ?? "");
  const [description, setDescription] = useState<string>(event?.description ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const validate = (): string | null => {
    if (!type) return "Event type is required";
    if (!eventAt) return "Date & time is required";
    const t = new Date(eventAt).getTime();
    if (Number.isNaN(t)) return "Invalid date";
    if (t > Date.now() + 60_000) return "Date cannot be in the future";
    if (description.length > 2000) return "Notes must be under 2000 characters";
    return null;
  };

  const validationError = validate();

  useEffect(() => {
    if (!dirty.current || !event) return;
    if (validationError) {
      setStatus("error");
      setErrorMsg(validationError);
      return;
    }
    if (
      type === event.event_type &&
      eventAt === (event.event_at ?? "") &&
      description === (event.description ?? "")
    ) {
      return;
    }
    setStatus("saving");
    setErrorMsg(null);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      try {
        await editEvent({ data: { id: event.id, event_type: type, description, event_at: eventAt } });
        setStatus("saved");
        onSaved();
      } catch (e) {
        setStatus("error");
        setErrorMsg(e instanceof Error ? e.message : "Save failed");
      }
    }, 700);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, eventAt, description]);

  const markDirty = () => {
    dirty.current = true;
  };

  return (
    <div className="space-y-4 text-sm">
      <div className="space-y-1.5">
        <Label>Event type</Label>
        <Select
          value={type}
          onValueChange={(v) => {
            markDirty();
            setType(v);
          }}
        >
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {PATIENT_EVENT_TYPES.map((t) => (
              <SelectItem key={t} value={t}>{t}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>Date &amp; time</Label>
        <DateTimePicker
          value={eventAt}
          onChange={(v) => {
            markDirty();
            setEventAt(v ?? "");
          }}
        />
      </div>
      <div className="space-y-1.5">
        <Label>Notes</Label>
        <Textarea
          value={description}
          onChange={(e) => {
            markDirty();
            setDescription(e.target.value);
          }}
          rows={3}
          placeholder="Add notes"
        />
        <div className="text-[10px] text-muted-foreground text-right">{description.length}/2000</div>
      </div>
      <div className="flex items-center justify-between gap-2 pt-1">
        <div className="text-xs">
          {status === "saving" && <span className="text-muted-foreground">Saving…</span>}
          {status === "saved" && <span className="text-emerald-600 dark:text-emerald-400">Saved</span>}
          {status === "error" && <span className="text-destructive">{errorMsg ?? "Save failed"}</span>}
          {status === "idle" && !validationError && (
            <span className="text-muted-foreground">Changes save automatically</span>
          )}
          {status === "idle" && validationError && (
            <span className="text-destructive">{validationError}</span>
          )}
        </div>
        <ConfirmDestructive
          title="Delete this timeline event?"
          description="Permanently removes this event from the patient timeline. This cannot be undone."
          onConfirm={onRemove}
        >
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" /> Remove
          </Button>
        </ConfirmDestructive>
      </div>
    </div>
  );
}
