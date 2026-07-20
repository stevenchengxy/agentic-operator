import { describe, expect, it } from "vitest";
import {
  GatewayInstanceSchema,
  LlmSettingsSchema,
  ModelRouteIdSchema,
  TaskRouteCandidateSchema,
  behavioralProviderForCandidate,
  catalogModelForCandidate,
  formatModelRouteId,
  parseModelRouteId,
  resolveLlmRouting,
} from "../src/index";

const settings = LlmSettingsSchema.parse({
  schemaVersion: 1,
  revision: 12,
  gatewayInstances: [
    {
      id: "openai",
      displayName: "OpenAI",
      kind: "direct",
      providerId: "openai",
    },
    {
      id: "openrouter",
      displayName: "OpenRouter",
      kind: "openrouter",
    },
    {
      id: "newapi-csi",
      displayName: "CSI NewAPI",
      kind: "newapi",
      baseUrl: "https://newapi.example.test/v1",
      dialect: "moonshot",
    },
  ],
  defaultProfile: {
    candidates: [{ route: "openai/gpt-5.6-terra" }],
  },
  taskProfiles: [
    {
      taskClass: "ontology.generate",
      workload: "quality",
      parameters: { reasoning: { effort: "high" } },
      candidates: [
        {
          route: "openrouter/openai/gpt-5.6-sol",
          modelFamily: "openai.gpt",
          parameters: { timeoutMs: 180_000 },
        },
      ],
    },
    {
      taskClass: "assistant.suggest",
      candidates: [{ route: "newapi-csi/moonshotai/kimi-k3" }],
    },
  ],
});

describe("canonical LLM model route grammar", () => {
  it("splits only the first slash and preserves the provider-native model id", () => {
    expect(parseModelRouteId("openrouter/openai/gpt-5.6-sol")).toEqual({
      id: "openrouter/openai/gpt-5.6-sol",
      gatewayInstanceId: "openrouter",
      modelId: "openai/gpt-5.6-sol",
    });
    expect(formatModelRouteId("newapi-csi", "moonshotai/kimi-k3")).toBe(
      "newapi-csi/moonshotai/kimi-k3",
    );
    expect(parseModelRouteId("newapi/kimi-k3")).toEqual({
      id: "newapi/kimi-k3",
      gatewayInstanceId: "newapi",
      modelId: "kimi-k3",
    });
    expect(formatModelRouteId("newapi", "kimi-k3")).toBe("newapi/kimi-k3");
  });

  it.each([
    "openrouter",
    "/openai/gpt-5.6-sol",
    "OpenRouter/openai/gpt-5.6-sol",
    "newapi-csi//kimi-k3",
    "newapi-csi/../kimi-k3",
    "newapi-csi/moonshotai/kimi k3",
  ])("rejects unsafe or ambiguous route %s", (route) => {
    expect(ModelRouteIdSchema.safeParse(route).success).toBe(false);
  });

  it("keeps compatible-gateway dialect explicit and settings secret-free", () => {
    expect(
      settings.gatewayInstances.find((gateway) => gateway.id === "newapi-csi")
        ?.dialect,
    ).toBe("moonshot");
    expect(
      GatewayInstanceSchema.safeParse({
        id: "newapi-csi",
        displayName: "CSI NewAPI",
        kind: "newapi",
        baseUrl: "https://newapi.example.test/v1",
        apiKey: "must-not-be-stored-here",
      }).success,
    ).toBe(false);
  });

  it("centralizes dotted model-family and namespaced NewAPI behavior hints", () => {
    const gateway = GatewayInstanceSchema.parse({
      id: "newapi-csi",
      displayName: "CSI NewAPI",
      kind: "newapi",
      baseUrl: "https://newapi.example.test/v1",
    });
    const kimi = TaskRouteCandidateSchema.parse({
      route: "newapi-csi/moonshotai/kimi-k3",
      modelFamily: "moonshot.kimi",
    });
    const glm = TaskRouteCandidateSchema.parse({
      route: "newapi-csi/z-ai/glm-5.2",
      modelFamily: "zhipu.glm",
    });

    expect(behavioralProviderForCandidate(gateway, kimi)).toBe("moonshot");
    expect(catalogModelForCandidate(gateway, kimi)?.name).toBe("kimi-k3");
    expect(behavioralProviderForCandidate(gateway, glm)).toBe("zai");
    expect(catalogModelForCandidate(gateway, glm)?.name).toBe("glm-5.2");
    expect(
      behavioralProviderForCandidate(
        gateway,
        TaskRouteCandidateSchema.parse({
          route: "newapi-csi/moonshotai/kimi-k3",
        }),
      ),
    ).toBe("moonshot");

    const canonicalGateway = GatewayInstanceSchema.parse({
      id: "newapi",
      displayName: "NewAPI",
      kind: "newapi",
      baseUrl: "https://newapi.example.test/v1",
    });
    const canonicalKimi = TaskRouteCandidateSchema.parse({
      route: "newapi/kimi-k3",
    });
    expect(
      behavioralProviderForCandidate(canonicalGateway, canonicalKimi),
    ).toBe("moonshot");
    expect(
      catalogModelForCandidate(canonicalGateway, canonicalKimi),
    ).toMatchObject({
      name: "kimi-k3",
      ctx: 1_048_576,
      out: 1_048_576,
      temperatureRange: null,
    });
  });

  it("accepts Kimi K3's documented maximum completion-token limit", () => {
    const parsed = LlmSettingsSchema.parse({
      ...settings,
      defaultProfile: {
        ...settings.defaultProfile,
        parameters: { maxTokens: 1_048_576 },
      },
    });
    expect(parsed.defaultProfile.parameters?.maxTokens).toBe(1_048_576);
  });
});

describe("deterministic task-to-model resolution", () => {
  it("selects an explicit route before an exact task profile", () => {
    const result = resolveLlmRouting(settings, {
      taskClass: "ontology.generate",
      explicitRoute: "openai/gpt-5.6-terra",
    });

    expect(result.matchType).toBe("explicit");
    expect(result.selectedCandidate.route).toBe("openai/gpt-5.6-terra");
    expect(result.trace.at(-1)?.stage).toBe("explicit");
  });

  it("selects the exact profile and merges profile and candidate controls", () => {
    const result = resolveLlmRouting(settings, {
      taskClass: "ontology.generate",
    });

    expect(result.matchType).toBe("exact");
    expect(result.matchedTaskClass).toBe("ontology.generate");
    expect(result.selectedCandidate.route).toBe(
      "openrouter/openai/gpt-5.6-sol",
    );
    expect(result.selectedCandidate.modelFamily).toBe("openai.gpt");
    expect(result.effectiveParameters).toEqual({
      reasoning: { effort: "high" },
      timeoutMs: 180_000,
    });
  });

  it("resolves aliases before walking the parent chain", () => {
    const result = resolveLlmRouting(settings, {
      taskClass: "ai.suggestion",
    });

    expect(result.matchType).toBe("alias");
    expect(result.matchedTaskClass).toBe("assistant.suggest");
    expect(result.selectedCandidate.route).toBe(
      "newapi-csi/moonshotai/kimi-k3",
    );
  });

  it("selects the nearest configured parent profile", () => {
    const result = resolveLlmRouting(settings, {
      taskClass: "ontogene.generate.schema",
    });

    expect(result.matchType).toBe("parent");
    expect(result.matchedTaskClass).toBe("ontology.generate");
    expect(result.selectedCandidate.route).toBe(
      "openrouter/openai/gpt-5.6-sol",
    );
  });

  it("falls back to the default profile with an auditable trace", () => {
    const result = resolveLlmRouting(settings, {
      taskClass: "customer.unmapped.task",
    });

    expect(result.matchType).toBe("default");
    expect(result.matchedTaskClass).toBeNull();
    expect(result.selectedCandidate.route).toBe("openai/gpt-5.6-terra");
    expect(result.trace.at(-1)).toMatchObject({
      stage: "default",
      outcome: "selected",
    });
  });

  it("skips a catalog-known candidate that cannot satisfy task capabilities", () => {
    const capabilitySettings = LlmSettingsSchema.parse({
      schemaVersion: 1,
      revision: 3,
      gatewayInstances: [
        {
          id: "zai",
          displayName: "Z.AI",
          kind: "direct",
          providerId: "zai",
        },
        {
          id: "openai",
          displayName: "OpenAI",
          kind: "direct",
          providerId: "openai",
        },
      ],
      defaultProfile: {
        requirements: { vision: true },
        candidates: [
          { route: "zai/glm-5.2" },
          { route: "openai/gpt-5.6-terra" },
        ],
      },
    });

    const result = resolveLlmRouting(capabilitySettings, {
      taskClass: "default",
    });
    expect(result.selectedCandidate.route).toBe("openai/gpt-5.6-terra");
    expect(result.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "candidate",
          outcome: "skipped",
          route: "zai/glm-5.2",
          message: expect.stringMatching(/vision capability/i),
        }),
      ]),
    );
  });

  it("uses the exact Kimi K3 context boundary for NewAPI routing", () => {
    const contextSettings = (minimumContextTokens: number) =>
      LlmSettingsSchema.parse({
        schemaVersion: 1,
        revision: 3,
        gatewayInstances: [
          {
            id: "newapi",
            displayName: "NewAPI",
            kind: "newapi",
            baseUrl: "https://newapi.example.test/v1",
          },
          {
            id: "openai",
            displayName: "OpenAI",
            kind: "direct",
            providerId: "openai",
          },
        ],
        defaultProfile: {
          requirements: { minimumContextTokens },
          candidates: [
            { route: "newapi/kimi-k3" },
            { route: "openai/gpt-5.6-terra" },
          ],
        },
      });

    expect(
      resolveLlmRouting(contextSettings(1_048_576), {
        taskClass: "default",
      }).selectedCandidate.route,
    ).toBe("newapi/kimi-k3");

    const aboveMaximum = resolveLlmRouting(contextSettings(1_048_577), {
      taskClass: "default",
    });
    expect(aboveMaximum.selectedCandidate.route).toBe("openai/gpt-5.6-terra");
    expect(aboveMaximum.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          route: "newapi/kimi-k3",
          outcome: "skipped",
          message: expect.stringMatching(/context window 1048576/i),
        }),
      ]),
    );
  });

  it("skips catalog-known routes outside the selectable lifecycle policy", () => {
    const governedSettings = LlmSettingsSchema.parse({
      schemaVersion: 1,
      revision: 4,
      gatewayInstances: [
        {
          id: "anthropic",
          displayName: "Anthropic",
          kind: "direct",
          providerId: "anthropic",
        },
        {
          id: "openai",
          displayName: "OpenAI",
          kind: "direct",
          providerId: "openai",
        },
      ],
      defaultProfile: {
        candidates: [
          { route: "anthropic/claude-opus-4" },
          { route: "openai/gpt-5.6-terra" },
        ],
      },
    });

    const result = resolveLlmRouting(governedSettings, {
      taskClass: "default",
    });
    expect(result.selectedCandidate.route).toBe("openai/gpt-5.6-terra");
    expect(result.trace).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "candidate",
          outcome: "skipped",
          route: "anthropic/claude-opus-4",
          message: expect.stringMatching(/older_than_365_days/),
        }),
      ]),
    );
    expect(() =>
      resolveLlmRouting(governedSettings, {
        taskClass: "default",
        explicitRoute: "anthropic/claude-opus-4",
      }),
    ).toThrow(/older_than_365_days/);
  });

  it("rejects settings that reference an unconfigured gateway instance", () => {
    expect(() =>
      LlmSettingsSchema.parse({
        schemaVersion: 1,
        revision: 0,
        gatewayInstances: [
          {
            id: "openai",
            displayName: "OpenAI",
            kind: "direct",
            providerId: "openai",
          },
        ],
        defaultProfile: {
          candidates: [{ route: "missing/vendor/model" }],
        },
      }),
    ).toThrow(/unknown gateway instance/i);
  });
});
