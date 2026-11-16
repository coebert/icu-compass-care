// Runs the STAGED (not applied) bed-integrity / bridge-import SQL against an
// in-memory Postgres (PGlite) with synthetic data only. Single connection:
// these tests prove the rules in serial order. Genuine two-session races are
// in tests/security/concurrency/bed-concurrency.test.ts (real Postgres).
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { normalizeBed } from "@/lib/icu-beds";

const ROOT = join(__dirname, "../..");
const MIG_DIR = join(ROOT, "drizzle/migrations");
const STAGED_DIR = join(ROOT, "docs/security/staged-migrations");
// Intended apply order. None of these is applied to the live database.
export const STAGED_FILES = [
  "0005_bed_integrity.sql",
  "0006_bridge_import_provenance.sql",
  "0007_bridge_wardable_fence.sql",
].map((f) => join(STAGED_DIR, f));
export const STAGED_SQL = STAGED_FILES[0]!;
export const stagedSql = (): string => STAGED_FILES.map((f) => readFileSync(f, "utf8")).join("\n;\n");

export function baseSql(): string {
  const mig = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql") && f.includes("security_remediation"))
    .sort()
    .map((f) => readFileSync(join(MIG_DIR, f), "utf8"))
    .join("\n;\n");
  return [
    readFileSync(join(__dirname, "sql/fixture.sql"), "utf8"),
    mig,
    readFileSync(join(__dirname, "sql/bed-bridge-fixture.sql"), "utf8"),
  ].join("\n;\n");
}

const U = {
  clinA: "00000000-0000-4000-8000-0000000000c1",
  clinB: "00000000-0000-4000-8000-0000000000c2",
  auditorA: "00000000-0000-4000-8000-0000000000d1",
  trust: "00000000-0000-4000-8000-0000000000a1",
};
const UNIT_A = "10000000-0000-4000-8000-000000000001";
const UNIT_B = "10000000-0000-4000-8000-000000000002";
const P = {
  a1: "20000000-0000-4000-8000-000000000001", // A, bed 1 (side room)
  a2: "20000000-0000-4000-8000-000000000002", // A, bed 3
  a3: "20000000-0000-4000-8000-000000000003", // A, unassigned
  iso: "20000000-0000-4000-8000-000000000004", // A, unassigned, needs isolation
  b1: "20000000-0000-4000-8000-000000000005", // B, bed 3 (same label, other unit)
  dis: "20000000-0000-4000-8000-000000000006", // A, discharged, bed 3 (inactive)
  sh: "20000000-0000-4000-8000-000000000007", // A, shared, unassigned
  shB: "20000000-0000-4000-8000-000000000008", // B, shared
};
const sid = (u: string) => u.replace(/^0/, "5");

type Q = { rows: Record<string, unknown>[] };
let db: PGlite;
const superQ = (sql: string, p?: unknown[]) => db.query(sql, p) as Promise<Q>;

async function as<T>(user: string | null, fn: (q: typeof superQ) => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try {
    if (user) {
      await db.query("SELECT set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: user, role: "authenticated", session_id: sid(user) }),
      ]);
      await db.exec("SET LOCAL ROLE authenticated");
    } else await db.exec("SET LOCAL ROLE anon");
    const out = await fn(superQ);
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}

async function rev(id: string): Promise<string> {
  const r = await superQ("SELECT updated_at::text AS u FROM public.patients WHERE id=$1", [id]);
  return r.rows[0]!.u as string;
}
async function bed(id: string) {
  const r = await superQ("SELECT bed, location_type::text AS loc FROM public.patients WHERE id=$1", [id]);
  return r.rows[0] as { bed: string | null; loc: string };
}
type Move = { id: string; expected_updated_at: string; location_type: "icu" | "outlier"; bed: string | null };
const move = (user: string, moves: Move[]) =>
  as(user, (q) => q("SELECT public.move_patient_beds($1::jsonb) AS r", [JSON.stringify(moves)]));
async function moveErr(user: string, moves: Move[]): Promise<string> {
  try {
    await move(user, moves);
  } catch (e) {
    return (e as Error).message;
  }
  return "no error";
}

async function seed(d: PGlite) {
  const q = (sql: string, p?: unknown[]) => d.query(sql, p);
  for (const id of Object.values(U)) {
    await q("INSERT INTO auth.users (id, email) VALUES ($1,$2)", [id, `${id.slice(-3)}@example.test`]);
    await q("INSERT INTO auth.sessions (id, user_id) VALUES ($1,$2)", [sid(id), id]);
  }
  await q("INSERT INTO public.icu_units (id, name, code) VALUES ($1,'Unit A','SDH-RADNOR'), ($2,'Unit B','B')", [UNIT_A, UNIT_B]);
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(baseSql());
  await seed(db);
  for (const [u, r] of [[U.clinA, "clinician"], [U.clinB, "clinician"], [U.auditorA, "auditor"], [U.trust, "trust_admin"]])
    await superQ("INSERT INTO public.user_roles (user_id, role) VALUES ($1,$2)", [u, r]);
  for (const [u, unit] of [[U.clinA, UNIT_A], [U.clinB, UNIT_B], [U.auditorA, UNIT_A]])
    await superQ("INSERT INTO public.user_unit_access (user_id, unit_id) VALUES ($1,$2)", [u, unit]);
  for (let i = 1; i <= 6; i++)
    await superQ("INSERT INTO public.icu_beds (label, position, is_side_room) VALUES ($1,$2,$3)", [String(i), i, i <= 2]);
  const rows: Array<[string, string, string | null, string, boolean, boolean]> = [
    [P.a1, UNIT_A, "1", "admitted", false, false],
    [P.a2, UNIT_A, "3", "admitted", false, false],
    [P.a3, UNIT_A, null, "admitted", false, false],
    [P.iso, UNIT_A, null, "admitted", true, false],
    [P.b1, UNIT_B, "3", "admitted", false, false],
    [P.dis, UNIT_A, "3", "discharged", false, false],
    [P.sh, UNIT_A, null, "admitted", false, true],
    [P.shB, UNIT_B, null, "admitted", false, true],
  ];
  for (const [id, unit, b, st, iso, sh] of rows)
    await superQ(
      "INSERT INTO public.patients (id, unit_id, full_name, bed, status, isolation_required, shared_with_partner) VALUES ($1,$2,'X.X.',$3,$4::public.patient_status,$5,$6)",
      [id, unit, b, st, iso, sh],
    );
  await db.exec(stagedSql());
}, 60_000);

describe("staged migration preflight", () => {
  it("aborts without changing anything when an active bed is already double-booked", async () => {
    const d = new PGlite();
    await d.exec(baseSql());
    await seed(d);
    await d.query(
      `INSERT INTO public.patients (unit_id, full_name, bed) VALUES ($1,'A.A.','3'), ($1,'B.B.',' 3 ')`,
      [UNIT_A],
    );
    await expect(d.exec(readFileSync(STAGED_SQL, "utf8"))).rejects.toThrow(/bed preflight failed: 1 duplicate/);
    const idx = await d.query("SELECT 1 FROM pg_indexes WHERE indexname='patients_active_unit_bed_uniq'");
    expect(idx.rows).toHaveLength(0);
    const n = await d.query<{ n: number }>("SELECT count(*)::int AS n FROM public.patients");
    expect(n.rows[0]!.n).toBe(2);
    await d.close();
  }, 60_000);
});

describe("bed normalisation matches the app", () => {
  it.each([" 3 ", "\t3\n", "\u00a03\u3000", "b3", "Bed 3", "03", "sr1 ", "", "\ufeffx\u2028"])(
    "%j",
    async (s) => {
      const r = await superQ("SELECT private.normalize_bed($1) AS k", [s]);
      expect(r.rows[0]!.k).toBe(normalizeBed(s));
    },
  );
  it("null is blank, like the app", async () => {
    const r = await superQ("SELECT private.normalize_bed(NULL) AS k");
    expect(r.rows[0]!.k).toBe(normalizeBed(null));
  });
});

describe("one active patient per bed per unit, on every write path", () => {
  it("direct write into an occupied bed (different spacing/case) is refused", async () => {
    await superQ("UPDATE public.icu_beds SET label='B1' WHERE label='6'");
    await superQ("UPDATE public.patients SET bed='b1 ' WHERE id=$1", [P.a3]);
    await expect(superQ("UPDATE public.patients SET bed=' B1' WHERE id=$1", [P.sh])).rejects.toThrow(/unique/);
    await superQ("UPDATE public.patients SET bed=NULL WHERE id=$1", [P.a3]);
    await superQ("UPDATE public.icu_beds SET label='6' WHERE label='B1'");
  });
  it("direct API write as a clinician is refused the same way", async () => {
    await expect(as(U.clinA, (q) => q("UPDATE public.patients SET bed='3' WHERE id=$1", [P.a3]))).rejects.toThrow(/unique/);
  });
  it("the same label in another unit, and inactive records, don't collide", async () => {
    expect((await bed(P.b1)).bed).toBe("3");
    expect((await bed(P.dis)).bed).toBe("3");
    expect((await bed(P.a2)).bed).toBe("3");
  });
});

describe("move_patient_beds", () => {
  it("moves into a free bed and returns the new revision", async () => {
    const r = await move(U.clinA, [{ id: P.a3, expected_updated_at: await rev(P.a3), location_type: "icu", bed: "4" }]);
    const out = (r.rows[0]!.r as Array<Record<string, unknown>>)[0]!;
    expect(out).toMatchObject({ id: P.a3, bed: "4", previous_bed: null });
    expect((await bed(P.a3)).bed).toBe("4");
  });
  it("refuses a stale revision and changes nothing", async () => {
    expect(await moveErr(U.clinA, [{ id: P.a3, expected_updated_at: "2000-01-01T00:00:00Z", location_type: "icu", bed: "5" }])).toBe("conflict");
    expect((await bed(P.a3)).bed).toBe("4");
  });
  it("refuses an occupied bed, an unknown bed, and isolation outside a side room", async () => {
    expect(await moveErr(U.clinA, [{ id: P.a3, expected_updated_at: await rev(P.a3), location_type: "icu", bed: " 1" }])).toBe("bed_occupied");
    expect(await moveErr(U.clinA, [{ id: P.a3, expected_updated_at: await rev(P.a3), location_type: "icu", bed: "99" }])).toBe("unknown_bed");
    expect(await moveErr(U.clinA, [{ id: P.iso, expected_updated_at: await rev(P.iso), location_type: "icu", bed: "5" }])).toBe("isolation_side_room_only");
  });
  it("swaps two beds atomically", async () => {
    await move(U.clinA, [
      { id: P.a1, expected_updated_at: await rev(P.a1), location_type: "icu", bed: "3" },
      { id: P.a2, expected_updated_at: await rev(P.a2), location_type: "icu", bed: "1" },
    ]);
    expect((await bed(P.a1)).bed).toBe("3");
    expect((await bed(P.a2)).bed).toBe("1");
  });
  it("rolls back the whole swap when the second half fails", async () => {
    await superQ(`CREATE FUNCTION public.t_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id = '${P.a1}' AND NEW.bed IS NOT NULL THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$`);
    await superQ("CREATE TRIGGER t_fail BEFORE UPDATE ON public.patients FOR EACH ROW EXECUTE FUNCTION public.t_fail()");
    try {
      // a1 is cleared first, a2 reassigned, then a1's assignment fails.
      expect(
        await moveErr(U.clinA, [
          { id: P.a1, expected_updated_at: await rev(P.a1), location_type: "icu", bed: "1" },
          { id: P.a2, expected_updated_at: await rev(P.a2), location_type: "icu", bed: "3" },
        ]),
      ).toBe("injected");
    } finally {
      await superQ("DROP TRIGGER t_fail ON public.patients");
      await superQ("DROP FUNCTION public.t_fail()");
    }
    expect((await bed(P.a1)).bed).toBe("3");
    expect((await bed(P.a2)).bed).toBe("1");
  });
  it("a swap with one stale revision changes neither patient", async () => {
    expect(
      await moveErr(U.clinA, [
        { id: P.a1, expected_updated_at: await rev(P.a1), location_type: "icu", bed: "1" },
        { id: P.a2, expected_updated_at: "2000-01-01T00:00:00Z", location_type: "icu", bed: "3" },
      ]),
    ).toBe("conflict");
    expect((await bed(P.a1)).bed).toBe("3");
  });
  it("only an exact two-bed exchange counts as a swap", async () => {
    expect(
      await moveErr(U.clinA, [
        { id: P.a1, expected_updated_at: await rev(P.a1), location_type: "icu", bed: "5" },
        { id: P.a2, expected_updated_at: await rev(P.a2), location_type: "icu", bed: "3" },
      ]),
    ).toBe("not_a_swap");
  });
  it("undo is revision-checked: it never overwrites a later move", async () => {
    const r = await move(U.clinA, [{ id: P.a3, expected_updated_at: await rev(P.a3), location_type: "icu", bed: "5" }]);
    const after = (r.rows[0]!.r as Array<{ updated_at: string; previous_bed: string }>)[0]!;
    // Someone else moves the patient again before Undo is pressed.
    await move(U.clinA, [{ id: P.a3, expected_updated_at: await rev(P.a3), location_type: "icu", bed: "6" }]);
    expect(await moveErr(U.clinA, [{ id: P.a3, expected_updated_at: after.updated_at, location_type: "icu", bed: after.previous_bed }])).toBe("conflict");
    expect((await bed(P.a3)).bed).toBe("6");
    // An undo against the current revision is fine.
    await move(U.clinA, [{ id: P.a3, expected_updated_at: await rev(P.a3), location_type: "icu", bed: "5" }]);
    expect((await bed(P.a3)).bed).toBe("5");
  });
  it("other-unit staff, auditors and signed-out callers can't move anyone", async () => {
    const m: Move = { id: P.a3, expected_updated_at: await rev(P.a3), location_type: "icu", bed: "4" };
    expect(await moveErr(U.clinB, [m])).toBe("not_found");
    expect(await moveErr(U.auditorA, [m])).toBe("not_found");
    await expect(as(null, (q) => q("SELECT public.move_patient_beds($1::jsonb)", [JSON.stringify([m])]))).rejects.toThrow(/permission denied/);
  });
  it("a locked session can't move anyone", async () => {
    await superQ("INSERT INTO public.session_guard (session_id, user_id, locked_at) VALUES ($1,$2,now())", [sid(U.clinA), U.clinA]);
    try {
      expect(await moveErr(U.clinA, [{ id: P.a3, expected_updated_at: await rev(P.a3), location_type: "icu", bed: "4" }])).toBe("not_authorised");
    } finally {
      await superQ("DELETE FROM public.session_guard WHERE session_id=$1", [sid(U.clinA)]);
    }
  });
  it("can't swap across units, even for a Trust administrator", async () => {
    expect(
      await moveErr(U.trust, [
        { id: P.a2, expected_updated_at: await rev(P.a2), location_type: "icu", bed: "3" },
        { id: P.b1, expected_updated_at: await rev(P.b1), location_type: "icu", bed: "1" },
      ]),
    ).toBe("invalid_request");
  });
  it("rejects malformed requests before touching anything", async () => {
    for (const bad of ["[]", "{}", '[{"id":"x"}]', `[{"id":"${P.a3}","expected_updated_at":"nope","location_type":"icu","bed":"4"}]`]) {
      await expect(as(U.clinA, (q) => q("SELECT public.move_patient_beds($1::jsonb)", [bad]))).rejects.toThrow(/invalid_request/);
    }
  });
});

// ---------------------------------------------------------------------------
// Audit inside the move transaction (0005)
// ---------------------------------------------------------------------------
async function auditRows(id: string) {
  const r = await superQ(
    "SELECT changed_fields, before, after, actor_id::text AS actor FROM public.record_audit WHERE record_id=$1 AND source='app' ORDER BY created_at, id",
    [id],
  );
  return r.rows as Array<{ changed_fields: string[]; before: Record<string, unknown>; after: Record<string, unknown>; actor: string }>;
}
async function fieldRows(id: string) {
  const r = await superQ(
    "SELECT field_name, old_value, new_value FROM public.patient_field_changes WHERE patient_id=$1 ORDER BY changed_at, id",
    [id],
  );
  return r.rows as Array<{ field_name: string; old_value: string | null; new_value: string | null }>;
}
async function failAuditInserts<T>(fn: () => Promise<T>, table = "record_audit"): Promise<T> {
  await superQ(`CREATE OR REPLACE FUNCTION public.t_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'audit_injected'; END $$`);
  await superQ(`CREATE TRIGGER t_fail_audit BEFORE INSERT ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.t_fail_audit()`);
  try {
    return await fn();
  } finally {
    await superQ(`DROP TRIGGER t_fail_audit ON public.${table}`);
  }
}

describe("bed moves are audited in the same transaction", () => {
  it("a swap records each patient's final position only, with the caller as actor", async () => {
    const before1 = (await bed(P.a1)).bed;
    const before2 = (await bed(P.a2)).bed;
    const n1 = (await auditRows(P.a1)).length;
    await move(U.clinA, [
      { id: P.a1, expected_updated_at: await rev(P.a1), location_type: "icu", bed: before2 },
      { id: P.a2, expected_updated_at: await rev(P.a2), location_type: "icu", bed: before1 },
    ]);
    const a = (await auditRows(P.a1)).slice(n1);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ changed_fields: ["bed"], actor: U.clinA });
    expect(a[0]!.before.bed).toBe(before1);
    expect(a[0]!.after).toMatchObject({ bed: before2, operation: "swap" });
    const f = (await fieldRows(P.a1)).filter((r) => r.field_name === "bed");
    // Never the transient cleared bed.
    expect(f.at(-1)).toMatchObject({ old_value: before1, new_value: before2 });
    expect(f.some((r) => r.new_value === null)).toBe(false);
  });
  it("if the audit write fails, the whole swap rolls back", async () => {
    const b1 = (await bed(P.a1)).bed;
    const b2 = (await bed(P.a2)).bed;
    const r1 = await rev(P.a1);
    const r2 = await rev(P.a2);
    const err = await failAuditInserts(() =>
      moveErr(U.clinA, [
        { id: P.a1, expected_updated_at: r1, location_type: "icu", bed: b2 },
        { id: P.a2, expected_updated_at: r2, location_type: "icu", bed: b1 },
      ]),
    );
    expect(err).toBe("audit_injected");
    expect((await bed(P.a1)).bed).toBe(b1);
    expect((await bed(P.a2)).bed).toBe(b2);
    expect(await rev(P.a1)).toBe(r1);
  });
  it("a field-history failure also rolls back a single move", async () => {
    const r = await rev(P.a3);
    const b = (await bed(P.a3)).bed;
    const err = await failAuditInserts(
      () => moveErr(U.clinA, [{ id: P.a3, expected_updated_at: r, location_type: "icu", bed: "4" }]),
      "patient_field_changes",
    );
    expect(err).toBe("audit_injected");
    expect((await bed(P.a3)).bed).toBe(b);
  });
});

describe("function permissions on a fresh schema", () => {
  it.each([
    ["public.move_patient_beds(jsonb)", "anon", false],
    ["public.move_patient_beds(jsonb)", "authenticated", true],
    ["public.bridge_import_referral(jsonb)", "authenticated", false],
    ["public.bridge_import_referral(jsonb)", "anon", false],
    ["public.bridge_import_referral(jsonb)", "service_role", true],
    ["public.bridge_import_result(text,jsonb)", "authenticated", false],
    ["public.bridge_import_result(text,jsonb)", "service_role", true],
    ["public.bridge_insert_investigation(uuid,text,text,timestamptz)", "anon", false],
    ["public.bridge_insert_investigation(uuid,text,text,timestamptz)", "authenticated", false],
    ["public.bridge_insert_investigation(uuid,text,text,timestamptz)", "service_role", true],
    ["public.bridge_set_wardable(uuid,timestamptz,boolean,text,jsonb)", "anon", false],
    ["public.bridge_set_wardable(uuid,timestamptz,boolean,text,jsonb)", "authenticated", false],
    ["public.bridge_set_wardable(uuid,timestamptz,boolean,text,jsonb)", "service_role", true],
    ["private.bridge_unit_id()", "authenticated", false],
    ["private.bridge_unit_id()", "anon", false],
  ] as const)("%s for %s = %s", async (fn, role, ok) => {
    const r = await superQ("SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok", [role, fn]);
    expect(r.rows[0]!.ok).toBe(ok);
  });
  it.each(["private.bridge_referral_provenance", "private.bridge_wardable_fence"])(
    "%s has no table access for app roles",
    async (t) => {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const r = await superQ("SELECT has_table_privilege($1, $2, 'SELECT,INSERT,UPDATE,DELETE') AS ok", [role, t]);
        expect(r.rows[0]!.ok).toBe(false);
      }
    },
  );
  it("helpers run with an empty search_path", async () => {
    const r = await superQ(
      `SELECT p.proname, p.proconfig FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE p.proname IN ('bridge_import_referral','bridge_import_result','bridge_insert_investigation','bridge_set_wardable','bridge_unit_id')`,
    );
    expect(r.rows).toHaveLength(5);
    for (const row of r.rows) expect(row.proconfig).toEqual(['search_path=""']);
  });
});

// ---------------------------------------------------------------------------
// Referral import with provenance (0006)
// ---------------------------------------------------------------------------
const refId = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const REF = refId(1);
const refRec = (over: Record<string, unknown> = {}) => ({
  id: REF,
  created_at: "2026-03-01T10:00:00.000001Z",
  updated_at: "2026-03-01T10:05:00.123456Z",
  deleted_at: null,
  status: "pending",
  referral_received_at: "2026-03-01T10:00:00Z",
  age: 70,
  sex: "female",
  current_ward: "W1",
  current_bed: "B2",
  referring_specialty: "Medicine",
  reason_category: "sepsis",
  ceiling_of_care: "full_escalation",
  resus_status: "for_cpr",
  dnacpr_respect: false,
  anticipated_interventions: ["niv"],
  allergies: null,
  weight_kg: 60,
  admission_urgency: null,
  infection_status: null,
  news2_score: 5,
  ...over,
});
const tomb = (id: string, at: string) => ({ id, updated_at: at, deleted_at: at });
async function asService<T>(fn: () => Promise<T>): Promise<T> {
  await db.exec("SET ROLE service_role");
  try {
    return await fn();
  } finally {
    await db.exec("RESET ROLE");
  }
}
const importReferral = (rec: object) =>
  asService(async () => (await superQ("SELECT public.bridge_import_referral($1::jsonb) AS r", [JSON.stringify(rec)])).rows[0]!.r as string);
async function localRef(id = REF) {
  const r = await superQ(
    "SELECT updated_at::text AS u, deleted_at, status::text, current_ward, hospital_number_enc, hospital_number_hash, created_by, origin_booking_id, previous_referral_id FROM public.referrals WHERE id=$1",
    [id],
  );
  return r.rows[0] as Record<string, unknown> | undefined;
}
async function prov(id = REF) {
  const r = await superQ(
    "SELECT source_revision::text AS s, receiver_revision::text AS r, source_deleted_at FROM private.bridge_referral_provenance WHERE referral_id=$1",
    [id],
  );
  return r.rows[0] as { s: string; r: string; source_deleted_at: unknown } | undefined;
}
const refAudits = async (id: string) =>
  (await superQ("SELECT count(*)::int AS n FROM public.record_audit WHERE record_id=$1 AND source='bridge'", [id])).rows[0]!.n as number;

describe("bridge_import_referral — provenance and ownership", () => {
  it("inserts allowlisted fields only; source and receiver revisions are kept separately", async () => {
    const rec = {
      ...refRec(),
      hospital_number_enc: "x",
      hospital_number_hash: "h",
      created_by: U.clinA,
      origin_booking_id: P.a1,
      previous_referral_id: REF,
    };
    expect(await importReferral(rec)).toBe("inserted");
    const l = (await localRef())!;
    expect(l).toMatchObject({ hospital_number_enc: null, hospital_number_hash: null, created_by: null, origin_booking_id: null, previous_referral_id: null });
    const p = (await prov())!;
    expect(p.s).toBe("2026-03-01 10:05:00.123456+00");
    // The receiver revision is OUR row's normal timestamp, not the source's.
    expect(p.r).toBe(l.u);
    expect(l.u).not.toBe(p.s);
    expect(await refAudits(REF)).toBe(1);
  });
  it("replays and older source revisions are no-ops", async () => {
    const before = await localRef();
    expect(await importReferral(refRec({ status: "declined" }))).toBe("unchanged");
    expect(await importReferral(refRec({ updated_at: "2026-03-01T00:00:00Z", status: "declined" }))).toBe("unchanged");
    expect(await localRef()).toEqual(before);
    expect(await refAudits(REF)).toBe(1);
  });
  it("a newer revision with identical content records the source revision only", async () => {
    const before = await localRef();
    expect(await importReferral(refRec({ updated_at: "2026-03-01T11:00:00Z" }))).toBe("unchanged");
    expect(await localRef()).toEqual(before);
    expect((await prov())!.s).toBe("2026-03-01 11:00:00+00");
  });
  it("a newer source revision updates, and the provenance follows our new row version", async () => {
    expect(await importReferral(refRec({ updated_at: "2026-03-02T08:00:00.000007Z", status: "admitted" }))).toBe("updated");
    const l = (await localRef())!;
    expect(l.status).toBe("admitted");
    expect((await prov())!).toMatchObject({ s: "2026-03-02 08:00:00.000007+00", r: l.u });
    expect(await refAudits(REF)).toBe(2);
  });
  it("a minimal tombstone marks the imported row deleted and keeps every other field", async () => {
    expect(await importReferral(tomb(REF, "2026-03-03T00:00:00Z"))).toBe("deleted");
    const l = (await localRef())!;
    expect(l.deleted_at).not.toBeNull();
    expect(l).toMatchObject({ status: "admitted", current_ward: "W1" });
    expect(await importReferral(tomb(REF, "2026-03-03T00:00:00Z"))).toBe("unchanged");
  });
  it("a newer live row restores it", async () => {
    expect(await importReferral(refRec({ updated_at: "2026-03-04T00:00:00Z", status: "admitted" }))).toBe("restored");
    expect((await localRef())!.deleted_at).toBeNull();
  });
  it("a local edit since our last import is never overwritten — conflict, even for a tombstone", async () => {
    await superQ("UPDATE public.referrals SET current_ward='LOCAL' WHERE id=$1", [REF]);
    const before = await localRef();
    expect(await importReferral(refRec({ updated_at: "2026-03-05T00:00:00Z", current_ward: "SRC" }))).toBe("conflict");
    expect(await importReferral(tomb(REF, "2026-03-05T00:00:01Z"))).toBe("conflict");
    expect(await localRef()).toEqual(before);
    expect((await prov())!.s).toBe("2026-03-04 00:00:00+00");
  });
  it("an unknown tombstone is a no-op, never a blank insert", async () => {
    const id = refId(2);
    expect(await importReferral(tomb(id, "2026-03-05T00:00:00Z"))).toBe("unknown_tombstone");
    expect(await localRef(id)).toBeUndefined();
    expect(await prov(id)).toBeUndefined();
  });
  it("a legacy or locally created row without provenance is a conflict, never adopted", async () => {
    const id = refId(3);
    await superQ("INSERT INTO public.referrals (id, status, current_ward) VALUES ($1,'pending','LEGACY')", [id]);
    const before = await localRef(id);
    expect(await importReferral(refRec({ id, updated_at: "2099-01-01T00:00:00Z" }))).toBe("conflict");
    expect(await importReferral(tomb(id, "2099-01-01T00:00:00Z"))).toBe("conflict");
    expect(await localRef(id)).toEqual(before);
    expect(await prov(id)).toBeUndefined();
  });
  it("rejects malformed or mixed shapes before touching anything", async () => {
    const id = refId(4);
    const bad: object[] = [
      { ...tomb(id, "2026-03-05T00:00:00Z"), status: "pending" }, // tombstone with live data
      (({ deleted_at: _d, ...r }) => r)(refRec({ id })), // live row without deleted_at
      (({ status: _s, ...r }) => r)(refRec({ id })), // missing key
      refRec({ id, status: "nonsense" }),
      refRec({ id, updated_at: "yesterday" }),
      refRec({ id: "not-a-uuid" }),
      refRec({ id, anticipated_interventions: "niv" }),
      { id, updated_at: "2026-03-05T00:00:00Z", deleted_at: null },
    ];
    for (const [i, b] of bad.entries())
      await expect(importReferral(b), `case ${i}`).rejects.toThrow(/invalid_record/);
    expect(await localRef(id)).toBeUndefined();
  });
  it("audit failure rolls back the content and the provenance", async () => {
    const id = refId(5);
    await expect(failAuditInserts(() => importReferral(refRec({ id })))).rejects.toThrow(/audit_injected/);
    expect(await localRef(id)).toBeUndefined();
    expect(await prov(id)).toBeUndefined();
    expect(await importReferral(refRec({ id }))).toBe("inserted");
    const p1 = await prov(id);
    await expect(
      failAuditInserts(() => importReferral(refRec({ id, updated_at: "2026-04-01T00:00:00Z", status: "admitted" }))),
    ).rejects.toThrow(/audit_injected/);
    expect((await localRef(id))!.status).toBe("pending");
    expect(await prov(id)).toEqual(p1);
  });
  it("ordinary referral and patient edits keep their normal timestamps", async () => {
    await superQ("UPDATE public.referrals SET current_ward='W2', updated_at='2000-01-01' WHERE id=$1", [REF]);
    expect(((await localRef())!.u as string) > "2026").toBe(true);
    await superQ("UPDATE public.patients SET updated_at='2000-01-01' WHERE id=$1", [P.dis]);
    expect((await rev(P.dis)) > "2026").toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Result import and the existing partner insert helper (0006)
// ---------------------------------------------------------------------------
const RES = "40000000-0000-4000-8000-000000000001";
const importResult = (kind: string, rec: object) =>
  asService(async () => (await superQ("SELECT public.bridge_import_result($1, $2::jsonb) AS r", [kind, JSON.stringify(rec)])).rows[0]!.r as string);
const res = (over: Record<string, unknown> = {}) => ({
  id: RES,
  patient_id: P.sh,
  type: "Blood",
  findings: "Normal",
  result_at: "2026-03-01T09:00:00Z",
  created_at: "2026-03-01T09:10:00.000001Z",
  updated_at: "2026-03-01T09:10:00.000002Z",
  ...over,
});
const patientCount = async () => (await superQ("SELECT count(*)::int AS n FROM public.patients")).rows[0]!.n as number;

describe("bridge_import_result", () => {
  it("inserts a new result for an existing shared patient in the bridge unit (unit resolved inside)", async () => {
    expect(await importResult("investigations", res())).toBe("inserted");
    const r = await superQ("SELECT category, updated_at::text AS u FROM public.investigations WHERE id=$1", [RES]);
    expect(r.rows[0]).toMatchObject({ category: "Blood", u: "2026-03-01 09:10:00.000002+00" });
    expect(await refAudits(RES)).toBe(1);
  });
  it("identical repeat is a no-op; divergent content is a conflict and never overwrites", async () => {
    expect(await importResult("investigations", res())).toBe("identical");
    expect(await importResult("investigations", res({ findings: "Changed" }))).toBe("conflict");
    const r = await superQ("SELECT findings FROM public.investigations WHERE id=$1", [RES]);
    expect(r.rows[0]!.findings).toBe("Normal");
    expect(await refAudits(RES)).toBe(1);
  });
  it("withheld, other-unit and unknown patients are never linked or created", async () => {
    const n = await patientCount();
    const id = "40000000-0000-4000-8000-000000000002";
    expect(await importResult("investigations", res({ id, patient_id: P.a3 }))).toBe("parent_unavailable");
    expect(await importResult("investigations", res({ id, patient_id: P.shB }))).toBe("parent_unavailable");
    expect(await importResult("investigations", res({ id, patient_id: "20000000-0000-4000-8000-0000000000ff" }))).toBe("parent_unavailable");
    expect(await patientCount()).toBe(n);
  });
  it("microbiology maps type to specimen_type", async () => {
    const id = "40000000-0000-4000-8000-000000000003";
    expect(await importResult("microbiology", res({ id, type: "Urine" }))).toBe("inserted");
    const r = await superQ("SELECT specimen_type FROM public.microbiology_results WHERE id=$1", [id]);
    expect(r.rows[0]!.specimen_type).toBe("Urine");
  });
  it("audit failure rolls the insert back", async () => {
    const id = "40000000-0000-4000-8000-000000000004";
    await expect(failAuditInserts(() => importResult("investigations", res({ id })))).rejects.toThrow(/audit_injected/);
    const r = await superQ("SELECT 1 FROM public.investigations WHERE id=$1", [id]);
    expect(r.rows).toHaveLength(0);
  });
  it("rejects malformed rows", async () => {
    await expect(importResult("investigations", res({ id: "nope" }))).rejects.toThrow(/invalid_record/);
    await expect(importResult("investigations", res({ id: "40000000-0000-4000-8000-000000000009", findings: " " }))).rejects.toThrow(/invalid_record/);
    await expect(importResult("audit", res({ id: "40000000-0000-4000-8000-000000000009" }))).rejects.toThrow(/invalid_record/);
  });
});

describe("bridge_insert_investigation (existing helper) is limited to shared patients in the bridge unit", () => {
  const ins = (pid: string) =>
    asService(async () =>
      (await superQ("SELECT id FROM public.bridge_insert_investigation($1::uuid, 'Gas', 'pH 7.4', NULL)", [pid])).rows,
    );
  it("shared patient in the bridge unit: inserted", async () => {
    expect(await ins(P.sh)).toHaveLength(1);
  });
  it("shared patient in another unit, withheld patient, unknown id: nothing", async () => {
    expect(await ins(P.shB)).toHaveLength(0);
    expect(await ins(P.a3)).toHaveLength(0);
    expect(await ins("20000000-0000-4000-8000-0000000000ff")).toHaveLength(0);
  });
  it("revoking sharing takes effect immediately", async () => {
    await superQ("UPDATE public.patients SET shared_with_partner=false WHERE id=$1", [P.sh]);
    try {
      expect(await ins(P.sh)).toHaveLength(0);
    } finally {
      await superQ("UPDATE public.patients SET shared_with_partner=true WHERE id=$1", [P.sh]);
    }
  });
  it("fails closed (PT503) when the bridge unit can't be resolved", async () => {
    await db.exec("BEGIN");
    try {
      await superQ("UPDATE public.icu_units SET code='RENAMED' WHERE id=$1", [UNIT_A]);
      await db.exec("SET LOCAL ROLE service_role");
      await expect(superQ("SELECT * FROM public.bridge_insert_investigation($1::uuid, 'Gas', 'x', NULL)", [P.sh])).rejects.toThrow(/bridge_unit_unavailable/);
    } finally {
      await db.exec("ROLLBACK");
    }
  });
});

// ---------------------------------------------------------------------------
// Fenced wardable updates (0007)
// ---------------------------------------------------------------------------
const PW = "20000000-0000-4000-8000-0000000000a9";
const ACTOR = { id: "60000000-0000-4000-8000-000000000001", email: "ccc-user@example.test", role: "clinician" };
type WOut = { ok: boolean; status?: string; code?: string; desired_revision?: string; patient?: Record<string, unknown> };
const setW = (pid: string, expected: string, wardable: boolean, revision: string, actor: object = ACTOR) =>
  asService(async () =>
    (await superQ(
      "SELECT public.bridge_set_wardable($1::uuid, $2::timestamptz, $3::boolean, $4::text, $5::jsonb) AS r",
      [pid, expected, wardable, revision, JSON.stringify(actor)],
    )).rows[0]!.r as WOut,
  );
async function wState(pid = PW) {
  const r = await superQ("SELECT wardable, wardable_at, wardable_by, updated_at::text AS u FROM public.patients WHERE id=$1", [pid]);
  return r.rows[0] as { wardable: boolean; wardable_at: unknown; wardable_by: unknown; u: string };
}
async function fence(pid = PW) {
  const r = await superQ(
    "SELECT highest_revision::text AS h, highest_wardable AS hw, applied_revision::text AS a, applied_wardable AS aw FROM private.bridge_wardable_fence WHERE patient_id=$1",
    [pid],
  );
  return r.rows[0] as { h: string; hw: boolean; a: string | null; aw: boolean | null } | undefined;
}
const wAudits = async () =>
  (await superQ("SELECT count(*)::int AS n FROM public.record_audit WHERE record_id=$1 AND source='bridge'", [PW])).rows[0]!.n as number;

describe("bridge_set_wardable — fenced, atomic", () => {
  beforeAll(async () => {
    await superQ(
      "INSERT INTO public.patients (id, unit_id, full_name, status, shared_with_partner) VALUES ($1,$2,'W.W.','admitted',true)",
      [PW, UNIT_A],
    );
  });
  it("unknown, withheld and other-unit patients get the same opaque not_found and no fence row", async () => {
    for (const pid of [P.a3, P.shB, "20000000-0000-4000-8000-0000000000ff"]) {
      expect(await setW(pid, "2026-01-01T00:00:00Z", true, "1")).toEqual({ ok: false, code: "not_found" });
      expect(await fence(pid)).toBeUndefined();
    }
  });
  it("applies a fresh intent, stamping the server clock, and audits it", async () => {
    const s0 = await wState();
    const out = await setW(PW, s0.u, true, "5");
    expect(out).toMatchObject({ ok: true, status: "applied", desired_revision: "5" });
    expect(Object.keys(out.patient!).sort()).toEqual(["id", "updated_at", "wardable", "wardable_at"]);
    const s1 = await wState();
    expect(s1.wardable).toBe(true);
    expect(s1.wardable_at).not.toBeNull();
    expect(s1.wardable_by).toBeNull();
    expect(await fence()).toEqual({ h: "5", hw: true, a: "5", aw: true });
    expect(await wAudits()).toBe(1);
  });
  it("a retry of the same intent is already_applied and changes nothing", async () => {
    const s = await wState();
    expect(await setW(PW, s.u, true, "5")).toMatchObject({ ok: true, status: "already_applied", desired_revision: "5" });
    expect(await wState()).toEqual(s);
    expect(await wAudits()).toBe(1);
  });
  it("same revision, different intent: intent_conflict; lower revision: superseded", async () => {
    const s = await wState();
    expect(await setW(PW, s.u, false, "5")).toEqual({ ok: false, code: "intent_conflict", desired_revision: "5" });
    expect(await setW(PW, s.u, false, "4")).toEqual({ ok: false, code: "superseded", desired_revision: "5" });
    expect(await wState()).toEqual(s);
  });
  it("a higher revision against a stale version reserves the revision persistently and reports revision_conflict", async () => {
    const s = await wState();
    expect(await setW(PW, "2000-01-01T00:00:00Z", false, "6")).toEqual({ ok: false, code: "revision_conflict", desired_revision: "6" });
    expect(await fence()).toEqual({ h: "6", hw: false, a: "5", aw: true });
    expect(await wState()).toEqual(s);
    // The reservation outlives the call: an older in-flight intent is now superseded.
    expect(await setW(PW, s.u, true, "5")).toMatchObject({ ok: false, code: "superseded", desired_revision: "6" });
    // Same pending revision, different intent: refused.
    expect(await setW(PW, s.u, true, "6")).toMatchObject({ ok: false, code: "intent_conflict" });
    // Same pending revision, same intent, still stale: refused again (no auto-rebase).
    expect(await setW(PW, "2000-01-01T00:00:00Z", false, "6")).toMatchObject({ ok: false, code: "revision_conflict" });
  });
  it("the pending intent applies only with an explicitly fresh version", async () => {
    const s = await wState();
    expect(await setW(PW, s.u, false, "6")).toMatchObject({ ok: true, status: "applied", desired_revision: "6" });
    const s1 = await wState();
    expect(s1.wardable).toBe(false);
    expect(s1.wardable_at).toBeNull();
    expect(await fence()).toEqual({ h: "6", hw: false, a: "6", aw: false });
  });
  it("a native change after an applied revision makes its retry target_changed, not already_applied", async () => {
    await superQ("UPDATE public.patients SET wardable=true WHERE id=$1", [PW]);
    const s = await wState();
    expect(await setW(PW, s.u, false, "6")).toEqual({ ok: false, code: "target_changed", desired_revision: "6" });
    expect((await wState()).wardable).toBe(true);
  });
  it("a higher revision that matches the current state still applies (no write) and fences out older intents", async () => {
    const s = await wState();
    const audits = await wAudits();
    expect(await setW(PW, s.u, true, "7")).toMatchObject({ ok: true, status: "applied", desired_revision: "7" });
    expect(await wState()).toEqual(s);
    expect(await wAudits()).toBe(audits);
    expect(await fence()).toEqual({ h: "7", hw: true, a: "7", aw: true });
    expect(await setW(PW, s.u, false, "6")).toMatchObject({ ok: false, code: "superseded" });
  });
  it("revisions beyond 2^53 are exact, up to the bigint maximum", async () => {
    const big = "9007199254740993"; // 2^53 + 1: not representable as a JS number
    let s = await wState();
    expect(await setW(PW, s.u, false, big)).toMatchObject({ ok: true, status: "applied", desired_revision: big });
    expect((await fence())!.h).toBe(big);
    // 2^53 + 2 would collide with 2^53 + 1 if parsed as a number; here it's strictly higher.
    s = await wState();
    expect(await setW(PW, s.u, true, "9007199254740994")).toMatchObject({ ok: true, desired_revision: "9007199254740994" });
    s = await wState();
    expect(await setW(PW, s.u, false, "9223372036854775807")).toMatchObject({ ok: true, desired_revision: "9223372036854775807" });
  });
  it("malformed revisions and actors are rejected (PT400) and change nothing", async () => {
    const s = await wState();
    const f = await fence();
    for (const r of ["9223372036854775808", "0", "01", "-1", "1e3", "1.0", " 1", "", "99999999999999999999"])
      await expect(setW(PW, s.u, true, r)).rejects.toThrow(/invalid_request/);
    await expect(setW(PW, s.u, true, "9", { role: "auditor" })).rejects.toThrow(/invalid_request/);
    expect(await fence()).toEqual(f);
    expect(await wState()).toEqual(s);
  });
  it("revoking sharing hides the patient and its fence", async () => {
    const p2 = "20000000-0000-4000-8000-0000000000aa";
    await superQ("INSERT INTO public.patients (id, unit_id, full_name, status, shared_with_partner) VALUES ($1,$2,'V.V.','admitted',true)", [p2, UNIT_A]);
    const s = await wState(p2);
    expect(await setW(p2, s.u, true, "3")).toMatchObject({ ok: true, status: "applied" });
    await superQ("UPDATE public.patients SET shared_with_partner=false WHERE id=$1", [p2]);
    const s2 = await wState(p2);
    expect(await setW(p2, s2.u, false, "4")).toEqual({ ok: false, code: "not_found" });
    expect(await fence(p2)).toEqual({ h: "3", hw: true, a: "3", aw: true });
    expect((await wState(p2)).wardable).toBe(true);
  });
  it("audit failure rolls back the state change and the reservation", async () => {
    const p3 = "20000000-0000-4000-8000-0000000000ab";
    await superQ("INSERT INTO public.patients (id, unit_id, full_name, status, shared_with_partner) VALUES ($1,$2,'U.U.','admitted',true)", [p3, UNIT_A]);
    const s = await wState(p3);
    await expect(failAuditInserts(() => setW(p3, s.u, true, "2"))).rejects.toThrow(/audit_injected/);
    expect(await wState(p3)).toEqual(s);
    expect(await fence(p3)).toBeUndefined();
    expect(await setW(p3, s.u, true, "2")).toMatchObject({ ok: true, status: "applied" });
  });
  it("the fence only moves forward and can't be removed, even by the owner", async () => {
    await expect(superQ("UPDATE private.bridge_wardable_fence SET highest_revision=1 WHERE patient_id=$1", [PW])).rejects.toThrow(/only move forward/);
    await expect(superQ("UPDATE private.bridge_wardable_fence SET applied_revision=NULL, applied_wardable=NULL WHERE patient_id=$1", [PW])).rejects.toThrow(/only move forward/);
    await expect(superQ("UPDATE private.bridge_wardable_fence SET highest_wardable = NOT highest_wardable WHERE patient_id=$1", [PW])).rejects.toThrow(/only move forward/);
    await expect(superQ("DELETE FROM private.bridge_wardable_fence WHERE patient_id=$1", [PW])).rejects.toThrow(/cannot be removed/);
    await expect(superQ("TRUNCATE private.bridge_wardable_fence")).rejects.toThrow(/cannot be removed/);
  });
});
