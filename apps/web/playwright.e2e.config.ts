/**
 * Playwright config for the Phase 4 E2E suite (`apps/web/e2e/*.spec.ts`).
 *
 * This is a separate config from the Phase 2 pixel-diff harness
 * (`playwright.config.ts`) because E2E tests need a *running dev stack*
 * (api on :3540 + web on :3599 + optionally inngest on :8488), and they
 * write to the live SQLite. Mixing them into the same project would force
 * the visual suite to wait on the api boot too.
 *
 * Stack lifecycle:
 *   - In CI: the workflow boots `pnpm dev` in a background step, waits
 *     on `/health`, then runs `pnpm --filter @agentic/web test:e2e`.
 *     Set `PW_AUTO_WEBSERVER=1` if you want Playwright to boot the stack
 *     itself; default is to assume a pre-booted instance.
 *   - Locally: open one terminal with `pnpm dev`, then run
 *     `pnpm --filter @agentic/web test:e2e`.
 *
 * The `webServer` block boots all three processes via the repo-root
 * `pnpm dev` orchestrator and waits on the api health endpoint, which is
 * the slowest dependency (next boots faster, inngest is best-effort).
 */

import { defineConfig } from "@playwright/test";

const API_BASE = process.env.PW_API_BASE ?? "http://localhost:3540";
const WEB_BASE = process.env.PW_WEB_BASE ?? "http://localhost:3599";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: WEB_BASE,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Capture trace + screenshots on first retry so CI failures are
    // debuggable without re-runs.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // Pass the api base URL into the test process via env. Specs read it
  // through `process.env.E2E_API_BASE`.
  metadata: {
    apiBase: API_BASE,
  },
  // Optional auto-boot of the dev stack. Default off — most callers run
  // `pnpm dev` themselves to keep iteration fast. CI flips this on by
  // exporting PW_AUTO_WEBSERVER=1.
  ...(process.env.PW_AUTO_WEBSERVER === "1"
    ? {
        webServer: [
          {
            // The repo-level `pnpm dev` concurrently launches web (3599),
            // api (3540), and inngest dev (8488). It accepts a SIGTERM
            // cleanly via the wrapper.
            command: "pnpm dev",
            // Wait on the api /health endpoint — it's the slowest dep.
            url: `${API_BASE}/health`,
            reuseExistingServer: true,
            timeout: 180_000,
            cwd: "../..",
            stdout: "pipe",
            stderr: "pipe",
            env: {
              // E2E mode: keep auth in dev-bypass so we can sign in via
              // the seeded admin without needing a Resend account. The
              // dev tenant is pinned to `raas` so manifest agents
              // (syncFromClientSystem, jdReview) are reachable via the
              // /v1/events ingest path. Code agents like `testAgent` are
              // invoked synchronously — the spec asserts on the invoke
              // response envelope rather than re-fetching the run row
              // (which lives under __system and would 404 to a `raas`
              // caller until a platform-admin layer lands).
              AUTH_MODE: "dev",
              AGENTIC_DEV_TENANT: "raas",
              NODE_ENV: "development",
              LLM_DEFAULT_PROVIDER: "mock",
              LLM_DEFAULT_MODEL: "mock-model-v1",
              // The rate-limit plugin (P4-API-03) defaults to 100
              // req/min/tenant. The E2E suite makes ~50 requests per
              // spec across 6 specs back-to-back; disabling here keeps
              // the gate behaviour intact while letting the suite finish.
              AGENTIC_RATE_LIMIT_DISABLED: "1",
            },
          },
        ],
      }
    : {}),
});
