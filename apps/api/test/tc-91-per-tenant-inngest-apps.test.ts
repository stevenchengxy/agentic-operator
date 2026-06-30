/**
 * TC-91 — One Inngest app per tenant.
 *
 * Validates the per-tenant app split end-to-end against a real boot:
 *   - boot builds one Inngest app per discovered tenant + the __system app
 *   - the registry serves a distinct handler per app, keyed by app id
 *   - app id + serve-path schemes are correct (agentic-operator-<slug>,
 *     /inngest for __system, /inngest/<slug> for tenants)
 *   - an unknown tenant resolves to NO handler (route would 404)
 *   - a scoped single-tenant re-register rebuilds ONLY that tenant's app and
 *     leaves every other tenant's app untouched (the per-tenant blast-radius
 *     isolation that motivates the split)
 *   - the inngest-sync helpers compute the right per-app URLs and no-op under
 *     test (no live Inngest server)
 */

import { beforeAll, describe, expect, it } from "vitest";
import { appIdForTenant, getTenantInngest, SYSTEM_SLUG } from "@agentic/runtime";
import { buildTestEnv } from "./harness";
import {
  getActiveHandler,
  getHandlerForApp,
  listRegisteredApps,
  servePathForSlug,
  reregisterInngest,
} from "../src/services/inngest-registry";
import { serveOrigin, syncTenantApp } from "../src/services/inngest-sync";

describe("TC-91: one Inngest app per tenant", () => {
  beforeAll(async () => {
    // Boot the api so bootstrapRuntime builds per-tenant apps + seeds the
    // per-app registry with real Inngest clients.
    await buildTestEnv();
  });

  it("client factory: app id scheme + per-slug caching", () => {
    expect(appIdForTenant("raas")).toBe("agentic-operator-raas");
    expect(appIdForTenant(SYSTEM_SLUG)).toBe("agentic-operator-__system");
    // Cached: same slug returns the same client instance.
    expect(getTenantInngest("raas")).toBe(getTenantInngest("raas"));
    expect(getTenantInngest("raas")).not.toBe(getTenantInngest("zhaopin"));
  });

  it("serve-path scheme: __system at /inngest, tenants at /inngest/<slug>", () => {
    expect(servePathForSlug(SYSTEM_SLUG)).toBe("/inngest");
    expect(servePathForSlug("raas")).toBe("/inngest/raas");
  });

  it("boot registers the __system app + at least one tenant app", () => {
    const apps = listRegisteredApps();
    const bySlug = new Map(apps.map((a) => [a.slug, a]));
    // __system always present.
    const sys = bySlug.get(SYSTEM_SLUG);
    expect(sys).toBeDefined();
    expect(sys?.appId).toBe("agentic-operator-__system");
    expect(sys?.servePath).toBe("/inngest");
    // At least one tenant app beyond __system.
    const tenantApps = apps.filter((a) => a.slug !== SYSTEM_SLUG);
    expect(tenantApps.length).toBeGreaterThanOrEqual(1);
    for (const t of tenantApps) {
      expect(t.appId).toBe(`agentic-operator-${t.slug}`);
      expect(t.servePath).toBe(`/inngest/${t.slug}`);
    }
  });

  it("each app has its own serve handler; unknown tenant has none", () => {
    // __system handler is callable (no-arg default + explicit).
    expect(typeof getActiveHandler()).toBe("function");
    expect(typeof getHandlerForApp(appIdForTenant(SYSTEM_SLUG))).toBe(
      "function",
    );
    // A real tenant app resolves a handler.
    const tenant = listRegisteredApps().find((a) => a.slug !== SYSTEM_SLUG)!;
    expect(typeof getHandlerForApp(tenant.appId)).toBe("function");
    // An unknown tenant → no handler (the route returns 404).
    expect(getHandlerForApp(appIdForTenant("no-such-tenant-xyz"))).toBeNull();
  });

  it("scoped re-register rebuilds ONLY the target tenant app", async () => {
    const before = listRegisteredApps();
    const target = before.find((a) => a.slug !== SYSTEM_SLUG)!;
    const otherAppIds = before
      .filter((a) => a.appId !== target.appId)
      .map((a) => a.appId)
      .sort();

    const out = await reregisterInngest({
      tenantSlug: target.slug,
      scope: "tenant",
    });
    expect(out.appId).toBe(target.appId);
    // The scoped rebuild reports the target app's own function count.
    expect(typeof out.appFnCount).toBe("number");

    const after = listRegisteredApps();
    // The full app set is unchanged (no app dropped, none added).
    expect(after.map((a) => a.appId).sort()).toEqual(
      before.map((a) => a.appId).sort(),
    );
    // Every OTHER app still present (the target rebuild didn't touch them).
    const afterOthers = after
      .filter((a) => a.appId !== target.appId)
      .map((a) => a.appId)
      .sort();
    expect(afterOthers).toEqual(otherAppIds);
    // The target app still serves the same number of functions it built at boot.
    const targetAfter = after.find((a) => a.appId === target.appId)!;
    expect(targetAfter.fnCount).toBe(target.fnCount);
  });

  it("inngest-sync: per-app URL + test no-op", async () => {
    const origin = serveOrigin();
    expect(origin).toMatch(/^https?:\/\//);
    // Under NODE_ENV=test sync is skipped but still computes the URL.
    const r = await syncTenantApp("raas");
    expect(r.ok).toBe(true);
    expect(r.url).toBe(`${origin}/inngest/raas`);
    const sysR = await syncTenantApp(SYSTEM_SLUG);
    expect(sysR.url).toBe(`${origin}/inngest`);
  });
});
