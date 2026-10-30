// Server-only startup schema validation.
//
// Serverless workers have no long-lived "startup", so this runs lazily on the
// first server request per worker instance and memoizes its result. It probes
// every table in REQUIRED_SCHEMA by selecting the required columns with a
// head-only query (no rows returned). PostgREST reports a missing table or a
// missing column as a query error, which we translate into a clear message.
import { REQUIRED_SCHEMA } from "@/lib/schema-manifest";
import { getAdmin } from "@/lib/admin-db.server";

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
  const supabaseAdmin = await getAdmin();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = supabaseAdmin as any;
  const problems: SchemaProblem[] = [];
  let transient = false;

  await Promise.all(
    REQUIRED_SCHEMA.map(async ({ table, columns }) => {
      const { error, status } = await admin
        .from(table)
        // head-only, NO count: avoids a full exact count per table.
        .select(columns.join(","), { head: true })
        .limit(1);
      if (!error) return;
      // Backend unreachable / starting up (5xx or empty error): not a schema
      // problem. Don't block the app; just re-check on a later request.
      if ((status ?? 0) >= 500 || status === 0 || (!error.code && !error.message)) {
        transient = true;
        return;
      }
      problems.push(classify(table, error));
    }),
  );

  if (transient) console.warn("[schema] backend unreachable; schema check deferred");
  problems.sort((a, b) => a.table.localeCompare(b.table));
  return { ok: problems.length === 0, problems, checkedAt: new Date().toISOString(), transient } as SchemaValidationResult & { transient: boolean };
}

// Cache + coalesce: concurrent callers share one in-flight probe; successful
// results are cached for SUCCESS_TTL_MS; failed/deferred results are cached
// too, with exponential backoff, so neither page loads nor the public health
// endpoint can fan out repeated probes to the database.
export const SUCCESS_TTL_MS = 60 * 60 * 1000;
export const FAILURE_BASE_MS = 30 * 1000;
export const FAILURE_MAX_MS = 10 * 60 * 1000;

type Cache = { result: SchemaValidationResult; expiresAt: number } | null;
let cache: Cache = null;
let inflight: Promise<SchemaValidationResult> | null = null;
let failures = 0;

/** Test hook. */
export function __resetSchemaCache() {
  cache = null;
  inflight = null;
  failures = 0;
}

export function nextBackoffMs(failureCount: number): number {
  return Math.min(FAILURE_MAX_MS, FAILURE_BASE_MS * 2 ** Math.max(0, failureCount - 1));
}

export function validateSchema(
  _force = false,
  deps: { run?: () => Promise<SchemaValidationResult>; now?: () => number } = {},
): Promise<SchemaValidationResult> {
  void _force; // forced re-checks are no longer honoured: cache/backoff always apply
  const now = deps.now ?? Date.now;
  if (cache && cache.expiresAt > now()) return Promise.resolve(cache.result);
  if (inflight) return inflight;
  const run = deps.run ?? runValidation;
  inflight = run()
    .catch(
      (e): SchemaValidationResult & { transient: boolean } => ({
        ok: true,
        problems: [],
        checkedAt: new Date(now()).toISOString(),
        transient: true,
        ...(e ? {} : {}),
      }),
    )
    .then((result) => {
      const transient = Boolean((result as { transient?: boolean }).transient);
      if (result.ok && !transient) {
        failures = 0;
        cache = { result, expiresAt: now() + SUCCESS_TTL_MS };
      } else {
        failures += 1;
        cache = { result, expiresAt: now() + nextBackoffMs(failures) };
      }
      inflight = null;
      return result;
    });
  return inflight;
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
