import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineTool } from "@agentic/agent-kit";
import { canonicalToolCassetteKey } from "@agentic/shared/cassette";
import { globalToolRegistry, listGlobalTools } from "@agentic/tools";
import { probeGlobalIntegration } from "../src/services/agent-factory/integration-probe";

const catalog = {
  name: "vendor.lookup",
  category: "vendor",
  summary: "lookup",
  sideEffect: "read" as const,
  operation: "read" as const,
  effectScope: "external" as const,
  sandboxPolicy: "live_external" as const,
  argsSchema: { id: { type: "string", required: true } },
  returnsSchema: { result: { type: "object", required: true } },
  configSchema: { api_key_env: { type: "string" } },
  capabilities: [{ systems: ["Vendor"], kinds: ["external_api"], roles: ["reads"], operations: ["lookup"], probeRequired: true }],
  sourcePath: "packages/tools/src/vendor/lookup.ts",
};

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const writeProbeSafety = {
  testDataContract: {
    kind: "synthetic_canary" as const,
    marker: { kind: "argument" as const, path: "probe.marker", valuePrefix: "factory-canary-" },
  },
  idempotency: { kind: "argument" as const, path: "probe.idempotency_key", valuePrefix: "factory-idem-" },
  isolation: {
    namespace: { kind: "argument" as const, path: "probe.namespace", valuePrefix: "factory-ns-" },
    target: { kind: "argument" as const, path: "probe.target", valuePrefix: "factory-target-" },
  },
  cleanup: { kind: "handler" as const, handler: "vendor.lookup.cleanupCanary" },
  absenceProof: { kind: "handler" as const, handler: "vendor.lookup.readCanary" },
};

describe("global integration probe", () => {
  it("executes a read adapter, validates schema, and redacts cassette bodies", async () => {
    const handler = vi.fn(async () => ({ data: { result: { ok: true, token: "vendor-secret" } } }));
    const result = await probeGlobalIntegration({
      catalog,
      descriptor: defineTool({ name: catalog.name, description: "lookup", handler }),
      args: { id: "r-1" },
      tenantSlug: "tenant-sb",
      persistCassette: false,
    });
    expect(result.verified).toBe(true);
    expect(result.definitionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(handler).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.cassette)).not.toContain("vendor-secret");
  });

  it("recursively redacts and bounds global result.data before cassette persistence", async () => {
    vi.stubEnv("GLOBAL_PROBE_TOKEN", "plain-field-secret");
    let deep: Record<string, unknown> = { token: "nested-secret" };
    for (let index = 0; index < 20; index++) deep = { next: deep };
    const handler = vi.fn(async () => ({
      data: {
        result: {
          token: "vendor-secret",
          note: "adapter echoed plain-field-secret",
          huge: "x".repeat(20_000),
          deep,
          rows: Array.from({ length: 100 }, (_, index) => ({ index, session: `session-${index}` })),
        },
      },
    }));
    const result = await probeGlobalIntegration({
      catalog,
      descriptor: defineTool({ name: catalog.name, description: "lookup", handler }),
      args: { id: "r-bounded", metadata: { token: "argument-secret" } },
      config: { nested: { auth: [{ api_key_env: "GLOBAL_PROBE_TOKEN" }] } },
      tenantSlug: "tenant-sb",
      persistCassette: false,
    });
    const serialized = JSON.stringify(result.cassette);
    expect(result.verified).toBe(true);
    expect(serialized).not.toContain("vendor-secret");
    expect(serialized).not.toContain("nested-secret");
    expect(serialized).not.toContain("plain-field-secret");
    expect(serialized).not.toContain("argument-secret");
    expect(serialized).toContain("TRUNCATED");
    expect(serialized.length).toBeLessThan(80_000);
    expect(result.cassette?.entries[0]?.key).toBe(canonicalToolCassetteKey(catalog.name, {
      id: "r-bounded",
      metadata: { token: "[REDACTED]" },
    }));
  });

  it.each(["call", undefined] as const)("fails closed when %s legacy side-effect metadata has no explicit execution policy", async (sideEffect) => {
    const handler = vi.fn(async () => ({ data: { result: {} } }));
    const result = await probeGlobalIntegration({
      catalog: { ...catalog, sideEffect, operation: undefined as never },
      descriptor: defineTool({ name: catalog.name, description: "lookup", handler }),
      args: { id: "r-1" },
      tenantSlug: "tenant-sb",
      persistCassette: false,
    });
    expect(result).toMatchObject({
      verified: false,
      classification: "needs_config",
      next: "ask_user",
      missing: ["tool_execution_policy"],
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns needs_config/ask_user for an incomplete write contract before authorization or I/O", async () => {
    const handler = vi.fn(async () => ({ data: { result: {} } }));
    const result = await probeGlobalIntegration({
      catalog: { ...catalog, sideEffect: "write", operation: "write", sandboxPolicy: "requires_attempt_grant" },
      descriptor: defineTool({ name: catalog.name, description: "lookup", handler }),
      args: { id: "r-1" },
      tenantSlug: "tenant-sb",
      persistCassette: false,
      authorization: { actor: "user-1", allowSideEffects: true },
    });
    expect(result).toMatchObject({
      verified: false,
      classification: "needs_config",
      next: "ask_user",
      missing: expect.arrayContaining(["test_data_contract", "idempotency_key", "canary_namespace", "canary_target", "cleanup", "absence_readback"]),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("persists redacted create+cleanup+absence proof for a fully isolated write canary", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentic-write-probe-"));
    roots.push(root);
    const order: string[] = [];
    const handler = vi.fn(async (ctx: { event: { data: Record<string, unknown> } }) => {
      order.push("create");
      const probe = ctx.event.data.probe as Record<string, string>;
      return { data: { result: { ok: true, echoed_target: probe.target, token: "create-secret" } } };
    });
    const cleanup = vi.fn(async ({ canary }: { canary: { target: string } }) => {
      order.push("cleanup");
      return { completed: true, evidence: { deleted: canary.target, token: "cleanup-secret" } };
    });
    const readback = vi.fn(async ({ canary }: { canary: { target: string } }) => {
      order.push("readback");
      return { absent: true, evidence: { target: canary.target, rows: 0 } };
    });
    const result = await probeGlobalIntegration({
      catalog: { ...catalog, sideEffect: "write", operation: "write", sandboxPolicy: "requires_attempt_grant", probeSafety: writeProbeSafety },
      descriptor: defineTool({ name: catalog.name, description: "lookup", handler: handler as never }),
      args: { id: "r-1" },
      config: { api_key: "config-secret" },
      tenantSlug: "tenant-sb",
      dataRoot: root,
      persistCassette: true,
      canarySeed: "a".repeat(64),
      authorization: { actor: "user-1", allowSideEffects: true },
      writeProbeLifecycle: {
        identity: { id: "test/vendor-write", revision: "1" },
        cleanup: cleanup as never,
        readback: readback as never,
      },
    });
    expect(result).toMatchObject({
      verified: true,
      classification: "verified",
      writeProbeProof: {
        schema: "agent-factory-write-probe/v1",
        create: { completed: true },
        cleanup: { completed: true },
        absence: { verified: true },
      },
    });
    expect(order).toEqual(["create", "cleanup", "readback"]);
    const stored = await readFile(result.cassettePath!, "utf8");
    expect(stored).not.toContain("factory-target-");
    expect(stored).not.toContain("factory-ns-");
    expect(stored).not.toContain("factory-idem-");
    expect(stored).not.toContain("create-secret");
    expect(stored).not.toContain("cleanup-secret");
    expect(stored).not.toContain("config-secret");
    expect(JSON.parse(stored).evidence.writeProbe).toEqual(result.writeProbeProof);
  });

  it("does not verify a write when cleanup or absence proof fails", async () => {
    const result = await probeGlobalIntegration({
      catalog: { ...catalog, sideEffect: "write", operation: "write", sandboxPolicy: "requires_attempt_grant", probeSafety: writeProbeSafety },
      descriptor: defineTool({ name: catalog.name, description: "lookup", handler: async () => ({ data: { result: {} } }) }),
      args: { id: "r-1" },
      tenantSlug: "tenant-sb",
      persistCassette: false,
      canarySeed: "b".repeat(64),
      authorization: { actor: "user-1", allowSideEffects: true },
      writeProbeLifecycle: {
        identity: { id: "test/vendor-write", revision: "1" },
        cleanup: async () => ({ completed: false, evidence: { deleted: false } }),
        readback: async () => ({ absent: false, evidence: { rows: 1 } }),
      },
    });
    expect(result).toMatchObject({
      verified: false,
      classification: "cleanup_failed",
      writeProbeProof: { cleanup: { completed: false }, absence: { verified: false } },
    });
  });

  it.each(["inviteCandidateApi", "postgres.executeStatement", "ontology.writeInstance"])(
    "keeps current registry tool %s at needs_config without calling its service",
    async (name) => {
      const current = listGlobalTools().find((entry) => entry.name === name)!;
      const descriptor = globalToolRegistry.get(name)!;
      const result = await probeGlobalIntegration({
        catalog: current,
        descriptor,
        args: {},
        tenantSlug: "tenant-sb",
        persistCassette: false,
        authorization: { actor: "user-1", allowSideEffects: true },
      });
      expect(result).toMatchObject({ verified: false, classification: "needs_config", next: "ask_user" });
    },
  );

  it("classifies a successful but incompatible response as schema_mismatch", async () => {
    const result = await probeGlobalIntegration({
      catalog,
      descriptor: defineTool({ name: catalog.name, description: "lookup", handler: async () => ({ data: { wrong: true } }) }),
      args: { id: "r-1" },
      tenantSlug: "tenant-sb",
      persistCassette: false,
    });
    expect(result).toMatchObject({ verified: false, classification: "schema_mismatch" });
  });
});
