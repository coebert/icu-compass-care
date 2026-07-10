import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPatients, createPatient } from "@/lib/patients.functions";
import { PatientForm, emptyPatient, type PatientFormValues } from "@/components/PatientForm";
import { PatientName, PatientMetaLine } from "@/components/PatientSummary";
import { STATUS_BADGE, STATUS_LABELS, fmtDate } from "@/lib/icu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Plus, Search, HeartPulse, AlertTriangle, ClipboardList, FileDown } from "lucide-react";
import { toast } from "sonner";

import { HandoverPreviewModal } from "@/components/HandoverPreviewModal";

export const Route = createFileRoute("/_authenticated/patients")({
  component: PatientsBoard,
});

type Patient = Record<string, any>;

function PatientsBoard() {
  const qc = useQueryClient();
  const list = useServerFn(listPatients);
  const create = useServerFn(createPatient);
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [open, setOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [form, setForm] = useState<PatientFormValues>(emptyPatient());

  const { data: patients = [], isLoading } = useQuery({
    queryKey: ["patients"],
    queryFn: () => list() as Promise<Patient[]>,
  });

  const createMut = useMutation({
    mutationFn: (v: PatientFormValues) => create({ data: v as never }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patients"] });
      setOpen(false);
      setForm(emptyPatient());
      toast.success("Patient added");
    },
    onError: (e: Error) => toast.error("Could not add patient", { description: e.message }),
  });

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return patients.filter((p) => {
      const active = p.status === "admitted" || p.status === "referred";
      if (!showArchived && !active) return false;
      if (showArchived && active) return false;
      if (!q) return true;
      return (
        p.full_name?.toLowerCase().includes(q) ||
        p.hospital_number?.toLowerCase().includes(q) ||
        p.ward?.toLowerCase().includes(q)
      );
    });
  }, [patients, search, showArchived]);

  const icu = filtered.filter((p) => p.location_type === "icu");
  const outliers = filtered.filter((p) => p.location_type === "outlier");

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div>
          <h1 className="text-2xl font-bold">Patient board</h1>
          <p className="text-sm text-muted-foreground">
            {showArchived ? "Discharged & deceased records" : "Current ICU patients and outlying referrals"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="w-full pl-8"
              placeholder="Search initials or hospital no.…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button variant={showArchived ? "secondary" : "outline"} className="flex-1 sm:flex-none" onClick={() => setShowArchived((s) => !s)}>
            {showArchived ? "Show current" : "Archive"}
          </Button>
          <Button
            variant="outline"
            className="flex-1 gap-1.5 sm:flex-none"
            disabled={filtered.length === 0}
            onClick={() => setPreviewOpen(true)}
          >
            <FileDown className="h-4 w-4" /> Preview PDF
          </Button>
          <Button onClick={() => setOpen(true)} className="flex-1 gap-1.5 sm:flex-none">
            <Plus className="h-4 w-4" /> Add patient
          </Button>
        </div>
      </div>




      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No patients to show.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-8">
          <Section title="ICU" icon={HeartPulse} patients={icu} />
          <Section title="Outlying wards / referrals" icon={ClipboardList} patients={outliers} />
        </div>
      )}

      <HandoverPreviewModal
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        patients={filtered}
        title={showArchived ? "ICU Handover — Archived" : "ICU Handover Sheet"}
      />



      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Add patient</DialogTitle>
          </DialogHeader>
          <PatientForm
            values={form}
            onChange={setForm}
            onSubmit={() => createMut.mutate(form)}
            onCancel={() => setOpen(false)}
            submitting={createMut.isPending}
            submitLabel="Add patient"
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  patients,
}: {
  title: string;
  icon: React.ElementType;
  patients: Patient[];
}) {
  if (patients.length === 0) return null;
  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="h-4 w-4" /> {title} <span className="text-xs">({patients.length})</span>
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {patients.map((p) => (
          <Link key={p.id} to="/patients/$patientId" params={{ patientId: p.id }}>
            <Card className="h-full transition-colors hover:border-primary/50">
              <CardContent className="space-y-2 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <PatientName patient={p} showAge />
                    <p className="truncate text-xs text-muted-foreground">
                      {p.ward ? `${p.ward}${p.bed ? ` · Bed ${p.bed}` : ""}` : "No location"}
                    </p>
                  </div>
                  <Badge className={`${STATUS_BADGE[p.status]} shrink-0`} variant="secondary">
                    {STATUS_LABELS[p.status]}
                  </Badge>
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {p.dnacpr_decision && (
                    <Badge variant="outline" className="gap-1 border-rose-300 text-rose-700 dark:text-rose-300">
                      <AlertTriangle className="h-3 w-3" /> DNACPR
                    </Badge>
                  )}
                  {p.tep_in_place && <Badge variant="outline">TEP</Badge>}
                </div>
                {p.outstanding_tasks && (
                  <p className="line-clamp-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">Tasks: </span>
                    {p.outstanding_tasks}
                  </p>
                )}
                <PatientMetaLine
                  patient={p}
                  showAge={false}
                  trailing={[`Adm ${fmtDate(p.admission_date)}`]}
                  className="text-[11px]"
                />
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
