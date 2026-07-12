// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const tslibEsmPath = fileURLToPath(new URL("./node_modules/tslib/tslib.es6.mjs", import.meta.url));

/**
 * The bundled dev devtools plugin injects `data-tsd-source="file:line:col"`
 * attributes into JSX. Its line/column values are computed at different points
 * in the SSR vs client transform pipelines, so the SAME element (e.g. the
 * <html>/<head>/<body> shell in __root.tsx) ends up with DIFFERENT
 * `data-tsd-source` values on the server and the client. React then sees a
 * hydration attribute mismatch on the document shell and throws away the whole
 * server tree to regenerate it on the client — which shows up as the preview
 * failing to load cleanly / flashing on every navigation.
 *
 * These attributes are dev-only (already stripped from production builds), so
 * removing them from BOTH the SSR and client transforms in dev makes the two
 * outputs identical again and eliminates the mismatch, with no effect on
 * production. We run at `enforce: "post"` so the attribute is present in the
 * compiled output of every environment before we strip it.
 */
function stripTsdSourceAttr(): Plugin {
  return {
    name: "lovable:strip-data-tsd-source",
    enforce: "post",
    apply: "serve",
    transform(code) {
      if (!code.includes("data-tsd-source")) return null;
      const next = code.replace(/"data-tsd-source":\s*"[^"]*",?\s*/g, "");
      if (next === code) return null;
      return { code: next, map: null };
    },
  };
}

export default defineConfig({
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
  vite: {
    plugins: [stripTsdSourceAttr()],
    resolve: {
      alias: {
        // @simplewebauthn/server pulls in @peculiar/* packages that import
        // tslib helpers. In the Worker SSR bundle, resolving tslib through its
        // CommonJS entry can produce `__toESM(...).default === undefined` and
        // crash every route at startup. Force the ESM helper entry instead.
        tslib: tslibEsmPath,
      },
    },
  },
});
