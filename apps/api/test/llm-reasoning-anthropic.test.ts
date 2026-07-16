import { describe, expect, it } from "vitest";
import { mapAnthropicRequestReasoning } from "../../../packages/llm-gateway/src/adapters/anthropic";

describe("Anthropic reasoning request mapping", () => {
  it("does not change the wire request when reasoning is omitted", () => {
    expect(mapAnthropicRequestReasoning("claude-opus-4-8", undefined)).toEqual({});
  });

  it("maps supported effort to adaptive thinking and output_config", () => {
    expect(
      mapAnthropicRequestReasoning("claude-opus-4-8", {
        effort: "xhigh",
      }),
    ).toEqual({
      thinking: { type: "adaptive" },
      output_config: { effort: "xhigh" },
    });
  });

  it("maps none according to each model's default thinking behavior", () => {
    expect(
      mapAnthropicRequestReasoning("claude-opus-4-8", { effort: "none" }),
    ).toEqual({});
    expect(
      mapAnthropicRequestReasoning("claude-sonnet-5", { effort: "none" }),
    ).toEqual({ thinking: { type: "disabled" } });
  });

  it("rejects none for always-thinking Fable and Mythos models", () => {
    expect(() =>
      mapAnthropicRequestReasoning("claude-fable-5", { effort: "none" }),
    ).toThrow(/always uses adaptive thinking/);
    expect(() =>
      mapAnthropicRequestReasoning("claude-mythos-5", { effort: "none" }),
    ).toThrow(/always uses adaptive thinking/);
  });

  it("rejects unsupported provider-neutral mode and effort values clearly", () => {
    expect(() =>
      mapAnthropicRequestReasoning("claude-opus-4-8", { mode: "pro" }),
    ).toThrow(/does not expose reasoning mode "pro"/);
    expect(() =>
      mapAnthropicRequestReasoning("claude-opus-4-8", { effort: "minimal" }),
    ).toThrow(/does not support reasoning effort "minimal"/);
  });

  it("enforces Anthropic's model-specific xhigh support", () => {
    expect(() =>
      mapAnthropicRequestReasoning("claude-sonnet-4-6", { effort: "xhigh" }),
    ).toThrow(/effort "xhigh" is not supported/);
  });
});
