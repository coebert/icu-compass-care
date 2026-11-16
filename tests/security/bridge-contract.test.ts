import { describe, it, expect } from "vitest";
import {
  ContractError,
  LEGACY_REVIEW_LIMIT,
  mapReferral,
  mapResult,
  parseLegacyRecords,
  parseSyncPage,
  referralImportPayload,
  SyncPageCollector,
} from "@/lib/bridge-contract";

/** The paired Critical Care Connect contract, synthetic rows only. */
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return "accepted";
  } catch (e) {
    expect(e).toBeInstanceOf(ContractError);
    return (e as ContractError).code;
  }
};
const SNAP = "2026-11-16T12:00:00.000000Z";
const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n: number, at = `2026-11-16T10:00:${String(n).padStart(2, "0")}.000001Z`) => ({ id: id(n), updated_at: at });
const page = (records: unknown[], next: string | null, extra: Record<string, unknown> = {}) => ({
  schema_version: 1,
  records,
  snapshot_at: SNAP,
  pagination: { next_cursor: next, complete: next === null },
  ...extra,
});

describe("sync v1 page envelope", () => {
  it("a complete empty page is a valid empty result", () => {
    const c = new SyncPageCollector();
    expect(c.add(parseSyncPage(page([], null)))).toBeNull();
    expect(c.finish()).toEqual({ records: [], snapshotAt: SNAP });
  });
  it.each([
    ["wrong version", { ...page([], null), schema_version: 2 }, "contract_mismatch"],
    ["legacy {records} shape", { records: [] }, "contract_mismatch"],
    ["records not a list", { ...page([], null), records: null }, "contract_mismatch"],
    ["bad snapshot", { ...page([], null), snapshot_at: "now" }, "contract_mismatch"],
    ["complete with a cursor", { ...page([], null), pagination: { complete: true, next_cursor: "c" } }, "pagination_invalid"],
    ["incomplete without a cursor", { ...page([row(1)], null), pagination: { complete: false, next_cursor: null } }, "pagination_invalid"],
    ["incomplete and empty", page([], "c1"), "pagination_invalid"],
    ["cursor with odd characters", page([row(1)], "a b"), "pagination_invalid"],
    ["non-object row", page([1], null), "malformed_record"],
  ])("%s → %s", (_n, body, code) => {
    expect(codeOf(() => parseSyncPage(body))).toBe(code);
  });
  it("more rows than requested is refused", () => {
    expect(codeOf(() => parseSyncPage(page([row(1), row(2)], null), 1))).toBe("pagination_invalid");
  });
});

describe("sync v1 across pages", () => {
  it("collects ordered pages under one snapshot", () => {
    const c = new SyncPageCollector();
    expect(c.add(parseSyncPage(page([row(1), row(2)], "c1")))).toBe("c1");
    expect(c.add(parseSyncPage(page([row(3)], null)))).toBeNull();
    expect(c.finish().records.map((r) => r.id)).toEqual([id(1), id(2), id(3)]);
  });
  it("ties on updated_at are ordered by id", () => {
    const at = "2026-11-16T10:00:00.000001Z";
    const c = new SyncPageCollector();
    c.add(parseSyncPage(page([row(1, at), row(2, at)], null)));
    expect(c.finish().records).toHaveLength(2);
    const d = new SyncPageCollector();
    expect(codeOf(() => d.add(parseSyncPage(page([row(2, at), row(1, at)], null))))).toBe("pagination_invalid");
  });
  it("microsecond order is respected (no millisecond rounding)", () => {
    const c = new SyncPageCollector();
    expect(
      codeOf(() => c.add(parseSyncPage(page([row(1, "2026-11-16T10:00:00.000002Z"), row(2, "2026-11-16T10:00:00.000001Z")], null)))),
    ).toBe("pagination_invalid");
  });
  it.each([
    ["a changed snapshot", [page([row(1)], "c1"), page([row(2)], null, { snapshot_at: "2026-11-16T12:00:01Z" })], "snapshot_changed"],
    ["a repeated cursor", [page([row(1)], "c1"), page([row(2)], "c1")], "pagination_invalid"],
    ["a repeated id", [page([row(1)], "c1"), page([row(1, "2026-11-16T11:00:00Z")], null)], "pagination_invalid"],
    ["going backwards", [page([row(5)], "c1"), page([row(2)], null)], "pagination_invalid"],
    ["a row newer than the snapshot", [page([row(1, "2026-11-16T13:00:00Z")], null)], "pagination_invalid"],
    ["a page after completion", [page([row(1)], null), page([row(2)], null)], "pagination_invalid"],
    ["a row without a usable id", [page([{ id: "x", updated_at: SNAP }], null)], "malformed_record"],
  ])("%s → %s, before anything is returned", (_n, pages, code) => {
    const c = new SyncPageCollector();
    expect(
      codeOf(() => {
        for (const p of pages) c.add(parseSyncPage(p));
      }),
    ).toBe(code);
  });
  it("a truncated run (no completing page) can't be finished", () => {
    const c = new SyncPageCollector();
    c.add(parseSyncPage(page([row(1)], "c1")));
    expect(codeOf(() => c.finish())).toBe("pagination_invalid");
  });
  it("page and time budgets are enforced", () => {
    const c = new SyncPageCollector({ maxPages: 1, maxRecords: 10, maxMillis: 1000 });
    c.add(parseSyncPage(page([row(1)], "c1")));
    expect(codeOf(() => c.add(parseSyncPage(page([row(2)], null))))).toBe("budget_exceeded");
    let t = 0;
    const slow = new SyncPageCollector({ maxPages: 10, maxRecords: 10, maxMillis: 1000 }, () => t);
    slow.add(parseSyncPage(page([row(1)], "c1")));
    t = 5000;
    expect(codeOf(() => slow.add(parseSyncPage(page([row(2)], null))))).toBe("budget_exceeded");
    const many = new SyncPageCollector({ maxPages: 10, maxRecords: 1, maxMillis: 1000 });
    expect(codeOf(() => many.add(parseSyncPage(page([row(1), row(2)], null))))).toBe("budget_exceeded");
  });
});

const live = (over: Record<string, unknown> = {}) => ({
  id: id(1).toUpperCase(),
  created_at: "2026-11-16T09:00:00Z",
  updated_at: "2026-11-16T10:00:00.000001Z",
  deleted_at: null,
  status: "pending",
  referral_received_at: "2026-11-16T09:00:00Z",
  age: 70,
  sex: "female",
  current_ward: "SYN",
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
  ...over,
});

describe("referral rows as CCC sends them", () => {
  it("a producer-shaped live row (explicit deleted_at:null) maps to the allowlist only", () => {
    const src = {
      ...live(),
      hospital_number_enc: "cipher",
      hospital_number_hash: "hash",
      reason_for_referral_enc: "cipher",
      created_by: id(9),
      updated_by: id(9),
      deleted_by: null,
      origin_booking_id: id(8),
      previous_referral_id: id(7),
    };
    const m = mapReferral(src);
    expect(m.kind).toBe("live");
    const payload = referralImportPayload(m);
    expect(payload.id).toBe(id(1));
    for (const k of ["hospital_number_enc", "hospital_number_hash", "reason_for_referral_enc", "created_by", "updated_by", "deleted_by", "origin_booking_id", "previous_referral_id", "kind"])
      expect(payload).not.toHaveProperty(k);
    expect(payload.deleted_at).toBeNull();
  });
  it("a live row without deleted_at, or missing any allowlisted field, fails", () => {
    const { deleted_at: _d, ...noDeleted } = live();
    expect(codeOf(() => mapReferral(noDeleted))).toBe("malformed_record");
    const { news2_score: _n, ...missing } = live();
    expect(codeOf(() => mapReferral(missing))).toBe("malformed_record");
    expect(codeOf(() => mapReferral(live({ status: "unknown" })))).toBe("malformed_record");
  });
  it("a minimal tombstone is recognised first and carries nothing else", () => {
    const t = { id: id(2), updated_at: "2026-11-16T11:00:00Z", deleted_at: "2026-11-16T11:00:00Z" };
    expect(mapReferral(t)).toEqual({ kind: "tombstone", ...t });
    expect(referralImportPayload(mapReferral(t))).toEqual(t);
  });
  it("a tombstone with extra (live) fields, or a bad deleted_at, fails the batch", () => {
    expect(codeOf(() => mapReferral({ ...live(), deleted_at: "2026-11-16T11:00:00Z" }))).toBe("malformed_record");
    expect(codeOf(() => mapReferral({ id: id(2), updated_at: "2026-11-16T11:00:00Z", deleted_at: "yesterday" }))).toBe("malformed_record");
    expect(codeOf(() => mapReferral({ id: id(2), deleted_at: "2026-11-16T11:00:00Z" }))).toBe("malformed_record");
  });
});

describe("canonical result rows", () => {
  it("microbiology arrives as specimen_type / result_at; nothing is inferred", () => {
    const m = mapResult("microbiology", {
      id: id(3), patient_id: id(4), specimen_type: "Blood culture",
      findings: "Sample: Blood culture\nOrganism: none", result_at: "2026-11-16T08:00:00Z",
      created_at: "2026-11-16T08:00:00Z", updated_at: "2026-11-16T08:00:00Z",
    });
    expect(m).toMatchObject({ type: "Blood culture", result_at: "2026-11-16T08:00:00Z", deleted: false });
    expect(codeOf(() => mapResult("microbiology", { id: id(3), patient_id: id(4), sample_type: "Blood", findings: "x", reported_at: "2026-11-16T08:00:00Z", created_at: "2026-11-16T08:00:00Z", updated_at: "2026-11-16T08:00:00Z" }))).toBe("malformed_record");
  });
});

describe("legacy review feeds (audit / notifications) never look complete when they might not be", () => {
  const recs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `r${i}` }));
  it("below the bound: accepted, including empty", () => {
    expect(parseLegacyRecords({ records: [] })).toEqual([]);
    expect(parseLegacyRecords({ records: recs(3) })).toHaveLength(3);
  });
  it("exactly at the bound without proof of completeness: refused as possibly truncated", () => {
    expect(codeOf(() => parseLegacyRecords({ records: recs(LEGACY_REVIEW_LIMIT) }))).toBe("review_truncated");
    expect(parseLegacyRecords({ records: recs(LEGACY_REVIEW_LIMIT), pagination: { complete: true, next_cursor: null } })).toHaveLength(LEGACY_REVIEW_LIMIT);
  });
  it("over the bound, flagged truncated, or a missing list: refused", () => {
    expect(codeOf(() => parseLegacyRecords({ records: recs(LEGACY_REVIEW_LIMIT + 1) }))).toBe("budget_exceeded");
    expect(codeOf(() => parseLegacyRecords({ records: recs(1), has_more: true }))).toBe("review_truncated");
    expect(codeOf(() => parseLegacyRecords({ records: recs(1), pagination: { complete: false, next_cursor: "c" } }))).toBe("review_truncated");
    expect(codeOf(() => parseLegacyRecords({ records: null }))).toBe("malformed_response");
    expect(codeOf(() => parseLegacyRecords({}))).toBe("malformed_response");
  });
});
