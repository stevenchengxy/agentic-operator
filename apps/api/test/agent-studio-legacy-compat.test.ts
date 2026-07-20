/**
 * Agent Studio compatibility coverage for identities created before the
 * canonical Agent Definition v2 contract existed.
 *
 * The fixtures deliberately exercise three different persistence shapes:
 * a live workflow with no child agent_version, a historical v1 agent_version
 * with no deployment, and an identity with no versioned definition at all.
 * Code-defined agents are kept separate because their executable behavior
 * cannot be inferred safely from registry metadata.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  AgentDefinitionV2Schema,
  AgentEditorResponseSchema,
  normalizeAgentDefinition,
} from "@agentic/contracts";
import {
  agentDrafts,
  agents,
  agentVersions,
  deployments,
  eventListeners,
  getDb,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  definitionHash,
  validateDefinition,
} from "../src/services/agent-drafts";
import { buildTestEnv, type TestEnv } from "./harness";

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

const SUFFIX = `${Date.now().toString(36)}-${process.pid}`.slice(-16);
const TENANT_SLUG = `legacy-studio-${SUFFIX}`.slice(0, 32);
const tenantId = makeId("ten");

const liveWorkflowId = makeId("wf");
const liveWorkflowVersionId = makeId("wfv");
const liveAgentId = makeId("agt");
const liveKebabId = `legacy-live-${SUFFIX}`.slice(0, 80);
const liveName = `legacyLive${SUFFIX.replace(/-/g, "")}`;

const historicalWorkflowId = makeId("wf");
const historicalWorkflowVersionId = makeId("wfv");
const historicalAgentId = makeId("agt");
const historicalAgentVersionId = makeId("agv");
const historicalKebabId = `legacy-history-${SUFFIX}`.slice(0, 80);
const historicalName = `legacyHistory${SUFFIX.replace(/-/g, "")}`;

const identityWorkflowId = makeId("wf");
const identityAgentId = makeId("agt");
const identityKebabId = `legacy-identity-${SUFFIX}`.slice(0, 80);
const identityName = `legacyIdentity${SUFFIX.replace(/-/g, "")}`;
const identityTrigger = `LEGACY_IDENTITY_${SUFFIX.toUpperCase()}`;

const codeWorkflowId = makeId("wf");
const codeWorkflowVersionId = makeId("wfv");
const codeAgentId = makeId("agt");
const codeAgentVersionId = makeId("agv");
const codeKebabId = `legacy-code-${SUFFIX}`.slice(0, 80);
const codeName = `legacyCode${SUFFIX.replace(/-/g, "")}`;

const legacyLiveDefinition = {
  name: liveName,
  title: "Legacy live agent",
  description: "A live v1 manifest without a child agent version.",
  actor: ["Agent"],
  trigger: ["LEGACY_LIVE_REQUESTED"],
  input_data: { source: "live-v1" },
  system_prompt: "Summarize the supplied workflow payload.",
  action_steps: [
    {
      order: 1,
      name: "summarizePayload",
      object_type: "logic",
      description: "Create the requested summary.",
    },
  ],
  outputs: [{ name: "summary", type: "String", required: true }],
};

const historicalLegacyDefinition = {
  name: historicalName,
  title: "Historical v1 agent",
  description: "Recovered from an immutable historical agent version.",
  actor: "Agent",
  inputs: [
    { name: "question", type: "String", required: true },
    { name: "context", type: "JSON", required: false },
  ],
  system_prompt: "Answer the question using the supplied context.",
  tool_use: ["meta.ping"],
  action_steps: [
    {
      order: 1,
      name: "answerQuestion",
      object_type: "logic",
      description: "Answer accurately and concisely.",
    },
  ],
  outputs: [{ name: "answer", type: "String", required: true }],
};

async function editor(
  env: TestEnv,
  agentRef: string,
): Promise<ReturnType<typeof AgentEditorResponseSchema.parse>> {
  const response = await env.fetch(`/v1/agents/${agentRef}/editor`, {
    headers: { "x-agentic-tenant": TENANT_SLUG },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as Envelope<unknown>;
  expect(body.ok).toBe(true);
  return AgentEditorResponseSchema.parse(body.data);
}

describe("legacy Agent Definition normalization", () => {
  it("converts legacy ports, Human actor strings, and action_steps without mutating the source", () => {
    const source = {
      id: "legacy-human-review",
      name: "legacyHumanReview",
      title: "Legacy human review",
      actor: "Human",
      inputs: [
        { name: "decision", type: "Boolean", required: true },
        { name: "api_token", type: "String", required: false },
      ],
      action_steps: [
        {
          order: 1,
          name: "reviewDecision",
          object_type: "action",
          description: "Review and record the decision.",
        },
      ],
      outputs: [
        { name: "approved", type: "Boolean", required: true },
        { name: "evidence", type: "List<JSON>", required: false },
      ],
      tool_use: ["meta.ping"],
      model: "",
    };
    const before = structuredClone(source);

    const normalized = normalizeAgentDefinition(source);

    expect(source).toEqual(before);
    expect(normalized.actor).toEqual(["Human"]);
    expect(normalized.inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "decision",
          kind: "value",
          schema: { type: "boolean" },
        }),
        expect.objectContaining({
          id: "api_token",
          sensitivity: "secret",
          schema: { type: "string" },
        }),
      ]),
    );
    expect(normalized.actions).toEqual([
      expect.objectContaining({
        order: "1",
        name: "reviewDecision",
        type: "manual",
      }),
    ]);
    expect(normalized.outputs[1]?.schema).toEqual({
      type: "array",
      items: { type: "object" },
    });
    expect(normalized.tool_use).toEqual([
      expect.objectContaining({ name: "meta.ping" }),
    ]);
    expect(normalized.user_prompt_template).toContain(
      "decision: {{json inputs.decision}}",
    );
    expect(normalized.model).toBeUndefined();
    expect(normalized.extensions?.compatibility_mode).toBe("v1");
  });
});

describe("Agent Studio legacy persistence compatibility", () => {
  let env: TestEnv;

  beforeAll(async () => {
    const db = getDb();
    const now = new Date();

    db.insert(tenants)
      .values({
        id: tenantId,
        slug: TENANT_SLUG,
        name: "Agent Studio legacy compatibility",
      })
      .run();

    db.insert(workflows)
      .values([
        {
          id: liveWorkflowId,
          tenantId,
          slug: `live-${SUFFIX}`,
          name: "Legacy live workflow",
        },
        {
          id: historicalWorkflowId,
          tenantId,
          slug: `history-${SUFFIX}`,
          name: "Legacy historical workflow",
        },
        {
          id: identityWorkflowId,
          tenantId,
          slug: `identity-${SUFFIX}`,
          name: "Identity-only workflow",
        },
        {
          id: codeWorkflowId,
          tenantId,
          slug: `code-${SUFFIX}`,
          name: "Code-defined workflow",
        },
      ])
      .run();

    db.insert(workflowVersions)
      .values([
        {
          id: liveWorkflowVersionId,
          workflowId: liveWorkflowId,
          version: "legacy-live-v1",
          manifestJson: [legacyLiveDefinition] as unknown as object,
          actionsJson: null,
        },
        {
          id: historicalWorkflowVersionId,
          workflowId: historicalWorkflowId,
          version: "legacy-history-v1",
          manifestJson: [historicalLegacyDefinition] as unknown as object,
          actionsJson: null,
        },
        {
          id: codeWorkflowVersionId,
          workflowId: codeWorkflowId,
          version: "legacy-code-v1",
          manifestJson: [] as unknown as object,
          actionsJson: null,
        },
      ])
      .run();

    db.insert(agents)
      .values([
        {
          id: liveAgentId,
          tenantId,
          workflowId: liveWorkflowId,
          kebabId: liveKebabId,
          name: liveName,
          title: "Legacy live agent",
          actor: "Agent",
          kind: "manifest",
          enabled: true,
          lifecycle: "active",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: historicalAgentId,
          tenantId,
          workflowId: historicalWorkflowId,
          kebabId: historicalKebabId,
          name: historicalName,
          title: "Historical v1 agent",
          actor: "Agent",
          kind: "manifest",
          enabled: true,
          lifecycle: "active",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: identityAgentId,
          tenantId,
          workflowId: identityWorkflowId,
          kebabId: identityKebabId,
          name: identityName,
          title: "Identity-only agent",
          actor: "Agent",
          kind: "manifest",
          enabled: false,
          lifecycle: "active",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: codeAgentId,
          tenantId,
          workflowId: codeWorkflowId,
          kebabId: codeKebabId,
          name: codeName,
          title: "Legacy code agent",
          actor: "Agent",
          kind: "code",
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
          id: historicalAgentVersionId,
          agentId: historicalAgentId,
          workflowVersionId: historicalWorkflowVersionId,
          manifestJson: historicalLegacyDefinition as unknown as object,
          definitionSchemaVersion: 1,
          contentHash: definitionHash(historicalLegacyDefinition),
          publishedAt: now,
          changeNote: "Legacy historical fixture",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: codeAgentVersionId,
          agentId: codeAgentId,
          workflowVersionId: codeWorkflowVersionId,
          manifestJson: {
            type: "code",
            sha: "legacy-dev",
            name: codeName,
            description: "Metadata for behavior implemented in TypeScript.",
            defaultProvider: "mock",
            defaultModel: "mock-model-v1",
            maxSteps: 3,
          } as unknown as object,
          definitionSchemaVersion: 1,
          publishedAt: now,
          changeNote: "Code registry metadata",
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();

    db.insert(deployments)
      .values([
        {
          id: makeId("dpl"),
          tenantId,
          target: "workflow",
          versionId: liveWorkflowVersionId,
          status: "live",
          note: "Legacy live workflow fixture",
        },
        {
          id: makeId("dpl"),
          tenantId,
          target: "code_agent",
          versionId: codeAgentVersionId,
          status: "live",
          note: "Legacy code agent fixture",
        },
      ])
      .run();

    db.insert(eventListeners)
      .values({ eventName: identityTrigger, agentId: identityAgentId })
      .run();

    env = await buildTestEnv();
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("materializes a true immutable v2 child version for a live v1 workflow exactly once", async () => {
    const first = await editor(env, liveAgentId);
    expect(first.live).not.toBeNull();
    expect(first.draft).toBeNull();
    expect(first.live?.definition).toEqual(
      expect.objectContaining({
        id: liveKebabId,
        name: liveName,
        ontology_instructions: "Summarize the supplied workflow payload.",
      }),
    );
    expect(first.live?.definition.actions).toEqual([
      expect.objectContaining({
        name: "summarizePayload",
        type: "logic",
      }),
    ]);

    const rowsAfterFirstRead = getDb()
      .select()
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.agentId, liveAgentId),
          eq(agentVersions.workflowVersionId, liveWorkflowVersionId),
        ),
      )
      .all();
    expect(rowsAfterFirstRead).toHaveLength(1);
    expect(rowsAfterFirstRead[0]?.definitionSchemaVersion).toBe(2);
    const persisted = AgentDefinitionV2Schema.parse(
      rowsAfterFirstRead[0]?.manifestJson,
    );
    expect(persisted.id).toBe(liveKebabId);
    expect(rowsAfterFirstRead[0]?.contentHash).toBe(definitionHash(persisted));

    const second = await editor(env, liveKebabId);
    expect(second.live?.agentVersionId).toBe(first.live?.agentVersionId);
    expect(
      getDb()
        .select()
        .from(agentVersions)
        .where(
          and(
            eq(agentVersions.agentId, liveAgentId),
            eq(agentVersions.workflowVersionId, liveWorkflowVersionId),
          ),
        )
        .all(),
    ).toHaveLength(1);
  });

  it("opens a normalized draft from immutable historical v1 data and reuses it", async () => {
    const first = await editor(env, historicalAgentId);
    expect(first.live).toBeNull();
    expect(first.draft).not.toBeNull();
    expect(first.draft?.baseAgentVersionId).toBe(historicalAgentVersionId);
    expect(first.draft?.baseWorkflowVersionId).toBe(
      historicalWorkflowVersionId,
    );
    expect(first.draft?.definition).toEqual(
      expect.objectContaining({
        id: historicalKebabId,
        name: historicalName,
        ontology_instructions:
          "Answer the question using the supplied context.",
      }),
    );
    expect(first.draft?.definition.inputs.map((port) => port.id)).toEqual([
      "prompt",
      "question",
      "context",
    ]);
    expect(first.draft?.definition.tool_use).toEqual([
      expect.objectContaining({ name: "meta.ping" }),
    ]);
    expect(first.draft?.definition.extensions?.compatibility_source).toBe(
      "historical-agent-version",
    );

    // Compatibility reads must not rewrite a history-pinned v1 version.
    const historicalRow = getDb()
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.id, historicalAgentVersionId))
      .all()[0]!;
    expect(historicalRow.definitionSchemaVersion).toBe(1);
    expect(historicalRow.manifestJson).toEqual(historicalLegacyDefinition);

    const second = await editor(env, historicalKebabId);
    expect(second.draft?.id).toBe(first.draft?.id);
    expect(
      getDb()
        .select()
        .from(agentDrafts)
        .where(eq(agentDrafts.agentId, historicalAgentId))
        .all(),
    ).toHaveLength(1);
  });

  it("generates a complete valid draft from identity metadata and listeners", async () => {
    const result = await editor(env, identityAgentId);
    expect(result.live).toBeNull();
    expect(result.draft).not.toBeNull();
    expect(result.capabilities).toEqual({
      canEdit: true,
      canRun: true,
      canPublish: true,
    });

    const definition = result.draft!.definition;
    expect(definition).toEqual(
      expect.objectContaining({
        id: identityKebabId,
        name: identityName,
        generated: true,
        trigger: [identityTrigger],
      }),
    );
    expect(definition.actions).toEqual([
      expect.objectContaining({ type: "logic" }),
    ]);
    expect(definition.outputs).toEqual([
      expect.objectContaining({ id: "result" }),
    ]);
    expect(definition.extensions).toEqual(
      expect.objectContaining({
        compatibility_mode: "generated",
        compatibility_source: "agent-identity",
      }),
    );
    expect(
      validateDefinition(definition).issues.filter(
        (issue) => issue.severity === "error",
      ),
    ).toEqual([]);

    const repeat = await editor(env, identityKebabId);
    expect(repeat.draft?.id).toBe(result.draft?.id);
    expect(
      getDb()
        .select()
        .from(agentDrafts)
        .where(eq(agentDrafts.agentId, identityAgentId))
        .all(),
    ).toHaveLength(1);
  });

  it("keeps partial legacy metadata while generating its missing execution step", async () => {
    const workflowId = makeId("wf");
    const workflowVersionId = makeId("wfv");
    const agentId = makeId("agt");
    const agentVersionId = makeId("agv");
    const kebabId = `legacy-partial-${SUFFIX}`.slice(0, 80);
    const name = `legacyPartial${SUFFIX.replace(/-/g, "")}`;
    const now = new Date();
    const db = getDb();
    db.insert(workflows)
      .values({
        id: workflowId,
        tenantId,
        slug: `partial-${SUFFIX}`,
        name: "Partial legacy workflow",
      })
      .run();
    db.insert(workflowVersions)
      .values({
        id: workflowVersionId,
        workflowId,
        version: "legacy-partial-v1",
        manifestJson: [] as unknown as object,
        actionsJson: null,
      })
      .run();
    db.insert(agents)
      .values({
        id: agentId,
        tenantId,
        workflowId,
        kebabId,
        name,
        title: "Partial legacy agent",
        actor: "Agent",
        kind: "manifest",
        enabled: false,
        lifecycle: "active",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(agentVersions)
      .values({
        id: agentVersionId,
        agentId,
        workflowVersionId,
        manifestJson: {
          name,
          description: "Preserve this older description.",
          actor: "Agent",
          inputs: [{ name: "case_id", type: "String", required: true }],
          outputs: [{ name: "decision", type: "String", required: true }],
        } as unknown as object,
        definitionSchemaVersion: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const result = await editor(env, agentId);
    const definition = result.draft!.definition;
    expect(definition.description).toBe("Preserve this older description.");
    expect(definition.inputs.map((port) => port.id)).toContain("case_id");
    expect(definition.outputs.map((port) => port.id)).toContain("decision");
    expect(definition.actions).toEqual([
      expect.objectContaining({ type: "logic", name: "completeRequest" }),
    ]);
    expect(definition.extensions?.compatibility_generated_fields).toEqual([
      "actions",
    ]);
    expect(
      validateDefinition(definition).issues.filter(
        (issue) => issue.severity === "error",
      ),
    ).toEqual([]);
  });

  it("keeps code-defined agents read-only instead of silently converting them", async () => {
    const result = await editor(env, codeAgentId);
    expect(result.agent.kind).toBe("code");
    expect(result.live?.agentVersionId).toBe(codeAgentVersionId);
    expect(result.live?.definition.extensions).toEqual(
      expect.objectContaining({
        compatibility_mode: "code",
        compatibility_source: "code-agent-metadata",
      }),
    );
    expect(result.live?.definition.provider).toBe("mock");
    expect(result.live?.definition.model).toBe("mock-model-v1");
    expect(result.draft).toBeNull();
    expect(result.capabilities).toEqual({
      canEdit: false,
      canRun: false,
      canPublish: false,
    });
    expect(
      getDb()
        .select()
        .from(agentDrafts)
        .where(eq(agentDrafts.agentId, codeAgentId))
        .all(),
    ).toHaveLength(0);

    const response = await env.fetch(`/v1/agents/${codeAgentId}/drafts`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT_SLUG,
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as Envelope<unknown>;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe("agent_not_editable");
    expect(body.error?.details).toEqual({ reason: "code_agent" });
  });
});
