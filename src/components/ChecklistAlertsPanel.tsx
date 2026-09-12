import { Link } from "@tanstack/react-router";
import { AlertTriangle, ClipboardList, Clock, ShieldAlert } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtDateTime } from "@/lib/icu";
import { dueRelativeLabel, snooze } from "@/lib/task-reminders";
import { roleLabel } from "@/lib/checklists";
import type { ChecklistAlertRow } from "@/hooks/use-checklist-alerts";

/**
 * Unit-wide panel of checklist items that are late or, for key items, missed —
 * so nothing on an active management checklist slips through.
 */
export function ChecklistAlertsPanel({
  missed,
  overdue,
  soon,
  showSoon = true,
}: {
  missed: ChecklistAlertRow[];
  overdue: ChecklistAlertRow[];
  soon?: ChecklistAlertRow[];
  showSoon?: boolean;
}) {
  const soonRows = showSoon ? (soon ?? []) : [];
  const rows = [...missed, ...overdue, ...soonRows];
  if (rows.length === 0) return null;

  return (
    <Card
      className={
        missed.length > 0
          ? "border-rose-500/50"
          : overdue.length > 0
            ? "border-rose-500/40"
            : "border-amber-500/40"
      }
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <ClipboardList className="h-4 w-4" /> Checklist alerts
          {missed.length > 0 && (
            <Badge variant="outline" className="border-rose-500/50 text-rose-600 dark:text-rose-400">
              {missed.length} key item{missed.length === 1 ? "" : "s"} missed
            </Badge>
          )}
          {overdue.length > 0 && (
            <Badge variant="outline" className="border-rose-500/40 text-rose-600 dark:text-rose-400">
              {overdue.length} overdue
            </Badge>
          )}
          {soonRows.length > 0 && (
            <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
              {soonRows.length} due soon
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5">
        {rows.map((a) => (
          <div
            key={a.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2 text-sm"
          >
            {a.level === "missed" ? (
              <ShieldAlert className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
            ) : a.level === "overdue" ? (
              <AlertTriangle className="h-4 w-4 shrink-0 text-rose-600 dark:text-rose-400" />
            ) : (
              <Clock className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            )}
            <span className="min-w-0 flex-1">
              <span className="font-medium">{a.itemLabel}</span>
              <span className="block text-xs text-muted-foreground">
                {a.patientLabel} · {a.checklistName}
                {a.dueAt ? ` · due ${fmtDateTime(a.dueAt)} · ${dueRelativeLabel(a.dueAt)}` : " · no target time set"}
                {a.responsible ? ` · ${roleLabel(a.responsible)}` : ""}
              </span>
            </span>
            <Button asChild size="sm" variant="ghost">
              <Link
                to="/patients/$patientId"
                params={{ patientId: a.patientId }}
                search={{ tab: "checklists" } as never}
              >
                Open
              </Link>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => snooze(a.id)}>
              Snooze
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
