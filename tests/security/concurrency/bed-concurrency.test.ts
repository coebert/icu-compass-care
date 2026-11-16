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
const PW = "20000000-0000-4000-8000-0000000000a6"; // shared, wardable races
const sid = (u: string) => u.replace(/^0/, "5");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function connect(database: string) {
  const [host, port] = URL_!.split(":");
  return postgres({
    host,
    port: Number(port),
    user: "postgres",
    database,
    max: 1,
    onnotice: () => {},
  });
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
    for (const f of readdirSync(dir)
      .filter((x) => x.endsWith(".sql") && x.includes("security_remediation"))
      .sort())
      await admin.unsafe(readFileSync(join(dir, f), "utf8"));
    await admin.unsafe(readFileSync(join(__dirname, "../sql/bed-bridge-fixture.sql"), "utf8"));
    for (let i = 1; i <= 6; i++)
      await admin`INSERT INTO public.icu_beds (label, position) VALUES (${String(i)}, ${i})`;
    await admin`INSERT INTO public.patients (id, unit_id, full_name, bed, shared_with_partner) VALUES
      (${P1}, ${UNIT}, 'A.A.', '1', false), (${P2}, ${UNIT}, 'B.B.', '2', false),
      (${P3}, ${UNIT}, 'C.C.', NULL, false), (${P4}, ${UNIT}, 'D.D.', NULL, false),
      (${PS}, ${UNIT}, 'E.E.', NULL, true)`;
    await admin`INSERT INTO public.patients (id, unit_id, full_name, shared_with_partner) VALUES (${PW}, ${UNIT}, 'W.W.', true)`;
    for (const f of [
      "0005_bed_integrity.sql",
      "0006_bridge_import_provenance.sql",
      "0007_bridge_wardable_fence.sql",
      "0008_bridge_read_exports.sql",
      "0009_referral_prefill_atomic.sql",
      "0010_bridge_referral_review.sql",
    ])
      await admin.unsafe(readFileSync(join(ROOT, "docs/security/staged-migrations", f), "utf8"));
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
    const n =
      await admin`SELECT count(*)::int AS n FROM public.patients WHERE upper(btrim(bed)) = '5'`;
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
    const r =
      await admin`SELECT id, bed FROM public.patients WHERE id IN (${P1}, ${P2}) ORDER BY id`;
    expect(r.map((x) => x.bed)).toEqual(["2", "1"]);
  });

  it("revoking sharing waits for an in-flight result import; a later import is refused", async () => {
    const rec = (id: string) =>
      JSON.stringify({
        id,
        patient_id: PS,
        type: "Blood",
        findings: "Normal",
        result_at: "2026-03-01T09:00:00Z",
        created_at: "2026-03-01T09:00:00Z",
        updated_at: "2026-03-01T09:00:00Z",
      });
    const order: string[] = [];
    const imp = a.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE service_role");
      const r = await tx.unsafe(
        `SELECT public.bridge_import_result('investigations', '${rec("40000000-0000-4000-8000-0000000000b1")}'::jsonb) AS r`,
      );
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
      return tx.unsafe(
        `SELECT public.bridge_import_result('investigations', '${rec("40000000-0000-4000-8000-0000000000b2")}'::jsonb) AS r`,
      );
    });
    expect(after[0]!.r).toBe("parent_unavailable");
  });

  // ---- fenced wardable (0007) -------------------------------------------
  const ACTOR = JSON.stringify({
    id: "60000000-0000-4000-8000-000000000001",
    email: "ccc@example.test",
    role: "clinician",
  });
  type W = { ok: boolean; status?: string; code?: string; desired_revision?: string };
  const setW = async (
    tx: postgres.TransactionSql,
    expected: string,
    wardable: boolean,
    revision: string,
  ): Promise<W> => {
    await tx.unsafe("SET LOCAL ROLE service_role");
    // Text parameters: keep microseconds exact and the actor as a JSON object.
    const r =
      await tx`SELECT public.bridge_set_wardable(${PW}::uuid, (${expected}::text)::timestamptz, ${wardable}::boolean, ${revision}::text, (${ACTOR}::text)::jsonb) AS r`;
    return r[0]!.r as W;
  };
  const state = async () => {
    const r =
      await admin`SELECT p.wardable, f.highest_revision::text AS h, f.applied_revision::text AS a
      FROM public.patients p LEFT JOIN private.bridge_wardable_fence f ON f.patient_id = p.id WHERE p.id = ${PW}`;
    return r[0] as { wardable: boolean; h: string | null; a: string | null };
  };
  const audits = async () =>
    (
      await admin`SELECT count(*)::int AS n FROM public.record_audit WHERE record_id = ${PW} AND source = 'bridge'`
    )[0]!.n as number;

  it("wardable: an older intent arriving while a newer one is in flight waits, then is superseded", async () => {
    const v = await rev(PW);
    let newer: W | undefined;
    const first = a.begin(async (tx) => {
      newer = await setW(tx, v, true, "10");
      await sleep(400); // hold the patient + fence locks
    });
    await sleep(100);
    const older = b.begin((tx) => setW(tx, v, false, "9"));
    const [, o] = await Promise.all([first, older]);
    expect(newer).toMatchObject({ ok: true, status: "applied", desired_revision: "10" });
    expect(o).toMatchObject({ ok: false, code: "superseded", desired_revision: "10" });
    expect(await state()).toEqual({ wardable: true, h: "10", a: "10" });
  });

  it("wardable: a newer intent racing an older apply keeps its reservation even though it conflicts", async () => {
    const v = await rev(PW);
    const first = a.begin(async (tx) => {
      const r = await setW(tx, v, false, "11");
      await sleep(400);
      return r;
    });
    await sleep(100);
    // Read the same version before the first commits: after waiting it is stale.
    const second = b.begin((tx) => setW(tx, v, true, "12"));
    const [r11, r12] = await Promise.all([first, second]);
    expect(r11).toMatchObject({ ok: true, status: "applied" });
    expect(r12).toMatchObject({ ok: false, code: "revision_conflict", desired_revision: "12" });
    expect(await state()).toEqual({ wardable: false, h: "12", a: "11" });
    // The committed reservation fences out a delayed retry of 11.
    const late = await a.begin((tx) => setW(tx, v, false, "11"));
    expect(late).toMatchObject({ ok: false, code: "superseded", desired_revision: "12" });
    // 12 applies only once re-sent with the fresh version (no auto-rebase).
    const ok = await b.begin(async (tx) => setW(tx, await rev(PW), true, "12"));
    expect(ok).toMatchObject({ ok: true, status: "applied" });
  });

  it("wardable: two identical retries at once apply exactly once", async () => {
    const v = await rev(PW);
    const before = await audits();
    const first = a.begin(async (tx) => {
      const r = await setW(tx, v, false, "13");
      await sleep(300);
      return r;
    });
    await sleep(80);
    const second = b.begin((tx) => setW(tx, v, false, "13"));
    const res = (await Promise.all([first, second])).map((r) => r.status ?? r.code).sort();
    // The retry read the pre-apply version: after the first commits it's
    // either already_applied (same intent recorded) — never a second write.
    expect(res).toEqual(["already_applied", "applied"]);
    expect(await audits()).toBe(before + 1);
  });

  it("wardable: a native edit in flight makes the partner request wait, then conflict (reservation kept)", async () => {
    const v = await rev(PW);
    const native = a.begin(async (tx) => {
      await tx`UPDATE public.patients SET wardable = true WHERE id = ${PW}`;
      await sleep(300);
    });
    await sleep(80);
    const partner = b.begin((tx) => setW(tx, v, true, "14"));
    const [, r] = await Promise.all([native, partner]);
    expect(r).toMatchObject({ ok: false, code: "revision_conflict", desired_revision: "14" });
    expect(await state()).toMatchObject({ wardable: true, h: "14", a: "13" });
  });

  it("wardable: revoking sharing waits for an in-flight update; afterwards the patient is not_found", async () => {
    const v = await rev(PW);
    const order: string[] = [];
    const upd = a.begin(async (tx) => {
      const r = await setW(tx, v, true, "15");
      order.push(`wardable:${r.status ?? r.code}`);
      await sleep(300);
      order.push("wardable:commit");
    });
    await sleep(80);
    const revoke = b.begin(async (tx) => {
      await tx`UPDATE public.patients SET shared_with_partner = false WHERE id = ${PW}`;
      order.push("revoke");
    });
    await Promise.all([upd, revoke]);
    expect(order).toEqual(["wardable:applied", "wardable:commit", "revoke"]);
    const after = await a.begin(async (tx) => setW(tx, await rev(PW), false, "16"));
    expect(after).toEqual({ ok: false, code: "not_found" });
    expect(await state()).toMatchObject({ h: "15", a: "15" });
  });

  // ---- partner referral import watermark (0006) ----------------------------
  const RID = (n: number) => `30000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
  const live = (id: string, at: string) =>
    JSON.stringify({
      id,
      created_at: "2026-03-01T10:00:00Z",
      updated_at: at,
      deleted_at: null,
      status: "pending",
      referral_received_at: "2026-03-01T10:00:00Z",
      age: 70,
      sex: "female",
      current_ward: "W1",
      current_bed: "B1",
      referring_specialty: "Medicine",
      reason_category: "sepsis",
      ceiling_of_care: "full_escalation",
      resus_status: "for_cpr",
      dnacpr_respect: false,
      anticipated_interventions: [],
      allergies: null,
      weight_kg: null,
      admission_urgency: null,
      infection_status: null,
      news2_score: null,
    });
  const dead = (id: string, at: string) => JSON.stringify({ id, updated_at: at, deleted_at: at });
  const imp = async (tx: postgres.TransactionSql, rec: string) => {
    await tx.unsafe("SET LOCAL ROLE service_role");
    const r = await tx`SELECT public.bridge_import_referral((${rec}::text)::jsonb) AS r`;
    return r[0]!.r as string;
  };
  const refRow = async (id: string) =>
    (await admin`SELECT deleted_at FROM public.referrals WHERE id = ${id}`)[0] as
      | { deleted_at: Date | null }
      | undefined;

  it("import: an unknown tombstone in flight makes a delayed older live row wait, then stay deleted", async () => {
    const id = RID(1);
    const first = a.begin(async (tx) => {
      const r = await imp(tx, dead(id, "2026-03-05T00:00:00Z"));
      await sleep(400);
      return r;
    });
    await sleep(100);
    const second = b.begin((tx) => imp(tx, live(id, "2026-03-04T00:00:00Z")));
    expect(await Promise.all([first, second])).toEqual(["unknown_tombstone", "unchanged"]);
    expect(await refRow(id)).toBeUndefined();
  });

  it("import: the other order — older live in flight, tombstone waits, then deletes it", async () => {
    const id = RID(2);
    const first = a.begin(async (tx) => {
      const r = await imp(tx, live(id, "2026-03-04T00:00:00Z"));
      await sleep(400);
      return r;
    });
    await sleep(100);
    const second = b.begin((tx) => imp(tx, dead(id, "2026-03-05T00:00:00Z")));
    expect(await Promise.all([first, second])).toEqual(["inserted", "deleted"]);
    expect((await refRow(id))!.deleted_at).not.toBeNull();
    // A late replay of the older live row afterwards still can't restore it.
    expect(await a.begin((tx) => imp(tx, live(id, "2026-03-04T00:00:00Z")))).toBe("unchanged");
    expect((await refRow(id))!.deleted_at).not.toBeNull();
  });

  it("import: a rolled-back tombstone leaves no watermark; the waiting live row is inserted", async () => {
    const id = RID(3);
    const first = a
      .begin(async (tx) => {
        await imp(tx, dead(id, "2026-03-05T00:00:00Z"));
        await sleep(400);
        throw new Error("rollback_injected");
      })
      .catch((e: Error) => e.message);
    await sleep(100);
    const second = b.begin((tx) => imp(tx, live(id, "2026-03-04T00:00:00Z")));
    expect(await Promise.all([first, second])).toEqual(["rollback_injected", "inserted"]);
    expect((await refRow(id))!.deleted_at).toBeNull();
  });

  it("import: two first imports of an absent referral are serialised — one row, one audit", async () => {
    const id = RID(4);
    const first = a.begin(async (tx) => {
      const r = await imp(tx, live(id, "2026-03-04T00:00:00Z"));
      await sleep(300);
      return r;
    });
    await sleep(80);
    const second = b.begin((tx) => imp(tx, live(id, "2026-03-04T00:00:00Z")));
    expect(await Promise.all([first, second])).toEqual(["inserted", "unchanged"]);
    const n = await admin`SELECT
      (SELECT count(*)::int FROM public.referrals WHERE id = ${id}) AS r,
      (SELECT count(*)::int FROM public.record_audit WHERE record_id = ${id}) AS a`;
    expect(n[0]).toEqual({ r: 1, a: 1 });
  });

  // ---- native referral prefill (0009) -------------------------------------
  const PP = "20000000-0000-4000-8000-0000000000b1";
  const iso = async (sql: string, id: string) => (await admin.unsafe(sql, [id]))[0]!.u as string;
  const prev = () =>
    iso("SELECT to_json(updated_at)#>>'{}' AS u FROM public.patients WHERE id = $1", PP);
  const rrev = (id: string) =>
    iso("SELECT to_json(updated_at)#>>'{}' AS u FROM public.referrals WHERE id = $1", id);
  const linkTo = async (rid: string) => {
    await admin`UPDATE public.patients SET source_referral_id = ${rid}, current_admission_enc = NULL WHERE id = ${PP}`;
  };
  const apply = async (tx: postgres.TransactionSql, rid: string, pAt: string, rAt: string) => {
    await tx.unsafe("SET LOCAL ROLE service_role");
    const req = JSON.stringify({
      patient_id: PP,
      referral_id: rid,
      expected_patient_updated_at: pAt,
      expected_referral_updated_at: rAt,
      set: { current_admission: "CIPHER" },
    });
    const r =
      await tx`SELECT public.apply_referral_prefill(${C1}::uuid, ${sid(C1)}::uuid, (${req}::text)::jsonb) AS r`;
    return r[0]!.r as { ok: boolean; code?: string };
  };
  const filled = async () =>
    (await admin`SELECT current_admission_enc AS a FROM public.patients WHERE id = ${PP}`)[0]!.a;

  it("prefill: a source edit in flight makes the apply wait, then refuse as stale", async () => {
    await admin`INSERT INTO public.patients (id, unit_id, full_name) VALUES (${PP}, ${UNIT}, 'P.P.') ON CONFLICT DO NOTHING`;
    const rid = RID(10);
    await admin`INSERT INTO public.referrals (id, status, reason_category) VALUES (${rid}, 'pending', 'sepsis')`;
    await linkTo(rid);
    const [pAt, rAt] = [await prev(), await rrev(rid)];
    const edit = a.begin(async (tx) => {
      await tx`UPDATE public.referrals SET current_ward = 'MOVED' WHERE id = ${rid}`;
      await sleep(400);
    });
    await sleep(100);
    const ap = b.begin((tx) => apply(tx, rid, pAt, rAt));
    const [, r] = await Promise.all([edit, ap]);
    expect(r).toEqual({ ok: false, code: "stale" });
    expect(await filled()).toBeNull();
  });

  it("prefill: an apply in flight makes the source edit wait; the apply commits against the version it checked", async () => {
    const rid = RID(10);
    const [pAt, rAt] = [await prev(), await rrev(rid)];
    const order: string[] = [];
    const ap = a.begin(async (tx) => {
      const r = await apply(tx, rid, pAt, rAt);
      order.push(`apply:${r.ok}`);
      await sleep(400);
      order.push("apply:commit");
    });
    await sleep(100);
    const edit = b.begin(async (tx) => {
      await tx`UPDATE public.referrals SET current_ward = 'MOVED AGAIN' WHERE id = ${rid}`;
      order.push("edit");
    });
    await Promise.all([ap, edit]);
    expect(order).toEqual(["apply:true", "apply:commit", "edit"]);
    expect(await filled()).toBe("CIPHER");
    const n =
      await admin`SELECT count(*)::int AS n FROM public.record_audit WHERE record_id = ${PP} AND after->>'operation' = 'referral_prefill'`;
    expect(n[0]!.n).toBe(1);
  });

  it("prefill: a partner tombstone in flight makes the apply wait, then refuse (no stale prefill)", async () => {
    const rid = RID(11);
    expect(await a.begin((tx) => imp(tx, live(rid, "2026-03-04T00:00:00Z")))).toBe("inserted");
    await linkTo(rid);
    const [pAt, rAt] = [await prev(), await rrev(rid)];
    const del = a.begin(async (tx) => {
      const r = await imp(tx, dead(rid, "2026-03-05T00:00:00Z"));
      await sleep(400);
      return r;
    });
    await sleep(100);
    const ap = b.begin((tx) => apply(tx, rid, pAt, rAt));
    const [d1, r] = await Promise.all([del, ap]);
    expect(d1).toBe("deleted");
    expect(r).toEqual({ ok: false, code: "referral_unavailable" });
    expect(await filled()).toBeNull();
  });

  it("prefill: an apply in flight makes a native soft delete wait; no deadlock either way", async () => {
    const rid = RID(12);
    await admin`INSERT INTO public.referrals (id, status, reason_category) VALUES (${rid}, 'pending', 'sepsis')`;
    await linkTo(rid);
    const [pAt, rAt] = [await prev(), await rrev(rid)];
    const ap = a.begin(async (tx) => {
      const r = await apply(tx, rid, pAt, rAt);
      await sleep(300);
      return r;
    });
    await sleep(80);
    const del = b.begin(async (tx) => {
      await tx`UPDATE public.referrals SET deleted_at = now() WHERE id = ${rid}`;
      return "deleted";
    });
    const [r, d1] = await Promise.all([ap, del]);
    expect(r).toMatchObject({ ok: true });
    expect(d1).toBe("deleted");
    expect(await filled()).toBe("CIPHER");
  });

  it("prefill: a clinician's patient edit in flight makes the apply wait, then refuse as stale", async () => {
    const rid = RID(13);
    await admin`INSERT INTO public.referrals (id, status, reason_category) VALUES (${rid}, 'pending', 'sepsis')`;
    await linkTo(rid);
    const [pAt, rAt] = [await prev(), await rrev(rid)];
    const edit = a.begin(async (tx) => {
      await tx`UPDATE public.patients SET current_management_enc = 'LOCAL EDIT' WHERE id = ${PP}`;
      await sleep(400);
    });
    await sleep(100);
    const ap = b.begin((tx) => apply(tx, rid, pAt, rAt));
    const [, r] = await Promise.all([edit, ap]);
    expect(r).toEqual({ ok: false, code: "stale" });
    expect(await filled()).toBeNull();
    const row =
      await admin`SELECT current_management_enc AS m FROM public.patients WHERE id = ${PP}`;
    expect(row[0]!.m).toBe("LOCAL EDIT");
  });
});
