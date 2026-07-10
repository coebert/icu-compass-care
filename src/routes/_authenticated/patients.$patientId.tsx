import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPatient, updatePatient, deletePatient, getPatientAudit } from "@/lib/patients.functions";
import {
  listInvestigations,
  addInvestigation,
  deleteInvestigation,
} from "@/lib/investigations.functions";
import { PatientForm, toFormValues, type PatientFormValues } from "@/components/PatientForm";
import { STATUS_BADGE, STATUS_LABELS, INVESTIGATION_CATEGORIES, fmtDate, fmtDateTime } from "@/lib/icu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ArrowLeft, Pencil, Trash2, Plus, AlertTriangle, FlaskConical } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/patients/$patientId")({
  component: PatientDetail,
});

type Patient = Record<string, any>;
type Investigation = Record<string, any>;

function InfoBlock({ label, value }: { label: string; value?: string | null }) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 whitespace-pre-wrap text-sm">{value?.trim() ? value : "—"}</p>
    </div>
  );
}

function PatientDetail() {
  const { patientId } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const get = useServerFn(getPatient);
  const update = useServerFn(updatePatient);
  const del = useServerFn(deletePatient);

  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<PatientFormValues | null>(null);

  const { data: patient, isLoading } = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => get({ data: { id: patientId } }) as Promise<Patient>,
  });

  const updateMut = useMutation({
    mutationFn: (v: PatientFormValues) =>
      update({ data: { id: patientId, expected_updated_at: patient?.updated_at, ...v } as never }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patient", patientId] });
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["patient-audit", patientId] });
      setEditing(false);
      toast.success("Patient updated");
    },
    onError: (e: Error) =>
      e.message.startsWith("CONFLICT:")
        ? toast.warning("Edit conflict", { description: e.message.replace("CONFLICT: ", "") })
        : toast.error("Update failed", { description: e.message }),
  });

  const deleteMut = useMutation({
    mutationFn: () => del({ data: { id: patientId } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      toast.success("Patient deleted");
      navigate({ to: "/patients" });
    },
    onError: (e: Error) => toast.error("Delete failed", { description: e.message }),
  });

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!patient)
    return (
      <div className="space-y-3">
        <p>Patient not found.</p>
        <Link to="/patients"><Button variant="outline">Back to board</Button></Link>
      </div>
    );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/patients">
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" /> Board
          </Button>
        </Link>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{patient.full_name}</h1>
            <Badge className={STATUS_BADGE[patient.status]} variant="secondary">
              {STATUS_LABELS[patient.status]}
            </Badge>
            {patient.dnacpr_decision && (
              <Badge variant="outline" className="gap-1 border-rose-300 text-rose-700 dark:text-rose-300">
                <AlertTriangle className="h-3 w-3" /> DNACPR
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {patient.ward ? `${patient.ward}${patient.bed ? ` · Bed ${patient.bed}` : ""} · ` : ""}
            {patient.hospital_number ? `MRN ${patient.hospital_number} · ` : ""}
            {patient.nhs_number ? `NHS ${patient.nhs_number} · ` : ""}
            DOB {fmtDate(patient.dob)}
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Button
            variant="outline"
            className="gap-1.5"
            onClick={() => {
              setForm(toFormValues(patient));
              setEditing(true);
            }}
          >
            <Pencil className="h-4 w-4" /> Edit
          </Button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" className="gap-1.5 text-destructive">
                <Trash2 className="h-4 w-4" /> Delete
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this patient record?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes the record and all its investigations. To keep the
                  record for review, change the status to discharged or died instead.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => deleteMut.mutate()}>Delete</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="escalation">Escalation & Resus</TabsTrigger>
          <TabsTrigger value="nok">Next of kin</TabsTrigger>
          <TabsTrigger value="investigations">Investigations</TabsTrigger>
          <TabsTrigger value="status">Status</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>


        <TabsContent value="overview" className="mt-4">
          <Card>
            <CardContent className="grid gap-6 p-6 sm:grid-cols-2">
              <InfoBlock label="Past medical history" value={patient.past_medical_history} />
              <InfoBlock label="Current admission" value={patient.current_admission} />
              <InfoBlock label="Current management" value={patient.current_management} />
              <InfoBlock label="Outstanding tasks" value={patient.outstanding_tasks} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="escalation" className="mt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Treatment escalation plan</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <Badge variant={patient.tep_in_place ? "default" : "secondary"}>
                  {patient.tep_in_place ? "TEP in place" : "No TEP recorded"}
                </Badge>
                <InfoBlock label="Details" value={patient.tep_details} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">Resuscitation (DNACPR)</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <Badge variant={patient.dnacpr_decision ? "destructive" : "secondary"}>
                  {patient.dnacpr_decision ? "DNACPR decision made" : "For resuscitation"}
                </Badge>
                <InfoBlock label="Date of decision" value={fmtDate(patient.dnacpr_date)} />
                <InfoBlock label="Details" value={patient.dnacpr_details} />
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="nok" className="mt-4">
          <Card>
            <CardContent className="grid gap-6 p-6 sm:grid-cols-2">
              <InfoBlock label="Name" value={patient.nok_name} />
              <InfoBlock label="Relationship" value={patient.nok_relationship} />
              <InfoBlock label="Contact" value={patient.nok_contact} />
              <InfoBlock label="Last updated / spoken to" value={fmtDateTime(patient.nok_last_updated)} />
              <InfoBlock label="Updated by" value={patient.nok_last_updated_by} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="investigations" className="mt-4">
          <InvestigationsTab patientId={patientId} />
        </TabsContent>

        <TabsContent value="status" className="mt-4">
          <StatusTab patient={patient} />
        </TabsContent>
      </Tabs>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader><DialogTitle>Edit patient</DialogTitle></DialogHeader>
          {form && (
            <PatientForm
              values={form}
              onChange={setForm}
              onSubmit={() => updateMut.mutate(form)}
              onCancel={() => setEditing(false)}
              submitting={updateMut.isPending}
              submitLabel="Save changes"
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StatusTab({ patient }: { patient: Patient }) {
  const qc = useQueryClient();
  const update = useServerFn(updatePatient);
  const [status, setStatus] = useState(patient.status);
  const [dischargeDate, setDischargeDate] = useState(patient.discharge_date ?? "");
  const [destination, setDestination] = useState(patient.discharge_destination ?? "");
  const [dod, setDod] = useState(patient.date_of_death ?? "");

  const mut = useMutation({
    mutationFn: () =>
      update({
        data: {
          id: patient.id,
          status,
          discharge_date: status === "discharged" ? dischargeDate : "",
          discharge_destination: status === "discharged" ? destination : "",
          date_of_death: status === "died" ? dod : "",
        } as never,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patient", patient.id] });
      qc.invalidateQueries({ queryKey: ["patients"] });
      toast.success("Status updated");
    },
    onError: (e: Error) => toast.error("Update failed", { description: e.message }),
  });

  return (
    <Card>
      <CardContent className="max-w-md space-y-4 p-6">
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
              <Input type="date" value={dischargeDate} onChange={(e) => setDischargeDate(e.target.value)} />
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
            <Input type="date" value={dod} onChange={(e) => setDod(e.target.value)} />
          </div>
        )}
        <Button onClick={() => mut.mutate()} disabled={mut.isPending}>
          {mut.isPending ? "Saving…" : "Update status"}
        </Button>
      </CardContent>
    </Card>
  );
}

function InvestigationsTab({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const list = useServerFn(listInvestigations);
  const add = useServerFn(addInvestigation);
  const del = useServerFn(deleteInvestigation);
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState(INVESTIGATION_CATEGORIES[0]);
  const [findings, setFindings] = useState("");
  const [resultAt, setResultAt] = useState(() => new Date().toISOString().slice(0, 16));

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["investigations", patientId],
    queryFn: () => list({ data: { patientId } }) as Promise<Investigation[]>,
  });

  const addMut = useMutation({
    mutationFn: () =>
      add({
        data: {
          patient_id: patientId,
          category,
          findings,
          result_at: new Date(resultAt).toISOString(),
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investigations", patientId] });
      setOpen(false);
      setFindings("");
      toast.success("Investigation saved");
    },
    onError: (e: Error) => toast.error("Could not save", { description: e.message }),
  });

  const delMut = useMutation({
    mutationFn: (id: string) => del({ data: { id } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["investigations", patientId] });
      toast.success("Deleted");
    },
  });

  // Most recent per category
  const mostRecent = useMemo(() => {
    const map = new Map<string, Investigation>();
    for (const it of items) {
      if (!map.has(it.category)) map.set(it.category, it);
    }
    return Array.from(map.values());
  }, [items]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Most recent results
        </h2>
        <Button size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
          <Plus className="h-4 w-4" /> Add result
        </Button>
      </div>

      {mostRecent.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No investigations recorded.</CardContent></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {mostRecent.map((it) => (
            <Card key={it.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1.5 text-sm">
                  <FlaskConical className="h-4 w-4 text-primary" /> Most recent {it.category}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                <p className="whitespace-pre-wrap text-sm">{it.findings}</p>
                <p className="text-xs text-muted-foreground">{fmtDateTime(it.result_at)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Full history
        </h2>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">No entries.</p>
        ) : (
          <div className="space-y-2">
            {items.map((it) => (
              <Card key={it.id}>
                <CardContent className="flex items-start justify-between gap-3 p-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{it.category}</Badge>
                      <span className="text-xs text-muted-foreground">{fmtDateTime(it.result_at)}</span>
                    </div>
                    <p className="mt-1 whitespace-pre-wrap text-sm">{it.findings}</p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-destructive"
                    onClick={() => delMut.mutate(it.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add investigation result</DialogTitle></DialogHeader>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              addMut.mutate();
            }}
            className="space-y-4"
          >
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {INVESTIGATION_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Date / time of result</Label>
              <Input type="datetime-local" value={resultAt} onChange={(e) => setResultAt(e.target.value)} required />
            </div>
            <div className="space-y-1.5">
              <Label>Findings</Label>
              <Textarea rows={4} value={findings} onChange={(e) => setFindings(e.target.value)} required />
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={addMut.isPending}>{addMut.isPending ? "Saving…" : "Save"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
