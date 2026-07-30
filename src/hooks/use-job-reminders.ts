import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { listOpenTasks } from "@/lib/patient-tasks.functions";
import { listPatients } from "@/lib/patients.functions";
import {
  dueLevel,
  dueRelativeLabel,
  isSnoozed,
  markNotified,
  reminderKey,
  snooze,
  wasNotified,
  type DueLevel,
} from "@/lib/task-reminders";
import { formatInitials, formatHospitalNumber } from "@/components/PatientSummary";

export type JobReminder = {
  id: string;
  patientId: string;
  patientLabel: string;
  description: string;
  dueAt: string;
  level: Exclude<DueLevel, "none">;
  relative: string;
  priority: string | null;
  owner: string | null;
};

/**
 * Watches every open ICU job and surfaces reminders as they approach their due
 * time or fall overdue. Polls in the background so a clinician who leaves the
 * app open on the ward still gets nudged.
 */
export function useJobReminders(options?: { toasts?: boolean }) {
  const withToasts = options?.toasts ?? false;
  const fetchTasks = useServerFn(listOpenTasks);
  const fetchPatients = useServerFn(listPatients);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const { data: tasks = [] } = useQuery({
    queryKey: ["job-reminder-tasks"],
    queryFn: () => fetchTasks() as Promise<any[]>,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const { data: patients = [] } = useQuery({
    queryKey: ["job-reminder-patients"],
    queryFn: () => fetchPatients() as Promise<any[]>,
    staleTime: 5 * 60_000,
  });

  const reminders = useMemo<JobReminder[]>(() => {
    const byId = new Map((patients ?? []).map((p: any) => [p.id, p]));
    return (tasks ?? [])
      .map((t: any) => {
        const level = dueLevel(t.due_at, now);
        if (level === "none" || !t.due_at) return null;
        const p = byId.get(t.patient_id);
        const label = p
          ? [formatInitials(p), formatHospitalNumber(p.hospital_number), p.bed ? `Bed ${p.bed}` : null]
              .filter(Boolean)
              .join(" · ")
          : "Unknown patient";
        return {
          id: t.id,
          patientId: t.patient_id,
          patientLabel: label,
          description: t.description,
          dueAt: t.due_at as string,
          level,
          relative: dueRelativeLabel(t.due_at, now),
          priority: t.priority ?? null,
          owner: t.owner ?? null,
        } satisfies JobReminder;
      })
      .filter(Boolean)
      .sort((a: any, b: any) => new Date(a.dueAt).getTime() - new Date(b.dueAt).getTime()) as JobReminder[];
  }, [tasks, patients, now]);

  // Fire one toast per job per escalation level (due soon, then overdue).
  const seeded = useRef(false);
  useEffect(() => {
    if (!withToasts) return;
    if (!seeded.current) seeded.current = true;
    for (const r of reminders) {
      if (isSnoozed(r.id, now)) continue;
      const key = reminderKey(r.id, r.dueAt, r.level);
      if (wasNotified(key)) continue;
      markNotified(key);
      const fn = r.level === "overdue" ? toast.error : toast.warning;
      fn(r.level === "overdue" ? "Job overdue" : "Job due soon", {
        description: `${r.patientLabel} — ${r.description} (${r.relative})`,
        duration: 12_000,
        action: {
          label: "Snooze 30m",
          onClick: () => snooze(r.id),
        },
      });
    }
  }, [reminders, withToasts, now]);

  const overdue = reminders.filter((r) => r.level === "overdue");
  const soon = reminders.filter((r) => r.level === "soon");

  return { reminders, overdue, soon };
}
