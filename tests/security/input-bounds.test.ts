import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  findBoundsViolation,
  assertInputBounds,
  InputTooLargeError,
  SERVER_FN_INPUT_BOUNDS,
  BRIDGE_INPUT_BOUNDS,
} from "@/lib/input-bounds";
import { PATIENT_ARRAY_FIELDS } from "@/lib/patient-schema";

// GHSA-mrhx-c7xc-m3w5: synthetic payloads only, with bounded lengths
// (largest list here is 50,000 short items; nothing touches a backend).

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

describe("Zod 3 behaviour that makes pre-validation necessary", () => {
  it("still checks every element after a .max() limit fails (one issue per bad element)", () => {
    const schema = z.object(PATIENT_ARRAY_FIELDS);
    const r = schema.safeParse({ resp_support: Array.from({ length: 5_000 }, () => 1) });
    expect(r.success).toBe(false);
    // 1 "too big" issue + 5,000 element issues. If this drops to a handful,
    // Zod has been upgraded to a patched release that stops early.
    expect(r.error!.issues.length).toBe(5_001);
  });
});

describe("server-function bounds (run before sign-in check and Zod)", () => {
  it("rejects a list longer than 1,000 items without reading the items", () => {
    expect(findBoundsViolation({ ids: Array.from({ length: 1_001 }, (_, i) => uuid(i)) }, SERVER_FN_INPUT_BOUNDS)).toBe("array_too_long");
  });

  it("rejects a huge sparse list in bounded time", () => {
    const t = performance.now();
    expect(findBoundsViolation({ ids: new Array(50_000_000) }, SERVER_FN_INPUT_BOUNDS)).toBe("array_too_long");
    expect(performance.now() - t).toBeLessThan(50);
  });

  it("rejects an object with more than 500 keys (e.g. daily_goals record)", () => {
    const daily_goals: Record<string, boolean> = {};
    for (let i = 0; i < 501; i++) daily_goals[`g${i}`] = true;
    expect(findBoundsViolation({ patch: { daily_goals } }, SERVER_FN_INPUT_BOUNDS)).toBe("too_many_keys");
  });

  it("rejects many individually-allowed lists that together exceed 20,000 items", () => {
    const lists = Array.from({ length: 25 }, () => Array.from({ length: 1_000 }, () => 0));
    expect(findBoundsViolation({ lists }, SERVER_FN_INPUT_BOUNDS)).toBe("too_many_nodes");
  });

  it("rejects nesting deeper than 32 levels", () => {
    let v: unknown = "leaf";
    for (let i = 0; i < 40; i++) v = { v };
    expect(findBoundsViolation(v, SERVER_FN_INPUT_BOUNDS)).toBe("too_deep");
  });

  it("rejects an oversized Set or Map", () => {
    expect(findBoundsViolation({ s: new Set(Array.from({ length: 1_001 }, (_, i) => i)) }, SERVER_FN_INPUT_BOUNDS)).toBe("array_too_long");
    expect(findBoundsViolation({ m: new Map(Array.from({ length: 1_001 }, (_, i) => [i, i])) }, SERVER_FN_INPUT_BOUNDS)).toBe("array_too_long");
  });

  it("throws the user-facing error from assertInputBounds", () => {
    expect(() => assertInputBounds({ ids: new Array(1_001).fill("x") }, SERVER_FN_INPUT_BOUNDS)).toThrow(InputTooLargeError);
  });

  // Allowed workflows: real-size payloads must pass untouched.
  it("allows a 500-patient handover export and a 500-patient sharing change", () => {
    const patientIds = Array.from({ length: 500 }, (_, i) => uuid(i));
    expect(findBoundsViolation({ patientIds, columns: { observations: true } }, SERVER_FN_INPUT_BOUNDS)).toBeNull();
    expect(findBoundsViolation({ ids: patientIds, shared: true }, SERVER_FN_INPUT_BOUNDS)).toBeNull();
  });

  it("allows a fully filled patient form with every list at its schema maximum", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `x${i}`);
    const patient: Record<string, unknown> = {
      resp_support: list(10), vasoactive_agents: list(10), sedative_agents: list(20),
      pca_agents: list(10), regional_analgesia: list(10), nutrition_route: list(10),
      anticoagulation: list(10), tep_exclusions: ["hfno", "niv", "ivv", "cvvh", "vasopressors"],
      antimicrobials: Array.from({ length: 30 }, (_, i) => ({ name: `a${i}`, started_on: "2026-01-01", ended_on: null })),
      allergies: Array.from({ length: 50 }, (_, i) => ({ substance: `s${i}`, reaction: "r", severity: "mild" })),
      daily_goals: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`goal_${i}`, i % 2 === 0])),
    };
    for (let i = 0; i < 120; i++) patient[`field_${i}`] = "x".repeat(10_000);
    expect(findBoundsViolation({ id: uuid(1), patch: patient }, SERVER_FN_INPUT_BOUNDS)).toBeNull();
  });

  it("allows a 60-bed unit set-up and a 3-page chart scan", () => {
    const beds = Array.from({ length: 60 }, (_, i) => ({ label: `Bed ${i}`, bay: "A", sort_order: i, active: true, side_room: false }));
    expect(findBoundsViolation({ unitId: uuid(1), beds }, SERVER_FN_INPUT_BOUNDS)).toBeNull();
    const pages = Array.from({ length: 3 }, () => "data:image/jpeg;base64," + "A".repeat(200_000));
    expect(findBoundsViolation({ patientId: uuid(2), pages }, SERVER_FN_INPUT_BOUNDS)).toBeNull();
  });

  it("treats strings, numbers, booleans, null and dates as leaves", () => {
    expect(findBoundsViolation("x".repeat(1_000_000), SERVER_FN_INPUT_BOUNDS)).toBeNull();
    expect(findBoundsViolation(undefined, SERVER_FN_INPUT_BOUNDS)).toBeNull();
    expect(findBoundsViolation({ at: new Date(0), n: 1, b: false, z: null }, SERVER_FN_INPUT_BOUNDS)).toBeNull();
  });
});

describe("partner-link bounds", () => {
  it("rejects a structured patient list longer than 200 items", () => {
    expect(findBoundsViolation({ full_name: "Z.Q.", resp_support: new Array(201).fill("hfno") }, BRIDGE_INPUT_BOUNDS)).toBe("array_too_long");
  });
  it("allows a full partner patient record", () => {
    const rec: Record<string, unknown> = { full_name: "Z.Q.", resp_support: ["hfno"], sedative_agents: new Array(20).fill("p") };
    for (let i = 0; i < 150; i++) rec[`col_${i}`] = "x".repeat(5_000);
    expect(findBoundsViolation(rec, BRIDGE_INPUT_BOUNDS)).toBeNull();
  });
});
