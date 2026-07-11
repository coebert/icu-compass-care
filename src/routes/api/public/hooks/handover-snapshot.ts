import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";

// Scheduled handover snapshot endpoint.
//
// Called by pg_cron (see the cron job configured in Cloud) at the top of each
// hour. The snapshot logic only actually saves a version during the 8am and 8pm
// London handover hours, so an hourly trigger yields exactly two versions a day
// across BST/GMT. Guarded by the shared cron secret so random public callers
// cannot trigger it. The response contains only aggregate counts — never patient
// data — so it is safe to log.
export const Route = createFileRoute("/api/public/hooks/handover-snapshot")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Accept either configured cron/bridge secret via x-bridge-secret,
        // matching the bridge-sync hook so the same pg_cron credential works.
        const accepted = [
          process.env.BRIDGE_SYNC_CRON_SECRET,
          process.env.HANDOVER_API_SECRET,
        ].filter((v): v is string => typeof v === "string" && v.length > 0);
        if (accepted.length === 0) {
          return Response.json(
            { error: "Snapshot not configured" },
            { status: 503 },
          );
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
          const { captureHandoverSnapshot } = await import(
            "@/lib/handover-snapshot.server"
          );
          const result = await captureHandoverSnapshot({ force: false });
          return Response.json(result, { status: 200 });
        } catch (e) {
          const message = e instanceof Error ? e.message : "Snapshot failed";
          console.error("[handover-snapshot] run failed:", message);
          return Response.json({ ok: false, error: message }, { status: 500 });
        }
      },
    },
  },
});
