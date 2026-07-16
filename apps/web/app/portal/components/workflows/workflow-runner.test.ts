import { describe, expect, it } from "vitest";
import {
  buildWorkflowEventPayload,
  deriveWorkflowEntrypoints,
  parseWorkflowTestLimits,
  seedWorkflowInputValue,
  validateWorkflowInputValues,
  workflowInputControl,
} from "./workflow-runner";

const promptPort = {
  id: "prompt",
  label: "Request",
  kind: "prompt" as const,
  required: true,
  schema: { type: "string", minLength: 1 },
  sensitivity: "none" as const,
};

function agent(
  id: string,
  trigger: string[],
  emitted: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    id,
    name: id,
    title: id,
    description: "Test agent",
    actor: ["Agent"],
    trigger,
    inputs: [promptPort],
    ontology_instructions:
      "Role mission inputs procedure tool policy output contract completion criteria safety privacy non-fabrication error recovery human escalation.",
    generated: true,
    tool_use: [],
    actions: [
      {
        order: "1",
        name: "execute",
        description: "Execute",
        type: "logic",
      },
    ],
    outputs: [
      {
        id: "result",
        required: true,
        schema: { type: "string" },
        sensitivity: "none",
      },
    ],
    triggered_event: emitted,
    provider: "mock",
    model: "mock-model-v1",
    ...overrides,
  };
}

describe("workflow Run Console model", () => {
  it("recommends external triggers and retains internal branch entrypoints", () => {
    const result = deriveWorkflowEntrypoints({
      $schemaVersion: 2,
      agents: [
        agent("intake", ["CASE_OPENED"], ["CASE_TRIAGED"]),
        agent("triage", ["CASE_TRIAGED"], ["CASE_DONE"]),
      ],
    });

    expect(result.entrypoints.map((entrypoint) => entrypoint.event)).toEqual([
      "CASE_OPENED",
      "CASE_TRIAGED",
    ]);
    expect(result.entrypoints[0]).toMatchObject({
      source: "external",
      recommended: true,
      listenerAgentIds: ["intake"],
    });
    expect(result.entrypoints[1]).toMatchObject({
      source: "internal",
      recommended: false,
    });
  });

  it("merges shared inputs and identifies conflicting listener contracts", () => {
    const result = deriveWorkflowEntrypoints({
      $schemaVersion: 2,
      agents: [
        agent("alpha", ["START"], [], {
          inputs: [promptPort],
        }),
        agent("beta", ["START"], [], {
          inputs: [
            {
              ...promptPort,
              schema: { type: "string", maxLength: 10 },
            },
          ],
        }),
      ],
    });

    expect(result.entrypoints[0]?.inputs[0]).toMatchObject({
      id: "prompt",
      consumers: ["alpha", "beta"],
      conflict: true,
    });
    expect(
      validateWorkflowInputValues(result.entrypoints[0], {
        prompt: "hello",
      }),
    ).toContain(
      "Request has conflicting listener schemas; verify the raw event payload.",
    );
  });

  it("selects controls and seeds values from schemas", () => {
    const input = {
      id: "priority",
      label: "Priority",
      description: null,
      kind: "value" as const,
      required: true,
      schema: { type: "string", enum: ["normal", "urgent"] },
      sensitivity: "none" as const,
      consumers: ["agent"],
      bindings: [{ agentId: "agent", mode: "direct" as const }],
      conflict: false,
    };
    expect(workflowInputControl(input)).toBe("select");
    expect(seedWorkflowInputValue(input)).toBe("normal");
  });

  it("preserves file policy and validates bounded test limits", () => {
    const result = deriveWorkflowEntrypoints({
      $schemaVersion: 2,
      agents: [
        agent("documents", ["DOCUMENT_RECEIVED"], [], {
          inputs: [
            promptPort,
            {
              id: "documents",
              label: "Documents",
              kind: "file",
              required: true,
              schema: { type: "array" },
              sensitivity: "confidential",
              file: {
                media_types: ["application/pdf"],
                max_bytes: 5_000_000,
                multiple: true,
              },
            },
          ],
        }),
      ],
    });
    const documents = result.entrypoints[0]?.inputs.find(
      (input) => input.id === "documents",
    );
    expect(documents?.file).toEqual({
      media_types: ["application/pdf"],
      max_bytes: 5_000_000,
      multiple: true,
    });
    expect(seedWorkflowInputValue(documents!)).toEqual([]);
    expect(
      parseWorkflowTestLimits({
        maxAgentRuns: "100",
        maxEvents: "250",
        maxDepth: "50",
      }),
    ).toEqual({
      maxAgentRuns: 100,
      maxEvents: 250,
      maxDepth: 50,
    });
    expect(() =>
      parseWorkflowTestLimits({
        maxAgentRuns: "101",
        maxEvents: "75",
        maxDepth: "12",
      }),
    ).toThrow("Agent runs budget must be a whole number from 1 to 100.");
  });

  it("builds the same direct and nested input envelope for live events", () => {
    expect(
      buildWorkflowEventPayload(
        { prompt: "Run", priority: "normal" },
        { priority: "urgent", inputs: { prompt: "untrusted override" } },
      ),
    ).toEqual({
      prompt: "Run",
      priority: "urgent",
      inputs: { prompt: "Run", priority: "normal" },
    });
  });
});
