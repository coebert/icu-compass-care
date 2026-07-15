import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DatePicker } from "@/components/ui/date-picker";
import { Pencil, Check, X, CheckCircle2, Loader2, AlertCircle } from "lucide-react";
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patient", patientId] });
      qc.invalidateQueries({ queryKey: ["patient-field-changes", patientId] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to save"),
  });
}

/** Fades a "Saved" confirmation ~2.5s after the last successful save. */
export function useSavedIndicator() {
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
  const markSaved = () => {
    setSavedAt(Date.now());
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setSavedAt(null), 2500);
  };
  const clear = () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setSavedAt(null);
  };
  return { savedAt, markSaved, clear };
}

/** Inline status line: Saving… / Saved / error, sized to sit under a field. */
export function FieldStatus({
  mut,
  savedAt,
}: {
  mut: { isPending: boolean; isError: boolean; error: unknown };
  savedAt: number | null;
}) {
  if (mut.isPending) {
    return (
      <p className="flex items-center gap-1 text-xs text-muted-foreground" aria-live="polite">
        <Loader2 className="h-3 w-3 animate-spin" /> Saving…
      </p>
    );
  }
  if (mut.isError) {
    const msg = (mut.error as { message?: string } | null)?.message ?? "Save failed";
    return (
      <p className="flex items-start gap-1 text-xs text-destructive" role="alert">
        <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" /> {msg}
      </p>
    );
  }
  if (savedAt) {
    return (
      <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400" aria-live="polite">
        <CheckCircle2 className="h-3 w-3" /> Saved
      </p>
    );
  }
  return null;
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
  required,
  validate,
  coerce,
}: {
  patientId: string;
  field: string;
  label: string;
  value?: string | null;
  multiline?: boolean;
  placeholder?: string;
  required?: boolean;
  /** Return an error message to block save, or null when valid. */
  validate?: (trimmed: string) => string | null;
  /** Transform the trimmed string into the payload value (e.g. Number). */
  coerce?: (trimmed: string) => unknown;
}) {
  const mut = usePatientFieldMutation(patientId);
  const { savedAt, markSaved, clear } = useSavedIndicator();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    setDraft(value ?? "");
    setError(null);
    setEditing(true);
  };

  const runValidation = (next: string): string | null => {
    if (required && next === "") return `${label.replace(/\s*\*$/, "")} is required.`;
    if (validate) return validate(next);
    return null;
  };

  const save = () => {
    const next = draft.trim();
    if (next === (value?.trim() ?? "")) {
      setEditing(false);
      return;
    }
    const err = runValidation(next);
    if (err) {
      setError(err);
      return;
    }
    const payload = next === "" ? null : coerce ? coerce(next) : next;
    clear();
    mut.mutate(
      { [field]: payload },
      { onSuccess: () => { setEditing(false); markSaved(); } },
    );
  };

  const onChange = (v: string) => {
    setDraft(v);
    if (error) setError(runValidation(v.trim()));
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
              aria-invalid={!!error}
              onChange={(e) => onChange(e.target.value)}
              rows={3}
            />
          ) : (
            <Input
              autoFocus
              value={draft}
              placeholder={placeholder}
              disabled={mut.isPending}
              aria-invalid={!!error}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          )}
          {error && <p className="text-xs text-destructive">{error}</p>}
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
          <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100 md:opacity-0" />
        </button>
      )}
      <FieldStatus mut={mut} savedAt={savedAt} />
    </div>
  );
}

/**
 * Inline-editable select bound to a single patient column. Same click-to-edit
 * pattern as EditableField but for enum values (sex, status, location).
 */
export function EditableSelect({
  patientId,
  field,
  label,
  value,
  options,
  placeholder,
  allowClear,
  required,
}: {
  patientId: string;
  field: string;
  label: string;
  value?: string | null;
  options: { value: string; label: string }[];
  placeholder?: string;
  allowClear?: boolean;
  /** When true, an empty value is rejected and the "Clear" button is suppressed. */
  required?: boolean;
}) {
  const mut = usePatientFieldMutation(patientId);
  const { savedAt, markSaved, clear } = useSavedIndicator();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const allowed = options.map((o) => o.value);
  const displayLabel = options.find((o) => o.value === value)?.label ?? (value?.trim() ? value : "—");
  const currentValueValid = value == null || value === "" || allowed.includes(value);

  const start = () => {
    setDraft(value ?? "");
    setError(null);
    setEditing(true);
  };

  const save = (next: string) => {
    if (next === (value ?? "")) {
      setEditing(false);
      return;
    }
    if (next === "") {
      if (required) {
        setError(`${label.replace(/\s*\*$/, "")} is required.`);
        return;
      }
    } else if (!allowed.includes(next)) {
      setError(`Invalid value. Choose one of: ${options.map((o) => o.label).join(", ")}.`);
      return;
    }
    setError(null);
    clear();
    mut.mutate(
      { [field]: next || null },
      { onSuccess: () => { setEditing(false); markSaved(); } },
    );
  };

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {editing ? (
        <div className="mt-1 space-y-2">
          <div className="flex items-center gap-2">
            <Select value={draft || undefined} onValueChange={(v) => { setDraft(v); save(v); }}>
              <SelectTrigger className="h-9" aria-invalid={!!error}>
                <SelectValue placeholder={placeholder ?? "Select…"} />
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {allowClear && !required && (
              <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => save("")}>
                Clear
              </Button>
            )}
            <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => setEditing(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      ) : (
        <button
          type="button"
          onClick={start}
          className="group mt-1 flex w-full items-start gap-2 rounded-md text-left hover:bg-muted/50"
        >
          <span className="flex-1 text-sm">{displayLabel}</span>
          <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100 md:opacity-0" />
        </button>
      )}
      {!editing && required && (value == null || value === "") && (
        <p className="mt-1 text-xs text-destructive">This field is required.</p>
      )}
      {!editing && !currentValueValid && (
        <p className="mt-1 text-xs text-destructive">
          Stored value "{value}" is not one of the allowed options; please pick a valid one.
        </p>
      )}
      <FieldStatus mut={mut} savedAt={savedAt} />
    </div>
  );
}

/**
 * Inline-editable date field (yyyy-MM-dd) bound to a single patient column.
 */
export function EditableDate({
  patientId,
  field,
  label,
  value,
  displayFormatter,
}: {
  patientId: string;
  field: string;
  label: string;
  value?: string | null;
  displayFormatter?: (v: string) => string;
}) {
  const mut = usePatientFieldMutation(patientId);
  const { savedAt, markSaved, clear } = useSavedIndicator();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const start = () => {
    setDraft(value ? value.slice(0, 10) : "");
    setEditing(true);
  };
  const save = () => {
    if ((draft || "") === (value?.slice(0, 10) ?? "")) {
      setEditing(false);
      return;
    }
    clear();
    mut.mutate(
      { [field]: draft || null },
      { onSuccess: () => { setEditing(false); markSaved(); } },
    );
  };

  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      {editing ? (
        <div className="mt-1 flex items-center gap-2">
          <DatePicker value={draft} onChange={setDraft} />
          <Button type="button" size="sm" className="h-8" onClick={save} disabled={mut.isPending}>
            <Check className="h-4 w-4" />
          </Button>
          <Button type="button" size="sm" variant="ghost" className="h-8" onClick={() => setEditing(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={start}
          className="group mt-1 flex w-full items-start gap-2 rounded-md text-left hover:bg-muted/50"
        >
          <span className="flex-1 text-sm">
            {value?.trim() ? (displayFormatter ? displayFormatter(value) : value.slice(0, 10)) : "—"}
          </span>
          <Pencil className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100 md:opacity-0" />
        </button>
      )}
      <FieldStatus mut={mut} savedAt={savedAt} />
    </div>
  );
}


