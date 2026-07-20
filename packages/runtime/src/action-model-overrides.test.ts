import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import type {
  ChatRequest,
  ChatResponse,
  LLMGateway,
} from "@agentic/llm-gateway";
import { TaskClassIdSchema } from "@agentic/contracts";
import { getRuntimeGateway, setRuntimeGateway } from "./llm-host";
import { runAction } from "./step-engine";

const previousGateway = getRuntimeGateway();
let request: ChatRequest | undefined;

const gateway = {
  async chat(input: ChatRequest): Promise<ChatResponse> {
    request = structuredClone(input);
    return {
      text: "step completed",
      provider: input.provider ?? "mock",
      model: input.model ?? "unknown",
      tokensIn: 3,
      tokensOut: 2,
      finishReason: "stop",
      latencyMs: 1,
    };
  },
} as unknown as LLMGateway;

beforeEach(() => {
  request = undefined;
  setRuntimeGateway(gateway);
});

after(() => {
  if (previousGateway) setRuntimeGateway(previousGateway);
});

describe("action-level model controls", () => {
  it("overrides provider/model/runtime controls without mutating the agent defaults", async () => {
    const agent = {
      id: "model-routing-agent",
      name: "modelRoutingAgent",
      description: "Exercise per-step model routing.",
      actor: ["Agent"] as Array<"Agent" | "Human">,
      trigger: ["RUN"],
      actions: [],
      triggered_event: ["DONE"],
      generated: true,
      ontology_instructions: "Complete the step.",
      tool_use: [],
      provider: "mock" as const,
      model: "agent-default",
      task_class: "chat",
      temperature: 0.7,
      max_tokens: 1000,
    };
    const result = await runAction({
      ctx: {
        agentName: agent.name,
        actionName: "reasoningStep",
        correlationId: "cor-action-model",
        tenantSlug: "test",
        event: { name: "test/RUN", data: { prompt: "Run the step." } },
      },
      action: {
        order: "1",
        name: "reasoningStep",
        description: "Use the action-specific model.",
        type: "logic",
        provider: "openai",
        model: "gpt-step-model",
        task_class: TaskClassIdSchema.parse("evaluation"),
        reasoning: { effort: "high" },
        verbosity: "low",
        store: false,
        temperature: 0.1,
        max_tokens: 222,
      },
      agent,
    });

    assert.equal(result.ok, true);
    assert.equal(request?.provider, "openai");
    assert.equal(request?.model, "gpt-step-model");
    assert.equal(request?.routing?.taskType, "evaluation");
    assert.deepEqual(request?.reasoning, { effort: "high" });
    assert.equal(request?.verbosity, "low");
    assert.equal(request?.store, false);
    assert.equal(request?.temperature, 0.1);
    assert.equal(request?.maxTokens, 222);
    assert.equal(agent.provider, "mock");
    assert.equal(agent.model, "agent-default");
    assert.equal(agent.task_class, "chat");
  });
});
