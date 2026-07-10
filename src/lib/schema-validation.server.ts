// Server-only startup schema validation.
//
// Serverless workers have no long-lived "startup", so this runs lazily on the
// first server request per worker instance and memoizes its result. It probes
// every table in REQUIRED_SCHEMA by selecting the required columns with a
// head-only query (no rows returned). PostgREST reports a missing table or a
// missing column as a query error, which we translate into a clear message.
import { REQUIRED_SCHEMA } from "@/lib/schema-manifest";

export type SchemaProblem = {
  table: string;
  kind: "missing_table" | "missing_column" | "unknown";
  detail: string;
};

export type SchemaValidationResult = {
  ok: boolean;
  problems: SchemaProblem[];
  checkedAt: string;
};

// PostgREST / Postgres error codes we can classify.
function classify(table: string, error: { code?: string; message?: string }): SchemaProblem {
  const code = error.code ?? "";
  const message = error.message ?? "unknown error";
  // 42P01 = undefined_table, PGRST205 = table not found in schema cache
  if (code === "42P01" || code === "PGRST205" || /does not exist/i.test(message) && /relation|table/i.test(message)) {
    return { table, kind: "missing_table", detail: `Table "${table}" is missing` };
  }
  // 42703 = undefined_column, PGRST204 = column not found in schema cache
  if (code === "42703" || code === "PGRST204" || /column .* does not exist/i.test(message)) {
    return { table, kind: "missing_column", detail: `Table "${table}": ${message}` };
  }
  return { table, kind: "unknown", detail: `Table "${table}": ${message}` };
}

async function runValidation(): Promise<SchemaValidationResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = supabaseAdmin as any;
  const problems: SchemaProblem[] = [];

  await Promise.all(
    REQUIRED_SCHEMA.map(async ({ table, columns }) => {
      const { error } = await admin
        .from(table)
        .select(columns.join(","), { head: true, count: "exact" })
        .limit(1);
      if (error) problems.push(classify(table, error));
    }),
  );

  problems.sort((a, b) => a.table.localeCompare(b.table));
  return { ok: problems.length === 0, problems, checkedAt: new Date().toISOString() };
}

let memo: Promise<SchemaValidationResult> | null = null;

// Validate once per worker instance; subsequent calls reuse the result.
// A failed validation is NOT cached so a mid-flight migration can recover.
export function validateSchema(force = false): Promise<SchemaValidationResult> {
  if (force || !memo) {
    memo = runValidation().then((result) => {
      if (!result.ok) memo = null; // allow re-check after the schema is fixed
      return result;
    });
  }
  return memo;
}

export function formatSchemaError(result: SchemaValidationResult): string {
  const lines = result.problems.map((p) => `  • ${p.detail}`);
  return [
    "Database schema validation failed — the connected backend is missing required tables or columns.",
    "Run the outstanding migrations so the schema matches what this app expects.",
    "",
    ...lines,
  ].join("\n");
}

// Fail fast: throw a clear error when the schema is invalid. Memoized so the
// probe cost is paid at most once per worker instance on success.
export async function assertSchema(): Promise<void> {
  const result = await validateSchema();
  if (!result.ok) {
    throw new Error(formatSchemaError(result));
  }
}
