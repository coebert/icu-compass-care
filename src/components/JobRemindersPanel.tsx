import { Link } from "@tanstack/react-router";
import { AlertTriangle, BellRing, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtDateTime } from "@/lib/icu";
import { snooze } from "@/lib/task-reminders";
import type { JobReminder } from "@/hooks/use-job-reminders";

/**
 * Summary panel of jobs that are overdue or coming due, so the resident team
 * sees the whole unit's time-critical work in one place.
 */
export function JobRemindersPanel({
  overdue,
  soon,
}: {
  overdue: JobReminder[];
  soon: JobReminder[];
}) {
  if (overdue.length === 0 && soon.length === 0) return null;

  return (
    <Card className={overdue.length > 0 ? "border-rose-500/40" : "border-amber-500/40"}>
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <BellRing className="h-4 w-4" /> Reminders
          {overdue.length > 0 && (
            <Badge variant="outline" className="border-rose-500/40 text-rose-600 dark:text-rose-400">
              {overdue.length} overdue
            </Badge>
          )}
          {soon.length > 0 && (
            <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
              {soon.length} due soon
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {[...overdue, ...soon].map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-sm"
          >
            {r.level === "overdue" ? (
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
            ) : (
              <Clock className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            )}
            <span className="min-w-0 flex-1">
              <span className="font-medium">{r.description}</span>
              <span className="block text-xs text-muted-foreground">
                {r.patientLabel} · {fmtDateTime(r.dueAt)} · {r.relative}
                {r.owner ? ` · ${r.owner}` : ""}
              </span>
            </span>
            <Button size="sm" variant="ghost" onClick={() => snooze(r.id)}>
              Snooze
            </Button>
            <Link
              to="/patients/$patientId"
              params={{ patientId: r.patientId }}
              className="text-xs text-primary underline-offset-2 hover:underline"
            >
              Open notes →
            </Link>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
