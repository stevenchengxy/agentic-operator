/**
 * TC-95 — Generated agents (Agent Factory / deploy wizard) are runnable WITHOUT a
 * hand-written tenant prompt package.
 *
 * The factory generates agents into an isolated sandbox tenant (and the deploy
 * wizard persists edited prompts) with no `@tenants/<slug>` package. Their
 * reasoning lives in `ontology_instructions` (system prompt); the runtime
 * supplies the default USER turn via `makeGeneratedAgentPrompt` in
 * `packages/runtime/src/generated-agent.ts`. These tests pin the merged prompt
 * contract and the runtime seam:
 *   - the default user turn carries the action name, action objective, trigger
 *     event name, JSON payload, previous-result block, and the bilingual
 *     (EN + 中文) guidance lines,
 *   - agent-level provider/model selections flow to the gateway request,
 *   - explicitly selected GLOBAL registry tools resolve by bare name,
 *   - provider-invented tool calls outside the manifest allow-list are rejected,
 *   - hand-authored tenants keep STRICT missing-prompt behaviour,
 *   - findMissingTenantPrompts exempts only generated agents.
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
  it("uses the edited system prompt, runtime event context, selected model, and declared tools", async () => {
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

    // The MERGED makeGeneratedAgentPrompt user turn: action line + objective +
    // trigger name + payload JSON + previous-result block + bilingual guidance.
    expect(user?.content).toEqual(
      expect.stringContaining('Execute the workflow action "runtimeResearcherExecute".'),
    );
    expect(user?.content).toEqual(
      expect.stringContaining(
        "Action objective: Research and assess the agentic runtime architecture.",
      ),
    );
    expect(user?.content).toEqual(
      expect.stringContaining("Trigger event: ARCHITECTURE_RESEARCH_REQUESTED"),
    );
    expect(user?.content).toEqual(
      expect.stringContaining("Incoming event payload / 触发事件数据:"),
    );
    expect(user?.content).toEqual(expect.stringContaining('"requestId": "req-42"'));
    expect(user?.content).toEqual(
      expect.stringContaining('"topic": "agentic runtime durability"'),
    );
    expect(user?.content).toEqual(expect.stringContaining("Previous action result:"));
    expect(user?.content).toEqual(expect.stringContaining('"sourceCount": 3'));
    expect(user?.content).toEqual(
      expect.stringContaining(
        "Follow the system prompt exactly. Use an available tool only when it is necessary",
      ),
    );
    expect(user?.content).toEqual(
      expect.stringContaining("按你的系统指令处理本次事件：需要数据或执行动作时调用可用工具，完成后给出结论。"),
    );
  });

  it("renders '(none)' for a missing previous result and resolves GLOBAL registry tools by bare name", async () => {
    const result = await runAction({
      ctx: {
        agentName: "genA",
        actionName: "processResume",
        correlationId: "cor-generated-none",
        tenantSlug: "acme-sb",
        event: { name: "RESUME_UPLOADED", data: { resume_id: "r-1", subject: "REQ-9" } },
        lastResult: null,
      },
      action: {
        order: "1",
        name: "processResume",
        description: "process the resume",
        type: "logic",
      },
      // generated:true, NO tenantRegistry.prompts — and the tool is referenced
      // by bare name only, so it must resolve from globalToolRegistry.
      agent: {
        name: "genA",
        generated: true,
        ontology_instructions: "You process resumes per the rules.",
        tool_use: [{ name: "ontology.fetchActionRules" }],
      },
      tenantRegistry: {},
    });

    expect(result.ok).toBe(true);
    expect(captured).toHaveLength(1);
    const request = captured[0]!;

    const advertised = (request.tools ?? []).map((tool) => tool.name);
    expect(advertised).toContain("ontology.fetchActionRules");

    const system = request.messages.find((message) => message.role === "system");
    expect(system?.content).toEqual(
      expect.stringContaining("You process resumes per the rules."),
    );

    const user = request.messages.find((message) => message.role === "user");
    expect(user?.content).toEqual(expect.stringContaining("resume_id"));
    expect(user?.content).toEqual(
      expect.stringContaining('Execute the workflow action "processResume".'),
    );
    // lastResult null → the previous-result block renders the literal "(none)".
    expect(user?.content).toEqual(expect.stringContaining("Previous action result:"));
    expect(user?.content).toEqual(expect.stringContaining("(none)"));
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

    // Generated agents fail the WHOLE loop when the model invents an
    // undeclared tool call — the factory trust boundary is agent.tool_use[],
    // and a fail-closed terminal error beats letting the model self-correct
    // its way around the immutable manifest. (Hand-authored legacy agents get
    // the softer per-call is_error gate instead.)
    expect(result.ok).toBe(false);
    expect(maliciousRequests[0]?.tools).toBeUndefined();
    expect(String(result.meta?.message)).toContain(
      "generated_tool_not_declared",
    );
    expect(String(result.meta?.message)).toContain("meta.ping");
    // Fail-closed means no second turn: the loop terminates instead of
    // feeding the model a tool_result to retry against.
    expect(maliciousRequests.length).toBe(1);
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
