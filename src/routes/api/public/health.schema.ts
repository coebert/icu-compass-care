import { createFileRoute } from "@tanstack/react-router";

// Public health endpoint that reports whether the connected database matches
// the schema this app requires. Returns 200 when healthy, 503 with the list of
// missing tables/columns when not. Safe to expose: it leaks no data, only the
// names of missing schema objects.
export const Route = createFileRoute("/api/public/health/schema")({
  server: {
    handlers: {
      // Minimal, cached answer: uses the memoised validation (no forced
      // re-run per request) and never lists schema details publicly.
      GET: async () => {
        const { validateSchema } = await import("@/lib/schema-validation.server");
        const result = await validateSchema(false);
        return Response.json(
          { ok: result.ok },
          { status: result.ok ? 200 : 503, headers: { "cache-control": "public, max-age=60" } },
        );
      },
    },
  },
});
