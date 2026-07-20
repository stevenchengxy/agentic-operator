import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { SandboxCancelFenceStore } from "../src/services/agent-factory/sandbox-cancel-fence";

const key = "sandbox-cancel-fence-test-integrity-key-at-least-32-bytes";
const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(path.join(tmpdir(), "factory-cancel-fence-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("durable sandbox cancel fences", () => {
  it("survives restart, fails closed at capacity, and prunes only after expiry", () => {
    const directory = root();
    const now = new Date("2026-07-16T00:00:00.000Z");
    const store = new SandboxCancelFenceStore(directory, key, 1);
    store.fence({
      attemptId: "attempt-retained",
      bundleHash: "bundle-retained",
      sandboxTenantSlug: "af-sbx-retained-sb",
      appId: "agentic-factory-sandbox-af-sbx-retained-sb",
      expiresAt: "2026-07-16T00:10:00.000Z",
    }, now);
    expect(() => store.fence({
      attemptId: "attempt-over-capacity",
      bundleHash: "bundle-over-capacity",
      sandboxTenantSlug: "af-sbx-over-capacity-sb",
      appId: "agentic-factory-sandbox-af-sbx-over-capacity-sb",
      expiresAt: "2026-07-16T00:10:00.000Z",
    }, now)).toThrow(/capacity exceeded/);
    expect(store.removeVerifiedExpired("attempt-retained", new Date("2026-07-16T00:09:59.000Z"))).toBe(false);

    const restarted = new SandboxCancelFenceStore(directory, key, 1);
    expect(restarted.get("attempt-retained")).toMatchObject({ bundleHash: "bundle-retained" });
    expect(restarted.removeVerifiedExpired("attempt-retained", new Date("2026-07-16T00:10:01.000Z"))).toBe(true);
    expect(new SandboxCancelFenceStore(directory, key, 1).size).toBe(0);
  });
});
