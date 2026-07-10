import { createFileRoute } from "@tanstack/react-router";

// Public health endpoint that reports whether the connected database matches
// the schema this app requires. Returns 200 when healthy, 503 with the list of
// missing tables/columns when not. Safe to expose: it leaks no data, only the
// names of missing schema objects.
export const Route = createFileRoute("/api/public/health/schema")({
  server: {
    handlers: {
      GET: async () => {
        const { validateSchema, formatSchemaError } = await import(
          "@/lib/schema-validation.server"
        );
        const result = await validateSchema(true);
        if (result.ok) {
          return Response.json({ ok: true, checkedAt: result.checkedAt });
        }
        return Response.json(
          {
            ok: false,
            checkedAt: result.checkedAt,
            problems: result.problems,
            message: formatSchemaError(result),
          },
          { status: 503 },
        );
      },
    },
  },
});
