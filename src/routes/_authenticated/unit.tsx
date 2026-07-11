import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPatients } from "@/lib/patients.functions";
import { listOpenTasks, TASK_PRIORITY_LABEL, type TaskPriority } from "@/lib/patient-tasks.functions";
import { listBeds, type Bed } from "@/lib/beds.functions";
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

function UnitDashboard() {
  const list = useServerFn(listPatients);
  const beds = useServerFn(listBeds);

  const { data: patients = [] } = useQuery({
    queryKey: ["patients"],
    queryFn: () => list() as Promise<Patient[]>,
  });
  const { data: bedRoster = [] } = useQuery({
    queryKey: ["beds"],
    queryFn: () => beds() as Promise<Bed[]>,
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
        <StatCard icon={Activity} label="Total active patients" value={active.length} />
        <StatCard icon={ShieldAlert} label="No resus/TEP decision" value={stats.noResus.length} tone={stats.noResus.length ? "danger" : "default"} />
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        <ListCard
          icon={ShieldAlert}
          title="Awaiting resus / escalation decision"
          patients={stats.noResus}
          empty="Every ICU patient has a TEP or DNACPR decision recorded."
        />
        <ListCard
          icon={ClipboardList}
          title="Outstanding jobs"
          patients={stats.jobs}
          empty="No outstanding jobs recorded."
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
    </div>
  );
}
