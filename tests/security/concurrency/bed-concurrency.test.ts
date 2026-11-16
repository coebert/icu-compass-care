// Genuine two-session races for the STAGED bed-integrity / bridge-import SQL,
// on a throwaway local PostgreSQL (started by run.sh). Own database so it
// never shares state with the admin concurrency tests. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const URL_ = process.env["CONCURRENCY_PG_URL"];
const d = URL_ ? describe : describe.skip;
const ROOT = join(__dirname, "../../..");
const DB = "bed_concurrency";

const C1 = "00000000-0000-4000-8000-00000000cc01";
const C2 = "00000000-0000-4000-8000-00000000cc02";
const UNIT = "10000000-0000-4000-8000-0000000000aa";
const P1 = "20000000-0000-4000-8000-0000000000a1"; // bed 1
const P2 = "20000000-0000-4000-8000-0000000000a2"; // bed 2
const P3 = "20000000-0000-4000-8000-0000000000a3"; // unassigned
const P4 = "20000000-0000-4000-8000-0000000000a4"; // unassigned
const PS = "20000000-0000-4000-8000-0000000000a5"; // shared
const sid = (u: string) => u.replace(/^0/, "5");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(database: string) {
  const [host, port] = URL_!.split(":");
  return postgres({ host, port: Number(port), user: "postgres", database, max: 1, onnotice: () => {} });
}

let admin: ReturnType<typeof postgres>;
let a: ReturnType<typeof postgres>;
let b: ReturnType<typeof postgres>;

async function asUser(tx: postgres.TransactionSql, user: string) {
  await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: "authenticated", session_id: sid(user) })}, true)`;
  await tx.unsafe("SET LOCAL ROLE authenticated");
}
async function rev(id: string): Promise<string> {
  const r = await admin`SELECT updated_at::text AS u FROM public.patients WHERE id = ${id}`;
  return r[0]!.u as string;
}
const mv = (id: string, expected: string, bed: string) =>
  JSON.stringify([{ id, expected_updated_at: expected, location_type: "icu", bed }]);
const outcome = (p: Promise<unknown>) =>
  p.then(
    () => "ok",
    (e: Error) => e.message,
  );

d("bed moves under real concurrency", () => {
  beforeAll(async () => {
    const root = connect("postgres");
    await root.unsafe(`DROP DATABASE IF EXISTS ${DB}`);
    await root.unsafe(`CREATE DATABASE ${DB}`);
    await root.end();
    admin = connect(DB);
    a = connect(DB);
    b = connect(DB);
    await admin.unsafe(readFileSync(join(__dirname, "../sql/fixture.sql"), "utf8"));
    for (const id of [C1, C2]) {
      await admin`INSERT INTO auth.users (id, email) VALUES (${id}, ${id.slice(-4) + "@example.test"})`;
      await admin`INSERT INTO auth.sessions (id, user_id) VALUES (${sid(id)}, ${id})`;
    }
    await admin`INSERT INTO public.icu_units (id, name, code) VALUES (${UNIT}, 'U', 'SDH-RADNOR')`;
    await admin`INSERT INTO public.user_roles (user_id, role) VALUES (${C1},'clinician'), (${C2},'clinician')`;
    await admin`INSERT INTO public.user_unit_access (user_id, unit_id) VALUES (${C1}, ${UNIT}), (${C2}, ${UNIT})`;
    const dir = join(ROOT, "drizzle/migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql") && x.includes("security_remediation")).sort())
      await admin.unsafe(readFileSync(join(dir, f), "utf8"));
    await admin.unsafe(readFileSync(join(__dirname, "../sql/bed-bridge-fixture.sql"), "utf8"));
    for (let i = 1; i <= 6; i++) await admin`INSERT INTO public.icu_beds (label, position) VALUES (${String(i)}, ${i})`;
    await admin`INSERT INTO public.patients (id, unit_id, full_name, bed, shared_with_partner) VALUES
      (${P1}, ${UNIT}, 'A.A.', '1', false), (${P2}, ${UNIT}, 'B.B.', '2', false),
      (${P3}, ${UNIT}, 'C.C.', NULL, false), (${P4}, ${UNIT}, 'D.D.', NULL, false),
      (${PS}, ${UNIT}, 'E.E.', NULL, true)`;
    await admin.unsafe(readFileSync(join(ROOT, "docs/security/staged-migrations/0005_bed_integrity_and_bridge_import.sql"), "utf8"));
  }, 120_000);
  afterAll(async () => {
    await Promise.all([admin?.end(), a?.end(), b?.end()]);
  });

  it("two clinicians moving different patients into the same free bed: exactly one wins", async () => {
    const [r3, r4] = [await rev(P3), await rev(P4)];
    const first = outcome(
      a.begin(async (tx) => {
        await asUser(tx, C1);
        await tx.unsafe(`SELECT public.move_patient_beds('${mv(P3, r3, "5")}'::jsonb)`);
        await sleep(400); // hold the uncommitted bed while the other arrives
      }),
    );
    await sleep(100);
    const second = outcome(
      b.begin(async (tx) => {
        await asUser(tx, C2);
        await tx.unsafe(`SELECT public.move_patient_beds('${mv(P4, r4, "5")}'::jsonb)`);
      }),
    );
    const results = [await first, await second].sort();
    expect(results).toEqual(["bed_occupied", "ok"]);
    const n = await admin`SELECT count(*)::int AS n FROM public.patients WHERE upper(btrim(bed)) = '5'`;
    expect(n[0]!.n).toBe(1);
  });

  it("two opposite swaps at once: one succeeds, the other is a conflict, no deadlock", async () => {
    const [r1, r2] = [await rev(P1), await rev(P2)];
    const swap = JSON.stringify([
      { id: P1, expected_updated_at: r1, location_type: "icu", bed: "2" },
      { id: P2, expected_updated_at: r2, location_type: "icu", bed: "1" },
    ]);
    const reversed = JSON.stringify([
      { id: P2, expected_updated_at: r2, location_type: "icu", bed: "1" },
      { id: P1, expected_updated_at: r1, location_type: "icu", bed: "2" },
    ]);
    const first = outcome(
      a.begin(async (tx) => {
        await asUser(tx, C1);
        await tx.unsafe(`SELECT public.move_patient_beds('${swap}'::jsonb)`);
        await sleep(300);
      }),
    );
    await sleep(80);
    const second = outcome(
      b.begin(async (tx) => {
        await asUser(tx, C2);
        await tx.unsafe(`SELECT public.move_patient_beds('${reversed}'::jsonb)`);
      }),
    );
    expect([await first, await second].sort()).toEqual(["conflict", "ok"]);
    const r = await admin`SELECT id, bed FROM public.patients WHERE id IN (${P1}, ${P2}) ORDER BY id`;
    expect(r.map((x) => x.bed)).toEqual(["2", "1"]);
  });

  it("revoking sharing waits for an in-flight result import; a later import is refused", async () => {
    const rec = (id: string) =>
      JSON.stringify({ id, patient_id: PS, type: "Blood", findings: "Normal", result_at: "2026-03-01T09:00:00Z", created_at: "2026-03-01T09:00:00Z", updated_at: "2026-03-01T09:00:00Z" });
    const order: string[] = [];
    const imp = a.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE service_role");
      const r = await tx.unsafe(`SELECT public.bridge_import_result('investigations', '${rec("40000000-0000-4000-8000-0000000000b1")}'::jsonb, '${UNIT}') AS r`);
      order.push(`import:${r[0]!.r}`);
      await sleep(400);
      order.push("import:commit");
    });
    await sleep(100);
    const revoke = b.begin(async (tx) => {
      await tx`UPDATE public.patients SET shared_with_partner = false WHERE id = ${PS}`;
      order.push("revoke");
    });
    await Promise.all([imp, revoke]);
    expect(order).toEqual(["import:inserted", "import:commit", "revoke"]);
    const after = await a.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE service_role");
      return tx.unsafe(`SELECT public.bridge_import_result('investigations', '${rec("40000000-0000-4000-8000-0000000000b2")}'::jsonb, '${UNIT}') AS r`);
    });
    expect(after[0]!.r).toBe("parent_unavailable");
  });
});
