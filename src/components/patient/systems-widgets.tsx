import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Pencil, Check, X } from "lucide-react";
import { updatePatient } from "@/lib/patients.functions";

export type SystemOption = { value: string; label: string };

/**
 * Shared mutation for patching arbitrary patient fields from the systems-review
 * widgets. Every widget saved the same way (patch → invalidate patient query →
 * toast on error); this centralises that so each widget only declares *what* it
 * changes, not the plumbing.
 */
export function usePatientFieldMutation(patientId: string) {
  const qc = useQueryClient();
  const update = useServerFn(updatePatient);
  return useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      update({ data: { id: patientId, ...patch } as never }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["patient", patientId] }),
    onError: (e: any) => toast.error(e?.message ?? "Failed to save"),
  });
}

/** A labelled row of checkboxes bound to a set of options. */
export function CheckboxOptionGroup({
  label,
  options,
  isChecked,
  onToggle,
  disabled,
}: {
  label: string;
  options: SystemOption[];
  isChecked: (value: string) => boolean;
  onToggle: (value: string) => void;
  disabled?: boolean;
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
              checked={isChecked(opt.value)}
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

function toggleValue(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/**
 * A systems card whose only control is a single multi-select array field
 * (e.g. vasoactive agents, anticoagulation) plus a free-text notes block.
 * Replaces several near-identical widgets that differed only by field name,
 * options, and labels.
 */
export function SystemMultiSelectCard({
  patientId,
  selected,
  arrayField,
  groupLabel,
  options,
  notesLabel,
  notesField,
  notes,
}: {
  patientId: string;
  selected: string[];
  arrayField: string;
  groupLabel: string;
  options: SystemOption[];
  notesLabel: string;
  notesField: string;
  notes?: string | null;
}) {
  const mut = usePatientFieldMutation(patientId);
  return (
    <div className="sm:col-span-2 space-y-4 rounded-lg border p-4">
      <CheckboxOptionGroup
        label={groupLabel}
        options={options}
        isChecked={(v) => selected.includes(v)}
        onToggle={(v) => mut.mutate({ [arrayField]: toggleValue(selected, v) })}
        disabled={mut.isPending}
      />
      <EditableField
        patientId={patientId}
        field={notesField}
        label={notesLabel}
        value={notes}
        multiline
      />
    </div>
  );
}

/**
 * An inline-editable field bound to a single patient column. Shows the current
 * value as read-only text with a small pencil; clicking it reveals an input
 * (single-line) or textarea (multiline) with save/cancel, saved directly from
 * this page without opening the full edit dialog.
 */
export function EditableField({
  patientId,
  field,
  label,
  value,
  multiline,
  placeholder,
}: {
  patientId: string;
  field: string;
  label: string;
  value?: string | null;
  multiline?: boolean;
  placeholder?: string;
}) {
  const mut = usePatientFieldMutation(patientId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const start = () => {
    setDraft(value ?? "");
    setEditing(true);
  };

  const save = () => {
    const next = draft.trim();
    if (next === (value?.trim() ?? "")) {
      setEditing(false);
      return;
    }
    mut.mutate(
      { [field]: next || null },
      { onSuccess: () => setEditing(false) },
    );
  };

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {editing ? (
        <div className="mt-1 space-y-2">
          {multiline ? (
            <Textarea
              autoFocus
              value={draft}
              placeholder={placeholder}
              disabled={mut.isPending}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
            />
          ) : (
            <Input
              autoFocus
              value={draft}
              placeholder={placeholder}
              disabled={mut.isPending}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          )}
          <div className="flex gap-2">
            <Button type="button" size="sm" className="h-8" disabled={mut.isPending} onClick={save}>
              <Check className="mr-1 h-4 w-4" /> Save
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8"
              disabled={mut.isPending}
              onClick={() => setEditing(false)}
            >
              <X className="mr-1 h-4 w-4" /> Cancel
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={start}
          className="group mt-1 flex w-full items-start gap-2 rounded-md text-left hover:bg-muted/50"
        >
          <span className="flex-1 whitespace-pre-wrap text-sm">{value?.trim() ? value : "—"}</span>
          <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
      )}
    </div>
  );
}

