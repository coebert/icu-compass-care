import { ListSkeleton, RowSkeleton, TextSkeleton } from "@/components/LoadingSkeleton";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPatient, updatePatient, deletePatient } from "@/lib/patients.functions";
import { useClinicalAccess } from "@/hooks/use-clinical-access";
import { ClinicalAccessRequired } from "@/components/ClinicalAccessRequired";
import type { Patient as DomainPatient } from "@/lib/domain-types";
import { SafetySummary, DailyGoalsCard } from "@/components/patient/safety-summary";
import { ObservationsCard } from "@/components/patient/observations-card";
import { LinesCard } from "@/components/patient/lines-card";
import { InfoBlock } from "@/components/patient/shared";
import { EditableField } from "@/components/patient/systems-widgets";
import { parseTepExclusions, TEP_INTERVENTION_LABEL } from "@/lib/patient-safety";
import {
  RespiratoryStatus,
  CardiovascularStatus,
  HaemStatus,
  RenalStatus,
  MicroStatus,
  NeuroStatus,
  GastroNutritionStatus,
} from "@/components/patient/systems-status";
import { OutstandingTasks } from "@/components/patient/tasks-card";
import { RecentInvestigations } from "@/components/patient/recent-investigations";
import { PrefillFromReferral } from "@/components/patient/prefill-from-referral";
import { TimelineTab } from "@/components/patient/timeline-tab";
import { ReviewsTab } from "@/components/patient/reviews-tab";
import { StatusTab } from "@/components/patient/status-tab";
import { InvestigationsTab } from "@/components/patient/investigations-tab";
import { MicrobiologyTab } from "@/components/patient/microbiology-tab";
import { AuditTab, RecentChangesRibbon } from "@/components/patient/history-tab";
import { listInvestigations } from "@/lib/investigations.functions";
import { listMicrobiology } from "@/lib/microbiology.functions";
import { PatientName, PatientMetaLine } from "@/components/PatientSummary";
import { DemographicsTab } from "@/components/patient/demographics-tab";
import { ChartTab } from "@/components/patient/chart-tab";
import { listChartDays } from "@/lib/chart-days.functions";
import { STATUS_BADGE, STATUS_LABELS, fmtDate, fmtDateTime } from "@/lib/icu";
import { downloadHandover, type HandoverPatient } from "@/lib/handover-pdf";
import { missingCriticalFields } from "@/lib/handover-validation";
import { listObservations } from "@/lib/observations.functions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, AlertTriangle, Circle, CheckCircle2, FileDown, Loader2, ClipboardPlus, Share2, ShieldOff, ChevronLeft, ChevronRight } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { setPatientsShared } from "@/lib/sharing.functions";
import { toast } from "sonner";
import { useConflictDialog } from "@/components/ConflictDialog";


import { zodValidator, fallback } from "@tanstack/zod-adapter";
import { z } from "zod";
import { TIMELINE_FILTER_KEYS, type FilterKey as TimelineFilterKey } from "@/components/patient/timeline-tab";

const TAB_KEYS = [
  "overview",
  "demographics",
  "observations",
  "chart",
  "lines",
  "escalation",
  "nok",
  "investigations",
  "microbiology",
  "reviews",
  "timeline",
  "status",
  "history",
] as const;

const patientDetailSearchSchema = z.object({
  tab: fallback(z.string(), "overview").default("overview"),
  filter: fallback(z.string(), "").default(""),
  chartDate: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/_authenticated/patients/$patientId")({
  component: PatientDetail,
  validateSearch: zodValidator(patientDetailSearchSchema),
});

type Patient = DomainPatient & Record<string, any>;

// Maps each critical-field warning label to the id of its input in PatientForm,
// so the amber warning can deep-link the user straight to the field to fix.
const MISSING_FIELD_ANCHORS: Record<string, string> = {
  "Patient name": "pf-full_name",
  "Hospital number": "pf-hospital_number",
  "Location (ward/bed)": "pf-ward",
  "Current admission": "pf-current_admission",
};

function PatientDetail() {
  const { patientId } = Route.useParams();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const qc = useQueryClient();
  const get = useServerFn(getPatient);
  const update = useServerFn(updatePatient);
  const del = useServerFn(deletePatient);

  type SearchShape = z.infer<typeof patientDetailSearchSchema>;
  const activeTab = (TAB_KEYS as readonly string[]).includes(search.tab) ? search.tab : "overview";
  const setActiveTab = (tab: string) =>
    navigate({
      to: "/patients/$patientId",
      params: { patientId },
      search: (prev: SearchShape) => ({ ...prev, tab }),
      replace: true,
    });
  const timelineFilters = search.filter
    .split(",")
    .filter((k: string): k is TimelineFilterKey => (TIMELINE_FILTER_KEYS as string[]).includes(k));
  const setTimelineFilters = (next: TimelineFilterKey[]) =>
    navigate({
      to: "/patients/$patientId",
      params: { patientId },
      search: (prev: SearchShape) => ({ ...prev, filter: next.join(",") }),
      replace: true,
    });
  const isoDateRe = /^\d{4}-\d{2}-\d{2}$/;
  const urlChartDate = isoDateRe.test(search.chartDate) ? search.chartDate : "";
  const setChartDate = (next: string) =>
    navigate({
      to: "/patients/$patientId",
      params: { patientId },
      search: (prev: SearchShape) => ({ ...prev, chartDate: next && isoDateRe.test(next) ? next : "" }),
      replace: true,
    });

  const [focus, setFocus] = useState<{ tab: "investigations" | "microbiology"; id: string; seq: number } | null>(null);


  const { hasClinicalAccess, profile } = useClinicalAccess();

  const { data: patient, isLoading } = useQuery({
    queryKey: ["patient", patientId],
    queryFn: () => get({ data: { id: patientId } }) as Promise<Patient>,
    enabled: hasClinicalAccess,
  });

  const conflict = useConflictDialog();



  // Admin-only: mark this single patient as shared / not shared with the partner
  // app. The backend enforces admin-only; this is the per-patient control.
  const shareFn = useServerFn(setPatientsShared);
  const shareMut = useMutation({
    mutationFn: (shared: boolean) => shareFn({ data: { ids: [patientId], shared } }),
    onSuccess: (_res, shared) => {
      qc.invalidateQueries({ queryKey: ["patient", patientId] });
      qc.invalidateQueries({ queryKey: ["patients"] });
      qc.invalidateQueries({ queryKey: ["patient-sharing"] });
      toast.success(shared ? "Shared with partner app" : "Sharing stopped");
    },
    onError: (e: Error) => toast.error("Could not update sharing", { description: e.message }),
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

  // Handover PDF export for this single patient. All the clinical detail the
  // sheet needs (investigations, microbiology, observations) is fetched fresh
  // and in parallel BEFORE the PDF is built, so a failed or in-flight fetch can
  // never produce a blank or partial sheet — the button stays in a loading
  // state until every source resolves, and surfaces an error toast otherwise.
  const listInvFn = useServerFn(listInvestigations);
  const listMicroFn = useServerFn(listMicrobiology);
  const listObsFn = useServerFn(listObservations);

  // Per-section fetch status so the user can see exactly which clinical source
  // is still loading (or failed) while the handover PDF is being prepared.
  type SectionState = "idle" | "loading" | "done" | "error";
  const [sectionStatus, setSectionStatus] = useState<{
    investigations: SectionState;
    microbiology: SectionState;
    observations: SectionState;
  }>({ investigations: "idle", microbiology: "idle", observations: "idle" });

  const exportMut = useMutation({
    mutationFn: async () => {
      if (!patient) throw new Error("Patient record is still loading");
      const missing = missingCriticalFields(patient);
      if (missing.length > 0) {
        throw new Error(`Missing required data: ${missing.join(", ")}`);
      }
      setSectionStatus({
        investigations: "loading",
        microbiology: "loading",
        observations: "loading",
      });
      const track = <T,>(key: keyof typeof sectionStatus, p: Promise<T>) =>
        p.then(
          (v) => {
            setSectionStatus((s) => ({ ...s, [key]: "done" }));
            return v;
          },
          (err) => {
            setSectionStatus((s) => ({ ...s, [key]: "error" }));
            throw err;
          },
        );
      const [investigations, microbiology_results, patient_observations] = await Promise.all([
        track("investigations", listInvFn({ data: { patientId } })),
        track("microbiology", listMicroFn({ data: { patientId } })),
        track("observations", listObsFn({ data: { patientId } })),
      ]);
      const handoverPatient = {
        ...patient,
        investigations,
        microbiology_results,
        patient_observations,
      } as HandoverPatient;
      downloadHandover([handoverPatient], {
        title: `ICU Handover — ${patient.full_name ?? "Patient"}`,
        orientation: "portrait",
      });
    },
    onSuccess: () => toast.success("Handover PDF downloaded"),
    onError: (e: Error) =>
      toast.error("Could not generate handover PDF", { description: e.message }),
  });

  if (profile && !hasClinicalAccess)
    return (
      <ClinicalAccessRequired
        backTo="/patients"
        backLabel="Back to board"
        description="You need clinical access (clinician or admin) to view this patient record and its history."
      />
    );

  if (isLoading) return <ListSkeleton rows={3} />;
  if (!patient)
    return (
      <div className="space-y-3">
        <p>Patient not found.</p>
        <Link to="/patients"><Button variant="outline">Back to board</Button></Link>
      </div>
    );

  const missingForHandover = missingCriticalFields(patient);

  // Missing-field warnings now deep-link to the Demographics tab instead of an
  // edit dialog; each label maps to a tab where the field is editable inline.
  const openDemographics = () => setActiveTab("demographics");


  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link to="/patients">
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ArrowLeft className="h-4 w-4" /> Board
          </Button>
        </Link>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">

            <PatientName patient={patient} size="lg" />
            <Badge className={STATUS_BADGE[patient.status]} variant="secondary">
              {STATUS_LABELS[patient.status]}
            </Badge>
            {patient.dnacpr_decision && (
              <Badge variant="outline" className="gap-1 border-rose-300 text-rose-700 dark:text-rose-300">
                <AlertTriangle className="h-3 w-3" /> DNACPR
              </Badge>
            )}
            {patient.source_referral_id && (
              <Badge variant="outline" className="gap-1">
                <ClipboardPlus className="h-3 w-3" /> From referral
              </Badge>
            )}
            {patient.shared_with_partner ? (
              <Badge variant="outline" className="gap-1 border-sky-300 text-sky-700 dark:text-sky-300">
                <Share2 className="h-3 w-3" /> Shared with partner
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                <ShieldOff className="h-3 w-3" /> Not shared with partner
              </Badge>
            )}

          </div>
          <PatientMetaLine
            patient={patient}
            leading={[patient.ward ? `${patient.ward}${patient.bed ? ` · Bed ${patient.bed}` : ""}` : null]}
          />
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {profile?.isAdmin && (
            <label className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
              <Share2 className="h-4 w-4 text-muted-foreground" />
              <span>Share with partner</span>
              <Switch
                checked={Boolean(patient.shared_with_partner)}
                disabled={shareMut.isPending}
                onCheckedChange={(v) => shareMut.mutate(v)}
                aria-label="Share this patient with the partner app"
              />
            </label>
          )}
          <PrefillFromReferral
            patientId={patientId}
            linked={Boolean(patient.source_referral_id)}
            onDone={() => {
              qc.invalidateQueries({ queryKey: ["patient", patientId] });
              qc.invalidateQueries({ queryKey: ["patients"] });
              qc.invalidateQueries({ queryKey: ["patient-audit", patientId] });
            }}
          />

          <div className="flex flex-col items-start gap-1.5">
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => {
                if (missingForHandover.length > 0) {
                  toast.warning("Cannot generate handover PDF", {
                    description: `Missing required data: ${missingForHandover.join(", ")}`,
                  });
                  return;
                }
                exportMut.mutate();
              }}
              disabled={exportMut.isPending}
              aria-busy={exportMut.isPending}
            >
              {exportMut.isPending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Preparing…
                </>
              ) : (
                <>
                  <FileDown className="h-4 w-4" /> Handover PDF
                </>
              )}
            </Button>
            {missingForHandover.length > 0 && !exportMut.isPending && (
              <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                <span>Missing:</span>
                {missingForHandover.map((label, i) => {
                  const canJump = Boolean(MISSING_FIELD_ANCHORS[label]);
                  return (
                    <span key={label} className="flex items-center">
                      {canJump ? (
                        <button
                          type="button"
                          onClick={openDemographics}
                          className="font-medium underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-100"
                        >
                          {label}
                        </button>
                      ) : (
                        <span className="font-medium">{label}</span>
                      )}
                      {i < missingForHandover.length - 1 && <span>,</span>}
                    </span>
                  );
                })}
              </div>
            )}
            {exportMut.isPending && (
              <ul className="rounded-md border bg-muted/40 px-2.5 py-1.5 text-xs" aria-live="polite">
                {([
                  ["investigations", "Investigations"],
                  ["microbiology", "Microbiology"],
                  ["observations", "Observations"],
                ] as const).map(([key, label]) => {
                  const st = sectionStatus[key];
                  return (
                    <li key={key} className="flex items-center gap-1.5 py-0.5">
                      {st === "done" ? (
                        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                      ) : st === "error" ? (
                        <AlertTriangle className="h-3.5 w-3.5 text-rose-600" />
                      ) : st === "loading" ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      ) : (
                        <Circle className="h-3.5 w-3.5 text-muted-foreground/50" />
                      )}
                      <span
                        className={
                          st === "error"
                            ? "text-rose-600"
                            : st === "done"
                              ? "text-foreground"
                              : "text-muted-foreground"
                        }
                      >
                        {label}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>


      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <div className="relative">
          <TabsList className="flex h-12 w-full max-w-full items-stretch justify-start gap-1 overflow-x-auto sm:h-9">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="demographics">Demographics</TabsTrigger>
            <TabsTrigger value="observations">Observations</TabsTrigger>
            <TabsTrigger value="chart">24h Chart</TabsTrigger>
            <TabsTrigger value="lines">Lines & devices</TabsTrigger>
            <TabsTrigger value="escalation">Escalation & Resus</TabsTrigger>
            <TabsTrigger value="nok">Next of kin</TabsTrigger>
            <TabsTrigger value="investigations">Investigations</TabsTrigger>
            <TabsTrigger value="microbiology">Microbiology</TabsTrigger>
            <TabsTrigger value="reviews">Specialty reviews</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="status">Status</TabsTrigger>
            <TabsTrigger value="history">History</TabsTrigger>
          </TabsList>
          {/* Right-edge fade so users see there's more to scroll on narrow viewports. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-0 right-0 w-8 rounded-r-md bg-gradient-to-l from-background to-transparent sm:hidden"
          />
        </div>


        <TabsContent value="observations" className="mt-4 space-y-4">
          <ObservationsCard
            patientId={patientId}
            support={{
              ventilated:
                patient.airway_type === "ett" ||
                patient.airway_type === "tracheostomy" ||
                (Array.isArray(patient.resp_support) && patient.resp_support.length > 0),
              rrt: patient.renal_rrt === true,
              vasoactive: Array.isArray(patient.vasoactive_agents) && patient.vasoactive_agents.length > 0,
            }}
          />
        </TabsContent>

        <TabsContent value="chart" className="mt-4 space-y-4">
          <ChartTab patientId={patientId} />
        </TabsContent>

        <TabsContent value="lines" className="mt-4 space-y-4">
          <LinesCard patientId={patientId} />
        </TabsContent>

        <TabsContent value="demographics" className="mt-4 space-y-4">
          <DemographicsTab patient={patient} />
        </TabsContent>



        <TabsContent value="overview" className="mt-4 space-y-4">
          <SafetySummary patient={patient} />
          <RecentChangesRibbon patientId={patientId} />
          <RecentInvestigations patientId={patientId} />
          <Card>
            <CardContent className="grid gap-6 p-6 sm:grid-cols-2">
              <EditableField patientId={patientId} field="parent_specialty" label="Parent specialty" value={patient.parent_specialty} />
              <EditableField patientId={patientId} field="specialty_consultant" label="Specialty consultant" value={patient.specialty_consultant} />
              <EditableField patientId={patientId} field="past_medical_history" label="Past medical history" value={patient.past_medical_history} multiline />
              <EditableField patientId={patientId} field="current_admission" label="Current admission" value={patient.current_admission} multiline />
              <EditableField patientId={patientId} field="current_management" label="Current management" value={patient.current_management} multiline />
            </CardContent>
          </Card>
          <DailyGoalsCard patient={patient} />
          <OutstandingTasks patientId={patientId} freeText={patient.outstanding_tasks} />

          <Card>
            <CardContent className="p-6">
              <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Systems review
              </h3>
              <div className="grid gap-6 sm:grid-cols-2">
                <RespiratoryStatus patientId={patientId} patient={patient} />
                <CardiovascularStatus patientId={patientId} patient={patient} />
                <NeuroStatus patientId={patientId} patient={patient} />
                <RenalStatus patientId={patientId} patient={patient} />
                <GastroNutritionStatus patientId={patientId} patient={patient} />
                <HaemStatus patientId={patientId} patient={patient} />
                <MicroStatus patientId={patientId} patient={patient} />
                <EditableField patientId={patientId} field="systems_other" label="Other" value={patient.systems_other} multiline />
              </div>
            </CardContent>
          </Card>

          <OverviewChartCard patientId={patientId} />

        </TabsContent>

        <TabsContent value="escalation" className="mt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">Treatment escalation plan</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                <Badge variant={patient.tep_in_place ? "default" : "secondary"}>
                  {patient.tep_in_place ? "TEP in place" : "No TEP recorded"}
                </Badge>
                {(() => {
                  const excl = parseTepExclusions(patient.tep_exclusions);
                  return (
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        Not for
                      </p>
                      {excl.length === 0 ? (
                        <p className="text-sm text-muted-foreground">No intervention limits recorded.</p>
                      ) : (
                        <div className="mt-1 flex flex-wrap gap-1.5">
                          {excl.map((k) => (
                            <Badge
                              key={k}
                              variant="outline"
                              className="border-destructive text-destructive"
                            >
                              ✕ {TEP_INTERVENTION_LABEL[k]}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })()}
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
          <InvestigationsTab
            patientId={patientId}
            focusId={focus?.tab === "investigations" ? focus.id : null}
            focusSeq={focus?.tab === "investigations" ? focus.seq : 0}
          />
        </TabsContent>

        <TabsContent value="microbiology" className="mt-4">
          <MicrobiologyTab
            patientId={patientId}
            patient={patient}
            focusId={focus?.tab === "microbiology" ? focus.id : null}
            focusSeq={focus?.tab === "microbiology" ? focus.seq : 0}
          />
        </TabsContent>

        <TabsContent value="reviews" className="mt-4">
          <ReviewsTab patientId={patientId} />
        </TabsContent>

        <TabsContent value="timeline" className="mt-4">
          <TimelineTab
            patient={patient}
            patientId={patientId}
            filters={timelineFilters}
            onFiltersChange={setTimelineFilters}
            onNavigate={(tab, id) => {
              setFocus({ tab, id, seq: Date.now() });
              setActiveTab(tab);
            }}
          />

        </TabsContent>

        <TabsContent value="status" className="mt-4">
          <StatusTab
            patient={patient}
            onDelete={() => deleteMut.mutate()}
            isDeleting={deleteMut.isPending}
          />
        </TabsContent>

        <TabsContent value="history" className="mt-4">
          <AuditTab patientId={patientId} />
        </TabsContent>

      </Tabs>

      {conflict.dialog}
    </div>

  );
}

function shiftISODate(iso: string, delta: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  const mm = `${dt.getUTCMonth() + 1}`.padStart(2, "0");
  const dd = `${dt.getUTCDate()}`.padStart(2, "0");
  return `${dt.getUTCFullYear()}-${mm}-${dd}`;
}

function todayISO(): string {
  const d = new Date();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
}

function OverviewChartCard({ patientId }: { patientId: string }) {
  const listDays = useServerFn(listChartDays);
  const [expanded, setExpanded] = useState(false);
  const [date, setDate] = useState<string>(() => {
    const d = new Date();
    const m = `${d.getMonth() + 1}`.padStart(2, "0");
    const day = `${d.getDate()}`.padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  });
  const [chartKey, setChartKey] = useState(0);

  const daysQ = useQuery({
    queryKey: ["chart-days-overview", patientId],
    queryFn: () => listDays({ data: { patientId, includeArchived: true } }),
  });

  const open = (d: string) => {
    setDate(d);
    setExpanded(true);
    setChartKey((k) => k + 1);
  };

  const recent = (daysQ.data ?? []).slice(0, 8);

  return (
    <Card>
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="text-base">24-hour chart</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor="overview-chart-date" className="text-xs text-muted-foreground">
            Open date
          </label>
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-8 w-8 shrink-0"
            onClick={() => setDate((d) => shiftISODate(d, -1))}
            aria-label="Previous day"
            title="Previous day"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <input
            id="overview-chart-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-8 rounded border bg-background px-2 text-sm"
          />
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-8 w-8 shrink-0"
            onClick={() => setDate((d) => shiftISODate(d, 1))}
            aria-label="Next day"
            title="Next day"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-8 shrink-0"
            onClick={() => open(todayISO())}
            aria-label="Open today's chart"
            title="Open today's chart"
          >
            Today
          </Button>
          <Button size="sm" variant="outline" onClick={() => open(date)}>
            Open
          </Button>
        </div>

      </CardHeader>
      <CardContent className="space-y-3">
        {recent.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Recent:</span>
            {recent.map((d) => (
              <button
                key={d.id}
                type="button"
                onClick={() => open(d.chart_date)}
                className={`rounded border px-2 py-0.5 text-xs hover:bg-accent ${
                  d.archived_at ? "border-amber-400/60 text-amber-800 dark:text-amber-200" : ""
                }`}
                title={d.archived_at ? "Archived" : "Active"}
              >
                {d.chart_date}
                {d.archived_at ? " · archived" : ""}
              </button>
            ))}
          </div>
        )}
        {expanded ? (
          <div className="pt-2">
            <ChartTab key={chartKey} patientId={patientId} initialDate={date} />
          </div>
        ) : (
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded(true)}
          >
            Show digital 24h chart (click to expand)
          </button>
        )}
      </CardContent>
    </Card>
  );
}

