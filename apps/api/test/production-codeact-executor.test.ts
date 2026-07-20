import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activeProductionCodeActRpcContexts,
  authorizeProductionCodeAct,
  PRODUCTION_CODEACT_PROTOCOL,
  productionCodeActIdentityHash,
  productionCodeActMessageSignature,
  runAction,
  setProductionCodeActAuthorizationVerifier,
  type CodeActDockerAdmin,
  type CodeActOrphanCandidate,
  type ProductionCodeActExecuteCommand,
  type ProductionCodeActExecutionIdentity,
} from "@agentic/runtime";
import type { MemoryHandle } from "@agentic/agent-sdk";

import {
  buildProductionCodeActExecutor,
  installProductionCodeActShutdownHandlers,
  type ProductionCodeActExecutorConfig,
} from "../src/codeact-executor";
import { productionCodeActRpcRoutes } from "../src/services/production-codeact-rpc-route";
import {
  InProcessCodeActContainerTestTransport,
  TEST_CODEACT_CANDIDATE_IMAGE,
} from "./codeact-container-test-transport";

const TOKEN = "test-production-codeact-token-that-is-longer-than-thirty-two-bytes";
const AUTHORIZATION = `Bearer ${TOKEN}`;
const SUITE = `regression-suite:v1:${"c".repeat(64)}`;
const ENV_KEYS = [
  "AGENTIC_PROCESS_ROLE",
  "FACTORY_EXEC_GENERATED",
  "FACTORY_CODEACT_CANDIDATE_IMAGE",
  "FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS",
  "PRODUCTION_CODEACT_EXECUTOR_ENABLED",
  "PRODUCTION_CODEACT_EXECUTOR_URL",
  "PRODUCTION_CODEACT_EXECUTOR_TOKEN",
  "PRODUCTION_CODEACT_EXECUTOR_TOKEN_FILE",
  "PRODUCTION_CODEACT_EXECUTOR_HTTP_ALLOWED_HOSTS",
  "PRODUCTION_CODEACT_EXPECTED_EXECUTOR_ID",
  "PRODUCTION_CODEACT_EXPECTED_BUILD_ID",
  "PRODUCTION_CODEACT_ALLOWED_CANDIDATE_REFS",
  "PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS",
  "PRODUCTION_CODEACT_DRAIN_TIMEOUT_MS",
] as const;

const CODE = `
export const promoted = defineAgent({
  name: "promoted-remote",
  async handler(input, ctx) {
    ctx.emit("PROMOTED_DONE", { id: input.id });
    return { ok: true, normalizedId: String(input.id).toUpperCase() };
  },
});
`;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function memoryHandle(): MemoryHandle {
  const values = new Map<string, unknown>();
  return {
    async get<T = unknown>(key: string, scope = "run"): Promise<T | null> {
      const composite = `${scope}:${key}`;
      return values.has(composite) ? values.get(composite) as T : null;
    },
    async put<T = unknown>(key: string, value: T, scope = "run"): Promise<void> {
      values.set(`${scope}:${key}`, value);
    },
    async delete(key: string, scope = "run"): Promise<void> {
      values.delete(`${scope}:${key}`);
    },
    async search(): Promise<never[]> { return []; },
  };
}

function executorConfig(callbackOrigin: string): ProductionCodeActExecutorConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    executorId: "test-production-codeact-executor",
    buildId: "test-build-1",
    callbackOrigin,
    token: TOKEN,
    maxActive: 2,
    candidateImage: TEST_CODEACT_CANDIDATE_IMAGE,
    candidateImageIds: new Set([`sha256:${"b".repeat(64)}`]),
    reaperIntervalMs: 5_000,
    orphanGraceMs: 30_000,
    drainTimeoutMs: 2_000,
  };
}

async function listen(app: FastifyInstance): Promise<string> {
  return app.listen({ host: "127.0.0.1", port: 0 });
}

describe.sequential("production CodeAct remote executor", () => {
  const previous = new Map<string, string | undefined>();
  const apps: FastifyInstance[] = [];

  beforeEach(() => {
    for (const key of ENV_KEYS) previous.set(key, process.env[key]);
    process.env.AGENTIC_PROCESS_ROLE = "api";
    process.env.FACTORY_EXEC_GENERATED = "1";
    process.env.FACTORY_CODEACT_CANDIDATE_IMAGE = TEST_CODEACT_CANDIDATE_IMAGE;
    process.env.FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS = JSON.stringify([
      TEST_CODEACT_CANDIDATE_IMAGE,
    ]);
    process.env.PRODUCTION_CODEACT_EXECUTOR_ENABLED = "1";
    process.env.PRODUCTION_CODEACT_EXECUTOR_TOKEN = TOKEN;
    delete process.env.PRODUCTION_CODEACT_EXECUTOR_TOKEN_FILE;
    process.env.PRODUCTION_CODEACT_EXECUTOR_HTTP_ALLOWED_HOSTS = "127.0.0.1";
    process.env.PRODUCTION_CODEACT_EXPECTED_EXECUTOR_ID = "test-production-codeact-executor";
    process.env.PRODUCTION_CODEACT_EXPECTED_BUILD_ID = "test-build-1";
    process.env.PRODUCTION_CODEACT_ALLOWED_CANDIDATE_REFS = JSON.stringify([
      TEST_CODEACT_CANDIDATE_IMAGE,
    ]);
    process.env.PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS = JSON.stringify([
      `sha256:${"b".repeat(64)}`,
    ]);
  });

  afterEach(async () => {
    setProductionCodeActAuthorizationVerifier(null);
    await Promise.all(apps.splice(0).map((app) => app.close()));
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    previous.clear();
    expect(activeProductionCodeActRpcContexts()).toBe(0);
  });

  async function startExecutor(): Promise<string> {
    const callback = Fastify({ logger: false });
    await callback.register(productionCodeActRpcRoutes);
    apps.push(callback);
    const callbackOrigin = await listen(callback);

    const config = executorConfig(callbackOrigin);
    const executor = await buildProductionCodeActExecutor({
      config,
      transport: new InProcessCodeActContainerTestTransport(),
    });
    apps.push(executor);
    const executorOrigin = await listen(executor);
    process.env.PRODUCTION_CODEACT_EXECUTOR_URL = executorOrigin;
    return executorOrigin;
  }

  it("runs a promoted step remotely and removes the one-shot candidate", async () => {
    await startExecutor();
    const digest = sha256(CODE);
    const authorizationRequest = {
      executionKind: "codeact" as const,
      tenantId: "tenant-agents-generation",
      tenantSlug: "agents-generation",
      domainId: "Agents-generation",
      agentSlug: "promoted-remote",
      promotionVersionId: "promotion-version-7",
      regressionSuiteFingerprint: SUITE,
      codeSha256: digest,
      agentManifestSha256: "f".repeat(64),
      workflowManifestSha256: "e".repeat(64),
    };
    setProductionCodeActAuthorizationVerifier(async (request) => ({
      ...request,
      authorizationId: "factory-code-authorization-test",
      promotionId: "factory-promotion-test",
      activationPromotionId: "factory-activation-test",
      deploymentId: "deployment-test",
      workflowVersionId: "workflow-version-test",
      reviewReceiptId: "review-receipt-test",
      activationReviewReceiptId: "review-activation-test",
    }));
    const productionCodeActCapability = await authorizeProductionCodeAct(authorizationRequest);

    const result = await runAction({
      action: {
        name: "execute-promoted-code",
        type: "logic",
        description: "execute the exact reviewed CodeAct handler",
      },
      ctx: {
        tenantId: "tenant-agents-generation",
        tenantSlug: "agents-generation",
        agentName: "promoted-remote",
        actionName: "execute-promoted-code",
        correlationId: "cor-production-remote-1",
        event: { name: "RUN_PROMOTED", data: { id: "candidate-7" } },
      },
      runId: "run-production-remote-1",
      memory: memoryHandle(),
      agent: {
        id: "promoted-remote",
        name: "promoted-remote",
        generated: true,
        codeExecuted: true,
        typescriptCode: CODE,
        codeAttestation: {
          allow_production: true,
          expected_sha256: digest,
        },
        factoryDomainId: "Agents-generation",
        factoryPromotionVersionId: "promotion-version-7",
        factoryRegressionSuiteFingerprint: SUITE,
        productionCodeActManifestSha256: "f".repeat(64),
        productionCodeActWorkflowManifestSha256: "e".repeat(64),
        productionCodeActCapability,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        ok: true,
        normalizedId: "CANDIDATE-7",
        _emit: "PROMOTED_DONE",
      },
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
          attestation: "production_verified",
          failure: null,
        },
      },
    });
    expect(result.meta?.containerEvidence).toMatchObject({
      codeSha256: digest,
      removed: true,
      absenceVerified: true,
      isolation: "isolated_container",
    });
  });

  it("rejects unsigned commands without starting a candidate", async () => {
    const origin = await startExecutor();
    const response = await fetch(`${origin}/internal/v1/production-codeact/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema: "agentic-production-codeact-execute/v1" }),
    });
    expect(response.status).toBe(401);
  });

  it("rejects a signed callback that is not bound to an active execution", async () => {
    const callback = Fastify({ logger: false });
    await callback.register(productionCodeActRpcRoutes);
    const body = {
      schema: "agentic-production-codeact-rpc/v1" as const,
      executionId: "00000000-0000-4000-8000-000000000000",
      identityHash: `sha256:${"d".repeat(64)}`,
      codeSha256: "e".repeat(64),
      rpcId: "stale:1",
      method: "tool" as const,
      args: ["meta.ping", {}],
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const response = await callback.inject({
      method: "POST",
      url: "/internal/production-codeact/rpc",
      headers: {
        authorization: AUTHORIZATION,
        "x-agentic-codeact-signature": productionCodeActMessageSignature(body, TOKEN),
      },
      payload: body,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ ok: false, error: expect.stringContaining("mismatched") });
    await callback.close();
  });

  it("uses the exact RPC route body boundary instead of the API-wide 1 MiB limit", async () => {
    const callback = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
    await callback.register(productionCodeActRpcRoutes);
    const base = {
      schema: "agentic-production-codeact-rpc/v1",
      executionId: "00000000-0000-4000-8000-000000000000",
      identityHash: `sha256:${"d".repeat(64)}`,
      codeSha256: "e".repeat(64),
      rpcId: "boundary:1",
      method: "tool",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    };
    const aboveGlobal = await callback.inject({
      method: "POST",
      url: "/internal/production-codeact/rpc",
      payload: { ...base, args: ["meta.ping", { blob: "x".repeat(1_100_000) }] },
    });
    expect(aboveGlobal.statusCode).toBe(401);

    const aboveProtocolEnvelope = await callback.inject({
      method: "POST",
      url: "/internal/production-codeact/rpc",
      headers: { authorization: AUTHORIZATION },
      payload: { ...base, rpcId: "boundary:2", args: ["meta.ping", { blob: "x".repeat(9 * 1024 * 1024) }] },
    });
    expect(aboveProtocolEnvelope.statusCode).toBe(413);
    await callback.close();
  });

  it("deep health verifies Docker/image and removes only old production orphans", async () => {
    const orphan: CodeActOrphanCandidate = {
      id: "a".repeat(64),
      createdAtMs: Date.now() - 60_000,
      state: "exited",
      labels: {
        "io.agentic.role": "codeact-candidate",
        "io.agentic.execution-plane": "production-codeact",
      },
    };
    let candidates = [orphan];
    const removed: string[] = [];
    const admin: CodeActDockerAdmin = {
      async ping() {},
      async inspectImage() {
        return { Id: `sha256:${"b".repeat(64)}`, RepoDigests: [TEST_CODEACT_CANDIDATE_IMAGE] };
      },
      async listCandidates() { return [...candidates]; },
      async inspectContainer(id) { return candidates.some((entry) => entry.id === id) ? {} as never : null; },
      async removeContainer(id) {
        removed.push(id);
        candidates = candidates.filter((entry) => entry.id !== id);
      },
    };
    const app = await buildProductionCodeActExecutor({
      config: executorConfig("http://127.0.0.1:1"),
      transport: new InProcessCodeActContainerTestTransport(),
      admin,
    });
    const health = await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: AUTHORIZATION },
    });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({
      ok: true,
      executorId: "test-production-codeact-executor",
      buildId: "test-build-1",
      candidateImageId: `sha256:${"b".repeat(64)}`,
      removedOrphans: 1,
    });
    expect(removed).toEqual([orphan.id]);
    await app.close();
  });

  it("reports unhealthy when Docker or the reviewed candidate identity is unavailable", async () => {
    const admin: CodeActDockerAdmin = {
      async ping() { throw new Error("docker socket unavailable"); },
      async inspectImage() { return null; },
      async listCandidates() { return []; },
      async inspectContainer() { return null; },
      async removeContainer() {},
    };
    const app = await buildProductionCodeActExecutor({
      config: executorConfig("http://127.0.0.1:1"),
      transport: new InProcessCodeActContainerTestTransport(),
      admin,
    });
    const health = await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: AUTHORIZATION },
    });
    expect(health.statusCode).toBe(503);
    expect(health.json()).toMatchObject({
      ok: false,
      error: expect.stringContaining("docker socket unavailable"),
    });
    await app.close();
  });

  it("drains by aborting active candidates and proving their removal", async () => {
    const transport = new InProcessCodeActContainerTestTransport();
    const app = await buildProductionCodeActExecutor({
      config: executorConfig("http://127.0.0.1:1"),
      transport,
      admin: transport,
    });
    const code = "export const hung=defineAgent({async handler(){while(true){} }});";
    const identity: ProductionCodeActExecutionIdentity = {
      tenantId: "tenant-1",
      tenantSlug: "agents-generation",
      runId: "run-drain-1",
      agentName: "hung",
      correlationId: "cor-drain-1",
      promotionVersionId: "promotion-drain-1",
      regressionSuiteFingerprint: SUITE,
      codeSha256: sha256(code),
    };
    const now = Date.now();
    const command: ProductionCodeActExecuteCommand = {
      schema: PRODUCTION_CODEACT_PROTOCOL.execute,
      executionId: randomUUID(),
      nonce: randomUUID(),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 90_000).toISOString(),
      identity,
      identityHash: productionCodeActIdentityHash(identity),
      code,
      input: {},
      policy: { timeoutMs: 60_000, memoryMb: 128, cpus: 1, pidsLimit: 64 },
    };
    const running = app.inject({
      method: "POST",
      url: "/internal/v1/production-codeact/execute",
      headers: {
        authorization: AUTHORIZATION,
        "x-agentic-codeact-signature": productionCodeActMessageSignature(command, TOKEN),
      },
      payload: command,
    });
    await vi.waitFor(async () => {
      const health = await app.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: AUTHORIZATION },
      });
      expect(health.json()).toMatchObject({ active: 1, draining: false });
    });
    const stderr = { write: vi.fn() };
    const signals = Object.assign(new EventEmitter(), {
      exitCode: undefined as number | undefined,
      stderr,
    });
    const closeSpy = vi.spyOn(app, "close");
    const shutdown = installProductionCodeActShutdownHandlers(app, signals);
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    expect(shutdown.closing).toBe(true);
    const terminal = await running;
    await shutdown.closed;
    expect(terminal.statusCode).toBe(200);
    expect(terminal.json()).toMatchObject({
      schema: PRODUCTION_CODEACT_PROTOCOL.terminal,
      result: {
        ok: false,
        failure: "kill_switch",
        executorStarted: true,
        evidence: {
          removed: true,
          absenceVerified: true,
        },
      },
    });
    await expect(transport.listCandidates("production-codeact")).resolves.toEqual([]);
    expect(stderr.write).not.toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });
});
