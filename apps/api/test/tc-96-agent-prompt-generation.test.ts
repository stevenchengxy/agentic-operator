/**
 * TC-96 — LLM-backed system-prompt generation for the deploy wizard.
 *
 * Uses the real gateway and deterministic MockAdapter. This verifies that
 * the service sends the user's description/specification to the model and
 * returns a comprehensive, editable prompt instead of canned UI text.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GenerateAgentPromptBody } from "@agentic/contracts";
import { LLMGateway, MockAdapter } from "@agentic/llm-gateway";
import { generateAgentSystemPrompt } from "../src/services/agent-authoring";
import { _setLLMGatewayForTests } from "../src/services/llm";

beforeEach(() => {
  const gateway = new LLMGateway({
    defaultProvider: "mock",
    defaultModel: "mock-model-v1",
    timeoutMs: 5_000,
  });
  gateway.registerProvider(new MockAdapter());
  _setLLMGatewayForTests(gateway);
});

afterEach(() => {
  _setLLMGatewayForTests(null);
});

describe("TC-96: generated system prompt", () => {
  it("turns the supplied description and workflow context into a comprehensive prompt", async () => {
    const input = GenerateAgentPromptBody.parse({
      name: "runtimeArchitectureResearcher",
      title: "Runtime Architecture Researcher",
      description:
        "Research the agentic runtime architecture, compare durability and tenant isolation trade-offs, and produce an evidence-backed recommendation for the platform team.",
      actor: "Agent",
      template: "rag",
      stage: 2,
      triggers: ["ARCHITECTURE_RESEARCH_REQUESTED"],
      emits: ["ARCHITECTURE_RESEARCH_COMPLETED"],
      tools: [
        {
          name: "meta.ping",
          description: "Verify the live tenant and event context.",
          input_schema: { type: "object", additionalProperties: false },
        },
      ],
      provider: "mock",
      model: "mock-model-authoring-v2",
    });

    const result = await generateAgentSystemPrompt(input, {
      // Budget accounting is orthogonal to this unit seam. An empty internal
      // id intentionally disables the gateway's optional budget hook, keeping
      // the test read-only with respect to the shared SQLite fixture.
      tenantId: "",
      tenantSlug: "raas",
    });

    expect(result.provider).toBe("mock");
    expect(result.model).toBe("mock-model-authoring-v2");
    expect(result.tokensIn).toBeGreaterThan(0);
    expect(result.tokensOut).toBeGreaterThan(0);

    expect(result.systemPrompt).toContain("# Role");
    expect(result.systemPrompt).toContain("# Mission");
    expect(result.systemPrompt).toContain("# Inputs");
    expect(result.systemPrompt).toContain("# Operating procedure");
    expect(result.systemPrompt).toContain("# Tool policy");
    expect(result.systemPrompt).toContain("# Guardrails");
    expect(result.systemPrompt).toContain("# Errors and human review");
    expect(result.systemPrompt).toContain("Runtime Architecture Researcher");
    expect(result.systemPrompt).toContain(
      "Research the agentic runtime architecture, compare durability and tenant isolation trade-offs",
    );
    expect(result.systemPrompt).toContain("ARCHITECTURE_RESEARCH_REQUESTED");
    expect(result.systemPrompt).toContain("ARCHITECTURE_RESEARCH_COMPLETED");
    expect(result.systemPrompt).toContain("meta.ping");
    expect(result.systemPrompt).toContain(
      "Verify the live tenant and event context",
    );
    expect(result.systemPrompt).toContain("tenant raas");
    expect(result.systemPrompt).toContain("event_type");
    expect(result.systemPrompt).toContain("prompt");
    expect(result.systemPrompt).toContain(
      "never require them to wrap a request in event JSON",
    );
  });
});
