import { createFileRoute } from "@tanstack/react-router";
import { corsHeaders } from "@/lib/api-bridge.server";
import { bridgeOpenApiSpec } from "@/lib/bridge-openapi";

// Publishes the OpenAPI 3.1 / JSON Schema specification for every
// /api/public/bridge/* endpoint. Unauthenticated and cacheable — it contains
// only documented shapes, no data or secrets.
export const Route = createFileRoute("/api/public/bridge/openapi")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: corsHeaders() }),

      GET: async () =>
        new Response(JSON.stringify(bridgeOpenApiSpec, null, 2), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "public, max-age=300",
            ...corsHeaders(),
          },
        }),
    },
  },
});
