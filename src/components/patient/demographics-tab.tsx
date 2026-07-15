import { Card, CardContent } from "@/components/ui/card";
import { EditableField, EditableSelect, EditableDate } from "@/components/patient/systems-widgets";
import { fmtDate } from "@/lib/icu";
import type { Patient } from "@/lib/domain-types";

// All patient identity / location / lifecycle fields, edited inline (no dialog).
// Everything routes through the same updatePatient server fn as the systems
// widgets, so audit + concurrency checks apply as normal.
export function DemographicsTab({ patient }: { patient: Patient }) {
  const patientId = patient.id;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="grid gap-6 p-6 sm:grid-cols-2">
          <EditableField patientId={patientId} field="full_name" label="Initials / name *" value={patient.full_name} placeholder="e.g. J.S." />
          <EditableField patientId={patientId} field="hospital_number" label="Hospital number" value={patient.hospital_number} />
          <EditableField patientId={patientId} field="age" label="Age *" value={patient.age != null ? String(patient.age) : ""} placeholder="e.g. 58" />
          <EditableSelect
            patientId={patientId}
            field="sex"
            label="Sex *"
            value={patient.sex}
            options={[
              { value: "female", label: "Female" },
              { value: "male", label: "Male" },
              { value: "other", label: "Other" },
              { value: "unknown", label: "Unknown" },
            ]}
            placeholder="Select sex…"
          />
          <EditableField patientId={patientId} field="weight_kg" label="Weight (kg)" value={patient.weight_kg != null ? String(patient.weight_kg) : ""} placeholder="e.g. 78" />
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
    </div>
  );
}
