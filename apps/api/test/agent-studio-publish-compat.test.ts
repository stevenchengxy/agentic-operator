import { rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  AgentDefinitionV2Schema,
  AgentDraftResponseSchema,
  PublishAgentDraftResponseSchema,
} from "@agentic/contracts";
import {
  agents,
  agentVersions,
  deployments,
  getDb,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

const SUFFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TENANT = `studio-publish-${SUFFIX}`.slice(0, 48);
const tenantId = makeId("ten");
const workflowId = makeId("wf");
const workflowVersionId = makeId("wfv");
const deploymentId = makeId("dpl");
const targetAgentId = makeId("agt");
const siblingAgentId = makeId("agt");
const targetVersionId = makeId("agv");
const siblingVersionId = makeId("agv");

const legacyTarget = {
  id: "legacy-publish-target",
  name: "legacyPublishTarget",
  title: "Legacy publish target",
  description: "The currently published legacy definition.",
  actor: ["Agent"],
  trigger: [],
  input_data: {},
  ontology_instructions: "Return the legacy result.",
  generated: true,
  actions: [
    {
      order: "1",
      name: "legacyStep",
      description: "Produce the legacy result.",
      type: "logic",
    },
  ],
  triggered_event: [],
};

const legacySibling = {
  id: "legacy-publish-sibling",
  name: "legacyPublishSibling",
  title: "Unrelated legacy sibling",
  description: "Must survive publishing another agent.",
  actor: ["Agent"],
  trigger: [],
  input_data: {},
  ontology_instructions: "Return the sibling result.",
  generated: true,
  actions: [
    {
      order: "1",
      name: "siblingStep",
      description: "Produce the sibling result.",
      type: "logic",
    },
  ],
  triggered_event: [],
};

const studioDefinition = AgentDefinitionV2Schema.parse({
  id: legacyTarget.id,
  name: legacyTarget.name,
  title: legacyTarget.title,
  description: "The definition edited in Agent Studio.",
  actor: ["Agent"],
  trigger: [],
  inputs: [
    {
      id: "prompt",
      label: "Request",
      kind: "prompt",
      required: true,
      schema: { type: "string", minLength: 1 },
      sensitivity: "none",
    },
  ],
  ontology_instructions: "Complete the request and return structured JSON.",
  user_prompt_template: "{{inputs.prompt}}",
  generated: true,
  tool_use: [],
  actions: [
    {
      order: "1",
      name: "completeRequest",
      description: "Complete the request using the model.",
      type: "logic",
    },
  ],
  outputs: [
    {
      id: "result",
      label: "Result",
      required: true,
      schema: { type: "object" },
      sensitivity: "none",
    },
  ],
  triggered_event: [],
  // Agent Studio deliberately serializes disabled scheduling as null. The
  // legacy bare-array import boundary must accept these v2 sentinels.
  cron: null,
  cron_timezone: null,
});

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: { impacts?: string[] };
  };
}

describe("Agent Studio publish compatibility", () => {
  let env: TestEnv;
  const modelDir = path.join(
    process.env.AGENTIC_MODELS_DIR ??
      path.resolve(__dirname, "../../../models"),
    `${TENANT}-v1`,
  );

  beforeAll(async () => {
    env = await buildTestEnv();
    const db = getDb();
    const now = new Date();
    db.insert(tenants)
      .values({
        id: tenantId,
        slug: TENANT,
        name: "Studio publish compatibility",
      })
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
        id: workflowVersionId,
        workflowId,
        version: "legacy-v1",
        manifestJson: [legacyTarget, legacySibling],
        createdAt: now,
      })
      .run();
    db.insert(deployments)
      .values({
        id: deploymentId,
        tenantId,
        target: "workflow",
        versionId: workflowVersionId,
        status: "live",
        deployedAt: now,
      })
      .run();
    db.insert(agents)
      .values([
        {
          id: targetAgentId,
          tenantId,
          workflowId,
          kebabId: legacyTarget.id,
          name: legacyTarget.name,
          title: legacyTarget.title,
          actor: "Agent",
          kind: "manifest",
          enabled: true,
          lifecycle: "active",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: siblingAgentId,
          tenantId,
          workflowId,
          kebabId: legacySibling.id,
          name: legacySibling.name,
          title: legacySibling.title,
          actor: "Agent",
          kind: "manifest",
          enabled: true,
          lifecycle: "active",
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    db.insert(agentVersions)
      .values([
        {
          id: targetVersionId,
          agentId: targetAgentId,
          workflowVersionId,
          manifestJson: legacyTarget,
          definitionSchemaVersion: 1,
          publishedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: siblingVersionId,
          agentId: siblingAgentId,
          workflowVersionId,
          manifestJson: legacySibling,
          definitionSchemaVersion: 1,
          publishedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
  });

  afterAll(async () => {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
    await rm(modelDir, { recursive: true, force: true });
  });

  it("confirms impact, then publishes null schedule fields into a multi-agent legacy workflow", async () => {
    const createResponse = await env.fetch(
      `/v1/agents/${targetAgentId}/drafts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": TENANT,
        },
        body: JSON.stringify({ definition: studioDefinition }),
      },
    );
    expect(createResponse.status).toBe(201);
    const created = (await createResponse.json()) as Envelope<unknown>;
    const draft = AgentDraftResponseSchema.parse(created.data).draft;
    expect(draft.definition.cron).toBeNull();
    expect(draft.definition.cron_timezone).toBeNull();

    const initialPublish = await env.fetch(
      `/v1/agent-drafts/${draft.id}/publish`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": TENANT,
        },
        body: JSON.stringify({ confirmImpact: false }),
      },
    );
    expect(initialPublish.status).toBe(409);
    const impact = (await initialPublish.json()) as Envelope<never>;
    expect(impact.error?.code).toBe("impact_confirmation_required");
    expect(impact.error?.details?.impacts).toEqual(
      expect.arrayContaining(["inputs", "outputs", "actions"]),
    );

    const confirmedPublish = await env.fetch(
      `/v1/agent-drafts/${draft.id}/publish`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": TENANT,
        },
        body: JSON.stringify({ confirmImpact: true }),
      },
    );
    expect(confirmedPublish.status).toBe(201);
    const confirmed = (await confirmedPublish.json()) as Envelope<unknown>;
    const published = PublishAgentDraftResponseSchema.parse(confirmed.data);

    const live = getDb()
      .select({ manifest: workflowVersions.manifestJson })
      .from(deployments)
      .innerJoin(
        workflowVersions,
        eq(workflowVersions.id, deployments.versionId),
      )
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
          eq(workflowVersions.id, published.workflowVersionId),
        ),
      )
      .limit(1)
      .all()[0];
    expect(live).toBeDefined();
    const manifest = live!.manifest as Array<Record<string, unknown>>;
    expect(manifest.map((agent) => agent.id)).toEqual(
      expect.arrayContaining([legacyTarget.id, legacySibling.id]),
    );
    expect(manifest).toHaveLength(2);
    const publishedTarget = manifest.find(
      (agent) => agent.id === legacyTarget.id,
    );
    expect(publishedTarget?.description).toBe(studioDefinition.description);
    expect(publishedTarget).not.toHaveProperty("cron");
    expect(publishedTarget).not.toHaveProperty("cron_timezone");
  });
});
