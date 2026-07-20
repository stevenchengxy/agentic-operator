/**
 * TC-5 — monitoring + deployment audit reuse.
 *
 * After invoking testAgent, verify:
 *   1. GET /v1/agents?kind=code lists testAgent with recent run count >=1
 *   2. GET /v1/runs/<runId> returns the run with its steps array
 *   3. Deployments table has a row with target='code_agent' for testAgent
 */

import { describe, it, expect, beforeAll } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import {
  agents,
  agentVersions,
  deployments,
  getDb,
  runs,
  tenants,
  workflows,
} from "@agentic/db";
import { buildTestEnv, type TestEnv } from "./harness";

describe("TC-5: monitoring + deployment audit reuse", () => {
  let env: TestEnv;
  let runId: string;

  beforeAll(async () => {
    env = await buildTestEnv();
    const res = await env.fetch("/v1/agents/testAgent/invoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { runId: string } };
    runId = body.data.runId;
  });

  it("GET /v1/agents?kind=code returns testAgent", async () => {
    const res = await env.fetch("/v1/agents?kind=code");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: Array<{ kebabId: string; kind: string; runCount: number }>;
    };
    expect(body.ok).toBe(true);
    const ta = body.data.find((a) => a.kebabId === "testAgent");
    expect(ta).toBeDefined();
    expect(ta!.kind).toBe("code");
    expect(ta!.runCount).toBeGreaterThanOrEqual(1);
  });

  it("GET /v1/runs/:runId returns the run with steps array", async () => {
    const res = await env.fetch(`/v1/runs/${runId}`);
    expect(res.status).toBe(200);
    // Route wraps as { run, steps } — match the actual contract.
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        run: { id: string; status: string };
        steps: Array<{ provider?: string | null; model?: string | null }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.run.id).toBe(runId);
    expect(body.data.run.status).toBe("ok");
    expect(Array.isArray(body.data.steps)).toBe(true);
    expect(body.data.steps.length).toBeGreaterThanOrEqual(1);
    const firstStep = body.data.steps[0]!;
    expect(firstStep.provider).toBe("mock");
    expect(firstStep.model).toBe("mock-model-v1");
  });

  it("deployments table contains a target='code_agent' row for testAgent", () => {
    const db = getDb();
    const systemTenant = db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, "__system"))
      .all()[0];
    expect(systemTenant).toBeDefined();

    const testAgentRow = db
      .select()
      .from(agents)
      .innerJoin(workflows, eq(workflows.id, agents.workflowId))
      .where(
        and(
          eq(agents.kebabId, "testAgent"),
          eq(workflows.tenantId, systemTenant!.id),
          eq(workflows.slug, "__system"),
        ),
      )
      .all()[0];
    expect(testAgentRow).toBeDefined();

    const depRow = db
      .select()
      .from(deployments)
      .innerJoin(agentVersions, eq(agentVersions.id, deployments.versionId))
      .where(
        and(
          eq(deployments.tenantId, systemTenant!.id),
          eq(deployments.target, "code_agent"),
          eq(deployments.status, "live"),
          eq(agentVersions.agentId, testAgentRow!.agents.id),
        ),
      )
      .all()[0];
    expect(depRow).toBeDefined();
    expect(depRow!.deployments.status).toBe("live");
  });

  it("the run is reachable via the recent-runs query for testAgent", () => {
    // listAgentRuns is what /v1/agents/:kebab uses for recent runs;
    // testing it indirectly via the public route is more honest.
    const db = getDb();
    const testAgentRow = db
      .select()
      .from(agents)
      .where(eq(agents.kebabId, "testAgent"))
      .all()[0];
    const rs = db
      .select()
      .from(runs)
      .where(eq(runs.agentId, testAgentRow!.id))
      .orderBy(desc(runs.startedAt))
      .limit(5)
      .all();
    expect(rs.some((r) => r.id === runId)).toBe(true);
  });
});
