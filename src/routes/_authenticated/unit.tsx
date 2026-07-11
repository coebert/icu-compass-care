import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPatients } from "@/lib/patients.functions";
import { listOpenTasks, TASK_PRIORITY_LABEL, type TaskPriority } from "@/lib/patient-tasks.functions";
import { listInSituLines, LINE_TYPE_LABEL, LINE_REVIEW_DAYS, type LineType } from "@/lib/lines.functions";
import { daysInSitu } from "@/lib/lines";
import { listBeds, type Bed } from "@/lib/beds.functions";
import { listLatestObservations } from "@/lib/observations.functions";
import { computeAcuity, type Observation } from "@/lib/observations";
import { AcuityBadge } from "@/components/patient/observations-card";
import { normalizeBed } from "@/lib/icu-beds";
import { deriveSafetyFlags, parseAllergies } from "@/lib/patient-safety";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PatientName } from "@/components/PatientSummary";
import {
  Activity,
  AlertTriangle,
  BedDouble,
  ClipboardList,
  Clock,
  Droplets,
  HeartPulse,
  ShieldAlert,
  Wind,
  Cable,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/unit")({
  head: () => ({ meta: [{ title: "Unit dashboard — ICU Handover" }] }),
  component: UnitDashboard,
});

type Patient = Record<string, any>;

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  sub?: string;
  tone?: "default" | "warn" | "danger";
}) {
  const toneClass =
    tone === "danger"
      ? "text-rose-600 dark:text-rose-400"
      : tone === "warn"
        ? "text-amber-600 dark:text-amber-400"
        : "text-primary";
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`rounded-lg bg-muted p-2 ${toneClass}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="text-2xl font-bold leading-none">{value}</p>
          <p className="truncate text-xs text-muted-foreground">{label}</p>
          {sub && <p className="truncate text-[11px] text-muted-foreground">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function PatientRow({ p, right }: { p: Patient; right?: React.ReactNode }) {
  return (
    <Link
      to="/patients/$patientId"
      params={{ patientId: p.id }}
      className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-muted"
    >
      <span className="min-w-0 truncate">
        <PatientName patient={p} showAge />
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">{right}</span>
    </Link>
  );
}

function ListCard({
  icon: Icon,
  title,
  patients,
  empty,
  right,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  patients: Patient[];
  empty: string;
  right?: (p: Patient) => React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="h-4 w-4" /> {title}
          <Badge variant="secondary" className="ml-auto">{patients.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {patients.length === 0 ? (
          <p className="px-2 py-1 text-sm text-muted-foreground">{empty}</p>
        ) : (
          <div className="space-y-0.5">
            {patients.map((p) => (
              <PatientRow key={p.id} p={p} right={right?.(p)} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function has(arr: unknown): boolean {
  return Array.isArray(arr) && arr.length > 0;
}

const PRIORITY_BADGE: Record<string, string> = {
  critical: "border-rose-500/40 text-rose-600 dark:text-rose-400",
  urgent: "border-amber-500/40 text-amber-600 dark:text-amber-400",
  routine: "border-border text-muted-foreground",
};

function fmtDue(due: string | null): { text: string; overdue: boolean } | null {
  if (!due) return null;
  const t = new Date(due).getTime();
  if (Number.isNaN(t)) return null;
  const overdue = t < Date.now();
  const text = new Date(due).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return { text, overdue };
}

function OpenTasksCard({
  tasks,
  patientById,
}: {
  tasks: OpenTask[];
  patientById: Map<string, Record<string, any>>;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ClipboardList className="h-4 w-4" /> Outstanding tasks (unit-wide)
          <Badge variant="secondary" className="ml-auto">{tasks.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        {tasks.length === 0 ? (
          <p className="px-2 py-1 text-sm text-muted-foreground">No outstanding tasks.</p>
        ) : (
          <div className="space-y-1">
            {tasks.map((t) => {
              const p = patientById.get(t.patient_id);
              const due = fmtDue(t.due_at);
              return (
                <Link
                  key={t.id}
                  to="/patients/$patientId"
                  params={{ patientId: t.patient_id }}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                >
                  {t.priority !== "routine" && (
                    <Badge variant="outline" className={`shrink-0 ${PRIORITY_BADGE[t.priority] ?? ""}`}>
                      {TASK_PRIORITY_LABEL[t.priority as TaskPriority] ?? t.priority}
                    </Badge>
                  )}
                  <span className="min-w-0 flex-1 truncate">{t.description}</span>
                  {t.owner && <span className="shrink-0 text-xs text-muted-foreground">{t.owner}</span>}
                  {due && (
                    <span
                      className={`shrink-0 text-xs ${due.overdue ? "font-medium text-rose-600 dark:text-rose-400" : "text-muted-foreground"}`}
                    >
                      {due.overdue ? "Overdue · " : ""}
                      {due.text}
                    </span>
                  )}
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {p ? <PatientName patient={p} /> : "—"}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}


type OpenTask = {
  id: string;
  patient_id: string;
  description: string;
  priority: string;
  category: string;
  owner: string | null;
  due_at: string | null;
  status: string;
};

function UnitDashboard() {
  const list = useServerFn(listPatients);
  const beds = useServerFn(listBeds);
  const openTasksFn = useServerFn(listOpenTasks);

  const { data: patients = [] } = useQuery({
    queryKey: ["patients"],
    queryFn: () => list() as Promise<Patient[]>,
  });
  const { data: bedRoster = [] } = useQuery({
    queryKey: ["beds"],
    queryFn: () => beds() as Promise<Bed[]>,
  });
  const { data: openTasks = [] } = useQuery({
    queryKey: ["open-tasks"],
    queryFn: () => openTasksFn() as Promise<OpenTask[]>,
  });
  const latestObsFn = useServerFn(listLatestObservations);
  const { data: latestObs = [] } = useQuery({
    queryKey: ["latest-observations"],
    queryFn: () => latestObsFn() as Promise<Observation[]>,
  });

  const obsByPatient = useMemo(() => {
    const m = new Map<string, Observation>();
    for (const o of latestObs) m.set(o.patient_id, o);
    return m;
  }, [latestObs]);

  const patientSupport = (p: Patient) => ({
    ventilated:
      p.airway_type === "ett" || p.airway_type === "tracheostomy" || has(p.resp_support),
    rrt: p.renal_rrt === true,
    vasoactive: has(p.vasoactive_agents),
  });

  const active = useMemo(
    () => patients.filter((p) => p.status === "admitted" || p.status === "referred"),
    [patients],
  );
  const icu = active.filter((p) => p.location_type === "icu");

  const stats = useMemo(() => {
    const ventilated = icu.filter((p) => p.airway_type === "ett" || p.airway_type === "tracheostomy" || has(p.resp_support));
    const vasoactive = icu.filter((p) => has(p.vasoactive_agents));
    const rrt = icu.filter((p) => p.renal_rrt === true);
    const isolation = active.filter((p) => p.isolation_required === true);
    const allergy = active.filter((p) => parseAllergies(p.allergies).length > 0);
    const noResus = icu.filter((p) => !p.dnacpr_decision && !p.tep_in_place);
    const stale = active.filter((p) => deriveSafetyFlags(p).stale);
    const jobs = active.filter((p) => (p.outstanding_tasks ?? "").trim().length > 0);

    const occupied = new Set(icu.map((p) => normalizeBed(p.bed)).filter(Boolean)).size;
    const totalBeds = bedRoster.length;

    return { ventilated, vasoactive, rrt, isolation, allergy, noResus, stale, jobs, occupied, totalBeds };
  }, [icu, active, bedRoster]);

  const highAcuity = useMemo(
    () =>
      icu.filter(
        (p) => computeAcuity(obsByPatient.get(p.id), patientSupport(p)).band === "high",
      ),
    [icu, obsByPatient],
  );


  const patientById = useMemo(() => {
    const m = new Map<string, Patient>();
    for (const p of patients) m.set(p.id, p);
    return m;
  }, [patients]);

  const taskStats = useMemo(() => {
    const now = Date.now();
    const overdue = openTasks.filter((t) => t.due_at && new Date(t.due_at).getTime() < now);
    const critical = openTasks.filter((t) => t.priority === "critical");
    // Show highest-signal tasks first: critical, then overdue, then rest.
    const rank = (t: OpenTask) =>
      t.priority === "critical" ? 0 : t.due_at && new Date(t.due_at).getTime() < now ? 1 : 2;
    const sorted = [...openTasks].sort((a, b) => rank(a) - rank(b));
    return { overdue, critical, sorted };
  }, [openTasks]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Unit dashboard</h1>
        <p className="text-sm text-muted-foreground">Live overview of occupancy, acuity and outstanding safety items</p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <StatCard icon={BedDouble} label="ICU beds occupied" value={`${stats.occupied}${stats.totalBeds ? `/${stats.totalBeds}` : ""}`} />
        <StatCard icon={Wind} label="Ventilated / resp support" value={stats.ventilated.length} />
        <StatCard icon={HeartPulse} label="On vasoactives" value={stats.vasoactive.length} tone="warn" />
        <StatCard icon={Droplets} label="On RRT" value={stats.rrt.length} tone="warn" />
        <StatCard icon={ClipboardList} label="Open tasks" value={openTasks.length} sub={`${taskStats.critical.length} critical`} tone={taskStats.critical.length ? "danger" : "default"} />
        <StatCard icon={Clock} label="Overdue tasks" value={taskStats.overdue.length} tone={taskStats.overdue.length ? "danger" : "default"} />
        <StatCard icon={Activity} label="Total active patients" value={active.length} />
        <StatCard icon={ShieldAlert} label="No resus/TEP decision" value={stats.noResus.length} tone={stats.noResus.length ? "danger" : "default"} />
        <StatCard icon={HeartPulse} label="High acuity" value={highAcuity.length} tone={highAcuity.length ? "danger" : "default"} />
      </div>

      <ListCard
        icon={Activity}
        title="ICU acuity"
        patients={icu}
        empty="No ICU patients."
        right={(p) => <AcuityBadge latest={obsByPatient.get(p.id)} support={patientSupport(p)} />}
      />

      <OpenTasksCard tasks={taskStats.sorted} patientById={patientById} />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <ListCard
          icon={ShieldAlert}
          title="Awaiting resus / escalation decision"
          patients={stats.noResus}
          empty="Every ICU patient has a TEP or DNACPR decision recorded."
        />
        <ListCard
          icon={BedDouble}
          title="Isolation"
          patients={stats.isolation}
          empty="No patients flagged for isolation."
        />
        <ListCard
          icon={AlertTriangle}
          title="Recorded allergies"
          patients={stats.allergy}
          empty="No allergies recorded across active patients."
          right={(p) => parseAllergies(p.allergies).map((a) => a.substance).join(", ")}
        />
        <ListCard
          icon={Clock}
          title="Records not updated recently"
          patients={stats.stale}
          empty="All records updated recently."
          right={(p) => {
            const h = deriveSafetyFlags(p).staleHours;
            return h != null ? `${Math.floor(h)}h ago` : "";
          }}
        />
      </div>

      <LinesSurveillanceCard patientById={patientById} />
    </div>
  );
}
