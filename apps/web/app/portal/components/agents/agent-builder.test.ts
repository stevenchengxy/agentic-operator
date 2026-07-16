import { describe, expect, it } from "vitest";
import type { FleetEntry } from "@/lib/hooks/useModelFleet";
import {
  AGENT_BUILDER_TEMPLATES,
  deepSearchStepsForMode,
  defaultStepModels,
  recommendFleetModel,
} from "./agent-builder";

function fleetEntry(
  id: string,
  modelName: string,
  role: FleetEntry["role"] = "fallback",
): FleetEntry {
  return {
    id,
    tenantSlug: "test",
    provider: "openai",
    modelName,
    alias: "",
    role,
    dailyCapUsd: 10,
    maxOutTokens: 4_096,
    temperature: 0.2,
    addedAt: 0,
    addedBy: null,
  };
}

describe("New Agent builder archetypes", () => {
  it("ships six complete event-driven patterns including Deep Search", () => {
    expect(AGENT_BUILDER_TEMPLATES).toHaveLength(6);
    expect(AGENT_BUILDER_TEMPLATES.map((item) => item.name)).toContain(
      "Deep Search",
    );
    for (const template of AGENT_BUILDER_TEMPLATES) {
      expect(template.suggestedTrigger).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(template.suggestedEmit).toMatch(/^[A-Z][A-Z0-9_]*$/);
      expect(template.steps.length).toBeGreaterThan(0);
      expect(template.safeguards.length).toBeGreaterThan(0);
    }
  });

  it("starts every execution step by inheriting the agent model", () => {
    for (const template of AGENT_BUILDER_TEMPLATES) {
      expect(defaultStepModels(template)).toEqual(
        template.steps.map((step) => ({
          ...step,
          modelOverride: "inherit",
        })),
      );
    }
  });

  it("expands Deep Research into a bounded, reviewable research lifecycle", () => {
    const deepSearch = AGENT_BUILDER_TEMPLATES.find(
      (item) => item.id === "rag",
    )!;
    const answer = deepSearchStepsForMode(deepSearch, "answer");
    const investigate = deepSearchStepsForMode(deepSearch, "investigate");
    const deepResearch = deepSearchStepsForMode(deepSearch, "deep_research");

    expect(answer).toHaveLength(2);
    expect(investigate).toHaveLength(3);
    expect(deepResearch.map((step) => step.id)).toEqual([
      "clarify",
      "approve-plan",
      "research-workstreams",
      "gap-check",
      "verify-citations",
      "synthesize",
    ]);
    expect(
      deepResearch.find((step) => step.id === "approve-plan")?.execution,
    ).toBe("human");
  });

  it("prefers a fast model for classification", () => {
    const classifier = AGENT_BUILDER_TEMPLATES.find(
      (item) => item.id === "classify",
    )!;
    const result = recommendFleetModel(
      [
        fleetEntry("primary", "gpt-5", "primary"),
        fleetEntry("fast", "gpt-5-mini"),
      ],
      classifier,
      "Route high volume requests with low latency",
    );
    expect(result?.id).toBe("fast");
  });

  it("prefers a reasoning model for deep research", () => {
    const deepSearch = AGENT_BUILDER_TEMPLATES.find(
      (item) => item.id === "rag",
    )!;
    const result = recommendFleetModel(
      [
        fleetEntry("fast", "gpt-5-mini", "primary"),
        fleetEntry("reasoning", "o3"),
      ],
      deepSearch,
      "Investigate a complex topic and synthesize conflicting evidence",
    );
    expect(result?.id).toBe("reasoning");
  });
});
