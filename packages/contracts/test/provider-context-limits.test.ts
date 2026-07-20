import { describe, expect, it } from "vitest";
import { PROVIDER_MODEL_CATALOG, type ProviderId } from "../src/index";

type ExpectedLimit = readonly [
  provider: ProviderId,
  model: string,
  context: number,
  maxOutput: number | null,
];

const VERIFIED_LIMITS: ExpectedLimit[] = [
  ["openai", "gpt-5.6-sol", 1_050_000, 128_000],
  ["openai", "gpt-5.6-terra", 1_050_000, 128_000],
  ["openai", "gpt-5.6-luna", 1_050_000, 128_000],
  ["openai", "gpt-5.4-mini", 400_000, 128_000],

  ["anthropic", "claude-fable-5", 1_000_000, 128_000],
  ["anthropic", "claude-mythos-5", 1_000_000, 128_000],
  ["anthropic", "claude-opus-4-8", 1_000_000, 128_000],
  ["anthropic", "claude-sonnet-5", 1_000_000, 128_000],
  ["anthropic", "claude-haiku-4-5", 200_000, 64_000],
  ["anthropic", "claude-sonnet-4-5", 200_000, 64_000],
  ["anthropic", "claude-opus-4", 200_000, 32_000],

  ["moonshot", "kimi-k3", 1_048_576, 1_048_576],
  ["moonshot", "kimi-k2.7-code", 262_144, null],
  ["moonshot", "kimi-k2.7-code-highspeed", 262_144, null],
  ["moonshot", "kimi-k2.6", 262_144, null],

  ["zai", "glm-5.2", 1_000_000, 131_072],
  ["zai", "glm-5.1", 204_800, 131_072],
  ["zai", "glm-5", 204_800, 131_072],
  ["zai", "glm-5-turbo", 204_800, 131_072],
  ["zai", "glm-4.7", 204_800, 131_072],
  ["zai", "glm-4.7-flashx", 204_800, 131_072],
  ["zai", "glm-4.5-air", 131_072, 98_304],
  ["zai", "glm-4.7-flash", 204_800, 131_072],
  ["zai", "glm-4.5-flash", 131_072, 98_304],
  ["zai", "glm-4.6v-flash", 131_072, 32_768],

  ["deepseek", "deepseek-v4-pro", 1_048_576, 384_000],
  ["deepseek", "deepseek-v4-flash", 1_048_576, 384_000],

  ["openrouter", "openai/gpt-5.6-sol", 1_050_000, 128_000],
  ["openrouter", "openai/gpt-5.6-sol-pro", 1_050_000, 128_000],
  ["openrouter", "openai/gpt-5.6-terra", 1_050_000, 128_000],
  ["openrouter", "openai/gpt-5.6-terra-pro", 1_050_000, 128_000],
  ["openrouter", "openai/gpt-5.6-luna", 1_050_000, 128_000],
  ["openrouter", "openai/gpt-5.6-luna-pro", 1_050_000, 128_000],
  ["openrouter", "openai/gpt-oss-120b", 131_072, 65_536],
  ["openrouter", "google/gemini-3.1-pro-preview", 1_048_576, 65_536],
  ["openrouter", "anthropic/claude-sonnet-5", 1_000_000, 128_000],
  ["openrouter", "anthropic/claude-fable-5", 1_000_000, 128_000],
  ["openrouter", "anthropic/claude-opus-4.8", 1_000_000, 128_000],
  ["openrouter", "anthropic/claude-opus-4.8-fast", 1_000_000, 128_000],
  ["openrouter", "moonshotai/kimi-k3", 1_048_576, null],
  ["openrouter", "moonshotai/kimi-k2.7-code", 262_144, 262_144],
  ["openrouter", "moonshotai/kimi-k2.6", 262_144, 262_144],
  ["openrouter", "z-ai/glm-5.2", 1_048_576, 131_072],
  ["openrouter", "deepseek/deepseek-v4-pro", 1_048_576, 384_000],
  ["openrouter", "deepseek/deepseek-v4-flash", 1_048_576, null],
  ["openrouter", "openrouter/free", 200_000, null],
  ["openrouter", "nvidia/nemotron-3-ultra-550b-a55b:free", 1_048_576, 65_536],
];

describe("provider-specific context and output limits", () => {
  it.each(VERIFIED_LIMITS)(
    "%s/%s advertises its verified route-specific maximums",
    (provider, modelName, context, maxOutput) => {
      const model = PROVIDER_MODEL_CATALOG[provider].find(
        (candidate) => candidate.name === modelName,
      );
      expect(
        model,
        `missing catalog model ${provider}/${modelName}`,
      ).toBeDefined();
      expect(model).toMatchObject({ ctx: context, out: maxOutput });
    },
  );

  it("keeps every catalog limit internally valid", () => {
    for (const [provider, models] of Object.entries(PROVIDER_MODEL_CATALOG)) {
      for (const model of models) {
        expect(
          Number.isInteger(model.ctx),
          `${provider}/${model.name} ctx`,
        ).toBe(true);
        expect(model.ctx, `${provider}/${model.name} ctx`).toBeGreaterThan(0);
        if (model.out !== null) {
          expect(
            Number.isInteger(model.out),
            `${provider}/${model.name} out`,
          ).toBe(true);
          expect(model.out, `${provider}/${model.name} out`).toBeGreaterThan(0);
          expect(
            model.out,
            `${provider}/${model.name} out`,
          ).toBeLessThanOrEqual(model.ctx);
        }
      }
    }
  });
});
