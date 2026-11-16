// Runs the STAGED (not applied) partner read-export SQL (0008) on an in-memory
// Postgres (PGlite) with synthetic data only, on top of 0005-0007 so the whole
// staged chain is proven to apply in order.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "../..");
const MIG_DIR = join(ROOT, "drizzle/migrations");
const STAGED = [
  "0005_bed_integrity.sql",
  "0006_bridge_import_provenance.sql",
  "0007_bridge_wardable_fence.sql",
  "0008_bridge_read_exports.sql",
].map((f) => readFileSync(join(ROOT, "docs/security/staged-migrations", f), "utf8"));

const RADNOR = "10000000-0000-4000-8000-000000000001";
const OTHER = "10000000-0000-4000-8000-000000000002";
const P = {
  shared: "20000000-0000-4000-8000-000000000001", // Radnor, shared, from REF.shared
  hidden: "20000000-0000-4000-8000-000000000002", // Radnor, not shared, from REF.hidden
  otherShared: "20000000-0000-4000-8000-000000000003", // other unit, shared, from REF.other
  revoked: "20000000-0000-4000-8000-000000000004", // Radnor, shared then revoked
};
const REF = {
  shared: "30000000-0000-4000-8000-000000000001",
  hidden: "30000000-0000-4000-8000-000000000002",
  other: "30000000-0000-4000-8000-000000000003",
  revoked: "30000000-0000-4000-8000-000000000004",
  orphan: "30000000-0000-4000-8000-000000000005",
  // Identity collision: a referral whose id equals a shared patient's id.
  collides: "20000000-0000-4000-8000-000000000001",
};

type Row = Record<string, unknown>;
let db: PGlite;
const q = async (sql: string, p?: unknown[]) => (await db.query(sql, p)).rows as Row[];

/** Calls an export exactly as the API does: as service_role. */
async function exportAs(role: string, fn: string, args = ""): Promise<Row[]> {
  await db.exec("BEGIN");
  try {
    await db.exec(`SET LOCAL ROLE ${role}`);
    const rows = await q(`SELECT * FROM public.${fn}(${args})`);
    await db.exec("COMMIT");
    return rows;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}
const ids = (rows: Row[]) => rows.map((r) => r.id as string).sort();

beforeAll(async () => {
  db = new PGlite();
  const mig = readdirSync(MIG_DIR)
    .filter((f) => f.endsWith(".sql") && f.includes("security_remediation"))
    .sort()
    .map((f) => readFileSync(join(MIG_DIR, f), "utf8"));
  await db.exec(
    [
      readFileSync(join(__dirname, "sql/fixture.sql"), "utf8"),
      ...mig,
      readFileSync(join(__dirname, "sql/bed-bridge-fixture.sql"), "utf8"),
    ].join("\n;\n"),
  );
  await q(
    "INSERT INTO public.icu_units (id, name, code) VALUES ($1,'Radnor','SDH-RADNOR'), ($2,'Other','SDH-OTHER')",
    [RADNOR, OTHER],
  );
  for (const sql of STAGED) await db.exec(sql);
}, 60_000);

beforeEach(async () => {
  await db.exec(`
    DELETE FROM public.notifications; DELETE FROM public.audit_log;
    DELETE FROM public.microbiology_results; DELETE FROM public.investigations;
    DELETE FROM public.patients; DELETE FROM public.referrals;
    UPDATE public.icu_units SET code = 'SDH-RADNOR' WHERE id = '${RADNOR}';
    UPDATE public.icu_units SET code = 'SDH-OTHER' WHERE id = '${OTHER}';`);
  for (const r of Object.values(REF))
    await q("INSERT INTO public.referrals (id) VALUES ($1) ON CONFLICT DO NOTHING", [r]);
  for (const [id, unit, shared, ref] of [
    [P.shared, RADNOR, true, REF.shared],
    [P.hidden, RADNOR, false, REF.hidden],
    [P.otherShared, OTHER, true, REF.other],
    [P.revoked, RADNOR, true, REF.revoked],
  ] as const)
    await q(
      "INSERT INTO public.patients (id, unit_id, shared_with_partner, full_name, source_referral_id) VALUES ($1,$2,$3,'S.Y.',$4)",
      [id, unit, shared, ref],
    );
  for (const p of Object.values(P)) {
    await q(
      "INSERT INTO public.investigations (patient_id, category, findings) VALUES ($1,'bloods','synthetic'), ($1,'imaging','synthetic')",
      [p],
    );
    await q(
      "INSERT INTO public.microbiology_results (patient_id, specimen_type, findings) VALUES ($1,'blood','synthetic')",
      [p],
    );
  }
  for (const r of [REF.shared, REF.hidden, REF.other, REF.revoked, REF.orphan])
    await q(
      "INSERT INTO public.notifications (user_id, referral_id, kind, message) VALUES (gen_random_uuid(), $1, 'k', 'synthetic')",
      [r],
    );
  await q(
    "INSERT INTO public.notifications (user_id, referral_id, kind, message) VALUES (gen_random_uuid(), NULL, 'k', 'internal')",
  );
});

const patientOf = async (table: string, rows: Row[]) => {
  if (rows.length === 0) return [];
  const r = await q(
    `SELECT DISTINCT patient_id::text AS p FROM public.${table} WHERE id = ANY($1::uuid[])`,
    [rows.map((x) => x.id)],
  );
  return r.map((x) => x.p as string).sort();
};

describe("staged 0008: child results", () => {
  it("investigations: only still-shared Radnor patients; other unit and unshared excluded", async () => {
    await q("UPDATE public.patients SET shared_with_partner=false WHERE id=$1", [P.revoked]);
    const rows = await exportAs("service_role", "bridge_export_investigations");
    expect(await patientOf("investigations", rows)).toEqual([P.shared]);
    expect(rows).toHaveLength(2);
  });
  it("investigations: exact table row keys (response contract unchanged)", async () => {
    const rows = await exportAs("service_role", "bridge_export_investigations");
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["category", "created_at", "created_by", "findings", "id", "patient_id", "result_at", "updated_at"],
    );
  });
  it("investigations: patient and category filters; wrong-unit patient id returns nothing", async () => {
    const one = await exportAs(
      "service_role",
      "bridge_export_investigations",
      `'${P.shared}'::uuid, 'bloods'`,
    );
    expect(one.map((r) => r.category)).toEqual(["bloods"]);
    expect(
      await exportAs("service_role", "bridge_export_investigations", `'${P.otherShared}'::uuid`),
    ).toEqual([]);
    expect(
      await exportAs("service_role", "bridge_export_investigations", `'${P.hidden}'::uuid`),
    ).toEqual([]);
  });
  it("microbiology: only still-shared Radnor patients", async () => {
    const rows = await exportAs("service_role", "bridge_export_microbiology");
    expect(await patientOf("microbiology_results", rows)).toEqual([P.shared, P.revoked].sort());
  });
  it("sharing revoked before the statement is honoured (no stale id list)", async () => {
    expect(
      await patientOf("investigations", await exportAs("service_role", "bridge_export_investigations")),
    ).toContain(P.revoked);
    await q("UPDATE public.patients SET shared_with_partner=false WHERE id=$1", [P.revoked]);
    expect(
      await patientOf("investigations", await exportAs("service_role", "bridge_export_investigations")),
    ).not.toContain(P.revoked);
    expect(
      await patientOf("microbiology_results", await exportAs("service_role", "bridge_export_microbiology")),
    ).toEqual([P.shared]);
  });
  it("patient moved to another unit stops exporting", async () => {
    await q("UPDATE public.patients SET unit_id=$2 WHERE id=$1", [P.revoked, OTHER]);
    expect(
      await patientOf("microbiology_results", await exportAs("service_role", "bridge_export_microbiology")),
    ).toEqual([P.shared]);
  });
  it("empty success: nothing shared returns an empty set, not an error", async () => {
    await q("UPDATE public.patients SET shared_with_partner=false");
    for (const fn of [
      "bridge_export_investigations",
      "bridge_export_microbiology",
      "bridge_export_referrals",
      "bridge_export_notifications",
      "bridge_export_audit",
    ])
      expect(await exportAs("service_role", fn)).toEqual([]);
  });
});

describe("staged 0008: referral-linked feeds", () => {
  it("referrals: only those a still-shared Radnor patient came from", async () => {
    await q("UPDATE public.patients SET shared_with_partner=false WHERE id=$1", [P.revoked]);
    expect(ids(await exportAs("service_role", "bridge_export_referrals"))).toEqual([REF.shared]);
  });
  it("notifications: shared Radnor referral only; orphan, other unit, unlinked and internal excluded", async () => {
    const rows = await exportAs("service_role", "bridge_export_notifications");
    expect(rows.map((r) => r.referral_id).sort()).toEqual([REF.revoked, REF.shared].sort());
    expect(Object.keys(rows[0]!).sort()).toEqual(
      ["created_at", "id", "kind", "message", "read_at", "referral_id", "user_id"],
    );
  });
  it("identity collision: a referral id equal to a shared patient id is not a shared referral", async () => {
    const rows = await exportAs("service_role", "bridge_export_referrals");
    // REF.collides has the same UUID as P.shared but no patient came from it.
    expect(ids(rows)).not.toContain(REF.collides);
  });
});

describe("staged 0008: typed audit", () => {
  beforeEach(async () => {
    const add = (entity: string, id: string) =>
      q(
        "INSERT INTO public.audit_log (action, entity, entity_id, diff) VALUES ('update', $1, $2, '{}')",
        [entity, id],
      );
    await add("patients", P.shared); // allowed
    await add("patients", P.hidden); // not shared
    await add("patients", P.otherShared); // other unit
    await add("referrals", REF.shared); // allowed (source of a shared patient)
    await add("referrals", REF.other); // other unit
    await add("referrals", REF.orphan); // no patient
    // Same UUID as a shared patient, wrong entity type: must not leak.
    await add("investigations", P.shared);
    await add("chart_scan", P.shared);
    // Referral entry whose id equals a shared PATIENT id (not its source).
    await add("referrals", P.shared);
    // Patient entry whose id equals a shared REFERRAL id.
    await add("patients", REF.shared);
  });
  it("only correctly typed entries for still-shared Radnor patients and their referrals", async () => {
    const rows = await exportAs("service_role", "bridge_export_audit");
    expect(rows.map((r) => `${r.entity}:${r.entity_id}`).sort()).toEqual(
      [`patients:${P.shared}`, `referrals:${REF.shared}`].sort(),
    );
  });
  it("revocation removes both the patient's and its referral's entries", async () => {
    await q("UPDATE public.patients SET shared_with_partner=false WHERE id=$1", [P.shared]);
    expect(await exportAs("service_role", "bridge_export_audit")).toEqual([]);
  });
});

describe("staged 0008: unit resolution and privileges", () => {
  const ALL = [
    "bridge_export_investigations",
    "bridge_export_microbiology",
    "bridge_export_referrals",
    "bridge_export_notifications",
    "bridge_export_audit",
  ];
  it("missing bridge unit raises PT503 (never an empty success)", async () => {
    await q("UPDATE public.icu_units SET code='RENAMED' WHERE id=$1", [RADNOR]);
    for (const fn of ALL) {
      const err = await exportAs("service_role", fn).catch((e: { code?: string }) => e);
      expect((err as { code?: string }).code).toBe("PT503");
    }
  });
  it("duplicate bridge unit code raises PT503", async () => {
    await q("UPDATE public.icu_units SET code='SDH-RADNOR' WHERE id=$1", [OTHER]);
    for (const fn of ALL) {
      const err = await exportAs("service_role", fn).catch((e: { code?: string }) => e);
      expect((err as { code?: string }).code).toBe("PT503");
    }
  });
  it("browser roles cannot execute any export", async () => {
    for (const role of ["anon", "authenticated"])
      for (const fn of ALL)
        await expect(exportAs(role, fn)).rejects.toThrow(/permission denied/);
  });
  it("functions are SECURITY DEFINER with an empty search_path; no table grants widened", async () => {
    const fns = await q(
      `SELECT p.proname, p.prosecdef, p.proconfig FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname='public' AND p.proname LIKE 'bridge_export_%' ORDER BY 1`,
    );
    expect(fns.map((f) => f.proname)).toEqual([...ALL].sort());
    for (const f of fns) {
      expect(f.prosecdef).toBe(true);
      expect(f.proconfig).toEqual(['search_path=""']);
    }
    const anonGrants = await q(
      `SELECT count(*)::int AS n FROM information_schema.role_table_grants
        WHERE grantee='anon' AND table_name IN ('notifications')`,
    );
    expect(anonGrants[0]!.n).toBe(0);
  });
});
