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

describe("bridge patient sync (e2e)", () => {
  beforeAll(() => {
    if (!SECRET) {
      throw new Error(
        "HANDOVER_API_SECRET is required to run the bridge e2e test. " +
          "Set it in the environment before running vitest.",
      );
    }
  });

  it("inserts an outlying-ward referral and exposes only agreed identity fields", async () => {
    const marker = `H-E2E-${Date.now()}`;
    const payload = JSON.stringify({
      full_name: "Z.Q.",
      age: 72,
      hospital_number: marker,
      location_type: "outlier",
      ward: "Farley",
      status: "referred",
    });

    // 1. Insert the sample outlying-ward referral.
    const post = await bridge("POST", "/api/public/bridge/patients", payload);
    expect(post.status, `POST failed: ${post.text}`).toBe(200);

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
      const payload = JSON.stringify({
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
      });

      // Insert via the live bridge endpoint.
      const post = await bridge("POST", "/api/public/bridge/patients", payload);
      expect(post.status, `POST (${status}) failed: ${post.text}`).toBe(200);
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
});
