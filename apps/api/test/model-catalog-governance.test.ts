import { describe, expect, it } from "vitest";
import {
  catalogModelPolicy,
  defaultModelFor,
  groupCatalogModelsByTier,
  isFreeTierModel,
  PROVIDER_MODEL_CATALOG,
  selectableModelsForProvider,
} from "@agentic/contracts";
import { assertModelSelectable } from "@agentic/llm-gateway";

const AS_OF = new Date("2026-07-18T23:59:59.999Z");

describe("model catalog lifecycle governance", () => {
  it("keeps the exact rolling 365-day boundary and excludes one day older", () => {
    expect(
      catalogModelPolicy({ releaseDate: "2025-07-18" }, AS_OF),
    ).toMatchObject({ status: "current", selectable: true });
    expect(
      catalogModelPolicy({ releaseDate: "2025-07-17" }, AS_OF),
    ).toMatchObject({
      status: "legacy",
      selectable: false,
      reason: "older_than_365_days",
    });
  });

  it("uses catalog creation only as conservative age evidence", () => {
    expect(
      catalogModelPolicy(
        { providerCatalogCreatedAt: "2025-07-17T23:59:59Z" },
        AS_OF,
      ),
    ).toMatchObject({
      status: "legacy",
      selectable: false,
      ageEvidenceDate: "2025-07-17T23:59:59Z",
    });
    expect(catalogModelPolicy({}, AS_OF)).toMatchObject({
      status: "unverified",
      selectable: true,
    });
    expect(
      catalogModelPolicy(
        { providerCatalogCreatedAt: "2026-07-17T23:59:59Z" },
        AS_OF,
      ),
    ).toMatchObject({ status: "unverified", selectable: true });
  });

  it("lets access restrictions and lifecycle deadlines override model age", () => {
    expect(
      catalogModelPolicy(
        { releaseDate: "2026-07-18", restricted: true },
        AS_OF,
      ),
    ).toMatchObject({ selectable: false, reason: "restricted" });
    expect(
      catalogModelPolicy(
        { releaseDate: "2026-07-18", expiresAt: "2026-07-18T12:00:00Z" },
        AS_OF,
      ),
    ).toMatchObject({
      status: "legacy",
      selectable: false,
      reason: "expired",
    });
  });

  it("retains legacy rows for history but excludes them from new selection", () => {
    expect(
      PROVIDER_MODEL_CATALOG.anthropic.some(
        (model) => model.name === "claude-opus-4",
      ),
    ).toBe(true);
    expect(
      selectableModelsForProvider("anthropic", AS_OF).some(
        (model) => model.name === "claude-opus-4",
      ),
    ).toBe(false);
    expect(
      selectableModelsForProvider("anthropic", AS_OF).some(
        (model) => model.name === "claude-mythos-5",
      ),
    ).toBe(false);
  });

  it("blocks catalog-known legacy models at the gateway boundary", () => {
    expect(() =>
      assertModelSelectable("anthropic", "claude-opus-4"),
    ).toThrow(/older_than_365_days/);
    expect(() =>
      assertModelSelectable("openai", "gpt-5.6-terra"),
    ).not.toThrow();
    expect(() =>
      assertModelSelectable("custom", "private/latest-model"),
    ).not.toThrow();
  });

  it("groups only genuine zero-price rows into Free-Tier", () => {
    const free = [
      ...PROVIDER_MODEL_CATALOG.openrouter,
      ...PROVIDER_MODEL_CATALOG.zai,
    ].filter(isFreeTierModel);
    expect(free.map((model) => model.name)).toEqual(
      expect.arrayContaining([
        "openrouter/free",
        "glm-4.7-flash",
        "glm-4.5-flash",
        "glm-4.6v-flash",
      ]),
    );
    expect(
      PROVIDER_MODEL_CATALOG.zai.find((model) => model.name === "glm-5.2")
        ?.tier,
    ).toBe("top");
    expect(
      groupCatalogModelsByTier(PROVIDER_MODEL_CATALOG.zai).free.map(
        (model) => model.name,
      ),
    ).toEqual(
      expect.arrayContaining([
        "glm-4.7-flash",
        "glm-4.5-flash",
        "glm-4.6v-flash",
      ]),
    );
  });

  it("selects the current Moonshot flagship as the default", () => {
    expect(defaultModelFor("moonshot")).toBe("kimi-k3");
  });

  it("keeps every selectable model from the reviewed providers billable", () => {
    const reviewedProviders = [
      "openai",
      "anthropic",
      "openrouter",
      "moonshot",
      "zai",
      "deepseek",
    ] as const;

    for (const provider of reviewedProviders) {
      for (const model of selectableModelsForProvider(provider, AS_OF)) {
        expect(model.priceSource, `${provider}/${model.name}`).toMatch(
          /^https:/,
        );
        expect(model.priceAsOf, `${provider}/${model.name}`).toMatch(
          /^\d{4}-\d{2}-\d{2}$/,
        );
        expect(
          model.pricing?.length,
          `${provider}/${model.name}`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
