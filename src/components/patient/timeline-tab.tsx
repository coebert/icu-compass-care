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
};

const KIND_STYLE: Record<TimelineEvent["kind"], string> = {
  admission: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  discharge: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  investigation: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  microbiology: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  event: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

type FilterKey = "scans" | "procedures" | "lines" | "micro" | "antibiotics";

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

export function TimelineTab({ patient, patientId }: { patient: Patient; patientId: string }) {
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
  const [activeFilters, setActiveFilters] = useState<FilterKey[]>([]);

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

  // Horizontal timeline reads left (oldest) to right (newest).
  const chronological = useMemo(
    () =>
      [...filteredEvents].sort((a, b) => {
        const ta = a.at ? new Date(a.at).getTime() : 0;
        const tb = b.at ? new Date(b.at).getTime() : 0;
        return ta - tb;
      }),
    [filteredEvents],
  );

  const [selected, setSelected] = useState<TimelineEvent | null>(null);
  const [cols, setCols] = useState(3);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const compute = () => {
      const w = window.innerWidth;
      setCols(w >= 1280 ? 6 : w >= 1024 ? 5 : w >= 768 ? 4 : w >= 640 ? 3 : 2);
    };
    compute();
    window.addEventListener("resize", compute);
    return () => window.removeEventListener("resize", compute);
  }, []);

  const rows = useMemo(() => {
    const out: TimelineEvent[][] = [];
    for (let i = 0; i < chronological.length; i += cols) {
      out.push(chronological.slice(i, i + cols));
    }
    return out;
  }, [chronological, cols]);

  const TimelineNode = ({ ev }: { ev: TimelineEvent }) => (
    <button
      type="button"
      onClick={() => setSelected(ev)}
      className="group relative z-10 flex w-full flex-col items-center gap-1.5 rounded-md p-1 text-center transition hover:bg-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span
        className={`flex h-10 w-10 items-center justify-center rounded-full ring-4 ring-background transition group-hover:scale-110 ${KIND_STYLE[ev.kind]}`}
      >
        {ev.icon}
      </span>
      <span className="line-clamp-2 text-xs font-medium leading-tight">{ev.title}</span>
      <span className="text-[10px] text-muted-foreground">
        {ev.at ? (isDate(ev.at) ? fmtDate(ev.at) : fmtDateTime(ev.at)) : "—"}
      </span>
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Activity className="h-4 w-4" />
          Key clinical events, admission, discharge and investigation snapshots — retained after discharge. Tap any item for details.
        </div>
        <Button size="sm" className="ml-auto gap-1.5" onClick={openAdd}>
          <Plus className="h-4 w-4" /> Add event
        </Button>
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

      {chronological.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {activeFilters.length > 0
              ? "No events match the selected filters."
              : "No timeline events recorded yet."}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2 py-2">
          {rows.map((row, rowIdx) => {
            const reversed = rowIdx % 2 === 1;
            const items = reversed ? [...row].reverse() : row;
            const isLastRow = rowIdx === rows.length - 1;
            return (
              <div key={rowIdx} className="relative">
                {/* Horizontal connector across this row's nodes */}
                <div
                  className="pointer-events-none absolute top-6 h-0.5 bg-border"
                  style={{
                    left: `calc(${100 / (row.length * 2)}%)`,
                    right: `calc(${100 / (row.length * 2)}%)`,
                  }}
                />
                <div
                  className="grid gap-2"
                  style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                >
                  {items.map((ev) => (
                    <TimelineNode key={ev.key} ev={ev} />
                  ))}
                </div>
                {/* Snake connector down to next row on the correct side */}
                {!isLastRow && row.length === cols && (
                  <div
                    className="pointer-events-none absolute top-6 h-[calc(100%+0.5rem)] w-0.5 bg-border"
                    style={reversed ? { left: `calc(${100 / (cols * 2)}%)` } : { right: `calc(${100 / (cols * 2)}%)` }}
                  />
                )}
              </div>
            );
          })}
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
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 text-destructive"
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </Button>
      </div>
    </div>
  );
}
