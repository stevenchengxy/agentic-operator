import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  GenerateWorkflowResponseSchema,
  WorkflowDetailSchema,
  WorkflowListResponseSchema,
  WorkflowTemplateCatalogResponseSchema,
  WorkflowValidationResponseSchema,
  type WorkflowDetail,
} from "@agentic/contracts";
import { getDb, tenants } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

const suffix = Date.now().toString(36).slice(-8);
const tenantASlug = `wf-route-${suffix}-a`;
const tenantBSlug = `wf-route-${suffix}-b`;
const tenantAId = makeId("ten");
const tenantBId = makeId("ten");
const workflowSlug = `route-${suffix}`;

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

describe("workflow authoring HTTP API", () => {
  let env: TestEnv;
  let workflow: WorkflowDetail;

  beforeAll(async () => {
    getDb()
      .insert(tenants)
      .values([
        { id: tenantAId, slug: tenantASlug, name: "Workflow route A" },
        { id: tenantBId, slug: tenantBSlug, name: "Workflow route B" },
      ])
      .run();
    env = await buildTestEnv();
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, tenantAId)).run();
    getDb().delete(tenants).where(eq(tenants.id, tenantBId)).run();
  });

  it("returns the API-owned template catalog", async () => {
    const response = await env.fetch("/v1/workflow-templates", {
      headers: { "x-agentic-tenant": tenantASlug },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    const catalog = WorkflowTemplateCatalogResponseSchema.parse(body.data);
    expect(catalog.templates).toHaveLength(6);
    expect(catalog.templates[0]?.agentCount).toBeGreaterThan(0);
  });

  it("creates and reloads a server draft without making it visible cross-tenant", async () => {
    const created = await env.fetch("/v1/workflows", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({
        slug: workflowSlug,
        name: "Route workflow",
        description: "Created through the new authoring API",
        source: { type: "template", templateId: "hello-world" },
        model: { provider: "mock", model: "mock-model-v1" },
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as Envelope<unknown>;
    workflow = WorkflowDetailSchema.parse(createdBody.data);
    expect(created.headers.get("etag")).toBe(`"${workflow.latestVersionId}"`);
    expect(workflow.status).toBe("draft");

    const own = await env.fetch(`/v1/workflows/${workflowSlug}`, {
      headers: { "x-agentic-tenant": tenantASlug },
    });
    expect(own.status).toBe(200);
    const other = await env.fetch(`/v1/workflows/${workflowSlug}`, {
      headers: { "x-agentic-tenant": tenantBSlug },
    });
    expect(other.status).toBe(404);
    const otherBody = (await other.json()) as Envelope<unknown>;
    expect(otherBody.error?.code).toBe("workflow_not_found");
  });

  it("saves a new revision and rejects a stale base version", async () => {
    const baseVersionId = workflow.latestVersionId;
    const manifest = structuredClone(workflow.manifest);
    manifest.agents[0]!.title = "Updated through PUT";
    const updated = await env.fetch(`/v1/workflows/${workflowSlug}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({ baseVersionId, manifest }),
    });
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as Envelope<unknown>;
    workflow = WorkflowDetailSchema.parse(updatedBody.data);
    expect(workflow.latestVersionId).not.toBe(baseVersionId);
    expect(workflow.manifest.agents[0]?.title).toBe("Updated through PUT");

    const stale = await env.fetch(`/v1/workflows/${workflowSlug}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({ baseVersionId, manifest }),
    });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as Envelope<unknown>;
    expect(staleBody.error?.code).toBe("workflow_version_conflict");
  });

  it("validates the persisted revision separately from saving", async () => {
    const response = await env.fetch(`/v1/workflows/${workflowSlug}/validate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    const result = WorkflowValidationResponseSchema.parse(body.data);
    expect(result.valid).toBe(true);
    expect(result.versionId).toBe(workflow.latestVersionId);
  });

  it("generates a deterministic mock preview without persisting it", async () => {
    const before = await env.fetch("/v1/workflows", {
      headers: { "x-agentic-tenant": tenantASlug },
    });
    const beforeBody = (await before.json()) as Envelope<unknown>;
    const beforeList = WorkflowListResponseSchema.parse(beforeBody.data);

    const response = await env.fetch("/v1/workflows/generate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({
        purpose:
          "Classify customer requests, prepare a safe resolution, and escalate uncertain outcomes for review.",
        provider: "mock",
        model: "mock-model-v1",
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<unknown>;
    const generated = GenerateWorkflowResponseSchema.parse(body.data);
    expect(generated.validation.valid).toBe(true);
    expect(generated.manifest.agents.length).toBeGreaterThanOrEqual(2);

    const after = await env.fetch("/v1/workflows", {
      headers: { "x-agentic-tenant": tenantASlug },
    });
    const afterBody = (await after.json()) as Envelope<unknown>;
    const afterList = WorkflowListResponseSchema.parse(afterBody.data);
    expect(afterList.workflows).toHaveLength(beforeList.workflows.length);
  });

  it("maps malformed manifests to 400 and still tenant-scopes inline validation", async () => {
    const invalidCreate = await env.fetch("/v1/workflows", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantASlug,
      },
      body: JSON.stringify({
        slug: `invalid-${suffix}`,
        name: "Invalid workflow",
        source: { type: "manifest", manifest: { notAgents: [] } },
      }),
    });
    expect(invalidCreate.status).toBe(400);
    const invalidBody = (await invalidCreate.json()) as Envelope<unknown>;
    expect(invalidBody.error?.code).toBe("invalid_workflow_manifest");

    const scopedValidate = await env.fetch(
      `/v1/workflows/${workflowSlug}/validate`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenantBSlug,
        },
        body: JSON.stringify({ manifest: workflow.manifest }),
      },
    );
    expect(scopedValidate.status).toBe(404);
  });

  it("deletes a non-live draft", async () => {
    const response = await env.fetch(`/v1/workflows/${workflowSlug}`, {
      method: "DELETE",
      headers: { "x-agentic-tenant": tenantASlug },
    });
    expect(response.status).toBe(200);
    const missing = await env.fetch(`/v1/workflows/${workflowSlug}`, {
      headers: { "x-agentic-tenant": tenantASlug },
    });
    expect(missing.status).toBe(404);
  });
});
