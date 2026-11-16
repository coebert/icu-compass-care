/**
 * Minimal in-memory stand-in for the Supabase query builder. Every call is
 * recorded; `resolve` decides what each query returns. Nothing leaves the
 * process, so tests using it never touch the live backend.
 */
export type FakeCall = {
  table: string;
  op: "select" | "insert" | "upsert" | "update" | "delete";
  columns?: string;
  options?: unknown;
  payload?: unknown;
  filters: Array<[string, ...unknown[]]>;
};
export type FakeResult = { data?: unknown; error?: unknown; count?: number | null };

export function fakeSupabase(resolve: (call: FakeCall) => FakeResult | Promise<FakeResult>) {
  const calls: FakeCall[] = [];
  const client = {
    calls,
    from(table: string) {
      const call: FakeCall = { table, op: "select", filters: [] };
      calls.push(call);
      const run = async () => {
        const r = await resolve(call);
        return { data: r.data ?? null, error: r.error ?? null, count: r.count ?? null };
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {
        select(columns?: string, options?: unknown) {
          if (call.op === "select") {
            call.columns = columns;
            call.options = options;
          }
          return b;
        },
        insert(payload: unknown) {
          call.op = "insert";
          call.payload = payload;
          return b;
        },
        upsert(payload: unknown, options?: unknown) {
          call.op = "upsert";
          call.payload = payload;
          call.options = options;
          return b;
        },
        update(payload: unknown) {
          call.op = "update";
          call.payload = payload;
          return b;
        },
        delete() {
          call.op = "delete";
          return b;
        },
        maybeSingle: run,
        single: run,
        then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
          return run().then(ok, bad);
        },
      };
      for (const m of ["eq", "neq", "in", "is", "not", "gte", "lte", "lt", "gt", "order", "limit", "range"]) {
        b[m] = (...args: unknown[]) => {
          call.filters.push([m, ...args]);
          return b;
        };
      }
      return b;
    },
  };
  return client;
}

export const hasFilter = (c: FakeCall, op: string, col: string, val?: unknown) =>
  c.filters.some(
    ([o, k, v]) => o === op && k === col && (val === undefined || JSON.stringify(v) === JSON.stringify(val)),
  );
