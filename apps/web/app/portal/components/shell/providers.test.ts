import { describe, expect, it } from "vitest";
import { portalTenantScope } from "./providers";

describe("portalTenantScope", () => {
  it("isolates caches by the tenant URL segment", () => {
    expect(portalTenantScope("/portal/raas/runs")).toBe("raas");
    expect(portalTenantScope("/portal/northwind/dashboard")).toBe("northwind");
  });

  it("keeps nested routes in the same tenant scope", () => {
    expect(portalTenantScope("/portal/raas/runs/run-1")).toBe(
      portalTenantScope("/portal/raas/logs"),
    );
  });

  it("uses a non-tenant scope outside a tenant route", () => {
    expect(portalTenantScope("/portal")).toBe("__portal__");
    expect(portalTenantScope(null)).toBe("__portal__");
  });

  it("does not throw on a malformed encoded tenant segment", () => {
    expect(portalTenantScope("/portal/%E0%A4%A/runs")).toBe(
      "__invalid__:%E0%A4%A",
    );
  });
});
