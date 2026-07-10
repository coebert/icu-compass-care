import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { runBridgeSync } from "@/lib/bridge-sync.server";

// Scheduled bridge synchronization endpoint.
//
// Lives under /api/public/* so pg_cron (or an external scheduler) can call it
// without a user session. It is guarded by a shared secret header so random
// public callers cannot trigger a sync. The response contains only aggregate
// counts — never patient data — so it is safe to log.
export const Route = createFileRoute("/api/public/hooks/bridge-sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Accept either the shared bridge HMAC secret (partner-triggered) or the
        // dedicated cron trigger secret (pg_cron on this backend). Whichever is
        // configured guards the endpoint; a matching x-bridge-secret is required.
        const bridgeSecret = process.env.HANDOVER_API_SECRET;
        const cronSecret = process.env.BRIDGE_SYNC_CRON_SECRET;
        const accepted = [bridgeSecret, cronSecret].filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        );
        if (accepted.length === 0) {
          return Response.json({ error: "Bridge not configured" }, { status: 503 });
        }

        const provided = request.headers.get("x-bridge-secret") ?? "";
        const providedBuf = Buffer.from(provided);
        const authorized = accepted.some((secret) => {
          const secretBuf = Buffer.from(secret);
          return (
            providedBuf.length === secretBuf.length &&
            timingSafeEqual(providedBuf, secretBuf)
          );
        });
        if (!authorized) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        try {
          const result = await runBridgeSync();
          return Response.json(result, { status: result.ok ? 200 : 207 });
        } catch (e) {
          const message = e instanceof Error ? e.message : "Sync failed";
          console.error("[bridge-sync] run failed:", message);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
