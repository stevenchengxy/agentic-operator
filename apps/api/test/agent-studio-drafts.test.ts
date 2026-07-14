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
  ValidateAgentDraftResponseSchema,
  type AgentDefinitionV2,
  type AgentDefinitionV2Input,
} from "@agentic/contracts";
import { getDb, tenants } from "@agentic/db";
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

function definition(): AgentDefinitionV2Input {
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

describe("Agent Studio draft routes", () => {
  let env: TestEnv;
  let draftId: string;
  let agentId: string;
  let currentDefinition: AgentDefinitionV2;

  beforeAll(async () => {
    const db = getDb();
    db.insert(tenants)
      .values([
        { id: tenantAId, slug: TENANT_A, name: "Studio test A" },
        { id: tenantBId, slug: TENANT_B, name: "Studio test B" },
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
