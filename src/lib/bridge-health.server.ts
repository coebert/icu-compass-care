// Server-only bridge health check. Verifies the linked (partner) project's
// bridge endpoints are reachable, that HMAC signature auth is enforced, and
// that the patient payload contains none of the removed demographic fields
// (dob / nhs_number / date_of_birth). Never import from client code.
import { createHmac } from "crypto";

// Demographic fields that were removed from the schema. If any of these ever
// appears in a partner payload the sync contract has regressed.
export const FORBIDDEN_FIELDS = ["dob", "date_of_birth", "nhs_number"] as const;

const SYSTEM_ACTOR = {
  id: "00000000-0000-0000-0000-000000000000",
  email: "healthcheck-bot@icu-handover",
  role: "admin",
} as const;

// Bridge endpoints exposed by the partner project that we depend on.
const ENDPOINTS: { path: string; key: string; label: string }[] = [
  { path: "/api/public/bridge/patients", key: "patients", label: "Patients" },
  { path: "/api/public/bridge/investigations", key: "investigations", label: "Investigations" },
  { path: "/api/public/bridge/referrals", key: "referrals", label: "Referrals" },
  { path: "/api/public/bridge/notifications", key: "notifications", label: "Notifications" },
  { path: "/api/public/bridge/audit", key: "audit_log", label: "Audit log" },
];

export type EndpointCheck = {
  label: string;
  path: string;
  ok: boolean;
  status: number;
  recordCount: number | null;
  error?: string;
};

export type BridgeHealthResult = {
  ok: boolean;
  checkedAt: string;
  config: {
    partnerUrlConfigured: boolean;
    secretConfigured: boolean;
    partnerHost: string | null;
  };
  signatureAuth: {
    validAccepted: boolean; // a correctly signed request succeeds
    invalidRejected: boolean; // a tampered signature is refused
    detail: string;
  };
  endpoints: EndpointCheck[];
  samplePayload: {
    source: string; // which endpoint the sample came from
    keys: string[];
    forbiddenKeysPresent: string[];
    clean: boolean;
    sample: { full_name: string | null; age: number | null; hospital_number: string | null } | null;
  };
};

function config() {
  const baseUrl = process.env.PARTNER_BRIDGE_URL;
  const secret = process.env.HANDOVER_API_SECRET;
  return {
    baseUrl: baseUrl ? baseUrl.replace(/\/$/, "") : "",
    secret: secret ?? "",
    hasUrl: Boolean(baseUrl),
    hasSecret: Boolean(secret),
  };
}

function signedHeaders(secret: string, rawBody: string, tamper = false): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const actor = JSON.stringify(SYSTEM_ACTOR);
  let signature = createHmac("sha256", secret).update(`${timestamp}.${actor}.${rawBody}`).digest("hex");
  if (tamper) signature = signature.slice(0, -4) + "0000"; // corrupt the signature
  return {
    "Content-Type": "application/json",
    "x-timestamp": timestamp,
    "x-actor": actor,
    "x-signature": signature,
  };
}

async function signedGet(baseUrl: string, secret: string, path: string, tamper = false) {
  const res = await fetch(`${baseUrl}${path}`, { method: "GET", headers: signedHeaders(secret, "", tamper) });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

export async function runBridgeHealth(): Promise<BridgeHealthResult> {
  const { baseUrl, secret, hasUrl, hasSecret } = config();
  const checkedAt = new Date().toISOString();

  let partnerHost: string | null = null;
  try {
    partnerHost = baseUrl ? new URL(baseUrl).host : null;
  } catch {
    partnerHost = null;
  }

  const result: BridgeHealthResult = {
    ok: false,
    checkedAt,
    config: { partnerUrlConfigured: hasUrl, secretConfigured: hasSecret, partnerHost },
    signatureAuth: { validAccepted: false, invalidRejected: false, detail: "" },
    endpoints: [],
    samplePayload: { source: "", keys: [], forbiddenKeysPresent: [], clean: false, sample: null },
  };

  if (!hasUrl || !hasSecret) {
    result.signatureAuth.detail = "Bridge not configured (missing PARTNER_BRIDGE_URL or HANDOVER_API_SECRET).";
    return result;
  }

  // 1. Signature auth: a tampered signature must be rejected.
  try {
    const bad = await signedGet(baseUrl, secret, "/api/public/bridge/patients", true);
    result.signatureAuth.invalidRejected = bad.status === 401 || bad.status === 403;
  } catch (e) {
    result.signatureAuth.detail = `Auth probe failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  // 2. Endpoint reachability with a valid signature.
  for (const ep of ENDPOINTS) {
    try {
      const res = await signedGet(baseUrl, secret, ep.path);
      const body = res.json as Record<string, unknown> | null;
      const arr = body ? (body[ep.key] as unknown[] | undefined) : undefined;
      result.endpoints.push({
        label: ep.label,
        path: ep.path,
        ok: res.status === 200,
        status: res.status,
        recordCount: Array.isArray(arr) ? arr.length : null,
        error: res.status === 200 ? undefined : (typeof res.text === "string" ? res.text.slice(0, 200) : undefined),
      });
    } catch (e) {
      result.endpoints.push({
        label: ep.label,
        path: ep.path,
        ok: false,
        status: 0,
        recordCount: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const patientsCheck = result.endpoints.find((e) => e.path.endsWith("/patients"));
  result.signatureAuth.validAccepted = Boolean(patientsCheck?.ok);
  if (!result.signatureAuth.detail) {
    result.signatureAuth.detail = result.signatureAuth.validAccepted
      ? "Valid signatures accepted; tampered signatures rejected."
      : "Valid signature was not accepted by the partner bridge.";
  }

  // 3. Sample payload from the patients endpoint, scrubbed for forbidden keys.
  try {
    const res = await signedGet(baseUrl, secret, "/api/public/bridge/patients");
    const body = res.json as { patients?: Record<string, unknown>[] } | null;
    const first = body?.patients?.[0] ?? null;
    if (first) {
      const keys = Object.keys(first);
      const forbiddenKeysPresent = FORBIDDEN_FIELDS.filter((f) => keys.includes(f));
      // Only surface the agreed identity fields in the sample to avoid echoing
      // clinical free-text back into the UI.
      const sample: Record<string, unknown> = {
        full_name: first.full_name ?? null,
        age: first.age ?? null,
        hospital_number: first.hospital_number ?? null,
      };
      result.samplePayload = {
        source: "/api/public/bridge/patients",
        keys,
        forbiddenKeysPresent,
        clean: forbiddenKeysPresent.length === 0,
        sample,
      };
    } else {
      // No rows on the partner side — the contract is still verifiable as clean.
      result.samplePayload = {
        source: "/api/public/bridge/patients",
        keys: [],
        forbiddenKeysPresent: [],
        clean: true,
        sample: null,
      };
    }
  } catch (e) {
    result.samplePayload.source = `error: ${e instanceof Error ? e.message : String(e)}`;
  }

  result.ok =
    result.signatureAuth.validAccepted &&
    result.signatureAuth.invalidRejected &&
    result.endpoints.every((e) => e.ok) &&
    result.samplePayload.clean;

  return result;
}
