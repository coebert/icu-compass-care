import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listOpenChecklists } from "@/lib/checklists.functions";
import { listPatients } from "@/lib/patients.functions";
import {
  CHECKLIST_ALERT_RANK,
  checklistAlerts,
  roleLabel,
  type ChecklistAlert,
} from "@/lib/checklists";
import { isSnoozed, markNotified, reminderKey, snooze, wasNotified } from "@/lib/task-reminders";
import { formatInitials, formatHospitalNumber } from "@/components/PatientSummary";

export type ChecklistAlertRow = ChecklistAlert & { patientLabel: string };

/**
 * Watches every active management checklist and surfaces items that are due
 * soon, overdue, or — for key items — missed. Deadlines are derived from each
 * item's target window or the time staff set for that patient; nothing extra
 * is stored. Polls in the background so a screen left open on the ward keeps
 * nudging.
 */
export function useChecklistAlerts(options?: { toasts?: boolean }) {
  const withToasts = options?.toasts ?? false;
  const fetchChecklists = useServerFn(listOpenChecklists);
  const fetchPatients = useServerFn(listPatients);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const { data: checklists = [] } = useQuery({
    queryKey: ["checklist-alerts"],
    queryFn: () => fetchChecklists() as Promise<any[]>,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: patients = [] } = useQuery({
    queryKey: ["job-reminder-patients"],
    queryFn: () => fetchPatients() as Promise<any[]>,
    staleTime: 5 * 60_000,
  });

  const alerts = useMemo<ChecklistAlertRow[]>(() => {
    const byId = new Map((patients ?? []).map((p: any) => [p.id, p]));
    return (checklists ?? [])
      .flatMap((cl: any) => checklistAlerts(cl, now))
      .map((a) => {
        const p = byId.get(a.patientId);
        const patientLabel = p
          ? [formatInitials(p), formatHospitalNumber(p.hospital_number), p.bed ? `Bed ${p.bed}` : null]
              .filter(Boolean)
              .join(" · ")
          : "Unknown patient";
        return { ...a, patientLabel };
      })
      .sort((a, b) => {
        const rank = CHECKLIST_ALERT_RANK[b.level] - CHECKLIST_ALERT_RANK[a.level];
        if (rank !== 0) return rank;
        const at = a.dueAt ? new Date(a.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
        const bt = b.dueAt ? new Date(b.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
        return at - bt;
      });
  }, [checklists, patients, now]);

  // One toast per item per escalation level, snoozable and deduped.
  useEffect(() => {
    if (!withToasts) return;
    for (const a of alerts) {
      if (a.level === "soon") continue; // only nag once something is late
      if (isSnoozed(a.id, now)) continue;
      const key = reminderKey(a.id, a.dueAt ?? "untimed", a.level);
      if (wasNotified(key)) continue;
      markNotified(key);
      const fn = a.level === "missed" ? toast.error : toast.warning;
      fn(a.level === "missed" ? "Key checklist item missed" : "Checklist item overdue", {
        description: `${a.patientLabel} — ${a.checklistName}: ${a.itemLabel}${
          a.responsible ? ` (${roleLabel(a.responsible)})` : ""
        }`,
        duration: 14_000,
        action: { label: "Snooze 30m", onClick: () => snooze(a.id) },
      });
    }
  }, [alerts, withToasts, now]);

  const missed = alerts.filter((a) => a.level === "missed");
  const overdue = alerts.filter((a) => a.level === "overdue");
  const soon = alerts.filter((a) => a.level === "soon");

  return { alerts, missed, overdue, soon };
}
