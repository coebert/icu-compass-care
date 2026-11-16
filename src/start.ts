import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";
import { applySecurityHeaders } from "./lib/security-headers";
import { assertInputBounds, SERVER_FN_INPUT_BOUNDS } from "./lib/input-bounds";

const errorMiddleware = createMiddleware().server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    if (error != null && typeof error === "object" && "statusCode" in error) {
      throw error;
    }
    console.error(error);
    return new Response(renderErrorPage(), {
      status: 500,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }
});

// Startup schema guard: on the first server request per worker instance this
// validates the connected database against the app's required schema and fails
// fast with a clear error if a table/column is missing (memoized after success).
// Dynamically imported so the server-only validator never enters the client bundle.
const schemaGuardMiddleware = createMiddleware().server(async ({ next }) => {
  const { assertSchema } = await import("./lib/schema-validation.server");
  await assertSchema();
  return next();
});

const securityHeadersMiddleware = createMiddleware().server(async ({ next }) => {
  const result = await next();
  const res = result instanceof Response ? result : result.response;
  try {
    applySecurityHeaders(res.headers);
  } catch {
    // Immutable headers (e.g. some proxied responses): leave untouched.
  }
  return result;
});

// Structural size guard for every server function (GHSA-mrhx-c7xc-m3w5): runs on
// the server before requireSupabaseAuth and before any Zod inputValidator, so an
// oversized list is refused in bounded time instead of being expanded into one
// Zod issue per element. Normal payloads are far below the limits.
const inputBoundsMiddleware = createMiddleware({ type: "function" }).server(
  async ({ data, next }) => {
    assertInputBounds(data, SERVER_FN_INPUT_BOUNDS);
    return next();
  },
);

export const startInstance = createStart(() => ({
  functionMiddleware: [inputBoundsMiddleware, attachSupabaseAuth],
  requestMiddleware: [securityHeadersMiddleware, errorMiddleware, schemaGuardMiddleware],
}));
