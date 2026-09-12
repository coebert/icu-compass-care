import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { safeDbError } from "@/lib/db-error";
import { assertConfigAdmin, loadActor } from "@/lib/roles.server";
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


type ChecklistDraft = {
  name: string;
  description?: string | null;
  specialty?: string | null;
  items: z.infer<typeof zItems>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctx = { supabase: any; userId: string; claims?: { email?: string } };

function actorEmail(context: Ctx): string | null {
  return context.claims?.email ?? null;
}

async function applyCreate(context: Ctx, draft: ChecklistDraft) {
  const base = slugifyChecklistKey(draft.name) || "checklist";
  const key = `${base}_${Date.now().toString(36)}`;
  const { data: row, error } = await context.supabase
    .from("checklist_templates")
    .insert({
      key,
      name: draft.name,
      description: draft.description ?? null,
      specialty: draft.specialty ?? null,
      items: draft.items,
      is_builtin: false,
      created_by: context.userId,
    } as never)
    .select()
    .single();
  if (error) throw safeDbError(error);
  return row;
}

async function applyUpdate(context: Ctx, id: string, draft: ChecklistDraft) {
  const { data: row, error } = await context.supabase
    .from("checklist_templates")
    .update({
      name: draft.name,
      description: draft.description ?? null,
      specialty: draft.specialty ?? null,
      items: draft.items,
    } as never)
    .eq("id", id)
    .select()
    .single();
  if (error) throw safeDbError(error);
  return row;
}

async function submitProposal(
  context: Ctx,
  payload: ChecklistDraft & { template_id: string | null; kind: "create" | "update"; note: string | null },
) {
  const { data: row, error } = await context.supabase
    .from("checklist_template_proposals")
    .insert({
      template_id: payload.template_id,
      kind: payload.kind,
      name: payload.name,
      description: payload.description ?? null,
      specialty: payload.specialty ?? null,
      items: payload.items,
      note: payload.note,
      status: "pending",
      proposed_by: context.userId,
      proposed_by_email: actorEmail(context),
    } as never)
    .select("id")
    .single();
  if (error) throw safeDbError(error);
  return { pending: true as const, proposal_id: row.id as string };
}

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

// Anyone clinical may draft a checklist, but only an administrator's change
// goes live immediately; everybody else's is queued for approval.
export const createChecklistTemplate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        name: z.string().trim().min(2).max(120),
        description: z.string().trim().max(2000).nullish(),
        specialty: z.string().trim().max(120).nullish(),
        items: zItems,
        note: z.string().trim().max(1000).nullish(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const actor = await loadActor(context);
    if (!actor.canConfigure) {
      return submitProposal(context, {
        template_id: null,
        kind: "create",
        name: data.name,
        description: data.description ?? null,
        specialty: data.specialty ?? null,
        items: data.items,
        note: data.note ?? null,
      });
    }
    const row = await applyCreate(context, data);
    return { pending: false as const, template: row };
  });

// Any clinical member of staff can edit a checklist template, including the
// built-in ones, so units can keep them aligned with local guidelines — but
// the edit only reaches patient tabs once an administrator approves it.
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
        note: z.string().trim().max(1000).nullish(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const actor = await loadActor(context);
    if (!actor.canConfigure) {
      return submitProposal(context, {
        template_id: data.id,
        kind: "update",
        name: data.name,
        description: data.description ?? null,
        specialty: data.specialty ?? null,
        items: data.items,
        note: data.note ?? null,
      });
    }
    const row = await applyUpdate(context, data.id, data);
    return { pending: false as const, template: row };
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

// ---- Change approvals -----------------------------------------------------

/** Queued checklist changes. Staff see their own queue; admins see all. */
export const listChecklistProposals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const actor = await loadActor(context);
    const { data: rows, error } = await context.supabase
      .from("checklist_template_proposals")
      .select(
        "id, template_id, kind, name, description, specialty, items, note, status, proposed_by, proposed_by_email, reviewed_by_email, reviewed_at, review_note, created_at",
      )
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) throw safeDbError(error);
    return { canReview: actor.canConfigure, proposals: rows ?? [] };
  });

/** Approve (apply) or reject a queued checklist change. Administrators only. */
export const reviewChecklistProposal = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string; decision: "approved" | "rejected"; review_note?: string | null }) =>
    z
      .object({
        id: z.string().uuid(),
        decision: z.enum(["approved", "rejected"]),
        review_note: z.string().trim().max(1000).nullish(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    await assertConfigAdmin(context);

    const { data: proposal, error: readErr } = await context.supabase
      .from("checklist_template_proposals")
      .select("id, template_id, kind, name, description, specialty, items, status")
      .eq("id", data.id)
      .single();
    if (readErr) throw safeDbError(readErr);
    if (proposal.status !== "pending") throw new Error("This change has already been reviewed");

    if (data.decision === "approved") {
      const draft = {
        name: proposal.name as string,
        description: proposal.description as string | null,
        specialty: proposal.specialty as string | null,
        items: proposal.items as z.infer<typeof zItems>,
      };
      if (proposal.kind === "update" && proposal.template_id) {
        await applyUpdate(context, proposal.template_id as string, draft);
      } else {
        await applyCreate(context, draft);
      }
    }

    const { error } = await context.supabase
      .from("checklist_template_proposals")
      .update({
        status: data.decision,
        reviewed_by: context.userId,
        reviewed_by_email: actorEmail(context),
        reviewed_at: new Date().toISOString(),
        review_note: data.review_note ?? null,
      } as never)
      .eq("id", data.id);
    if (error) throw safeDbError(error);

    await writeAudit(context, {
      action: "update",
      entity: "checklists",
      entityId: data.id,
      diff: { proposal_review: data.decision, template_id: proposal.template_id ?? null },
    });

    return { ok: true, status: data.decision };
  });
