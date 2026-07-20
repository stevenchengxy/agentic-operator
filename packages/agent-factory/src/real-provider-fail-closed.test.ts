import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrainCtx } from "./brain-types";
import type { DomainOntology } from "./ontology-types";
import { FACTORY_TOOLS, parsePlanCritiquePayload } from "./tools";

const webSearch = FACTORY_TOOLS.find((tool) => tool.name === "web_search")!;
const critiquePlan = FACTORY_TOOLS.find((tool) => tool.name === "critique_plan")!;

function webCtx(web?: BrainCtx["ports"]["web"]): BrainCtx {
  return {
    ports: web ? { web } : {},
    research: [],
    emit: () => {},
  } as unknown as BrainCtx;
}

function critiqueCtx(): BrainCtx {
  const actions = [
    {
      id: "create-jd",
      name: "createJD",
      actor: ["Agent"],
      trigger: ["START"],
      triggered_event: ["DONE"],
      target_objects: [],
      tool_use: [],
      system_prompt: "",
      user_prompt: "",
    },
  ];
  return {
    domain: "rec",
    ontology: {
      domainId: "rec",
      objects: [],
      rules: [],
      events: [],
      workflow: [],
      source: "snapshot",
      actions,
    } as unknown as DomainOntology,
    currentPlan: {
      version: 1,
      summary: "plan",
      agents: [
        {
          actionName: "createJD",
          role: "builder",
          triggerEvents: ["START"],
          emitEvents: ["DONE"],
          toolCandidates: [],
        },
      ],
    },
    specs: [],
    emit: () => {},
    ports: {},
  } as unknown as BrainCtx;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("real provider failures are never represented as empty success", () => {
  it("web_search returns ok:false when no provider is wired", async () => {
    const result = await webSearch.execute({ query: "Inngest cron" }, webCtx());
    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({
      results: [],
      failure: "web_search_provider_not_configured",
    });
  });

  it("web_search exposes provider failure instead of returning zero results", async () => {
    const result = await webSearch.execute(
      { query: "Inngest cron" },
      webCtx({ search: async () => { throw new Error("provider unavailable"); } }),
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("provider unavailable");
    expect(result.output).toMatchObject({
      results: [],
      failure: "web_search_provider_failed",
    });
  });

  it("critique_plan blocks when the real LLM gateway is not configured", async () => {
    vi.stubEnv("FACTORY_GATEWAY_API_KEY", "");
    vi.stubEnv("CUSTOM_LLM_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const result = await critiquePlan.execute({}, critiqueCtx());
    expect(result.ok).toBe(false);
    expect(result.output).toMatchObject({
      verdict: "blocked",
      failure: "llm_gateway_not_configured",
    });
  });

  it("rejects malformed or incomplete LLM critique JSON", () => {
    expect(parsePlanCritiquePayload(null).ok).toBe(false);
    expect(parsePlanCritiquePayload({ verdict: "ok", issues: "none" }).ok).toBe(false);
    expect(
      parsePlanCritiquePayload({
        verdict: "ok",
        issues: [{ severity: "high", problem: "missing fix" }],
      }).ok,
    ).toBe(false);
    expect(parsePlanCritiquePayload({ verdict: "ok", issues: [] })).toEqual({
      ok: true,
      verdict: "ok",
      issues: [],
    });
  });
});
