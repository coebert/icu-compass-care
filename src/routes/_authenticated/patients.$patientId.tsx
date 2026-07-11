import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPatient, updatePatient, deletePatient, getPatientAudit, getPatientFieldChanges } from "@/lib/patients.functions";
import type {
  Patient as DomainPatient,
  Investigation as DomainInvestigation,
  Microbiology as DomainMicrobiology,
  PatientTask as DomainPatientTask,
  PatientEvent as DomainPatientEvent,
  PatientReview as DomainReview,
} from "@/lib/domain-types";
import {
  listInvestigations,
  addInvestigation,
  updateInvestigation,
  deleteInvestigation,
} from "@/lib/investigations.functions";
import {
  listMicrobiology,
  addMicrobiology,
  deleteMicrobiology,
} from "@/lib/microbiology.functions";
import {
  listPatientEvents,
  addPatientEvent,
  updatePatientEvent,
  deletePatientEvent,
  PATIENT_EVENT_TYPES,
} from "@/lib/patient-events.functions";
import {
  listPatientReviews,
  addPatientReview,
  updatePatientReview,
  deletePatientReview,
  REVIEW_SPECIALTIES,
} from "@/lib/patient-reviews.functions";
import {
  listPatientTasks,
  addPatientTask,
  updatePatientTask,
  deletePatientTask,
  TASK_STATUSES,
  TASK_STATUS_LABEL,
  type TaskStatus,
} from "@/lib/patient-tasks.functions";
import { PatientName, PatientMetaLine } from "@/components/PatientSummary";
import { PatientForm, toFormValues, type PatientFormValues } from "@/components/PatientForm";
import { STATUS_BADGE, STATUS_LABELS, INVESTIGATION_CATEGORIES, MICROBIOLOGY_SPECIMENS, fmtDate, fmtDateTime } from "@/lib/icu";
import { RECENT_INVESTIGATION_CATEGORIES, mostRecentInvestigation } from "@/lib/handover-pdf";
import { courseDays, type Antimicrobial } from "@/lib/antimicrobials";
import { SpecimenTypeCombobox } from "@/components/SpecimenTypeCombobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Pencil, Trash2, Plus, AlertTriangle, FlaskConical, Microscope, LogIn, LogOut, Clock, Activity, Stethoscope, Users, Circle, CircleDashed, CheckCircle2, ListTodo } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/patients/$patientId")({
  component: PatientDetail,
});

type Patient = DomainPatient & Record<string, any>;
type Investigation = DomainInvestigation & Record<string, any>;

function InfoBlock({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm">{value?.trim() ? value : "—"}</p>
    </div>
  );
}

const AIRWAY_OPTIONS: { value: string; label: string }[] = [
  { value: "own", label: "Own airway" },
  { value: "ett", label: "ETT" },
  { value: "tt", label: "Tracheostomy (TT)" },
];

const RESP_SUPPORT_OPTIONS: { value: string; label: string }[] = [
  { value: "nc", label: "Nasal cannula (NC)" },
  { value: "fm", label: "Face mask (FM)" },
  { value: "hfno", label: "HFNO" },
  { value: "niv", label: "NIV" },
  { value: "ippv", label: "IPPV" },
];

function RespiratoryStatus({
  patientId,
  patient,
}: {
  patientId: string;
  patient: Record<string, any>;
}) {
  const mut = usePatientFieldMutation(patientId);
  const airway: string | null = patient.airway_type ?? null;
  const support: string[] = patient.resp_support ?? [];

  return (
    <div className="sm:col-span-2 space-y-4 rounded-lg border p-4">
      <CheckboxOptionGroup
        label="Airway"
        options={AIRWAY_OPTIONS}
        isChecked={(v) => airway === v}
        onToggle={(v) => mut.mutate({ airway_type: airway === v ? null : v })}
        disabled={mut.isPending}
      />
      <CheckboxOptionGroup
        label="Respiratory support"
        options={RESP_SUPPORT_OPTIONS}
        isChecked={(v) => support.includes(v)}
        onToggle={(v) =>
          mut.mutate({
            resp_support: support.includes(v)
              ? support.filter((s) => s !== v)
              : [...support, v],
          })
        }
        disabled={mut.isPending}
      />
      <InfoBlock label="Resp notes" value={patient.systems_resp} />
    </div>
  );
}

const VASOACTIVE_OPTIONS: { value: string; label: string }[] = [
  { value: "na", label: "Noradrenaline (NA)" },
  { value: "adrenaline", label: "Adrenaline" },
  { value: "metaraminol", label: "Metaraminol" },
  { value: "dobutamine", label: "Dobutamine" },
  { value: "milrinone", label: "Milrinone" },
  { value: "vasopressin", label: "Vasopressin" },
];

function CardiovascularStatus({
  patientId,
  patient,
}: {
  patientId: string;
  patient: Record<string, any>;
}) {
  return (
    <SystemMultiSelectCard
      patientId={patientId}
      selected={patient.vasoactive_agents ?? []}
      arrayField="vasoactive_agents"
      groupLabel="Vasoactive agents"
      options={VASOACTIVE_OPTIONS}
      notesLabel="CVS notes"
      notes={patient.systems_cvs}
    />
  );
}

const ANTICOAGULATION_OPTIONS: { value: string; label: string }[] = [
  { value: "plmwh", label: "pLMWH" },
  { value: "tlmwh", label: "tLMWH" },
  { value: "ufh", label: "UFH" },
  { value: "doac", label: "DOAC" },
  { value: "none", label: "None" },
  { value: "other", label: "Other" },
];

function HaemStatus({
  patientId,
  patient,
}: {
  patientId: string;
  patient: Record<string, any>;
}) {
  return (
    <SystemMultiSelectCard
      patientId={patientId}
      selected={patient.anticoagulation ?? []}
      arrayField="anticoagulation"
      groupLabel="Anticoagulation"
      options={ANTICOAGULATION_OPTIONS}
      notesLabel="Haem notes"
      notes={patient.systems_haem}
    />
  );
}

function RenalStatus({
  patientId,
  patient,
}: {
  patientId: string;
  patient: Record<string, any>;
}) {
  const mut = usePatientFieldMutation(patientId);

  return (
    <div className="sm:col-span-2 space-y-4 rounded-lg border p-4">
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Renal
        </p>
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={!!patient.renal_diuretics}
              disabled={mut.isPending}
              onCheckedChange={(v) => mut.mutate({ renal_diuretics: !!v })}
            />
            Diuretics
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={!!patient.renal_rrt}
              disabled={mut.isPending}
              onCheckedChange={(v) => mut.mutate({ renal_rrt: !!v })}
            />
            RRT
          </label>
        </div>
      </div>
      <InfoBlock label="Renal notes" value={patient.systems_renal} />
    </div>
  );
}




function MicroStatus({
  patientId,
  patient,
}: {
  patientId: string;
  patient: Record<string, any>;
}) {
  const qc = useQueryClient();
  const update = useServerFn(updatePatient);

  const agents: Antimicrobial[] = Array.isArray(patient.antimicrobials)
    ? patient.antimicrobials
    : [];

  const [name, setName] = useState("");
  const [startedOn, setStartedOn] = useState(
    () => new Date().toISOString().slice(0, 10),
  );

  const mut = useMutation({
    mutationFn: (next: Antimicrobial[]) =>
      update({ data: { id: patientId, antimicrobials: next } as never }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["patient", patientId] }),
    onError: (e: any) => toast.error(e?.message ?? "Failed to save"),
  });

  const add = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    mut.mutate([...agents, { name: trimmed, started_on: startedOn }]);
    setName("");
    setStartedOn(new Date().toISOString().slice(0, 10));
  };

  const remove = (idx: number) => {
    mut.mutate(agents.filter((_, i) => i !== idx));
  };

  const setEnd = (idx: number, value: string) => {
    mut.mutate(
      agents.map((a, i) =>
        i === idx ? { ...a, ended_on: value || null } : a,
      ),
    );
  };

  const toggleStatus = (idx: number) => {
    const today = new Date().toISOString().slice(0, 10);
    mut.mutate(
      agents.map((a, i) =>
        i === idx
          ? { ...a, ended_on: a.ended_on ? null : today }
          : a,
      ),
    );
  };

  const indexed = agents.map((a, i) => ({ a, i }));
  const current = indexed.filter(({ a }) => !a.ended_on);
  const completed = indexed.filter(({ a }) => !!a.ended_on);

  const renderItem = ({ a, i }: { a: Antimicrobial; i: number }) => {
    const days = courseDays(a.started_on, a.ended_on);
    const isCompleted = !!a.ended_on;
    return (
      <li
        key={i}
        className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ${
          isCompleted ? "opacity-70" : "border-primary/30 bg-primary/5"
        }`}
      >
        <div>
          <span className="font-medium">{a.name}</span>
          <span className="ml-2 text-muted-foreground">
            {a.started_on}
            {isCompleted ? <> → {a.ended_on}</> : <> → ongoing</>}
            {days != null && (
              <>
                {" "}
                · {isCompleted
                  ? `total course ${days} day${days === 1 ? "" : "s"}`
                  : `day ${days} of course`}
              </>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isCompleted && (
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              End
              <Input
                type="date"
                className="h-8 w-[9.5rem]"
                value={a.ended_on ?? ""}
                min={a.started_on}
                max={new Date().toISOString().slice(0, 10)}
                disabled={mut.isPending}
                onChange={(e) => setEnd(i, e.target.value)}
              />
            </label>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            disabled={mut.isPending}
            onClick={() => toggleStatus(i)}
          >
            {isCompleted ? "Mark current" : "Mark completed"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            disabled={mut.isPending}
            onClick={() => remove(i)}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </li>
    );
  };

  return (
    <div className="sm:col-span-2 space-y-4 rounded-lg border p-4">
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Antimicrobials
        </p>
        {agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No antimicrobials recorded.
          </p>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="mb-2 flex items-center gap-2 text-xs font-semibold text-primary">
                Currently receiving
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                  {current.length}
                </span>
              </p>
              {current.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No active antimicrobials.
                </p>
              ) : (
                <ul className="space-y-2">{current.map(renderItem)}</ul>
              )}
            </div>
            {completed.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Completed
                </p>
                <ul className="space-y-2">{completed.map(renderItem)}</ul>
              </div>
            )}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="flex-1 min-w-[140px]">
            <label className="mb-1 block text-xs text-muted-foreground">
              Agent
            </label>
            <Input
              value={name}
              placeholder="e.g. Piperacillin/tazobactam"
              disabled={mut.isPending}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  add();
                }
              }}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Start date
            </label>
            <Input
              type="date"
              value={startedOn}
              max={new Date().toISOString().slice(0, 10)}
              disabled={mut.isPending}
              onChange={(e) => setStartedOn(e.target.value)}
            />
          </div>
          <Button type="button" onClick={add} disabled={mut.isPending || !name.trim()}>
            <Plus className="mr-1 h-4 w-4" /> Add
          </Button>
        </div>
      </div>
      {agents.length > 0 && (() => {
        const sorted = [...agents].sort((a, b) =>
          (b.started_on || "").localeCompare(a.started_on || ""),
        );
        const latest = sorted[0]?.started_on || "";
        return (
          <div>
            <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Timeline (most recent first)
            </p>
            <ol className="relative space-y-3 border-l pl-5">
              {sorted.map((a, i) => {
                const days = courseDays(a.started_on, a.ended_on);
                const completed = !!a.ended_on;
                const isLatest = a.started_on === latest;
                return (
                  <li key={i} className="relative">
                    <span
                      className={`absolute -left-[1.4rem] top-1 h-3 w-3 rounded-full border-2 border-background ${
                        isLatest ? "bg-primary" : "bg-muted-foreground/40"
                      }`}
                    />
                    <div
                      className={`rounded-md px-3 py-2 text-sm ${
                        isLatest
                          ? "bg-primary/10 ring-1 ring-primary/30"
                          : "bg-muted/40"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{a.name}</span>
                        {isLatest && (
                          <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-semibold uppercase text-primary-foreground">
                            Newest
                          </span>
                        )}
                        {completed && (
                          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold uppercase text-muted-foreground">
                            Completed
                          </span>
                        )}
                      </div>
                      <span className="text-muted-foreground">
                        {a.started_on}
                        {completed ? <> → {a.ended_on}</> : <> → ongoing</>}
                        {days != null && (
                          <>
                            {" "}
                            · {completed
                              ? `total course ${days} day${days === 1 ? "" : "s"}`
                              : `day ${days} of course`}
                          </>
                        )}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        );
      })()}
      <InfoBlock label="Micro notes" value={patient.systems_micro} />
    </div>
  );
}

const SEDATIVE_OPTIONS: { value: string; label: string }[] = [
  { value: "propofol", label: "Propofol" },
  { value: "fentanyl", label: "Fentanyl" },
  { value: "alfentanil", label: "Alfentanil" },
  { value: "remifentanil", label: "Remifentanil" },
  { value: "clonidine", label: "Clonidine" },
  { value: "dexmedetomidine", label: "Dexmedetomidine" },
  { value: "midazolam", label: "Midazolam" },
  { value: "ketamine", label: "Ketamine" },
];

const PCA_OPTIONS: { value: string; label: string }[] = [
  { value: "morphine", label: "Morphine" },
  { value: "fentanyl", label: "Fentanyl" },
];

const REGIONAL_OPTIONS: { value: string; label: string }[] = [
  { value: "epidural", label: "Epidural" },
  { value: "rscs", label: "RSCs" },
  { value: "esp", label: "ESP" },
  { value: "sap", label: "SAP" },
  { value: "other", label: "Other LA catheter" },
];

function CheckboxRow({
  label,
  options,
  selected,
  disabled,
  onToggle,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  disabled: boolean;
  onToggle: (value: string) => void;
}) {
  return (
    <div>
      <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="flex flex-wrap gap-4">
        {options.map((opt) => (
          <label key={opt.value} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={selected.includes(opt.value)}
              disabled={disabled}
              onCheckedChange={() => onToggle(opt.value)}
            />
            {opt.label}
          </label>
        ))}
      </div>
    </div>
  );
}

function NeuroStatus({
  patientId,
  patient,
}: {
  patientId: string;
  patient: Record<string, any>;
}) {
  const qc = useQueryClient();
  const update = useServerFn(updatePatient);

  const sedatives: string[] = patient.sedative_agents ?? [];
  const pca: string[] = patient.pca_agents ?? [];
  const regional: string[] = patient.regional_analgesia ?? [];

  const mut = useMutation({
    mutationFn: (payload: Record<string, string[]>) =>
      update({ data: { id: patientId, ...payload } as never }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["patient", patientId] }),
    onError: (e: any) => toast.error(e?.message ?? "Failed to save"),
  });

  const toggleIn = (
    field: "sedative_agents" | "pca_agents" | "regional_analgesia",
    current: string[],
    value: string,
  ) => {
    const next = current.includes(value)
      ? current.filter((v) => v !== value)
      : [...current, value];
    mut.mutate({ [field]: next });
  };

  return (
    <div className="sm:col-span-2 space-y-4 rounded-lg border p-4">
      <CheckboxRow
        label="Sedative / analgesic agents"
        options={SEDATIVE_OPTIONS}
        selected={sedatives}
        disabled={mut.isPending}
        onToggle={(v) => toggleIn("sedative_agents", sedatives, v)}
      />
      <CheckboxRow
        label="PCA"
        options={PCA_OPTIONS}
        selected={pca}
        disabled={mut.isPending}
        onToggle={(v) => toggleIn("pca_agents", pca, v)}
      />
      <CheckboxRow
        label="Epidural / LA catheter(s)"
        options={REGIONAL_OPTIONS}
        selected={regional}
        disabled={mut.isPending}
        onToggle={(v) => toggleIn("regional_analgesia", regional, v)}
      />
      <InfoBlock label="CNS / Neuro notes" value={patient.systems_neuro} />
    </div>
  );
}

const NUTRITION_ROUTE_OPTIONS: { value: string; label: string }[] = [
  { value: "oral", label: "Oral" },
  { value: "ngt", label: "NGT" },
  { value: "njt", label: "NJT" },
  { value: "peg", label: "PEG" },
  { value: "pej", label: "PEJ" },
  { value: "tpn", label: "TPN" },
];

function GastroNutritionStatus({
  patientId,
  patient,
}: {
  patientId: string;
  patient: Record<string, any>;
}) {
  const qc = useQueryClient();
  const update = useServerFn(updatePatient);

  const routes: string[] = patient.nutrition_route ?? [];

  const mut = useMutation({
    mutationFn: (next: string[]) =>
      update({ data: { id: patientId, nutrition_route: next } as never }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["patient", patientId] }),
    onError: (e: any) => toast.error(e?.message ?? "Failed to save"),
  });

  const toggle = (value: string) => {
    const next = routes.includes(value)
      ? routes.filter((r) => r !== value)
      : [...routes, value];
    mut.mutate(next);
  };

  return (
    <div className="sm:col-span-2 space-y-4 rounded-lg border p-4">
      <CheckboxRow
        label="Nutrition route"
        options={NUTRITION_ROUTE_OPTIONS}
        selected={routes}
        disabled={mut.isPending}
        onToggle={toggle}
      />
      <InfoBlock label="Gastro / Nutri notes" value={patient.systems_gastro} />
    </div>
  );
}


type PatientTask = DomainPatientTask & Record<string, any>;

const TASK_STATUS_STYLE: Record<TaskStatus, string> = {
  not_started: "text-muted-foreground",
  in_progress: "text-amber-600 dark:text-amber-400",
  completed: "text-emerald-600 dark:text-emerald-400",
};

const TASK_STATUS_ICON: Record<TaskStatus, React.ReactNode> = {
  not_started: <Circle className="h-5 w-5" />,
  in_progress: <CircleDashed className="h-5 w-5" />,
  completed: <CheckCircle2 className="h-5 w-5" />,
};

// Clicking cycles through the three states in order.
const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  not_started: "in_progress",
  in_progress: "completed",
  completed: "not_started",
};

function OutstandingTasks({ patientId, freeText }: { patientId: string; freeText?: string | null }) {
  const qc = useQueryClient();
  const listTasks = useServerFn(listPatientTasks);
  const addTask = useServerFn(addPatientTask);
  const editTask = useServerFn(updatePatientTask);
  const removeTask = useServerFn(deletePatientTask);

  const [newTask, setNewTask] = useState("");

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["patient-tasks", patientId],
    queryFn: () => listTasks({ data: { patientId } }) as Promise<PatientTask[]>,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["patient-tasks", patientId] });

  const addMut = useMutation({
    mutationFn: (description: string) =>
      addTask({ data: { patient_id: patientId, description, position: tasks.length } as never }),
    onSuccess: () => {
      invalidate();
      setNewTask("");
    },
    onError: (e: Error) => toast.error("Could not add task", { description: e.message }),
  });

  const statusMut = useMutation({
    mutationFn: (v: { id: string; status: TaskStatus }) =>
      editTask({ data: { id: v.id, status: v.status } as never }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error("Could not update task", { description: e.message }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => removeTask({ data: { id } }),
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error("Could not remove task", { description: e.message }),
  });

  const submit = () => {
    const v = newTask.trim();
    if (v) addMut.mutate(v);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListTodo className="h-4 w-4" /> Outstanding tasks
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Add a task…"
          />
          <Button className="gap-1.5" onClick={submit} disabled={addMut.isPending || !newTask.trim()}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : tasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No tasks yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {tasks.map((t) => {
              const status = (t.status ?? "not_started") as TaskStatus;
              return (
                <li key={t.id} className="flex items-center gap-2 rounded-md border border-border p-2">
                  <button
                    type="button"
                    title={`${TASK_STATUS_LABEL[status]} — click to change`}
                    className={`shrink-0 transition-colors ${TASK_STATUS_STYLE[status]}`}
                    onClick={() => statusMut.mutate({ id: t.id, status: NEXT_STATUS[status] })}
                  >
                    {TASK_STATUS_ICON[status]}
                  </button>
                  <span
                    className={`flex-1 text-sm ${status === "completed" ? "text-muted-foreground line-through" : ""}`}
                  >
                    {t.description}
                  </span>
                  <Badge variant="outline" className={`shrink-0 ${TASK_STATUS_STYLE[status]}`}>
                    {TASK_STATUS_LABEL[status]}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-destructive"
                    onClick={() => deleteMut.mutate(t.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {freeText?.trim() && (
          <div className="rounded-md bg-muted/50 p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Notes
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm">{freeText}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}


function RecentInvestigations({ patientId }: { patientId: string }) {
  const listInv = useServerFn(listInvestigations);
  const { data: investigations = [], isLoading } = useQuery({
    queryKey: ["investigations", patientId],
    queryFn: () => listInv({ data: { patientId } }) as Promise<Investigation[]>,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="h-4 w-4" /> Most recent investigations
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        {RECENT_INVESTIGATION_CATEGORIES.map((category) => {
          const latest = mostRecentInvestigation(investigations, category);
          return (
            <div key={category} className="rounded-md border border-border p-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {category}
              </p>
              {isLoading ? (
                <p className="mt-1 text-sm text-muted-foreground">Loading…</p>
              ) : latest ? (
                <>
                  <p className="mt-1 whitespace-pre-wrap text-sm">
                    {latest.findings?.trim() ? latest.findings : "—"}
                  </p>
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {latest.result_at ? fmtDateTime(latest.result_at) : "Date not recorded"}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">No result recorded</p>
              )}
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function PatientDetail() {
  const { patientId } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const get = useServerFn(getPatient);
  const update = useServerFn(updatePatient);
  const del = useServerFn(deletePatient);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<PatientFormValues | null>(null);

  const { data: patient, isLoading } = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => get({ data: { id: patientId } }) as Promise<Patient>,
  });

  const updateMut = useMutation({
    mutationFn: (v: PatientFormValues) =>
      update({ data: { id: patientId, expected_updated_at: patient?.updated_at, ...v } as never }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patient", patientId] });
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["patient-audit", patientId] });
      setEditing(false);
      toast.success("Patient updated");
    },
    onError: (e: Error) =>
      e.message.startsWith("CONFLICT:")
        ? toast.warning("Edit conflict", { description: e.message.replace("CONFLICT: ", "") })
        : toast.error("Update failed", { description: e.message }),
  });

  const deleteMut = useMutation({
    mutationFn: () => del({ data: { id: patientId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      toast.success("Patient deleted");
      navigate({ to: "/patients" });
    },
    onError: (e: Error) => toast.error("Delete failed", { description: e.message }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!patient)
    return (
      <div className="space-y-3">
        <p>Patient not found.</p>
        <Link to="/patients"><Button variant="outline">Back to board</Button></Link>
      </div>
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/patients">
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" /> Board
          </Button>
        </Link>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">

            <PatientName patient={patient} size="lg" />
            <Badge className={STATUS_BADGE[patient.status]} variant="secondary">
              {STATUS_LABELS[patient.status]}
            </Badge>
            {patient.dnacpr_decision && (
              <Badge variant="outline" className="gap-1 border-rose-300 text-rose-700 dark:text-rose-300">
                <AlertTriangle className="h-3 w-3" /> DNACPR
              </Badge>
            )}
          </div>
          <PatientMetaLine
            patient={patient}
            leading={[patient.ward ? `${patient.ward}${patient.bed ? ` · Bed ${patient.bed}` : ""}` : null]}
          />
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => {
              setForm(toFormValues(patient));
              setEditing(true);
            }}
          >
            <Pencil className="h-4 w-4" /> Edit
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="gap-1.5 text-destructive">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this patient record?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes the record and all its investigations. To keep the
                  record for review, change the status to discharged or died instead.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => deleteMut.mutate()}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="flex h-12 w-full max-w-full items-stretch justify-start gap-1 overflow-x-auto sm:h-9">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="escalation">Escalation & Resus</TabsTrigger>
          <TabsTrigger value="nok">Next of kin</TabsTrigger>
          <TabsTrigger value="investigations">Investigations</TabsTrigger>
          <TabsTrigger value="microbiology">Microbiology</TabsTrigger>
          <TabsTrigger value="reviews">Specialty reviews</TabsTrigger>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="status">Status</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>



        <TabsContent value="overview" className="mt-4 space-y-4">
          <RecentInvestigations patientId={patientId} />
          <Card>
            <CardContent className="grid gap-6 p-6 sm:grid-cols-2">
              <InfoBlock label="Past medical history" value={patient.past_medical_history} />
              <InfoBlock label="Current admission" value={patient.current_admission} />
              <InfoBlock label="Current management" value={patient.current_management} />
            </CardContent>
          </Card>
          <OutstandingTasks patientId={patientId} freeText={patient.outstanding_tasks} />

          <Card>
            <CardContent className="p-6">
              <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Systems review
              </h3>
              <div className="grid gap-6 sm:grid-cols-2">
                <RespiratoryStatus patientId={patientId} patient={patient} />
                <CardiovascularStatus patientId={patientId} patient={patient} />
                <NeuroStatus patientId={patientId} patient={patient} />
                <RenalStatus patientId={patientId} patient={patient} />
                <GastroNutritionStatus patientId={patientId} patient={patient} />
                <HaemStatus patientId={patientId} patient={patient} />
                <MicroStatus patientId={patientId} patient={patient} />
                <InfoBlock label="Other" value={patient.systems_other} />
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="escalation" className="mt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Treatment escalation plan</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <Badge variant={patient.tep_in_place ? "default" : "secondary"}>
                  {patient.tep_in_place ? "TEP in place" : "No TEP recorded"}
                </Badge>
                <InfoBlock label="Details" value={patient.tep_details} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Resuscitation (DNACPR)</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <Badge variant={patient.dnacpr_decision ? "destructive" : "secondary"}>
                  {patient.dnacpr_decision ? "DNACPR decision made" : "For resuscitation"}
                </Badge>
                <InfoBlock label="Date of decision" value={fmtDate(patient.dnacpr_date)} />
                <InfoBlock label="Details" value={patient.dnacpr_details} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="nok" className="mt-4">
          <Card>
            <CardContent className="grid gap-6 p-6 sm:grid-cols-2">
              <InfoBlock label="Name" value={patient.nok_name} />
              <InfoBlock label="Relationship" value={patient.nok_relationship} />
              <InfoBlock label="Contact" value={patient.nok_contact} />
              <InfoBlock label="Last updated / spoken to" value={fmtDateTime(patient.nok_last_updated)} />
              <InfoBlock label="Updated by" value={patient.nok_last_updated_by} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="investigations" className="mt-4">
          <InvestigationsTab patientId={patientId} />
        </TabsContent>

        <TabsContent value="microbiology" className="mt-4">
          <MicrobiologyTab patientId={patientId} />
        </TabsContent>

        <TabsContent value="reviews" className="mt-4">
          <ReviewsTab patientId={patientId} />
        </TabsContent>


        <TabsContent value="timeline" className="mt-4">
          <TimelineTab patient={patient} patientId={patientId} />
        </TabsContent>

        <TabsContent value="status" className="mt-4">
          <StatusTab patient={patient} />
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <AuditTab patientId={patientId} />
        </TabsContent>

      </Tabs>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>Edit patient</DialogTitle></DialogHeader>
          {form && (
            <PatientForm
              values={form}
              onChange={setForm}
              onSubmit={() => updateMut.mutate(form)}
              onCancel={() => setEditing(false)}
              submitting={updateMut.isPending}
              submitLabel="Save changes"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

type TimelineEvent = {
  key: string;
  at: string | null;
  icon: React.ReactNode;
  title: string;
  detail?: string | null;
  kind: "admission" | "discharge" | "investigation" | "microbiology" | "event";
  eventId?: string;
  eventType?: string;
};

const KIND_STYLE: Record<TimelineEvent["kind"], string> = {
  admission: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  discharge: "bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300",
  investigation: "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300",
  microbiology: "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300",
  event: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
};

type PatientEvent = DomainPatientEvent & Record<string, any>;

function TimelineTab({ patient, patientId }: { patient: Patient; patientId: string }) {
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

    return evs.sort((a, b) => {
      const ta = a.at ? new Date(a.at).getTime() : 0;
      const tb = b.at ? new Date(b.at).getTime() : 0;
      return tb - ta;
    });
  }, [patient, investigations, micro, keyEvents]);

  const isDate = (v: string | null) => !!v && v.length <= 10;

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

      {events.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No timeline events recorded yet.
          </CardContent>
        </Card>
      ) : (
        <ol className="relative space-y-4 border-l border-border pl-6">
          {events.map((ev) => (
            <li key={ev.key} className="relative">
              <span
                className={`absolute -left-[35px] flex h-7 w-7 items-center justify-center rounded-full ${KIND_STYLE[ev.kind]}`}
              >
                {ev.icon}
              </span>
              <Card>
                <CardContent className="space-y-1 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{ev.title}</span>
                    <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {ev.at ? (isDate(ev.at) ? fmtDate(ev.at) : fmtDateTime(ev.at)) : "Date not recorded"}
                    </span>
                  </div>
                  {ev.detail?.trim() && (
                    <p className="whitespace-pre-wrap text-sm text-muted-foreground">{ev.detail}</p>
                  )}
                  {ev.kind === "event" && ev.eventId && (
                    <div className="flex gap-1 pt-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 gap-1 px-2 text-xs"
                        onClick={() =>
                          openEdit(keyEvents.find((k) => k.id === ev.eventId) as PatientEvent)
                        }
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
            </li>
          ))}
        </ol>
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

type Review = DomainReview & Record<string, any>;

function ReviewsTab({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const listReviews = useServerFn(listPatientReviews);
  const addReview = useServerFn(addPatientReview);
  const editReview = useServerFn(updatePatientReview);
  const removeReview = useServerFn(deletePatientReview);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [specialty, setSpecialty] = useState<string>(REVIEW_SPECIALTIES[0]);
  const [review, setReview] = useState("");
  const [plan, setPlan] = useState("");
  const [reviewedAt, setReviewedAt] = useState<string>("");

  const { data: reviews = [], isLoading } = useQuery({
    queryKey: ["patient-reviews", patientId],
    queryFn: () => listReviews({ data: { patientId } }) as Promise<Review[]>,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["patient-reviews", patientId] });

  const openAdd = () => {
    setEditId(null);
    setSpecialty(REVIEW_SPECIALTIES[0]);
    setReview("");
    setPlan("");
    setReviewedAt(new Date().toISOString());
    setDialogOpen(true);
  };

  const openEdit = (r: Review) => {
    setEditId(r.id);
    setSpecialty(r.specialty);
    setReview(r.review ?? "");
    setPlan(r.plan ?? "");
    setReviewedAt(r.reviewed_at ?? new Date().toISOString());
    setDialogOpen(true);
  };

  const saveMut = useMutation({
    mutationFn: () =>
      editId
        ? editReview({ data: { id: editId, specialty, review, plan, reviewed_at: reviewedAt } as never })
        : addReview({ data: { patient_id: patientId, specialty, review, plan, reviewed_at: reviewedAt } as never }),
    onSuccess: () => {
      invalidate();
      setDialogOpen(false);
      toast.success(editId ? "Review updated" : "Review added");
    },
    onError: (e: Error) => toast.error("Could not save review", { description: e.message }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => removeReview({ data: { id } }),
    onSuccess: () => {
      invalidate();
      toast.success("Review removed");
    },
    onError: (e: Error) => toast.error("Could not remove review", { description: e.message }),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Users className="h-4 w-4" />
          Reviews and plans from specialty teams — retained after discharge.
        </div>
        <Button size="sm" className="ml-auto gap-1.5" onClick={openAdd}>
          <Plus className="h-4 w-4" /> Add review
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : reviews.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No specialty reviews recorded yet.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {reviews.map((r) => (
            <Card key={r.id}>
              <CardContent className="space-y-2 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{r.specialty}</Badge>
                  <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock className="h-3 w-3" />
                    {r.reviewed_at ? fmtDateTime(r.reviewed_at) : "Date not recorded"}
                  </span>
                </div>
                <InfoBlock label="Review" value={r.review} />
                <InfoBlock label="Plan" value={r.plan} />
                <div className="flex gap-1 pt-1">
                  <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => openEdit(r)}>
                    <Pencil className="h-3 w-3" /> Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1 px-2 text-xs text-destructive"
                    onClick={() => deleteMut.mutate(r.id)}
                  >
                    <Trash2 className="h-3 w-3" /> Remove
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editId ? "Edit specialty review" : "Add specialty review"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Specialty team</Label>
              <Select value={specialty} onValueChange={setSpecialty}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {REVIEW_SPECIALTIES.map((s) => (
                    <SelectItem key={s} value={s}>{s}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Date &amp; time of review</Label>
              <DateTimePicker value={reviewedAt} onChange={(v) => setReviewedAt(v ?? "")} />
            </div>
            <div className="space-y-1.5">
              <Label>Review / findings</Label>
              <Textarea
                value={review}
                onChange={(e) => setReview(e.target.value)}
                placeholder="Assessment and impression from the specialty team"
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Plan / recommendations</Label>
              <Textarea
                value={plan}
                onChange={(e) => setPlan(e.target.value)}
                placeholder="Recommended plan and actions"
                rows={3}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
              <Button onClick={() => saveMut.mutate()} disabled={saveMut.isPending || !reviewedAt}>
                {saveMut.isPending ? "Saving…" : editId ? "Save changes" : "Add review"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}




function StatusTab({ patient }: { patient: Patient }) {
  const qc = useQueryClient();
  const update = useServerFn(updatePatient);
  const [status, setStatus] = useState<string>(patient.status);
  const [dischargeDate, setDischargeDate] = useState(patient.discharge_date ?? "");
  const [destination, setDestination] = useState(patient.discharge_destination ?? "");
  const [dod, setDod] = useState(patient.date_of_death ?? "");

  const mut = useMutation({
    mutationFn: () =>
      update({
        data: {
          id: patient.id,
          expected_updated_at: patient.updated_at,
          status,
          discharge_date: status === "discharged" ? dischargeDate : "",
          discharge_destination: status === "discharged" ? destination : "",
          date_of_death: status === "died" ? dod : "",
        } as never,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patient", patient.id] });
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["patient-audit", patient.id] });
      qc.invalidateQueries({ queryKey: ["patient-field-changes", patient.id] });
      toast.success("Status updated");
    },
    onError: (e: Error) =>
      e.message.startsWith("CONFLICT:")
        ? toast.warning("Edit conflict", { description: e.message.replace("CONFLICT: ", "") })
        : toast.error("Update failed", { description: e.message }),
  });

  return (
    <Card>
      <CardContent className="max-w-md space-y-4 p-6">
        <div className="space-y-1.5">
          <Label>Patient status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="referred">Referred (outlier)</SelectItem>
              <SelectItem value="admitted">Admitted</SelectItem>
              <SelectItem value="discharged">Discharged</SelectItem>
              <SelectItem value="died">Died</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {status === "discharged" && (
          <>
            <div className="space-y-1.5">
              <Label>Discharge date</Label>
              <DatePicker value={dischargeDate} onChange={setDischargeDate} />
            </div>
            <div className="space-y-1.5">
              <Label>Discharge destination</Label>
              <Input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="e.g. Ward, another hospital, home" />
            </div>
          </>
        )}
        {status === "died" && (
          <div className="space-y-1.5">
            <Label>Date of death</Label>
            <DatePicker value={dod} onChange={setDod} />
          </div>
        )}
        <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? "Saving…" : "Update status"}
        </Button>
      </CardContent>
    </Card>
  );
}

function toDateTimeLocal(iso?: string | null): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return new Date().toISOString().slice(0, 16);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function InvestigationsTab({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const list = useServerFn(listInvestigations);
  const add = useServerFn(addInvestigation);
  const update = useServerFn(updateInvestigation);
  const del = useServerFn(deleteInvestigation);
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [category, setCategory] = useState(INVESTIGATION_CATEGORIES[0]);
  const [findings, setFindings] = useState("");
  const [resultAt, setResultAt] = useState(() => toDateTimeLocal());

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["investigations", patientId],
    queryFn: () => list({ data: { patientId } }) as Promise<Investigation[]>,
  });

  const openAdd = () => {
    setEditingId(null);
    setCategory(INVESTIGATION_CATEGORIES[0]);
    setFindings("");
    setResultAt(toDateTimeLocal());
    setOpen(true);
  };

  const openEdit = (it: Investigation) => {
    setEditingId(it.id);
    setCategory(it.category ?? INVESTIGATION_CATEGORIES[0]);
    setFindings(it.findings ?? "");
    setResultAt(toDateTimeLocal(it.result_at));
    setOpen(true);
  };

  // A single success handler keeps the newest-per-category cards (here and on
  // the Overview tab, which share this query key) in sync immediately.
  const refreshAndClose = (message: string) => {
    qc.invalidateQueries({ queryKey: ["investigations", patientId] });
    setOpen(false);
    setEditingId(null);
    setFindings("");
    toast.success(message);
  };

  const addMut = useMutation({
    mutationFn: () =>
      add({
        data: {
          patient_id: patientId,
          category,
          findings,
          result_at: new Date(resultAt).toISOString(),
        },
      }),
    onSuccess: () => refreshAndClose("Investigation saved"),
    onError: (e: Error) => toast.error("Could not save", { description: e.message }),
  });

  const updateMut = useMutation({
    mutationFn: () =>
      update({
        data: {
          id: editingId as string,
          category,
          findings,
          result_at: new Date(resultAt).toISOString(),
        },
      }),
    onSuccess: () => refreshAndClose("Investigation updated"),
    onError: (e: Error) => toast.error("Could not update", { description: e.message }),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investigations", patientId] });
      toast.success("Deleted");
    },
    onError: (e: Error) => toast.error("Could not delete", { description: e.message }),
  });

  const saving = addMut.isPending || updateMut.isPending;

  // Most recent per category
  const mostRecent = useMemo(() => {
    const map = new Map<string, Investigation>();
    for (const it of items) {
      if (!map.has(it.category)) map.set(it.category, it);
    }
    return Array.from(map.values());
  }, [items]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Most recent results
        </h2>
        <Button size="sm" className="h-11 gap-1.5 sm:h-9" onClick={openAdd}>
          <Plus className="h-4 w-4" /> Add result
        </Button>
      </div>

      {mostRecent.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No investigations recorded.</CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {mostRecent.map((it) => (
            <Card key={it.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <FlaskConical className="h-4 w-4 text-primary" /> Most recent {it.category}
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
              <Card key={it.id}>
                <CardContent className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{it.category}</Badge>
                      <span className="text-xs text-muted-foreground">{fmtDateTime(it.result_at)}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{it.findings}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label="Edit investigation"
                      onClick={() => openEdit(it)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label="Delete investigation"
                          className="text-destructive"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete this investigation?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This permanently removes the {it.category} result from{" "}
                            {fmtDateTime(it.result_at)}.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction onClick={() => delMut.mutate(it.id)}>
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit investigation result" : "Add investigation result"}</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              (editingId ? updateMut : addMut).mutate();
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INVESTIGATION_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Date / time of result</Label>
              <DateTimePicker value={resultAt} onChange={setResultAt} />
            </div>
            <div className="space-y-1.5">
              <Label>Findings</Label>
              <Textarea rows={4} value={findings} onChange={(e) => setFindings(e.target.value)} required />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving…" : editingId ? "Save changes" : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type Microbiology = DomainMicrobiology & Record<string, any>;

function MicrobiologyTab({ patientId }: { patientId: string }) {
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Key microbiology results
          </h2>
          <p className="text-xs text-muted-foreground">
            Blood cultures, swabs, CSF and other significant micro findings.
          </p>
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
              <Card key={it.id}>
                <CardContent className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{it.specimen_type}</Badge>
                      <span className="text-xs text-muted-foreground">{fmtDateTime(it.result_at)}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{it.findings}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-destructive"
                    onClick={() => delMut.mutate(it.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
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


type AuditRow = Record<string, any>;

const ACTION_LABEL: Record<string, string> = {
  insert: "Created",
  update: "Updated",
  delete: "Removed",
};

function AuditTab({ patientId }: { patientId: string }) {
  const fetchAudit = useServerFn(getPatientAudit);
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["patient-audit", patientId],
    queryFn: () => fetchAudit({ data: { id: patientId } }) as Promise<AuditRow[]>,
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (rows.length === 0)
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No change history recorded yet.
        </CardContent>
      </Card>
    );

  return (
    <div className="space-y-4">
      <FieldChangeHistory patientId={patientId} />
      <div className="space-y-2">
        {rows.map((r) => {
          const who = r.actor_email || (r.actor_role ? `a ${r.actor_role}` : "unknown user");
          const fields: string[] = r.changed_fields ?? [];
          return (
            <Card key={r.id}>
              <CardContent className="space-y-1 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{ACTION_LABEL[r.action] ?? r.action}</Badge>
                  <Badge variant="outline">
                    {r.source === "bridge" ? "Linked app" : "This app"}
                  </Badge>
                  <span className="text-sm">{who}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {fmtDateTime(r.created_at)}
                  </span>
                </div>
                {r.action === "update" && fields.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Changed: {fields.map((f) => f.replace(/_/g, " ")).join(", ")}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

const FIELD_LABEL: Record<string, string> = {
  initials: "Initials",
  age: "Age",
  hospital_number: "Hospital number",
};

function FieldChangeHistory({ patientId }: { patientId: string }) {
  const fetchChanges = useServerFn(getPatientFieldChanges);
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["patient-field-changes", patientId],
    queryFn: () => fetchChanges({ data: { id: patientId } }) as Promise<AuditRow[]>,
  });

  if (isLoading || rows.length === 0) return null;

  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <p className="text-sm font-semibold">Field changes (initials, age, hospital number)</p>
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="font-medium">{FIELD_LABEL[r.field_name] ?? r.field_name}</span>
              <span className="text-muted-foreground">
                {r.old_value ?? "—"} → {r.new_value ?? "—"}
              </span>
              <span className="text-muted-foreground">
                by {r.changed_by_email || "unknown user"}
              </span>
              <span className="ml-auto text-muted-foreground">{fmtDateTime(r.changed_at)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
