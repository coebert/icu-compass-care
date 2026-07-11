import { createServerFn } from "@tanstack/react-start";
import { safeDbError } from "@/lib/db-error";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const TASK_STATUSES = ["not_started", "in_progress", "completed"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  completed: "Completed",
};

export const TASK_PRIORITIES = ["routine", "urgent", "critical"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABEL: Record<TaskPriority, string> = {
  routine: "Routine",
  urgent: "Urgent",
  critical: "Critical",
};

export const TASK_CATEGORIES = ["job", "ward_round"] as const;
export type TaskCategory = (typeof TASK_CATEGORIES)[number];

export const TASK_CATEGORY_LABEL: Record<TaskCategory, string> = {
  job: "Job",
  ward_round: "Ward round",
};

export const listPatientTasks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { patientId: string }) =>
    z.object({ patientId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: rows, error } = await context.supabase
      .from("patient_tasks")
      .select("*")
      .eq("patient_id", data.patientId)
      .order("position", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw safeDbError(error);
    return rows;
  });

// All open (not-completed) tasks across every patient, for the unit dashboard.
export const listOpenTasks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data: rows, error } = await context.supabase
      .from("patient_tasks")
      .select("id, patient_id, description, priority, category, owner, due_at, status")
      .neq("status", "completed")
      .order("due_at", { ascending: true, nullsFirst: false });
    if (error) throw safeDbError(error);
    return rows ?? [];
  });



export const addPatientTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        patient_id: z.string().uuid(),
        description: z.string().trim().min(1).max(2000),
        position: z.number().int().optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        category: z.enum(TASK_CATEGORIES).optional(),
        owner: z.string().trim().max(120).nullish(),
        due_at: z.string().datetime().nullish(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("patient_tasks")
      .insert({
        patient_id: data.patient_id,
        description: data.description,
        position: data.position ?? 0,
        priority: data.priority ?? "routine",
        category: data.category ?? "job",
        owner: data.owner ?? null,
        due_at: data.due_at ?? null,
        created_by: context.userId,
      } as never)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const updatePatientTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        id: z.string().uuid(),
        description: z.string().trim().min(1).max(2000).optional(),
        status: z.enum(TASK_STATUSES).optional(),
        priority: z.enum(TASK_PRIORITIES).optional(),
        category: z.enum(TASK_CATEGORIES).optional(),
        owner: z.string().trim().max(120).nullish(),
        due_at: z.string().datetime().nullish(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { id, ...rest } = data;
    const { data: row, error } = await context.supabase
      .from("patient_tasks")
      .update(rest as never)
      .eq("id", id)
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const deletePatientTask = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { id: string }) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase.from("patient_tasks").delete().eq("id", data.id);
    if (error) throw safeDbError(error);
    return { ok: true };
  });
