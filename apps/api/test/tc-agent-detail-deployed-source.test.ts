import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  agents,
  agentVersions,
  deployments,
  getDb,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { ManifestUploadBody } from "@agentic/contracts";
import { makeId } from "@agentic/shared";
import { findManifestAgentTrigger } from "../src/queries/agents";
import { buildTestEnv, type TestEnv } from "./harness";

describe("agent detail deployed-source truth", () => {
  let env: TestEnv;
  let tenantId: string;
  let tenantSlug: string;
  let deployedAgentKebab: string;
  let undeployedAgentKebab: string;
  let deployedAgentVersionId: string;
  let deployedWorkflowVersionId: string;
  let deploymentId: string;

  beforeAll(async () => {
    env = await buildTestEnv();
    const db = getDb();
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    tenantId = makeId("tnt");
    tenantSlug = `qa-probe-agent-source-${nonce}`;
    deployedAgentKebab = `deployed-${nonce}`;
    undeployedAgentKebab = `undeployed-${nonce}`;

    const workflowId = makeId("wf");
    deployedWorkflowVersionId = makeId("wfv");
    const draftWorkflowVersionId = makeId("wfv");
    const deployedAgentId = makeId("agt");
    const undeployedAgentId = makeId("agt");
    deployedAgentVersionId = makeId("agv");
    const draftAgentVersionId = makeId("agv");
    const undeployedAgentVersionId = makeId("agv");
    deploymentId = makeId("dpl");
    const now = new Date();

    db.transaction(() => {
      db.insert(tenants)
        .values({ id: tenantId, slug: tenantSlug, name: "Agent source test" })
        .run();
      db.insert(workflows)
        .values({
          id: workflowId,
          tenantId,
          slug: `${tenantSlug}-default`,
          name: "Agent source workflow",
        })
        .run();
      db.insert(workflowVersions)
        .values([
          {
            id: deployedWorkflowVersionId,
            workflowId,
            version: "live-v1",
            manifestJson: [] as unknown as object,
          },
          {
            id: draftWorkflowVersionId,
            workflowId,
            version: "draft-v2",
            manifestJson: [] as unknown as object,
          },
        ])
        .run();
      db.insert(agents)
        .values([
          {
            id: deployedAgentId,
            workflowId,
            kebabId: deployedAgentKebab,
            name: "deployedAgent",
            title: "Deployed agent",
            actor: "Agent",
            kind: "manifest",
            enabled: true,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: undeployedAgentId,
            workflowId,
            kebabId: undeployedAgentKebab,
            name: "undeployedAgent",
            title: "Undeployed agent",
            actor: "Agent",
            kind: "manifest",
            enabled: false,
            createdAt: now,
            updatedAt: now,
          },
        ])
        .run();
      db.insert(agentVersions)
        .values([
          {
            id: deployedAgentVersionId,
            agentId: deployedAgentId,
            workflowVersionId: deployedWorkflowVersionId,
            manifestJson: {
              id: deployedAgentKebab,
              name: "deployedAgent",
              description: "actual deployed manifest",
              actor: ["Agent"],
              trigger: ["LIVE_INPUT"],
              actions: [
                { order: "1", name: "liveTool", type: "tool", description: "" },
              ],
              triggered_event: ["LIVE_OUTPUT"],
              input_data: { candidateId: "string" },
              ontology_instructions: "Use only deployed rules.",
              tool_use: [
                { name: "records.upsert", config: { table: "candidates" } },
              ],
              typescript_code: "export async function run() { return 'live'; }",
            },
          },
          {
            id: draftAgentVersionId,
            agentId: deployedAgentId,
            workflowVersionId: draftWorkflowVersionId,
            manifestJson: {
              id: deployedAgentKebab,
              name: "deployedAgent",
              description: "newer undeployed draft",
              actor: ["Agent"],
              trigger: ["DRAFT_INPUT"],
              actions: [],
              triggered_event: ["DRAFT_OUTPUT"],
              input_data: { shouldNeverLeak: true },
              ontology_instructions: "DRAFT ONLY",
              tool_use: [{ name: "draft.tool" }],
              typescript_code: "throw new Error('draft leaked')",
            },
          },
          {
            id: undeployedAgentVersionId,
            agentId: undeployedAgentId,
            workflowVersionId: draftWorkflowVersionId,
            manifestJson: {
              id: undeployedAgentKebab,
              name: "undeployedAgent",
              actor: ["Agent"],
              trigger: ["NOT_LIVE"],
              actions: [],
              triggered_event: [],
              typescript_code: "not deployed",
            },
          },
        ])
        .run();
      db.insert(deployments)
        .values({
          id: deploymentId,
          tenantId,
          target: "workflow",
          versionId: deployedWorkflowVersionId,
          status: "live",
          note: "deployed-source truth fixture",
        })
        .run();
    });
  });

  afterAll(() => {
    if (tenantId) {
      getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
    }
  });

  it("returns fields from the live agent_version, never the newer draft", async () => {
    const response = await env.fetch(`/v1/agents/${deployedAgentKebab}`, {
      headers: { "x-agentic-tenant": tenantSlug },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      kind: "manifest",
      enabled: true,
      description: "actual deployed manifest",
      triggers: ["LIVE_INPUT"],
      triggeredEvents: ["LIVE_OUTPUT"],
      workflowVersion: "live-v1",
      input_data: { candidateId: "string" },
      ontology_instructions: "Use only deployed rules.",
      tool_use: [{ name: "records.upsert", config: { table: "candidates" } }],
      typescript_code: "export async function run() { return 'live'; }",
      sourceUnavailable: false,
      deployedSource: {
        deploymentId,
        deploymentTarget: "workflow",
        agentVersionId: deployedAgentVersionId,
        workflowVersionId: deployedWorkflowVersionId,
        storage: "agent_versions.manifest_json",
      },
    });
    expect(JSON.stringify(body.data)).not.toContain("DRAFT ONLY");
    expect(JSON.stringify(body.data)).not.toContain("shouldNeverLeak");
  });

  it("reports null source fields when no live deployment references the agent version", async () => {
    const response = await env.fetch(`/v1/agents/${undeployedAgentKebab}`, {
      headers: { "x-agentic-tenant": tenantSlug },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      enabled: false,
      workflowVersion: null,
      description: null,
      input_data: null,
      ontology_instructions: null,
      tool_use: null,
      typescript_code: null,
      sourceUnavailable: true,
      deployedSource: null,
      triggers: [],
      triggeredEvents: [],
      actions: [],
    });
  });

  it("keeps list descriptions and invocation triggers bound to the live version", async () => {
    const listResponse = await env.fetch("/v1/agents?kind=manifest", {
      headers: { "x-agentic-tenant": tenantSlug },
    });
    expect(listResponse.status).toBe(200);
    const listBody = (await listResponse.json()) as {
      data: Array<{ kebabId: string; description: string | null }>;
    };
    expect(
      listBody.data.find((row) => row.kebabId === deployedAgentKebab),
    ).toMatchObject({ description: "actual deployed manifest" });
    expect(
      listBody.data.find((row) => row.kebabId === undeployedAgentKebab),
    ).toMatchObject({ description: null });

    const trigger = await findManifestAgentTrigger(tenantSlug, "deployedAgent");
    expect(trigger).toMatchObject({
      triggers: ["LIVE_INPUT"],
      sourceUnavailable: false,
    });

    const invokeResponse = await env.fetch("/v1/agents/undeployedAgent/invoke", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantSlug,
      },
      body: JSON.stringify({ input: { subject: "source-truth-test" } }),
    });
    expect(invokeResponse.status).toBe(409);
    const invokeBody = (await invokeResponse.json()) as {
      error: { code: string; message: string };
    };
    expect(invokeBody.error.code).toBe("agent_source_unavailable");
    expect(invokeBody.error.message).toContain("undeployed draft");
  });

  it("preserves source fields and extended action metadata in direct manifest uploads", () => {
    const parsed = ManifestUploadBody.parse({
      manifest: [
        {
          id: "upload-source",
          name: "uploadSource",
          actor: ["Agent"],
          trigger: ["INPUT"],
          actions: [
            {
              order: "1",
              name: "childAgent",
              type: "invoke",
              invoke: "childAgent",
              forward_results: true,
            },
          ],
          triggered_event: ["OUTPUT"],
          input_data: { id: "string" },
          ontology_instructions: "real instructions",
          tool_use: [{ name: "real.tool", config: { endpoint: "https://example.test" } }],
          typescript_code: "export const handler = () => 1;",
          model: "provider/model",
        },
      ],
    });
    expect(parsed.manifest[0]).toMatchObject({
      input_data: { id: "string" },
      ontology_instructions: "real instructions",
      tool_use: [{ name: "real.tool", config: { endpoint: "https://example.test" } }],
      typescript_code: "export const handler = () => 1;",
      model: "provider/model",
      actions: [
        {
          type: "invoke",
          invoke: "childAgent",
          forward_results: true,
        },
      ],
    });
  });
});
