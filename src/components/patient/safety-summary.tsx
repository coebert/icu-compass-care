import { AlertTriangle, BedDouble, Clock, HeartPulse, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  ALLERGY_SEVERITY_LABEL,
  DAILY_GOAL_ITEMS,
  dailyGoalsProgress,
  deriveSafetyFlags,
  parseAllergies,
  parseDailyGoals,
  parseTepExclusions,
  TEP_INTERVENTION_LABEL,
  type AllergySeverity,
} from "@/lib/patient-safety";

const SEVERITY_CLASS: Record<AllergySeverity, string> = {
  unknown: "border-muted-foreground/40 text-muted-foreground",
  mild: "border-amber-300 text-amber-700 dark:text-amber-300",
  moderate: "border-amber-400 text-amber-800 dark:text-amber-200",
  severe: "border-rose-400 text-rose-700 dark:text-rose-300",
  anaphylaxis: "border-rose-500 bg-rose-500/10 text-rose-700 dark:text-rose-300",
};

// A dense "one-look" safety strip for the top of the patient overview: allergies,
// weight and the key resus/isolation flags — everything a ward round needs at a glance.
export function SafetySummary({ patient }: { patient: Record<string, unknown> }) {
  const flags = deriveSafetyFlags(patient);
  const allergies = parseAllergies(patient.allergies);
  const weight = patient.weight_kg != null ? `${patient.weight_kg} kg` : null;
  const tepExclusions = parseTepExclusions(patient.tep_exclusions);

  return (
    <Card className={allergies.length > 0 ? "border-rose-300 dark:border-rose-900" : undefined}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          {flags.dnacpr && (
            <Badge variant="outline" className="gap-1 border-rose-300 text-rose-700 dark:text-rose-300">
              <AlertTriangle className="h-3 w-3" /> DNACPR
            </Badge>
          )}
          {flags.tep && (
            <Badge variant="outline" className="gap-1">
              <ShieldCheck className="h-3 w-3" /> TEP in place
            </Badge>
          )}
          {flags.isolation && (
            <Badge variant="outline" className="gap-1 border-amber-300 text-amber-700 dark:text-amber-300">
              <BedDouble className="h-3 w-3" /> Isolation
            </Badge>
          )}
          {weight && (
            <Badge variant="outline" className="gap-1">
              <HeartPulse className="h-3 w-3" /> {weight}
            </Badge>
          )}
          {flags.stale && (
            <Badge variant="outline" className="gap-1 border-muted-foreground/40 text-muted-foreground">
              <Clock className="h-3 w-3" />
              Updated {flags.staleHours != null ? `${Math.floor(flags.staleHours)}h ago` : "a while ago"}
            </Badge>
          )}
        </div>

        {tepExclusions.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Not for</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {tepExclusions.map((k) => (
                <Badge key={k} variant="outline" className="gap-1 border-destructive text-destructive">
                  <AlertTriangle className="h-3 w-3" /> {TEP_INTERVENTION_LABEL[k]}
                </Badge>
              ))}
            </div>
          </div>
        )}


        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Allergies</p>
          {allergies.length === 0 ? (
            <p className="text-sm text-muted-foreground">No known allergies recorded.</p>
          ) : (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {allergies.map((a, i) => (
                <Badge
                  key={i}
                  variant="outline"
                  className={`gap-1 ${SEVERITY_CLASS[(a.severity as AllergySeverity) ?? "unknown"]}`}
                >
                  <AlertTriangle className="h-3 w-3" />
                  <span className="font-medium">{a.substance}</span>
                  {a.reaction ? <span className="opacity-80">· {a.reaction}</span> : null}
                  <span className="opacity-70">
                    ({ALLERGY_SEVERITY_LABEL[(a.severity as AllergySeverity) ?? "unknown"]})
                  </span>
                </Badge>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// A compact daily-goals (FAST-HUG) checklist display with review stamp.
export function DailyGoalsCard({ patient }: { patient: Record<string, unknown> }) {
  const goals = parseDailyGoals(patient.daily_goals);
  const { done, total } = dailyGoalsProgress(goals);
  const reviewedBy = patient.daily_goals_reviewed_by as string | null;
  const reviewedAt = patient.daily_goals_reviewed_at as string | null;

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Daily goals</h3>
          <Badge variant="secondary">{done}/{total}</Badge>
        </div>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {DAILY_GOAL_ITEMS.map((item) => {
            const on = !!goals[item.key];
            return (
              <div
                key={item.key}
                className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm ${
                  on ? "border-emerald-300 text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"
                }`}
              >
                <span
                  className={`inline-block h-2 w-2 shrink-0 rounded-full ${on ? "bg-emerald-500" : "bg-muted-foreground/30"}`}
                />
                {item.label}
              </div>
            );
          })}
        </div>
        {(reviewedBy || reviewedAt) && (
          <p className="text-xs text-muted-foreground">
            Last reviewed {reviewedAt ? new Date(reviewedAt).toLocaleString() : ""}
            {reviewedBy ? ` by ${reviewedBy}` : ""}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
