/**
 * Focused Agent Studio authoring/execution boundary tests.
 *
 * These cases stay below the Inngest dispatch boundary: semantic checks and
 * runtime helpers are pure, while invalid file uploads are rejected before a
 * run row or event can be queued.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  AgentDraftResponseSchema,
  type AgentDefinitionV2Input,
} from "@agentic/contracts";
import { getDb, tenants } from "@agentic/db";
import {
  AgentInputValidationError,
  createBufferedTraceSink,
  parseValidateAndRepairOutput,
  prepareAgentExecution,
  runAction,
} from "@agentic/runtime";
import { makeId } from "@agentic/shared";
import { validateDefinition } from "../src/services/agent-drafts";
import { buildTestEnv, type TestEnv } from "./harness";

const SUFFIX = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TENANT = `studio-boundary-${SUFFIX}`.slice(0, 32);
const tenantId = makeId("ten");

function humanDefinition(
  overrides: Partial<AgentDefinitionV2Input> = {},
): AgentDefinitionV2Input {
  return {
    id: `human-review-${SUFFIX}`,
    name: `humanReview${SUFFIX}`,
    title: "Human review",
    description: "Collect a structured human decision without invoking an LLM.",
    actor: ["Human"],
    trigger: ["REVIEW_REQUESTED"],
    inputs: [
      {
        id: "review",
        kind: "value",
        required: true,
        schema: {
          type: "object",
          required: ["decision"],
          properties: {
            decision: { type: "string", enum: ["approve", "reject"] },
          },
          additionalProperties: false,
        },
      },
    ],
    actions: [
      {
        id: "request-review",
        order: "1",
        name: "requestReview",
        description: "Request a decision.",
        type: "manual",
      },
    ],
    outputs: [
      {
        id: "result",
        required: true,
        schema: {
          type: "object",
          required: ["accepted"],
          properties: { accepted: { type: "boolean" } },
          additionalProperties: false,
        },
      },
    ],
    triggered_event: ["REVIEW_COMPLETED"],
    ...overrides,
  };
}

function repairDefinition(): AgentDefinitionV2Input {
  return {
    id: `repair-agent-${SUFFIX}`,
    name: `repairAgent${SUFFIX}`,
    title: "Repair agent",
    description: "Exercise configured structured-output repair.",
    actor: ["Agent"],
    trigger: ["RUN"],
    inputs: [
      {
        id: "prompt",
        kind: "prompt",
        required: true,
        schema: { type: "string", minLength: 1 },
      },
    ],
    actions: [
      {
        order: "1",
        name: "produceResult",
        description: "Produce a strict result.",
        type: "logic",
      },
    ],
    outputs: [
      {
        id: "result",
        required: true,
        schema: {
          type: "object",
          required: ["score"],
          properties: { score: { type: "integer", minimum: 0, maximum: 100 } },
          additionalProperties: false,
        },
      },
    ],
    output_config: {
      format: "json",
      strict: true,
      repair_attempts: 2,
      unwrap_single_output: false,
      artifact: {
        filename: "output.json",
        persist_individual_outputs: false,
        persist_run_input: true,
        persist_run_record: true,
        persist_raw_response: false,
      },
    },
    triggered_event: [],
  };
}

describe("Agent Studio semantic and execution boundaries", () => {
  it("reports unknown and backward condition branch targets", () => {
    const checked = validateDefinition(
      humanDefinition({
        actions: [
          {
            id: "collect",
            order: "1",
            name: "collect",
            description: "Collect a decision.",
            type: "manual",
          },
          {
            id: "route",
            order: "2",
            name: "route",
            description: "Route the decision.",
            type: "condition",
            condition: "lastResult.accepted == true",
            true_action_id: "collect",
            false_action_id: "missing-action",
          },
        ],
      }),
    );

    expect(checked.definition).not.toBeNull();
    expect(checked.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "/actions/1/true_action_id",
          code: "condition_backward_target_unsupported",
          severity: "error",
        }),
        expect.objectContaining({
          path: "/actions/1/false_action_id",
          code: "condition_target_unknown",
          severity: "error",
        }),
      ]),
    );
  });

  it("rejects unsafe input and output action mappings before dispatch", async () => {
    const ctx = {
      agentName: "mappingBoundary",
      actionName: "wait",
      correlationId: "cor-mapping-boundary",
      tenantSlug: "test",
      event: { name: "RUN", data: { inputs: {} } },
    };

    await expect(
      runAction({
        ctx,
        action: {
          order: "1",
          name: "wait",
          description: "No-op delay.",
          type: "delay",
          delay_ms: 0,
          input_mapping: { leaked: "$.event.constructor" },
        },
      }),
    ).rejects.toThrow("forbidden path segment 'constructor'");

    await expect(
      runAction({
        ctx,
        action: {
          order: "1",
          name: "wait",
          description: "No-op delay.",
          type: "delay",
          delay_ms: 0,
          output_mapping: { leaked: "$.result.__proto__" },
        },
      }),
    ).rejects.toThrow("forbidden path segment '__proto__'");
  });

  it("validates a human agent without synthesizing an LLM prompt", async () => {
    const trace = createBufferedTraceSink();
    const prepared = await prepareAgentExecution({
      definition: humanDefinition(),
      inputs: { review: { decision: "approve" } },
      trace,
      runId: "run-human-boundary",
    });

    expect(prepared.prompts).toBeNull();
    expect(prepared.inputs).toEqual({ review: { decision: "approve" } });
    expect(trace.events).toContainEqual(
      expect.objectContaining({
        name: "input.validation",
        status: "ok",
        data: { inputIds: ["review"] },
      }),
    );

    await expect(
      prepareAgentExecution({
        definition: humanDefinition(),
        inputs: {
          prompt: "This chat text is not an authored input port.",
          review: { decision: "approve" },
        },
      }),
    ).rejects.toBeInstanceOf(AgentInputValidationError);
  });

  it("uses the configured repair budget and accepts the second repaired output", async () => {
    const attempts: Array<{ attempt: number; maxAttempts: number }> = [];
    const trace = createBufferedTraceSink();
    const result = await parseValidateAndRepairOutput({
      definition: repairDefinition(),
      candidate: "not-json",
      runId: "run-repair-boundary",
      trace,
      repair: async ({ attempt, maxAttempts }) => {
        attempts.push({ attempt, maxAttempts });
        return attempt === 1
          ? JSON.stringify({ result: { score: "still-not-an-integer" } })
          : JSON.stringify({ result: { score: 91 } });
      },
    });

    expect(attempts).toEqual([
      { attempt: 1, maxAttempts: 2 },
      { attempt: 2, maxAttempts: 2 },
    ]);
    expect(result).toMatchObject({
      valid: true,
      repaired: true,
      repairAttempts: 2,
      value: { result: { score: 91 } },
    });
    expect(
      trace.events.filter((event) => event.kind === "output_validation"),
    ).toHaveLength(3);
    expect(trace.events.at(-1)).toMatchObject({
      name: "output.repair.validation",
      status: "ok",
      data: { repairAttempt: 2, valid: true },
    });
  });
});

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

describe("Agent Studio file input policy", () => {
  let env: TestEnv;
  let agentId: string;
  let draftId: string;

  beforeAll(async () => {
    getDb()
      .insert(tenants)
      .values({ id: tenantId, slug: TENANT, name: "Studio boundary tests" })
      .run();
    env = await buildTestEnv();

    const created = await env.fetch("/v1/agents/drafts", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT,
      },
      body: JSON.stringify({
        definition: humanDefinition({
          id: `file-review-${SUFFIX}`,
          name: `fileReview${SUFFIX}`,
          inputs: [
            {
              id: "document",
              kind: "file",
              required: true,
              schema: { type: "object" },
              file: {
                media_types: ["text/plain"],
                max_bytes: 4,
                multiple: false,
              },
            },
          ],
        }),
      }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Envelope<unknown>;
    const draft = AgentDraftResponseSchema.parse(body.data).draft;
    agentId = draft.agentId;
    draftId = draft.id;
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it.each([
    {
      name: "multiple files on a single-file port",
      document: [
        {
          name: "a.txt",
          type: "text/plain",
          dataUrl: "data:text/plain;base64,QQ==",
        },
        {
          name: "b.txt",
          type: "text/plain",
          dataUrl: "data:text/plain;base64,Qg==",
        },
      ],
      code: "file_multiple_forbidden",
    },
    {
      name: "malformed base64",
      document: {
        name: "bad.txt",
        type: "text/plain",
        dataUrl: "data:text/plain;base64,%%%",
      },
      code: "file_data_url_invalid",
    },
    {
      name: "invalid base64 padding",
      document: {
        name: "bad-padding.txt",
        type: "text/plain",
        dataUrl: "data:text/plain;base64,A===",
      },
      code: "file_data_url_invalid",
    },
    {
      name: "a mismatched claimed media type",
      document: {
        name: "claim.pdf",
        type: "application/pdf",
        dataUrl: "data:text/plain;base64,QQ==",
      },
      code: "file_media_type_mismatch",
    },
    {
      name: "a forbidden media type",
      document: {
        name: "pixel.png",
        type: "image/png",
        dataUrl: "data:image/png;base64,QQ==",
      },
      code: "file_media_type_forbidden",
    },
    {
      name: "content over the authored byte limit",
      document: {
        name: "large.txt",
        type: "text/plain",
        dataUrl: "data:text/plain;base64,MTIzNDU=",
      },
      code: "file_too_large",
    },
  ])("rejects $name before queueing a run", async ({ document, code }) => {
    const response = await env.fetch(`/v1/agents/${agentId}/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": TENANT,
      },
      body: JSON.stringify({
        target: { kind: "draft", draftId },
        prompt: "Review the attached document.",
        inputs: { document },
        toolPolicy: "safe",
      }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as Envelope<unknown>;
    expect(body.error?.code).toBe(code);
  });
});
