import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { safeDbError } from "@/lib/db-error";
import { normalizeAntimicrobialName } from "@/lib/antimicrobials";

// Central library of antimicrobial agent names that staff can manage in one
// place. Names are stored once and reused as suggestions across the app. A
// case-insensitive unique index on the table guarantees no duplicate spellings.

export type AntimicrobialLibraryRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

const nameSchema = z
  .string()
  .transform(normalizeAntimicrobialName)
  .pipe(z.string().min(1, "Name is required").max(120, "Name is too long"));

export const listAntimicrobialLibrary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<AntimicrobialLibraryRow[]> => {
    const { data, error } = await context.supabase
      .from("antimicrobial_library")
      .select("id, name, created_at, updated_at")
      .order("name", { ascending: true });
    if (error) throw safeDbError(error, "load antimicrobial library");
    return (data ?? []) as AntimicrobialLibraryRow[];
  });

export const addAntimicrobialName = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ name: nameSchema }).parse(input))
  .handler(async ({ data, context }): Promise<AntimicrobialLibraryRow> => {
    const { data: row, error } = await context.supabase
      .from("antimicrobial_library")
      .insert({ name: data.name })
      .select("id, name, created_at, updated_at")
      .single();
    if (error) {
      if (error.code === "23505") throw new Error(`"${data.name}" is already in the library`);
      throw safeDbError(error, "add antimicrobial name");
    }
    return row as AntimicrobialLibraryRow;
  });

export const renameAntimicrobialName = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) =>
    z.object({ id: z.string().uuid(), name: nameSchema }).parse(input),
  )
  .handler(async ({ data, context }): Promise<AntimicrobialLibraryRow> => {
    const { data: row, error } = await context.supabase
      .from("antimicrobial_library")
      .update({ name: data.name })
      .eq("id", data.id)
      .select("id, name, created_at, updated_at")
      .single();
    if (error) {
      if (error.code === "23505") throw new Error(`"${data.name}" is already in the library`);
      throw safeDbError(error, "rename antimicrobial name");
    }
    return row as AntimicrobialLibraryRow;
  });

export const deleteAntimicrobialName = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input) => z.object({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data, context }): Promise<{ id: string }> => {
    const { error } = await context.supabase
      .from("antimicrobial_library")
      .delete()
      .eq("id", data.id);
    if (error) throw safeDbError(error, "remove antimicrobial name");
    return { id: data.id };
  });
