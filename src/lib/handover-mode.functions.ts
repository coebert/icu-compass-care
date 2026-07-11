import { createServerFn } from "@tanstack/react-start";
import { safeDbError } from "@/lib/db-error";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const HANDOVER_ACTIONS = ["given", "received"] as const;
export type HandoverAction = (typeof HANDOVER_ACTIONS)[number];

export type HandoverAck = {
  id: string;
  patient_id: string;
  shift_key: string;
  action: string;
  ack_by: string | null;
  ack_name: string | null;
  note: string | null;
  created_at: string;
};

// Derive the current shift key: YYYY-MM-DD plus am (08:00–19:59) / pm.
export function currentShiftKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const shift = now.getHours() >= 8 && now.getHours() < 20 ? "am" : "pm";
  return `${y}-${m}-${d}-${shift}`;
}

export function shiftKeyLabel(key: string): string {
  const m = key.match(/^(\d{4})-(\d{2})-(\d{2})-(am|pm)$/);
  if (!m) return key;
  const [, y, mo, d, s] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d));
  const dateLabel = date.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
  return `${dateLabel} · ${s === "am" ? "Day (AM)" : "Night (PM)"}`;
}

export const listHandoverAcks = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { shiftKey: string }) =>
    z.object({ shiftKey: z.string().min(1).max(40) }).parse(input),
  )
  .handler(async ({ context, data }): Promise<HandoverAck[]> => {
    const { data: rows, error } = await context.supabase
      .from("handover_acknowledgements")
      .select("*")
      .eq("shift_key", data.shiftKey);
    if (error) throw safeDbError(error);
    return (rows ?? []) as HandoverAck[];
  });

export const setHandoverAck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        patient_id: z.string().uuid(),
        shift_key: z.string().min(1).max(40),
        action: z.enum(HANDOVER_ACTIONS),
        ack_name: z.string().trim().max(120).nullish(),
        note: z.string().trim().max(1000).nullish(),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { data: row, error } = await context.supabase
      .from("handover_acknowledgements")
      .upsert(
        {
          patient_id: data.patient_id,
          shift_key: data.shift_key,
          action: data.action,
          ack_by: context.userId,
          ack_name: data.ack_name ?? null,
          note: data.note ?? null,
        } as never,
        { onConflict: "patient_id,shift_key,action" },
      )
      .select()
      .single();
    if (error) throw safeDbError(error);
    return row;
  });

export const clearHandoverAck = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z
      .object({
        patient_id: z.string().uuid(),
        shift_key: z.string().min(1).max(40),
        action: z.enum(HANDOVER_ACTIONS),
      })
      .parse(input),
  )
  .handler(async ({ context, data }) => {
    const { error } = await context.supabase
      .from("handover_acknowledgements")
      .delete()
      .eq("patient_id", data.patient_id)
      .eq("shift_key", data.shift_key)
      .eq("action", data.action);
    if (error) throw safeDbError(error);
    return { ok: true };
  });

// Recent field changes across all patients since a timestamp, for the
// "what changed since last handover" section. Grouped client-side by patient.
export type RecentChange = {
  id: string;
  patient_id: string;
  field_name: string | null;
  changed_at: string | null;
};

export const listRecentFieldChanges = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: { sinceHours?: number }) =>
    z.object({ sinceHours: z.number().int().min(1).max(72).optional() }).parse(input ?? {}),
  )
  .handler(async ({ context, data }): Promise<RecentChange[]> => {
    const sinceHours = data.sinceHours ?? 12;
    const since = new Date(Date.now() - sinceHours * 3_600_000).toISOString();
    const { data: rows, error } = await context.supabase
      .from("patient_field_changes")
      .select("id, patient_id, field_name, changed_at")
      .gte("changed_at", since)
      .order("changed_at", { ascending: false })
      .limit(1000);
    if (error) throw safeDbError(error);
    return (rows ?? []) as RecentChange[];
  });
