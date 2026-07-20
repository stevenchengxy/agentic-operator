import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authorizeProductionCodeAct,
  codeActExecutionReceiptFromMeta,
  runGeneratedCodeIsolated as executeGeneratedCode,
  runAction,
  setProductionCodeActAuthorizationVerifier,
} from "@agentic/runtime";
import type { MemoryHandle } from "@agentic/agent-sdk";
import { codeActContainerTestOptions } from "./codeact-container-test-transport";

function runGeneratedCodeIsolated(
  code: string,
  input: Record<string, unknown>,
  options: Parameters<typeof executeGeneratedCode>[2] = {},
) {
  return executeGeneratedCode(code, input, {
    ...options,
    ...codeActContainerTestOptions(),
  });
}

function codeActStepExecutor() {
  const options = codeActContainerTestOptions();
  return {
    generatedCodeContainerTransport: options.containerTransport,
    generatedCodeCandidateImage: options.candidateImage,
  };
}

const CAPABILITY_CODE = `
import { defineAgent } from "@agentic/runtime";
export const capabilityAgent = defineAgent({
  name: "capability",
  async handler(input, ctx) {
    await ctx.memory.put("seen", input.value);
    const remembered = await ctx.memory.get("seen");
    const decision = await ctx.reason("decide", input);
    const toolResult = await ctx.tool("echo", { value: input.value });
    const invoked = await ctx.invoke("child", { value: input.value });
    ctx.emit("DONE", { remembered });
    return { remembered, decision, toolResult, invoked };
  },
});
`;

const SIMPLE_CODE = `
export const productionAgent = defineAgent({
  name: "production",
  async handler(input, ctx) {
    ctx.emit("PRODUCTION_DONE", { id: input.id });
    return { ok: true, id: input.id };
  },
});
`;

const FIXTURE_POLICY = {
  operation: "compute",
  effectScope: "none",
  sandboxPolicy: "pure",
} as const;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function memoryHandle(): MemoryHandle {
  const values = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string): Promise<T | null> {
      return values.has(key) ? (values.get(key) as T) : null;
    },
    async put<T = unknown>(key: string, value: T): Promise<void> {
      values.set(key, value);
    },
    async delete(key: string): Promise<void> {
      values.delete(key);
    },
    async search(): Promise<never[]> {
      return [];
    },
  };
}

describe.sequential("isolated CodeAct production kernel", () => {
  const previousGenerated = process.env.FACTORY_EXEC_GENERATED;

  beforeAll(() => {
    process.env.FACTORY_EXEC_GENERATED = "1";
  });

  afterAll(() => {
    setProductionCodeActAuthorizationVerifier(null);
    if (previousGenerated === undefined) delete process.env.FACTORY_EXEC_GENERATED;
    else process.env.FACTORY_EXEC_GENERATED = previousGenerated;
  });

  it("runs AgentRuntime capabilities over host↔worker RPC", async () => {
    const result = await runGeneratedCodeIsolated(
      CAPABILITY_CODE,
      { value: 7 },
      {
        tenantSlug: "kernel-sb",
        memory: memoryHandle(),
        allowedTools: ["echo"],
        toolPolicies: { echo: FIXTURE_POLICY },
        hostRuntimeKind: "fixture",
        hostRuntime: {
          async reason(_prompt, input) {
            return { accepted: (input as { value: number }).value === 7 };
          },
          async tool(name, args) {
            return { name, args };
          },
          async invoke(agentRef, input) {
            return { agentRef, input };
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isolation).toBe("isolated_container");
    expect(result.codeSha256).toBe(sha256(CAPABILITY_CODE));
    expect(result).toMatchObject({
      executorStarted: true,
      attestation: "sandbox_not_required",
    });
    expect(result.data).toMatchObject({
      remembered: 7,
      decision: { accepted: true },
      toolResult: { name: "echo", args: { value: 7 } },
      invoked: { agentRef: "child", input: { value: 7 } },
      _emit: "DONE",
    });
    expect(result.emitted).toEqual([{ event: "DONE", payload: { remembered: 7 } }]);
  });

  it("terminates a synchronous infinite loop at the hard worker timeout", async () => {
    const result = await runGeneratedCodeIsolated(
      `export const hung = defineAgent({ async handler() { while (true) {} } });`,
      {},
      { tenantSlug: "kernel-sb", timeoutMs: 500, memory: memoryHandle() },
    );

    expect(result).toMatchObject({
      ok: false,
      failure: "container_timeout",
      timedOut: true,
      isolation: "isolated_container",
      executorStarted: true,
      attestation: "sandbox_not_required",
    });
    expect(result.durationMs).toBeLessThan(2_500);
  });

  it("terminates an in-flight worker when the operator kill switch flips", async () => {
    const previous = process.env.FACTORY_EXEC_GENERATED;
    process.env.FACTORY_EXEC_GENERATED = "1";
    try {
      const running = runGeneratedCodeIsolated(
        `export const waiting = defineAgent({ async handler() {
          await new Promise((resolve) => setTimeout(resolve, 30_000));
          return { tooLate: true };
        } });`,
        {},
        { tenantSlug: "kernel-sb", timeoutMs: 5_000, memory: memoryHandle() },
      );
      await new Promise((resolve) => setTimeout(resolve, 200));
      process.env.FACTORY_EXEC_GENERATED = "0";
      const result = await running;
      expect(result).toMatchObject({ ok: false, failure: "kill_switch" });
      expect(result.durationMs).toBeLessThan(2_500);
    } finally {
      if (previous === undefined) delete process.env.FACTORY_EXEC_GENERATED;
      else process.env.FACTORY_EXEC_GENERATED = previous;
    }
  });

  it("treats a failed host RPC as fatal even when generated code tries to catch it", async () => {
    const result = await runGeneratedCodeIsolated(
      `export const catches = defineAgent({ async handler(_input, ctx) {
        try { await ctx.tool("broken", {}); } catch (_) { return { hidden: true }; }
        return { hidden: false };
      } });`,
      {},
      {
        tenantSlug: "kernel-sb",
        memory: memoryHandle(),
        allowedTools: ["broken"],
        toolPolicies: { broken: FIXTURE_POLICY },
        hostRuntimeKind: "fixture",
        hostRuntime: { async tool() { throw new Error("upstream unavailable"); } },
      },
    );

    expect(result).toMatchObject({ ok: false, failure: "rpc_failed" });
    if (!result.ok) expect(result.error).toContain("upstream unavailable");
  });

  it("denies ctx.tool outside the immutable allowlist before invoking the host", async () => {
    let hostCalls = 0;
    const result = await runGeneratedCodeIsolated(
      `export const denied = defineAgent({ async handler(input, ctx) {
        return { value: await ctx.tool("meta.ping", input) };
      } });`,
      { value: 1 },
      {
        tenantSlug: "kernel-sb",
        memory: memoryHandle(),
        allowedTools: [],
        hostRuntimeKind: "fixture",
        hostRuntime: {
          async tool() {
            hostCalls += 1;
            return { ok: true };
          },
        },
      },
    );

    expect(result).toMatchObject({ ok: false, failure: "rpc_failed" });
    if (!result.ok) {
      expect(result.error).toContain("generated_tool_not_declared");
      expect(result.error).toContain("meta.ping");
    }
    expect(hostCalls).toBe(0);
  });

  it("allows a configured host tool only when the immutable allowlist declares it", async () => {
    const result = await runGeneratedCodeIsolated(
      `export const allowed = defineAgent({ async handler(input, ctx) {
        return { value: await ctx.tool("meta.ping", input) };
      } });`,
      { value: 2 },
      {
        tenantSlug: "kernel-sb",
        memory: memoryHandle(),
        allowedTools: ["meta.ping"],
        hostRuntimeKind: "fixture",
        hostRuntime: {
          async tool(name, args) {
            return { name, args };
          },
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      data: { value: { name: "meta.ping", args: { value: 2 } } },
      toolDispatches: [{ tool: "meta.ping", kind: "fixture" }],
    });
  });

  it("rejects a fixture policy that drifted from the current global registry", async () => {
    let hostCalls = 0;
    const result = await runGeneratedCodeIsolated(
      `export const drifted = defineAgent({ async handler(input, ctx) {
        return { value: await ctx.tool("meta.ping", input) };
      } });`,
      { value: 2 },
      {
        tenantSlug: "kernel-sb",
        memory: memoryHandle(),
        allowedTools: ["meta.ping"],
        toolPolicies: {
          "meta.ping": {
            operation: "write",
            effectScope: "external",
            sandboxPolicy: "requires_attempt_grant",
          },
        },
        hostRuntimeKind: "fixture",
        hostRuntime: {
          async tool() {
            hostCalls += 1;
            return { ok: true };
          },
        },
      },
    );

    expect(result).toMatchObject({ ok: false, failure: "rpc_failed" });
    if (!result.ok) expect(result.error).toContain("conflicts with current reviewed registry");
    expect(hostCalls).toBe(0);
  });

  it("rejects every import outside @agentic/runtime and the curated allowlist", async () => {
    const result = await runGeneratedCodeIsolated(
      `import fs from "node:fs";
       export const bad = defineAgent({ async handler() { return { read: typeof fs.readFileSync }; } });`,
      {},
      { tenantSlug: "kernel-sb", memory: memoryHandle() },
    );

    expect(result).toMatchObject({ ok: false, failure: "candidate_failed" });
    if (!result.ok) expect(result.error).toMatch(/node:fs.*not allowed/i);
  });

  it("allows a curated pure dependency inside the worker", async () => {
    const result = await runGeneratedCodeIsolated(
      `import { createHash } from "node:crypto";
       export const digest = defineAgent({ async handler(input) {
         return { sha: createHash("sha256").update(input.value).digest("hex") };
       } });`,
      { value: "abc" },
      { tenantSlug: "kernel-sb", memory: memoryHandle() },
    );

    expect(result).toMatchObject({
      ok: true,
      data: { sha: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" },
    });
  });

  it("denies production by default and rejects a mismatched code attestation", async () => {
    const denied = await runGeneratedCodeIsolated(
      SIMPLE_CODE,
      { id: "1" },
      { tenantSlug: "production", memory: memoryHandle() },
    );
    expect(denied).toMatchObject({
      ok: false,
      failure: "production_not_authorized",
      executorStarted: false,
      attestation: "not_authorized",
    });

    const mismatch = await runGeneratedCodeIsolated(
      SIMPLE_CODE,
      { id: "1" },
      {
        tenantSlug: "production",
        memory: memoryHandle(),
        production: { allowProduction: true, expectedCodeSha256: "0".repeat(64) },
      },
    );
    expect(mismatch).toMatchObject({
      ok: false,
      failure: "attestation_mismatch",
      executorStarted: false,
      attestation: "mismatch",
    });

    const mismatchStep = await runAction({
      ...codeActStepExecutor(),
      action: { name: "blocked-code", type: "logic", description: "must not start" },
      ctx: {
        agentName: "blocked-agent",
        actionName: "blocked-code",
        correlationId: "cor-blocked",
        tenantSlug: "production",
        event: { name: "START", data: { id: "blocked" } },
      },
      agent: {
        name: "blocked-agent",
        generated: true,
        codeExecuted: true,
        typescriptCode: SIMPLE_CODE,
        codeAttestation: {
          allow_production: true,
          expected_sha256: "0".repeat(64),
        },
      },
      memory: memoryHandle(),
    });
    expect(mismatchStep.meta?.codeExecutionReceipt).toMatchObject({
      source: "runtime_codeact",
      codeExecuted: false,
      codeRan: false,
      isolation: null,
      codeSha256: sha256(SIMPLE_CODE),
      attestation: "not_authorized",
      failure: "production_not_authorized",
    });
  });

  it("executes attested production code and returns hash/isolation telemetry", async () => {
    const digest = sha256(SIMPLE_CODE);
    const result = await runGeneratedCodeIsolated(
      SIMPLE_CODE,
      { id: "prod-1" },
      {
        tenantSlug: "production",
        memory: memoryHandle(),
        production: { allowProduction: true, expectedCodeSha256: digest },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      isolation: "isolated_container",
      codeSha256: digest,
      productionAttested: true,
      executorStarted: true,
      attestation: "production_verified",
    });
  });

  it("step-engine executes only an exactly attested production handler and exposes telemetry", async () => {
    const digest = sha256(SIMPLE_CODE);
    const agentManifestSha256 = "d".repeat(64);
    const authorizationRequest = {
      executionKind: "codeact" as const,
      tenantId: "tenant-production-test",
      tenantSlug: "production",
      domainId: "domain-production-test",
      agentSlug: "production-agent",
      promotionVersionId: "version-production-test",
      regressionSuiteFingerprint: `regression-suite:v1:${"e".repeat(64)}`,
      codeSha256: digest,
      agentManifestSha256,
      workflowManifestSha256: "c".repeat(64),
    };
    setProductionCodeActAuthorizationVerifier(async (request) => ({
      ...request,
      authorizationId: "fca-production-test",
      promotionId: "fpr-production-test",
      activationPromotionId: "fpr-activation-production-test",
      deploymentId: "dpl-production-test",
      workflowVersionId: "wfv-production-test",
      reviewReceiptId: "review-production-test",
      activationReviewReceiptId: "review-activation-production-test",
    }));
    const productionCodeActCapability = await authorizeProductionCodeAct(
      authorizationRequest,
    );
    const result = await runAction({
      ...codeActStepExecutor(),
      action: { name: "production-code", type: "logic", description: "run exact code" },
      ctx: {
        tenantId: "tenant-production-test",
        agentName: "production-agent",
        actionName: "production-code",
        correlationId: "cor-prod",
        tenantSlug: "production",
        event: { name: "START", data: { id: "prod-2" } },
      },
      agent: {
        id: "production-agent",
        name: "production-agent",
        generated: true,
        codeExecuted: true,
        typescriptCode: SIMPLE_CODE,
        codeAttestation: {
          allow_production: true,
          expected_sha256: digest,
        },
        factoryDomainId: "domain-production-test",
        factoryPromotionVersionId: "version-production-test",
        factoryRegressionSuiteFingerprint:
          authorizationRequest.regressionSuiteFingerprint,
        productionCodeActManifestSha256: agentManifestSha256,
        productionCodeActWorkflowManifestSha256:
          authorizationRequest.workflowManifestSha256,
        productionCodeActCapability,
      },
      memory: memoryHandle(),
    });

    expect(result).toMatchObject({
      ok: true,
      data: { ok: true, id: "prod-2", _emit: "PRODUCTION_DONE" },
      meta: {
        codeExecuted: true,
        isolation: "isolated_container",
        codeSha256: digest,
        productionAttested: true,
        codeExecutionReceipt: {
          source: "runtime_codeact",
          codeExecuted: true,
          codeRan: true,
          isolation: "isolated_container",
          codeSha256: digest,
          attestation: "production_verified",
          failure: null,
        },
      },
    });
    expect(codeActExecutionReceiptFromMeta(result.meta)).toMatchObject({
      source: "runtime_codeact",
      codeExecuted: true,
      codeRan: true,
    });
  });

  it("records that the worker started even when the generated handler fails", async () => {
    const result = await runAction({
      ...codeActStepExecutor(),
      action: { name: "crashing-code", type: "logic", description: "crash" },
      ctx: {
        agentName: "crashing-agent",
        actionName: "crashing-code",
        correlationId: "cor-crash",
        tenantSlug: "crash-sb",
        event: { name: "START", data: {} },
      },
      agent: {
        name: "crashing-agent",
        generated: true,
        codeExecuted: true,
        typescriptCode: `export const crashing = defineAgent({ async handler() { throw new Error("boom"); } });`,
      },
      memory: memoryHandle(),
    });

    expect(result).toMatchObject({
      ok: false,
      meta: {
        codeExecuted: true,
        isolation: "isolated_container",
        codeAttestation: "sandbox_not_required",
        codeExecutionReceipt: {
          source: "runtime_codeact",
          codeExecuted: true,
          codeRan: false,
          isolation: "isolated_container",
          attestation: "sandbox_not_required",
          failure: "candidate_failed",
        },
      },
    });
  });

  it("does not accept a manifest-shaped execution declaration as a receipt", () => {
    expect(codeActExecutionReceiptFromMeta({ codeExecuted: true })).toBeNull();
    expect(
      codeActExecutionReceiptFromMeta({
        codeExecutionReceipt: {
          codeExecuted: true,
          codeRan: true,
          isolation: "worker_thread",
          codeSha256: sha256(SIMPLE_CODE),
          attestation: "production_verified",
          durationMs: 1,
          failure: null,
        },
      }),
    ).toBeNull();
  });
});
