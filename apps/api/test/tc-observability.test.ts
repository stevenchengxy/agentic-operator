/** Unified observability API contract regression. */

import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, events, getDb, runs, tenants, workflows } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

interface Ok<T> {
  ok: true;
  data: T;
}

describe("observability API", () => {
  let env: TestEnv;
  const headers = { "x-agentic-tenant": "raas" };

  beforeAll(async () => {
    env = await buildTestEnv();
  });

  it("returns stable summary arrays and numeric supervision totals", async () => {
    const since = Date.now() - 7 * 86_400_000;
    const res = await env.fetch(
      `/v1/observability/summary?since=${since}&bucketMs=86400000`,
      { headers },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Ok<{
      window: { since: number; until: number; bucketMs: number };
      totals: Record<string, number>;
      rates: Record<string, number>;
      latency: { p50Ms: number | null; p95Ms: number | null };
      byAgent: unknown[];
      byModel: unknown[];
      byStatus: Array<{ status: string; runs: number }>;
      byTool: unknown[];
      timeSeries: unknown[];
      coverage: {
        toolCalls: string;
        tokens: { complete: boolean };
      };
    }>;
    expect(body.ok).toBe(true);
    expect(body.data.window.until).toBeGreaterThan(body.data.window.since);
    expect(body.data.window.bucketMs).toBeGreaterThan(0);
    expect(typeof body.data.totals.runs).toBe("number");
    expect(typeof body.data.totals.tokensIn).toBe("number");
    expect(typeof body.data.totals.tokensOut).toBe("number");
    expect(typeof body.data.totals.toolCalls).toBe("number");
    expect(typeof body.data.totals.testRuns).toBe("number");
    expect(Array.isArray(body.data.byAgent)).toBe(true);
    expect(Array.isArray(body.data.byModel)).toBe(true);
    expect(Array.isArray(body.data.byTool)).toBe(true);
    expect(body.data.byStatus.map((s) => s.status)).toEqual([
      "queued",
      "running",
      "waiting",
      "ok",
      "failed",
      "cancelled",
    ]);
    expect(Array.isArray(body.data.timeSeries)).toBe(true);
    expect(body.data.coverage.toolCalls).toBe("persisted_steps_only");
    expect(typeof body.data.coverage.tokens.complete).toBe("boolean");
  });

  it("rejects an unbounded summary instead of silently truncating it", async () => {
    const res = await env.fetch(
      "/v1/observability/summary?since=0&bucketMs=86400000",
      { headers },
    );
    expect(res.status).toBe(422);
  });

  it("paginates a normalized timeline", async () => {
    const res = await env.fetch("/v1/observability/timeline?since=0&limit=5", {
      headers,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Ok<{
      items: Array<{
        id: string;
        type: string;
        kind: string;
        at: number;
        level: string;
        runId: string | null;
        stepId: string | null;
        eventId: string | null;
        agentName: string | null;
        message: string;
        metadata: unknown;
      }>;
      nextCursor: string | null;
      count: number;
    }>;
    expect(body.data.items.length).toBeLessThanOrEqual(5);
    expect(body.data.count).toBe(body.data.items.length);
    for (const item of body.data.items) {
      expect(typeof item.id).toBe("string");
      expect(typeof item.type).toBe("string");
      expect(typeof item.kind).toBe("string");
      expect(typeof item.at).toBe("number");
      expect(["debug", "info", "warn", "error"]).toContain(item.level);
      expect(typeof item.message).toBe("string");
      expect(item.metadata).toBeTruthy();
    }
  });

  it("returns invocation edges and nodes with cursor-compatible ids", async () => {
    const res = await env.fetch(
      "/v1/observability/invocations?since=0&limit=10",
      { headers },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Ok<{
      items: Array<{
        id: string;
        callerRunId: string | null;
        callerAgent: string | null;
        calleeRunId: string;
        calleeAgent: string;
        callType: string;
        startedAt: number;
        status: string;
      }>;
      edges: unknown[];
      nodes: unknown[];
      nextCursor: string | null;
      count: number;
    }>;
    expect(body.data.items.length).toBeLessThanOrEqual(10);
    expect(body.data.edges).toEqual(body.data.items);
    expect(Array.isArray(body.data.nodes)).toBe(true);
    expect(body.data.count).toBe(body.data.items.length);
    for (const edge of body.data.items) {
      expect(edge.id).toBe(`invoke:${edge.calleeRunId}`);
      expect(typeof edge.calleeAgent).toBe("string");
      expect(typeof edge.callType).toBe("string");
      expect(typeof edge.startedAt).toBe("number");
      expect(typeof edge.status).toBe("string");
    }
  });

  it("never resolves a trigger source agent from another tenant", async () => {
    const db = getDb();
    const raasTenant = db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "raas"))
      .all()[0]!;
    const localAgent = db
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(workflows, eq(workflows.id, agents.workflowId))
      .where(eq(workflows.tenantId, raasTenant.id))
      .all()[0]!;
    const foreignTenantId = makeId("ten");
    const foreignWorkflowId = makeId("wf");
    const foreignAgentId = makeId("agt");
    const eventId = makeId("evt");
    const runId = makeId("run");
    const now = new Date();
    try {
      db.insert(tenants)
        .values({
          id: foreignTenantId,
          slug: `foreign-observe-${makeId("tag").slice(-8)}`,
          name: "Foreign observability tenant",
        })
        .run();
      db.insert(workflows)
        .values({
          id: foreignWorkflowId,
          tenantId: foreignTenantId,
          slug: "foreign",
          name: "Foreign",
        })
        .run();
      db.insert(agents)
        .values({
          id: foreignAgentId,
          workflowId: foreignWorkflowId,
          kebabId: "foreignSecretAgent",
          name: "foreignSecretAgent",
          title: "Foreign Secret Agent",
          actor: "Agent",
          kind: "code",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      // The schema has a global FK for source_agent_id. A poisoned/corrupt
      // legacy row can therefore reference another tenant; the read path must
      // not turn that id into leaked agent identity.
      db.insert(events)
        .values({
          id: eventId,
          tenantId: raasTenant.id,
          name: "CROSS_TENANT_SOURCE",
          sourceAgentId: foreignAgentId,
          receivedAt: now,
        })
        .run();
      db.insert(runs)
        .values({
          id: runId,
          tenantId: raasTenant.id,
          agentId: localAgent.id,
          triggerEventId: eventId,
          correlationId: makeId("cor"),
          status: "ok",
          startedAt: now,
          endedAt: now,
          durationMs: 1,
        })
        .run();

      const res = await env.fetch(
        `/v1/observability/invocations?since=${now.getTime() - 1_000}&until=${now.getTime() + 1_000}&limit=10`,
        { headers },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Ok<{
        items: Array<{
          calleeRunId: string;
          callerAgentId: string | null;
          callerAgent: string | null;
          callerAgentTitle: string | null;
          callType: string;
        }>;
      }>;
      const edge = body.data.items.find((item) => item.calleeRunId === runId);
      expect(edge).toMatchObject({
        callerAgentId: null,
        callerAgent: null,
        callerAgentTitle: null,
        callType: "external",
      });
      expect(JSON.stringify(body)).not.toContain("foreignSecretAgent");
      expect(JSON.stringify(body)).not.toContain(foreignAgentId);
    } finally {
      db.delete(runs).where(eq(runs.id, runId)).run();
      db.delete(events).where(eq(events.id, eventId)).run();
      db.delete(tenants).where(eq(tenants.id, foreignTenantId)).run();
    }
  });
});
