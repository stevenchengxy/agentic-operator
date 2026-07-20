import { afterEach, describe, expect, it, vi } from "vitest";
import { updateTenant } from "./useTenants";

const TENANT_DETAIL = {
  id: "ten-1",
  slug: "acme",
  name: "Acme AI",
  subtitle: null,
  color: "#5deeff",
  createdAt: 1,
  updatedAt: 2,
  archivedAt: null,
  agentCount: 0,
  runs24h: 0,
  openTasks: 0,
  workflowCount: 0,
  deploymentLiveCount: 0,
  membership: "admin" as const,
  budgets: null,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("updateTenant", () => {
  it("sends only the mutable tenant patch to the existing PUT route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({ ok: true, data: TENANT_DETAIL }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      updateTenant({
        slug: "acme",
        patch: { name: "Acme AI", color: "#5deeff" },
      }),
    ).resolves.toEqual(TENANT_DETAIL);

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/tenants/acme",
      expect.objectContaining({
        credentials: "same-origin",
        method: "PUT",
        body: JSON.stringify({ name: "Acme AI", color: "#5deeff" }),
      }),
    );
  });

  it("surfaces the API error instead of presenting a successful save", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        json: async () => ({
          ok: false,
          error: { code: "forbidden", message: "Admin access required" },
        }),
      }),
    );

    await expect(
      updateTenant({ slug: "acme", patch: { name: "Acme AI" } }),
    ).rejects.toThrow("forbidden — Admin access required");
  });
});
