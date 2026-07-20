import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lint } from "./lint";
import { WorkflowManifestSchema, type WorkflowManifest } from "./manifest";

const lintContext = {
  llmProviders: ["mock"],
  concurrencyMax: 25,
};

function humanManifest(overrides: Record<string, unknown>): WorkflowManifest {
  return WorkflowManifestSchema.parse([
    {
      id: "manual-agent",
      name: "manualAgent",
      title: "Manual agent",
      description: "Wait for an accountable operator decision.",
      actor: ["Human"],
      trigger: ["REVIEW_REQUESTED"],
      actions: [],
      triggered_event: ["REVIEW_RESOLVED"],
      tool_use: [],
      ...overrides,
    },
  ]);
}

function orphanConflicts(manifest: WorkflowManifest) {
  return lint(manifest, lintContext).conflicts.filter(
    (conflict) => conflict.type === "orphan_actor",
  );
}

describe("Human actor task-definition lint", () => {
  it("accepts the canonical v2 inline manual-task contract", () => {
    const manifest = humanManifest({
      inputs: [
        {
          id: "payload",
          label: "Payload",
          kind: "value",
          required: false,
          schema: { type: "object" },
          sensitivity: "none",
        },
      ],
      outputs: [
        {
          id: "result",
          label: "Resolution",
          required: true,
          schema: { type: "object" },
          sensitivity: "none",
        },
      ],
      actions: [
        {
          order: "1",
          name: "requestApproval",
          description: "Wait for an operator.",
          type: "manual",
          task_type: "approval",
          awaiting_role: "risk-operator",
          form_schema: {
            type: "object",
            required: ["decision"],
            properties: {
              decision: {
                type: "string",
                enum: ["approve", "reject", "supplement"],
              },
            },
          },
        },
      ],
    });

    assert.deepEqual(orphanConflicts(manifest), []);
  });

  it("preserves the legacy taskDefinition tool representation", () => {
    const manifest = humanManifest({
      actions: [
        {
          order: "1",
          name: "waitForDecision",
          description: "Legacy manual step.",
          type: "manual",
        },
      ],
      tool_use: [{ name: "taskDefinition" }],
    });

    assert.deepEqual(orphanConflicts(manifest), []);
  });

  it("still blocks a bare Human actor with an incomplete manual action", () => {
    const manifest = humanManifest({
      actions: [
        {
          order: "1",
          name: "waitForDecision",
          description: "Missing its role and form contract.",
          type: "manual",
          task_type: "approval",
        },
      ],
    });

    const conflicts = orphanConflicts(manifest);
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0]!.detail, /neither a complete inline/i);
  });
});
