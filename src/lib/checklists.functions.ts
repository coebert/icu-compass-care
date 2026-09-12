import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeDbError } from "@/lib/db-error";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { CHECKLIST_ITEM_STATUSES, CHECKLIST_ROLES, slugifyChecklistKey } from "@/lib/checklists";

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
      .select("id, state")
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
