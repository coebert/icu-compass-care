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
