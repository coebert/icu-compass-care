import { useMemo, useState } from "react";
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
  Pencil,
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

  const openEdit = (ev: PatientEvent) => {
    setEditId(ev.id);
    setType(ev.event_type);
    setDescription(ev.description ?? "");
    setEventAt(ev.event_at ?? new Date().toISOString());
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

  // Horizontal timeline reads left (oldest) to right (newest).
  const chronological = useMemo(
    () =>
      [...events].sort((a, b) => {
        const ta = a.at ? new Date(a.at).getTime() : 0;
        const tb = b.at ? new Date(b.at).getTime() : 0;
        return ta - tb;
      }),
    [events],
  );

  const EventCard = ({ ev }: { ev: TimelineEvent }) => (
    <Card className="w-full">
      <CardContent className="space-y-1 p-3">
        <div className="flex items-start gap-2">
          <span
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${KIND_STYLE[ev.kind]}`}
          >
            {ev.icon}
          </span>
          <span className="text-sm font-medium leading-tight">{ev.title}</span>
        </div>
        <span className="flex items-center gap-1 text-xs text-muted-foreground">
          <Clock className="h-3 w-3" />
          {ev.at ? (isDate(ev.at) ? fmtDate(ev.at) : fmtDateTime(ev.at)) : "Date not recorded"}
        </span>
        {ev.detail?.trim() && (
          <p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">{ev.detail}</p>
        )}
        {ev.changedBy && (
          <p className="flex items-center gap-1 text-xs text-muted-foreground">
            <UserRound className="h-3 w-3" />
            Changed by {ev.changedBy}
          </p>
        )}
        {ev.kind === "event" && ev.eventId && (
          <div className="flex gap-1 pt-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => openEdit(keyEvents.find((k) => k.id === ev.eventId) as PatientEvent)}
            >
              <Pencil className="h-3 w-3" /> Edit
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-xs text-destructive"
              onClick={() => deleteMut.mutate(ev.eventId as string)}
            >
              <Trash2 className="h-3 w-3" /> Remove
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Activity className="h-4 w-4" />
          Key clinical events, admission, discharge and investigation snapshots — retained after discharge.
        </div>
        <Button size="sm" className="ml-auto gap-1.5" onClick={openAdd}>
          <Plus className="h-4 w-4" /> Add event
        </Button>
      </div>

      {chronological.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No timeline events recorded yet.
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto pb-3">
          <div className="relative flex min-w-max items-stretch gap-3 px-2 py-2">
            {/* Central horizontal line running through every node */}
            <div className="pointer-events-none absolute left-4 right-4 top-1/2 h-0.5 -translate-y-1/2 bg-border" />

            {chronological.map((ev, i) => {
              const above = i % 2 === 0;
              return (
                <div key={ev.key} className="relative flex w-56 shrink-0 flex-col">
                  {/* Branch above the line */}
                  <div className="flex min-h-[9rem] flex-1 flex-col items-center justify-end pb-1">
                    {above && (
                      <>
                        <EventCard ev={ev} />
                        <div className="h-4 w-px bg-border" />
                      </>
                    )}
                  </div>

                  {/* Node sitting on the line */}
                  <div className="relative z-10 flex items-center justify-center">
                    <span
                      className={`flex h-9 w-9 items-center justify-center rounded-full ring-4 ring-background ${KIND_STYLE[ev.kind]}`}
                    >
                      {ev.icon}
                    </span>
                  </div>

                  {/* Branch below the line */}
                  <div className="flex min-h-[9rem] flex-1 flex-col items-center justify-start pt-1">
                    {!above && (
                      <>
                        <div className="h-4 w-px bg-border" />
                        <EventCard ev={ev} />
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}


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
