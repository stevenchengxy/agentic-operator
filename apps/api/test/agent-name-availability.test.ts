import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { AgentNameAvailabilityResponse } from "@agentic/contracts";
import {
  deployments,
  getDb,
  tenants,
  workflowVersions,
  workflows,
} from "@agentic/db";
import { buildTestEnv, type TestEnv } from "./harness";

const TENANT = "mi-agent-availability";
const OTHER_TENANT = "mi-agent-availability-other";
const tenantId = "ten-agent-availability";
const otherTenantId = "ten-agent-availability-other";
const workflowId = "wf-agent-availability";
const versionId = "wfv-agent-availability";
const deploymentId = "dpl-agent-availability";

const existingAgent = {
  id: "candidate-review",
  name: "LegacyAgent",
  title: "Legacy agent",
  description: "Existing live agent used to exercise identity conflicts.",
  actor: ["Agent"],
  trigger: ["WORK_REQUESTED"],
  actions: [
    {
      order: "1",
      name: "completeWork",
      description: "Complete the requested work.",
      type: "logic",
    },
  ],
  triggered_event: ["WORK_COMPLETED"],
};

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; hint?: string };
}

function removeFixtures(): void {
  getDb()
    .delete(tenants)
    .where(inArray(tenants.id, [tenantId, otherTenantId]))
    .run();
}

describe("agent authoring name availability", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await buildTestEnv();
    removeFixtures();
    const db = getDb();
    db.insert(tenants)
      .values([
        { id: tenantId, slug: TENANT, name: "Availability probe" },
        {
          id: otherTenantId,
          slug: OTHER_TENANT,
          name: "Availability isolation probe",
        },
      ])
      .run();
    db.insert(workflows)
      .values({
        id: workflowId,
        tenantId,
        slug: `${TENANT}-default`,
        name: `${TENANT}-default`,
      })
      .run();
    db.insert(workflowVersions)
      .values({
        id: versionId,
        workflowId,
        version: "v1",
        manifestJson: [existingAgent],
      })
      .run();
    db.insert(deployments)
      .values({
        id: deploymentId,
        tenantId,
        target: "workflow",
        versionId,
        status: "live",
      })
      .run();
  });

  afterAll(removeFixtures);

  async function check(name: string, tenant = TENANT) {
    const response = await env.fetch(
      `/v1/agents/availability?name=${encodeURIComponent(name)}`,
      { headers: { "x-agentic-tenant": tenant } },
    );
    const body = (await response.json()) as Envelope<unknown>;
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    return AgentNameAvailabilityResponse.parse(body.data);
  }

  it("reports a case-insensitive live name conflict immediately", async () => {
    expect(await check("legacyAgent")).toEqual({
      name: "legacyAgent",
      id: "legacy-agent",
      available: false,
      conflict: { field: "name", value: "legacyAgent" },
    });
  });

  it("reports a derived id collision when the live name is different", async () => {
    expect(await check("candidateReview")).toEqual({
      name: "candidateReview",
      id: "candidate-review",
      available: false,
      conflict: { field: "id", value: "candidate-review" },
    });
  });

  it("normalizes valid input and returns the deploy-time derived id", async () => {
    expect(await check("  freshAgent2  ")).toEqual({
      name: "freshAgent2",
      id: "fresh-agent-2",
      available: true,
      conflict: null,
    });
  });

  it("scopes duplicate checks to the authenticated tenant", async () => {
    expect(await check("legacyAgent", OTHER_TENANT)).toMatchObject({
      available: true,
      conflict: null,
    });
  });

  it("rejects malformed authoring names instead of querying loosely", async () => {
    const response = await env.fetch(
      "/v1/agents/availability?name=Not-valid!",
      { headers: { "x-agentic-tenant": TENANT } },
    );
    const body = (await response.json()) as Envelope<unknown>;
    expect(response.status).toBe(400);
    expect(body.error?.code).toBe("invalid_input");
    expect(body.error?.hint).toContain("lower camelCase");
  });
});
