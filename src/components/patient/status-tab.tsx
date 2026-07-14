import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import type { Patient as DomainPatient } from "@/lib/domain-types";
import { updatePatient } from "@/lib/patients.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { DatePicker } from "@/components/ui/date-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Share2, ShieldOff, Trash2, AlertTriangle } from "lucide-react";
import { ConfirmDestructive } from "@/components/ui/confirm-destructive";

type Patient = DomainPatient & Record<string, any>;

export function StatusTab({
  patient,
  onDelete,
  isDeleting = false,
}: {
  patient: Patient;
  onDelete?: () => void;
  isDeleting?: boolean;
}) {
  const qc = useQueryClient();
  const update = useServerFn(updatePatient);
  const [status, setStatus] = useState<string>(patient.status);
  const [dischargeDate, setDischargeDate] = useState(patient.discharge_date ?? "");
  const [destination, setDestination] = useState(patient.discharge_destination ?? "");
  const [dod, setDod] = useState(patient.date_of_death ?? "");

  const mut = useMutation({
    mutationFn: () =>
      update({
        data: {
          id: patient.id,
          expected_updated_at: patient.updated_at,
          status,
          discharge_date: status === "discharged" ? dischargeDate : "",
          discharge_destination: status === "discharged" ? destination : "",
          date_of_death: status === "died" ? dod : "",
        } as never,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patient", patient.id] });
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["patient-audit", patient.id] });
      qc.invalidateQueries({ queryKey: ["patient-field-changes", patient.id] });
      toast.success("Status updated");
    },
    onError: (e: Error) =>
      e.message.startsWith("CONFLICT:")
        ? toast.warning("Edit conflict", { description: e.message.replace("CONFLICT: ", "") })
        : toast.error("Update failed", { description: e.message }),
  });

  return (
    <Card>
      <CardContent className="max-w-md space-y-4 p-6">
        <div
          className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm ${
            patient.shared_with_partner
              ? "border-sky-300 text-sky-700 dark:text-sky-300"
              : "text-muted-foreground"
          }`}
        >
          {patient.shared_with_partner ? (
            <>
              <Share2 className="h-4 w-4" />
              <span className="font-medium">Shared with partner app</span>
            </>
          ) : (
            <>
              <ShieldOff className="h-4 w-4" />
              <span className="font-medium">Not shared with partner app</span>
            </>
          )}
        </div>
        <div className="space-y-1.5">
          <Label>Patient status</Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="referred">Referred (outlier)</SelectItem>
              <SelectItem value="admitted">Admitted</SelectItem>
              <SelectItem value="discharged">Discharged</SelectItem>
              <SelectItem value="died">Died</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {status === "discharged" && (
          <>
            <div className="space-y-1.5">
              <Label>Discharge date</Label>
              <DatePicker value={dischargeDate} onChange={setDischargeDate} />
            </div>
            <div className="space-y-1.5">
              <Label>Discharge destination</Label>
              <Input value={destination} onChange={(e) => setDestination(e.target.value)} placeholder="e.g. Ward, another hospital, home" />
            </div>
          </>
        )}
        {status === "died" && (
          <div className="space-y-1.5">
            <Label>Date of death</Label>
            <DatePicker value={dod} onChange={setDod} />
          </div>
        )}
        <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? "Saving…" : "Update status"}
        </Button>
      </CardContent>
    </Card>
    {onDelete && (
      <Card className="mt-6 max-w-md border-destructive/40">
        <CardContent className="space-y-3 p-6">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            <h3 className="text-sm font-semibold uppercase tracking-wide">Danger zone</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            Deleting a patient record is intended for test entries or duplicates created in
            error. For real patients who have left the unit, change the status to{" "}
            <span className="font-medium">discharged</span> or <span className="font-medium">died</span> above so the record and its
            clinical history are retained for audit.
          </p>
          <ConfirmDestructive
            title="Delete this patient record permanently?"
            description={
              <>
                <p className="mb-2">
                  This will permanently remove <span className="font-medium">{patient.display_name ?? "the patient"}</span>{" "}
                  and every associated record:
                </p>
                <ul className="mb-2 list-disc pl-5 text-sm">
                  <li>All observations, ventilation and fluid entries</li>
                  <li>All lines and devices</li>
                  <li>All investigations and microbiology results</li>
                  <li>All specialty reviews and timeline events</li>
                  <li>The full audit trail of who changed what and when</li>
                </ul>
                <p>
                  This cannot be undone. To keep the record for review, use{" "}
                  <span className="font-medium">discharged</span> or <span className="font-medium">died</span> status instead.
                </p>
              </>
            }
            confirmLabel="Delete permanently"
            onConfirm={onDelete}
            disabled={isDeleting}
          >
            <Button variant="destructive" className="gap-1.5" disabled={isDeleting}>
              <Trash2 className="h-4 w-4" />
              {isDeleting ? "Deleting…" : "Delete patient record"}
            </Button>
          </ConfirmDestructive>
        </CardContent>
      </Card>
    )}
    </>
  );
}
