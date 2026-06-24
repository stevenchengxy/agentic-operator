/**
 * TC-35 — Control-plane hot-swap (上线/下线 without a restart).
 *
 * Proves the wiring completed in this change: boot seeds the MUTABLE Inngest
 * registry, `rebuildTenantFns` re-runs the manifest bootstrap, and a runtime
 * re-register swaps the served function set. Before this change every one of
 * these assertions failed:
 *   - boot never called `initInngestRegistry` → registry counts were all 0;
 *   - `rebuildTenantFns` didn't exist → import threw;
 *   - `reregisterInngest` no-op'd (no `rebuildTenantFns`) → disabling an agent
 *     never dropped its function.
 *
 * Integration (shares data/agentic.db). It disables a tenant's agents, asserts
 * their functions drop from the served set, then restores the exact prior
 * enabled-state in `finally` so sibling test files see baseline.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildTestEnv } from "./harness";
import { agents, and, eq, getDb, inArray, tenants, workflows } from "@agentic/db";

const TENANT = "raas"; // seeded + has on-disk manifest agents (models/RAAS-v1)

describe("TC-35: control-plane hot-swap", () => {
  beforeAll(async () => {
    // Boot so `bootstrapRuntime` runs `initInngestRegistry` with a real client.
    await buildTestEnv();
  });

  it("boot seeds the mutable registry with helloFn + tenant manifest fns", async () => {
    const { _inspectRegistryForTests } = await import(
      "../src/services/inngest-registry"
    );
    const c = _inspectRegistryForTests();
    expect(c.base).toBeGreaterThanOrEqual(1); // helloFn
    expect(c.tenant).toBeGreaterThan(0); // manifest agents registered
  });

  it("rebuildTenantFns re-runs bootstrapAll and returns a non-empty fn set", async () => {
    const { rebuildTenantFns } = await import("../src/bootstrap");
    const fns = await rebuildTenantFns();
    expect(Array.isArray(fns)).toBe(true);
    expect(fns.length).toBeGreaterThan(0);
  });

  it("下线: disabling a tenant's agents drops their fns; re-enabling restores them", async () => {
    const { _inspectRegistryForTests, reregisterInngest } = await import(
      "../src/services/inngest-registry"
    );
    const db = getDb();

    const tenant = db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, TENANT))
      .all()[0];
    expect(tenant).toBeTruthy();

    const wfIds = db
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.tenantId, tenant!.id))
      .all()
      .map((r) => r.id);
    expect(wfIds.length).toBeGreaterThan(0);

    const agentRows = db
      .select({ id: agents.id, enabled: agents.enabled })
      .from(agents)
      .where(inArray(agents.workflowId, wfIds))
      .all();
    expect(agentRows.length).toBeGreaterThan(0);
    const priorEnabled = new Map(agentRows.map((r) => [r.id, r.enabled]));

    // Baseline: re-register with the tenant fully enabled.
    await reregisterInngest({ tenantSlug: TENANT, scope: "tenant" });
    const beforeTenant = _inspectRegistryForTests().tenant;

    try {
      // 下线 — disable every agent of this tenant, then re-register.
      db.update(agents)
        .set({ enabled: false, updatedAt: new Date() })
        .where(inArray(agents.workflowId, wfIds))
        .run();
      await reregisterInngest({ tenantSlug: TENANT, scope: "tenant" });
      const afterTenant = _inspectRegistryForTests().tenant;

      expect(afterTenant).toBeLessThan(beforeTenant);
    } finally {
      // Restore exact prior enabled-state regardless of assertion outcome.
      for (const [id, en] of priorEnabled) {
        db.update(agents)
          .set({ enabled: en, updatedAt: new Date() })
          .where(eq(agents.id, id))
          .run();
      }
      await reregisterInngest({ tenantSlug: TENANT, scope: "tenant" });
    }

    // 上线 (restored) — count is back to baseline.
    const restoredTenant = _inspectRegistryForTests().tenant;
    expect(restoredTenant).toBe(beforeTenant);
    void and; // (imported for parity with sibling tests; not needed here)
  });
});
