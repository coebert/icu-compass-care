// Reproduces the cross-app review against the REAL staged import (0006) and
// review helper (0010) on an in-memory Postgres (PGlite). Synthetic referrals
// only; the partner feed is a fixed in-process list. Nothing is applied live.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
  "0009_referral_prefill_atomic.sql",
  "0010_bridge_referral_review.sql",
].map((f) => readFileSync(join(ROOT, "docs/security/staged-migrations", f), "utf8"));

type Row = Record<string, unknown>;
let db: PGlite;
const q = async (sql: string, p?: unknown[]) => (await db.query(sql, p)).rows as Row[];
async function asRole<T>(role: string, fn: () => Promise<T>): Promise<T> {
  await db.exec("BEGIN");
  try {
    await db.exec(`SET LOCAL ROLE ${role}`);
    const out = await fn();
    await db.exec("COMMIT");
    return out;
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
}
const pgErr = (e: unknown) => ({
  code: (e as { code?: string }).code ?? "XX000",
  message: "db error",
});

/** Just enough of the service client for the review/import code paths. */
const admin = {
  async rpc(name: string, args: Record<string, unknown>) {
    try {
      if (name === "bridge_referral_review") {
        const r = await asRole("service_role", () =>
          q("SELECT public.bridge_referral_review($1) AS r", [args._limit]),
        );
        return { data: r[0]!.r, error: null };
      }
      if (name === "bridge_import_referral") {
        const r = await asRole("service_role", () =>
          q("SELECT public.bridge_import_referral($1::jsonb) AS r", [JSON.stringify(args._rec)]),
        );
        return { data: r[0]!.r, error: null };
      }
      return { data: null, error: { code: "PGRST202" } };
    } catch (e) {
      return { data: null, error: pgErr(e) };
    }
  },
  from(table: string) {
    let cols = "*";
    let after: string | null = null;
    let lim = 1000;
    const b = {
      select(c: string) {
        cols = c;
        return b;
      },
      order() {
        return b;
      },
      gt(_c: string, v: string) {
        after = v;
        return b;
      },
      limit(n: number) {
        lim = n;
        return b;
      },
      then(ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) {
        const sql = `SELECT ${cols} FROM public.${table} ${after ? "WHERE id > $1" : ""} ORDER BY id LIMIT ${Math.min(lim, 1000)}`;
        return asRole("service_role", () => q(sql, after ? [after] : []))
          .then((data) => ({ data, error: null }))
          .catch((e) => ({ data: null, error: pgErr(e) }))
          .then(ok, bad);
      },
    };
    return b;
  },
};

const h = vi.hoisted(() => ({ remote: [] as Row[] }));
vi.mock("@/lib/admin-db.server", () => ({ getAdmin: async () => admin }));
vi.mock("@/lib/bridge-client.server", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  fetchSyncV1: async () => ({ records: h.remote, snapshotAt: "2026-11-16T12:00:00Z" }),
  fetchPartnerNotificationsForReview: async () => ({ records: [], complete: true }),
  fetchPartnerAuditLogForReview: async () => ({ records: [], complete: true }),
}));

import {
  buildReconciliation,
  reconcilePullReferrals,
  referralContentKey,
} from "@/lib/reconcile.server";
import { importReferrals } from "@/lib/bridge-import.server";
import { mapReferral } from "@/lib/bridge-contract";

const rid = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const live = (id: string, over: Row = {}): Row => ({
  id,
  created_at: "2026-11-16T08:00:00Z",
  updated_at: "2026-11-16T09:00:00.123456Z",
  deleted_at: null,
  status: "pending",
  referral_received_at: "2026-11-16T08:00:00Z",
  age: 70,
  sex: "female",
  current_ward: "SYN",
  current_bed: "B1",
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
/** A local copy written directly (legacy mirror / made here): no import provenance. */
async function legacyCopy(rec: Row) {
  const cols = Object.keys(rec).filter((k) => k !== "updated_at");
  await q(
    `INSERT INTO public.referrals (${cols.join(",")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(",")})`,
    cols.map((k) => rec[k]),
  );
}
const referrals = async () => (await buildReconciliation()).find((e) => e.entity === "referrals")!;
const rowFor = async (id: string) => (await referrals()).mismatches.find((m) => m.id === id);

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
    "INSERT INTO public.icu_units (id, name, code) VALUES (gen_random_uuid(),'Radnor','SDH-RADNOR')",
  );
  for (const sql of STAGED) await db.exec(sql);
}, 60_000);

beforeEach(async () => {
  h.remote = [];
  await db.exec(
    "DELETE FROM public.record_audit; DELETE FROM public.referrals; DELETE FROM private.bridge_referral_provenance;",
  );
});

describe("referral review vs the staged import (reproduction)", () => {
  it("an equal legacy copy without provenance is NOT 'in sync': the import refuses it", async () => {
    const rec = live(rid(1));
    await legacyCopy(rec);
    h.remote = [rec];
    // The old review compared content only, which matches here...
    const local = (
      await q("SELECT private.referral_import_fields(r) AS f FROM public.referrals r")
    )[0]!.f as Row;
    expect(referralContentKey(local)).toBe(referralContentKey(mapReferral(rec)));
    // ...but the real import calls it a conflict.
    expect((await importReferrals(admin, [rec])).conflicts).toBe(1);
    const r = await referrals();
    expect(r.matched).toBe(0);
    expect(r.mismatches).toEqual([
      expect.objectContaining({
        id: rid(1),
        state: "conflict",
        reason: "not_imported",
        pullable: false,
      }),
    ]);
  });

  it("two equal legacy copies stay as conflicts after a pull; nothing is adopted or changed", async () => {
    for (const n of [2, 3]) await legacyCopy(live(rid(n)));
    h.remote = [live(rid(2)), live(rid(3))];
    const before = await q("SELECT id, updated_at FROM public.referrals ORDER BY id");
    const res = await reconcilePullReferrals("all", admin);
    expect(res).toMatchObject({ applied: 0, conflicts: 2 });
    expect(await q("SELECT id, updated_at FROM public.referrals ORDER BY id")).toEqual(before);
    expect(await q("SELECT * FROM private.bridge_referral_provenance")).toEqual([]);
    const r = await referrals();
    expect(r.matched).toBe(0);
    expect(r.mismatches.map((m) => [m.state, m.pullable])).toEqual([
      ["conflict", false],
      ["conflict", false],
    ]);
  });

  it("a partner deletion of a never-imported referral is 'only on partner' until pulled, then matched", async () => {
    h.remote = [tomb(rid(4), "2026-11-16T10:00:00Z")];
    expect(await rowFor(rid(4))).toMatchObject({
      state: "remote_only",
      reason: "partner_deletion",
      pullable: true,
    });
    expect((await reconcilePullReferrals([rid(4)], admin)).skipped).toBe(1);
    // Only the watermark exists; no referral row was created.
    expect(await q("SELECT id FROM public.referrals")).toEqual([]);
    const r = await referrals();
    expect(r.mismatches).toEqual([]);
    expect(r.matched).toBe(1);
    expect(r.localCount).toBe(0);
  });

  it("an older live copy after a recorded deletion is shown as 'deletion stands', not pullable", async () => {
    await importReferrals(admin, [tomb(rid(5), "2026-11-16T10:00:00Z")]);
    h.remote = [live(rid(5), { updated_at: "2026-11-16T09:00:00Z" })];
    expect(await rowFor(rid(5))).toMatchObject({
      state: "held",
      reason: "deletion_stands",
      pullable: false,
    });
    // A strictly newer live version is a genuine restore and is pullable.
    h.remote = [live(rid(5), { updated_at: "2026-11-16T11:00:00Z" })];
    expect(await rowFor(rid(5))).toMatchObject({ state: "remote_only", pullable: true });
  });

  it("imported + unchanged + equal is matched; a newer partner version is pullable and then matched", async () => {
    await importReferrals(admin, [live(rid(6))]);
    h.remote = [live(rid(6))];
    expect(await referrals()).toMatchObject({ matched: 1, mismatches: [] });
    h.remote = [live(rid(6), { updated_at: "2026-11-16T11:00:00Z", status: "admitted" })];
    expect(await rowFor(rid(6))).toMatchObject({ state: "diverged", pullable: true });
    expect((await reconcilePullReferrals([rid(6)], admin)).applied).toBe(1);
    expect(await referrals()).toMatchObject({ matched: 1, mismatches: [] });
  });

  it("a local edit after import is a conflict; a pull doesn't overwrite it", async () => {
    await importReferrals(admin, [live(rid(7))]);
    await q("UPDATE public.referrals SET current_ward = 'LOCAL' WHERE id = $1", [rid(7)]);
    h.remote = [live(rid(7), { updated_at: "2026-11-16T11:00:00Z", status: "admitted" })];
    expect(await rowFor(rid(7))).toMatchObject({
      state: "conflict",
      reason: "local_edit",
      pullable: false,
    });
    expect((await reconcilePullReferrals([rid(7)], admin)).conflicts).toBe(1);
    expect((await q("SELECT current_ward FROM public.referrals WHERE id=$1", [rid(7)]))[0]).toEqual(
      {
        current_ward: "LOCAL",
      },
    );
  });

  it("a referral only in this app is 'only here', with no partner action", async () => {
    await legacyCopy(live(rid(8)));
    expect(await rowFor(rid(8))).toMatchObject({
      state: "local_only",
      reason: "local_record",
      pullable: false,
    });
  });

  it("same content but the partner's copy isn't newer: 'differs', not pullable", async () => {
    await importReferrals(admin, [live(rid(9), { updated_at: "2026-11-16T11:00:00Z" })]);
    h.remote = [live(rid(9), { updated_at: "2026-11-16T10:00:00Z", status: "declined" })];
    expect(await rowFor(rid(9))).toMatchObject({ state: "held", reason: "partner_not_newer" });
  });
});

describe("bridge_referral_review helper", () => {
  it("is service-role only", async () => {
    for (const role of ["authenticated", "anon"]) {
      await expect(
        asRole(role, () => q("SELECT public.bridge_referral_review(10)")),
      ).rejects.toThrow(/permission denied/);
    }
  });
  it("withholds rows and says incomplete when more ids exist than the limit (watermarks count)", async () => {
    await legacyCopy(live(rid(10)));
    await importReferrals(admin, [tomb(rid(11), "2026-11-16T10:00:00Z")]);
    const one = await asRole("service_role", () =>
      q("SELECT public.bridge_referral_review(1) AS r"),
    );
    expect(one[0]!.r).toEqual({ complete: false, rows: [] });
    const two = await asRole("service_role", () =>
      q("SELECT public.bridge_referral_review(2) AS r"),
    );
    expect((two[0]!.r as { complete: boolean }).complete).toBe(true);
  });
  it("never returns the receiver revision or ledger timestamps", async () => {
    await importReferrals(admin, [live(rid(12))]);
    const r = await asRole("service_role", () =>
      q("SELECT public.bridge_referral_review(10) AS r"),
    );
    const row = (r[0]!.r as { rows: Row[] }).rows[0]!;
    expect(Object.keys(row.provenance as Row).sort()).toEqual([
      "receiver_matches",
      "source_revision",
      "watermark",
    ]);
    expect(Object.keys(row.local as Row)).not.toContain("hospital_number_enc");
  });
  it("rejects silly limits", async () => {
    for (const n of [0, 10001]) {
      await expect(
        asRole("service_role", () => q("SELECT public.bridge_referral_review($1)", [n])),
      ).rejects.toThrow(/invalid_limit/);
    }
  });
});

describe("pulling chosen ids", () => {
  it("an id no longer in the partner's list is reported, not silently 'pulled'", async () => {
    h.remote = [live(rid(20))];
    const res = await reconcilePullReferrals([rid(20), rid(21)], admin);
    expect(res.applied).toBe(1);
    expect(res.errors.join(" ")).toMatch(/no longer in Critical Care Connect's list/);
    expect(await q("SELECT id FROM public.referrals WHERE id=$1", [rid(21)])).toEqual([]);
  });
});
