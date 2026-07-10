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
import { Plus, Search, HeartPulse, AlertTriangle, ClipboardList, FileDown, BedDouble } from "lucide-react";
import { toast } from "sonner";

import { HandoverPreviewModal } from "@/components/HandoverPreviewModal";

export const Route = createFileRoute("/_authenticated/patients/")({
  component: PatientsBoard,
});

type Patient = Record<string, any>;

// Radnor Critical Care Unit bed roster (shared with the cross-project bridge).
import { ICU_BEDS, normalizeBed } from "@/lib/icu-beds";

// Build a human-readable location label. ICU patients are identified by
// location_type and a bed number (ward is usually blank for them), so we must
// not fall back to "No location" just because ward is empty.
function formatLocation(p: Patient): string {
  const bed = p.bed ? ` · Bed ${p.bed}` : "";
  if (p.location_type === "icu") return `ICU${bed}`;
  if (p.ward) return `${p.ward}${bed}`;
  if (p.bed) return `Bed ${p.bed}`;
  return "No location";
}

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

  // Map each ICU bed to the active patient occupying it (if any).
  const bedOccupant = useMemo(() => {
    const map = new Map<string, Patient>();
    for (const p of icu) {
      const key = normalizeBed(p.bed);
      if (key && !map.has(key)) map.set(key, p);
    }
    return map;
  }, [icu]);

  // Active ICU patients whose bed doesn't match a known bed slot.
  const icuUnassigned = icu.filter((p) => {
    const key = normalizeBed(p.bed);
    return !key || !ICU_BEDS.some((b) => normalizeBed(b) === key);
  });

  function addToBed(bed: string) {
    setForm({ ...emptyPatient(), location_type: "icu", bed });
    setOpen(true);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
        <div>
          <h1 className="text-2xl font-bold">Patient board</h1>
          <p className="text-sm text-muted-foreground">
            {showArchived ? "Discharged & deceased records" : "Current ICU patients and outlying referrals"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 sm:ml-auto">
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="h-11 w-full pl-9 sm:h-10"
              placeholder="Search initials or hospital no.…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button variant={showArchived ? "secondary" : "outline"} className="h-11 flex-1 sm:h-10 sm:flex-none" onClick={() => setShowArchived((s) => !s)}>
            {showArchived ? "Show current" : "Archive"}
          </Button>
          <Button
            variant="outline"
            className="h-11 flex-1 gap-1.5 sm:h-10 sm:flex-none"
            disabled={filtered.length === 0}
            onClick={() => setPreviewOpen(true)}
          >
            <FileDown className="h-4 w-4" /> Preview PDF
          </Button>
          <Button onClick={() => setOpen(true)} className="h-11 flex-1 gap-1.5 sm:h-10 sm:flex-none">
            <Plus className="h-4 w-4" /> Add patient
          </Button>
        </div>

      </div>




      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : showArchived ? (
        filtered.length === 0 ? (
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
        )
      ) : (
        <div className="space-y-8">
          <BedBoard bedOccupant={bedOccupant} unassigned={icuUnassigned} onAddToBed={addToBed} />
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

function PatientCardBody({ p, bedLabel }: { p: Patient; bedLabel?: string }) {
  return (
    <CardContent className="space-y-2 p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <PatientName patient={p} showAge />
          <p className="truncate text-xs text-muted-foreground">
            {bedLabel ?? formatLocation(p)}
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
  );
}

function BedBoard({
  bedOccupant,
  unassigned,
  onAddToBed,
}: {
  bedOccupant: Map<string, Patient>;
  unassigned: Patient[];
  onAddToBed: (bed: string) => void;
}) {
  const occupied = bedOccupant.size;
  return (
    <div className="space-y-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        <BedDouble className="h-4 w-4" /> Radnor Critical Care — Bed board
        <span className="text-xs">({occupied}/{ICU_BEDS.length} occupied)</span>
      </h2>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {ICU_BEDS.map((bed) => {
          const label = bed.startsWith("SR") ? bed : `Bed ${bed}`;
          const p = bedOccupant.get(normalizeBed(bed));
          if (p) {
            return (
              <Link key={bed} to="/patients/$patientId" params={{ patientId: p.id }}>
                <Card className="h-full transition-colors hover:border-primary/50">
                  <div className="border-b bg-muted/40 px-4 py-1.5 text-xs font-semibold">
                    {label}
                  </div>
                  <PatientCardBody p={p} bedLabel={bed.startsWith("SR") ? "Side room" : undefined} />
                </Card>
              </Link>
            );
          }
          return (
            <button
              key={bed}
              type="button"
              onClick={() => onAddToBed(bed)}
              className="group flex h-full min-h-[120px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed bg-muted/20 p-4 text-center transition-colors hover:border-primary hover:bg-primary/5"
            >
              <span className="text-xs font-semibold text-muted-foreground">{label}</span>
              <span className="flex items-center gap-1 text-sm text-muted-foreground group-hover:text-primary">
                <Plus className="h-4 w-4" /> Empty
              </span>
              <span className="text-[11px] text-muted-foreground">Tap to admit</span>
            </button>
          );
        })}
      </div>

      {unassigned.length > 0 && (
        <div className="space-y-2 pt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            ICU · no bed assigned ({unassigned.length})
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {unassigned.map((p) => (
              <Link key={p.id} to="/patients/$patientId" params={{ patientId: p.id }}>
                <Card className="h-full transition-colors hover:border-primary/50">
                  <PatientCardBody p={p} />
                </Card>
              </Link>
            ))}
          </div>
        </div>
      )}
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
              <PatientCardBody p={p} />
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
