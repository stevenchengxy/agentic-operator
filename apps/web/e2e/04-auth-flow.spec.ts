/**
 * P4-TEST-04 — E2E: auth flow.
 *
 * Drives the browser through:
 *
 *   1. Navigate to /portal/raas/dashboard — should redirect to /sign-in.
 *   2. Sign in as the explicitly configured bootstrap admin through
 *      `/v1/auth/login` and land on
 *      `/portal/raas/dashboard`.
 *   3. From the same browser context, request /v1/agents via fetch and
 *      assert 200 with a JSON envelope — proves the session cookie is
 *      carried across the Next rewrite.
 *
 * The portal is the Next App Router application. We assert the nav shell
 * renders and the cookie roundtrips to apps/api correctly.
 */

import { test, expect } from "@playwright/test";
import { API_BASE, loginBootstrapAdmin } from "./helpers";

test.describe("P4-TEST-04: auth flow E2E", () => {
  test("unauthenticated → sign-in → portal renders", async ({ page }) => {
    await page.goto("/portal/raas/dashboard");
    await page.waitForURL(/\/sign-in/, { timeout: 15_000 });
    await loginBootstrapAdmin(page);
    expect(page.url()).toMatch(/\/portal\/raas\/dashboard|\/portal\//);
  });

  test("portal dashboard view renders the nav shell", async ({ page }) => {
    await loginBootstrapAdmin(page);
    await page.goto("/portal/raas/dashboard");
    // The App Router shell mounts a `<nav>` element with the sidebar.
    await page.waitForSelector("nav", { timeout: 15_000 });
    // Title / brand mark should be present.
    const html = await page.content();
    expect(html.toLowerCase()).toMatch(/(agentic|operator|portal)/);
  });

  test("authenticated browser carries cookie to /v1/agents", async ({ page }) => {
    await loginBootstrapAdmin(page);

    // Make an in-page fetch so the login cookie rides on the same origin. The Next rewrite under
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
