import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  AgentSchema,
  DockerSocketCodeActTransport,
  appIdForTenant,
  disposeTenantInngestClient,
  registerAgent,
  type RegisterContext,
} from "@agentic/runtime";
import {
  agents,
  factorySandboxAttempts,
  getDb,
  runs,
  steps,
  tenants,
  workflows,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { codeActContainerTestOptions } from "./codeact-container-test-transport";

const nonce = randomUUID().replaceAll("-", "");
const tenantSlug = `af-sbx-${nonce.slice(0, 8)}-${nonce.slice(8, 16)}-${nonce.slice(16, 28)}-sb`;
const attemptId = randomUUID();
const targetDomainId = "receipt-replay-domain";
const candidateFingerprint = `sandbox-evidence:v5:${nonce}`;
const sandboxEnvNames = [
  "INNGEST_SANDBOX_CONFIG_REFS",
  "TC_RECEIPT_SB_EVENT_KEY",
  "TC_RECEIPT_SB_SIGNING_KEY",
  "TC_RECEIPT_SB_SERVE_ORIGIN",
  "TC_RECEIPT_SB_BASE_URL",
  "TC_RECEIPT_SB_APP_PREFIX",
  "TC_RECEIPT_SB_CONTROL_BEARER",
  "TC_RECEIPT_SB_DELETE_URL",
  "TC_RECEIPT_SB_DELETE_TOKEN",
  "FACTORY_EXEC_GENERATED",
  "FACTORY_CODEACT_CANDIDATE_IMAGE",
  "FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS",
] as const;
const previousSandboxEnv = new Map<string, string | undefined>();
const generatedCode = `
import { defineAgent } from "@agentic/runtime";
export const receiptReplayAgent = defineAgent({
  name: "receipt-replay-agent",
  async handler(input) {
    return { handled: true, id: input.id };
  },
});
`;

describe.sequential("registerAgent CodeAct receipt durability", () => {
  let tenantId: string;
  let ownerTenantId: string;
  let dbAgentId: string;
  let registered: { fn: (ctx: Record<string, unknown>) => Promise<unknown> };

  beforeAll(() => {
    for (const name of sandboxEnvNames) {
      previousSandboxEnv.set(name, process.env[name]);
    }
    process.env.INNGEST_SANDBOX_CONFIG_REFS = JSON.stringify({
      eventKeyEnv: "TC_RECEIPT_SB_EVENT_KEY",
      signingKeyEnv: "TC_RECEIPT_SB_SIGNING_KEY",
      serveOriginEnv: "TC_RECEIPT_SB_SERVE_ORIGIN",
      baseUrlEnv: "TC_RECEIPT_SB_BASE_URL",
      appPrefixEnv: "TC_RECEIPT_SB_APP_PREFIX",
      controlBearerEnv: "TC_RECEIPT_SB_CONTROL_BEARER",
      cleanupMode: "custom_delete_control",
      deleteControlUrlEnv: "TC_RECEIPT_SB_DELETE_URL",
      deleteControlTokenEnv: "TC_RECEIPT_SB_DELETE_TOKEN",
    });
    process.env.TC_RECEIPT_SB_EVENT_KEY = `evt_${nonce}`;
    process.env.TC_RECEIPT_SB_SIGNING_KEY = `sign_${nonce}`;
    process.env.TC_RECEIPT_SB_SERVE_ORIGIN = "http://receipt-workload.invalid";
    process.env.TC_RECEIPT_SB_BASE_URL = "http://receipt-broker.invalid";
    process.env.TC_RECEIPT_SB_APP_PREFIX = "agentic-receipt-sandbox";
    process.env.TC_RECEIPT_SB_CONTROL_BEARER = `control_${nonce}`;
    process.env.TC_RECEIPT_SB_DELETE_URL =
      "http://receipt-control.invalid/apps/{appId}";
    process.env.TC_RECEIPT_SB_DELETE_TOKEN = `delete_${nonce}`;

    const codeActExecutor = codeActContainerTestOptions();
    process.env.FACTORY_EXEC_GENERATED = "1";
    process.env.FACTORY_CODEACT_CANDIDATE_IMAGE = codeActExecutor.candidateImage;
    process.env.FACTORY_CODEACT_ALLOWED_IMAGE_DIGESTS = JSON.stringify([
      codeActExecutor.candidateImage,
    ]);
    vi.spyOn(DockerSocketCodeActTransport.prototype, "create")
      .mockImplementation((name, config) =>
        codeActExecutor.containerTransport.create(name, config));
    vi.spyOn(DockerSocketCodeActTransport.prototype, "inspect")
      .mockImplementation((id) => codeActExecutor.containerTransport.inspect(id));
    vi.spyOn(DockerSocketCodeActTransport.prototype, "attach")
      .mockImplementation((id) => codeActExecutor.containerTransport.attach(id));
    vi.spyOn(DockerSocketCodeActTransport.prototype, "start")
      .mockImplementation((id) => codeActExecutor.containerTransport.start(id));
    vi.spyOn(DockerSocketCodeActTransport.prototype, "wait")
      .mockImplementation((id) => codeActExecutor.containerTransport.wait(id));
    vi.spyOn(DockerSocketCodeActTransport.prototype, "kill")
      .mockImplementation((id) => codeActExecutor.containerTransport.kill(id));
    vi.spyOn(DockerSocketCodeActTransport.prototype, "remove")
      .mockImplementation((id) => codeActExecutor.containerTransport.remove(id));

    const db = getDb();
    ownerTenantId = makeId("ten");
    tenantId = makeId("ten");
    const workflowId = makeId("wf");
    dbAgentId = makeId("agt");
    db.insert(tenants)
      .values({
        id: ownerTenantId,
        slug: `receipt-replay-owner-${nonce.slice(0, 12)}`,
        name: "Receipt replay owner",
      })
      .run();
    db.insert(tenants)
      .values({ id: tenantId, slug: tenantSlug, name: "Receipt replay" })
      .run();
    db.insert(factorySandboxAttempts)
      .values({
        id: attemptId,
        ownerTenantId,
        ownerTenantSlug: `receipt-replay-owner-${nonce.slice(0, 12)}`,
        targetDomainId,
        candidateFingerprint,
        sandboxTenantId: tenantId,
        sandboxTenantSlug: tenantSlug,
        appId: appIdForTenant(tenantSlug),
        status: "active",
        remoteMayExist: true,
        leaseOwner: "tc-codeact-receipt-register",
        leaseToken: randomUUID(),
        fenceGeneration: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      .run();
    db.insert(workflows)
      .values({
        id: workflowId,
        tenantId,
        slug: "receipt-replay",
        name: "Receipt replay",
      })
      .run();
    db.insert(agents)
      .values({
        id: dbAgentId,
        workflowId,
        kebabId: "receipt-replay-agent",
        name: "receiptReplayAgent",
        actor: "Agent",
        kind: "manifest",
        enabled: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const agent = AgentSchema.parse({
      id: "receipt-replay-agent",
      name: "receiptReplayAgent",
      actor: ["Agent"],
      trigger: ["START"],
      triggered_event: ["DONE"],
      generated: true,
      codeExecuted: true,
      typescript_code: generatedCode,
      factory_domain_id: targetDomainId,
      factory_target_domain_id: targetDomainId,
      factory_action_name: "ReceiptReplay",
      factory_execution_scope: {
        kind: "sandbox",
        target_domain_id: targetDomainId,
        candidate_fingerprint: candidateFingerprint,
        attempt_id: attemptId,
      },
      actions: [
        {
          order: "1",
          name: "executeGeneratedHandler",
          description: "execute the exact generated handler",
          type: "logic",
        },
      ],
    });
    const context: RegisterContext = {
      tenantId,
      tenantSlug,
      workflowVersionId: makeId("wfv"),
    };
    registered = registerAgent(agent, context) as unknown as typeof registered;
  });

  afterAll(() => {
    const db = getDb();
    db.delete(factorySandboxAttempts)
      .where(eq(factorySandboxAttempts.id, attemptId))
      .run();
    db.delete(tenants).where(eq(tenants.id, tenantId)).run();
    db.delete(tenants).where(eq(tenants.id, ownerTenantId)).run();
    disposeTenantInngestClient(tenantSlug);
    vi.restoreAllMocks();
    for (const name of sandboxEnvNames) {
      const previous = previousSandboxEnv.get(name);
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  });

  it("persists before finalization and survives a replay with a fresh handler closure", async () => {
    const cache = new Map<string, unknown>();
    let interruptBeforeFinalize = true;
    const step = {
      run: async (
        idOrOptions: string | { id: string },
        fn: (...args: unknown[]) => unknown,
        ...args: unknown[]
      ) => {
        const id =
          typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id;
        if (cache.has(id)) return cache.get(id);
        if (id === "finalize" && interruptBeforeFinalize) {
          interruptBeforeFinalize = false;
          throw new Error("simulated replay boundary before finalize");
        }
        const value = await fn(...args);
        cache.set(id, value);
        return value;
      },
      sendEvent: async () => undefined,
    };
    const invocation = {
      event: {
        name: `${tenantSlug}/START`,
        data: { id: "receipt-1", subject: "receipt-subject" },
      },
      step,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    };

    await expect(registered.fn(invocation)).rejects.toThrow(
      "simulated replay boundary before finalize",
    );

    const db = getDb();
    const runAfterWorker = db
      .select()
      .from(runs)
      .where(eq(runs.agentId, dbAgentId))
      .orderBy(desc(runs.startedAt))
      .all()[0];
    expect(runAfterWorker).toMatchObject({
      status: "running",
      codeRan: true,
      codeExecuted: true,
      codeIsolation: "isolated_container",
      codeAttestation: "sandbox_not_required",
      codeExecutionFailure: null,
    });
    expect(runAfterWorker?.codeSha256).toMatch(/^[a-f0-9]{64}$/);
    const stepAfterWorker = db
      .select()
      .from(steps)
      .where(eq(steps.runId, runAfterWorker!.id))
      .all()[0];
    expect(stepAfterWorker).toMatchObject({
      codeRan: true,
      codeExecuted: true,
      codeIsolation: "isolated_container",
      codeSha256: runAfterWorker?.codeSha256,
      codeAttestation: "sandbox_not_required",
      codeExecutionFailure: null,
    });

    // Re-enter the handler as Inngest would: init/action results are memoized,
    // while finalization executes for the first time in a fresh closure.
    await expect(registered.fn(invocation)).resolves.toMatchObject({
      ok: true,
      runId: runAfterWorker?.id,
    });
    const finalized = db
      .select()
      .from(runs)
      .where(eq(runs.id, runAfterWorker!.id))
      .all()[0];
    expect(finalized).toMatchObject({
      status: "ok",
      codeRan: true,
      codeExecuted: true,
      codeIsolation: "isolated_container",
      codeSha256: runAfterWorker?.codeSha256,
      codeAttestation: "sandbox_not_required",
      codeExecutionFailure: null,
    });
  });

  it("does not report the run as ok until the downstream event send is accepted", async () => {
    const cache = new Map<string, unknown>();
    let rejectSend = true;
    const step = {
      run: async (
        idOrOptions: string | { id: string },
        fn: (...args: unknown[]) => unknown,
        ...args: unknown[]
      ) => {
        const id = typeof idOrOptions === "string" ? idOrOptions : idOrOptions.id;
        if (cache.has(id)) return cache.get(id);
        const value = await fn(...args);
        cache.set(id, value);
        return value;
      },
      sendEvent: async () => {
        if (rejectSend) throw new Error("broker rejected event");
      },
    };
    const invocation = {
      event: {
        name: `${tenantSlug}/START`,
        data: { id: "receipt-dispatch", subject: "receipt-dispatch-subject" },
      },
      step,
      logger: {
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    };

    await expect(registered.fn(invocation)).rejects.toThrow("broker rejected event");
    const pending = getDb()
      .select()
      .from(runs)
      .where(and(eq(runs.agentId, dbAgentId), eq(runs.subject, "receipt-dispatch-subject")))
      .all()[0];
    expect(pending).toMatchObject({ status: "running" });
    expect(pending?.endedAt).toBeNull();
    expect(pending?.emittedEventId).toMatch(/^evt-/);

    rejectSend = false;
    await expect(registered.fn(invocation)).resolves.toMatchObject({
      ok: true,
      runId: pending?.id,
      emittedEventId: pending?.emittedEventId,
    });
    const completed = getDb().select().from(runs).where(eq(runs.id, pending!.id)).all()[0];
    expect(completed?.status).toBe("ok");
    expect(completed?.endedAt).toBeInstanceOf(Date);
  });
});
