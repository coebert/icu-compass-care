// Server-only orchestration for the bridge synchronization job.
//
// Strategy: PULL-based reconciliation. Each backend independently pulls the
// overlapping ICU data from the other and applies a last-write-wins merge
// keyed by `updated_at`. When both backends run this job on a schedule the
// result is eventual bidirectional convergence with no duplicate rows,
// because every record keeps its stable id across both databases.
import { fetchPartnerPatients, fetchPartnerInvestigations, fetchPartnerReferrals, fetchPartnerMicrobiology, bridgeSystemActor, type PatientRow, type InvestigationRow, type ReferralRow, type MicrobiologyRow } from "@/lib/bridge-client.server";
import { logSync, logSyncError, type BridgeEntity } from "@/lib/api-bridge.server";
import { writeAudit } from "@/lib/audit";

export type EntitySyncResult = {
  entity: BridgeEntity;
  fetched: number;
  applied: number;
  skipped: number;
  error?: string;
};

export type SyncRunResult = {
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  results: EntitySyncResult[];
};

function newer(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = a ? Date.parse(a) : 0;
  const tb = b ? Date.parse(b) : 0;
  return ta > tb;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function syncPatients(admin: any): Promise<EntitySyncResult> {
  const result: EntitySyncResult = { entity: "patients", fetched: 0, applied: 0, skipped: 0 };
  try {
    const partner = await fetchPartnerPatients();
    result.fetched = partner.length;
    if (partner.length === 0) return result;

    const ids = partner.map((p) => p.id);
    const { data: localRows, error: readErr } = await admin
      .from("patients")
      .select("*")
      .in("id", ids);
    if (readErr) throw new Error(readErr.message);

    const localById = new Map<string, PatientRow>((localRows ?? []).map((r: PatientRow) => [r.id, r]));

    for (const remote of partner) {
      const local = localById.get(remote.id);
      // Only apply when the record is new here, or the partner copy is strictly
      // newer than ours. Ties and older partner copies are left untouched.
      if (local && !newer(remote.updated_at, local.updated_at)) {
        result.skipped++;
        continue;
      }
      const { error: upErr } = await admin.from("patients").upsert(remote, { onConflict: "id" });
      if (upErr) {
        result.skipped++;
        continue;
      }
      await writeAudit(admin, {
        entity: "patients",
        recordId: remote.id,
        action: local ? "update" : "insert",
        source: "bridge",
        actor: bridgeSystemActor,
        before: (local as Record<string, unknown> | undefined) ?? null,
        after: remote as Record<string, unknown>,
      });
      result.applied++;
    }

    await logSync(admin, { direction: "pull", entity: "patients", record_count: result.applied, actor: bridgeSystemActor });
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    await logSyncError(admin, { direction: "pull", entity: "patients", message: result.error, actor: bridgeSystemActor });
  }
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function syncInvestigations(admin: any): Promise<EntitySyncResult> {
  const result: EntitySyncResult = { entity: "investigations", fetched: 0, applied: 0, skipped: 0 };
  try {
    const partner = await fetchPartnerInvestigations();
    result.fetched = partner.length;
    if (partner.length === 0) return result;

    const ids = partner.map((i) => i.id);
    const { data: localRows, error: readErr } = await admin
      .from("investigations")
      .select("*")
      .in("id", ids);
    if (readErr) throw new Error(readErr.message);

    const localById = new Map<string, InvestigationRow>((localRows ?? []).map((r: InvestigationRow) => [r.id, r]));

    for (const remote of partner) {
      const local = localById.get(remote.id);
      if (local && !newer(remote.updated_at, local.updated_at)) {
        result.skipped++;
        continue;
      }
      const { error: upErr } = await admin.from("investigations").upsert(remote, { onConflict: "id" });
      if (upErr) {
        result.skipped++;
        continue;
      }
      await writeAudit(admin, {
        entity: "investigations",
        recordId: remote.id,
        action: local ? "update" : "insert",
        source: "bridge",
        actor: bridgeSystemActor,
        before: (local as Record<string, unknown> | undefined) ?? null,
        after: remote as Record<string, unknown>,
      });
      result.applied++;
    }

    await logSync(admin, { direction: "pull", entity: "investigations", record_count: result.applied, actor: bridgeSystemActor });
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    await logSyncError(admin, { direction: "pull", entity: "investigations", message: result.error, actor: bridgeSystemActor });
  }
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function syncReferrals(admin: any): Promise<EntitySyncResult> {
  const result: EntitySyncResult = { entity: "referrals", fetched: 0, applied: 0, skipped: 0 };
  try {
    const partner = await fetchPartnerReferrals();
    result.fetched = partner.length;
    if (partner.length === 0) return result;

    const ids = partner.map((r) => r.id);
    const { data: localRows, error: readErr } = await admin
      .from("referrals")
      .select("*")
      .in("id", ids);
    if (readErr) throw new Error(readErr.message);

    const localById = new Map<string, ReferralRow>((localRows ?? []).map((r: ReferralRow) => [r.id, r]));

    for (const remote of partner) {
      const local = localById.get(remote.id);
      if (local && !newer(remote.updated_at, local.updated_at)) {
        result.skipped++;
        continue;
      }
      const { error: upErr } = await admin.from("referrals").upsert(remote, { onConflict: "id" });
      if (upErr) {
        // A referral may reference a patient that has not synced yet; leave it
        // for a later pass rather than failing the whole run.
        result.skipped++;
        continue;
      }
      await writeAudit(admin, {
        entity: "referrals",
        recordId: remote.id,
        action: local ? "update" : "insert",
        source: "bridge",
        actor: bridgeSystemActor,
        before: (local as Record<string, unknown> | undefined) ?? null,
        after: remote as Record<string, unknown>,
      });
      result.applied++;
    }

    await logSync(admin, { direction: "pull", entity: "referrals", record_count: result.applied, actor: bridgeSystemActor });
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    await logSyncError(admin, { direction: "pull", entity: "referrals", message: result.error, actor: bridgeSystemActor });
  }
  return result;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function syncMicrobiology(admin: any): Promise<EntitySyncResult> {
  const result: EntitySyncResult = { entity: "microbiology", fetched: 0, applied: 0, skipped: 0 };
  try {
    const partner = await fetchPartnerMicrobiology();
    result.fetched = partner.length;
    if (partner.length === 0) return result;

    const ids = partner.map((m) => m.id);
    const { data: localRows, error: readErr } = await admin
      .from("microbiology_results")
      .select("*")
      .in("id", ids);
    if (readErr) throw new Error(readErr.message);

    const localById = new Map<string, MicrobiologyRow>((localRows ?? []).map((r: MicrobiologyRow) => [r.id, r]));

    for (const remote of partner) {
      const local = localById.get(remote.id);
      if (local && !newer(remote.updated_at, local.updated_at)) {
        result.skipped++;
        continue;
      }
      const { error: upErr } = await admin.from("microbiology_results").upsert(remote, { onConflict: "id" });
      if (upErr) {
        // A result may reference a patient that has not synced yet; leave it for
        // a later pass rather than failing the whole run.
        result.skipped++;
        continue;
      }
      await writeAudit(admin, {
        entity: "microbiology",
        recordId: remote.id,
        action: local ? "update" : "insert",
        source: "bridge",
        actor: bridgeSystemActor,
        before: (local as Record<string, unknown> | undefined) ?? null,
        after: remote as Record<string, unknown>,
      });
      result.applied++;
    }

    await logSync(admin, { direction: "pull", entity: "microbiology", record_count: result.applied, actor: bridgeSystemActor });
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
    await logSyncError(admin, { direction: "pull", entity: "microbiology", message: result.error, actor: bridgeSystemActor });
  }
  return result;
}

// Run one full synchronization pass across every overlapping entity.
// Patients sync first so dependent records (investigations/referrals/micro) resolve.
export async function runBridgeSync(): Promise<SyncRunResult> {
  const startedAt = new Date().toISOString();
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const results = [
    await syncPatients(supabaseAdmin),
    await syncInvestigations(supabaseAdmin),
    await syncReferrals(supabaseAdmin),
    await syncMicrobiology(supabaseAdmin),
  ];
  return {
    ok: results.every((r) => !r.error),
    startedAt,
    finishedAt: new Date().toISOString(),
    results,
  };
}
