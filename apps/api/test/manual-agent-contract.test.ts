import { describe, expect, it } from "vitest";
import {
  buildManualTaskResolution,
  validateValueAgainstJsonSchema,
} from "@agentic/runtime";
import { buildAgentArchetypeRuntime } from "../src/services/agent-archetypes";

describe("strict hybrid manual output contract", () => {
  it("accepts both the normal Deep Search result and a terminal rejection", () => {
    const blueprint = buildAgentArchetypeRuntime({
      template: "rag",
      retries: 2,
      timeoutS: 300,
      steps: [
        {
          id: "research",
          name: "researchEvidence",
          description: "Prepare the evidence-backed report.",
          type: "logic",
        },
        {
          id: "approval",
          name: "approveResearch",
          description: "Wait for publication approval.",
          type: "manual",
        },
      ],
    });
    expect(blueprint.outputConfig.strict).toBe(true);
    const schema = blueprint.outputs[0]!.schema;

    expect(
      validateValueAgainstJsonSchema(
        schema,
        {
          answer: "Evidence-backed answer.",
          executive_summary: "Summary.",
          findings: [],
          citations: [],
          limitations: [],
        },
        "/output",
        "output_schema",
      ),
    ).toEqual([]);

    const rejection = buildManualTaskResolution({
      taskId: "tsk-research-42",
      decision: "reject",
      payload: { rationale: "Citation coverage is insufficient." },
    });
    expect(
      validateValueAgainstJsonSchema(
        schema,
        rejection,
        "/output",
        "output_schema",
      ),
    ).toEqual([]);
    expect(
      validateValueAgainstJsonSchema(
        schema,
        { ...rejection, outcome: "approved" },
        "/output",
        "output_schema",
      ).length,
    ).toBeGreaterThan(0);
  });
});
