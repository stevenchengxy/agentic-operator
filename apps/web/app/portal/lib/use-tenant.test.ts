/**
 * useTenant — happy-path coverage. We can't realistically run React hooks
 * here without a renderer; instead we test the pure helpers exported from
 * `./use-tenant` directly. Wider e2e coverage is in the Playwright suite
 * (P2-FE-26 follow-up, P4-TEST-04).
 */
import { describe, expect, it } from "vitest";
import {
  resolveTenantParam,
  rewriteTenantInPath,
} from "./use-tenant";

describe("resolveTenantParam", () => {
  it("returns the raw param when it's a non-empty string", () => {
    expect(resolveTenantParam("support")).toBe("support");
  });

  it("uses only an explicitly supplied verified-session fallback", () => {
    expect(resolveTenantParam(undefined, "acme")).toBe("acme");
    expect(() => resolveTenantParam(undefined)).toThrow(
      "Tenant route parameter is required",
    );
  });

  it("returns the first element of an array param", () => {
    expect(resolveTenantParam(["foo", "bar"])).toBe("foo");
  });

  it("fails closed when an array param is empty", () => {
    expect(() => resolveTenantParam([])).toThrow(
      "Tenant route parameter is required",
    );
  });

  it("rejects malformed route and session tenant slugs", () => {
    expect(() => resolveTenantParam("../admin")).toThrow(
      "Tenant route parameter is required",
    );
    expect(() => resolveTenantParam(undefined, "bad/slug")).toThrow(
      "Tenant route parameter is required",
    );
  });
});

describe("rewriteTenantInPath", () => {
  it("swaps tenant on a typical view path", () => {
    expect(rewriteTenantInPath("/portal/raas/runs", "support")).toBe(
      "/portal/support/runs",
    );
  });

  it("drops tenant-scoped detail ids", () => {
    expect(
      rewriteTenantInPath("/portal/raas/runs/run-abc", "support"),
    ).toBe("/portal/support/runs");
  });

  it("treats /portal alone as no-rest", () => {
    expect(rewriteTenantInPath("/portal", "support")).toBe(
      "/portal/support/dashboard",
    );
  });

  it("preserves the settings usage view", () => {
    expect(rewriteTenantInPath("/portal/raas/settings/usage", "support")).toBe(
      "/portal/support/settings/usage",
    );
  });

  it("falls back to /portal/<tenant> when not under /portal", () => {
    expect(rewriteTenantInPath("/sign-in", "support")).toBe(
      "/portal/support/dashboard",
    );
  });

  it("handles an empty path", () => {
    expect(rewriteTenantInPath("/", "support")).toBe(
      "/portal/support/dashboard",
    );
  });

  it("rejects malformed tenant slugs", () => {
    expect(() => rewriteTenantInPath("/portal/raas/runs", "../admin")).toThrow(
      "Invalid tenant slug",
    );
  });
});
