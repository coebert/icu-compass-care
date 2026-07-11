import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePicker, DateTimePicker } from "@/components/ui/date-picker";
import { Plus, Trash2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ALLERGY_SEVERITIES,
  ALLERGY_SEVERITY_LABEL,
  DAILY_GOAL_ITEMS,
  parseAllergies,
  parseDailyGoals,
  type AllergyEntry,
  type AllergySeverity,
  type DailyGoals,
} from "@/lib/patient-safety";

export type PatientFormValues = {
  full_name: string;
  hospital_number: string;
  age: string;
  location_type: "icu" | "outlier";
  ward: string;
  bed: string;
  status: "referred" | "admitted" | "discharged" | "died";
  admission_date: string;
  discharge_date: string;
  discharge_destination: string;
  date_of_death: string;
  past_medical_history: string;
  current_admission: string;
  current_management: string;
  outstanding_tasks: string;
  systems_resp: string;
  resp_fio2: string;
  systems_cvs: string;
  systems_neuro: string;
  systems_renal: string;
  systems_gastro: string;
  systems_haem: string;
  systems_micro: string;
  systems_other: string;
  isolation_required: boolean;
  tep_in_place: boolean;
  tep_details: string;
  dnacpr_decision: boolean;
  dnacpr_details: string;
  dnacpr_date: string;
  nok_name: string;
  nok_relationship: string;
  nok_contact: string;
  nok_last_updated: string;
  nok_last_updated_by: string;
  weight_kg: string;
  allergies: AllergyEntry[];
  daily_goals: DailyGoals;
  daily_goals_reviewed_by: string;
  daily_goals_reviewed_at: string;
};

export function emptyPatient(): PatientFormValues {
  return {
    full_name: "",
    hospital_number: "",
    age: "",
    location_type: "icu",
    ward: "",
    bed: "",
    status: "admitted",
    admission_date: "",
    discharge_date: "",
    discharge_destination: "",
    date_of_death: "",
    past_medical_history: "",
    current_admission: "",
    current_management: "",
    outstanding_tasks: "",
    systems_resp: "",
    resp_fio2: "",
    systems_cvs: "",
    systems_neuro: "",
    systems_renal: "",
    systems_gastro: "",
    systems_haem: "",
    systems_micro: "",
    systems_other: "",
    isolation_required: false,
    tep_in_place: false,
    tep_details: "",
    dnacpr_decision: false,
    dnacpr_details: "",
    dnacpr_date: "",
    nok_name: "",
    nok_relationship: "",
    nok_contact: "",
    nok_last_updated: "",
    nok_last_updated_by: "",
    weight_kg: "",
    allergies: [],
    daily_goals: {},
    daily_goals_reviewed_by: "",
    daily_goals_reviewed_at: "",
  };
}

export function toFormValues(p: Record<string, unknown>): PatientFormValues {
  const base = emptyPatient();
  const out = { ...base };
  for (const key of Object.keys(base) as (keyof PatientFormValues)[]) {
    const v = p[key];
    if (v === null || v === undefined) continue;
    if (key === "allergies") {
      out.allergies = parseAllergies(v);
    } else if (key === "daily_goals") {
      out.daily_goals = parseDailyGoals(v);
    } else if (key === "nok_last_updated" && typeof v === "string") {
      // datetime-local expects yyyy-MM-ddThh:mm
      out[key] = v.slice(0, 16) as never;
    } else {
      (out as Record<string, unknown>)[key] = typeof v === "boolean" ? v : String(v);
    }
  }
  return out;
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

export function PatientForm({
  values,
  onChange,
  onSubmit,
  onCancel,
  submitting,
  submitLabel,
}: {
  values: PatientFormValues;
  onChange: (v: PatientFormValues) => void;
  onSubmit: () => void;
  onCancel: () => void;
  submitting?: boolean;
  submitLabel: string;
}) {
  const set = <K extends keyof PatientFormValues>(k: K, v: PatientFormValues[K]) =>
    onChange({ ...values, [k]: v });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-6"
    >
      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Identity & location
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Initials *">
            <Input id="pf-full_name" value={values.full_name} onChange={(e) => set("full_name", e.target.value)} maxLength={10} placeholder="e.g. J.S." required />
          </Field>
          <Field label="Age *">
            <Input type="number" min={0} max={130} step={1} value={values.age} onChange={(e) => set("age", e.target.value)} required />
          </Field>
          <Field label="Hospital number">
            <Input id="pf-hospital_number" value={values.hospital_number} onChange={(e) => set("hospital_number", e.target.value)} />
          </Field>
          <Field label="Weight (kg)">
            <Input type="number" min={0} max={600} step="0.1" value={values.weight_kg} onChange={(e) => set("weight_kg", e.target.value)} placeholder="e.g. 78" />
          </Field>
          <Field label="Location">
            <Select value={values.location_type} onValueChange={(v) => set("location_type", v as PatientFormValues["location_type"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="icu">ICU</SelectItem>
                <SelectItem value="outlier">Outlying ward / referral</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Status">
            <Select value={values.status} onValueChange={(v) => set("status", v as PatientFormValues["status"])}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="referred">Referred (outlier)</SelectItem>
                <SelectItem value="admitted">Admitted</SelectItem>
                <SelectItem value="discharged">Discharged</SelectItem>
                <SelectItem value="died">Died</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Ward"><Input id="pf-ward" value={values.ward} onChange={(e) => set("ward", e.target.value)} /></Field>
          <Field label="Bed"><Input value={values.bed} onChange={(e) => set("bed", e.target.value)} /></Field>
          <Field label="Admission date">
            <DatePicker value={values.admission_date} onChange={(v) => set("admission_date", v)} />
          </Field>
          {values.status === "discharged" && (
            <>
              <Field label="Discharge date">
                <DatePicker value={values.discharge_date} onChange={(v) => set("discharge_date", v)} />
              </Field>
              <Field label="Discharge destination">
                <Input value={values.discharge_destination} onChange={(e) => set("discharge_destination", e.target.value)} />
              </Field>
            </>
          )}
          {values.status === "died" && (
            <Field label="Date of death">
              <DatePicker value={values.date_of_death} onChange={(v) => set("date_of_death", v)} />
            </Field>
          )}
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Clinical summary</h3>
        <Field label="Past medical history">
          <Textarea rows={3} value={values.past_medical_history} onChange={(e) => set("past_medical_history", e.target.value)} />
        </Field>
        <Field label="Current admission">
          <Textarea id="pf-current_admission" rows={3} value={values.current_admission} onChange={(e) => set("current_admission", e.target.value)} />
        </Field>
        <Field label="Current management">
          <Textarea rows={3} value={values.current_management} onChange={(e) => set("current_management", e.target.value)} />
        </Field>
        <Field label="Outstanding tasks">
          <Textarea rows={3} value={values.outstanding_tasks} onChange={(e) => set("outstanding_tasks", e.target.value)} />
        </Field>
      </section>

      <section className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Allergies</h3>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() =>
              set("allergies", [...values.allergies, { substance: "", reaction: "", severity: "unknown" }])
            }
          >
            <Plus className="h-4 w-4" /> Add allergy
          </Button>
        </div>
        {values.allergies.length === 0 ? (
          <p className="text-sm text-muted-foreground">No known allergies recorded.</p>
        ) : (
          <div className="space-y-3">
            {values.allergies.map((a, i) => (
              <div key={i} className="grid gap-2 rounded-lg border p-3 sm:grid-cols-[1fr_1fr_9rem_auto]">
                <Input
                  placeholder="Substance *"
                  value={a.substance}
                  onChange={(e) => {
                    const next = [...values.allergies];
                    next[i] = { ...a, substance: e.target.value };
                    set("allergies", next);
                  }}
                />
                <Input
                  placeholder="Reaction"
                  value={a.reaction ?? ""}
                  onChange={(e) => {
                    const next = [...values.allergies];
                    next[i] = { ...a, reaction: e.target.value };
                    set("allergies", next);
                  }}
                />
                <Select
                  value={a.severity ?? "unknown"}
                  onValueChange={(v) => {
                    const next = [...values.allergies];
                    next[i] = { ...a, severity: v as AllergySeverity };
                    set("allergies", next);
                  }}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ALLERGY_SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s}>{ALLERGY_SEVERITY_LABEL[s]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="text-destructive"
                  aria-label="Remove allergy"
                  onClick={() => set("allergies", values.allergies.filter((_, j) => j !== i))}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Daily goals</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {DAILY_GOAL_ITEMS.map((item) => (
            <label key={item.key} className="flex items-start gap-3 rounded-lg border p-3 cursor-pointer">
              <Checkbox
                checked={!!values.daily_goals[item.key]}
                onCheckedChange={(v) =>
                  onChange({
                    ...values,
                    daily_goals: { ...values.daily_goals, [item.key]: v === true },
                    daily_goals_reviewed_at: new Date().toISOString(),
                  })
                }
                className="mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium">{item.label}</span>
                <span className="block text-xs text-muted-foreground">{item.hint}</span>
              </span>
            </label>
          ))}
        </div>
        <Field label="Daily goals reviewed by (staff name)">
          <Input value={values.daily_goals_reviewed_by} onChange={(e) => set("daily_goals_reviewed_by", e.target.value)} />
        </Field>
      </section>


      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Systems review
        </h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Resp">
            <Textarea rows={3} value={values.systems_resp} onChange={(e) => set("systems_resp", e.target.value)} />
          </Field>
          <Field label="Current FiO2">
            <Input
              value={values.resp_fio2}
              onChange={(e) => set("resp_fio2", e.target.value)}
              placeholder="e.g. 0.4 or 40% via HFNC"
            />
          </Field>
          <Field label="CVS">
            <Textarea rows={3} value={values.systems_cvs} onChange={(e) => set("systems_cvs", e.target.value)} />
          </Field>
          <Field label="CNS / Neuro">
            <Textarea rows={3} value={values.systems_neuro} onChange={(e) => set("systems_neuro", e.target.value)} />
          </Field>
          <Field label="Renal">
            <Textarea rows={3} value={values.systems_renal} onChange={(e) => set("systems_renal", e.target.value)} />
          </Field>
          <Field label="Gastro / Nutri">
            <Textarea rows={3} value={values.systems_gastro} onChange={(e) => set("systems_gastro", e.target.value)} />
          </Field>
          <Field label="Haem">
            <Textarea rows={3} value={values.systems_haem} onChange={(e) => set("systems_haem", e.target.value)} />
          </Field>
          <Field label="Micro">
            <Textarea rows={3} value={values.systems_micro} onChange={(e) => set("systems_micro", e.target.value)} />
          </Field>
          <Field label="Other">
            <Textarea rows={3} value={values.systems_other} onChange={(e) => set("systems_other", e.target.value)} />
          </Field>
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Placement & isolation
        </h3>
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">Isolation required</p>
            <p className="text-xs text-muted-foreground">Patient must be placed in a side room only</p>
          </div>
          <Switch checked={values.isolation_required} onCheckedChange={(v) => set("isolation_required", v)} />
        </div>
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Escalation & resuscitation
        </h3>
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">Treatment escalation plan (TEP) in place</p>
            <p className="text-xs text-muted-foreground">Record ceiling of care / escalation decisions</p>
          </div>
          <Switch checked={values.tep_in_place} onCheckedChange={(v) => set("tep_in_place", v)} />
        </div>
        {values.tep_in_place && (
          <Field label="TEP details">
            <Textarea rows={2} value={values.tep_details} onChange={(e) => set("tep_details", e.target.value)} />
          </Field>
        )}
        <div className="flex items-center justify-between rounded-lg border p-3">
          <div>
            <p className="text-sm font-medium">DNACPR — decision not to attempt CPR</p>
            <p className="text-xs text-muted-foreground">Record if a DNACPR decision has been made</p>
          </div>
          <Switch checked={values.dnacpr_decision} onCheckedChange={(v) => set("dnacpr_decision", v)} />
        </div>
        {values.dnacpr_decision && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="DNACPR date">
              <DatePicker value={values.dnacpr_date} onChange={(v) => set("dnacpr_date", v)} />
            </Field>
            <Field label="DNACPR details">
              <Input value={values.dnacpr_details} onChange={(e) => set("dnacpr_details", e.target.value)} />
            </Field>
          </div>
        )}
      </section>

      <section className="space-y-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Next of kin</h3>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name"><Input value={values.nok_name} onChange={(e) => set("nok_name", e.target.value)} /></Field>
          <Field label="Relationship"><Input value={values.nok_relationship} onChange={(e) => set("nok_relationship", e.target.value)} /></Field>
          <Field label="Contact details"><Input value={values.nok_contact} onChange={(e) => set("nok_contact", e.target.value)} /></Field>
          <Field label="Last updated / spoken to">
            <DateTimePicker value={values.nok_last_updated} onChange={(v) => set("nok_last_updated", v)} />
          </Field>
          <Field label="Updated by (staff name)">
            <Input value={values.nok_last_updated_by} onChange={(e) => set("nok_last_updated_by", e.target.value)} />
          </Field>
        </div>
      </section>

      <div className="flex justify-end gap-2 border-t pt-4">
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        <Button type="submit" disabled={submitting}>{submitting ? "Saving…" : submitLabel}</Button>
      </div>
    </form>
  );
}
