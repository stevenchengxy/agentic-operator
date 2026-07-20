import { describe, expect, it } from "vitest";
import {
  isCurrentPromptRequest,
  promptRequestFingerprint,
} from "./prompt-generation-guard";

describe("prompt generation request guard", () => {
  it("accepts only the latest request for the current source fields", () => {
    const fingerprint = promptRequestFingerprint({
      name: "researchAgent",
      triggers: ["RESEARCH_REQUESTED"],
      emits: ["RESEARCH_COMPLETED"],
    });

    expect(
      isCurrentPromptRequest({
        requestId: 2,
        latestRequestId: 2,
        requestFingerprint: fingerprint,
        currentFingerprint: fingerprint,
      }),
    ).toBe(true);
  });

  it("rejects an older request even when its fields match", () => {
    const fingerprint = promptRequestFingerprint({ name: "researchAgent" });

    expect(
      isCurrentPromptRequest({
        requestId: 1,
        latestRequestId: 2,
        requestFingerprint: fingerprint,
        currentFingerprint: fingerprint,
      }),
    ).toBe(false);
  });

  it("rejects a result after the source fields change", () => {
    expect(
      isCurrentPromptRequest({
        requestId: 1,
        latestRequestId: 1,
        requestFingerprint: promptRequestFingerprint({
          emits: ["RESEARCH_COMPLETED"],
        }),
        currentFingerprint: promptRequestFingerprint({
          emits: ["RESEARCH_REVIEWED"],
        }),
      }),
    ).toBe(false);
  });
});
