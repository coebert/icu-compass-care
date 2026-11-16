// Server-only client for calling the PARTNER project's (Critical Care Connect)
// HMAC bridge endpoints. Never import this from client code — it reads server
// secrets and signs requests with the shared HANDOVER_API_SECRET.
//
// Patients are NOT fetched: they are authoritative in this app. Scheduled
// imports use the versioned sync v1 contract (see bridge-contract.ts), and
// every page is validated before the caller writes anything.
import { createHmac } from "crypto";
import type { SyncErrorCode } from "@/lib/sync-status";
import {
  ContractError,
  parseLegacyRecords,
  parseSyncPage,
  SyncPageCollector,
  SYNC_V1_BUDGET,
  SYNC_V1_PAGE_LIMIT,
} from "@/lib/bridge-contract";

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

/** Read a response body without buffering more than `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new BridgeFetchError("budget_exceeded");
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BridgeFetchError("budget_exceeded");
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

// Errors carry a code only: the partner's response body can contain record
// values and must never reach logs, the sync-event table or the UI.
async function getJson(
  pathWithQuery: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<unknown> {
  const { baseUrl } = config();
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${pathWithQuery}`, {
      method: "GET",
      headers: signedHeaders(""),
      signal: AbortSignal.timeout(opts.timeoutMs ?? SYNC_V1_BUDGET.requestTimeoutMs),
    });
  } catch {
    throw new BridgeFetchError("partner_unreachable");
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    console.error("[bridge-client] partner GET failed", pathWithQuery.split("?")[0], res.status);
    throw new BridgeFetchError("partner_http_error");
  }
  let text: string;
  try {
    text = await readCapped(res, opts.maxBytes ?? SYNC_V1_BUDGET.maxPageBytes);
  } catch (e) {
    if (e instanceof BridgeFetchError) throw e;
    throw new BridgeFetchError("partner_unreachable");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BridgeFetchError("malformed_response");
  }
}

const asFetchError = (e: unknown): never => {
  if (e instanceof ContractError) throw new BridgeFetchError(e.code);
  throw e;
};

export type SyncV1Resource = "referrals" | "investigations" | "microbiology";

/** URL for one sync v1 page; the cursor is passed as an encoded query value. */
export function syncV1Path(resource: SyncV1Resource, cursor: string | null): string {
  const q = new URLSearchParams({ sync: "1", limit: String(SYNC_V1_PAGE_LIMIT) });
  if (cursor !== null) q.set("cursor", cursor);
  return `/api/public/bridge/${resource}?${q.toString()}`;
}

/**
 * Pull every page of one resource under a single snapshot. Throws a coded
 * BridgeFetchError on ANY contract problem; returns only a complete, ordered,
 * validated set. A genuine `[]` with complete:true is a valid empty result.
 */
export async function fetchSyncV1(
  resource: SyncV1Resource,
  opts: { now?: () => number } = {},
): Promise<{ records: Record<string, unknown>[]; snapshotAt: string }> {
  const collector = new SyncPageCollector(SYNC_V1_BUDGET, opts.now);
  let cursor: string | null = null;
  try {
    for (;;) {
      const body = await getJson(syncV1Path(resource, cursor));
      const next = collector.add(parseSyncPage(body));
      if (next === null) break;
      cursor = next;
    }
    return collector.finish();
  } catch (e) {
    return asFetchError(e);
  }
}

/**
 * Legacy `{records:[...]}` review feeds (cross-app reconciliation review only;
 * never imported). Malformed or truncated feeds fail instead of looking empty.
 */
async function fetchLegacy(path: string): Promise<Record<string, unknown>[]> {
  const body = await getJson(path);
  try {
    return parseLegacyRecords(body);
  } catch (e) {
    return asFetchError(e);
  }
}

export const fetchPartnerNotificationsForReview = () =>
  fetchLegacy("/api/public/bridge/notifications");
export const fetchPartnerAuditLogForReview = () => fetchLegacy("/api/public/bridge/audit");

export const bridgeSystemActor = SYSTEM_ACTOR;
