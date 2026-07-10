import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

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
  };
}

export function toFormValues(p: Record<string, unknown>): PatientFormValues {
  const base = emptyPatient();
  const out = { ...base };
  for (const key of Object.keys(base) as (keyof PatientFormValues)[]) {
    const v = p[key];
    if (v === null || v === undefined) continue;
    // datetime-local expects yyyy-MM-ddThh:mm
    if (key === "nok_last_updated" && typeof v === "string") {
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
          <Field label="Full name *">
            <Input value={values.full_name} onChange={(e) => set("full_name", e.target.value)} required />
          </Field>
          <Field label="Date of birth">
            <Input type="date" value={values.dob} onChange={(e) => set("dob", e.target.value)} />
          </Field>
          <Field label="Hospital number">
            <Input value={values.hospital_number} onChange={(e) => set("hospital_number", e.target.value)} />
          </Field>
          <Field label="NHS number">
            <Input value={values.nhs_number} onChange={(e) => set("nhs_number", e.target.value)} />
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
          <Field label="Ward"><Input value={values.ward} onChange={(e) => set("ward", e.target.value)} /></Field>
          <Field label="Bed"><Input value={values.bed} onChange={(e) => set("bed", e.target.value)} /></Field>
          <Field label="Admission date">
            <Input type="date" value={values.admission_date} onChange={(e) => set("admission_date", e.target.value)} />
          </Field>
          {values.status === "discharged" && (
            <>
              <Field label="Discharge date">
                <Input type="date" value={values.discharge_date} onChange={(e) => set("discharge_date", e.target.value)} />
              </Field>
              <Field label="Discharge destination">
                <Input value={values.discharge_destination} onChange={(e) => set("discharge_destination", e.target.value)} />
              </Field>
            </>
          )}
          {values.status === "died" && (
            <Field label="Date of death">
              <Input type="date" value={values.date_of_death} onChange={(e) => set("date_of_death", e.target.value)} />
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
          <Textarea rows={3} value={values.current_admission} onChange={(e) => set("current_admission", e.target.value)} />
        </Field>
        <Field label="Current management">
          <Textarea rows={3} value={values.current_management} onChange={(e) => set("current_management", e.target.value)} />
        </Field>
        <Field label="Outstanding tasks">
          <Textarea rows={3} value={values.outstanding_tasks} onChange={(e) => set("outstanding_tasks", e.target.value)} />
        </Field>
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
              <Input type="date" value={values.dnacpr_date} onChange={(e) => set("dnacpr_date", e.target.value)} />
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
            <Input type="datetime-local" value={values.nok_last_updated} onChange={(e) => set("nok_last_updated", e.target.value)} />
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
