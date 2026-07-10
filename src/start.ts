import { createStart, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { attachSupabaseAuth } from "@/integrations/supabase/auth-attacher";

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

export const startInstance = createStart(() => ({
  functionMiddleware: [attachSupabaseAuth],
  requestMiddleware: [errorMiddleware, schemaGuardMiddleware],
}));
