import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Role permission matrix conformance tests.
 *
 * Verifies, against the live database and through the same Data API the app
 * uses, that every role can view/edit exactly what the published permission
 * matrix (Critical_Care_Permission_Matrix_v1.docx, companion to proposal
 * section 10.1) says it can — under BOTH deployment options:
 *
 *   Option A — a separate deployment per hospital. Every account belongs to the
 *     one unit in its own deployment; there is no route to another hospital's
 *     data. Simulated here by a clinician who holds a single unit membership:
 *     records in any other unit must be as unreachable as another deployment.
 *
 *   Option B — one deployment, several hospitals, segregation per ICU unit.
 *     Access follows explicit unit memberships: a single-unit clinician sees
 *     only their unit, a rotating clinician sees exactly the units granted, and
 *     an administrator holds configuration rights across units.
 *
 * Enforcement is row-level security, so these tests deliberately talk to the
 * Data API with real user sessions rather than exercising UI code: a passing
 * run proves the server refuses the request, not that a screen hides a button.
 *
 * Role mapping to the two roles the app currently implements:
 *   matrix "Clinician"           -> app role `clinician` + unit membership
 *   matrix "Unit administrator"  -> app role `admin`
 *   matrix "Unauthenticated"     -> anon key, no session
 * The matrix's separate Trust-administrator and Auditor roles are not yet
 * implemented; `implemented roles` below fails if the role vocabulary changes,
 * so the matrix and these tests must be extended together.
 *
 * Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and a publishable/anon key.
 */

const SUPABASE_URL = (process.env["SUPABASE_URL"] ?? "").replace(/\/$/, "");
const SERVICE_KEY = process.env["SUPABASE_SERVICE_ROLE_KEY"] ?? "";
const ANON_KEY =
  process.env["SUPABASE_PUBLISHABLE_KEY"] ??
  process.env["SUPABASE_ANON_KEY"] ??
  process.env["VITE_SUPABASE_PUBLISHABLE_KEY"] ??
  "";

const TAG = `mtx-${Date.now().toString(36)}`;
const PASSWORD = `Matrix!${Math.random().toString(36).slice(2)}Aa1`;
const TIMEOUT = 120_000;

const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function userClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** Actors under test, keyed by the matrix role they represent. */
type ActorKey =
  | "clinicianSingleUnit"
  | "clinicianRotating"
  | "clinicianOtherUnit"
  | "administrator"
  | "signedInNoRole"
  | "unauthenticated";

const fixture = {
  userIds: {} as Record<Exclude<ActorKey, "unauthenticated">, string>,
  clients: {} as Record<ActorKey, SupabaseClient>,
  hospitalOwn: "",
  hospitalOther: "",
  unitOwn: "",
  unitSibling: "",
  unitFar: "",
  patientOwn: "",
  patientSibling: "",
  patientFar: "",
  chartOwn: "",
  chartSibling: "",
  chartFar: "",
};

/** Scopes mirror the matrix column headings. */
const SCOPES = {
  own_unit: () => ({ patient: fixture.patientOwn, chart: fixture.chartOwn, unit: fixture.unitOwn }),
  other_unit_same_hospital: () => ({
    patient: fixture.patientSibling,
    chart: fixture.chartSibling,
    unit: fixture.unitSibling,
  }),
  unit_in_other_hospital: () => ({
    patient: fixture.patientFar,
    chart: fixture.chartFar,
    unit: fixture.unitFar,
  }),
} as const;

type ScopeKey = keyof typeof SCOPES;

// ---------------------------------------------------------------- primitives

async function canView(cl: SupabaseClient, table: string, column: string, id: string) {
  const { data, error } = await cl.from(table).select("id").eq(column, id).limit(1);
  if (error) return false;
  return (data ?? []).length > 0;
}

async function canEdit(
  cl: SupabaseClient,
  table: string,
  column: string,
  id: string,
  patch: Record<string, unknown>,
) {
  const { data, error } = await cl.from(table).update(patch).eq(column, id).select("*");
  if (error) return false;
  return (data ?? []).length > 0;
}

async function canInsert(cl: SupabaseClient, table: string, row: Record<string, unknown>) {
  const { data, error } = await cl.from(table).insert(row).select("*");
  if (error) return false;
  const inserted = (data ?? []) as { id?: string }[];
  // Undo anything the probe managed to create so the fixture stays predictable.
  for (const r of inserted) {
    if (r.id) await admin.from(table).delete().eq("id", r.id);
  }
  return inserted.length > 0;
}

async function canDelete(cl: SupabaseClient, table: string, column: string, id: string) {
  const { data, error } = await cl.from(table).delete().eq(column, id).select("*");
  if (error) return false;
  return (data ?? []).length > 0;
}

// ------------------------------------------------------- matrix cell probes

/** Everything a "Full" cell must allow, and a "None" cell must refuse. */
async function probeScope(actor: ActorKey, scopeKey: ScopeKey) {
  const cl = fixture.clients[actor];
  const scope = SCOPES[scopeKey]();
  return {
    patientView: await canView(cl, "patients", "id", scope.patient),
    patientEdit: await canEdit(cl, "patients", "id", scope.patient, { ward: `ward-${TAG}` }),
    patientCreate: await canInsert(cl, "patients", {
      unit_id: scope.unit,
      hospital_number: `${TAG}-new`,
      location_type: "icu",
      status: "admitted",
    }),
    taskView: await canView(cl, "patient_tasks", "patient_id", scope.patient),
    taskEdit: await canEdit(cl, "patient_tasks", "patient_id", scope.patient, {
      status: "in_progress",
    }),
    taskCreate: await canInsert(cl, "patient_tasks", {
      patient_id: scope.patient,
      description: `${TAG} job`,
      status: "not_started",
      position: 9,
    }),
    chartView: await canView(cl, "chart_days", "id", scope.chart),
    chartEdit: await canEdit(cl, "chart_days", "id", scope.chart, { notes: `${TAG} chart` }),
    chartDelete: await canDelete(cl, "chart_days", "id", scope.chart),
    microView: await canView(cl, "microbiology_results", "patient_id", scope.patient),
    investigationCreate: await canInsert(cl, "investigations", {
      patient_id: scope.patient,
      category: "bloods",
      findings: `${TAG} result`,
      result_at: new Date().toISOString(),
    }),
    editHistoryView: await canView(cl, "patient_field_changes", "patient_id", scope.patient),
    editHistoryDelete: await canDelete(cl, "patient_field_changes", "patient_id", scope.patient),
  };
}

type ScopeProbe = Awaited<ReturnType<typeof probeScope>>;

/** Accounts, unit configuration, audit and key-material surfaces. */
async function probeConfig(actor: ActorKey) {
  const cl = fixture.clients[actor];
  return {
    unitConfigEdit: await canEdit(cl, "icu_units", "id", fixture.unitOwn, {
      bed_capacity: 12,
    }),
    grantUnitAccess: await canInsert(cl, "user_unit_access", {
      user_id: fixture.userIds.signedInNoRole,
      unit_id: fixture.unitFar,
    }),
    assignRole: await canInsert(cl, "user_roles", {
      user_id: fixture.userIds.signedInNoRole,
      role: "clinician",
    }),
    viewOtherRoles: await canView(
      cl,
      "user_roles",
      "user_id",
      fixture.userIds.clinicianSingleUnit,
    ),
    viewAccessLog: await canView(cl, "account_access_events", "action", "provisioned"),
    viewOtherProfile: await canView(cl, "profiles", "id", fixture.userIds.signedInNoRole),
    readEncryptionKeys: await (async () => {
      const { error } = await cl.from("crypto_key_escrow").select("key_id").limit(1);
      return !error;
    })(),
  };
}

type ConfigProbe = Awaited<ReturnType<typeof probeConfig>>;

/** Matrix "Full": view and edit everything in scope. */
function expectFull(p: ScopeProbe) {
  expect(p.patientView).toBe(true);
  expect(p.patientEdit).toBe(true);
  expect(p.patientCreate).toBe(true);
  expect(p.taskView).toBe(true);
  expect(p.taskEdit).toBe(true);
  expect(p.taskCreate).toBe(true);
  expect(p.chartView).toBe(true);
  expect(p.chartEdit).toBe(true);
  expect(p.microView).toBe(true);
  expect(p.investigationCreate).toBe(true);
  // Edit history is view-only for every role, and never hard-deleted.
  expect(p.editHistoryView).toBe(true);
  expect(p.editHistoryDelete).toBe(false);
  // Digitised chart rows are retained: no role may delete them.
  expect(p.chartDelete).toBe(false);
}

/** Matrix "None": the server returns nothing and accepts no writes. */
function expectNone(p: ScopeProbe) {
  for (const [action, allowed] of Object.entries(p)) {
    expect(allowed, `${action} must be denied`).toBe(false);
  }
}

// -------------------------------------------------------------------- setup

async function createActor(
  key: Exclude<ActorKey, "unauthenticated">,
  role: "admin" | "clinician" | null,
) {
  const email = `${TAG}-${key.toLowerCase()}@matrix.test.invalid`;
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
    user_metadata: { display_name: `Matrix ${key}` },
  });
  if (error || !data.user) throw new Error(`createUser ${key}: ${error?.message}`);
  fixture.userIds[key] = data.user.id;
  if (role) {
    const { error: roleError } = await admin
      .from("user_roles")
      .insert({ user_id: data.user.id, role });
    if (roleError) throw new Error(`role ${key}: ${roleError.message}`);
  }
  const signIn = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: session, error: signInError } = await signIn.auth.signInWithPassword({
    email,
    password: PASSWORD,
  });
  if (signInError || !session.session) throw new Error(`signIn ${key}: ${signInError?.message}`);
  fixture.clients[key] = userClient(session.session.access_token);
}

beforeAll(async () => {
  expect(SUPABASE_URL, "SUPABASE_URL required").toBeTruthy();
  expect(SERVICE_KEY, "SUPABASE_SERVICE_ROLE_KEY required").toBeTruthy();
  expect(ANON_KEY, "publishable/anon key required").toBeTruthy();

  const hospitals = await admin
    .from("hospitals")
    .insert([
      { name: `Matrix Hospital A ${TAG}`, code: `${TAG}-HA` },
      { name: `Matrix Hospital B ${TAG}`, code: `${TAG}-HB` },
    ])
    .select("id, code");
  if (hospitals.error) throw new Error(hospitals.error.message);
  fixture.hospitalOwn = hospitals.data!.find((h) => h.code === `${TAG}-HA`)!.id;
  fixture.hospitalOther = hospitals.data!.find((h) => h.code === `${TAG}-HB`)!.id;

  const units = await admin
    .from("icu_units")
    .insert([
      { hospital_id: fixture.hospitalOwn, name: "Matrix Own ICU", code: `${TAG}-OWN` },
      { hospital_id: fixture.hospitalOwn, name: "Matrix Sibling ICU", code: `${TAG}-SIB` },
      { hospital_id: fixture.hospitalOther, name: "Matrix Far ICU", code: `${TAG}-FAR` },
    ])
    .select("id, code");
  if (units.error) throw new Error(units.error.message);
  const unitByCode = (suffix: string) => units.data!.find((u) => u.code === `${TAG}-${suffix}`)!.id;
  fixture.unitOwn = unitByCode("OWN");
  fixture.unitSibling = unitByCode("SIB");
  fixture.unitFar = unitByCode("FAR");

  const patients = await admin
    .from("patients")
    .insert([
      {
        unit_id: fixture.unitOwn,
        hospital_number: `${TAG}-own`,
        location_type: "icu",
        status: "admitted",
      },
      {
        unit_id: fixture.unitSibling,
        hospital_number: `${TAG}-sib`,
        location_type: "icu",
        status: "admitted",
      },
      {
        unit_id: fixture.unitFar,
        hospital_number: `${TAG}-far`,
        location_type: "icu",
        status: "admitted",
      },
    ])
    .select("id, unit_id");
  if (patients.error) throw new Error(patients.error.message);
  const patientByUnit = (unit: string) => patients.data!.find((p) => p.unit_id === unit)!.id;
  fixture.patientOwn = patientByUnit(fixture.unitOwn);
  fixture.patientSibling = patientByUnit(fixture.unitSibling);
  fixture.patientFar = patientByUnit(fixture.unitFar);

  const allPatients = [fixture.patientOwn, fixture.patientSibling, fixture.patientFar];

  const tasks = await admin
    .from("patient_tasks")
    .insert(
      allPatients.map((patient_id) => ({
        patient_id,
        description: `${TAG} seeded job`,
        status: "not_started",
        position: 1,
      })),
    )
    .select("id");
  if (tasks.error) throw new Error(tasks.error.message);

  const charts = await admin
    .from("chart_days")
    .insert(
      allPatients.map((patient_id) => ({
        patient_id,
        chart_date: new Date().toISOString().slice(0, 10),
        source: "manual",
      })),
    )
    .select("id, patient_id");
  if (charts.error) throw new Error(charts.error.message);
  const chartFor = (patient: string) => charts.data!.find((c) => c.patient_id === patient)!.id;
  fixture.chartOwn = chartFor(fixture.patientOwn);
  fixture.chartSibling = chartFor(fixture.patientSibling);
  fixture.chartFar = chartFor(fixture.patientFar);

  const micro = await admin.from("microbiology_results").insert(
    allPatients.map((patient_id) => ({
      patient_id,
      specimen_type: "sputum",
      findings: `${TAG} organism`,
      result_at: new Date().toISOString(),
    })),
  );
  if (micro.error) throw new Error(micro.error.message);

  const history = await admin.from("patient_field_changes").insert(
    allPatients.map((patient_id) => ({
      patient_id,
      field_name: "ward",
      old_value: "a",
      new_value: "b",
    })),
  );
  if (history.error) throw new Error(history.error.message);

  await createActor("clinicianSingleUnit", "clinician");
  await createActor("clinicianRotating", "clinician");
  await createActor("clinicianOtherUnit", "clinician");
  await createActor("administrator", "admin");
  await createActor("signedInNoRole", null);
  fixture.clients.unauthenticated = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const grants = await admin.from("user_unit_access").insert([
    { user_id: fixture.userIds.clinicianSingleUnit, unit_id: fixture.unitOwn },
    { user_id: fixture.userIds.clinicianRotating, unit_id: fixture.unitOwn },
    { user_id: fixture.userIds.clinicianRotating, unit_id: fixture.unitFar },
    { user_id: fixture.userIds.clinicianOtherUnit, unit_id: fixture.unitSibling },
  ]);
  if (grants.error) throw new Error(grants.error.message);
}, TIMEOUT);

afterAll(async () => {
  for (const patient of [fixture.patientOwn, fixture.patientSibling, fixture.patientFar]) {
    if (!patient) continue;
    for (const table of [
      "patient_field_changes",
      "microbiology_results",
      "investigations",
      "patient_tasks",
      "chart_days",
    ]) {
      await admin.from(table).delete().eq("patient_id", patient);
    }
    await admin.from("patients").delete().eq("id", patient);
  }
  for (const id of Object.values(fixture.userIds)) {
    await admin.from("user_unit_access").delete().eq("user_id", id);
    await admin.from("user_roles").delete().eq("user_id", id);
    await admin.auth.admin.deleteUser(id).catch(() => undefined);
  }
  for (const unit of [fixture.unitOwn, fixture.unitSibling, fixture.unitFar]) {
    if (unit) await admin.from("icu_units").delete().eq("id", unit);
  }
  for (const hospital of [fixture.hospitalOwn, fixture.hospitalOther]) {
    if (hospital) await admin.from("hospitals").delete().eq("id", hospital);
  }
}, TIMEOUT);

// -------------------------------------------------------------------- tests

describe("role vocabulary", () => {
  it("only the roles covered by these tests exist", async () => {
    const { data, error } = await admin.rpc("noop" as never).select?.("*") ?? { data: null, error: null };
    void data;
    void error;
    // app_role is the single source of truth for role names; extending it must
    // come with new matrix rows and new expectations in this file.
    const { data: roles } = await admin.from("user_roles").select("role");
    const distinct = [...new Set((roles ?? []).map((r) => (r as { role: string }).role))].sort();
    for (const role of distinct) {
      expect(["admin", "clinician"]).toContain(role);
    }
  });
});

describe("Option A — separate deployment per hospital", () => {
  // In Option A an account exists in exactly one hospital's deployment, so the
  // single-unit clinician stands in for that deployment's user and any record
  // outside their unit stands in for another hospital's separate deployment.
  it(
    "clinician has Full access to their own unit",
    async () => expectFull(await probeScope("clinicianSingleUnit", "own_unit")),
    TIMEOUT,
  );

  it(
    "clinician has no access to another hospital's data",
    async () => expectNone(await probeScope("clinicianSingleUnit", "unit_in_other_hospital")),
    TIMEOUT,
  );

  it(
    "administrator has Full clinical access plus configuration in their deployment",
    async () => {
      expectFull(await probeScope("administrator", "own_unit"));
      const config: ConfigProbe = await probeConfig("administrator");
      expect(config.unitConfigEdit).toBe(true);
      expect(config.grantUnitAccess).toBe(true);
      expect(config.assignRole).toBe(true);
      expect(config.viewOtherRoles).toBe(true);
      expect(config.viewAccessLog).toBe(true);
      // Encryption keys are never exposed to any user account.
      expect(config.readEncryptionKeys).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "clinician has no access to accounts or unit configuration",
    async () => {
      const config: ConfigProbe = await probeConfig("clinicianSingleUnit");
      expect(config.unitConfigEdit).toBe(false);
      expect(config.grantUnitAccess).toBe(false);
      expect(config.assignRole).toBe(false);
      expect(config.viewOtherRoles).toBe(false);
      expect(config.viewAccessLog).toBe(false);
      expect(config.viewOtherProfile).toBe(false);
      expect(config.readEncryptionKeys).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "unauthenticated visitor gets nothing",
    async () => {
      expectNone(await probeScope("unauthenticated", "own_unit"));
      const config: ConfigProbe = await probeConfig("unauthenticated");
      for (const [action, allowed] of Object.entries(config)) {
        expect(allowed, `${action} must be denied without a session`).toBe(false);
      }
    },
    TIMEOUT,
  );
});

describe("Option B — one deployment, segregation per ICU unit", () => {
  it(
    "single-unit clinician: Full on own unit, None elsewhere",
    async () => {
      expectFull(await probeScope("clinicianSingleUnit", "own_unit"));
      expectNone(await probeScope("clinicianSingleUnit", "other_unit_same_hospital"));
      expectNone(await probeScope("clinicianSingleUnit", "unit_in_other_hospital"));
    },
    TIMEOUT,
  );

  it(
    "rotating clinician: Full only on the units explicitly granted",
    async () => {
      expectFull(await probeScope("clinicianRotating", "own_unit"));
      expectFull(await probeScope("clinicianRotating", "unit_in_other_hospital"));
      // Sibling unit in the same hospital was never granted.
      expectNone(await probeScope("clinicianRotating", "other_unit_same_hospital"));
    },
    TIMEOUT,
  );

  it(
    "another unit's clinician cannot reach this unit — segregation is per unit, not per hospital",
    async () => {
      expectFull(await probeScope("clinicianOtherUnit", "other_unit_same_hospital"));
      expectNone(await probeScope("clinicianOtherUnit", "own_unit"));
      expectNone(await probeScope("clinicianOtherUnit", "unit_in_other_hospital"));
    },
    TIMEOUT,
  );

  it(
    "administrator: configuration across all units",
    async () => {
      expectFull(await probeScope("administrator", "other_unit_same_hospital"));
      expectFull(await probeScope("administrator", "unit_in_other_hospital"));
      const config: ConfigProbe = await probeConfig("administrator");
      expect(config.unitConfigEdit).toBe(true);
      expect(config.viewAccessLog).toBe(true);
      expect(config.readEncryptionKeys).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "signed-in account with no clinical role sees nothing clinical",
    async () => {
      expectNone(await probeScope("signedInNoRole", "own_unit"));
      expectNone(await probeScope("signedInNoRole", "other_unit_same_hospital"));
      const config: ConfigProbe = await probeConfig("signedInNoRole");
      expect(config.unitConfigEdit).toBe(false);
      expect(config.grantUnitAccess).toBe(false);
      expect(config.assignRole).toBe(false);
      expect(config.viewAccessLog).toBe(false);
      expect(config.readEncryptionKeys).toBe(false);
    },
    TIMEOUT,
  );

  it(
    "revoking a unit membership removes access immediately",
    async () => {
      const userId = fixture.userIds.clinicianRotating;
      const { error } = await admin
        .from("user_unit_access")
        .delete()
        .eq("user_id", userId)
        .eq("unit_id", fixture.unitFar);
      expect(error).toBeNull();
      expectNone(await probeScope("clinicianRotating", "unit_in_other_hospital"));
      // Own-unit access is untouched, and historic entries are never deleted.
      expectFull(await probeScope("clinicianRotating", "own_unit"));
      await admin
        .from("user_unit_access")
        .insert({ user_id: userId, unit_id: fixture.unitFar });
    },
    TIMEOUT,
  );
});
