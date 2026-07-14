/**
 * TC-95 — deploy-wizard generated agents execute without tenant TypeScript.
 *
 * The wizard persists the edited system prompt in ontology_instructions and
 * marks the manifest entry `generated: true`. These tests exercise the exact
 * runtime seam used after hot-load, without writing a workflow fixture.
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type {
  ChatRequest,
  ChatResponse,
  LLMGateway,
} from "@agentic/llm-gateway";
import {
  findMissingTenantPrompts,
  getRuntimeGateway,
  runAction,
  setRuntimeGateway,
  WorkflowManifestSchema,
} from "@agentic/runtime";

const priorGateway = getRuntimeGateway();
let captured: ChatRequest[] = [];

const captureGateway = {
  chat: async (request: ChatRequest): Promise<ChatResponse> => {
    captured.push(request);
    return {
      text: "generated agent completed",
      provider: request.provider ?? "mock",
      model: request.model ?? "captured-default",
      tokensIn: 21,
      tokensOut: 7,
      finishReason: "stop",
      latencyMs: 1,
    };
  },
} as unknown as LLMGateway;

beforeEach(() => {
  captured = [];
  setRuntimeGateway(captureGateway);
});

afterAll(() => {
  // Preserve a gateway installed by an earlier test file when Vitest reuses
  // this fork. When none existed, leaving the deterministic capture gateway
  // installed is harmless because this is the final runtime-focused suite.
  if (priorGateway) setRuntimeGateway(priorGateway);
});

describe("TC-95: generated manifest agents", () => {
  it("uses the edited system prompt, runtime event context, selected model, and global tools", async () => {
    const editedPrompt = [
      "You are the Production Architecture Researcher.",
      "Compare the supplied runtime architecture against tenant-safe durability requirements.",
      "Never invent evidence; identify gaps and request human review for consequential ambiguity.",
    ].join("\n");

    const result = await runAction({
      ctx: {
        agentName: "runtimeResearcher",
        actionName: "runtimeResearcherExecute",
        subject: "research-42",
        correlationId: "cor-generated-42",
        tenantSlug: "raas",
        event: {
          name: "ARCHITECTURE_RESEARCH_REQUESTED",
          data: {
            requestId: "req-42",
            topic: "agentic runtime durability",
            constraints: ["tenant isolation", "replay safety"],
          },
        },
        lastResult: { sourceCount: 3, evidenceReady: true },
      },
      action: {
        order: "1",
        name: "runtimeResearcherExecute",
        description: "Research and assess the agentic runtime architecture.",
        type: "logic",
      },
      agent: {
        name: "runtimeResearcher",
        description: "Research the architecture for the agentic runtime.",
        ontology_instructions: editedPrompt,
        generated: true,
        provider: "openai",
        model: "gpt-5.2-research",
        tool_use: [
          {
            name: "meta.ping",
            description: "Verify live runtime context before producing the assessment.",
            input_schema: { type: "object", additionalProperties: false },
          },
        ],
      },
      // No tenant prompt or tenant tool is supplied: generated agents must
      // use the generic user turn and resolve explicitly selected global
      // tools from @agentic/tools.
      tenantRegistry: {},
    });

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);

    const request = captured[0]!;
    expect(request.provider).toBe("openai");
    expect(request.model).toBe("gpt-5.2-research");
    expect(request.tools).toEqual([
      expect.objectContaining({
        name: "meta.ping",
        description: expect.stringContaining("Verify live runtime context"),
        input_schema: { type: "object", additionalProperties: false },
      }),
    ]);

    const system = request.messages.find((message) => message.role === "system");
    const user = request.messages.find((message) => message.role === "user");
    expect(system?.content).toEqual(expect.stringContaining(editedPrompt));
    expect(user?.content).toEqual(
      expect.stringContaining("ARCHITECTURE_RESEARCH_REQUESTED"),
    );
    expect(user?.content).toEqual(expect.stringContaining('"requestId": "req-42"'));
    expect(user?.content).toEqual(
      expect.stringContaining('"topic": "agentic runtime durability"'),
    );
    expect(user?.content).toEqual(expect.stringContaining('"sourceCount": 3'));
  });

  it("preserves strict missing-prompt behavior for non-generated agents", async () => {
    const result = await runAction({
      ctx: {
        agentName: "handAuthoredAgent",
        actionName: "handAuthoredExecute",
        correlationId: "cor-strict-1",
        tenantSlug: "raas",
        event: { name: "WORK_REQUESTED", data: { id: "work-1" } },
      },
      action: {
        order: "1",
        name: "handAuthoredExecute",
        description: "This requires a tenant definePrompt.",
        type: "logic",
      },
      agent: {
        name: "handAuthoredAgent",
        description: "A hand-authored agent.",
      },
      tenantRegistry: {},
    });

    expect(result.ok).toBe(false);
    expect(result.meta).toEqual(
      expect.objectContaining({
        error: "missing_tenant_prompt",
        actionName: "handAuthoredExecute",
      }),
    );
    expect(captured).toHaveLength(0);
  });

  it("rejects provider-invented tool calls outside the manifest allow-list", async () => {
    const maliciousRequests: ChatRequest[] = [];
    setRuntimeGateway({
      chat: async (request: ChatRequest): Promise<ChatResponse> => {
        maliciousRequests.push(request);
        if (maliciousRequests.length === 1) {
          return {
            text: "",
            provider: "mock",
            model: "mock-model-v1",
            tokensIn: 4,
            tokensOut: 2,
            finishReason: "tool_calls",
            latencyMs: 1,
            toolCalls: [
              { id: "invented-1", name: "meta.ping", input: {} },
            ],
          };
        }
        return {
          text: "Stopped after the rejected tool call.",
          provider: "mock",
          model: "mock-model-v1",
          tokensIn: 7,
          tokensOut: 3,
          finishReason: "stop",
          latencyMs: 1,
        };
      },
    } as unknown as LLMGateway);

    const result = await runAction({
      ctx: {
        agentName: "allowListAgent",
        actionName: "allowListAgentExecute",
        correlationId: "cor-allow-list-1",
        tenantSlug: "raas",
        event: { name: "WORK_REQUESTED", data: { id: "work-1" } },
      },
      action: {
        order: "1",
        name: "allowListAgentExecute",
        description: "Complete work without tools.",
        type: "logic",
      },
      agent: {
        name: "allowListAgent",
        description: "A generated agent with no tool access.",
        ontology_instructions: "Never call a tool; use supplied context only.",
        generated: true,
        tool_use: [],
      },
      tenantRegistry: {},
    });

    expect(result.ok).toBe(true);
    expect(maliciousRequests[0]?.tools).toBeUndefined();
    expect(result.meta?.toolCalls).toEqual([
      expect.objectContaining({
        name: "meta.ping",
        isError: true,
        output: null,
      }),
    ]);
    const toolResultTurn = maliciousRequests[1]?.messages.find(
      (message) => message.role === "tool",
    );
    expect(JSON.stringify(toolResultTurn?.content)).toContain(
      "not declared in this agent's tool_use allow-list",
    );
  });

  it("missing-prompt validation exempts only generated manifest agents", () => {
    const manifest = WorkflowManifestSchema.parse([
      {
        id: "2-generated-researcher",
        name: "generatedResearcher",
        title: "Generated Researcher",
        description: "Generated through the deployment wizard.",
        actor: ["Agent"],
        trigger: ["RESEARCH_REQUESTED"],
        actions: [
          {
            order: "1",
            name: "generatedResearcherExecute",
            description: "Research the request.",
            type: "logic",
          },
        ],
        triggered_event: ["RESEARCH_COMPLETED"],
        ontology_instructions: "A complete authored prompt lives here.",
        generated: true,
      },
      {
        id: "3-hand-authored-reviewer",
        name: "handAuthoredReviewer",
        title: "Hand-authored Reviewer",
        description: "Requires a tenant prompt implementation.",
        actor: ["Agent"],
        trigger: ["REVIEW_REQUESTED"],
        actions: [
          {
            order: "1",
            name: "handAuthoredReview",
            description: "Review the result.",
            type: "logic",
          },
        ],
        triggered_event: ["REVIEW_COMPLETED"],
      },
    ]);

    expect(findMissingTenantPrompts({ manifest, tenantRegistry: {} })).toEqual([
      {
        agentName: "handAuthoredReviewer",
        actionName: "handAuthoredReview",
        description: "Review the result.",
      },
    ]);
  });
});
