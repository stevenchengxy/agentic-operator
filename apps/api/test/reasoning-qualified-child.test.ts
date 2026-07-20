import { describe, expect, it } from "vitest";
import { isVerifiedQualifiedReasoningChild } from "../src/routes/v1/reasoning-agent";

describe("Reasoning QualifiedAgent child verification", () => {
  it("does not infer a QualifiedAgent role from parentRunId alone", () => {
    expect(
      isVerifiedQualifiedReasoningChild({
        childRunId: "run-child",
        parentRunId: "run-parent",
        steps: [{ input: { agent: "reasoningAgent" } }],
      }),
    ).toBe(false);
  });

  it("accepts the runtimeRole input artifact while the parent is live", () => {
    expect(
      isVerifiedQualifiedReasoningChild({
        childRunId: "run-child",
        parentRunId: "run-parent",
        steps: [
          {
            input: {
              agent: "reasoningAgent",
              runtimeRole: "qualified",
              parentRunId: "run-parent",
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it("accepts only the child named by the persisted final receipt", () => {
    const persistedOutput = {
      audit: {
        qualityCheck: {
          agent: "QualifiedAgent",
          executionMode: "isolated-child-run",
          run: {
            role: "qualified",
            executionMode: "isolated-child-run",
            runId: "run-qualified",
            parentRunId: "run-parent",
          },
        },
      },
    };
    expect(
      isVerifiedQualifiedReasoningChild({
        childRunId: "run-qualified",
        parentRunId: "run-parent",
        steps: [],
        persistedOutput,
      }),
    ).toBe(true);
    expect(
      isVerifiedQualifiedReasoningChild({
        childRunId: "run-other",
        parentRunId: "run-parent",
        steps: [
          {
            input: {
              agent: "reasoningAgent",
              runtimeRole: "qualified",
              parentRunId: "run-parent",
            },
          },
        ],
        persistedOutput,
      }),
    ).toBe(false);
  });
});
