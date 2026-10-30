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
  // Apply every security-remediation migration in journal order (0002, 0003, ...).
  const files = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql") && f.includes("security_remediation"))
    .sort();
  if (!files.some((f) => f.includes("security_remediation_apply"))) throw new Error("remediation migration not found");
  return files.map((f) => readFileSync(join(MIG_DIR, f), "utf8")).join("\n;\n");
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
  opts: { session?: string | null; commit?: boolean; claims?: Record<string, unknown> } = {},
): Promise<T> {
  const session = opts.session === undefined && user ? sid(user) : opts.session;
  let out!: T;
  let error: unknown;
  await db.exec("BEGIN");
  try {
    if (user) {
      await db.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: user, role: "authenticated", session_id: session ?? undefined, ...(opts.claims ?? {}) }),
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

  const rr = (target: string, roles: string, action = "role_changed") =>
    `SELECT public.admin_replace_user_roles('${target}', ARRAY[${roles}]::public.app_role[], 'synthetic test reason', '${action}')`;
  it("unit admin role replacement for a same-unit clinician is atomic and audited", async () => {
    const out = await as(U.unitAdminA, async (q) => {
      await q(rr(U.clinA, "'unit_admin'"));
      const roles = (await q("SELECT role FROM public.user_roles WHERE user_id = $1", [U.clinA])).rows.map((r) => r.role);
      return roles;
    }, { claims: freshAmr() });
    expect(out).toEqual(["unit_admin"]);
  });
  it("unit admin cannot hand out trust_admin, even to a manageable account", async () => {
    await expect(
      as(U.unitAdminA, (q) => q(rr(U.clinA, "'trust_admin'")), { claims: freshAmr() }),
    ).rejects.toThrow(/FORBIDDEN_ROLE/);
  });
  it("unit admin cannot demote a same-unit Trust admin via RPC", async () => {
    await expect(
      as(U.unitAdminA, (q) => q(rr(U.trustInA, "'clinician'")), { claims: freshAmr() }),
    ).rejects.toThrow(/FORBIDDEN_TARGET/);
  });
  it("direct Data API writes to roles are refused outright", async () => {
    await expect(
      as(U.unitAdminA, (q) => q("DELETE FROM public.user_roles WHERE user_id = $1 RETURNING id", [U.trustInA])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(U.trustA, (q) => q("INSERT INTO public.user_roles (user_id, role) VALUES ($1,'trust_admin')", [U.clinA]), { claims: freshAmr() }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      as(U.trustA, (q) => q("SELECT public.replace_user_roles($1, ARRAY['clinician']::public.app_role[])", [U.clinA])),
    ).rejects.toThrow(/permission denied/);
  });
  it("unit admin cannot add a Trust admin or auditor to a unit, but can add a clinician (reauth + reason)", async () => {
    await expect(
      as(U.unitAdminA, (q) => q("INSERT INTO public.user_unit_access (user_id, unit_id, reason) VALUES ($1, $2, 'synthetic')", [U.noUnit, UNIT_A]), { claims: freshAmr() }),
    ).resolves.toBeDefined();
    await expect(
      as(U.unitAdminA, (q) => q("INSERT INTO public.user_unit_access (user_id, unit_id, reason) VALUES ($1, $2, 'synthetic')", [U.trustB, UNIT_A]), { claims: freshAmr() }),
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
      as(U.trustA, (q) => q(rr(U.trustInA, "'clinician'")), { claims: freshAmr() }),
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

// ---------------------------------------------------------------------------
// Review round 2 (commit 047c510 findings)
// ---------------------------------------------------------------------------
const LOCKED_SID = "60000000-0000-4000-8000-0000000000c1";
const freshAmr = () => ({ amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) - 30 }] });
const staleAmr = () => ({ amr: [{ method: "password", timestamp: Math.floor(Date.now() / 1000) - 3600 }] });

describe("Passkey enrolment cannot bypass a locked session", () => {
  beforeAll(async () => {
    await superQ("INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)", [LOCKED_SID, U.clinA]);
    await superQ("INSERT INTO public.session_guard (session_id, user_id, locked_at) VALUES ($1, $2, now())", [LOCKED_SID, U.clinA]);
  });
  const insertCred = (opts: Parameters<typeof as>[2]) =>
    as(U.clinA, (q) => q(
      "INSERT INTO public.webauthn_credentials (user_id, credential_id, public_key) VALUES ($1, $2, 'pk')",
      [U.clinA, `cred-${Math.random()}`],
    ), opts);

  it("a locked session cannot enrol a passkey, even with a fresh re-auth stamp", async () => {
    await expect(insertCred({ session: LOCKED_SID, claims: freshAmr() })).rejects.toThrow(/row-level security/);
  });
  it("an active session without recent re-authentication cannot enrol", async () => {
    await expect(insertCred({ claims: staleAmr() })).rejects.toThrow(/row-level security/);
    await expect(insertCred({})).rejects.toThrow(/row-level security/);
  });
  it("an active, recently re-authenticated session can enrol its own passkey", async () => {
    await expect(insertCred({ claims: freshAmr() })).resolves.toBeDefined();
  });
  it("nobody can enrol a passkey for another user", async () => {
    await expect(
      as(U.clinA, (q) => q("INSERT INTO public.webauthn_credentials (user_id, credential_id, public_key) VALUES ($1,'x','pk')", [U.clinB]), { claims: freshAmr() }),
    ).rejects.toThrow(/row-level security/);
  });
  it("a locked session cannot write a challenge, and clients can never claim a session binding", async () => {
    await expect(
      as(U.clinA, (q) => q("INSERT INTO public.webauthn_challenges (user_id, challenge, purpose) VALUES ($1,'c','registration')", [U.clinA]), { session: LOCKED_SID }),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as(U.clinA, (q) => q("INSERT INTO public.webauthn_challenges (user_id, challenge, purpose, session_id) VALUES ($1,'c','authentication',$2)", [U.clinA, sid(U.clinA)])),
    ).rejects.toThrow(/row-level security/);
  });
  it("signature counters cannot be edited by the user", async () => {
    await expect(
      as(U.clinA, (q) => q("UPDATE public.webauthn_credentials SET counter = 0 WHERE user_id = $1", [U.clinA])),
    ).rejects.toThrow(/permission denied/);
  });
  it("a locked session cannot delete passkeys", async () => {
    await superQ("INSERT INTO public.webauthn_credentials (user_id, credential_id, public_key) VALUES ($1,'keep-me','pk')", [U.clinA]);
    const n = await as(U.clinA, async (q) => (await q("DELETE FROM public.webauthn_credentials WHERE credential_id = 'keep-me' RETURNING id")).rows.length, { session: LOCKED_SID });
    expect(n).toBe(0);
  });
});

describe("Raw audit_log is scoped to current clinical access", () => {
  const DEMOTED = "00000000-0000-4000-8000-0000000000e1";
  const ROLELESS = "00000000-0000-4000-8000-0000000000e2";
  const MOVED = "00000000-0000-4000-8000-0000000000e3";
  const ownRows = (user: string, opts: Parameters<typeof as>[2] = {}) =>
    as(user, async (q) => (await q("SELECT id FROM public.audit_log")).rows.length, opts);

  beforeAll(async () => {
    for (const id of [DEMOTED, ROLELESS, MOVED]) {
      await superQ("INSERT INTO auth.users (id, email) VALUES ($1, $2)", [id, `${id.slice(-3)}@example.test`]);
      await superQ("INSERT INTO auth.sessions (id, user_id) VALUES ($1, $2)", [sid(id), id]);
    }
    // Former clinicians: one now auditor, one with no role, one moved to unit B.
    await superQ("INSERT INTO public.user_roles (user_id, role) VALUES ($1,'auditor'), ($2,'clinician')", [DEMOTED, MOVED]);
    await superQ("INSERT INTO public.user_unit_access (user_id, unit_id) VALUES ($1,$3), ($2,$3), ($4,$5)", [DEMOTED, ROLELESS, UNIT_A, MOVED, UNIT_B]);
    // Historical PHI diffs each of them authored on unit A's patient, plus clinA's.
    for (const author of [DEMOTED, ROLELESS, MOVED, U.clinA]) {
      await superQ("INSERT INTO public.audit_log (user_id, action, entity, entity_id, diff) VALUES ($1,'update','patients',$2,'{\"full_name\":\"A.A.\"}')", [author, PAT_A]);
    }
    await superQ("INSERT INTO public.audit_log (user_id, action, entity, entity_id, diff) VALUES ($1,'update','chart_scan',NULL,'{}')", [U.clinA]);
  });

  it("an active in-scope clinician still sees their own patient audit rows", async () => {
    expect(await ownRows(U.clinA)).toBe(1);
  });
  it("a former clinician now auditor cannot read raw diffs, only metadata", async () => {
    expect(await ownRows(DEMOTED)).toBe(0);
    const meta = await as(DEMOTED, async (q) => (await q("SELECT * FROM public.audit_log_metadata(500)")).rows);
    expect(meta.length).toBeGreaterThan(0);
    expect(Object.keys(meta[0]!)).not.toContain("diff");
  });
  it("a roleless (revoked) former clinician sees nothing", async () => {
    expect(await ownRows(ROLELESS)).toBe(0);
  });
  it("a clinician moved to another unit loses old-unit audit rows", async () => {
    expect(await ownRows(MOVED)).toBe(0);
  });
  it("a locked session cannot read its own audit rows", async () => {
    expect(await ownRows(U.clinA, { session: LOCKED_SID })).toBe(0);
  });
  it("Trust admins can read the full audit log", async () => {
    expect(await ownRows(U.trustA)).toBeGreaterThanOrEqual(5);
  });
  it("a locked session cannot append audit entries", async () => {
    await expect(
      as(U.clinA, (q) => q("INSERT INTO public.audit_log (user_id, action, entity) VALUES ($1,'view','x')", [U.clinA]), { session: LOCKED_SID }),
    ).rejects.toThrow(/row-level security/);
  });
});

describe("Bridge investigation insert after sharing is revoked", () => {
  it("a formerly-shared patient gets no new investigations", async () => {
    await superQ("UPDATE public.patients SET shared_with_partner = false WHERE id = $1", [PAT_SHARED]);
    await superQ("SET ROLE service_role");
    try {
      const r = await superQ("SELECT id FROM public.bridge_insert_investigation($1,'Bloods','synthetic',NULL)", [PAT_SHARED]);
      expect(r.rows.length).toBe(0);
    } finally {
      await superQ("RESET ROLE");
      await superQ("UPDATE public.patients SET shared_with_partner = true WHERE id = $1", [PAT_SHARED]);
    }
  });
});

// ---------------------------------------------------------------------------
// Review round 3
// ---------------------------------------------------------------------------
describe("Idle baseline for sessions without a guard row", () => {
  const OLDU = "00000000-0000-4000-8000-0000000000f1";
  const OLD_SID = "70000000-0000-4000-8000-0000000000f1";
  const NEW_SID = "70000000-0000-4000-8000-0000000000f2";
  const setEnforce = (on: boolean) =>
    superQ("UPDATE private.security_settings SET enforce_session_baseline = $1", [on]);
  const seen = (session: string) =>
    as(OLDU, async (q) => (await q("SELECT id FROM public.patients")).rows.length, { session });

  beforeAll(async () => {
    await superQ("INSERT INTO auth.users (id, email) VALUES ($1,'f1@example.test')", [OLDU]);
    await superQ("INSERT INTO auth.sessions (id, user_id, created_at) VALUES ($1,$3, now() - interval '3 hours'), ($2,$3, now())", [OLD_SID, NEW_SID, OLDU]);
    await superQ("INSERT INTO public.user_roles (user_id, role) VALUES ($1,'clinician')", [OLDU]);
    await superQ("INSERT INTO public.user_unit_access (user_id, unit_id, reason) VALUES ($1,$2,'synthetic')", [OLDU, UNIT_A]);
  });

  it("while the switch is off (old client still live), an old session is not locked out", async () => {
    await setEnforce(false);
    expect(await seen(OLD_SID)).toBe(2);
  });
  it("once enforced, an old valid session with no guard row and no heartbeat is idle-locked", async () => {
    await setEnforce(true);
    try {
      expect(await seen(OLD_SID)).toBe(0);
      const s = await as(OLDU, async (q) => (await q("SELECT public.session_heartbeat() AS s")).rows[0]!.s, { session: OLD_SID, commit: true });
      expect(s).toBe("locked");
      // The heartbeat recorded a lock; it did not initialise the session as active.
      expect(await seen(OLD_SID)).toBe(0);
      const s2 = await as(OLDU, async (q) => (await q("SELECT public.session_status() AS s")).rows[0]!.s, { session: OLD_SID });
      expect(s2).toBe("locked");
    } finally {
      await setEnforce(false);
    }
  });
  it("a freshly authenticated session is active, and a refreshed token does not count as activity", async () => {
    await setEnforce(true);
    try {
      // iat in the JWT is ignored; only auth.sessions.created_at / guard rows matter.
      expect(await seen(NEW_SID)).toBe(2);
      await superQ("UPDATE auth.sessions SET created_at = now() - interval '1 hour' WHERE id = $1", [NEW_SID]);
      const fresh = await as(OLDU, async (q) => (await q("SELECT id FROM public.patients")).rows.length, {
        session: NEW_SID,
        claims: { iat: Math.floor(Date.now() / 1000) },
      });
      expect(fresh).toBe(0);
    } finally {
      await setEnforce(false);
    }
  });
  it("clients cannot flip the enforcement switch", async () => {
    await expect(
      as(U.trustA, (q) => q("UPDATE private.security_settings SET enforce_session_baseline = false")),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("Authoritative admin transactions", () => {
  const SUSP = "00000000-0000-4000-8000-0000000000f3";
  const TRUST_LOCKED_SID = "70000000-0000-4000-8000-0000000000a1";
  const call = (actor: string, sql: string, opts: Parameters<typeof as>[2] = { claims: freshAmr() }) =>
    as(actor, (q) => q(sql), opts);
  const rr = (target: string, roles: string, reason = "synthetic reason", action = "role_changed") =>
    `SELECT public.admin_replace_user_roles('${target}', ARRAY[${roles}]::public.app_role[], ${reason === null ? "NULL" : `'${reason}'`}, '${action}')`;

  beforeAll(async () => {
    await superQ("INSERT INTO auth.users (id, email, banned_until) VALUES ($1,'f3@example.test', now() + interval '100 years')", [SUSP]);
    await superQ("INSERT INTO auth.sessions (id, user_id) VALUES ($1,$2)", [sid(SUSP), SUSP]);
    await superQ("INSERT INTO public.user_unit_access (user_id, unit_id, reason) VALUES ($1,$2,'synthetic')", [SUSP, UNIT_A]);
    await superQ("INSERT INTO auth.sessions (id, user_id) VALUES ($1,$2)", [TRUST_LOCKED_SID, U.trustA]);
    await superQ("INSERT INTO public.session_guard (session_id, user_id, locked_at) VALUES ($1,$2, now())", [TRUST_LOCKED_SID, U.trustA]);
  });

  it("requires a recent verified re-authentication (not a caller-supplied value)", async () => {
    await expect(call(U.trustA, rr(U.clinB, "'clinician'"), { claims: staleAmr() })).rejects.toThrow(/REAUTH_REQUIRED/);
    await expect(call(U.trustA, rr(U.clinB, "'clinician'"), {})).rejects.toThrow(/REAUTH_REQUIRED/);
  });
  it("requires a reason", async () => {
    await expect(call(U.trustA, rr(U.clinB, "'clinician'", "x"))).rejects.toThrow(/REASON_REQUIRED/);
    await expect(call(U.trustA, `SELECT public.admin_replace_user_roles('${U.clinB}', ARRAY['clinician']::public.app_role[], NULL)`)).rejects.toThrow(/REASON_REQUIRED/);
  });
  it("refuses a locked session even with a fresh re-auth stamp", async () => {
    await expect(
      call(U.trustA, rr(U.clinB, "'clinician'"), { session: TRUST_LOCKED_SID, claims: freshAmr() }),
    ).rejects.toThrow(/SESSION_LOCKED/);
  });
  it("refuses self-demotion", async () => {
    await expect(call(U.trustA, rr(U.trustA, "'clinician'"))).rejects.toThrow(/FORBIDDEN_TARGET/);
  });
  it("writes a mandatory audit event in the same transaction", async () => {
    const ev = await as(U.trustA, async (q) => {
      await q(rr(U.clinB, "'clinician'", "audited change"));
      return (await q("SELECT action, reason, actor_id FROM public.account_access_events WHERE target_user_id = $1 AND reason = 'audited change'", [U.clinB])).rows;
    }, { claims: freshAmr() });
    // authenticated cannot read events directly unless policy allows; fall back to superuser check
    void ev;
    await as(U.trustA, (q) => q(rr(U.clinB, "'clinician'", "audited change committed")), { claims: freshAmr(), commit: true });
    const rows = (await superQ("SELECT action, reason, actor_id FROM public.account_access_events WHERE reason = 'audited change committed'")).rows;
    expect(rows).toEqual([{ action: "role_changed", reason: "audited change committed", actor_id: U.trustA }]);
  });
  it("if the audit insert fails, the role change is rolled back", async () => {
    await db.exec("BEGIN");
    try {
      await db.exec("ALTER TABLE public.account_access_events ADD CONSTRAINT tmp_fail CHECK (action <> 'role_changed') NOT VALID");
      await db.exec("SAVEPOINT s1");
      await db.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: U.trustA, role: "authenticated", session_id: sid(U.trustA), ...freshAmr() }),
      ]);
      await db.exec("SET LOCAL ROLE authenticated");
      await expect(db.query(rr(U.clinB, "'unit_admin'"))).rejects.toThrow(/tmp_fail/);
      await db.exec("ROLLBACK TO SAVEPOINT s1");
      await db.exec("RESET ROLE");
      const roles = (await db.query<{ role: string }>("SELECT role FROM public.user_roles WHERE user_id = $1", [U.clinB])).rows.map((r) => r.role);
      expect(roles).toEqual(["clinician"]);
    } finally {
      await db.exec("ROLLBACK");
    }
  });
  it("refuses to assign roles or units to a suspended account except controlled reinstatement", async () => {
    await expect(call(U.trustA, rr(SUSP, "'clinician'"))).rejects.toThrow(/TARGET_SUSPENDED/);
    await expect(
      call(U.trustA, `SELECT public.admin_set_unit_access('${SUSP}', '${UNIT_B}', true, 'synthetic grant')`),
    ).rejects.toThrow(/TARGET_SUSPENDED/);
    await expect(call(U.trustA, rr(SUSP, "'clinician'", "reinstating", "reinstated"))).resolves.toBeDefined();
    await expect(call(U.trustA, rr(U.clinB, "'clinician'", "bogus", "reinstated"))).rejects.toThrow(/not suspended/);
  });
  it("unit membership changes go through the audited RPC; direct revoke is refused", async () => {
    await expect(
      as(U.unitAdminA, (q) => q("DELETE FROM public.user_unit_access WHERE user_id = $1", [U.clinA])),
    ).rejects.toThrow(/permission denied/);
    await expect(
      call(U.unitAdminA, `SELECT public.admin_set_unit_access('${U.clinB}', '${UNIT_B}', false, 'out of scope')`),
    ).rejects.toThrow(/FORBIDDEN_TARGET/);
    await expect(
      call(U.unitAdminA, `SELECT public.admin_set_unit_access('${U.noUnit}', '${UNIT_A}', true, 'synthetic grant')`),
    ).resolves.toBeDefined();
    await expect(
      call(U.unitAdminA, `SELECT public.admin_set_unit_access('${U.noUnit}', '${UNIT_A}', true, 'synthetic grant')`, { claims: staleAmr() }),
    ).rejects.toThrow(/REAUTH_REQUIRED/);
  });
  it("transitional direct unit-access insert needs reauth and a reason", async () => {
    await expect(
      as(U.unitAdminA, (q) => q("INSERT INTO public.user_unit_access (user_id, unit_id, reason) VALUES ($1,$2,'synthetic')", [U.noUnit, UNIT_A])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      as(U.unitAdminA, (q) => q("INSERT INTO public.user_unit_access (user_id, unit_id) VALUES ($1,$2)", [U.noUnit, UNIT_A]), { claims: freshAmr() }),
    ).rejects.toThrow(/row-level security/);
  });
  it("server-side (service role) changes are still audited", async () => {
    await superQ("SET ROLE service_role");
    try {
      await superQ("INSERT INTO public.user_unit_access (user_id, unit_id, reason) VALUES ($1,$2,'svc synthetic')", [U.clinB, UNIT_A]);
    } finally {
      await superQ("RESET ROLE");
    }
    const rows = (await superQ("SELECT action FROM public.account_access_events WHERE target_user_id = $1 AND reason = 'svc synthetic'", [U.clinB])).rows;
    expect(rows).toEqual([{ action: "access_change" }]);
    await superQ("DELETE FROM public.user_unit_access WHERE user_id = $1 AND unit_id = $2", [U.clinB, UNIT_A]);
  });
});

describe("Last-admin protection counts only enabled accounts", () => {
  it("a banned account holding a Trust role does not satisfy the guard", async () => {
    await expect(
      as(null, async () => {
        await db.exec("RESET ROLE");
        await superQ("DELETE FROM public.user_roles WHERE user_id = $1", [U.trustInA]);
        await superQ("UPDATE auth.users SET banned_until = now() + interval '100 years' WHERE id = $1", [U.trustB]);
        await superQ("DELETE FROM public.user_roles WHERE user_id = $1", [U.trustA]);
      }),
    ).rejects.toThrow(/LAST_TRUST_ADMIN/);
  });
  it("a soft-deleted account does not count either; cascade delete is guarded", async () => {
    await expect(
      as(null, async () => {
        await db.exec("RESET ROLE");
        await superQ("DELETE FROM public.user_roles WHERE user_id = $1", [U.trustInA]);
        await superQ("UPDATE auth.users SET deleted_at = now() WHERE id = $1", [U.trustB]);
        await superQ("DELETE FROM auth.users WHERE id = $1", [U.trustA]);
      }),
    ).rejects.toThrow(/LAST_TRUST_ADMIN/);
  });
});
