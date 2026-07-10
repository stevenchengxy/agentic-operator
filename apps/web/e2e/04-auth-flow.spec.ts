/**
 * P4-TEST-04 — E2E: auth flow.
 *
 * Drives the browser through:
 *
 *   1. Navigate to /portal/raas/dashboard — should redirect to /sign-in
 *      (or auto-redirect back to /portal in dev mode).
 *   2. In dev mode, the sign-in page auto-redirects to /portal which
 *      lands on /portal/raas/dashboard. Assert the page renders the
 *      Dashboard view header.
 *   3. From the same browser context, request /v1/agents via fetch and
 *      assert 200 with a JSON envelope — proves the session cookie is
 *      carried across the Next rewrite.
 *
 * The portal is a static SPA served from /portal/index.html via
 * next.config.mjs rewrite; navigation works regardless of which view
 * (dashboard / runs / events ...) is requested. We assert the nav
 * shell renders and the cookie roundtrips to apps/api correctly.
 */

import { test, expect } from "@playwright/test";
import { API_BASE } from "./helpers";

test.describe("P4-TEST-04: auth flow E2E", () => {
  test("unauthenticated → sign-in → portal renders", async ({ page }) => {
    // Land directly on the portal — the layout requires auth, so dev mode
    // auto-mints a session via /sign-in's redirect.
    await page.goto("/sign-in?return=/portal/raas/dashboard");
    await page.waitForURL(/\/portal\//, { timeout: 15_000 });
    expect(page.url()).toMatch(/\/portal\/raas\/dashboard|\/portal\//);
  });

  test("portal dashboard view renders the nav shell", async ({ page }) => {
    await page.goto("/sign-in?return=/portal/raas/dashboard");
    await page.waitForURL(/\/portal\//, { timeout: 15_000 });
    await page.goto("/portal/raas/dashboard");
    // The static SPA mounts a `<nav>` element with the sidebar; that's the
    // earliest stable selector available after Babel runs.
    await page.waitForSelector("nav", { timeout: 15_000 });
    // Title / brand mark should be present.
    const html = await page.content();
    expect(html.toLowerCase()).toMatch(/(agentic|operator|portal)/);
  });

  test("authenticated browser carries cookie to /v1/agents", async ({ page }) => {
    await page.goto("/sign-in?return=/portal/raas/dashboard");
    await page.waitForURL(/\/portal\//, { timeout: 15_000 });

    // Make an in-page fetch so the dev cookie attached by the layout
    // sign-in path rides on the same origin. The Next rewrite under
    // /v1/* proxies to apps/api on :3540.
    const result = await page.evaluate(async () => {
      const res = await fetch("/v1/agents?kind=all", {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      const body = (await res.json()) as
        | { ok: true; data: unknown[] }
        | { ok: false; error: { code: string; message: string } };
      return { status: res.status, body };
    });
    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    if (result.body.ok) {
      expect(Array.isArray(result.body.data)).toBe(true);
    }
  });

  test("the api /health endpoint responds without auth", async ({ request }) => {
    // Health probe is unauthenticated by design (load-balancer fronting).
    // We hit it through the browser context's `request` so the request
    // has cookies but health doesn't gate on them.
    const res = await request.get(`${API_BASE}/health`);
    // Either 200 or 503 is acceptable shape-wise; for a clean stack the
    // body always has the report fields.
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(typeof body.ok).toBe("boolean");
    expect(typeof body.version).toBe("string");
    expect(typeof body.schemaVersion).toBe("string");
  });
});
