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
        const secret = process.env.HANDOVER_API_SECRET;
        if (!secret) {
          return Response.json({ error: "Bridge not configured" }, { status: 503 });
        }

        const provided = request.headers.get("x-bridge-secret") ?? "";
        const a = Buffer.from(provided);
        const b = Buffer.from(secret);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
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
