import { describe, expect, it } from "vitest";
import {
  generationFingerprint,
  parseGenerationLines,
} from "./NewWorkflowModal";

describe("workflow generation proposal identity", () => {
  const base = {
    purpose: "Review customer requests and produce an approved decision.",
    documentFolder: "policies",
    webResearch: false,
    provider: "openai" as const,
    model: "gpt-4.1",
    constraints: ["Keep data in-region"],
    expectedOutputs: ["Decision record"],
  };

  it("changes when any generation input changes", () => {
    const original = generationFingerprint(base);
    const variants = [
      { ...base, purpose: `${base.purpose} Include audit evidence.` },
      { ...base, documentFolder: "new-policies" },
      { ...base, webResearch: true },
      { ...base, provider: "anthropic" as const },
      { ...base, model: "claude-sonnet-4-5" },
      { ...base, constraints: [...base.constraints, "Human approval"] },
      { ...base, expectedOutputs: [...base.expectedOutputs, "Audit log"] },
    ];
    for (const variant of variants) {
      expect(generationFingerprint(variant)).not.toBe(original);
    }
  });

  it("normalizes editable constraint/output lines", () => {
    expect(
      parseGenerationLines("- First rule\n\n* Second rule\n Third rule "),
    ).toEqual(["First rule", "Second rule", "Third rule"]);
  });
});
