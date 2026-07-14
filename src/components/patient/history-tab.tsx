import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getPatientAudit, getPatientFieldChanges } from "@/lib/patients.functions";
import { useClinicalAccess } from "@/hooks/use-clinical-access";
import { ClinicalAccessRequired } from "@/components/ClinicalAccessRequired";
import { fmtDateTime } from "@/lib/icu";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Clock } from "lucide-react";

type AuditRow = Record<string, any>;

const ACTION_LABEL: Record<string, string> = {
  insert: "Created",
  update: "Updated",
  delete: "Removed",
};

const FIELD_LABEL: Record<string, string> = {
  initials: "Initials",
  age: "Age",
  hospital_number: "Hospital number",
  current_admission: "Current admission",
  current_management: "Current management",
  past_medical_history: "Past medical history",
  dnacpr_decision: "DNACPR decision",
  dnacpr_details: "DNACPR details",
  tep_in_place: "TEP in place",
  tep_details: "TEP details",
  tep_exclusions: "TEP — not for",
  isolation_required: "Isolation",
  airway_type: "Airway",
  nutrition_route: "Nutrition",
  systems_resp: "Respiratory",
  systems_cvs: "Cardiovascular",
  systems_neuro: "Neurology",
  systems_renal: "Renal",
  systems_gastro: "Gastro",
  systems_micro: "Microbiology",
  systems_haem: "Haematology",
  systems_other: "Other systems",
};

// Compact ribbon of the most recent clinical changes, for the incoming team.
function truncate(v: string | null | undefined, n = 80): string {
  const s = (v ?? "").trim();
  if (!s) return "—";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function AuditTab({ patientId }: { patientId: string }) {
  const fetchAudit = useServerFn(getPatientAudit);
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["patient-audit", patientId],
    queryFn: () => fetchAudit({ data: { id: patientId } }) as Promise<AuditRow[]>,
  });

  if (isLoading) return <RowSkeleton rows={6} />;
  if (rows.length === 0)
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No change history recorded yet.
        </CardContent>
      </Card>
    );

  return (
    <div className="space-y-4">
      <FieldChangeHistory patientId={patientId} />
      <div className="space-y-2">
        {rows.map((r) => {
          const who = r.actor_email || (r.actor_role ? `a ${r.actor_role}` : "unknown user");
          const fields: string[] = r.changed_fields ?? [];
          return (
            <Card key={r.id}>
              <CardContent className="space-y-1 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="secondary">{ACTION_LABEL[r.action] ?? r.action}</Badge>
                  <Badge variant="outline">
                    {r.source === "bridge" ? "Linked app" : "This app"}
                  </Badge>
                  <span className="text-sm">{who}</span>
                  <span className="ml-auto text-xs text-muted-foreground">
                    {fmtDateTime(r.created_at)}
                  </span>
                </div>
                {r.action === "update" && fields.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Changed: {fields.map((f) => f.replace(/_/g, " ")).join(", ")}
                  </p>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export function RecentChangesRibbon({ patientId }: { patientId: string }) {
  const { hasClinicalAccess } = useClinicalAccess();
  const fetchChanges = useServerFn(getPatientFieldChanges);
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["patient-field-changes", patientId],
    queryFn: () => fetchChanges({ data: { id: patientId } }) as Promise<AuditRow[]>,
    enabled: hasClinicalAccess,
  });

  const recent = useMemo(() => rows.slice(0, 6), [rows]);
  if (!hasClinicalAccess || isLoading || recent.length === 0) return null;

  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="space-y-2 p-3">
        <p className="flex items-center gap-2 text-sm font-semibold">
          <Clock className="h-4 w-4" /> What changed recently
        </p>
        <div className="space-y-1.5">
          {recent.map((r) => (
            <div key={r.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="font-medium">{FIELD_LABEL[r.field_name] ?? r.field_name}</span>
              <span className="text-muted-foreground">
                {truncate(r.old_value)} → {truncate(r.new_value)}
              </span>
              <span className="ml-auto text-muted-foreground">
                {r.changed_by_email ? `${r.changed_by_email} · ` : ""}
                {fmtDateTime(r.changed_at)}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function FieldChangeHistory({ patientId }: { patientId: string }) {
  const { hasClinicalAccess, profile } = useClinicalAccess();
  const fetchChanges = useServerFn(getPatientFieldChanges);
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["patient-field-changes", patientId],
    queryFn: () => fetchChanges({ data: { id: patientId } }) as Promise<AuditRow[]>,
    enabled: hasClinicalAccess,
  });

  if (profile && !hasClinicalAccess) {
    return (
      <ClinicalAccessRequired description="You need clinical access (clinician or admin) to view this patient's field change history." />
    );
  }

  if (isLoading || rows.length === 0) return null;

  return (
    <Card>
      <CardContent className="space-y-2 p-3">
        <p className="text-sm font-semibold">Field change history</p>
        <div className="space-y-1.5">
          {rows.map((r) => (
            <div key={r.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
              <span className="font-medium">{FIELD_LABEL[r.field_name] ?? r.field_name}</span>
              <span className="text-muted-foreground">
                {r.old_value ?? "—"} → {r.new_value ?? "—"}
              </span>
              <span className="text-muted-foreground">
                by {r.changed_by_email || "unknown user"}
              </span>
              <span className="ml-auto text-muted-foreground">{fmtDateTime(r.changed_at)}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
