// Typed client wrapper for the cross-project data bridge
// (/api/public/bridge/*). The response types mirror the documented shapes in
// src/lib/bridge-openapi.ts and the handlers under src/routes/api/public/.
//
// Every authenticated call is signed the same way the bridge verifies it:
//   message   = `${timestamp}.${actor}.${rawBody}`   (rawBody is "" for GET)
//   signature = hex( HMAC_SHA256(secret, message) )
//   headers   = { x-timestamp, x-actor, x-signature }
//
// Signing uses the Web Crypto API (globalThis.crypto.subtle), so this module
// runs in the browser, a Worker/edge runtime, and Node 18+. Keep the shared
// secret server-side — do not ship it to the browser.

// ---- Shared field aliases ------------------------------------------------

export type Uuid = string;
export type IsoDateTime = string;

export type PatientStatus = "referred" | "admitted" | "discharged" | "died";
export type LocationType = "icu" | "outlier";

// ---- Response entity shapes ---------------------------------------------

export interface OccupantView {
  id: Uuid;
  full_name: string | null;
  hospital_number: string | null;
  age: number | null;
  status: string | null;
  bed: string | null;
  admission_date: string | null;
  tep_in_place: boolean | null;
  dnacpr_decision: boolean | null;
  outstanding_tasks: string | null;
  updated_at: string | null;
}

export interface Patient {
  id: Uuid;
  created_by: string | null;
  updated_by: string | null;
  full_name: string;
  hospital_number: string | null;
  age: number | null;
  location_type: LocationType | null;
  ward: string | null;
  bed: string | null;
  status: PatientStatus | null;
  admission_date: string | null;
  discharge_date: string | null;
  discharge_destination: string | null;
  date_of_death: string | null;
  past_medical_history: string | null;
  current_admission: string | null;
  current_management: string | null;
  outstanding_tasks: string | null;
  tep_in_place: boolean;
  tep_details: string | null;
  dnacpr_decision: boolean;
  dnacpr_details: string | null;
  dnacpr_date: string | null;
  nok_name: string | null;
  nok_relationship: string | null;
  nok_contact: string | null;
  nok_last_updated: string | null;
  nok_last_updated_by: string | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  [key: string]: unknown;
}

export interface PatientUpsert {
  /** Omit to create; provide to update. */
  id?: Uuid;
  /** Optimistic-concurrency guard: the updated_at the caller last saw. */
  expected_updated_at?: string;
  full_name: string;
  hospital_number?: string | null;
  age?: number | null;
  location_type?: LocationType;
  ward?: string | null;
  bed?: string | null;
  status?: PatientStatus;
  admission_date?: string | null;
  discharge_date?: string | null;
  discharge_destination?: string | null;
  date_of_death?: string | null;
  past_medical_history?: string | null;
  current_admission?: string | null;
  current_management?: string | null;
  outstanding_tasks?: string | null;
  tep_in_place?: boolean;
  tep_details?: string | null;
  dnacpr_decision?: boolean;
  dnacpr_details?: string | null;
  dnacpr_date?: string | null;
  nok_name?: string | null;
  nok_relationship?: string | null;
  nok_contact?: string | null;
  nok_last_updated?: string | null;
  nok_last_updated_by?: string | null;
}

export interface Investigation {
  id: Uuid;
  patient_id: Uuid;
  category: string;
  findings: string;
  result_at: IsoDateTime;
  created_by: string | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  [key: string]: unknown;
}

export interface InvestigationInsert {
  patient_id: Uuid;
  category: string;
  findings: string;
  /** Defaults to now when omitted. */
  result_at?: string | null;
}

export interface Microbiology {
  id: Uuid;
  patient_id: Uuid;
  specimen_type: string;
  findings: string;
  result_at: IsoDateTime;
  created_by: string | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  [key: string]: unknown;
}

export interface Notification {
  id: Uuid;
  user_id: Uuid;
  kind: string;
  message: string;
  referral_id: string | null;
  read_at: string | null;
  created_at: IsoDateTime;
  [key: string]: unknown;
}

export interface AuditLogEntry {
  id: Uuid;
  entity: string;
  entity_id: string | null;
  action: "insert" | "update" | "delete";
  diff: Record<string, unknown> | null;
  user_id: string | null;
  created_at: IsoDateTime;
  [key: string]: unknown;
}

export interface Referral {
  id: Uuid;
  status: string;
  outcome: string | null;
  referral_received_at: IsoDateTime;
  referring_specialty: string | null;
  accepting_consultant: string | null;
  current_ward: string | null;
  current_bed: string | null;
  age: number | null;
  sex: string | null;
  news2_score: number | null;
  news2_recorded_at: string | null;
  frailty_score: number | null;
  weight_kg: number | null;
  admission_urgency: string | null;
  ceiling_of_care: string | null;
  resus_status: string | null;
  infection_status: string | null;
  infection_organism: string | null;
  reason_category: string | null;
  anticipated_interventions: string[];
  consultant_to_consultant_only: boolean;
  dnacpr_respect: boolean;
  for_ongoing_ccot_review: boolean;
  needs_ward_review: boolean;
  is_test: boolean;
  first_seen_at: string | null;
  decision_at: string | null;
  outcome_recorded_at: string | null;
  arrived_on_unit_at: string | null;
  deleted_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  [key: string]: unknown;
}

export interface Bed {
  bed: string;
  is_side_room: boolean;
  occupied: boolean;
  occupant: OccupantView | null;
}

export interface BedBoardResponse {
  unit: string;
  side_rooms: string[];
  bed_board: Bed[];
  unassigned: OccupantView[];
  stats: {
    total_beds: number;
    occupied: number;
    available: number;
    unassigned: number;
  };
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  handover_api_secret_configured: boolean;
  partner_bridge_url_configured?: boolean;
  patient_field_keys: string[];
  patient_field_count: number;
  timestamp: IsoDateTime;
}

export interface VerifySignatureSelfTest {
  ok: boolean;
  handover_api_secret_configured?: boolean;
  rotation_window_active?: boolean;
  checks?: {
    valid_signature_accepted: boolean;
    tampered_signature_rejected: boolean;
  };
  envelope?: { message_format: string; raw_body: string };
  timestamp: IsoDateTime;
  [key: string]: unknown;
}

export interface VerifySignatureResult {
  ok: boolean;
  signature_valid: boolean;
  actor: BridgeActor;
  timestamp: IsoDateTime;
}

/** 409 body returned by POST /patients on an optimistic-concurrency conflict. */
export interface PatientConflict {
  error: "conflict";
  message: string;
  current: Patient;
  your_expected_updated_at?: string;
}

export interface BridgeErrorBody {
  error: string;
  message?: string;
  [key: string]: unknown;
}

// ---- Client config + error ----------------------------------------------

export interface BridgeActor {
  id: string;
  email?: string;
  role: string;
}

export interface BridgeClientOptions {
  /** Base origin, e.g. https://icu-compass-care.lovable.app (no trailing slash). */
  baseUrl: string;
  /** Shared HMAC secret (HANDOVER_API_SECRET). Keep server-side. */
  secret: string;
  /** The acting user, forwarded in the signed x-actor envelope. */
  actor: BridgeActor;
  /** Optional custom fetch (defaults to global fetch). */
  fetch?: typeof fetch;
}

/** Thrown for any non-2xx bridge response; carries status + parsed body. */
export class BridgeError extends Error {
  readonly status: number;
  readonly body: BridgeErrorBody | PatientConflict | unknown;

  constructor(status: number, body: unknown) {
    const msg =
      (body as BridgeErrorBody)?.message ??
      (body as BridgeErrorBody)?.error ??
      `Bridge request failed with status ${status}`;
    super(msg);
    this.name = "BridgeError";
    this.status = status;
    this.body = body;
  }

  /** True when the failure is an optimistic-concurrency conflict (409). */
  isConflict(): boolean {
    return this.status === 409;
  }
}

// ---- HMAC signing (Web Crypto, isomorphic) ------------------------------

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto (crypto.subtle) is unavailable in this runtime");
  const enc = new TextEncoder();
  const key = await subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await subtle.sign("HMAC", key, enc.encode(message));
  return toHex(sig);
}

// ---- Client factory ------------------------------------------------------

export interface BridgeClient {
  // clinical
  listPatients(params?: { status?: PatientStatus }): Promise<Patient[]>;
  upsertPatient(body: PatientUpsert): Promise<Patient>;
  listInvestigations(params?: { patient_id?: Uuid; category?: string }): Promise<Investigation[]>;
  addInvestigation(body: InvestigationInsert): Promise<Investigation>;
  listMicrobiology(): Promise<Microbiology[]>;
  listReferrals(): Promise<Referral[]>;
  // operations
  getBedBoard(): Promise<BedBoardResponse>;
  listAudit(): Promise<AuditLogEntry[]>;
  listNotifications(): Promise<Notification[]>;
  // diagnostics
  health(): Promise<HealthResponse>;
  verifySignatureSelfTest(): Promise<VerifySignatureSelfTest>;
  verifySignature(body?: unknown): Promise<VerifySignatureResult>;
}

export function createBridgeClient(opts: BridgeClientOptions): BridgeClient {
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  const doFetch = opts.fetch ?? globalThis.fetch;
  const actorJson = JSON.stringify({
    id: opts.actor.id,
    email: opts.actor.email,
    role: opts.actor.role,
  });

  async function signedHeaders(rawBody: string): Promise<Record<string, string>> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await hmacSha256Hex(opts.secret, `${timestamp}.${actorJson}.${rawBody}`);
    return {
      "x-timestamp": timestamp,
      "x-actor": actorJson,
      "x-signature": signature,
    };
  }

  async function parse<T>(res: Response): Promise<T> {
    const text = await res.text();
    let body: unknown = undefined;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!res.ok) throw new BridgeError(res.status, body);
    return body as T;
  }

  async function get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
    const url = new URL(`${baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
    }
    const res = await doFetch(url.toString(), {
      method: "GET",
      headers: { ...(await signedHeaders("")) },
    });
    return parse<T>(res);
  }

  async function post<T>(path: string, payload: unknown): Promise<T> {
    const rawBody = JSON.stringify(payload ?? {});
    const res = await doFetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await signedHeaders(rawBody)) },
      body: rawBody,
    });
    return parse<T>(res);
  }

  return {
    // clinical
    listPatients: (params) =>
      get<{ patients: Patient[] }>("/api/public/bridge/patients", { status: params?.status }).then(
        (r) => r.patients,
      ),
    upsertPatient: (body) =>
      post<{ patient: Patient }>("/api/public/bridge/patients", body).then((r) => r.patient),
    listInvestigations: (params) =>
      get<{ investigations: Investigation[] }>("/api/public/bridge/investigations", {
        patient_id: params?.patient_id,
        category: params?.category,
      }).then((r) => r.investigations),
    addInvestigation: (body) =>
      post<{ investigation: Investigation }>("/api/public/bridge/investigations", body).then(
        (r) => r.investigation,
      ),
    listMicrobiology: () =>
      get<{ microbiology: Microbiology[] }>("/api/public/bridge/microbiology").then(
        (r) => r.microbiology,
      ),
    listReferrals: () =>
      get<{ referrals: Referral[] }>("/api/public/bridge/referrals").then((r) => r.referrals),

    // operations
    getBedBoard: () => get<BedBoardResponse>("/api/public/bridge/beds"),
    listAudit: () =>
      get<{ audit_log: AuditLogEntry[] }>("/api/public/bridge/audit").then((r) => r.audit_log),
    listNotifications: () =>
      get<{ notifications: Notification[] }>("/api/public/bridge/notifications").then(
        (r) => r.notifications,
      ),

    // diagnostics (health + self-test are unauthenticated but signing them is harmless)
    health: () => get<HealthResponse>("/api/public/bridge/health"),
    verifySignatureSelfTest: () =>
      get<VerifySignatureSelfTest>("/api/public/bridge/verify-signature"),
    verifySignature: (body) =>
      post<VerifySignatureResult>("/api/public/bridge/verify-signature", body ?? {}),
  };
}
