import { defineConfig, configDefaults } from "vitest/config";
import { fileURLToPath } from "node:url";

// Tests that create synthetic accounts/patients on the CONNECTED (live) backend
// run only when explicitly opted in. The project has no staging copy, so the
// default suite must never mutate live accounts or records.
const LIVE_BACKEND_TESTS = ["tests/security/permission-matrix.test.ts", "tests/bridge-e2e.test.ts"];

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    exclude: [
      ...configDefaults.exclude,
      ...(process.env["ALLOW_LIVE_BACKEND_TESTS"] === "1" ? [] : LIVE_BACKEND_TESTS),
    ],
  },
});
