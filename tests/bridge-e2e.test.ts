import { describe, it, expect, beforeAll } from "vitest";
import { createHmac } from "crypto";

/**
 * End-to-end test for the cross-project patient bridge.
 *
 * Inserts a sample outlying-ward referral through the live bridge endpoint and
 * verifies that the serialized partner payload exposes only the identity fields
 * the two projects agreed on — full_name (initials), age, and hospital_number —
 * and that the removed demographic fields (dob / nhs_number / date_of_birth /
 * full patient name) never appear.
 *
 * Requires:
 *   HANDOVER_API_SECRET  — shared HMAC secret (same value on both backends)
 *   BRIDGE_BASE_URL      — base URL to hit (defaults to local dev server)
 *
 * Run:  HANDOVER_API_SECRET=... bunx vitest run tests/bridge-e2e.test.ts
 */

const BASE_URL = process.env.BRIDGE_BASE_URL ?? "http://localhost:8080";
const SECRET = process.env.HANDOVER_API_SECRET ?? "";
// The partner bridge only ever exposes patients an administrator has explicitly
// marked as shared (patients.shared_with_partner = true). Bridge writes cannot
// flip that governance flag (the admin-only guard trigger blocks it, and the
// flag is not part of the bridge upsert schema), so e2e fixtures must be seeded
// as shared directly via the admin Data API — the flag may only be set on INSERT.
const SUPABASE_URL = (process.env.SUPABASE_URL ?? "").replace(/\/$/, "");
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

// The only demographic/identity fields that may describe a patient.
const ALLOWED_IDENTITY_FIELDS = ["full_name", "age", "hospital_number"] as const;
// Fields removed from the schema that must never appear in any payload.
const FORBIDDEN_FIELDS = ["dob", "date_of_birth", "nhs_number", "patient_name", "name"] as const;

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function sign(timestamp: string, actor: string, body: string): string {
  return createHmac("sha256", SECRET).update(`${timestamp}.${actor}.${body}`).digest("hex");
}

async function bridge(method: "GET" | "POST", path: string, body = "") {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const actor = JSON.stringify({
    id: "00000000-0000-0000-0000-000000000001",
    email: "bridge-e2e@sdh.nhs",
    role: "admin",
  });
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      "User-Agent": BROWSER_UA,
      "x-timestamp": timestamp,
      "x-actor": actor,
      "x-signature": sign(timestamp, actor, body),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });
  const text = await res.text();
  let jsonBody: unknown = null;
  try {
    jsonBody = JSON.parse(text);
  } catch {
    /* non-JSON response (e.g. HTML) — leave as null */
  }
  return { status: res.status, json: jsonBody, text };
}

/**
 * Seed a patient fixture directly via the admin Data API, marked as shared with
 * the partner so it is visible to the bridge GET pull. INSERTing the
 * shared_with_partner flag is permitted (the admin-only guard trigger only
 * fires on UPDATE of the flag), whereas the bridge upsert endpoint can never
 * set it. The return shape mirrors `bridge(...)` so callers can treat a seeded
 * create exactly like a bridge create.
 */
async function seedSharedPatient(fields: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/patients`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({ ...fields, shared_with_partner: true }),
  });
  const text = await res.text();
  let rows: unknown = null;
  try {
    rows = JSON.parse(text);
  } catch {
    /* non-JSON error body — leave as null */
  }
  const patient = Array.isArray(rows) ? rows[0] : rows;
  // Normalise the 201 Created from PostgREST to the 200 the bridge returns.
  return { status: res.status === 201 ? 200 : res.status, json: { patient }, text };
}

describe("bridge patient sync (e2e)", () => {
  beforeAll(() => {
    if (!SECRET) {
      throw new Error(
        "HANDOVER_API_SECRET is required to run the bridge e2e test. " +
          "Set it in the environment before running vitest.",
      );
    }
    if (!SUPABASE_URL || !SERVICE_KEY) {
      throw new Error(
        "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required to run the bridge " +
          "e2e test: fixtures are seeded as shared-with-partner via the admin Data API.",
      );
    }
  });

  it("inserts an outlying-ward referral and exposes only agreed identity fields", async () => {
    const marker = `H-E2E-${Date.now()}`;
    const payload = {
      full_name: "Z.Q.",
      age: 72,
      hospital_number: marker,
      location_type: "outlier",
      ward: "Farley",
      status: "referred",
    };

    // 1. Seed the sample outlying-ward referral as shared with the partner.
    const post = await seedSharedPatient(payload);
    expect(post.status, `seed failed: ${post.text}`).toBe(200);

    const created = (post.json as { patient?: Record<string, unknown> })?.patient;
    expect(created, "POST response missing `patient`").toBeTruthy();
    const patient = created as Record<string, unknown>;

    // 2. The identity values round-tripped correctly.
    expect(patient.full_name).toBe("Z.Q.");
    expect(patient.age).toBe(72);
    expect(patient.hospital_number).toBe(marker);

    // 3. No removed demographic field is present in the partner payload.
    for (const field of FORBIDDEN_FIELDS) {
      expect(field in patient, `payload must not contain "${field}"`).toBe(false);
    }

    // 4. Every allowed identity field is present.
    for (const field of ALLOWED_IDENTITY_FIELDS) {
      expect(field in patient, `payload must contain "${field}"`).toBe(true);
    }

    // 5. The record is discoverable via the partner GET pull with the same
    //    guarantees, then clean up the test row.
    const list = await bridge("GET", "/api/public/bridge/patients?status=referred");
    expect(list.status, `GET failed: ${list.text}`).toBe(200);
    const patients = (list.json as { patients?: Record<string, unknown>[] })?.patients ?? [];
    const found = patients.find((p) => p.hospital_number === marker);
    expect(found, "inserted referral not returned by partner pull").toBeTruthy();
    for (const field of FORBIDDEN_FIELDS) {
      expect(field in (found as Record<string, unknown>)).toBe(false);
    }

    // Cleanup: remove the e2e test row so it never lingers in clinical data.
    if (found?.id) {
      await bridge(
        "POST",
        "/api/public/bridge/patients",
        JSON.stringify({ id: found.id, full_name: "Z.Q.", status: "discharged" }),
      );
    }
  }, 30_000);

  it("keeps identity fields limited to full_name/age/hospital_number across every referral status", async () => {
    // Every lifecycle status an outlying-ward referral can move through. The
    // identity contract must hold regardless of status, so exercise them all.
    const STATUSES = ["referred", "admitted", "discharged", "died"] as const;
    const createdIds: string[] = [];

    for (const status of STATUSES) {
      const marker = `H-E2E-${status}-${Date.now()}`;
      const payload = {
        full_name: "Y.X.",
        age: 65,
        hospital_number: marker,
        location_type: "outlier",
        ward: "Farley",
        status,
        // Status-specific fields, to prove they never leak identity data.
        ...(status === "discharged"
          ? { discharge_date: new Date().toISOString(), discharge_destination: "Ward 5" }
          : {}),
        ...(status === "died" ? { date_of_death: new Date().toISOString() } : {}),
      };

      // Seed as shared with the partner via the admin Data API.
      const post = await seedSharedPatient(payload);
      expect(post.status, `seed (${status}) failed: ${post.text}`).toBe(200);
      const patient = (post.json as { patient?: Record<string, unknown> })?.patient;
      expect(patient, `POST (${status}) missing patient`).toBeTruthy();
      const created = patient as Record<string, unknown>;
      if (typeof created.id === "string") createdIds.push(created.id);

      // Identity values round-tripped.
      expect(created.full_name, `full_name mismatch for ${status}`).toBe("Y.X.");
      expect(created.age, `age mismatch for ${status}`).toBe(65);
      expect(created.hospital_number, `hospital_number mismatch for ${status}`).toBe(marker);

      // Contract: every allowed identity field present, no forbidden field.
      const assertIdentityContract = (row: Record<string, unknown>, where: string) => {
        for (const field of ALLOWED_IDENTITY_FIELDS) {
          expect(field in row, `${where} (${status}) must contain "${field}"`).toBe(true);
        }
        for (const field of FORBIDDEN_FIELDS) {
          expect(field in row, `${where} (${status}) must not contain "${field}"`).toBe(false);
        }
      };
      assertIdentityContract(created, "POST payload");

      // Same guarantees on the partner GET pull, filtered by this status.
      const list = await bridge("GET", `/api/public/bridge/patients?status=${status}`);
      expect(list.status, `GET (${status}) failed: ${list.text}`).toBe(200);
      const rows = (list.json as { patients?: Record<string, unknown>[] })?.patients ?? [];
      const found = rows.find((p) => p.hospital_number === marker);
      expect(found, `referral (${status}) not returned by partner pull`).toBeTruthy();
      assertIdentityContract(found as Record<string, unknown>, "GET payload");
    }

    // Cleanup: mark every e2e row discharged so it never lingers in clinical data.
    for (const id of createdIds) {
      await bridge(
        "POST",
        "/api/public/bridge/patients",
        JSON.stringify({ id, full_name: "Y.X.", status: "discharged" }),
      );
    }
  }, 60_000);

  it("edits a discharged patient record and confirms changes persist and stay editable", async () => {
    const marker = `H-E2E-EDIT-${Date.now()}`;

    // 1. Seed the patient (shared with partner) and immediately discharge it.
    const create = await seedSharedPatient({
      full_name: "D.C.",
      age: 80,
      hospital_number: marker,
      location_type: "outlier",
      ward: "Farley",
      status: "discharged",
      discharge_date: new Date().toISOString(),
      discharge_destination: "Ward 3",
      current_management: "Initial management note",
      outstanding_tasks: "Follow up bloods",
    });
    expect(create.status, `create failed: ${create.text}`).toBe(200);
    const createdPatient = (create.json as { patient?: Record<string, unknown> })?.patient;
    expect(createdPatient, "create response missing `patient`").toBeTruthy();
    const created = createdPatient as Record<string, unknown>;
    const id = created.id as string;
    expect(id, "created patient missing id").toBeTruthy();
    expect(created.status).toBe("discharged");

    // 2. Edit the discharged record's clinical fields.
    const firstEdit = await bridge(
      "POST",
      "/api/public/bridge/patients",
      JSON.stringify({
        id,
        full_name: "D.C.",
        status: "discharged",
        current_management: "Updated plan: escalate antibiotics",
        outstanding_tasks: "Chase microbiology culture results",
        discharge_destination: "District General Ward 7",
      }),
    );
    expect(firstEdit.status, `first edit failed: ${firstEdit.text}`).toBe(200);
    const editedPatient = (firstEdit.json as { patient?: Record<string, unknown> })?.patient;
    expect(editedPatient, "edit response missing `patient`").toBeTruthy();
    const edited = editedPatient as Record<string, unknown>;
    expect(edited.current_management).toBe("Updated plan: escalate antibiotics");
    expect(edited.outstanding_tasks).toBe("Chase microbiology culture results");
    expect(edited.discharge_destination).toBe("District General Ward 7");
    // Still discharged; the edit did not change the lifecycle state.
    expect(edited.status).toBe("discharged");
    // The write bumped the version timestamp.
    expect(edited.updated_at).not.toBe(created.updated_at);

    // 3. The changes persist — re-read the record via the partner pull.
    const list = await bridge("GET", "/api/public/bridge/patients?status=discharged");
    expect(list.status, `list failed: ${list.text}`).toBe(200);
    const rows = (list.json as { patients?: Record<string, unknown>[] })?.patients ?? [];
    const persisted = rows.find((p) => p.id === id);
    expect(persisted, "edited discharged record not returned by partner pull").toBeTruthy();
    const persistedRow = persisted as Record<string, unknown>;
    expect(persistedRow.current_management).toBe("Updated plan: escalate antibiotics");
    expect(persistedRow.outstanding_tasks).toBe("Chase microbiology culture results");
    expect(persistedRow.discharge_destination).toBe("District General Ward 7");

    // 4. The record remains editable after discharge — a second edit succeeds
    //    with optimistic-concurrency using the latest updated_at.
    const secondEdit = await bridge(
      "POST",
      "/api/public/bridge/patients",
      JSON.stringify({
        id,
        full_name: "D.C.",
        status: "discharged",
        expected_updated_at: persistedRow.updated_at,
        current_management: "Second revision: for GP follow-up",
      }),
    );
    expect(secondEdit.status, `second edit failed: ${secondEdit.text}`).toBe(200);
    const secondPatient = (secondEdit.json as { patient?: Record<string, unknown> })?.patient;
    expect(secondPatient, "second edit response missing `patient`").toBeTruthy();
    const second = secondPatient as Record<string, unknown>;
    expect(second.current_management).toBe("Second revision: for GP follow-up");
    expect(second.updated_at).not.toBe(persistedRow.updated_at);

    // 5. A stale write (using the now-outdated timestamp) is rejected, proving
    //    the record is guarded by optimistic concurrency, not frozen.
    const staleEdit = await bridge(
      "POST",
      "/api/public/bridge/patients",
      JSON.stringify({
        id,
        full_name: "D.C.",
        status: "discharged",
        expected_updated_at: persistedRow.updated_at,
        current_management: "This should be rejected",
      }),
    );
    expect(staleEdit.status, "stale write should be rejected with 409").toBe(409);
  }, 60_000);

  it("transitions a patient from admitted to discharged, keeps the historical record visible, and stays editable after discharge", async () => {
    const marker = `H-E2E-DISCHARGE-${Date.now()}`;

    // 1. Admit the patient (status = admitted), seeded as shared with partner.
    const create = await seedSharedPatient({
      full_name: "M.R.",
      age: 66,
      hospital_number: marker,
      location_type: "icu",
      ward: "Critical Care",
      bed: "7",
      status: "admitted",
      admission_date: new Date().toISOString(),
      current_management: "Ventilated, sedation weaning in progress",
      outstanding_tasks: "Repeat ABG in the morning",
    });
    expect(create.status, `create failed: ${create.text}`).toBe(200);
    const createdPatient = (create.json as { patient?: Record<string, unknown> })?.patient;
    expect(createdPatient, "create response missing `patient`").toBeTruthy();
    const created = createdPatient as Record<string, unknown>;
    const id = created.id as string;
    expect(id, "created patient missing id").toBeTruthy();
    expect(created.status).toBe("admitted");
    expect(created.discharge_destination ?? null).toBeNull();

    // The admitted record shows up in the "admitted" partner pull.
    const admittedList = await bridge("GET", "/api/public/bridge/patients?status=admitted");
    expect(admittedList.status, `admitted list failed: ${admittedList.text}`).toBe(200);
    const admittedRows =
      (admittedList.json as { patients?: Record<string, unknown>[] })?.patients ?? [];
    expect(
      admittedRows.some((p) => p.id === id),
      "newly admitted record not returned by the admitted partner pull",
    ).toBe(true);

    // 2. Transition the lifecycle: admitted -> discharged, recording the
    //    discharge date and destination.
    const dischargeDate = new Date().toISOString();
    const discharge = await bridge(
      "POST",
      "/api/public/bridge/patients",
      JSON.stringify({
        id,
        full_name: "M.R.",
        status: "discharged",
        expected_updated_at: created.updated_at,
        discharge_date: dischargeDate,
        discharge_destination: "Ward 4 (step-down)",
      }),
    );
    expect(discharge.status, `discharge failed: ${discharge.text}`).toBe(200);
    const dischargedPatient = (discharge.json as { patient?: Record<string, unknown> })?.patient;
    expect(dischargedPatient, "discharge response missing `patient`").toBeTruthy();
    const discharged = dischargedPatient as Record<string, unknown>;
    expect(discharged.status).toBe("discharged");
    expect(discharged.discharge_destination).toBe("Ward 4 (step-down)");
    expect(discharged.discharge_date).toBeTruthy();
    // The lifecycle change bumped the version timestamp.
    expect(discharged.updated_at).not.toBe(created.updated_at);

    // 3. Historical record remains visible: it now appears in the "discharged"
    //    pull and has dropped out of the "admitted" pull (not deleted).
    const dischargedList = await bridge("GET", "/api/public/bridge/patients?status=discharged");
    expect(dischargedList.status, `discharged list failed: ${dischargedList.text}`).toBe(200);
    const dischargedRows =
      (dischargedList.json as { patients?: Record<string, unknown>[] })?.patients ?? [];
    const persisted = dischargedRows.find((p) => p.id === id);
    expect(persisted, "discharged record not returned by the discharged partner pull").toBeTruthy();
    const persistedRow = persisted as Record<string, unknown>;
    expect(persistedRow.status).toBe("discharged");
    expect(persistedRow.discharge_destination).toBe("Ward 4 (step-down)");
    // Clinical history captured while admitted is retained after discharge.
    expect(persistedRow.current_management).toBe("Ventilated, sedation weaning in progress");

    const admittedAfter = await bridge("GET", "/api/public/bridge/patients?status=admitted");
    expect(admittedAfter.status, `admitted re-pull failed: ${admittedAfter.text}`).toBe(200);
    const admittedAfterRows =
      (admittedAfter.json as { patients?: Record<string, unknown>[] })?.patients ?? [];
    expect(
      admittedAfterRows.some((p) => p.id === id),
      "discharged record must no longer appear in the admitted partner pull",
    ).toBe(false);

    // 4. The record stays editable after discharge — revise the clinical notes
    //    and discharge destination on the discharged record.
    const edit = await bridge(
      "POST",
      "/api/public/bridge/patients",
      JSON.stringify({
        id,
        full_name: "M.R.",
        status: "discharged",
        expected_updated_at: persistedRow.updated_at,
        discharge_destination: "Community rehabilitation unit",
        current_management: "Discharge summary completed; GP follow-up arranged",
      }),
    );
    expect(edit.status, `post-discharge edit failed: ${edit.text}`).toBe(200);
    const editedPatient = (edit.json as { patient?: Record<string, unknown> })?.patient;
    expect(editedPatient, "post-discharge edit response missing `patient`").toBeTruthy();
    const edited = editedPatient as Record<string, unknown>;
    expect(edited.status).toBe("discharged");
    expect(edited.discharge_destination).toBe("Community rehabilitation unit");
    expect(edited.current_management).toBe(
      "Discharge summary completed; GP follow-up arranged",
    );

    // The post-discharge edit persists across the partner sync.
    const finalList = await bridge("GET", "/api/public/bridge/patients?status=discharged");
    expect(finalList.status, `final list failed: ${finalList.text}`).toBe(200);
    const finalRows =
      (finalList.json as { patients?: Record<string, unknown>[] })?.patients ?? [];
    const finalRow = finalRows.find((p) => p.id === id) as Record<string, unknown> | undefined;
    expect(finalRow, "edited discharged record not returned by partner pull").toBeTruthy();
    expect((finalRow as Record<string, unknown>).discharge_destination).toBe(
      "Community rehabilitation unit",
    );
    expect((finalRow as Record<string, unknown>).current_management).toBe(
      "Discharge summary completed; GP follow-up arranged",
    );
  }, 60_000);



  it("records a treatment escalation plan and DNACPR decision that persist after discharge and stay editable", async () => {
    const marker = `H-E2E-TEP-${Date.now()}`;
    const dnacprDate = "2026-07-10";

    // 1. Admit a patient with an active treatment escalation plan (TEP) and a
    //    decision not to attempt CPR (DNACPR) fully documented, seeded as shared.
    const create = await seedSharedPatient({
      full_name: "T.E.",
      age: 78,
      hospital_number: marker,
      location_type: "icu",
      ward: "Critical Care",
      status: "admitted",
      tep_in_place: true,
      tep_details: "Ward-based care only. Not for intubation or filtration. For ward-level NIV.",
      dnacpr_decision: true,
      dnacpr_details: "DNACPR agreed with patient and family. Not for chest compressions.",
      dnacpr_date: dnacprDate,
    });
    expect(create.status, `create failed: ${create.text}`).toBe(200);
    const createdPatient = (create.json as { patient?: Record<string, unknown> })?.patient;
    expect(createdPatient, "create response missing `patient`").toBeTruthy();
    const created = createdPatient as Record<string, unknown>;
    const id = created.id as string;
    expect(id, "created patient missing id").toBeTruthy();

    // The escalation plan and resuscitation decision round-tripped on create.
    expect(created.tep_in_place).toBe(true);
    expect(created.tep_details).toBe(
      "Ward-based care only. Not for intubation or filtration. For ward-level NIV.",
    );
    expect(created.dnacpr_decision).toBe(true);
    expect(created.dnacpr_details).toBe(
      "DNACPR agreed with patient and family. Not for chest compressions.",
    );
    expect(String(created.dnacpr_date)).toContain(dnacprDate);

    // 2. Discharge the patient — the escalation/resuscitation fields must not be
    //    cleared by the lifecycle change.
    const discharge = await bridge(
      "POST",
      "/api/public/bridge/patients",
      JSON.stringify({
        id,
        full_name: "T.E.",
        status: "discharged",
        discharge_date: new Date().toISOString(),
        discharge_destination: "Ward 6",
      }),
    );
    expect(discharge.status, `discharge failed: ${discharge.text}`).toBe(200);
    const dischargedPatient = (discharge.json as { patient?: Record<string, unknown> })?.patient;
    expect(dischargedPatient, "discharge response missing `patient`").toBeTruthy();
    const discharged = dischargedPatient as Record<string, unknown>;
    expect(discharged.status).toBe("discharged");
    // TEP and DNACPR survived the discharge write.
    expect(discharged.tep_in_place).toBe(true);
    expect(discharged.tep_details).toBe(
      "Ward-based care only. Not for intubation or filtration. For ward-level NIV.",
    );
    expect(discharged.dnacpr_decision).toBe(true);
    expect(discharged.dnacpr_details).toBe(
      "DNACPR agreed with patient and family. Not for chest compressions.",
    );

    // 3. Persistence check — re-read the discharged record via the partner pull.
    const list = await bridge("GET", "/api/public/bridge/patients?status=discharged");
    expect(list.status, `list failed: ${list.text}`).toBe(200);
    const rows = (list.json as { patients?: Record<string, unknown>[] })?.patients ?? [];
    const persisted = rows.find((p) => p.id === id);
    expect(persisted, "discharged record not returned by partner pull").toBeTruthy();
    const persistedRow = persisted as Record<string, unknown>;
    expect(persistedRow.tep_in_place).toBe(true);
    expect(persistedRow.tep_details).toBe(
      "Ward-based care only. Not for intubation or filtration. For ward-level NIV.",
    );
    expect(persistedRow.dnacpr_decision).toBe(true);
    expect(persistedRow.dnacpr_details).toBe(
      "DNACPR agreed with patient and family. Not for chest compressions.",
    );
    expect(String(persistedRow.dnacpr_date)).toContain(dnacprDate);

    // 4. The fields remain editable after discharge — revise the escalation plan
    //    and DNACPR details on the discharged record.
    const edit = await bridge(
      "POST",
      "/api/public/bridge/patients",
      JSON.stringify({
        id,
        full_name: "T.E.",
        status: "discharged",
        expected_updated_at: persistedRow.updated_at,
        tep_details: "Revised: for ceiling of care at ward level, comfort-focused.",
        dnacpr_details: "DNACPR reaffirmed at discharge; community DNACPR form issued.",
      }),
    );
    expect(edit.status, `edit failed: ${edit.text}`).toBe(200);
    const editedPatient = (edit.json as { patient?: Record<string, unknown> })?.patient;
    expect(editedPatient, "edit response missing `patient`").toBeTruthy();
    const edited = editedPatient as Record<string, unknown>;
    expect(edited.tep_in_place).toBe(true);
    expect(edited.tep_details).toBe(
      "Revised: for ceiling of care at ward level, comfort-focused.",
    );
    expect(edited.dnacpr_decision).toBe(true);
    expect(edited.dnacpr_details).toBe(
      "DNACPR reaffirmed at discharge; community DNACPR form issued.",
    );
    expect(edited.updated_at).not.toBe(persistedRow.updated_at);
  }, 60_000);

  it("updates next of kin details and last-updated stamp that persist across partner sync and stay editable", async () => {
    const marker = `H-E2E-NOK-${Date.now()}`;
    const firstStamp = "2026-07-10T09:00:00.000Z";

    // 1. Admit a patient with an initial set of next-of-kin details.
    const create = await bridge(
      "POST",
      "/api/public/bridge/patients",
      JSON.stringify({
        full_name: "N.K.",
        age: 69,
        hospital_number: marker,
        location_type: "icu",
        ward: "Critical Care",
        status: "admitted",
        nok_name: "Jane Kirby",
        nok_relationship: "Daughter",
        nok_contact: "07700 900111",
        nok_last_updated: firstStamp,
        nok_last_updated_by: "Dr A. Smith",
      }),
    );
    expect(create.status, `create failed: ${create.text}`).toBe(200);
    const createdPatient = (create.json as { patient?: Record<string, unknown> })?.patient;
    expect(createdPatient, "create response missing `patient`").toBeTruthy();
    const created = createdPatient as Record<string, unknown>;
    const id = created.id as string;
    expect(id, "created patient missing id").toBeTruthy();
    expect(created.nok_name).toBe("Jane Kirby");
    expect(created.nok_relationship).toBe("Daughter");
    expect(created.nok_contact).toBe("07700 900111");
    expect(String(created.nok_last_updated)).toContain("2026-07-10T09:00");
    expect(created.nok_last_updated_by).toBe("Dr A. Smith");

    // 2. Update the next-of-kin details and bump the last-updated stamp/author.
    const secondStamp = "2026-07-10T14:30:00.000Z";
    const update = await bridge(
      "POST",
      "/api/public/bridge/patients",
      JSON.stringify({
        id,
        full_name: "N.K.",
        status: "admitted",
        expected_updated_at: created.updated_at,
        nok_name: "Mark Kirby",
        nok_relationship: "Son",
        nok_contact: "07700 900222",
        nok_last_updated: secondStamp,
        nok_last_updated_by: "Nurse B. Jones",
      }),
    );
    expect(update.status, `update failed: ${update.text}`).toBe(200);
    const updatedPatient = (update.json as { patient?: Record<string, unknown> })?.patient;
    expect(updatedPatient, "update response missing `patient`").toBeTruthy();
    const updated = updatedPatient as Record<string, unknown>;
    expect(updated.nok_name).toBe("Mark Kirby");
    expect(updated.nok_relationship).toBe("Son");
    expect(updated.nok_contact).toBe("07700 900222");
    expect(String(updated.nok_last_updated)).toContain("2026-07-10T14:30");
    expect(updated.nok_last_updated_by).toBe("Nurse B. Jones");
    expect(updated.updated_at).not.toBe(created.updated_at);

    // 3. Persistence check — the updated NOK details survive the partner sync.
    const list = await bridge("GET", "/api/public/bridge/patients?status=admitted");
    expect(list.status, `list failed: ${list.text}`).toBe(200);
    const rows = (list.json as { patients?: Record<string, unknown>[] })?.patients ?? [];
    const persisted = rows.find((p) => p.id === id);
    expect(persisted, "updated record not returned by partner pull").toBeTruthy();
    const persistedRow = persisted as Record<string, unknown>;
    expect(persistedRow.nok_name).toBe("Mark Kirby");
    expect(persistedRow.nok_relationship).toBe("Son");
    expect(persistedRow.nok_contact).toBe("07700 900222");
    expect(String(persistedRow.nok_last_updated)).toContain("2026-07-10T14:30");
    expect(persistedRow.nok_last_updated_by).toBe("Nurse B. Jones");

    // 4. The NOK details remain editable — a further update succeeds with the
    //    latest updated_at and refreshes the last-updated stamp again.
    const thirdStamp = "2026-07-11T08:15:00.000Z";
    const edit = await bridge(
      "POST",
      "/api/public/bridge/patients",
      JSON.stringify({
        id,
        full_name: "N.K.",
        status: "admitted",
        expected_updated_at: persistedRow.updated_at,
        nok_contact: "07700 900333",
        nok_last_updated: thirdStamp,
        nok_last_updated_by: "Dr C. Patel",
      }),
    );
    expect(edit.status, `edit failed: ${edit.text}`).toBe(200);
    const editedPatient = (edit.json as { patient?: Record<string, unknown> })?.patient;
    expect(editedPatient, "edit response missing `patient`").toBeTruthy();
    const edited = editedPatient as Record<string, unknown>;
    // Unchanged fields retained; contact and stamp refreshed.
    expect(edited.nok_name).toBe("Mark Kirby");
    expect(edited.nok_relationship).toBe("Son");
    expect(edited.nok_contact).toBe("07700 900333");
    expect(String(edited.nok_last_updated)).toContain("2026-07-11T08:15");
    expect(edited.nok_last_updated_by).toBe("Dr C. Patel");
    expect(edited.updated_at).not.toBe(persistedRow.updated_at);
  }, 60_000);
});

describe("bridge patient endpoints reject unauthenticated / unauthorized callers", () => {
  beforeAll(() => {
    if (!SECRET) {
      throw new Error(
        "HANDOVER_API_SECRET is required to run the bridge e2e test. " +
          "Set it in the environment before running vitest.",
      );
    }
  });

  // Raw fetch that lets us omit or corrupt individual auth headers.
  async function rawFetch(
    method: "GET" | "POST",
    path: string,
    headers: Record<string, string>,
    body = "",
  ) {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: { "User-Agent": BROWSER_UA, ...headers },
      ...(body ? { body } : {}),
    });
    return { status: res.status, text: await res.text() };
  }

  const SAMPLE_BODY = JSON.stringify({ full_name: "N.A.", age: 50, status: "referred" });

  it("returns 401 when no authentication headers are supplied", async () => {
    const get = await rawFetch("GET", "/api/public/bridge/patients", {});
    expect(get.status, `GET without auth: ${get.text}`).toBe(401);

    const post = await rawFetch(
      "POST",
      "/api/public/bridge/patients",
      { "Content-Type": "application/json" },
      SAMPLE_BODY,
    );
    expect(post.status, `POST without auth: ${post.text}`).toBe(401);
  }, 30_000);

  it("returns 401 when the signature is invalid", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const actor = JSON.stringify({
      id: "00000000-0000-0000-0000-000000000001",
      email: "bridge-e2e@sdh.nhs",
      role: "admin",
    });
    const badHeaders = {
      "x-timestamp": timestamp,
      "x-actor": actor,
      "x-signature": "deadbeef".repeat(8), // not a valid HMAC of the payload
    };

    const get = await rawFetch("GET", "/api/public/bridge/patients", badHeaders);
    expect(get.status, `GET bad signature: ${get.text}`).toBe(401);

    const post = await rawFetch(
      "POST",
      "/api/public/bridge/patients",
      { ...badHeaders, "Content-Type": "application/json" },
      SAMPLE_BODY,
    );
    expect(post.status, `POST bad signature: ${post.text}`).toBe(401);
  }, 30_000);

  it("returns 403 when a correctly-signed caller has an unauthorized role", async () => {
    // Signed with the real secret, but the forwarded actor has a role the
    // bridge does not recognise, so it must be rejected as forbidden (403)
    // rather than unauthenticated (401).
    const timestamp = String(Math.floor(Date.now() / 1000));
    const actor = JSON.stringify({
      id: "00000000-0000-0000-0000-000000000009",
      email: "outsider@sdh.nhs",
      role: "viewer", // not in READ_ROLES / WRITE_ROLES
    });

    const getSig = sign(timestamp, actor, "");
    const get = await rawFetch("GET", "/api/public/bridge/patients", {
      "x-timestamp": timestamp,
      "x-actor": actor,
      "x-signature": getSig,
    });
    expect(get.status, `GET unauthorized role: ${get.text}`).toBe(403);

    const postSig = sign(timestamp, actor, SAMPLE_BODY);
    const post = await rawFetch(
      "POST",
      "/api/public/bridge/patients",
      {
        "x-timestamp": timestamp,
        "x-actor": actor,
        "x-signature": postSig,
        "Content-Type": "application/json",
      },
      SAMPLE_BODY,
    );
    expect(post.status, `POST unauthorized role: ${post.text}`).toBe(403);
  }, 30_000);
});
