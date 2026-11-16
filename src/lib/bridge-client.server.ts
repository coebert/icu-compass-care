// Server-only client for calling the PARTNER project's HMAC bridge endpoints.
// Never import this from client code — it reads server secrets and signs
// requests with the shared HANDOVER_API_SECRET.
import { createHmac } from "crypto";
import type { Database } from "@/integrations/supabase/types";
import type { SyncErrorCode } from "@/lib/sync-status";

export type PatientRow = Database["public"]["Tables"]["patients"]["Row"];
export type InvestigationRow = Database["public"]["Tables"]["investigations"]["Row"];
export type NotificationRow = Database["public"]["Tables"]["notifications"]["Row"];
export type ReferralRow = Database["public"]["Tables"]["referrals"]["Row"];
export type AuditLogRow = Database["public"]["Tables"]["audit_log"]["Row"];
export type MicrobiologyRow = Database["public"]["Tables"]["microbiology_results"]["Row"];

// The sync job acts on behalf of an automated system principal. The partner
// bridge authorizes by role, so we present an admin-level service actor.
const SYSTEM_ACTOR = {
  id: "00000000-0000-0000-0000-000000000000",
  email: "sync-bot@icu-handover",
  role: "admin",
} as const;

export class BridgeFetchError extends Error {
  constructor(readonly code: SyncErrorCode) {
    super(code);
    this.name = "BridgeFetchError";
  }
}

function config(): { baseUrl: string; secret: string } {
  const baseUrl = process.env.PARTNER_BRIDGE_URL;
  const secret = process.env.HANDOVER_API_SECRET;
  if (!baseUrl || !secret) throw new BridgeFetchError("not_configured");
  return { baseUrl: baseUrl.replace(/\/$/, ""), secret };
}

// Build the signed headers the partner bridge's authorize() expects.
function signedHeaders(rawBody: string): Record<string, string> {
  const { secret } = config();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const actor = JSON.stringify(SYSTEM_ACTOR);
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${actor}.${rawBody}`)
    .digest("hex");
  return {
    "Content-Type": "application/json",
    "x-timestamp": timestamp,
    "x-actor": actor,
    "x-signature": signature,
  };
}

// Errors carry a code only: the partner's response body can contain record
// values and must never reach logs, the sync-event table or the UI.
async function getJson(path: string): Promise<unknown> {
  const { baseUrl } = config();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, { method: "GET", headers: signedHeaders("") });
  } catch {
    throw new BridgeFetchError("partner_unreachable");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    console.error("[bridge-client] partner GET failed", path, res.status);
    throw new BridgeFetchError("partner_http_error");
  }
  try {
    return await res.json();
  } catch {
    throw new BridgeFetchError("malformed_response");
  }
}

/**
 * The expected list must be present and an array of objects with a text id.
 * A missing/null/non-array list is malformed, NOT "no records" — otherwise a
 * broken partner response would look like a successful empty pull.
 */
export function expectRecords<T>(body: unknown, key: string): T[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BridgeFetchError("malformed_response");
  }
  const list = (body as Record<string, unknown>)[key];
  if (!Array.isArray(list)) throw new BridgeFetchError("malformed_response");
  for (const item of list) {
    const rec = item as Record<string, unknown> | null;
    if (
      !rec ||
      typeof rec !== "object" ||
      Array.isArray(rec) ||
      typeof rec.id !== "string" ||
      rec.id === "" ||
      !(
        rec.updated_at === undefined ||
        rec.updated_at === null ||
        typeof rec.updated_at === "string"
      )
    ) {
      throw new BridgeFetchError("malformed_record");
    }
  }
  return list as T[];
}

// Pull the full patient list from the partner backend.
export async function fetchPartnerPatients(): Promise<PatientRow[]> {
  return expectRecords<PatientRow>(await getJson("/api/public/bridge/patients"), "patients");
}

// Pull the full investigation list from the partner backend.
export async function fetchPartnerInvestigations(): Promise<InvestigationRow[]> {
  return expectRecords<InvestigationRow>(
    await getJson("/api/public/bridge/investigations"),
    "investigations",
  );
}

// Pull the partner backend's notifications for cross-project review.
export async function fetchPartnerNotifications(): Promise<NotificationRow[]> {
  const data = (await getJson("/api/public/bridge/notifications")) as {
    notifications?: NotificationRow[] | null;
  } | null;
  return data?.notifications ?? [];
}

// Pull the partner backend's referrals.
export async function fetchPartnerReferrals(): Promise<ReferralRow[]> {
  return expectRecords<ReferralRow>(await getJson("/api/public/bridge/referrals"), "referrals");
}

// Pull the partner backend's audit log for cross-project review.
export async function fetchPartnerAuditLog(): Promise<AuditLogRow[]> {
  const data = (await getJson("/api/public/bridge/audit")) as {
    audit_log?: AuditLogRow[] | null;
  } | null;
  return data?.audit_log ?? [];
}

// Pull the full microbiology-results list from the partner backend.
export async function fetchPartnerMicrobiology(): Promise<MicrobiologyRow[]> {
  return expectRecords<MicrobiologyRow>(
    await getJson("/api/public/bridge/microbiology"),
    "microbiology",
  );
}

export const bridgeSystemActor = SYSTEM_ACTOR;
