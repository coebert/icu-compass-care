import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPatients } from "@/lib/patients.functions";
import {
  listAllTasks,
  addPatientTask,
  updatePatientTask,
  deletePatientTask,
  TASK_STATUS_LABEL,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABEL,
  TASK_CATEGORIES,
  TASK_CATEGORY_LABEL,
  type TaskStatus,
  type TaskPriority,
  type TaskCategory,
} from "@/lib/patient-tasks.functions";
import { fmtDateTime } from "@/lib/icu";
import { dueLevel, dueRelativeLabel } from "@/lib/task-reminders";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { DateTimePicker } from "@/components/ui/date-picker";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Circle,
  CircleDashed,
  CheckCircle2,
  ClipboardList,
  Clock,
  MessageSquare,
  Plus,
  Trash2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { PatientName, PatientMetaLine } from "@/components/PatientSummary";
import { JobRemindersPanel } from "@/components/JobRemindersPanel";
import { useJobReminders } from "@/hooks/use-job-reminders";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/jobs")({
  head: () => ({
    meta: [
      { title: "ICU jobs list — Ward round tasks" },
      { name: "description", content: "Editable ICU jobs list showing every patient and the tasks the resident team needs to complete." },
      { property: "og:title", content: "ICU jobs list" },
      { property: "og:description", content: "Editable ward-round jobs list for the critical care team." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: JobsListPage,
});

const STATUS_ICON: Record<TaskStatus, React.ReactNode> = {
  not_started: <Circle className="h-5 w-5" />,
  in_progress: <CircleDashed className="h-5 w-5" />,
  completed: <CheckCircle2 className="h-5 w-5" />,
};
const STATUS_STYLE: Record<TaskStatus, string> = {
  not_started: "text-muted-foreground",
  in_progress: "text-amber-600 dark:text-amber-400",
  completed: "text-emerald-600 dark:text-emerald-400",
};
const NEXT_STATUS: Record<TaskStatus, TaskStatus> = {
  not_started: "in_progress",
  in_progress: "completed",
  completed: "not_started",
};
const PRIORITY_STYLE: Record<TaskPriority, string> = {
  routine: "border-border text-muted-foreground",
  urgent: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  critical: "border-rose-500/40 text-rose-600 dark:text-rose-400",
};
const PRIORITY_RANK: Record<TaskPriority, number> = { critical: 0, urgent: 1, routine: 2 };

type TaskRow = {
  id: string;
  patient_id: string;
  description: string;
  priority: string | null;
  category: string | null;
  owner: string | null;
  due_at: string | null;
  status: string;
  notes: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

function JobsListPage() {
  const qc = useQueryClient();
  const fetchTasks = useServerFn(listAllTasks);
  const fetchPatients = useServerFn(listPatients);

  const { overdue, soon } = useJobReminders();

  const [filter, setFilter] = useState<"open" | "all">("open");
  const [showRoundOnly, setShowRoundOnly] = useState(false);

  const { data: tasks = [], isLoading: tasksLoading } = useQuery({
    queryKey: ["jobs-list-tasks"],
    queryFn: () => fetchTasks() as Promise<TaskRow[]>,
    refetchInterval: 30_000,
  });

  const { data: patients = [], isLoading: patientsLoading } = useQuery({
    queryKey: ["jobs-list-patients"],
    queryFn: () => fetchPatients() as Promise<any[]>,
  });

  const activePatients = useMemo(
    () =>
      (patients ?? []).filter(
        (p: any) => p.status === "admitted" || p.status === "referred",
      ),
    [patients],
  );

  const grouped = useMemo(() => {
    const byPatient = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      if (filter === "open" && t.status === "completed") continue;
      if (showRoundOnly && t.category !== "ward_round") continue;
      const arr = byPatient.get(t.patient_id) ?? [];
      arr.push(t);
      byPatient.set(t.patient_id, arr);
    }
    for (const arr of byPatient.values()) {
      arr.sort((a, b) => {
        const aDone = a.status === "completed" ? 1 : 0;
        const bDone = b.status === "completed" ? 1 : 0;
        if (aDone !== bDone) return aDone - bDone;
        const pa = PRIORITY_RANK[(a.priority ?? "routine") as TaskPriority] ?? 2;
        const pb = PRIORITY_RANK[(b.priority ?? "routine") as TaskPriority] ?? 2;
        if (pa !== pb) return pa - pb;
        const da = a.due_at ? new Date(a.due_at).getTime() : Infinity;
        const db = b.due_at ? new Date(b.due_at).getTime() : Infinity;
        return da - db;
      });
    }
    return byPatient;
  }, [tasks, filter, showRoundOnly]);

  const totalOpen = tasks.filter((t) => t.status !== "completed").length;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <ClipboardList className="h-6 w-6" /> ICU jobs list
          </h1>
          <p className="text-sm text-muted-foreground">
            {totalOpen} open task{totalOpen === 1 ? "" : "s"} across the unit ·
            replaces the paper ward-round list.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filter} onValueChange={(v) => setFilter(v as any)}>
            <SelectTrigger className="w-[160px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open only</SelectItem>
              <SelectItem value="all">Include completed</SelectItem>
            </SelectContent>
          </Select>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={showRoundOnly}
              onCheckedChange={(v) => setShowRoundOnly(!!v)}
            />
            Ward-round jobs only
          </label>
        </div>
      </header>

      <JobRemindersPanel overdue={overdue} soon={soon} />

      {patientsLoading || tasksLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : activePatients.length === 0 ? (
        <p className="text-sm text-muted-foreground">No admitted patients.</p>
      ) : (
        <div className="space-y-3">
          {activePatients.map((p: any) => (
            <PatientJobsCard
              key={p.id}
              patient={p}
              tasks={grouped.get(p.id) ?? []}
              onChange={() =>
                qc.invalidateQueries({ queryKey: ["jobs-list-tasks"] })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PatientJobsCard({
  patient,
  tasks,
  onChange,
}: {
  patient: any;
  tasks: TaskRow[];
  onChange: () => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const openCount = tasks.filter((t) => t.status !== "completed").length;

  const bed = patient.bed ? `Bed ${patient.bed}` : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex w-full items-start justify-between gap-3 text-left"
        >
          <div className="min-w-0 flex-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {expanded ? (
                <ChevronDown className="h-4 w-4 shrink-0" />
              ) : (
                <ChevronRight className="h-4 w-4 shrink-0" />
              )}
              <PatientName patient={patient} />
              <Badge variant="secondary">
                {openCount} open · {tasks.length} total
              </Badge>
              <Link
                to="/patients/$patientId"
                params={{ patientId: patient.id }}
                onClick={(e) => e.stopPropagation()}
                className="ml-1 text-xs font-normal text-primary underline-offset-2 hover:underline"
              >
                Open notes →
              </Link>
            </CardTitle>
            <PatientMetaLine patient={patient} leading={[bed]} className="mt-1" />
          </div>
        </button>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-3">
          <NewTaskRow patientId={patient.id} onAdded={onChange} />
          {tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">No tasks for this patient.</p>
          ) : (
            <ul className="space-y-1.5">
              {tasks.map((t) => (
                <TaskItem key={t.id} task={t} onChange={onChange} />
              ))}
            </ul>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function NewTaskRow({
  patientId,
  onAdded,
}: {
  patientId: string;
  onAdded: () => void;
}) {
  const addTask = useServerFn(addPatientTask);
  const [desc, setDesc] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("routine");
  const [category, setCategory] = useState<TaskCategory>("job");
  const [owner, setOwner] = useState("");
  const [due, setDue] = useState("");

  const addMut = useMutation({
    mutationFn: () =>
      addTask({
        data: {
          patient_id: patientId,
          description: desc.trim(),
          priority,
          category,
          owner: owner.trim() || null,
          due_at: due ? new Date(due).toISOString() : null,
        } as never,
      }),
    onSuccess: () => {
      setDesc("");
      setOwner("");
      setDue("");
      setPriority("routine");
      setCategory("job");
      onAdded();
    },
    onError: (e: Error) => toast.error("Could not add task", { description: e.message }),
  });

  const submit = () => {
    if (desc.trim()) addMut.mutate();
  };

  return (
    <div className="space-y-2 rounded-md border border-dashed border-border p-2">
      <Input
        value={desc}
        onChange={(e) => setDesc(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
        placeholder="Add a job for this patient…"
      />
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Select value={priority} onValueChange={(v) => setPriority(v as TaskPriority)}>
          <SelectTrigger><SelectValue placeholder="Priority" /></SelectTrigger>
          <SelectContent>
            {TASK_PRIORITIES.map((p) => (
              <SelectItem key={p} value={p}>{TASK_PRIORITY_LABEL[p]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={category} onValueChange={(v) => setCategory(v as TaskCategory)}>
          <SelectTrigger><SelectValue placeholder="Category" /></SelectTrigger>
          <SelectContent>
            {TASK_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>{TASK_CATEGORY_LABEL[c]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          placeholder="Owner (e.g. Reg)"
        />
        <DateTimePicker value={due} onChange={setDue} placeholder="Due (optional)" />
      </div>
      <div className="flex justify-end">
        <Button size="sm" onClick={submit} disabled={addMut.isPending || !desc.trim()}>
          <Plus className="mr-1 h-4 w-4" /> Add job
        </Button>
      </div>
    </div>
  );
}

const taskDueState = (due?: string | null) => dueLevel(due);

function TaskItem({ task, onChange }: { task: TaskRow; onChange: () => void }) {
  const editTask = useServerFn(updatePatientTask);
  const removeTask = useServerFn(deletePatientTask);

  const status = (task.status ?? "not_started") as TaskStatus;
  const priority = (task.priority ?? "routine") as TaskPriority;
  const category = (task.category ?? "job") as TaskCategory;
  const dueState = status === "completed" ? "none" : taskDueState(task.due_at);

  const [notesOpen, setNotesOpen] = useState(false);
  const [notesDraft, setNotesDraft] = useState(task.notes ?? "");
  const [savedFlash, setSavedFlash] = useState(false);

  const statusMut = useMutation({
    mutationFn: (s: TaskStatus) => editTask({ data: { id: task.id, status: s } as never }),
    onSuccess: onChange,
    onError: (e: Error) => toast.error("Could not update task", { description: e.message }),
  });
  const notesMut = useMutation({
    mutationFn: (notes: string | null) =>
      editTask({ data: { id: task.id, notes } as never }),
    onSuccess: () => {
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onChange();
    },
    onError: (e: Error) => toast.error("Could not save note", { description: e.message }),
  });
  const deleteMut = useMutation({
    mutationFn: () => removeTask({ data: { id: task.id } }),
    onSuccess: onChange,
    onError: (e: Error) => toast.error("Could not remove task", { description: e.message }),
  });

  const hasNote = !!task.notes && task.notes.trim().length > 0;

  return (
    <li className="rounded-md border border-border">
      <div className="flex items-start gap-2 p-2">
        <button
          type="button"
          title={`${TASK_STATUS_LABEL[status]} — click to change`}
          className={`mt-0.5 shrink-0 transition-colors ${STATUS_STYLE[status]}`}
          onClick={() => statusMut.mutate(NEXT_STATUS[status])}
        >
          {STATUS_ICON[status]}
        </button>
        <div className="min-w-0 flex-1 space-y-1">
          <span
            className={`block text-sm ${status === "completed" ? "text-muted-foreground line-through" : ""}`}
          >
            {task.description}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            {priority !== "routine" && (
              <Badge variant="outline" className={`shrink-0 ${PRIORITY_STYLE[priority]}`}>
                {TASK_PRIORITY_LABEL[priority]}
              </Badge>
            )}
            <Badge variant="secondary" className="shrink-0">
              {TASK_CATEGORY_LABEL[category]}
            </Badge>
            {task.owner && (
              <span className="text-xs text-muted-foreground">{task.owner}</span>
            )}
            {task.due_at && (
              <span
                className={`flex items-center gap-1 text-xs ${
                  dueState === "overdue"
                    ? "font-medium text-rose-600 dark:text-rose-400"
                    : dueState === "soon"
                      ? "text-amber-600 dark:text-amber-400"
                      : "text-muted-foreground"
                }`}
              >
                <Clock className="h-3 w-3" />
                {dueState === "overdue" ? "Overdue · " : ""}
                {fmtDateTime(task.due_at)}
                {dueState !== "none" ? ` · ${dueRelativeLabel(task.due_at)}` : ""}
              </span>
            )}
          </div>
        </div>
        <Badge variant="outline" className={`shrink-0 ${STATUS_STYLE[status]}`}>
          {TASK_STATUS_LABEL[status]}
        </Badge>
        <Button
          variant="ghost"
          size="icon"
          className={`h-7 w-7 shrink-0 ${hasNote ? "text-primary" : ""}`}
          aria-label={hasNote ? "Edit note" : "Add note"}
          onClick={() => setNotesOpen((v) => !v)}
        >
          <MessageSquare className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-destructive"
          aria-label="Delete task"
          onClick={() => deleteMut.mutate()}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      {(notesOpen || hasNote) && (
        <div className="border-t border-border bg-muted/30 p-2">
          {notesOpen ? (
            <div className="space-y-2">
              <Textarea
                value={notesDraft}
                onChange={(e) => setNotesDraft(e.target.value)}
                placeholder="Add a note for this job (plan, results, discussion)…"
                rows={3}
                maxLength={4000}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  {savedFlash ? "Saved" : `${notesDraft.length}/4000`}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setNotesDraft(task.notes ?? "");
                      setNotesOpen(false);
                    }}
                  >
                    Close
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => notesMut.mutate(notesDraft.trim() ? notesDraft.trim() : null)}
                    disabled={notesMut.isPending || (notesDraft.trim() === (task.notes ?? "").trim())}
                  >
                    Save note
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setNotesOpen(true)}
              className="block w-full whitespace-pre-wrap text-left text-sm"
            >
              {task.notes}
            </button>
          )}
        </div>
      )}
    </li>
  );
}
