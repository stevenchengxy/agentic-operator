import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { factoryToolProbes, factoryTools, getDb, tenants } from "@agentic/db";
import type { DeclarativeTool } from "@agentic/agent-factory";
import {
  beginFactoryActiveWork,
  hasAnyFactoryActiveWork,
} from "../src/services/agent-factory/active-work";
import {
  DeclarativeToolDeleteError,
  deleteDeclarativeTool,
  saveDeclarativeTool,
} from "../src/services/agent-factory/declarative-tool";
import { DrizzleToolStore } from "../src/services/agent-factory/stores";

const suffix = randomUUID();
const tenantA = `ten-tool-active-a-${suffix}`;
const tenantB = `ten-tool-active-b-${suffix}`;
const domain = `domain-tool-active-${suffix}`;

function tool(name: string): DeclarativeTool {
  return {
    name,
    description: "read-only test tool",
    method: "GET",
    urlTemplate: "https://example.invalid/read",
    sideEffect: "read",
    operation: "read",
    effectScope: "external",
    sandboxPolicy: "live_external",
    domain,
  };
}

describe("declarative tool mutation snapshot isolation", () => {
  beforeAll(() => {
    getDb().insert(tenants).values([
      { id: tenantA, slug: `tool-active-a-${suffix}`, name: "Tool active A" },
      { id: tenantB, slug: `tool-active-b-${suffix}`, name: "Tool active B" },
    ]).run();
  });

  afterEach(() => vi.unstubAllGlobals());

  afterAll(() => {
    getDb().delete(factoryToolProbes).where(eq(factoryToolProbes.tenantId, tenantA)).run();
    getDb().delete(factoryToolProbes).where(eq(factoryToolProbes.tenantId, tenantB)).run();
    getDb().delete(factoryTools).where(eq(factoryTools.scopeKey, tenantA)).run();
    getDb().delete(factoryTools).where(eq(factoryTools.scopeKey, tenantB)).run();
    getDb().delete(factoryTools).where(eq(factoryTools.name, `shared-${suffix}`)).run();
    getDb().delete(tenants).where(eq(tenants.id, tenantA)).run();
    getDb().delete(tenants).where(eq(tenants.id, tenantB)).run();
  });

  it("freezes tenant resources and every shared definition during active work", async () => {
    const existing = tool(`existing-${suffix}`);
    expect(saveDeclarativeTool(existing, { tenantId: tenantA })).toEqual({ ok: true });

    const release = beginFactoryActiveWork(tenantA, `promotion:${domain}`, "promotion");
    try {
      expect(hasAnyFactoryActiveWork()).toBe(true);

      expect(saveDeclarativeTool(tool(`blocked-${suffix}`), { tenantId: tenantA })).toMatchObject({
        ok: false,
        reason: expect.stringContaining("FACTORY_EXECUTION_ACTIVE"),
      });
      expect(saveDeclarativeTool(tool(`shared-${suffix}`), { tenantId: tenantB, shared: true })).toMatchObject({
        ok: false,
        reason: expect.stringContaining("FACTORY_EXECUTION_ACTIVE"),
      });

      // An unrelated tenant-private definition is not part of tenant A's
      // immutable execution snapshot and may continue to evolve.
      expect(saveDeclarativeTool(tool(`unrelated-${suffix}`), { tenantId: tenantB })).toEqual({ ok: true });

      await expect(
        new DrizzleToolStore(tenantA, domain).save(tool(`store-blocked-${suffix}`)),
      ).rejects.toThrow(/FACTORY_EXECUTION_ACTIVE/);

      let deletionError: unknown;
      try {
        deleteDeclarativeTool(existing.name, tenantA, false, domain);
      } catch (error) {
        deletionError = error;
      }
      expect(deletionError).toBeInstanceOf(DeclarativeToolDeleteError);
      expect(String((deletionError as Error & { cause?: unknown }).cause)).toContain("FACTORY_EXECUTION_ACTIVE");
    } finally {
      release();
    }

    expect(hasAnyFactoryActiveWork()).toBe(false);
    expect(deleteDeclarativeTool(existing.name, tenantA, false, domain)).toBe(true);
  });

  it("persists probe evidence with a definition-revision CAS and discards a stale receipt", async () => {
    const store = new DrizzleToolStore(tenantA, domain);
    const stable = tool(`probe-stable-${suffix}`);
    await store.save(stable);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
    const verified = await store.probe({ domain, name: stable.name, args: {}, actor: "test-user" });
    expect(verified.verified).toBe(true);
    const stableRow = getDb().select().from(factoryTools).where(eq(factoryTools.name, stable.name)).get()!;
    expect(stableRow).toMatchObject({
      description: stable.description,
      probeStatus: "verified",
      definitionHash: verified.definitionHash,
    });
    const secondary = await store.probe({
      domain,
      name: stable.name,
      args: {},
      config: { profile_key: "secondary" },
      actor: "test-user",
    });
    expect(secondary.verified).toBe(true);
    expect(secondary.definitionHash).not.toBe(verified.definitionHash);
    const listed = (await store.list(domain)).find((entry) => entry.name === stable.name)!;
    expect(listed.verifiedDefinitionHashes).toEqual([
      verified.definitionHash,
      secondary.definitionHash,
    ].sort());
    expect(listed.productionVerifiedDefinitionHashes).toEqual([
      verified.definitionHash,
      secondary.definitionHash,
    ].sort());
    expect(getDb().select().from(factoryToolProbes)
      .where(eq(factoryToolProbes.toolName, stable.name)).all()).toHaveLength(2);

    const drifting = tool(`probe-drift-${suffix}`);
    await store.save(drifting);
    const before = getDb().select().from(factoryTools).where(eq(factoryTools.name, drifting.name)).get()!;
    vi.stubGlobal("fetch", vi.fn(async () => {
      getDb().update(factoryTools).set({
        description: "changed while probe was in flight",
        updatedAt: new Date(before.updatedAt.getTime() + 1_000),
      }).where(eq(factoryTools.id, before.id)).run();
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));
    await expect(
      store.probe({ domain, name: drifting.name, args: {}, actor: "test-user" }),
    ).rejects.toThrow(/evidence CAS failed/);
    const after = getDb().select().from(factoryTools).where(eq(factoryTools.id, before.id)).get()!;
    expect(after).toMatchObject({
      description: "changed while probe was in flight",
      probeStatus: "required",
      definitionHash: null,
    });
  });
});
