import { Card, CardContent } from "@/components/ui/card";
import { EditableField, EditableSelect, EditableDate } from "@/components/patient/systems-widgets";
import { DemographicsHistory } from "@/components/patient/demographics-history";
import { fmtDate } from "@/lib/icu";
import { computeBmi, BMI_MIN, BMI_MAX } from "@/lib/patient-schema";
import type { Patient } from "@/lib/domain-types";

// BMI category labels follow WHO adult classification. Shown alongside the
// numeric value so clinicians get context at a glance. The server enforces
// a wider sanity range (BMI_MIN..BMI_MAX) and rejects the save if breached.
function bmiCategory(bmi: number): { label: string; tone: string } {
  if (bmi < 18.5) return { label: "Underweight", tone: "text-amber-600" };
  if (bmi < 25) return { label: "Healthy weight", tone: "text-emerald-600" };
  if (bmi < 30) return { label: "Overweight", tone: "text-amber-600" };
  if (bmi < 40) return { label: "Obese", tone: "text-orange-600" };
  return { label: "Severely obese", tone: "text-red-600" };
}

// Read-only BMI panel driven by the saved weight_kg/height_m values. Updates
// automatically whenever either field is persisted. Also surfaces the same
// out-of-range warning that the server would reject on save, so staff see it
// before attempting an update rather than as a save error.
function BmiReadout({ weightKg, heightM }: { weightKg: number | null; heightM: number | null }) {
  const bmi = computeBmi(weightKg, heightM);
  if (bmi == null) {
    return (
      <div className="rounded-md border border-dashed p-3 text-sm text-muted-foreground">
        <div className="font-medium text-foreground">BMI</div>
        <div>Enter both weight and height to calculate.</div>
      </div>
    );
  }
  const outOfRange = bmi < BMI_MIN || bmi > BMI_MAX;
  const cat = bmiCategory(bmi);
  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="font-medium">BMI</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-2xl font-semibold tabular-nums">{bmi}</span>
        <span className="text-muted-foreground">kg/m²</span>
      </div>
      {outOfRange ? (
        <div className="mt-1 text-destructive">
          Implausible BMI (expected {BMI_MIN}–{BMI_MAX}). Check that height is in metres.
        </div>
      ) : (
        <div className={`mt-1 ${cat.tone}`}>{cat.label}</div>
      )}
    </div>
  );
}




// All patient identity / location / lifecycle fields, edited inline (no dialog).
// Everything routes through the same updatePatient server fn as the systems
// widgets, so audit + concurrency checks apply as normal.
export function DemographicsTab({ patient }: { patient: Patient }) {
  const patientId = patient.id;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-6 p-6 sm:grid-cols-2">
          <EditableField
            patientId={patientId}
            field="full_name"
            label="Initials / name *"
            value={patient.full_name}
            placeholder="e.g. J.S."
            required
            validate={(v) => (v.length > 10 ? "Max 10 characters." : null)}
          />
          <EditableField
            patientId={patientId}
            field="hospital_number"
            label="Hospital number"
            value={patient.hospital_number}
            validate={(v) => {
              if (v === "") return null;
              if (v.length > 50) return "Max 50 characters.";
              if (!/^[A-Za-z0-9\-\s]+$/.test(v)) return "Letters, numbers and hyphens only.";
              return null;
            }}
          />
          <EditableField
            patientId={patientId}
            field="age"
            label="Age *"
            value={patient.age != null ? String(patient.age) : ""}
            placeholder="e.g. 58"
            required
            validate={(v) => {
              if (!/^\d+$/.test(v)) return "Age must be a whole number.";
              const n = Number(v);
              if (n < 0 || n > 130) return "Age must be between 0 and 130.";
              return null;
            }}
            coerce={(v) => Number(v)}
          />
          <EditableSelect
            patientId={patientId}
            field="sex"
            label="Sex *"
            value={patient.sex}
            required
            options={[
              { value: "female", label: "Female" },
              { value: "male", label: "Male" },
              { value: "other", label: "Other" },
              { value: "unknown", label: "Unknown" },
            ]}
            placeholder="Select sex…"
          />
          <EditableField
            patientId={patientId}
            field="weight_kg"
            label="Weight (kg)"
            value={patient.weight_kg != null ? String(patient.weight_kg) : ""}
            placeholder="e.g. 78"
            validate={(v) => {
              if (v === "") return null;
              const n = Number(v);
              if (!Number.isFinite(n)) return "Weight must be a valid number.";
              if (n < 0 || n > 600) return "Weight must be between 0 and 600 kg.";
              return null;
            }}
            coerce={(v) => Number(v)}
          />
          <EditableField
            patientId={patientId}
            field="height_m"
            label="Height (m)"
            value={patient.height_m != null ? String(patient.height_m) : ""}
            placeholder="e.g. 1.75"
            validate={(v) => {
              if (v === "") return null;
              const n = Number(v);
              if (!Number.isFinite(n)) return "Height must be a valid number.";
              if (n < 0 || n > 3) return "Height must be between 0 and 3 m.";
              return null;
            }}
            coerce={(v) => Number(v)}
          />
          <BmiReadout weightKg={patient.weight_kg} heightM={patient.height_m} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-6 p-6 sm:grid-cols-2">
          <EditableSelect
            patientId={patientId}
            field="location_type"
            label="Location"
            value={patient.location_type}
            options={[
              { value: "icu", label: "ICU" },
              { value: "outlier", label: "Outlying ward / referral" },
            ]}
          />
          <EditableSelect
            patientId={patientId}
            field="status"
            label="Status"
            value={patient.status}
            options={[
              { value: "referred", label: "Referred (outlier)" },
              { value: "admitted", label: "Admitted" },
              { value: "discharged", label: "Discharged" },
              { value: "died", label: "Died" },
            ]}
          />
          <EditableField patientId={patientId} field="ward" label="Ward" value={patient.ward} />
          <EditableField patientId={patientId} field="bed" label="Bed" value={patient.bed} />
          <EditableDate patientId={patientId} field="admission_date" label="Admission date" value={patient.admission_date} displayFormatter={fmtDate} />
          {patient.status === "discharged" && (
            <>
              <EditableDate patientId={patientId} field="discharge_date" label="Discharge date" value={patient.discharge_date} displayFormatter={fmtDate} />
              <EditableField patientId={patientId} field="discharge_destination" label="Discharge destination" value={patient.discharge_destination} />
            </>
          )}
          {patient.status === "died" && (
            <EditableDate patientId={patientId} field="date_of_death" label="Date of death" value={patient.date_of_death} displayFormatter={fmtDate} />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid gap-6 p-6 sm:grid-cols-2">
          <EditableField patientId={patientId} field="nok_name" label="Next of kin — name" value={patient.nok_name} />
          <EditableField patientId={patientId} field="nok_relationship" label="Next of kin — relationship" value={patient.nok_relationship} />
          <EditableField patientId={patientId} field="nok_contact" label="Next of kin — contact" value={patient.nok_contact} />
          <EditableField patientId={patientId} field="nok_last_updated_by" label="Last spoken to by (staff)" value={patient.nok_last_updated_by} />
        </CardContent>
      </Card>

      <DemographicsHistory patientId={patientId} />
    </div>
  );
}
