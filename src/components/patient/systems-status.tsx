import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { updatePatient, listAntimicrobialNames } from "@/lib/patients.functions";
import { SpecimenTypeCombobox } from "@/components/SpecimenTypeCombobox";
import {
  CheckboxOptionGroup,
  SystemMultiSelectCard,
  EditableField,
  usePatientFieldMutation,
} from "@/components/patient/systems-widgets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Trash2, Plus, Pencil, Check, X } from "lucide-react";
import { courseDays, type Antimicrobial } from "@/lib/antimicrobials";
import { toast } from "sonner";

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

export function RespiratoryStatus({
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
      <EditableField patientId={patientId} field="resp_fio2" label="Current FiO2" value={patient.resp_fio2} placeholder="e.g. 0.4" />
      <EditableField patientId={patientId} field="systems_resp" label="Resp notes" value={patient.systems_resp} multiline />
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

export function CardiovascularStatus({
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
      notesField="systems_cvs"
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

export function HaemStatus({
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
      notesField="systems_haem"
      notes={patient.systems_haem}
    />
  );
}

export function RenalStatus({
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
      <EditableField patientId={patientId} field="systems_renal" label="Renal notes" value={patient.systems_renal} multiline />
    </div>
  );
}

export function MicroStatus({
  patientId,
  patient,
}: {
  patientId: string;
  patient: Record<string, any>;
}) {
  const qc = useQueryClient();
  const update = useServerFn(updatePatient);
  const fetchNames = useServerFn(listAntimicrobialNames);
  const { data: nameOptions = [] } = useQuery({
    queryKey: ["antimicrobial-names"],
    queryFn: () => fetchNames(),
    staleTime: 60_000,
  });

  const agents: Antimicrobial[] = Array.isArray(patient.antimicrobials)
    ? patient.antimicrobials
    : [];

  const [name, setName] = useState("");
  const [startedOn, setStartedOn] = useState(
    () => new Date().toISOString().slice(0, 10),
  );

  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editStart, setEditStart] = useState("");

  const mut = useMutation({
    mutationFn: (next: Antimicrobial[]) =>
      update({ data: { id: patientId, antimicrobials: next } as never }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patient", patientId] });
      qc.invalidateQueries({ queryKey: ["antimicrobial-names"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed to save"),
  });

  // Merge saved names with any already on this patient so freshly-entered
  // agents are immediately available as suggestions.
  const agentOptions = Array.from(
    new Set([
      ...nameOptions,
      ...agents.map((a) => a.name?.trim()).filter((n): n is string => !!n),
    ]),
  ).sort((a, b) => a.localeCompare(b));

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

  const startEdit = (idx: number, a: Antimicrobial) => {
    setEditingIdx(idx);
    setEditName(a.name ?? "");
    setEditStart(a.started_on ?? "");
  };

  const cancelEdit = () => {
    setEditingIdx(null);
  };

  const saveEdit = (idx: number) => {
    const trimmed = editName.trim();
    if (!trimmed || !editStart) return;
    mut.mutate(
      agents.map((a, i) =>
        i === idx ? { ...a, name: trimmed, started_on: editStart } : a,
      ),
      { onSuccess: () => setEditingIdx(null) },
    );
  };

  const indexed = agents.map((a, i) => ({ a, i }));
  const current = indexed.filter(({ a }) => !a.ended_on);
  const completed = indexed.filter(({ a }) => !!a.ended_on);

  const renderItem = ({ a, i }: { a: Antimicrobial; i: number }) => {
    const days = courseDays(a.started_on, a.ended_on);
    const isCompleted = !!a.ended_on;
    const isEditing = editingIdx === i;
    return (
      <li
        key={i}
        className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ${
          isCompleted ? "opacity-70" : "border-primary/30 bg-primary/5"
        }`}
      >
        {isEditing ? (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="flex-1 min-w-[180px]">
                <label className="mb-1 block text-xs text-muted-foreground">Agent</label>
                <SpecimenTypeCombobox
                  value={editName}
                  onChange={setEditName}
                  options={agentOptions}
                  placeholder="Search or type agent…"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-muted-foreground">Start date</label>
                <Input
                  type="date"
                  className="h-8 w-[9.5rem]"
                  value={editStart}
                  max={new Date().toISOString().slice(0, 10)}
                  disabled={mut.isPending}
                  onChange={(e) => setEditStart(e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                className="h-8"
                disabled={mut.isPending || !editName.trim() || !editStart}
                onClick={() => saveEdit(i)}
              >
                <Check className="mr-1 h-4 w-4" /> Save
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-8"
                disabled={mut.isPending}
                onClick={cancelEdit}
              >
                <X className="mr-1 h-4 w-4" /> Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
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
                onClick={() => startEdit(i, a)}
              >
                <Pencil className="mr-1 h-4 w-4" /> Edit
              </Button>
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
          </>
        )}
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
      <EditableField patientId={patientId} field="systems_micro" label="Micro notes" value={patient.systems_micro} multiline />
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

export function NeuroStatus({
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
      <EditableField patientId={patientId} field="systems_neuro" label="CNS / Neuro notes" value={patient.systems_neuro} multiline />
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

export function GastroNutritionStatus({
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
      <EditableField patientId={patientId} field="systems_gastro" label="Gastro / Nutri notes" value={patient.systems_gastro} multiline />
    </div>
  );
}
