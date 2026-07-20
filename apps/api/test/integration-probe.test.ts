import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalToolCassetteKey, lookupCanonicalToolCassette } from "@agentic/shared/cassette";
import { declarativeToolDefinitionHash, integrationProbeScope, probeDeclarativeIntegration } from "../src/services/agent-factory/integration-probe";

const roots: string[] = [];
afterEach(async () => {
  delete process.env.NESTED_PROBE_SECRET;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const tool = {
  name: "acme.lookup",
  description: "lookup",
  method: "POST",
  urlTemplate: "https://api.example.com/lookup",
  bodyTemplate: '{"id":"{id}"}',
  sideEffect: "read",
  operation: "read" as const,
  effectScope: "external" as const,
  sandboxPolicy: "live_external" as const,
  domain: "test",
  paramsSchema: { id: { type: "string", required: true } },
  returnsSchema: { result: { type: "object", required: true } },
};

const probeScope = integrationProbeScope({ tenantId: "ten-probe", domainId: "test" });

describe("probeDeclarativeIntegration", () => {
  it("validates, records, redacts, persists and replays a definition-bound cassette", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentic-probe-"));
    roots.push(root);
    const result = await probeDeclarativeIntegration({
      tool: { ...tool, bodyTemplate: '{"id":"{id}","api_key":"{api_key}"}' },
      args: { id: "x" },
      config: { api_key: "secret-config" },
      tenantSlug: probeScope,
      dataRoot: root,
      persistCassette: true,
      fetchFn: (async () => new Response(JSON.stringify({ result: { ok: true, token: "vendor-secret" } }), { status: 200 })) as typeof fetch,
    });
    expect(result).toMatchObject({ verified: true, classification: "verified", status: 200 });
    const stored = JSON.parse(await readFile(result.cassettePath!, "utf8"));
    expect(JSON.stringify(stored)).not.toContain("secret-config");
    expect(JSON.stringify(stored)).not.toContain("vendor-secret");
    expect(JSON.stringify(result.observedEvidence)).not.toContain("secret-config");
    expect(JSON.stringify(result.observedEvidence)).not.toContain("vendor-secret");
    expect(result.observedEvidence).toMatchObject({
      stage: "completed",
      request: { method: "POST", body: { id: "x", api_key: "[REDACTED]" } },
      response: { status: 200, body: { result: { ok: true, token: "[REDACTED]" } } },
    });
    expect(lookupCanonicalToolCassette(stored, tool.name, { id: "x" }, result.definitionHash)).toEqual({ result: { ok: true, token: "[REDACTED]" } });
    expect(lookupCanonicalToolCassette(stored, tool.name, { id: "x" }, "drifted-hash")).toBeUndefined();
  });

  it("keeps prior probe evidence immutable when the same tool records a new cassette", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentic-probe-addressed-"));
    roots.push(root);
    const first = await probeDeclarativeIntegration({
      tool,
      args: { id: "first" },
      tenantSlug: probeScope,
      dataRoot: root,
      persistCassette: true,
      fetchFn: (async () => new Response(JSON.stringify({ result: { version: 1 } }), { status: 200 })) as typeof fetch,
    });
    const firstBytes = await readFile(first.cassettePath!, "utf8");
    const second = await probeDeclarativeIntegration({
      tool,
      args: { id: "second" },
      tenantSlug: probeScope,
      dataRoot: root,
      persistCassette: true,
      fetchFn: (async () => new Response(JSON.stringify({ result: { version: 2 } }), { status: 200 })) as typeof fetch,
    });
    expect(second.cassettePath).not.toBe(first.cassettePath);
    expect(await readFile(first.cassettePath!, "utf8")).toBe(firstBytes);
    expect(path.basename(first.cassettePath!)).toMatch(/^acme\.lookup-[a-f0-9]{64}\.json$/);
  });

  it("records a redacted failed-stage observation for a response assertion", async () => {
    const result = await probeDeclarativeIntegration({
      tool: {
        ...tool,
        name: "acme.awaitResult",
        method: "GET",
        bodyTemplate: undefined,
        responseSpec: {
          assertions: [{ path: "state", op: "eq", value: "ready", failure: "retryable", code: "RESULT_PENDING" }],
          unwrapPath: "data",
        },
      },
      args: { id: "x" },
      config: { api_key: "secret-config" },
      tenantSlug: probeScope,
      fetchFn: (async () => new Response(JSON.stringify({ state: "pending", data: { token: "vendor-secret" } }), { status: 200 })) as typeof fetch,
    });
    expect(result).toMatchObject({
      verified: false,
      classification: "response_assertion",
      status: 502,
      observedEvidence: {
        stage: "response_assertion",
        response: { status: 200, body: { state: "pending", data: { token: "[REDACTED]" } } },
        failure: { kind: "response_assertion", code: "RESULT_PENDING", retryable: true },
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret-config");
    expect(JSON.stringify(result)).not.toContain("vendor-secret");
  });

  it("recursively resolves nested env references and sanitizes args before cassette hashing", async () => {
    process.env.NESTED_PROBE_SECRET = "nested-upstream-secret";
    const result = await probeDeclarativeIntegration({
      tool,
      args: { id: "x", metadata: { token: "argument-secret" } },
      config: { nested: { auth: [{ api_key_env: "NESTED_PROBE_SECRET" }] } },
      tenantSlug: probeScope,
      persistCassette: false,
      fetchFn: (async () => new Response(JSON.stringify({ result: { note: "echo nested-upstream-secret" } }), { status: 200 })) as typeof fetch,
    });
    expect(result.verified).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("nested-upstream-secret");
    expect(serialized).not.toContain("argument-secret");
    expect(result.cassette?.entries[0]?.key).toBe(canonicalToolCassetteKey(tool.name, {
      id: "x",
      metadata: { token: "[REDACTED]" },
    }));
  });

  it("returns needs_config before probing a declarative write without a full cleanup contract", async () => {
    let called = false;
    const result = await probeDeclarativeIntegration({
      tool: {
        ...tool,
        name: "acme.write",
        sideEffect: "write",
        operation: "write",
        sandboxPolicy: "requires_attempt_grant",
      },
      args: { id: "x" },
      tenantSlug: probeScope,
      fetchFn: (async () => { called = true; return new Response("{}"); }) as typeof fetch,
    });
    expect(result).toMatchObject({
      classification: "needs_config",
      next: "ask_user",
      missing: expect.arrayContaining(["test_data_contract", "cleanup", "absence_readback"]),
    });
    expect(called).toBe(false);
  });

  it("fails closed when explicit execution-policy metadata is missing", async () => {
    let called = false;
    const result = await probeDeclarativeIntegration({
      tool: { ...tool, name: "acme.legacy", sideEffect: "unknown", operation: undefined as never },
      args: { id: "x" },
      tenantSlug: probeScope,
      fetchFn: (async () => { called = true; return new Response("{}"); }) as typeof fetch,
    });
    expect(result).toMatchObject({
      classification: "needs_config",
      next: "ask_user",
      missing: ["tool_execution_policy"],
    });
    expect(called).toBe(false);
  });

  it("changes definition hash when config or schema changes", () => {
    expect(declarativeToolDefinitionHash(tool, { token: "a" })).not.toBe(declarativeToolDefinitionHash(tool, { token: "b" }));
    expect(declarativeToolDefinitionHash(tool)).not.toBe(declarativeToolDefinitionHash({ ...tool, returnsSchema: { other: { type: "string" } } }));
    expect(declarativeToolDefinitionHash(tool)).not.toBe(declarativeToolDefinitionHash({ ...tool, responseSpec: { mappings: { id: "data.id" } } }));
    expect(declarativeToolDefinitionHash(tool)).not.toBe(declarativeToolDefinitionHash({ ...tool, examples: [{ request: { id: "x" }, response: { result: { ok: true } }, source: "documentation" }] }));
  });

  it("uses a tenant/domain probe namespace that cannot impersonate a runtime sandbox", () => {
    expect(probeScope).toMatch(/^af-probe-[a-f0-9]{24}$/);
    expect(probeScope).not.toMatch(/-sb$/);
    expect(integrationProbeScope({ tenantId: "ten-probe", domainId: "other" }))
      .not.toBe(probeScope);
    expect(() => integrationProbeScope({ tenantId: "", domainId: "test" }))
      .toThrow(/explicit tenant scope/);
  });
});
