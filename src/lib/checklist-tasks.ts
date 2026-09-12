// Keeps checklist items and the patient's job list in step, both ways.
//
// Client-safe (no server-only imports): it is only ever CALLED from server
// handlers, with an authenticated Supabase client passed in.

import type { ChecklistItem, ChecklistItemStatus } from "@/lib/checklists";
import { roleLabel } from "@/lib/checklists";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MinimalClient = any;

export type TaskStatusValue = "not_started" | "in_progress" | "completed";

/** Checklist item status -> job status. "Not applicable" closes the job. */
export function taskStatusForItem(status: ChecklistItemStatus): TaskStatusValue {
  if (status === "in_progress") return "in_progress";
  if (status === "done" || status === "not_applicable") return "completed";
  return "not_started";
}

/** Job status -> checklist item status. */
export function itemStatusForTask(
  status: TaskStatusValue,
  current: ChecklistItemStatus | null,
): ChecklistItemStatus {
  if (status === "completed") return current === "not_applicable" ? "not_applicable" : "done";
  if (status === "in_progress") return "in_progress";
  return "not_started";
}

/**
 * Create or update the job linked to a checklist item. Called after the
 * checklist state is saved. Best-effort: never break the checklist write.
 */
export async function syncChecklistItemTask(
  client: MinimalClient,
  params: {
    patientId: string;
    checklistId: string;
    checklistName: string;
    item: ChecklistItem;
    status: ChecklistItemStatus;
    responsible: string | null;
    dueAt: string | null;
    note: string | null;
    userId: string;
  },
): Promise<{ taskId: string | null; created: boolean }> {
  try {
    const { data: existing } = await client
      .from("patient_tasks")
      .select("id, status")
      .eq("source_checklist_id", params.checklistId)
      .eq("source_item_key", params.item.key)
      .maybeSingle();

    const status = taskStatusForItem(params.status);
    const notes = [
      `${params.checklistName} checklist`,
      params.item.hint ?? "",
      params.status === "not_applicable" ? "Marked not applicable" : "",
      params.note ?? "",
    ]
      .filter((s) => s.trim() !== "")
      .join(" · ")
      .slice(0, 4000);

    const shared = {
      description: params.item.label.slice(0, 2000),
      status,
      priority: params.item.critical ? "urgent" : "routine",
      category: "job",
      owner: params.responsible ? roleLabel(params.responsible) : null,
      due_at: params.dueAt,
      notes,
    };

    if (existing?.id) {
      await client.from("patient_tasks").update(shared).eq("id", existing.id);
      return { taskId: existing.id as string, created: false };
    }

    // Only open a job once there is something to do or record.
    if (params.status === "not_started" && !params.dueAt && !params.note) {
      return { taskId: null, created: false };
    }

    const { data: row } = await client
      .from("patient_tasks")
      .insert({
        ...shared,
        patient_id: params.patientId,
        position: 0,
        created_by: params.userId,
        source_checklist_id: params.checklistId,
        source_item_key: params.item.key,
      })
      .select("id")
      .single();
    return { taskId: (row?.id as string) ?? null, created: true };
  } catch {
    return { taskId: null, created: false };
  }
}

/**
 * Push a job's status back onto its checklist item, so ticking the job list
 * updates the checklist too. Best-effort.
 */
export async function syncTaskToChecklistItem(
  client: MinimalClient,
  params: {
    checklistId: string;
    itemKey: string;
    status: TaskStatusValue;
    userId: string;
  },
): Promise<void> {
  try {
    const { data: cl } = await client
      .from("patient_checklists")
      .select("id, state")
      .eq("id", params.checklistId)
      .maybeSingle();
    if (!cl) return;

    const state = (
      cl.state && typeof cl.state === "object" && !Array.isArray(cl.state) ? { ...cl.state } : {}
    ) as Record<string, Record<string, unknown>>;
    const prev = (state[params.itemKey] ?? {}) as Record<string, unknown>;
    const current = (prev.status as ChecklistItemStatus | undefined) ?? null;
    const next = itemStatusForTask(params.status, current);
    if (current === next) return;

    state[params.itemKey] = {
      ...prev,
      status: next,
      at: new Date().toISOString(),
      by: params.userId,
    };
    await client.from("patient_checklists").update({ state }).eq("id", params.checklistId);
  } catch {
    // best-effort
  }
}
