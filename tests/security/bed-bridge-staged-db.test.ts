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

