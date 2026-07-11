import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listPatients } from "@/lib/patients.functions";
import { listLatestObservations } from "@/lib/observations.functions";
import { type Observation } from "@/lib/observations";
import { AcuityBadge } from "@/components/patient/observations-card";
import { normalizeBed } from "@/lib/icu-beds";
import { deriveSafetyFlags } from "@/lib/patient-safety";
import {
  listHandoverAcks,
  setHandoverAck,
  clearHandoverAck,
  listRecentFieldChanges,
  currentShiftKey,
  shiftKeyLabel,
  type HandoverAck,
  type RecentChange,
} from "@/lib/handover-mode.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PatientName } from "@/components/PatientSummary";
import {
  AlertTriangle,
  BedDouble,
  CheckCircle2,
  ClipboardCheck,
  Clock,
  ShieldAlert,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/patients/handover-mode")({
  head: () => ({ meta: [{ title: "Shift handover — ICU Handover" }] }),
  component: HandoverMode,
});

type Patient = Record<string, any>;

const FIELD_LABEL: Record<string, string> = {
  full_name: "Name",
  hospital_number: "Hospital number",
  age: "Age",
  bed: "Bed",
  ward: "Ward",
  status: "Status",
  allergies: "Allergies",
  dnacpr_decision: "DNACPR",
  tep_in_place: "TEP",
  isolation_required: "Isolation",
};

function has(arr: unknown): boolean {
  return Array.isArray(arr) && arr.length > 0;
}

function prettyField(f: string | null): string {
  if (!f) return "record";
  return FIELD_LABEL[f] ?? f.replace(/_/g, " ");
}

function HandoverCard({
  p,
  obs,
  changes,
  ack,
  shiftKey,
}: {
  p: Patient;
  obs: Observation | undefined;
  changes: RecentChange[];
  ack: { given?: HandoverAck; received?: HandoverAck };
  shiftKey: string;
}) {
  const qc = useQueryClient();
  const setFn = useServerFn(setHandoverAck);
  const clearFn = useServerFn(clearHandoverAck);
  const flags = deriveSafetyFlags(p);
  const support = {
    ventilated:
      p.airway_type === "ett" || p.airway_type === "tracheostomy" || has(p.resp_support),
    rrt: p.renal_rrt === true,
    vasoactive: has(p.vasoactive_agents),
  };

  const invalidate = () => qc.invalidateQueries({ queryKey: ["handover-acks", shiftKey] });

  const toggle = useMutation({
    mutationFn: async (action: "given" | "received") => {
      const done = action === "given" ? ack.given : ack.received;
      if (done) {
        await clearFn({ data: { patient_id: p.id, shift_key: shiftKey, action } });
      } else {
        await setFn({ data: { patient_id: p.id, shift_key: shiftKey, action } });
      }
    },
    onSuccess: () => invalidate(),
    onError: (e: Error) => toast.error(e.message),
  });

  const changedFields = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of changes) {
      const label = prettyField(c.field_name);
      if (!seen.has(label)) {
        seen.add(label);
        out.push(label);
      }
    }
    return out;
  }, [changes]);

  return (
    <Card className={ack.given && ack.received ? "border-emerald-500/40" : undefined}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <Badge variant="outline" className="font-mono">
            <BedDouble className="mr-1 h-3 w-3" />
            {normalizeBed(p.bed) || "—"}
          </Badge>
          <Link to="/patients/$patientId" params={{ patientId: p.id }} className="hover:underline">
            <PatientName patient={p} showAge />
          </Link>
          <AcuityBadge latest={obs} support={support} className="ml-auto" />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {flags.dnacpr && (
            <Badge variant="outline" className="border-rose-500/40 text-rose-600 dark:text-rose-400">
              DNACPR
            </Badge>
          )}
          {flags.tep && <Badge variant="outline">TEP</Badge>}
          {flags.isolation && (
            <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
              <ShieldAlert className="mr-1 h-3 w-3" /> Isolation
            </Badge>
          )}
          {flags.hasAllergies && (
            <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mr-1 h-3 w-3" /> {flags.allergies}
            </Badge>
          )}
          {flags.stale && (
            <Badge variant="outline" className="text-muted-foreground">
              <Clock className="mr-1 h-3 w-3" /> Stale
              {flags.staleHours != null ? ` ${flags.staleHours}h` : ""}
            </Badge>
          )}
        </div>

        {changedFields.length > 0 && (
          <div className="rounded-md bg-muted/60 p-2 text-xs">
            <span className="font-medium">Changed since handover: </span>
            {changedFields.join(", ")}
          </div>
        )}

        <div className="flex gap-2">
          <Button
            variant={ack.given ? "default" : "outline"}
            size="sm"
            onClick={() => toggle.mutate("given")}
            disabled={toggle.isPending}
          >
            {ack.given && <CheckCircle2 className="mr-1 h-4 w-4" />}
            Given{ack.given?.ack_name ? ` · ${ack.given.ack_name}` : ""}
          </Button>
          <Button
            variant={ack.received ? "default" : "outline"}
            size="sm"
            onClick={() => toggle.mutate("received")}
            disabled={toggle.isPending}
          >
            {ack.received && <CheckCircle2 className="mr-1 h-4 w-4" />}
            Received{ack.received?.ack_name ? ` · ${ack.received.ack_name}` : ""}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function HandoverMode() {
  const shiftKey = useMemo(() => currentShiftKey(), []);
  const list = useServerFn(listPatients);
  const latestObsFn = useServerFn(listLatestObservations);
  const acksFn = useServerFn(listHandoverAcks);
  const changesFn = useServerFn(listRecentFieldChanges);

  const { data: patients = [] } = useQuery({
    queryKey: ["patients"],
    queryFn: () => list() as Promise<Patient[]>,
  });
  const { data: latestObs = [] } = useQuery({
    queryKey: ["latest-observations"],
    queryFn: () => latestObsFn() as Promise<Observation[]>,
  });
  const { data: acks = [] } = useQuery({
    queryKey: ["handover-acks", shiftKey],
    queryFn: () => acksFn({ data: { shiftKey } }) as Promise<HandoverAck[]>,
  });
  const { data: changes = [] } = useQuery({
    queryKey: ["recent-changes", 12],
    queryFn: () => changesFn({ data: { sinceHours: 12 } }) as Promise<RecentChange[]>,
  });

  const obsByPatient = useMemo(() => {
    const m = new Map<string, Observation>();
    for (const o of latestObs) m.set(o.patient_id, o);
    return m;
  }, [latestObs]);

  const changesByPatient = useMemo(() => {
    const m = new Map<string, RecentChange[]>();
    for (const c of changes) {
      const arr = m.get(c.patient_id) ?? [];
      arr.push(c);
      m.set(c.patient_id, arr);
    }
    return m;
  }, [changes]);

  const ackByPatient = useMemo(() => {
    const m = new Map<string, { given?: HandoverAck; received?: HandoverAck }>();
    for (const a of acks) {
      const entry = m.get(a.patient_id) ?? {};
      if (a.action === "given") entry.given = a;
      if (a.action === "received") entry.received = a;
      m.set(a.patient_id, entry);
    }
    return m;
  }, [acks]);

  const ordered = useMemo(() => {
    const active = patients.filter(
      (p) => p.status === "admitted" || p.status === "referred",
    );
    return active.sort((a, b) =>
      normalizeBed(a.bed).localeCompare(normalizeBed(b.bed), undefined, { numeric: true }),
    );
  }, [patients]);

  const complete = ordered.filter((p) => {
    const a = ackByPatient.get(p.id);
    return a?.given && a?.received;
  }).length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <ClipboardCheck className="h-6 w-6" /> Shift handover
          </h1>
          <p className="text-sm text-muted-foreground">{shiftKeyLabel(shiftKey)} · ordered by bed</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={complete === ordered.length && ordered.length > 0 ? "default" : "secondary"}>
            {complete}/{ordered.length} handed over
          </Badge>
          <Button asChild variant="outline" size="sm">
            <Link to="/patients/handover-preview">Export PDF</Link>
          </Button>
        </div>
      </div>

      {ordered.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active patients to hand over.</p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {ordered.map((p) => (
            <HandoverCard
              key={p.id}
              p={p}
              obs={obsByPatient.get(p.id)}
              changes={changesByPatient.get(p.id) ?? []}
              ack={ackByPatient.get(p.id) ?? {}}
              shiftKey={shiftKey}
            />
          ))}
        </div>
      )}
    </div>
  );
}
