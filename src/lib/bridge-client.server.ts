// Server-only client for calling the PARTNER project's HMAC bridge endpoints.
// Never import this from client code — it reads server secrets and signs
// requests with the shared HANDOVER_API_SECRET.
import { createHmac } from "crypto";
import type { Database } from "@/integrations/supabase/types";

export type PatientRow = Database["public"]["Tables"]["patients"]["Row"];
export type InvestigationRow = Database["public"]["Tables"]["investigations"]["Row"];

// The sync job acts on behalf of an automated system principal. The partner
// bridge authorizes by role, so we present an admin-level service actor.
const SYSTEM_ACTOR = {
  id: "00000000-0000-0000-0000-000000000000",
  email: "sync-bot@icu-handover",
  role: "admin",
} as const;

function config(): { baseUrl: string; secret: string } {
  const baseUrl = process.env.PARTNER_BRIDGE_URL;
  const secret = process.env.HANDOVER_API_SECRET;
  if (!baseUrl) throw new Error("PARTNER_BRIDGE_URL is not configured");
  if (!secret) throw new Error("HANDOVER_API_SECRET is not configured");
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

async function getJson<T>(path: string): Promise<T> {
  const { baseUrl } = config();
  const res = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: signedHeaders(""),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Partner bridge GET ${path} failed [${res.status}]: ${body}`);
  }
  return (await res.json()) as T;
}

// Pull the full patient list from the partner backend.
export async function fetchPartnerPatients(): Promise<PatientRow[]> {
  const data = await getJson<{ patients: PatientRow[] | null }>("/api/public/bridge/patients");
  return data.patients ?? [];
}

// Pull the full investigation list from the partner backend.
export async function fetchPartnerInvestigations(): Promise<InvestigationRow[]> {
  const data = await getJson<{ investigations: InvestigationRow[] | null }>(
    "/api/public/bridge/investigations",
  );
  return data.investigations ?? [];
}

export const bridgeSystemActor = SYSTEM_ACTOR;
