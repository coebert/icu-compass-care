// Partner (Critical Care Connect) clinical READ exports.
//
// Every clinical feed goes through one staged SQL function
// (docs/security/staged-migrations/0008_bridge_read_exports.sql) that checks
// "parent patient is in the bridge unit AND still shared" in the same
// statement that reads the rows. There is deliberately no helper that returns
// a list of shared ids for a later query: a revocation between two reads
// would otherwise still export the record, and an id list has no unit scope.
//
// Failure is never an empty list: a missing/duplicate bridge unit, a missing
// function, a query error or a malformed result is "unavailable". Only the
// database error CODE is logged — never values or database text.

export type BridgeExportFn =
  | "bridge_export_investigations"
  | "bridge_export_microbiology"
  | "bridge_export_referrals"
  | "bridge_export_notifications"
  | "bridge_export_audit";

export type BridgeExportResult =
  | { ok: true; rows: Record<string, unknown>[] }
  | { ok: false; status: 503 };

export async function bridgeExport(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  fn: BridgeExportFn,
  args: Record<string, unknown> = {},
): Promise<BridgeExportResult> {
  let res: { data: unknown; error: { code?: string } | null };
  try {
    res = await admin.rpc(fn, args);
  } catch {
    console.error("[bridge] export unavailable", fn, "exception");
    return { ok: false, status: 503 };
  }
  if (res.error) {
    console.error("[bridge] export unavailable", fn, res.error.code ?? "unknown");
    return { ok: false, status: 503 };
  }
  if (!Array.isArray(res.data) || res.data.some((r) => !r || typeof r !== "object")) {
    console.error("[bridge] export unavailable", fn, "malformed");
    return { ok: false, status: 503 };
  }
  return { ok: true, rows: res.data as Record<string, unknown>[] };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string): boolean => UUID_RE.test(v);
