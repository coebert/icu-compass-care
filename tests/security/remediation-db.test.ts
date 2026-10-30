// Executes the REAL security-remediation migration SQL against an in-memory
// Postgres (PGlite) seeded with synthetic users/units/patients only. No live
// database, accounts or patient records are touched.
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(__dirname, "../../drizzle/migrations");
function migrationSql(): string {
  if (process.env["REMEDIATION_SQL"]) return readFileSync(process.env["REMEDIATION_SQL"], "utf8");
  const file = readdirSync(MIG_DIR).find((f) => f.includes("security_remediation_f1_f6"));
  if (!file) throw new Error("remediation migration not found");
  return readFileSync(join(MIG_DIR, file), "utf8");
}

const U = {
  trustA: "00000000-0000-4000-8000-0000000000a1",
  trustB: "00000000-0000-4000-8000-0000000000a2",
  unitAdminA: "00000000-0000-4000-8000-0000000000b1",
  clinA: "00000000-0000-4000-8000-0000000000c1",
  clinB: "00000000-0000-4000-8000-0000000000c2",
  clinAB: "00000000-0000-4000-8000-0000000000c3",
  noUnit: "00000000-0000-4000-8000-0000000000c4",
  revoked: "00000000-0000-4000-8000-0000000000c5",
  auditorA: "00000000-0000-4000-8000-0000000000d1",
  trustInA: "00000000-0000-4000-8000-0000000000a3",
};
const UNIT_A = "10000000-0000-4000-8000-000000000001";
const UNIT_B = "10000000-0000-4000-8000-000000000002";
const PAT_A = "20000000-0000-4000-8000-000000000001";
const PAT_B = "20000000-0000-4000-8000-000000000002";
const PAT_SHARED = "20000000-0000-4000-8000-000000000003";
const sid = (u: string) => u.replace(/^0/, "5");

let db: PGlite;

type Q = { rows: Record<string, unknown>[] };
/** Run statements as a signed-in synthetic user, inside a rolled-back txn. */
async function as<T>(
  user: string | null,
  fn: (q: (sql: string, p?: unknown[]) => Promise<Q>) => Promise<T>,
  opts: { session?: string | null; commit?: boolean } = {},
): Promise<T> {
  const session = opts.session === undefined && user ? sid(user) : opts.session;
  let out!: T;
  let error: unknown;
  await db.exec("BEGIN");
  try {
    if (user) {
      await db.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: user, role: "authenticated", session_id: session ?? undefined }),
      ]);
      await db.exec("SET LOCAL ROLE authenticated");
    } else {
      await db.exec("SET LOCAL ROLE anon");
    }
    out = await fn((sql, p) => db.query(sql, p) as Promise<Q>);
  } catch (e) {
    error = e;
  }
  await db.exec(opts.commit && !error ? "COMMIT" : "ROLLBACK");
  if (error) throw error;
  return out;
}
async function superQ(sql: string, p?: unknown[]) {
  return db.query(sql, p) as Promise<Q>;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(readFileSync(join(__dirname, "sql/fixture.sql"), "utf8"));
  // Synthetic actors, created BEFORE the migration so the bootstrap seal applies.
  for (const id of Object.values(U)) {
    await superQ("INSERT INTO auth.users (id, email) VALUES ($1, $2)", [id, `${id.slice(-3)}@example.test`]);
    await superQ("INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)", [sid(id), id]);
  }
  await superQ("INSERT INTO public.icu_units (id, name, code) VALUES ($1,'Unit A','A'), ($2,'Unit B','B')", [UNIT_A, UNIT_B]);
  const roles: Array<[string, string]> = [
    [U.trustA, "trust_admin"], [U.trustB, "admin"], [U.unitAdminA, "unit_admin"],
    [U.clinA, "clinician"], [U.clinB, "clinician"], [U.clinAB, "clinician"],
    [U.noUnit, "clinician"], [U.revoked, "clinician"], [U.auditorA, "auditor"],
    [U.trustInA, "trust_admin"],
  ];
  for (const [u, r] of roles) await superQ("INSERT INTO public.user_roles (user_id, role) VALUES ($1, $2)", [u, r]);
  const units: Array<[string, string]> = [
    [U.unitAdminA, UNIT_A], [U.clinA, UNIT_A], [U.clinB, UNIT_B], [U.clinAB, UNIT_A], [U.clinAB, UNIT_B],
    [U.auditorA, UNIT_A], [U.trustInA, UNIT_A],
  ];
  for (const [u, unit] of units) await superQ("INSERT INTO public.user_unit_access (user_id, unit_id) VALUES ($1, $2)", [u, unit]);
  await superQ(
    "INSERT INTO public.patients (id, unit_id, shared_with_partner, full_name) VALUES ($1,$4,false,'A.A.'), ($2,$5,false,'B.B.'), ($3,$4,true,'S.S.')",
    [PAT_A, PAT_B, PAT_SHARED, UNIT_A, UNIT_B],
  );
  await superQ(
    "INSERT INTO public.patient_field_changes (patient_id, field_name, old_value, new_value) VALUES ($1,'full_name','X.','A.A.'), ($2,'full_name','Y.','B.B.')",
    [PAT_A, PAT_B],
  );
  await superQ(
    "INSERT INTO public.record_audit (entity, record_id, action, source, before, after, changed_fields) VALUES ('patients',$1,'update','app','{\"full_name\":\"X.\"}','{\"full_name\":\"A.A.\"}','{full_name}')",
    [PAT_A],
  );
  await superQ("INSERT INTO public.handover_versions (local_date, shift, label, snapshot) VALUES ('2026-01-01','am','legacy','[]')");
  await db.exec(migrationSql());
  await superQ(
    "INSERT INTO public.handover_unit_versions (unit_id, local_date, shift, label) VALUES ($1,'2026-02-01','am','A am'), ($2,'2026-02-01','am','B am')",
    [UNIT_A, UNIT_B],
  );
});

describe("F1/F2 target-aware account management", () => {
  const can = (actor: string, target: string) =>
    as(actor, async (q) => (await q("SELECT public.can_manage_account($1) AS ok", [target])).rows[0]!.ok);

  it("unit admin may manage a same-unit clinician", async () => {
    expect(await can(U.unitAdminA, U.clinA)).toBe(true);
  });
  it("unit admin may NOT manage a Trust admin who shares their unit", async () => {
    expect(await can(U.unitAdminA, U.trustInA)).toBe(false);
  });
  it("unit admin may NOT manage an auditor in their unit", async () => {
    expect(await can(U.unitAdminA, U.auditorA)).toBe(false);
  });
  it("unit admin may NOT globally manage a multi-unit account", async () => {
    expect(await can(U.unitAdminA, U.clinAB)).toBe(false);
  });
  it("unit admin may NOT manage other-unit or no-unit accounts", async () => {
    expect(await can(U.unitAdminA, U.clinB)).toBe(false);
    expect(await can(U.unitAdminA, U.noUnit)).toBe(false);
  });
  it("Trust admin may manage anyone except themselves", async () => {
    expect(await can(U.trustA, U.clinAB)).toBe(true);
    expect(await can(U.trustA, U.trustInA)).toBe(true);
    expect(await can(U.trustA, U.trustA)).toBe(false);
  });
  it("clinicians cannot manage accounts", async () => {
    expect(await can(U.clinA, U.clinA)).toBe(false);
    expect(await can(U.clinA, U.clinB)).toBe(false);
  });

  it("unit admin role replacement for a same-unit clinician is atomic", async () => {
    const roles = await as(U.unitAdminA, async (q) => {
      await q("SELECT public.replace_user_roles($1, ARRAY['unit_admin']::public.app_role[])", [U.clinA]);
      return (await q("SELECT role FROM public.user_roles WHERE user_id = $1", [U.clinA])).rows.map((r) => r.role);
    });
    expect(roles).toEqual(["unit_admin"]);
  });
  it("unit admin cannot hand out trust_admin, even to a manageable account", async () => {
    await expect(
      as(U.unitAdminA, (q) => q("SELECT public.replace_user_roles($1, ARRAY['trust_admin']::public.app_role[])", [U.clinA])),
    ).rejects.toThrow(/FORBIDDEN_ROLE/);
  });
  it("unit admin cannot demote a same-unit Trust admin via RPC", async () => {
    await expect(
      as(U.unitAdminA, (q) => q("SELECT public.replace_user_roles($1, ARRAY['clinician']::public.app_role[])", [U.trustInA])),
    ).rejects.toThrow(/FORBIDDEN_TARGET/);
  });
  it("unit admin direct Data API delete of a Trust admin's role affects zero rows", async () => {
    const n = await as(U.unitAdminA, async (q) => {
      const r = await q("DELETE FROM public.user_roles WHERE user_id = $1 RETURNING id", [U.trustInA]);
      return r.rows.length;
    });
    expect(n).toBe(0);
  });
  it("unit admin cannot add a Trust admin or auditor to a unit, but can add a clinician", async () => {
    await expect(
      as(U.unitAdminA, (q) => q("INSERT INTO public.user_unit_access (user_id, unit_id) VALUES ($1, $2)", [U.noUnit, UNIT_A])),
    ).resolves.toBeDefined();
    await expect(
      as(U.unitAdminA, (q) => q("INSERT INTO public.user_unit_access (user_id, unit_id) VALUES ($1, $2)", [U.trustB, UNIT_A])),
    ).rejects.toThrow(/row-level security/);
  });

  it("the last Trust administrator cannot be removed (role, cascade delete)", async () => {
    // Remove all but one admin in a txn, then try to remove the last.
    await expect(
      as(null, async () => {
        await db.exec("RESET ROLE");
        await superQ("DELETE FROM public.user_roles WHERE user_id IN ($1, $2)", [U.trustB, U.trustInA]);
        await superQ("DELETE FROM public.user_roles WHERE user_id = $1 AND role = 'trust_admin'", [U.trustA]);
      }),
    ).rejects.toThrow(/LAST_TRUST_ADMIN/);
    await expect(
      as(null, async () => {
        await db.exec("RESET ROLE");
        await superQ("DELETE FROM public.user_roles WHERE user_id IN ($1, $2)", [U.trustB, U.trustInA]);
        await superQ("DELETE FROM auth.users WHERE id = $1", [U.trustA]);
      }),
    ).rejects.toThrow(/LAST_TRUST_ADMIN/);
  });
  it("removing every Trust admin in one statement is refused", async () => {
    await expect(
      as(null, async () => {
        await db.exec("RESET ROLE");
        await superQ("DELETE FROM public.user_roles WHERE role IN ('trust_admin','admin')");
      }),
    ).rejects.toThrow(/LAST_TRUST_ADMIN/);
  });
  it("a Trust admin can still demote another while one remains", async () => {
    await expect(
      as(U.trustA, (q) => q("SELECT public.replace_user_roles($1, ARRAY['clinician']::public.app_role[])", [U.trustInA])),
    ).resolves.toBeDefined();
  });

  it("bootstrap is sealed once accounts exist and cannot be reopened", async () => {
    const sealed = (await superQ("SELECT public.bootstrap_sealed() AS s")).rows[0]!.s;
    expect(sealed).toBe(true);
    await expect(superQ("SELECT public.complete_bootstrap($1)", [U.clinA])).rejects.toThrow(/BOOTSTRAP_SEALED/);
    await expect(as(U.clinA, (q) => q("SELECT public.complete_bootstrap($1)", [U.clinA]))).rejects.toThrow(/permission denied/);
  });
});

describe("F6 server-enforced session lock", () => {
  const visiblePatients = (user: string, session?: string | null) =>
    as(user, async (q) => (await q("SELECT id FROM public.patients")).rows.length, { session });

  it("an active session sees its unit's patients", async () => {
    expect(await visiblePatients(U.clinA)).toBe(2);
  });
  it("a locked session is denied on direct table reads", async () => {
    await as(U.clinA, (q) => q("SELECT public.session_lock()"), { commit: true });
    expect(await visiblePatients(U.clinA)).toBe(0);
    // Status / heartbeat never revive it.
    const s = await as(U.clinA, async (q) => (await q("SELECT public.session_heartbeat() AS s")).rows[0]!.s);
    expect(s).toBe("locked");
    expect(await visiblePatients(U.clinA)).toBe(0);
  });
  it("clients cannot write the guard table to unlock themselves", async () => {
    await expect(
      as(U.clinA, (q) => q("DELETE FROM public.session_guard WHERE session_id = $1", [sid(U.clinA)])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(U.clinA, (q) => q("SELECT public.session_unlock($1, $2)", [sid(U.clinA), U.clinA])),
    ).rejects.toThrow(/permission denied/);
  });
  it("server-side unlock (after verified passkey) restores access", async () => {
    await superQ("SET ROLE service_role");
    await superQ("SELECT public.session_unlock($1, $2)", [sid(U.clinA), U.clinA]);
    await superQ("RESET ROLE");
    expect(await visiblePatients(U.clinA)).toBe(2);
  });
  it("an idle session is locked by the server and stays locked", async () => {
    await superQ("INSERT INTO public.session_guard (session_id, user_id, last_activity_at) VALUES ($1,$2, now() - interval '20 minutes')", [sid(U.clinB), U.clinB]);
    expect(await visiblePatients(U.clinB)).toBe(0);
    const s = await as(U.clinB, async (q) => (await q("SELECT public.session_heartbeat() AS s")).rows[0]!.s, { commit: true });
    expect(s).toBe("locked");
  });
  it("a revoked (signed-out) session or a token without a session is denied", async () => {
    expect(await visiblePatients(U.clinAB, "99999999-0000-4000-8000-000000000000")).toBe(0);
    expect(await visiblePatients(U.clinAB, null)).toBe(0);
  });
});

describe("F3 unit-scoped handover snapshots", () => {
  const labels = (user: string, table = "handover_unit_versions") =>
    as(user, async (q) => (await q(`SELECT label FROM public.${table} ORDER BY label`)).rows.map((r) => r.label));

  it("unit A clinician sees only unit A snapshots", async () => {
    expect(await labels(U.unitAdminA)).toEqual(["A am"]);
  });
  it("multi-unit clinician sees both units", async () => {
    expect(await labels(U.clinAB)).toEqual(["A am", "B am"]);
  });
  it("no-unit clinician and auditors see nothing", async () => {
    expect(await labels(U.noUnit)).toEqual([]);
    expect(await labels(U.auditorA)).toEqual([]);
  });
  it("legacy mixed-unit snapshots are quarantined to Trust admins", async () => {
    expect(await labels(U.clinAB, "handover_versions")).toEqual([]);
    expect(await labels(U.trustA, "handover_versions")).toEqual(["legacy"]);
    expect(await labels(U.trustA)).toEqual(["A am", "B am"]);
  });
  it("clients cannot write snapshots directly", async () => {
    await expect(
      as(U.trustA, (q) => q("INSERT INTO public.handover_unit_versions (unit_id, local_date, shift, label) VALUES ($1,'2026-03-01','am','x')", [UNIT_A])),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("F4 edit history and audit projections", () => {
  it("auditors cannot read field-change values or record_audit payloads directly", async () => {
    const r = await as(U.auditorA, async (q) => ({
      changes: (await q("SELECT old_value, new_value FROM public.patient_field_changes")).rows.length,
      audit: (await q("SELECT before, after FROM public.record_audit")).rows.length,
    }));
    expect(r).toEqual({ changes: 0, audit: 0 });
  });
  it("auditor metadata projection returns only safe columns", async () => {
    const rows = await as(U.auditorA, async (q) => (await q("SELECT * FROM public.audit_field_change_metadata(NULL, 50)")).rows);
    expect(rows.length).toBe(2);
    expect(Object.keys(rows[0]!).sort()).toEqual(["changed_at", "changed_by", "changed_by_email", "field_name", "id", "patient_id"]);
    const audit = await as(U.auditorA, async (q) => (await q("SELECT * FROM public.audit_record_metadata()")).rows);
    expect(Object.keys(audit[0]!)).not.toContain("before");
    expect(Object.keys(audit[0]!)).not.toContain("after");
  });
  it("clinicians cannot call the auditor projection", async () => {
    await expect(as(U.clinA, (q) => q("SELECT * FROM public.audit_field_change_metadata()"))).rejects.toThrow(/FORBIDDEN/);
  });
  it("field history is visible only for patients the user can see", async () => {
    expect(await as(U.clinA, async (q) => (await q("SELECT patient_id FROM public.patient_field_changes")).rows.map((r) => r.patient_id))).toEqual([PAT_A]);
    expect(await as(U.revoked, async (q) => (await q("SELECT 1 FROM public.patient_field_changes")).rows.length)).toBe(0);
  });
  it("field history is append-only for signed-in users", async () => {
    await expect(as(U.clinA, (q) => q("UPDATE public.patient_field_changes SET new_value = 'Z.'"))).rejects.toThrow(/permission denied/);
    await expect(as(U.trustA, (q) => q("DELETE FROM public.patient_field_changes"))).rejects.toThrow(/permission denied/);
  });
  it("anon has no access to audit tables", async () => {
    await expect(as(null, (q) => q("SELECT 1 FROM public.record_audit"))).rejects.toThrow(/permission denied/);
  });
});

describe("F5 bridge investigation insert gated on sharing", () => {
  it("inserts only for shared patients", async () => {
    await superQ("SET ROLE service_role");
    try {
      const ok = await superQ("SELECT id FROM public.bridge_insert_investigation($1,'Bloods','synthetic',NULL)", [PAT_SHARED]);
      const denied = await superQ("SELECT id FROM public.bridge_insert_investigation($1,'Bloods','synthetic',NULL)", [PAT_A]);
      expect(ok.rows.length).toBe(1);
      expect(denied.rows.length).toBe(0);
    } finally {
      await superQ("RESET ROLE");
    }
  });
  it("signed-in users cannot call the bridge insert", async () => {
    await expect(
      as(U.clinA, (q) => q("SELECT public.bridge_insert_investigation($1,'x','y',NULL)", [PAT_SHARED])),
    ).rejects.toThrow(/permission denied/);
  });
});
