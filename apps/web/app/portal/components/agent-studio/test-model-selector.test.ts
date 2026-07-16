import { describe, expect, it } from "vitest";
import {
  CUSTOM_MODEL_OPTION,
  isLikelyChatModelId,
  providerModelIds,
  providerOverrideNeedsModel,
  testModelOptions,
} from "./test-model-selector";

describe("Test Lab provider model selector", () => {
  it("merges live discovery with the provider catalog and removes duplicates", () => {
    const ids = providerModelIds("deepseek", [
      { id: "deepseek-v4-pro" },
      { id: "deepseek-live-preview" },
    ]);

    expect(ids).toContain("deepseek-v4-pro");
    expect(ids).toContain("deepseek-v4-flash");
    expect(ids).toContain("deepseek-live-preview");
    expect(ids.filter((id) => id === "deepseek-v4-pro")).toHaveLength(1);
    expect(ids).not.toContain("openai/gpt-5.6-sol");
  });

  it("filters non-chat models from live discovery", () => {
    const ids = providerModelIds("openai", [
      { id: "gpt-5.4-mini" },
      { id: "text-embedding-3-large" },
      { id: "gpt-image-1" },
      { id: "whisper-1" },
      { id: "omni-moderation-latest" },
    ]);

    expect(ids).toContain("gpt-5.4-mini");
    expect(ids).not.toContain("text-embedding-3-large");
    expect(ids).not.toContain("gpt-image-1");
    expect(ids).not.toContain("whisper-1");
    expect(ids).not.toContain("omni-moderation-latest");
    expect(isLikelyChatModelId("deepseek-chat")).toBe(true);
    expect(isLikelyChatModelId("gemini-embedding-exp")).toBe(false);
  });

  it("keeps an inherited model choice when the provider is inherited", () => {
    const options = testModelOptions({
      providerOverride: "",
      effectiveProvider: "openrouter",
      inheritedModel: "deepseek/deepseek-v4-flash",
      modelIds: ["deepseek/deepseek-v4-flash"],
    });

    expect(options[0]).toEqual({
      value: "",
      label: "Use agent / workspace (deepseek/deepseek-v4-flash)",
    });
    expect(options.at(-1)).toEqual({
      value: CUSTOM_MODEL_OPTION,
      label: "Enter a custom model ID…",
    });
  });

  it("requires an exact model when the provider is overridden", () => {
    const options = testModelOptions({
      providerOverride: "openai",
      effectiveProvider: "openai",
      inheritedModel: "deepseek/deepseek-v4-flash",
      modelIds: ["gpt-5.4-mini"],
    });

    expect(options[0]).toEqual({
      value: "",
      label: "Choose a model from openai",
      disabled: true,
    });
    expect(providerOverrideNeedsModel("openai", "")).toBe(true);
    expect(providerOverrideNeedsModel("openai", "gpt-5.4-mini")).toBe(false);
    expect(providerOverrideNeedsModel("", "")).toBe(false);
  });

  it("supports providers whose model ID must be entered manually", () => {
    expect(providerModelIds("custom")).toEqual([]);
    expect(providerModelIds("bedrock")).toEqual([]);
    expect(providerModelIds("vertex")).toEqual([]);
  });
});
