import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { GetRunResponse, RunStreamEvent } from "@agentic/contracts";
import { agents, getDb, runs, steps, tenants, workflows } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

interface OkEnvelope<T> {
  ok: true;
  data: T;
}

const suffix = Date.now().toString(36).toLowerCase();
const tenantSlug = `receipt-${suffix}`;
const sha = "b".repeat(64);

describe.sequential("CodeAct receipt API and observability projection", () => {
  let env: TestEnv;
  let tenantId: string;
  let runId: string;
  let stepId: string;
  let declarativeRunId: string;

  beforeAll(async () => {
    env = await buildTestEnv();
    const db = getDb();
    tenantId = makeId("ten");
    const workflowId = makeId("wf");
    const agentId = makeId("agt");
    runId = makeId("run");
    stepId = makeId("stp");
    declarativeRunId = makeId("run");
    const now = Date.now();

    db.insert(tenants)
      .values({ id: tenantId, slug: tenantSlug, name: "Receipt projection" })
      .run();
    db.insert(workflows)
      .values({
        id: workflowId,
        tenantId,
        slug: "receipt-workflow",
        name: "Receipt workflow",
      })
      .run();
    db.insert(agents)
      .values({
        id: agentId,
        workflowId,
        kebabId: "receipt-agent",
        name: "receiptAgent",
        title: "Receipt agent",
        actor: "Agent",
        kind: "manifest",
        enabled: true,
        createdAt: new Date(now - 100),
        updatedAt: new Date(now - 100),
      })
      .run();

    db.insert(runs)
      .values([
        {
          id: runId,
          tenantId,
          agentId,
          status: "failed",
          startedAt: new Date(now - 20),
          endedAt: new Date(now - 10),
          durationMs: 10,
          correlationId: makeId("cor"),
          errorMessage: "generated handler failed",
          codeRan: false,
          codeExecuted: true,
          codeIsolation: "worker_thread",
          codeSha256: sha,
          codeAttestation: "production_verified",
          codeExecutionFailure: "handler_failed",
        },
        {
          id: declarativeRunId,
          tenantId,
          agentId,
          status: "ok",
          startedAt: new Date(now - 40),
          endedAt: new Date(now - 30),
          durationMs: 10,
          correlationId: makeId("cor"),
        },
      ])
      .run();
    db.insert(steps)
      .values({
        id: stepId,
        runId,
        ord: 1,
        name: "execute-generated-handler",
        type: "logic",
        status: "failed",
        startedAt: new Date(now - 20),
        endedAt: new Date(now - 10),
        durationMs: 10,
        error: "generated handler failed",
        codeRan: false,
        codeExecuted: true,
        codeIsolation: "worker_thread",
        codeSha256: sha,
        codeAttestation: "production_verified",
        codeExecutionFailure: "handler_failed",
      })
      .run();
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  const headers = { "x-agentic-tenant": tenantSlug };

  it("returns exact persisted run and step receipts through the detail contract", async () => {
    const response = await env.fetch(`/v1/runs/${runId}`, { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as OkEnvelope<unknown>;
    const detail = GetRunResponse.parse(body.data);

    expect(detail.run).toMatchObject({
      codeRan: false,
      codeExecuted: true,
      codeIsolation: "worker_thread",
      codeSha256: sha,
      codeAttestation: "production_verified",
      codeExecutionFailure: "handler_failed",
    });
    expect(detail.steps).toHaveLength(1);
    expect(detail.steps[0]).toMatchObject({
      id: stepId,
      codeRan: false,
      codeExecuted: true,
      codeIsolation: "worker_thread",
      codeSha256: sha,
      codeAttestation: "production_verified",
      codeExecutionFailure: "handler_failed",
    });
  });

  it("keeps declarative runs null instead of manufacturing an execution receipt", async () => {
    const response = await env.fetch(`/v1/runs/${declarativeRunId}`, {
      headers,
    });
    const body = (await response.json()) as OkEnvelope<unknown>;
    const detail = GetRunResponse.parse(body.data);
    expect(detail.run).toMatchObject({
      codeRan: null,
      codeExecuted: null,
      codeIsolation: null,
      codeSha256: null,
      codeAttestation: null,
      codeExecutionFailure: null,
    });
  });

  it("projects the same receipt into activity and unified observability metadata", async () => {
    const activityResponse = await env.fetch("/v1/activity?limit=500", {
      headers,
    });
    const activityBody = (await activityResponse.json()) as OkEnvelope<
      unknown[]
    >;
    const events = activityBody.data.map((event) =>
      RunStreamEvent.parse(event),
    );
    const failed = events.find(
      (event) => event.type === "run.failed" && event.runId === runId,
    );
    const completedStep = events.find(
      (event) => event.type === "run.step.completed" && event.stepId === stepId,
    );
    expect(failed).toMatchObject({
      codeExecuted: true,
      codeRan: false,
      codeIsolation: "worker_thread",
      codeSha256: sha,
      codeAttestation: "production_verified",
      codeExecutionFailure: "handler_failed",
    });
    expect(completedStep).toMatchObject({
      codeExecuted: true,
      codeRan: false,
      codeIsolation: "worker_thread",
      codeSha256: sha,
      codeAttestation: "production_verified",
      codeExecutionFailure: "handler_failed",
    });

    const timelineResponse = await env.fetch(
      `/v1/observability/timeline?limit=500&since=${Date.now() - 60_000}&until=${Date.now() + 60_000}`,
      { headers },
    );
    expect(timelineResponse.status).toBe(200);
    const timelineBody = (await timelineResponse.json()) as OkEnvelope<{
      items: Array<{ runId: string | null; type: string; metadata: unknown }>;
    }>;
    const observed = timelineBody.data.items.find(
      (item) => item.runId === runId && item.type === "run.failed",
    );
    expect(RunStreamEvent.parse(observed?.metadata)).toMatchObject({
      codeExecuted: true,
      codeRan: false,
      codeIsolation: "worker_thread",
      codeSha256: sha,
      codeAttestation: "production_verified",
      codeExecutionFailure: "handler_failed",
    });
  });
});
