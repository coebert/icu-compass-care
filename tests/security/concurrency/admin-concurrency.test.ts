// Real concurrency tests: two independent connections to a throwaway local
// PostgreSQL server (started by run.sh). Skipped when no server is provided.
// Synthetic users only; never points at the live database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const URL_ = process.env["CONCURRENCY_PG_URL"];
const d = URL_ ? describe : describe.skip;

const T1 = "00000000-0000-4000-8000-00000000aa01";
const T2 = "00000000-0000-4000-8000-00000000aa02";
const UA = "00000000-0000-4000-8000-00000000bb01";
const C1 = "00000000-0000-4000-8000-00000000cc01";
const UNIT = "10000000-0000-4000-8000-0000000000aa";
const sid = (u: string) => u.replace(/^0/, "5");
const amr = () => [{ method: "password", timestamp: Math.floor(Date.now() / 1000) - 10 }];

let admin: ReturnType<typeof postgres>;
let a: ReturnType<typeof postgres>;
let b: ReturnType<typeof postgres>;

async function asUser(tx: postgres.TransactionSql, user: string) {
  await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: user, role: "authenticated", session_id: sid(user), amr: amr() })}, true)`;
  await tx.unsafe("SET LOCAL ROLE authenticated");
}
const rr = (target: string, roles: string) =>
  `SELECT public.admin_replace_user_roles('${target}', ARRAY[${roles}]::public.app_role[], 'concurrency test', 'role_changed')`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d("admin changes under real concurrency", () => {
  beforeAll(async () => {
    admin = postgres(URL_!, { max: 1, onnotice: () => {} });
    a = postgres(URL_!, { max: 1, onnotice: () => {} });
    b = postgres(URL_!, { max: 1, onnotice: () => {} });
    const dir = join(__dirname, "../../../drizzle/migrations");
    await admin.unsafe(readFileSync(join(__dirname, "../sql/fixture.sql"), "utf8"));
    for (const id of [T1, T2, UA, C1]) {
      await admin`INSERT INTO auth.users (id, email) VALUES (${id}, ${id.slice(-4) + "@example.test"})`;
      await admin`INSERT INTO auth.sessions (id, user_id) VALUES (${sid(id)}, ${id})`;
    }
    await admin`INSERT INTO public.icu_units (id, name, code) VALUES (${UNIT}, 'U', 'U')`;
    await admin`INSERT INTO public.user_roles (user_id, role) VALUES (${T1},'trust_admin'), (${T2},'trust_admin'), (${UA},'unit_admin'), (${C1},'clinician')`;
    await admin`INSERT INTO public.user_unit_access (user_id, unit_id) VALUES (${UA}, ${UNIT}), (${C1}, ${UNIT})`;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql") && x.includes("security_remediation")).sort()) {
      await admin.unsafe(readFileSync(join(dir, f), "utf8"));
    }
  }, 60_000);
  afterAll(async () => {
    await Promise.all([admin?.end(), a?.end(), b?.end()]);
  });

  it("two Trust admins demoting each other at once: exactly one succeeds, one enabled admin remains", async () => {
    const first = a.begin(async (tx) => {
      await asUser(tx, T1);
      await tx.unsafe(rr(T2, "'clinician'"));
      await sleep(400); // hold the lock while the other transaction arrives
    });
    await sleep(100);
    const second = b
      .begin(async (tx) => {
        await asUser(tx, T2);
        await tx.unsafe(rr(T1, "'clinician'"));
      })
      .then(() => "ok", (e: Error) => e.message);
    await first;
    const res = await second;
    expect(res).toMatch(/FORBIDDEN_TARGET|LAST_TRUST_ADMIN/);
    const left = await admin`SELECT user_id FROM public.user_roles WHERE role = 'trust_admin'`;
    expect(left.map((r) => r["user_id"])).toEqual([T1]);
  });

  it("a unit admin whose role is being revoked cannot act in the overlap window", async () => {
    const revoke = a.begin(async (tx) => {
      await asUser(tx, T1);
      await tx.unsafe(rr(UA, "'clinician'"));
      await sleep(400);
    });
    await sleep(100);
    const act = b
      .begin(async (tx) => {
        await asUser(tx, UA);
        await tx.unsafe(rr(C1, "'unit_admin'"));
      })
      .then(() => "ok", (e: Error) => e.message);
    await revoke;
    expect(await act).toMatch(/FORBIDDEN_TARGET/);
    const c1 = await admin`SELECT role FROM public.user_roles WHERE user_id = ${C1}`;
    expect(c1.map((r) => r["role"])).toEqual(["clinician"]);
  });
});
