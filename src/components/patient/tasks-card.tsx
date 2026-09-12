import { ListSkeleton, RowSkeleton, TextSkeleton } from "@/components/LoadingSkeleton";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { PatientTask as DomainPatientTask } from "@/lib/domain-types";
import {
  listPatientTasks,
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DateTimePicker } from "@/components/ui/date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Trash2, Plus, Clock, Circle, CircleDashed, CheckCircle2, ListTodo } from "lucide-react";
import { toast } from "sonner";

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

const TASK_PRIORITY_STYLE: Record<TaskPriority, string> = {
  routine: "border-border text-muted-foreground",
  urgent: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  critical: "border-rose-500/40 text-rose-600 dark:text-rose-400",
};

const PRIORITY_RANK: Record<TaskPriority, number> = { critical: 0, urgent: 1, routine: 2 };

function taskDueState(due?: string | null): "none" | "soon" | "overdue" {
  if (!due) return "none";
  const t = new Date(due).getTime();
  if (Number.isNaN(t)) return "none";
  const diff = t - Date.now();
  if (diff < 0) return "overdue";
  if (diff < 2 * 60 * 60 * 1000) return "soon";
  return "none";
}

export function OutstandingTasks({ patientId, freeText }: { patientId: string; freeText?: string | null }) {
  const qc = useQueryClient();
  const listTasks = useServerFn(listPatientTasks);
  const addTask = useServerFn(addPatientTask);
  const editTask = useServerFn(updatePatientTask);
  const removeTask = useServerFn(deletePatientTask);

  const [newTask, setNewTask] = useState("");
  const [newPriority, setNewPriority] = useState<TaskPriority>("routine");
  const [newCategory, setNewCategory] = useState<TaskCategory>("job");
  const [newOwner, setNewOwner] = useState("");
  const [newDue, setNewDue] = useState("");

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ["patient-tasks", patientId],
    queryFn: () => listTasks({ data: { patientId } }) as Promise<PatientTask[]>,
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["patient-tasks", patientId] });
    // Jobs created from a checklist item push their status back to the checklist.
    void qc.invalidateQueries({ queryKey: ["patient-checklists", patientId] });
  };

  const addMut = useMutation({
    mutationFn: () =>
      addTask({
        data: {
          patient_id: patientId,
          description: newTask.trim(),
          position: tasks.length,
          priority: newPriority,
          category: newCategory,
          owner: newOwner.trim() || null,
          due_at: newDue ? new Date(newDue).toISOString() : null,
        } as never,
      }),
    onSuccess: () => {
      invalidate();
      setNewTask("");
      setNewOwner("");
      setNewDue("");
      setNewPriority("routine");
      setNewCategory("job");
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
    if (newTask.trim()) addMut.mutate();
  };

  // Sort open tasks by priority then due time; completed sink to the bottom.
  const sorted = useMemo(() => {
    return [...tasks].sort((a, b) => {
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
  }, [tasks]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ListTodo className="h-4 w-4" /> Outstanding tasks
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2 rounded-md border border-border p-3">
          <Input
            value={newTask}
            onChange={(e) => setNewTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Describe a task…"
          />
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Select value={newPriority} onValueChange={(v) => setNewPriority(v as TaskPriority)}>
              <SelectTrigger>
                <SelectValue placeholder="Priority" />
              </SelectTrigger>
              <SelectContent>
                {TASK_PRIORITIES.map((p) => (
                  <SelectItem key={p} value={p}>
                    {TASK_PRIORITY_LABEL[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={newCategory} onValueChange={(v) => setNewCategory(v as TaskCategory)}>
              <SelectTrigger>
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                {TASK_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {TASK_CATEGORY_LABEL[c]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={newOwner}
              onChange={(e) => setNewOwner(e.target.value)}
              placeholder="Owner (e.g. Reg)"
            />
            <DateTimePicker value={newDue} onChange={setNewDue} placeholder="Due (optional)" />
          </div>
          <div className="flex justify-end">
            <Button className="gap-1.5" onClick={submit} disabled={addMut.isPending || !newTask.trim()}>
              <Plus className="h-4 w-4" /> Add task
            </Button>
          </div>
        </div>

        {isLoading ? (
          <RowSkeleton rows={3} />
        ) : tasks.length === 0 ? (

          <p className="text-sm text-muted-foreground">No tasks yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {sorted.map((t) => {
              const status = (t.status ?? "not_started") as TaskStatus;
              const priority = (t.priority ?? "routine") as TaskPriority;
              const category = (t.category ?? "job") as TaskCategory;
              const dueState = status === "completed" ? "none" : taskDueState(t.due_at);
              return (
                <li key={t.id} className="flex items-start gap-2 rounded-md border border-border p-2">
                  <button
                    type="button"
                    title={`${TASK_STATUS_LABEL[status]} — click to change`}
                    className={`mt-0.5 shrink-0 transition-colors ${TASK_STATUS_STYLE[status]}`}
                    onClick={() => statusMut.mutate({ id: t.id, status: NEXT_STATUS[status] })}
                  >
                    {TASK_STATUS_ICON[status]}
                  </button>
                  <div className="flex-1 space-y-1">
                    <span
                      className={`block text-sm ${status === "completed" ? "text-muted-foreground line-through" : ""}`}
                    >
                      {t.description}
                    </span>
                    <div className="flex flex-wrap items-center gap-1.5">
                      {priority !== "routine" && (
                        <Badge variant="outline" className={`shrink-0 ${TASK_PRIORITY_STYLE[priority]}`}>
                          {TASK_PRIORITY_LABEL[priority]}
                        </Badge>
                      )}
                      <Badge variant="secondary" className="shrink-0">
                        {TASK_CATEGORY_LABEL[category]}
                      </Badge>
                      {t.owner && (
                        <span className="text-xs text-muted-foreground">{t.owner}</span>
                      )}
                      {t.due_at && (
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
                          {fmtDateTime(t.due_at)}
                        </span>
                      )}
                    </div>
                  </div>
                  <Badge variant="outline" className={`shrink-0 ${TASK_STATUS_STYLE[status]}`}>
                    {TASK_STATUS_LABEL[status]}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0 text-destructive"
                    aria-label="Delete task"
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
