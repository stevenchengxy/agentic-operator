/**
 * TC-26 — P3-API-03 inngest-registry bookkeeping.
 *
 * Pure-unit: verifies the registry state machine without going through
 * Inngest's `serve()` (which requires a real client). The real wiring is
 * exercised by the existing TC-3 / TC-11 paths once the boot pipeline
 * initializes the registry.
 *
 * The handler-build call inside `initInngestRegistry()` requires a real
 * Inngest client, so this test uses the live boot to seed the registry
 * and then asserts on `_inspectRegistryForTests()`.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildTestEnv } from "./harness";

describe("TC-26: P3-API-03 inngest-registry", () => {
  beforeAll(async () => {
    // Boot the api so `bootstrapRuntime` runs and `initInngestRegistry`
    // gets called with a real Inngest client.
    await buildTestEnv();
  });

  it("registry exposes the boot-time function counts", async () => {
    const mod = await import("../src/services/inngest-registry");
    const counts = mod._inspectRegistryForTests();

    // Boot must initialize the registry with the platform function set and
    // at least one manifest-backed tenant function. A zero-count snapshot is
    // not a valid fallback: deploy hot-reload depends on this cache being the
    // source of truth for the active /inngest handler.
    expect(counts.base).toBeGreaterThan(0);
    expect(counts.tenant).toBeGreaterThan(0);
    expect(mod.listInngestFunctionIds()).toHaveLength(
      counts.base + counts.codeAgent + counts.tenant,
    );
  });

  it("getActiveHandler returns a callable when init has succeeded", async () => {
    const mod = await import("../src/services/inngest-registry");
    const handler = mod.getActiveHandler();
    expect(typeof handler).toBe("function");
  });
});
