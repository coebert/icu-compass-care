import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  activateChecklist,
  archivePatientChecklist,
  createChecklistTemplate,
  listChecklistTemplates,
  listPatientChecklists,
  setChecklistItem,
  updateChecklistTemplate,
} from "@/lib/checklists.functions";
import { draftChecklist } from "@/lib/checklist-ai.functions";
import {
  CHECKLIST_ITEM_STATUS_LABEL,
  CHECKLIST_ROLES,
  CHECKLIST_ROLE_LABEL,
  NEXT_CHECKLIST_STATUS,
  UNASSIGNED_ROLE,
  CHECKLIST_ALERT_LABEL,
  checklistItemAlert,
  effectiveRaci,
  formatTargetMinutes,
  matchRole,
  parseTargetMinutes,
  roleLabel,
  checklistProgress,
  parseChecklistItems,
  parseChecklistState,
  type ChecklistItemStatus,
  type ChecklistRole,
} from "@/lib/checklists";
import { fmtDateTime } from "@/lib/icu";
import { dueRelativeLabel } from "@/lib/task-reminders";
import { DateTimePicker } from "@/components/ui/date-picker";
import { ListSkeleton } from "@/components/LoadingSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CheckCircle2,
  Circle,
  CircleDashed,
  ClipboardList,
  MinusCircle,
  Pencil,
  Plus,
  Sparkles,
  ShieldAlert,
  Trash2,
  AlertTriangle,
  Clock,
} from "lucide-react";

const STATUS_ICON: Record<ChecklistItemStatus, React.ReactNode> = {
  not_started: <Circle className="h-5 w-5" />,
  in_progress: <CircleDashed className="h-5 w-5" />,
  done: <CheckCircle2 className="h-5 w-5" />,
  not_applicable: <MinusCircle className="h-5 w-5" />,
};

const STATUS_STYLE: Record<ChecklistItemStatus, string> = {
  not_started: "text-muted-foreground",
  in_progress: "text-amber-600 dark:text-amber-400",
  done: "text-emerald-600 dark:text-emerald-400",
  not_applicable: "text-muted-foreground/60",
};

export function ChecklistsTab({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const fetchTemplates = useServerFn(listChecklistTemplates);
  const fetchChecklists = useServerFn(listPatientChecklists);
  const activate = useServerFn(activateChecklist);
  const setItem = useServerFn(setChecklistItem);
  const archive = useServerFn(archivePatientChecklist);

  const [templateId, setTemplateId] = useState("");

  const templatesQ = useQuery({
    queryKey: ["checklist-templates"],
    queryFn: () => fetchTemplates(),
  });

  const listQ = useQuery({
    queryKey: ["patient-checklists", patientId],
    queryFn: () => fetchChecklists({ data: { patientId } }),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["patient-checklists", patientId] });
  };

  const activateM = useMutation({
    mutationFn: (template_id: string) => activate({ data: { patient_id: patientId, template_id } }),
    onSuccess: () => {
      setTemplateId("");
      invalidate();
      toast.success("Checklist activated");
    },
    onError: (e: Error) => toast.error(e.message || "Could not activate checklist"),
  });

  const itemM = useMutation({
    mutationFn: (v: {
      id: string;
      item_key: string;
      status?: ChecklistItemStatus;
      responsible?: ChecklistRole | null;
      accountable?: ChecklistRole | null;
      due_at?: string | null;
      note?: string | null;
    }) =>
      setItem({ data: v }),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message || "Could not save checklist item"),
  });

  const archiveM = useMutation({
    mutationFn: (id: string) => archive({ data: { id } }),
    onSuccess: () => {
      invalidate();
      toast.success("Checklist removed");
    },
    onError: (e: Error) => toast.error(e.message || "Could not remove checklist"),
  });

  const active = listQ.data ?? [];
  const activeKeys = useMemo(() => new Set(active.map((c) => c.template_key)), [active]);
  const allTemplates = templatesQ.data ?? [];
  const selected = allTemplates.find((t) => t.id === templateId) ?? null;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="h-4 w-4" /> Management checklists
          </CardTitle>
          <CardDescription>
            Activate the checklists relevant to this patient. Each item can be marked not started, in
            progress, done or not applicable, with a note, and shows who is responsible for doing it
            and who owns it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger className="w-full min-w-0 sm:w-[320px]">
              <SelectValue placeholder="Choose a checklist…" />
            </SelectTrigger>
            <SelectContent>
              {allTemplates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                  {t.specialty ? ` · ${t.specialty}` : ""}
                  {activeKeys.has(t.key) ? " · already active" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={() => templateId && activateM.mutate(templateId)}
            disabled={!templateId || activateM.isPending || (selected ? activeKeys.has(selected.key) : false)}
          >
            <Plus className="mr-1.5 h-4 w-4" /> Activate
          </Button>
          {selected && <TemplateDialog template={selected} />}
          <TemplateDialog />
        </CardContent>
      </Card>

      {listQ.isLoading ? (
        <ListSkeleton rows={3} />
      ) : active.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No checklists are active for this patient yet.
        </p>
      ) : (
        active.map((cl) => {
          const items = parseChecklistItems(cl.items);
          const state = parseChecklistState(cl.state);
          const { done, total } = checklistProgress(items, state);
          const late = items.filter((i) => {
            const l = checklistItemAlert(i, state, cl.activated_at).level;
            return l === "overdue" || l === "missed";
          }).length;
          return (
            <Card key={cl.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
                <div className="min-w-0">
                  <CardTitle className="text-base">{cl.name}</CardTitle>
                  <CardDescription>Activated {fmtDateTime(cl.activated_at)}</CardDescription>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {late > 0 && (
                    <Badge variant="outline" className="border-rose-500/50 text-rose-600 dark:text-rose-400">
                      {late} late
                    </Badge>
                  )}
                  <Badge variant={done === total && total > 0 ? "default" : "secondary"}>
                    {done}/{total}
                  </Badge>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${cl.name}`}
                    onClick={() => archiveM.mutate(cl.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="hidden gap-2 px-2.5 text-xs font-medium uppercase tracking-wide text-muted-foreground md:grid md:grid-cols-[1fr_190px_190px]">
                  <span>Task</span>
                  <span>Responsible (does it)</span>
                  <span>Accountable (owner)</span>
                </div>
                {items.map((item) => {
                  const st = state[item.key]?.status ?? "not_started";
                  const entry = state[item.key];
                  const raci = effectiveRaci(item, state);
                  const alert = checklistItemAlert(item, state, cl.activated_at);
                  const alertTone =
                    alert.level === "missed"
                      ? "border-rose-500/60 bg-rose-500/5"
                      : alert.level === "overdue"
                        ? "border-rose-500/40 bg-rose-500/5"
                        : alert.level === "soon"
                          ? "border-amber-500/40 bg-amber-500/5"
                          : "";
                  return (
                    <div
                      key={item.key}
                      className={`grid gap-2 rounded-md border p-2.5 md:grid-cols-[1fr_190px_190px] md:items-start ${alertTone}`}
                    >
                      <div className="flex items-start gap-2">
                        <button
                          type="button"
                          className={`mt-0.5 shrink-0 ${STATUS_STYLE[st]}`}
                          aria-label={`${item.label}: ${CHECKLIST_ITEM_STATUS_LABEL[st]} — click to change`}
                          onClick={() =>
                            itemM.mutate({
                              id: cl.id,
                              item_key: item.key,
                              status: NEXT_CHECKLIST_STATUS[st],
                            })
                          }
                        >
                          {STATUS_ICON[st]}
                        </button>
                        <div className="min-w-0 flex-1">
                          <p
                            className={`text-sm font-medium ${
                              st === "done"
                                ? "text-emerald-700 dark:text-emerald-300"
                                : st === "not_applicable"
                                  ? "text-muted-foreground line-through"
                                  : ""
                            }`}
                          >
                            {item.label}
                            {item.critical && (
                              <span className="ml-1.5 rounded-sm bg-muted px-1 py-0.5 align-middle text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                                Key
                              </span>
                            )}
                          </p>
                          {alert.level !== "none" && (
                            <p
                              className={`mt-0.5 flex items-center gap-1 text-xs font-medium ${
                                alert.level === "soon"
                                  ? "text-amber-600 dark:text-amber-400"
                                  : "text-rose-600 dark:text-rose-400"
                              }`}
                            >
                              {alert.level === "missed" ? (
                                <ShieldAlert className="h-3.5 w-3.5" />
                              ) : alert.level === "overdue" ? (
                                <AlertTriangle className="h-3.5 w-3.5" />
                              ) : (
                                <Clock className="h-3.5 w-3.5" />
                              )}
                              {CHECKLIST_ALERT_LABEL[alert.level]}
                              {alert.dueAt ? ` · ${dueRelativeLabel(alert.dueAt)}` : ""}
                            </p>
                          )}
                          {item.hint && <p className="text-xs text-muted-foreground">{item.hint}</p>}
                          <ItemNote
                            value={entry?.note ?? ""}
                            onSave={(note) => itemM.mutate({ id: cl.id, item_key: item.key, note })}
                          />
                          <div className="mt-1.5">
                            <p className="mb-1 text-xs text-muted-foreground">
                              Due by
                              {item.target_minutes
                                ? ` (target ${formatTargetMinutes(item.target_minutes)} from activation)`
                                : ""}
                            </p>
                            <DateTimePicker
                              className="max-w-[280px]"
                              value={alert.dueAt ?? ""}
                              onChange={(v) =>
                                itemM.mutate({
                                  id: cl.id,
                                  item_key: item.key,
                                  due_at: v ? new Date(v).toISOString() : null,
                                })
                              }
                            />
                          </div>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {CHECKLIST_ITEM_STATUS_LABEL[st]}
                            {entry?.at ? ` · updated ${fmtDateTime(entry.at)}` : ""}
                          </p>
                        </div>
                      </div>
                      <RolePicker
                        label={`Responsible for ${item.label}`}
                        mobileLabel="Responsible"
                        value={raci.responsible}
                        onChange={(responsible) =>
                          itemM.mutate({ id: cl.id, item_key: item.key, responsible })
                        }
                      />
                      <RolePicker
                        label={`Accountable owner for ${item.label}`}
                        mobileLabel="Accountable owner"
                        value={raci.accountable}
                        onChange={(accountable) =>
                          itemM.mutate({ id: cl.id, item_key: item.key, accountable })
                        }
                      />
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          );
        })
      )}
    </div>
  );
}

// Who does the item (responsible) and who owns it (accountable).
function RolePicker({
  label,
  mobileLabel,
  value,
  onChange,
}: {
  label: string;
  mobileLabel: string;
  value: ChecklistRole | null;
  onChange: (role: ChecklistRole | null) => void;
}) {
  return (
    <div className="min-w-0">
      <p className="mb-1 text-xs text-muted-foreground md:hidden">{mobileLabel}</p>
      <Select
        value={value ?? UNASSIGNED_ROLE}
        onValueChange={(v) => onChange(v === UNASSIGNED_ROLE ? null : (v as ChecklistRole))}
      >
        <SelectTrigger className="h-9 w-full min-w-0 text-xs" aria-label={label}>
          <SelectValue placeholder="Unassigned" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={UNASSIGNED_ROLE}>Unassigned</SelectItem>
          {CHECKLIST_ROLES.map((r) => (
            <SelectItem key={r} value={r}>
              {CHECKLIST_ROLE_LABEL[r]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// Free-text note for a single checklist item; saves on blur.
function ItemNote({ value, onSave }: { value: string; onSave: (note: string | null) => void }) {
  const [draft, setDraft] = useState(value);
  const [open, setOpen] = useState(value.trim() !== "");

  if (!open) {
    return (
      <button
        type="button"
        className="mt-1 text-xs text-muted-foreground underline underline-offset-2"
        onClick={() => setOpen(true)}
      >
        Add note
      </button>
    );
  }

  return (
    <Textarea
      className="mt-1.5 min-h-[60px] text-sm"
      placeholder="Note (e.g. sent 14:20, awaiting result)"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft.trim();
        if (next !== value.trim()) onSave(next === "" ? null : next);
      }}
    />
  );
}

type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  specialty: string | null;
  items: unknown;
};

function itemToLine(i: {
  label: string;
  hint?: string | null;
  responsible?: string | null;
  accountable?: string | null;
  target_minutes?: number | null;
  critical?: boolean | null;
}): string {
  const parts = [i.label, i.hint ?? ""];
  if (i.responsible || i.accountable || i.target_minutes || i.critical) {
    parts.push(roleLabel(i.responsible ?? null), roleLabel(i.accountable ?? null));
  }
  if (i.target_minutes || i.critical) parts.push(formatTargetMinutes(i.target_minutes ?? null));
  if (i.critical) parts.push("key");
  return parts.join(" | ").replace(/(\s*\|\s*)+$/, "");
}

function templateToLines(items: unknown): string {
  return parseChecklistItems(items).map(itemToLine).join("\n");
}

// Add a new checklist, or edit an existing one (including the standard
// checklists) so a unit can keep them in line with local guidelines.
// One item per line, optional guidance after a "|".
function TemplateDialog({ template }: { template?: TemplateRow | null }) {
  const isEdit = !!template;
  const qc = useQueryClient();
  const create = useServerFn(createChecklistTemplate);
  const update = useServerFn(updateChecklistTemplate);
  const draft = useServerFn(draftChecklist);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(template?.name ?? "");
  const [specialty, setSpecialty] = useState(template?.specialty ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [lines, setLines] = useState(template ? templateToLines(template.items) : "");
  const [topic, setTopic] = useState("");

  const reset = () => {
    setName(template?.name ?? "");
    setSpecialty(template?.specialty ?? "");
    setDescription(template?.description ?? "");
    setLines(template ? templateToLines(template.items) : "");
    setTopic("");
  };

  const draftM = useMutation({
    mutationFn: () =>
      draft({ data: { topic: topic.trim(), specialty: specialty.trim() || null } }),
    onSuccess: (d) => {
      if (!name.trim()) setName(d.name);
      if (!specialty.trim() && d.specialty) setSpecialty(d.specialty);
      if (!description.trim() && d.description) setDescription(d.description);
      setLines(d.items.map(itemToLine).join("\n"));
      toast.success("Draft ready — review and edit before saving");
    },
    onError: (e: Error) => toast.error(e.message || "Could not draft a checklist"),
  });

  const saveM = useMutation({
    mutationFn: () => {
      const items = lines
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "")
        .map((l, i) => {
          const [label, hint, responsible, accountable, target, flag] = l.split("|");
          return {
            key: `item_${i + 1}`,
            label: (label ?? "").trim(),
            hint: hint && hint.trim() !== "" ? hint.trim() : null,
            responsible: matchRole(responsible),
            accountable: matchRole(accountable),
            target_minutes: parseTargetMinutes(target),
            critical: /^(key|critical)$/i.test((flag ?? "").trim()),
          };
        })
        .filter((i) => i.label !== "");
      if (items.length === 0) throw new Error("Add at least one checklist item");
      const payload = {
        name: name.trim(),
        specialty: specialty.trim() || null,
        description: description.trim() || null,
        items,
      };
      return isEdit
        ? update({ data: { id: template!.id, ...payload } })
        : create({ data: payload });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["checklist-templates"] });
      setOpen(false);
      if (!isEdit) reset();
      setTopic("");
      toast.success(isEdit ? "Checklist updated" : "Checklist created");
    },
    onError: (e: Error) =>
      toast.error(e.message || (isEdit ? "Could not update checklist" : "Could not create checklist")),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger asChild>
        {isEdit ? (
          <Button variant="outline">
            <Pencil className="mr-1.5 h-4 w-4" /> Edit
          </Button>
        ) : (
          <Button variant="outline">
            <Plus className="mr-1.5 h-4 w-4" /> New checklist
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit checklist" : "New checklist"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Changes apply to checklists activated from now on; checklists already open on a patient keep their current items."
              : "Available to every patient in the units you work in."}{" "}
            One item per line, separated by vertical bars: task | guidance | responsible |
            accountable owner | target time | key — e.g. "Blood cultures | before antibiotics |
            Bedside nurse | ICU trainee / registrar | 1h | key". Everything after the task is
            optional; a target time (30m, 1h, 2d) sets the deadline from activation, and "key" marks
            an item that must not be missed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="rounded-md border bg-muted/40 p-3">
            <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
              <Sparkles className="h-4 w-4" /> Draft with the AI assistant
            </p>
            <p className="mb-2 text-xs text-muted-foreground">
              Describe the checklist you want and it will suggest items with the criteria for
              each. No patient information is sent.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                className="min-w-0"
                placeholder="e.g. Sepsis first 6 hours, or DKA management"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && topic.trim().length >= 3 && !draftM.isPending) {
                    e.preventDefault();
                    draftM.mutate();
                  }
                }}
              />
              <Button
                variant="secondary"
                className="shrink-0"
                onClick={() => draftM.mutate()}
                disabled={topic.trim().length < 3 || draftM.isPending}
              >
                {draftM.isPending ? "Drafting…" : "Generate"}
              </Button>
            </div>
          </div>
          <Input placeholder="Checklist name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input
            placeholder="Specialty (optional)"
            value={specialty}
            onChange={(e) => setSpecialty(e.target.value)}
          />
          <Textarea
            placeholder="What this checklist is for (optional)"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <Textarea
            className="min-h-[160px]"
            placeholder={
              "Blood cultures | before antibiotics | Bedside nurse | ICU trainee / registrar | 1h | key\nChest X-ray reviewed"
            }
            value={lines}
            onChange={(e) => setLines(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => saveM.mutate()}
            disabled={name.trim().length < 2 || saveM.isPending}
          >
            {isEdit ? "Save changes" : "Create checklist"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
