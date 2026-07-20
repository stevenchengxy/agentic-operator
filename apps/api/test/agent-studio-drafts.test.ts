/**
 * Agent Studio draft API contract.
 *
 * Exercises the server-backed edit lifecycle through Fastify so regressions
 * in tenant scoping, ETags, optimistic concurrency, or semantic validation
 * are caught without requiring an LLM or Inngest dev server.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  AgentDraftResponseSchema,
  AgentDefinitionV2Schema,
  AgentEditorResponseSchema,
  CreateAgentDraftBodySchema,
  ValidateAgentDraftResponseSchema,
  type AgentDefinitionV2,
  type AgentDefinitionV2Input,
} from "@agentic/contracts";
import {
  agentDrafts,
  agents,
  getDb,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  definitionHash,
  mergeAgentDefinitionIntoManifest,
} from "../src/services/agent-drafts";
import { buildTestEnv, type TestEnv } from "./harness";

const SUFFIX = Date.now().toString(36).slice(-8);
const TENANT_A = `studio-${SUFFIX}-a`.slice(0, 32);
const TENANT_B = `studio-${SUFFIX}-b`.slice(0, 32);
const tenantAId = makeId("ten");
const tenantBId = makeId("ten");
const selectedWorkflowId = makeId("wf");
const secondaryWorkflowId = makeId("wf");
const foreignWorkflowId = makeId("wf");
const SELECTED_WORKFLOW = `selected-${SUFFIX}`;
const SECONDARY_WORKFLOW = `secondary-${SUFFIX}`;
const FOREIGN_WORKFLOW = `foreign-${SUFFIX}`;
const selectedBaseVersionId = makeId("wfv");
const selectedMissingAgentVersionId = makeId("wfv");
const secondaryBaseVersionId = makeId("wfv");
const foreignBaseVersionId = makeId("wfv");
const SCOPED_AGENT_ID = `shared-agent-${SUFFIX}`;
const SELECTED_SCOPED_AGENT_NAME = `selectedSharedAgent${SUFFIX}`;
const SECONDARY_SCOPED_AGENT_NAME = `secondarySharedAgent${SUFFIX}`;

function definition(
  overrides: Partial<AgentDefinitionV2Input> = {},
): AgentDefinitionV2Input {
  return {
    id: `draft-agent-${SUFFIX}`,
    name: `draftAgent${SUFFIX}`,
    title: "Draft lifecycle agent",
    description: "Exercises the Agent Studio draft API.",
    actor: ["Agent"],
    trigger: ["DRAFT_TEST_REQUESTED"],
    inputs: [
      {
        id: "prompt",
        kind: "prompt",
        required: true,
        schema: { type: "string", minLength: 1 },
      },
      {
        id: "profile",
        kind: "value",
        required: true,
        schema: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
          additionalProperties: false,
        },
      },
    ],
    user_prompt_template: "{{json inputs.profile}}",
    actions: [
      {
        order: "1",
        name: "produceResult",
        description: "Produce a structured result.",
        type: "logic",
      },
    ],
    outputs: [
      {
        id: "result",
        required: true,
        schema: {
          type: "object",
          required: ["summary"],
          properties: { summary: { type: "string" } },
          additionalProperties: false,
        },
      },
    ],
    triggered_event: ["DRAFT_TEST_COMPLETED"],
    ...overrides,
  };
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

describe("Agent Studio definition identity", () => {
  it("hashes JSON objects canonically while preserving array order", () => {
    const left = {
      id: "canonical",
      schema: {
        required: ["first", "second"],
        properties: {
          first: { type: "string", minLength: 1 },
          second: { type: "number" },
        },
      },
    };
    const reorderedKeys = {
      schema: {
        properties: {
          second: { type: "number" },
          first: { minLength: 1, type: "string" },
        },
        required: ["first", "second"],
      },
      id: "canonical",
    };
    const reorderedArray = {
      ...reorderedKeys,
      schema: { ...reorderedKeys.schema, required: ["second", "first"] },
    };

    expect(definitionHash(left)).toBe(definitionHash(reorderedKeys));
    expect(definitionHash(left)).not.toBe(definitionHash(reorderedArray));
  });

  it("merges by immutable id without dropping an unrelated same-name agent", () => {
    const replacement = AgentDefinitionV2Schema.parse(definition());
    const sameNameId = `same-name-${SUFFIX}`;
    const merged = mergeAgentDefinitionIntoManifest(
      {
        agents: [
          { id: replacement.id, name: "oldRuntimeName" },
          { name: replacement.name, legacy: true },
          { id: sameNameId, name: replacement.name, preserved: true },
        ],
      },
      { kebabId: replacement.id, name: replacement.name },
      replacement,
    );

    expect(merged).toHaveLength(2);
    expect(merged).toContainEqual(
      expect.objectContaining({ id: sameNameId, preserved: true }),
    );
    expect(merged.filter((agent) => agent.id === replacement.id)).toEqual([
      replacement,
    ]);
  });
});

describe("Agent Studio draft creation contract", () => {
  it("accepts a workflow slug and rejects malformed workflow identifiers", () => {
    expect(
      CreateAgentDraftBodySchema.parse({
        definition: definition(),
        workflowSlug: SELECTED_WORKFLOW,
      }).workflowSlug,
    ).toBe(SELECTED_WORKFLOW);
    expect(
      CreateAgentDraftBodySchema.safeParse({
        definition: definition(),
        workflowSlug: "Not a workflow slug",
      }).success,
    ).toBe(false);
  });
});

describe("Agent Studio draft routes", () => {
  let env: TestEnv;
  let draftId: string;
  let agentId: string;
  let currentDefinition: AgentDefinitionV2;
  let selectedScopedAgentId: string;
  let secondaryScopedAgentId: string;

  beforeAll(async () => {
    const db = getDb();
    db.insert(tenants)
      .values([
        { id: tenantAId, slug: TENANT_A, name: "Studio test A" },
        { id: tenantBId, slug: TENANT_B, name: "Studio test B" },
      ])
      .run();
    db.insert(workflows)
      .values([
        {
          id: selectedWorkflowId,
          tenantId: tenantAId,
          slug: SELECTED_WORKFLOW,
          name: "Selected Studio workflow",
        },
        {
          id: secondaryWorkflowId,
          tenantId: tenantAId,
          slug: SECONDARY_WORKFLOW,
          name: "Secondary Studio workflow",
        },
        {
          id: foreignWorkflowId,
          tenantId: tenantBId,
          slug: FOREIGN_WORKFLOW,
          name: "Foreign Studio workflow",
        },
      ])
      .run();
    db.insert(workflowVersions)
      .values([
        {
          id: selectedBaseVersionId,
          workflowId: selectedWorkflowId,
          version: "scoped-base-1",
          manifestJson: {
            agents: [
              definition({
                id: SCOPED_AGENT_ID,
                name: SELECTED_SCOPED_AGENT_NAME,
              }),
            ],
          },
        },
        {
          id: selectedMissingAgentVersionId,
          workflowId: selectedWorkflowId,
          version: "scoped-base-without-agent",
          manifestJson: { agents: [] },
        },
        {
          id: secondaryBaseVersionId,
          workflowId: secondaryWorkflowId,
          version: "scoped-base-1",
          manifestJson: {
            agents: [
              definition({
                id: SCOPED_AGENT_ID,
                name: SECONDARY_SCOPED_AGENT_NAME,
              }),
            ],
          },
        },
        {
          id: foreignBaseVersionId,
          workflowId: foreignWorkflowId,
          version: "scoped-base-1",
          manifestJson: {
            agents: [
              definition({
                id: SCOPED_AGENT_ID,
                name: SELECTED_SCOPED_AGENT_NAME,
              }),
            ],
          },
        },
      ])
      .run();
    env = await buildTestEnv();
  });

  afterAll(() => {
    // Every Studio row created by this suite is below one of these tenants and
    // is removed by the schema's tenant cascades.
    const db = getDb();
    db.delete(tenants).where(eq(tenants.id, tenantAId)).run();
    db.delete(tenants).where(eq(tenants.id, tenantBId)).run();
  });

  it("creates a new agent and revision-1 draft", async () => {
    const res = await env.fetch("/v1/agents/drafts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT_A,
      },
      body: JSON.stringify({ definition: definition() }),
    });
    expect(res.status).toBe(201);
    expect(res.headers.get("etag")).toBe('"1"');

    const body = (await res.json()) as Envelope<unknown>;
    expect(body.ok).toBe(true);
    const parsed = AgentDraftResponseSchema.parse(body.data);
    draftId = parsed.draft.id;
    agentId = parsed.draft.agentId;
    currentDefinition = parsed.draft.definition;
    expect(parsed.etag).toBe("1");
    expect(parsed.draft.revision).toBe(1);
    expect(parsed.draft.validationStatus).toBe("unvalidated");
    expect(parsed.draft.definition.inputs.map((port) => port.id)).toEqual([
      "prompt",
      "profile",
    ]);
    const defaultWorkflow = getDb()
      .select({ slug: workflows.slug })
      .from(workflows)
      .where(eq(workflows.id, parsed.draft.workflowId))
      .all()[0];
    expect(defaultWorkflow?.slug).toBe(`${TENANT_A}-default`);
  });

  it("creates a new Agent Studio draft inside the requested workflow", async () => {
    const id = `selected-agent-${SUFFIX}`;
    const res = await env.fetch("/v1/agents/drafts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT_A,
      },
      body: JSON.stringify({
        definition: definition({
          id,
          name: `selectedAgent${SUFFIX}`,
          title: "Selected workflow agent",
        }),
        workflowSlug: SELECTED_WORKFLOW,
      }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as Envelope<unknown>;
    const parsed = AgentDraftResponseSchema.parse(body.data);
    expect(parsed.draft.workflowId).toBe(selectedWorkflowId);
    expect(
      getDb()
        .select({ workflowId: agents.workflowId })
        .from(agents)
        .where(eq(agents.id, parsed.draft.agentId))
        .all()[0]?.workflowId,
    ).toBe(selectedWorkflowId);

    const editor = await env.fetch(`/v1/agents/${id}/editor`, {
      headers: { "x-agentic-tenant": TENANT_A },
    });
    expect(editor.status).toBe(200);
    const editorBody = (await editor.json()) as Envelope<unknown>;
    expect(AgentEditorResponseSchema.parse(editorBody.data).draft?.id).toBe(
      parsed.draft.id,
    );
  });

  it("creates and resolves duplicate kebab ids within the requested workflow", async () => {
    const selectedDefinition = definition({
      id: SCOPED_AGENT_ID,
      name: SELECTED_SCOPED_AGENT_NAME,
      title: "Selected shared agent",
    });
    const secondaryDefinition = definition({
      id: SCOPED_AGENT_ID,
      name: SECONDARY_SCOPED_AGENT_NAME,
      title: "Secondary shared agent",
    });

    const selectedCreate = await env.fetch("/v1/agents/drafts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT_A,
      },
      body: JSON.stringify({
        definition: selectedDefinition,
        workflowSlug: SELECTED_WORKFLOW,
        baseWorkflowVersionId: selectedBaseVersionId,
      }),
    });
    expect(selectedCreate.status).toBe(201);
    const selectedCreated = AgentDraftResponseSchema.parse(
      ((await selectedCreate.json()) as Envelope<unknown>).data,
    ).draft;
    selectedScopedAgentId = selectedCreated.agentId;
    expect(selectedCreated.workflowId).toBe(selectedWorkflowId);
    expect(selectedCreated.baseWorkflowVersionId).toBe(selectedBaseVersionId);

    const secondaryCreate = await env.fetch("/v1/agents/drafts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT_A,
      },
      body: JSON.stringify({
        definition: secondaryDefinition,
        workflowSlug: SECONDARY_WORKFLOW,
        baseWorkflowVersionId: secondaryBaseVersionId,
      }),
    });
    expect(secondaryCreate.status).toBe(201);
    const secondaryCreated = AgentDraftResponseSchema.parse(
      ((await secondaryCreate.json()) as Envelope<unknown>).data,
    ).draft;
    secondaryScopedAgentId = secondaryCreated.agentId;
    expect(secondaryCreated.workflowId).toBe(secondaryWorkflowId);
    expect(secondaryCreated.baseWorkflowVersionId).toBe(secondaryBaseVersionId);
    expect(secondaryScopedAgentId).not.toBe(selectedScopedAgentId);

    const selectedHandoff = await env.fetch(
      `/v1/agents/${SCOPED_AGENT_ID}/drafts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": TENANT_A,
        },
        body: JSON.stringify({
          definition: {
            ...selectedDefinition,
            title: "Selected shared agent handoff",
          },
          workflowSlug: SELECTED_WORKFLOW,
          baseWorkflowVersionId: selectedBaseVersionId,
        }),
      },
    );
    expect(selectedHandoff.status).toBe(201);
    expect(
      AgentDraftResponseSchema.parse(
        ((await selectedHandoff.json()) as Envelope<unknown>).data,
      ).draft.agentId,
    ).toBe(selectedScopedAgentId);

    const secondaryHandoff = await env.fetch(
      `/v1/agents/${SCOPED_AGENT_ID}/drafts`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": TENANT_A,
        },
        body: JSON.stringify({
          definition: {
            ...secondaryDefinition,
            title: "Secondary shared agent handoff",
          },
          workflowSlug: SECONDARY_WORKFLOW,
          baseWorkflowVersionId: secondaryBaseVersionId,
        }),
      },
    );
    expect(secondaryHandoff.status).toBe(201);
    const secondaryHandoffDraft = AgentDraftResponseSchema.parse(
      ((await secondaryHandoff.json()) as Envelope<unknown>).data,
    ).draft;
    expect(secondaryHandoffDraft.agentId).toBe(secondaryScopedAgentId);

    const editor = await env.fetch(
      `/v1/agents/${SCOPED_AGENT_ID}/editor?draftId=${secondaryHandoffDraft.id}`,
      { headers: { "x-agentic-tenant": TENANT_A } },
    );
    expect(editor.status).toBe(200);
    const editorResponse = AgentEditorResponseSchema.parse(
      ((await editor.json()) as Envelope<unknown>).data,
    );
    expect(editorResponse.agent.id).toBe(secondaryScopedAgentId);
    expect(editorResponse.draft?.id).toBe(secondaryHandoffDraft.id);

    const mismatchedRef = await env.fetch(
      `/v1/agents/${SELECTED_SCOPED_AGENT_NAME}/editor?draftId=${secondaryHandoffDraft.id}`,
      { headers: { "x-agentic-tenant": TENANT_A } },
    );
    expect(mismatchedRef.status).toBe(404);
  });

  it.each([
    ["an unknown version", `missing-wfv-${SUFFIX}`, "not_found"],
    ["another workflow's version", secondaryBaseVersionId, "workflow_mismatch"],
    ["another tenant's version", foreignBaseVersionId, "not_found"],
    [
      "a version without the selected agent",
      selectedMissingAgentVersionId,
      "agent_mismatch",
    ],
  ])(
    "rejects %s before storing a workflow handoff draft",
    async (_label, baseWorkflowVersionId, reason) => {
      const before = getDb()
        .select({ id: agentDrafts.id })
        .from(agentDrafts)
        .where(eq(agentDrafts.agentId, selectedScopedAgentId))
        .all();
      const res = await env.fetch(`/v1/agents/${SCOPED_AGENT_ID}/drafts`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": TENANT_A,
        },
        body: JSON.stringify({
          definition: definition({
            id: SCOPED_AGENT_ID,
            name: SELECTED_SCOPED_AGENT_NAME,
          }),
          workflowSlug: SELECTED_WORKFLOW,
          baseWorkflowVersionId,
        }),
      });

      expect(res.status).toBe(400);
      const body = (await res.json()) as Envelope<unknown>;
      expect(body.error?.code).toBe("invalid_base_workflow_version");
      expect(body.error?.details).toEqual({
        versionId: baseWorkflowVersionId,
        reason,
      });
      expect(
        getDb()
          .select({ id: agentDrafts.id })
          .from(agentDrafts)
          .where(eq(agentDrafts.agentId, selectedScopedAgentId))
          .all(),
      ).toHaveLength(before.length);
    },
  );

  it("rejects an invalid base version before creating a new agent identity", async () => {
    const id = `invalid-base-agent-${SUFFIX}`;
    const res = await env.fetch("/v1/agents/drafts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT_A,
      },
      body: JSON.stringify({
        definition: definition({
          id,
          name: `invalidBaseAgent${SUFFIX}`,
        }),
        workflowSlug: SELECTED_WORKFLOW,
        baseWorkflowVersionId: secondaryBaseVersionId,
      }),
    });

    expect(res.status).toBe(400);
    expect(((await res.json()) as Envelope<unknown>).error?.code).toBe(
      "invalid_base_workflow_version",
    );
    expect(
      getDb()
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.kebabId, id))
        .all(),
    ).toHaveLength(0);
  });

  it.each([
    ["a missing workflow", `missing-${SUFFIX}`],
    ["another tenant's workflow", FOREIGN_WORKFLOW],
  ])("does not create an agent for %s", async (_label, workflowSlug) => {
    const id = `${workflowSlug}-agent`;
    const res = await env.fetch("/v1/agents/drafts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT_A,
      },
      body: JSON.stringify({
        definition: definition({
          id,
          name: `unavailableWorkflowAgent${workflowSlug.replaceAll("-", "")}`,
        }),
        workflowSlug,
      }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as Envelope<unknown>;
    expect(body.error?.code).toBe("workflow_not_found");
    expect(body.error?.details).toEqual({ workflowSlug });
    expect(
      getDb()
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.kebabId, id))
        .all(),
    ).toHaveLength(0);
  });

  it("keeps the legacy no-workflow draft lookup behavior", async () => {
    const res = await env.fetch(`/v1/agents/${agentId}/drafts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT_A,
      },
      body: "{}",
    });
    expect(res.status).toBe(201);
    expect(
      AgentDraftResponseSchema.parse(
        ((await res.json()) as Envelope<unknown>).data,
      ).draft.id,
    ).toBe(draftId);
  });

  it("returns the draft from the editor while keeping it tenant-scoped", async () => {
    const own = await env.fetch(`/v1/agents/${agentId}/editor`, {
      headers: { "x-agentic-tenant": TENANT_A },
    });
    expect(own.status).toBe(200);
    const ownBody = (await own.json()) as Envelope<unknown>;
    const editor = AgentEditorResponseSchema.parse(ownBody.data);
    expect(editor.draft?.id).toBe(draftId);
    expect(editor.live).toBeNull();
    expect(editor.capabilities).toEqual({
      canEdit: true,
      canRun: true,
      canPublish: true,
    });

    const otherTenant = await env.fetch(`/v1/agent-drafts/${draftId}`, {
      headers: { "x-agentic-tenant": TENANT_B },
    });
    expect(otherTenant.status).toBe(404);
    const otherBody = (await otherTenant.json()) as Envelope<unknown>;
    expect(otherBody.error?.code).toBe("not_found");
  });

  it("requires If-Match and advances the revision atomically", async () => {
    const missingPrecondition = await env.fetch(`/v1/agent-drafts/${draftId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT_A,
      },
      body: JSON.stringify({
        definition: { ...currentDefinition, title: "Updated title" },
      }),
    });
    expect(missingPrecondition.status).toBe(428);

    const updated = await env.fetch(`/v1/agent-drafts/${draftId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT_A,
        "if-match": 'W/"1"',
      },
      body: JSON.stringify({
        definition: { ...currentDefinition, title: "Updated title" },
      }),
    });
    expect(updated.status).toBe(200);
    expect(updated.headers.get("etag")).toBe('"2"');
    const updatedBody = (await updated.json()) as Envelope<unknown>;
    const parsed = AgentDraftResponseSchema.parse(updatedBody.data);
    currentDefinition = parsed.draft.definition;
    expect(parsed.draft.revision).toBe(2);
    expect(parsed.draft.definition.title).toBe("Updated title");

    const identityChange = await env.fetch(`/v1/agent-drafts/${draftId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT_A,
        "if-match": '"2"',
      },
      body: JSON.stringify({
        definition: { ...currentDefinition, id: `different-agent-${SUFFIX}` },
      }),
    });
    expect(identityChange.status).toBe(400);
    const identityBody = (await identityChange.json()) as Envelope<unknown>;
    expect(identityBody.error?.code).toBe("agent_identity_immutable");

    const stale = await env.fetch(`/v1/agent-drafts/${draftId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT_A,
        "if-match": '"1"',
      },
      body: JSON.stringify({
        definition: { ...currentDefinition, title: "Stale overwrite" },
      }),
    });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as Envelope<{
      current: { revision: number };
    }>;
    expect(staleBody.error?.code).toBe("draft_revision_conflict");
    expect(
      (staleBody.error?.details as { current?: { revision?: number } })?.current
        ?.revision,
    ).toBe(2);
  });

  it("runs semantic validation and records the validated hash", async () => {
    const res = await env.fetch(`/v1/agent-drafts/${draftId}/validate`, {
      method: "POST",
      headers: { "x-agentic-tenant": TENANT_A },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<unknown>;
    const parsed = ValidateAgentDraftResponseSchema.parse(body.data);
    expect(parsed.validation.status).toBe("valid");
    expect(parsed.draft.validationStatus).toBe("valid");
    expect(parsed.draft.validatedHash).toBe(parsed.draft.definitionHash);
    expect(parsed.validation.issues).toContainEqual(
      expect.objectContaining({
        path: "/model",
        code: "model_inherited",
        severity: "info",
      }),
    );
  });

  it("marks a changed valid draft stale and reports blocking semantic issues", async () => {
    const unsafeDefinition: AgentDefinitionV2 = {
      ...currentDefinition,
      actions: [],
      outputs: [
        {
          ...currentDefinition.outputs[0]!,
          schema: { $ref: "https://untrusted.example/output-schema.json" },
        },
      ],
    };
    const patch = await env.fetch(`/v1/agent-drafts/${draftId}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT_A,
        "if-match": '"2"',
      },
      body: JSON.stringify({ definition: unsafeDefinition }),
    });
    expect(patch.status).toBe(200);
    const patchBody = (await patch.json()) as Envelope<unknown>;
    const changed = AgentDraftResponseSchema.parse(patchBody.data);
    expect(changed.draft.revision).toBe(3);
    expect(changed.draft.validationStatus).toBe("stale");
    expect(changed.draft.validatedHash).toBeNull();

    const validation = await env.fetch(`/v1/agent-drafts/${draftId}/validate`, {
      method: "POST",
      headers: { "x-agentic-tenant": TENANT_A },
    });
    expect(validation.status).toBe(200);
    const validationBody = (await validation.json()) as Envelope<unknown>;
    const checked = ValidateAgentDraftResponseSchema.parse(validationBody.data);
    expect(checked.validation.status).toBe("invalid");
    expect(checked.validation.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "remote_schema_ref",
          severity: "error",
        }),
        expect.objectContaining({ code: "no_actions", severity: "error" }),
      ]),
    );
  });
});
