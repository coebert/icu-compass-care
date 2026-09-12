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

export type ChecklistItem = {
  key: string;
  label: string;
  hint?: string | null;
};

export type ChecklistItemState = {
  status: ChecklistItemStatus;
  note?: string | null;
  at?: string | null;
  by?: string | null;
};

export type ChecklistState = Record<string, ChecklistItemState>;

export function parseChecklistItems(value: unknown): ChecklistItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .map((v) => ({
      key: String(v.key ?? "").trim(),
      label: String(v.label ?? "").trim(),
      hint: v.hint != null && String(v.hint).trim() !== "" ? String(v.hint) : null,
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
