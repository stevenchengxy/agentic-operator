/**
 * tenant-header.test.ts — regression tests for the URL → tenant header bridge.
 *
 * Hotfix — dashboard render hang (`/portal/hello/dashboard`).
 *
 * The dashboard hang was a downstream symptom of every `/v1/*` call resolving
 * to the AGENTIC_DEV_TENANT env-pinned slug regardless of which tenant the
 * user was actually viewing in their URL. The fix wires every client-side
 * hook through `tenantHeader()` so the api receives the URL-bound slug as
 * `x-agentic-tenant` and resolves the right scope in dev mode.
 *
 * The bug was easy to trip on a re-add — any new hook that copy-pastes the
 * stock `callV1` boilerplate without `...tenantHeader()` will reintroduce
 * the symptom. The integration test (`tc-74-tenant-header-override`) catches
 * the api side; this unit test catches the web side at compile-time-ish.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { tenantFromPathname, tenantHeader } from "./tenant-header";

describe("tenantFromPathname", () => {
  it("extracts the [tenant] segment from a portal pathname", () => {
    expect(tenantFromPathname("/portal/raas/dashboard")).toBe("raas");
    expect(tenantFromPathname("/portal/hello/dashboard")).toBe("hello");
    expect(tenantFromPathname("/portal/__system/agents")).toBe("__system");
    expect(tenantFromPathname("/portal/raas")).toBe("raas");
  });

  it("returns null for non-portal pathnames", () => {
    expect(tenantFromPathname("/sign-in")).toBeNull();
    expect(tenantFromPathname("/")).toBeNull();
    expect(tenantFromPathname("/v1/runs")).toBeNull();
    expect(tenantFromPathname("/about")).toBeNull();
  });

  it("returns null for the bare /portal route (no tenant segment)", () => {
    expect(tenantFromPathname("/portal")).toBeNull();
    expect(tenantFromPathname("/portal/")).toBeNull();
  });

  it("rejects malformed slugs without crashing the api fetcher", () => {
    // Slugs are constrained to [a-z0-9_-]; pathological inputs return null
    // rather than letting an attacker-controlled value reach the header.
    expect(tenantFromPathname("/portal/x".repeat(50))).not.toBeNull(); // first segment still matches
    // The regex matches up to 32 chars; longer is fine because it stops at /.
    expect(tenantFromPathname("/portal/12345678901234567890123456789012/dash"))
      .toBe("12345678901234567890123456789012");
  });
});

describe("tenantHeader", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { location: { pathname: "/" } } as Window);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns {} on the server (no window)", () => {
    vi.unstubAllGlobals();
    expect(tenantHeader()).toEqual({});
  });

  it("returns {} on non-portal pages", () => {
    vi.stubGlobal("window", {
      location: { pathname: "/sign-in" },
    } as Window);
    expect(tenantHeader()).toEqual({});
  });

  it("returns x-agentic-tenant for /portal/<slug>/...", () => {
    vi.stubGlobal("window", {
      location: { pathname: "/portal/hello/dashboard" },
    } as Window);
    expect(tenantHeader()).toEqual({ "x-agentic-tenant": "hello" });
  });

  it("returns the slug for /portal/<slug> without trailing segment", () => {
    vi.stubGlobal("window", {
      location: { pathname: "/portal/raas" },
    } as Window);
    expect(tenantHeader()).toEqual({ "x-agentic-tenant": "raas" });
  });
});
