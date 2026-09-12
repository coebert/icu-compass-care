// Client-safe shapes for management checklists (FASTERHUG, respiratory
// admission workup, and any custom checklist a unit adds later).

export const CHECKLIST_ITEM_STATUSES = ["not_started", "in_progress", "done", "not_applicable"] as const;
export type ChecklistItemStatus = (typeof CHECKLIST_ITEM_STATUSES)[number];

export const CHECKLIST_ITEM_STATUS_LABEL: Record<ChecklistItemStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  done: "Done",
  not_applicable: "Not applicable",
};

// Clicking the status control cycles through these in order.
export const NEXT_CHECKLIST_STATUS: Record<ChecklistItemStatus, ChecklistItemStatus> = {
  not_started: "in_progress",
  in_progress: "done",
  done: "not_applicable",
  not_applicable: "not_started",
};

// RACI roles: who carries out the item (responsible) and who owns it
// (accountable). Kept as a fixed vocabulary so the table reads consistently.
export const CHECKLIST_ROLES = [
  "bedside_nurse",
  "nurse_in_charge",
  "icu_trainee",
  "icu_consultant",
  "acp",
  "pharmacist",
  "physio",
  "salt",
  "dietitian",
  "microbiology",
  "parent_team",
  "outreach",
  "family",
] as const;
export type ChecklistRole = (typeof CHECKLIST_ROLES)[number];

export const CHECKLIST_ROLE_LABEL: Record<ChecklistRole, string> = {
  bedside_nurse: "Bedside nurse",
  nurse_in_charge: "Nurse in charge",
  icu_trainee: "ICU trainee / registrar",
  icu_consultant: "ICU consultant",
  acp: "Advanced critical care practitioner",
  pharmacist: "Pharmacist",
  physio: "Physiotherapist",
  salt: "Speech and language therapist",
  dietitian: "Dietitian",
  microbiology: "Microbiology",
  parent_team: "Parent specialty team",
  outreach: "Critical care outreach",
  family: "Family / next of kin",
};

export const UNASSIGNED_ROLE = "unassigned";

export function roleLabel(role: string | null | undefined): string {
  if (!role) return "Unassigned";
  return CHECKLIST_ROLE_LABEL[role as ChecklistRole] ?? role;
}

function parseRole(value: unknown): ChecklistRole | null {
  const v = String(value ?? "").trim();
  return (CHECKLIST_ROLES as readonly string[]).includes(v) ? (v as ChecklistRole) : null;
}

export type ChecklistItem = {
  key: string;
  label: string;
  hint?: string | null;
  // Default RACI roles suggested by the checklist template.
  responsible?: ChecklistRole | null;
  accountable?: ChecklistRole | null;
  // Default target window, in minutes from when the checklist was activated
  // (e.g. 60 for a Sepsis Six item). Null means no timed target.
  target_minutes?: number | null;
  // Key items are the ones that must not be missed; they escalate faster.
  critical?: boolean;
};

export type ChecklistItemState = {
  status: ChecklistItemStatus;
  // Per-patient overrides of the template's default RACI roles.
  responsible?: ChecklistRole | null;
  accountable?: ChecklistRole | null;
  // Per-patient override of the deadline (ISO, UTC).
  due_at?: string | null;
  note?: string | null;
  at?: string | null;
  by?: string | null;
};

export type ChecklistState = Record<string, ChecklistItemState>;

// Accept "90", "90m", "1h", "1.5h", "2 hours" when a target is typed as text.
export function parseTargetMinutes(value: unknown): number | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === "") return null;
  const m = raw.match(/^([0-9]+(?:\.[0-9]+)?)\s*(m|min|mins|minutes|h|hr|hrs|hour|hours|d|day|days)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2] ?? "m";
  const mult = unit.startsWith("d") ? 60 * 24 : unit.startsWith("h") ? 60 : 1;
  return Math.min(Math.round(n * mult), 60 * 24 * 30);
}

export function formatTargetMinutes(minutes: number | null | undefined): string {
  if (!minutes) return "";
  if (minutes % (60 * 24) === 0) return `${minutes / (60 * 24)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

export function parseChecklistItems(value: unknown): ChecklistItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .map((v) => ({
      key: String(v.key ?? "").trim(),
      label: String(v.label ?? "").trim(),
      hint: v.hint != null && String(v.hint).trim() !== "" ? String(v.hint) : null,
      responsible: parseRole(v.responsible),
      accountable: parseRole(v.accountable),
      target_minutes: parseTargetMinutes(v.target_minutes),
      critical: v.critical === true,
    }))
    .filter((i) => i.key !== "" && i.label !== "");
}


export function parseChecklistState(value: unknown): ChecklistState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: ChecklistState = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const status = (CHECKLIST_ITEM_STATUSES as readonly string[]).includes(String(r.status))
      ? (r.status as ChecklistItemStatus)
      : "not_started";
    out[key] = {
      status,
      responsible: parseRole(r.responsible),
      accountable: parseRole(r.accountable),
      due_at: r.due_at != null && String(r.due_at).trim() !== "" ? String(r.due_at) : null,
      note: r.note != null ? String(r.note) : null,

      at: r.at != null ? String(r.at) : null,
      by: r.by != null ? String(r.by) : null,
    };
  }
  return out;
}

export function checklistProgress(
  items: ChecklistItem[],
  state: ChecklistState,
): { done: number; total: number; outstanding: number } {
  let done = 0;
  let total = 0;
  for (const item of items) {
    const st = state[item.key]?.status ?? "not_started";
    if (st === "not_applicable") continue;
    total += 1;
    if (st === "done") done += 1;
  }
  return { done, total, outstanding: total - done };
}

// Turn a checklist name into a stable key for a custom template.
export function slugifyChecklistKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

// The effective RACI pair for an item: the per-patient override if a member of
// staff has set one, otherwise the template default.
export function effectiveRaci(
  item: ChecklistItem,
  state: ChecklistState,
): { responsible: ChecklistRole | null; accountable: ChecklistRole | null } {
  const entry = state[item.key];
  return {
    responsible: entry?.responsible ?? item.responsible ?? null,
    accountable: entry?.accountable ?? item.accountable ?? null,
  };
}

// Accept either the role key ("icu_consultant") or its label ("ICU consultant")
// when a checklist is typed out as text in the template editor.
export function matchRole(value: string | null | undefined): ChecklistRole | null {
  const v = String(value ?? "").trim().toLowerCase();
  if (v === "") return null;
  const byKey = (CHECKLIST_ROLES as readonly string[]).find((r) => r === v);
  if (byKey) return byKey as ChecklistRole;
  const byLabel = (CHECKLIST_ROLES as readonly ChecklistRole[]).find(
    (r) => CHECKLIST_ROLE_LABEL[r].toLowerCase() === v,
  );
  return byLabel ?? null;
}

// ---- Deadlines and alerts -------------------------------------------------
//
// Deadlines are derived, never stored as a separate job: a checklist item is
// due either at the time a member of staff set for this patient, or at the
// template's target window measured from when the checklist was activated.

export type ChecklistAlertLevel = "none" | "soon" | "overdue" | "missed";

/** Items due within this window count as "due soon". */
export const CHECKLIST_SOON_MS = 60 * 60 * 1000;
/** A key item overdue by longer than this counts as missed. */
export const CHECKLIST_MISSED_GRACE_MS = 60 * 60 * 1000;
/** A key item with no timed target counts as missed after this long. */
export const CHECKLIST_UNTIMED_MISSED_MS = 12 * 60 * 60 * 1000;

/** The effective deadline for an item, or null when it has no timed target. */
export function checklistItemDueAt(
  item: ChecklistItem,
  state: ChecklistState,
  activatedAt: string | null | undefined,
): string | null {
  const override = state[item.key]?.due_at;
  if (override) return override;
  if (item.target_minutes && activatedAt) {
    const t = new Date(activatedAt).getTime();
    if (!Number.isNaN(t)) return new Date(t + item.target_minutes * 60_000).toISOString();
  }
  return null;
}

export function checklistItemAlert(
  item: ChecklistItem,
  state: ChecklistState,
  activatedAt: string | null | undefined,
  now: number = Date.now(),
): { level: ChecklistAlertLevel; dueAt: string | null } {
  const dueAt = checklistItemDueAt(item, state, activatedAt);
  const status = state[item.key]?.status ?? "not_started";
  if (status === "done" || status === "not_applicable") return { level: "none", dueAt };

  if (dueAt) {
    const t = new Date(dueAt).getTime();
    if (Number.isNaN(t)) return { level: "none", dueAt: null };
    const diff = t - now;
    if (diff < 0) {
      const late = -diff;
      if (item.critical && late > CHECKLIST_MISSED_GRACE_MS) return { level: "missed", dueAt };
      return { level: "overdue", dueAt };
    }
    if (diff <= CHECKLIST_SOON_MS) return { level: "soon", dueAt };
    return { level: "none", dueAt };
  }

  // No deadline: a key item left outstanding for a long time still counts.
  if (item.critical && activatedAt) {
    const started = new Date(activatedAt).getTime();
    if (!Number.isNaN(started) && now - started > CHECKLIST_UNTIMED_MISSED_MS) {
      return { level: "missed", dueAt: null };
    }
  }
  return { level: "none", dueAt: null };
}

export const CHECKLIST_ALERT_RANK: Record<ChecklistAlertLevel, number> = {
  none: 0,
  soon: 1,
  overdue: 2,
  missed: 3,
};

export const CHECKLIST_ALERT_LABEL: Record<ChecklistAlertLevel, string> = {
  none: "",
  soon: "Due soon",
  overdue: "Overdue",
  missed: "Key item missed",
};

export type ChecklistAlert = {
  id: string;
  checklistId: string;
  patientId: string;
  checklistName: string;
  itemKey: string;
  itemLabel: string;
  level: Exclude<ChecklistAlertLevel, "none">;
  dueAt: string | null;
  critical: boolean;
  responsible: ChecklistRole | null;
};

/** Every outstanding alert on one activated checklist. */
export function checklistAlerts(
  checklist: {
    id: string;
    patient_id: string;
    name: string;
    items: unknown;
    state: unknown;
    activated_at: string | null;
  },
  now: number = Date.now(),
): ChecklistAlert[] {
  const items = parseChecklistItems(checklist.items);
  const state = parseChecklistState(checklist.state);
  const out: ChecklistAlert[] = [];
  for (const item of items) {
    const { level, dueAt } = checklistItemAlert(item, state, checklist.activated_at, now);
    if (level === "none") continue;
    out.push({
      id: `${checklist.id}:${item.key}`,
      checklistId: checklist.id,
      patientId: checklist.patient_id,
      checklistName: checklist.name,
      itemKey: item.key,
      itemLabel: item.label,
      level,
      dueAt,
      critical: item.critical === true,
      responsible: effectiveRaci(item, state).responsible,
    });
  }
  return out;
}
