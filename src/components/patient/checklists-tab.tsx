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
} from "@/lib/checklists.functions";
import { draftChecklist } from "@/lib/checklist-ai.functions";
import {
  CHECKLIST_ITEM_STATUS_LABEL,
  NEXT_CHECKLIST_STATUS,
  checklistProgress,
  parseChecklistItems,
  parseChecklistState,
  type ChecklistItemStatus,
} from "@/lib/checklists";
import { fmtDateTime } from "@/lib/icu";
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
  Plus,
  Sparkles,
  Trash2,
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
    mutationFn: (v: { id: string; item_key: string; status?: ChecklistItemStatus; note?: string | null }) =>
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
  const available = (templatesQ.data ?? []).filter((t) => !activeKeys.has(t.key));

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="h-4 w-4" /> Management checklists
          </CardTitle>
          <CardDescription>
            Activate the checklists relevant to this patient. Each item can be marked not started, in
            progress, done or not applicable, with a note.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          <Select value={templateId} onValueChange={setTemplateId}>
            <SelectTrigger className="w-full min-w-0 sm:w-[320px]">
              <SelectValue placeholder={available.length ? "Choose a checklist…" : "All checklists activated"} />
            </SelectTrigger>
            <SelectContent>
              {available.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.name}
                  {t.specialty ? ` · ${t.specialty}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={() => templateId && activateM.mutate(templateId)}
            disabled={!templateId || activateM.isPending}
          >
            <Plus className="mr-1.5 h-4 w-4" /> Activate
          </Button>
          <NewTemplateDialog />
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
          return (
            <Card key={cl.id}>
              <CardHeader className="flex flex-row items-start justify-between gap-3 pb-2">
                <div className="min-w-0">
                  <CardTitle className="text-base">{cl.name}</CardTitle>
                  <CardDescription>Activated {fmtDateTime(cl.activated_at)}</CardDescription>
                </div>
                <div className="flex shrink-0 items-center gap-2">
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
                {items.map((item) => {
                  const st = state[item.key]?.status ?? "not_started";
                  const entry = state[item.key];
                  return (
                    <div key={item.key} className="rounded-md border p-2.5">
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
                          </p>
                          {item.hint && <p className="text-xs text-muted-foreground">{item.hint}</p>}
                          <ItemNote
                            value={entry?.note ?? ""}
                            onSave={(note) => itemM.mutate({ id: cl.id, item_key: item.key, note })}
                          />
                          <p className="mt-1 text-xs text-muted-foreground">
                            {CHECKLIST_ITEM_STATUS_LABEL[st]}
                            {entry?.at ? ` · updated ${fmtDateTime(entry.at)}` : ""}
                          </p>
                        </div>
                      </div>
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

// Lets a unit add its own checklist for future use; one item per line,
// optional guidance after a "|".
function NewTemplateDialog() {
  const qc = useQueryClient();
  const create = useServerFn(createChecklistTemplate);
  const draft = useServerFn(draftChecklist);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [specialty, setSpecialty] = useState("");
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState("");
  const [topic, setTopic] = useState("");

  const draftM = useMutation({
    mutationFn: () =>
      draft({ data: { topic: topic.trim(), specialty: specialty.trim() || null } }),
    onSuccess: (d) => {
      if (!name.trim()) setName(d.name);
      if (!specialty.trim() && d.specialty) setSpecialty(d.specialty);
      if (!description.trim() && d.description) setDescription(d.description);
      setLines(
        d.items.map((i) => (i.hint ? `${i.label} | ${i.hint}` : i.label)).join("\n"),
      );
      toast.success("Draft ready — review and edit before saving");
    },
    onError: (e: Error) => toast.error(e.message || "Could not draft a checklist"),
  });

  const createM = useMutation({
    mutationFn: () => {
      const items = lines
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "")
        .map((l, i) => {
          const [label, hint] = l.split("|");
          return {
            key: `item_${i + 1}`,
            label: (label ?? "").trim(),
            hint: hint ? hint.trim() : null,
          };
        })
        .filter((i) => i.label !== "");
      if (items.length === 0) throw new Error("Add at least one checklist item");
      return create({
        data: {
          name: name.trim(),
          specialty: specialty.trim() || null,
          description: description.trim() || null,
          items,
        },
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["checklist-templates"] });
      setOpen(false);
      setName("");
      setSpecialty("");
      setDescription("");
      setLines("");
      setTopic("");
      toast.success("Checklist created");
    },
    onError: (e: Error) => toast.error(e.message || "Could not create checklist"),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Plus className="mr-1.5 h-4 w-4" /> New checklist
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New checklist</DialogTitle>
          <DialogDescription>
            Available to every patient in the units you work in. One item per line; add optional
            guidance after a vertical bar, e.g. "Sputum sample | culture and sensitivity".
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
            placeholder={"Viral swabs sent | respiratory viral PCR\nChest X-ray reviewed"}
            value={lines}
            onChange={(e) => setLines(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => createM.mutate()}
            disabled={name.trim().length < 2 || createM.isPending}
          >
            Create checklist
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
