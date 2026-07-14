import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const API_URL = process.env.AGENTIC_API_URL ?? "http://localhost:3501";

/**
 * Next 16 ships Turbopack as default for dev. The web workspace has no
 * native module deps (better-sqlite3 lives in apps/api only), so Turbopack
 * is safe here. The api still runs on Node 26 + better-sqlite3 12 directly.
 *
 * Web is UI-only. All data calls go through /v1/* which Next rewrites to
 * apps/api on :3501. Same-origin in dev; in prod a reverse proxy serves the
 * same paths.
 *
 * Routing decisions (P5-TEN-01b — SPA / production split):
 *   - `/v1/*`, `/health`            → proxied to apps/api on :3501.
 *   - `/demo` and `/demo/*`         → static Babel SPA in /public/demo
 *                                     (the v1_1 design reference, NOT the
 *                                     production app).
 *   - everything else               → Next.js App Router. `/portal/*` is the
 *                                     real production UI (TypeScript +
 *                                     react-query); `/` redirects there via
 *                                     `apps/web/app/page.tsx`.
 *
 * Previous behaviour rewrote `/` and any unmatched path to /portal/index.html
 * (the SPA). That coupling let snapshot-restore mechanisms wipe the SPA-side
 * tenant wiring whenever they ran. Splitting the SPA into its own /demo
 * namespace lets the production Next portal serve the canonical UI without
 * being mistaken for the prototype.
 */
/** @type {import("next").NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: path.join(__dirname, "../.."),
  transpilePackages: ["@agentic/contracts"],
  typedRoutes: true,
  reactStrictMode: true,
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/v1/:path*", destination: `${API_URL}/v1/:path*` },
        { source: "/health", destination: `${API_URL}/health` },
        // `/demo` without trailing slash → the SPA entry. Next serves
        // /public/demo/foo paths automatically (static files); the bare
        // `/demo` URL needs an explicit rewrite to the index.
        { source: "/demo", destination: "/demo/index.html" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
};

export default nextConfig;
