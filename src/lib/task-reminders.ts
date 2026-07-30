// Shared logic for ICU job due-date reminders.
//
// Reminders are derived client-side from each job's `due_at`; nothing extra is
// stored server-side. Dedupe/snooze state is kept in localStorage so a
// clinician isn't re-nagged about the same job on every poll.

export type DueLevel = "none" | "soon" | "overdue";

/** Jobs due within this window count as "due soon". */
export const DUE_SOON_MS = 2 * 60 * 60 * 1000;
/** How long a snoozed reminder stays quiet. */
export const SNOOZE_MS = 30 * 60 * 1000;

export function dueLevel(
  due?: string | null,
  now: number = Date.now(),
  soonMs: number = DUE_SOON_MS,
): DueLevel {
  if (!due) return "none";
  const t = new Date(due).getTime();
  if (Number.isNaN(t)) return "none";
  const diff = t - now;
  if (diff < 0) return "overdue";
  if (diff <= soonMs) return "soon";
  return "none";
}

/** "in 45 min" / "35 min overdue" style helper for reminder copy. */
export function dueRelativeLabel(due: string, now: number = Date.now()): string {
  const t = new Date(due).getTime();
  if (Number.isNaN(t)) return "";
  const diffMin = Math.round((t - now) / 60000);
  const abs = Math.abs(diffMin);
  const unit =
    abs < 60
      ? `${abs} min`
      : abs < 60 * 24
        ? `${Math.round(abs / 60)} h`
        : `${Math.round(abs / (60 * 24))} d`;
  if (diffMin < 0) return `${unit} overdue`;
  if (diffMin === 0) return "due now";
  return `due in ${unit}`;
}

const KEY = "icu-job-reminders-v1";

type ReminderState = Record<string, number>; // key -> timestamp (ms) last handled

function read(): ReminderState {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.localStorage.getItem(KEY) ?? "{}") as ReminderState;
  } catch {
    return {};
  }
}

function write(state: ReminderState) {
  if (typeof window === "undefined") return;
  try {
    // Drop entries older than 24h so the key doesn't grow unbounded.
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const pruned: ReminderState = {};
    for (const [k, v] of Object.entries(state)) if (v > cutoff) pruned[k] = v;
    window.localStorage.setItem(KEY, JSON.stringify(pruned));
  } catch {
    /* storage unavailable — reminders simply repeat */
  }
}

/**
 * Key includes due_at so rescheduling a job legitimately re-arms its reminder.
 */
export function reminderKey(taskId: string, due: string, level: DueLevel) {
  return `${taskId}|${due}|${level}`;
}

export function wasNotified(key: string): boolean {
  return !!read()[key];
}

export function markNotified(key: string) {
  const s = read();
  s[key] = Date.now();
  write(s);
}

export function snoozeKey(taskId: string) {
  return `snooze|${taskId}`;
}

export function isSnoozed(taskId: string, now: number = Date.now()): boolean {
  const at = read()[snoozeKey(taskId)];
  return !!at && now - at < SNOOZE_MS;
}

export function snooze(taskId: string) {
  const s = read();
  s[snoozeKey(taskId)] = Date.now();
  write(s);
}
