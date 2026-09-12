import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeDbError } from "@/lib/db-error";
import { assertConfigAdmin } from "@/lib/roles.server";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  CHECKLIST_ITEM_STATUSES,
  CHECKLIST_ROLES,
  parseChecklistItems,
  slugifyChecklistKey,
} from "@/lib/checklists";
import { syncChecklistItemTask } from "@/lib/checklist-tasks";
import { writeAudit } from "@/lib/audit";

const zItems = z
  .array(
    z.object({
      key: z.string().trim().min(1).max(60),
      label: z.string().trim().min(1).max(300),
      hint: z.string().trim().max(500).nullish(),
      responsible: z.enum(CHECKLIST_ROLES).nullish(),
      accountable: z.enum(CHECKLIST_ROLES).nullish(),
      // Target window in minutes from activation; null = no timed target.
      target_minutes: z.number().int().min(1).max(60 * 24 * 30).nullish(),
      critical: z.boolean().nullish(),
    }),
  )
  .min(1)
  .max(60);


// ---- Templates ------------------------------------------------------------

export const listChecklistTemplates = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("checklist_templates")
      .select("id, key, name, description, specialty, items, is_active, is_builtin")
      .eq("is_active", true)
      .order("is_builtin", { ascending: false })
      .order("name", { ascending: true });
    if (error) throw safeDbError(error);
    return data ?? [];
  });

export const createChecklistTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        name: z.string().trim().min(2).max(120),
        description: z.string().trim().max(2000).nullish(),
        specialty: z.string().trim().max(120).nullish(),
        items: zItems,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const base = slugifyChecklistKey(data.name) || "checklist";
    const key = `${base}_${Date.now().toString(36)}`;
    const { data: row, error } = await context.supabase
      .from("checklist_templates")
      .insert({
        key,
        name: data.name,
        description: data.description ?? null,
        specialty: data.specialty ?? null,
        items: data.items,
        is_builtin: false,
        created_by: context.userId,
      } as never)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

// Any clinical member of staff can edit a checklist template, including the
// built-in ones, so units can keep them aligned with local guidelines.
export const updateChecklistTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        name: z.string().trim().min(2).max(120),
        description: z.string().trim().max(2000).nullish(),
        specialty: z.string().trim().max(120).nullish(),
        items: zItems,
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("checklist_templates")
      .update({
        name: data.name,
        description: data.description ?? null,
        specialty: data.specialty ?? null,
        items: data.items,
      } as never)
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const archiveChecklistTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("checklist_templates")
      .update({ is_active: false } as never)
      .eq("id", data.id);
    if (error) throw safeDbError(error);
    return { ok: true };
  });

// ---- Per-patient checklists ----------------------------------------------

export const listPatientChecklists = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patientId: string }) =>
    z.object({ patientId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("patient_checklists")
      .select("*")
      .eq("patient_id", data.patientId)
      .is("archived_at", null)
      .order("activated_at", { ascending: true });
    if (error) throw safeDbError(error);
    return rows ?? [];
  });

export const activateChecklist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({ patient_id: z.string().uuid(), template_id: z.string().uuid() })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: tpl, error: tplErr } = await context.supabase
      .from("checklist_templates")
      .select("id, key, name, items")
      .eq("id", data.template_id)
      .single();
    if (tplErr) throw safeDbError(tplErr);

    // Re-activating an existing checklist should not duplicate it.
    const { data: existing } = await context.supabase
      .from("patient_checklists")
      .select("id")
      .eq("patient_id", data.patient_id)
      .eq("template_key", tpl.key)
      .is("archived_at", null)
      .maybeSingle();
    if (existing) return existing;

    const { data: row, error } = await context.supabase
      .from("patient_checklists")
      .insert({
        patient_id: data.patient_id,
        template_id: tpl.id,
        template_key: tpl.key,
        name: tpl.name,
        items: tpl.items,
        state: {},
        activated_by: context.userId,
      } as never)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const setChecklistItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        item_key: z.string().trim().min(1).max(60),
        status: z.enum(CHECKLIST_ITEM_STATUSES).optional(),
        responsible: z.enum(CHECKLIST_ROLES).nullish(),
        accountable: z.enum(CHECKLIST_ROLES).nullish(),
        due_at: z.string().trim().datetime({ offset: true }).nullish(),
        note: z.string().trim().max(2000).nullish(),

      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: current, error: readErr } = await context.supabase
      .from("patient_checklists")
      .select("id, patient_id, name, items, state, activated_at")
      .eq("id", data.id)
      .single();
    if (readErr) throw safeDbError(readErr);

    const state = (current.state && typeof current.state === "object" && !Array.isArray(current.state)
      ? { ...(current.state as Record<string, unknown>) }
      : {}) as Record<string, Record<string, unknown>>;
    const prev = (state[data.item_key] ?? {}) as Record<string, unknown>;

    state[data.item_key] = {
      status: data.status ?? (prev.status as string) ?? "not_started",
      responsible:
        data.responsible !== undefined
          ? (data.responsible ?? null)
          : ((prev.responsible as string | null) ?? null),
      accountable:
        data.accountable !== undefined
          ? (data.accountable ?? null)
          : ((prev.accountable as string | null) ?? null),
      due_at:
        data.due_at !== undefined
          ? (data.due_at ?? null)
          : ((prev.due_at as string | null) ?? null),
      note: data.note !== undefined ? (data.note ?? null) : ((prev.note as string | null) ?? null),

      at: new Date().toISOString(),
      by: context.userId,
    };

    const { data: row, error } = await context.supabase
      .from("patient_checklists")
      .update({ state } as never)
      .eq("id", data.id)
      .select()
      .single();
    if (error) throw safeDbError(error);

    // Keep the patient's job list and the audit trail in step with the item.
    const entry = state[data.item_key]!;
    const item = parseChecklistItems(current.items).find((i) => i.key === data.item_key);
    if (item) {
      const status = (entry.status as string) as (typeof CHECKLIST_ITEM_STATUSES)[number];
      const linked = await syncChecklistItemTask(context.supabase, {
        patientId: current.patient_id as string,
        checklistId: data.id,
        checklistName: (current.name as string) ?? "Checklist",
        item,
        status,
        responsible: (entry.responsible as string | null) ?? null,
        dueAt: (entry.due_at as string | null) ?? null,
        note: (entry.note as string | null) ?? null,
        userId: context.userId,
      });
      await writeAudit(context.supabase, {
        entity: "checklists",
        recordId: data.id,
        action: "update",
        source: "app",
        actor: { id: context.userId },
        changedFields: [data.item_key],
        before: { status: (prev.status as string | null) ?? "not_started" },
        after: { status, item: item.label, linked_task_id: linked.taskId },
      });
    }
    return row;
  });

export const archivePatientChecklist = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("patient_checklists")
      .update({ archived_at: new Date().toISOString() } as never)
      .eq("id", data.id);
    if (error) throw safeDbError(error);
    return { ok: true };
  });

// Every open checklist across the patients the signed-in member of staff can
// see, so overdue and missed key items can be surfaced unit-wide. Row level
// security already limits this to their units.
export const listOpenChecklists = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase
      .from("patient_checklists")
      .select("id, patient_id, name, items, state, activated_at")
      .is("archived_at", null)
      .is("completed_at", null)
      .order("activated_at", { ascending: true });
    if (error) throw safeDbError(error);
    return data ?? [];
  });

// ---- Template version history --------------------------------------------

export const listChecklistTemplateVersions = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { template_id: string }) =>
    z.object({ template_id: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("checklist_template_versions")
      .select("id, version, name, description, specialty, items, note, changed_by_email, created_at")
      .eq("template_id", data.template_id)
      .order("version", { ascending: false })
      .limit(50);
    if (error) throw safeDbError(error);
    return rows ?? [];
  });

/** Restore an earlier saved version. Administrators only. */
export const revertChecklistTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { template_id: string; version: number }) =>
    z
      .object({ template_id: z.string().uuid(), version: z.number().int().min(1) })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertConfigAdmin(context);

    const { data: snap, error: readErr } = await context.supabase
      .from("checklist_template_versions")
      .select("name, description, specialty, items")
      .eq("template_id", data.template_id)
      .eq("version", data.version)
      .single();
    if (readErr) throw safeDbError(readErr);

    const { data: row, error } = await context.supabase
      .from("checklist_templates")
      .update({
        name: snap.name,
        description: snap.description,
        specialty: snap.specialty,
        items: snap.items,
      } as never)
      .eq("id", data.template_id)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });
