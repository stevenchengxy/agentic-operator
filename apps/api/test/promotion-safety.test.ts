import { describe, expect, it } from "vitest";
import { inspectMergedPromotionSafety } from "../src/services/agent-factory/promotion-safety";

function agent(input: {
  id: string;
  trigger: string[];
  emit: string[];
  actor?: "Agent" | "Human";
  inputSchema?: Array<{ field: string; type: string; required?: boolean }>;
  outputSchema?: Array<{ field: string; type: string; required?: boolean }>;
}) {
  return {
    id: input.id,
    name: input.id,
    actor: [input.actor ?? "Agent"],
    trigger: input.trigger,
    triggered_event: input.emit,
    actions: [{ order: "1", name: input.id, description: "", type: "logic" }],
    tool_use: [],
    ...(input.inputSchema !== undefined ? { factory_input_schema: input.inputSchema } : {}),
    ...(input.outputSchema !== undefined ? { factory_output_schema: input.outputSchema } : {}),
  };
}

describe("merged Agent Factory promotion safety", () => {
  it("detects a cross live/candidate cycle but accepts the same cycle with a HITL bound", () => {
    const candidate = agent({
      id: "candidate",
      trigger: ["FROM_LIVE"],
      emit: ["TO_LIVE"],
      inputSchema: [],
      outputSchema: [],
    });
    const live = agent({
      id: "live",
      trigger: ["TO_LIVE"],
      emit: ["FROM_LIVE"],
      inputSchema: [],
      outputSchema: [],
    });

    const unsafe = inspectMergedPromotionSafety({
      merged: [live, candidate],
      promotedIds: new Set(["candidate"]),
      domainId: "test",
    });
    expect(unsafe.issues).toContainEqual(expect.objectContaining({
      kind: "unbounded_cycle",
      agentIds: ["candidate", "live"],
    }));

    const bounded = inspectMergedPromotionSafety({
      merged: [{ ...live, actor: ["Human"] }, candidate],
      promotedIds: new Set(["candidate"]),
      domainId: "test",
    });
    expect(bounded.issues.filter((issue) => issue.kind === "unbounded_cycle")).toEqual([]);
  });

  it("fails closed when a touched event edge has no persistent schema", () => {
    const result = inspectMergedPromotionSafety({
      merged: [
        agent({ id: "candidate", trigger: ["START"], emit: ["NEXT"] }),
        agent({ id: "live", trigger: ["NEXT"], emit: ["END"], inputSchema: [], outputSchema: [] }),
      ],
      promotedIds: new Set(["candidate"]),
      domainId: "test",
    });
    expect(result.issues).toContainEqual(expect.objectContaining({
      kind: "contract_schema_missing",
      agentId: "candidate",
      side: "output",
      event: "NEXT",
    }));
  });

  it("checks required fields and known types across the exact event edge", () => {
    const result = inspectMergedPromotionSafety({
      merged: [
        agent({
          id: "candidate",
          trigger: ["START"],
          emit: ["NEXT"],
          inputSchema: [],
          outputSchema: [{ field: "candidate_id", type: "number" }],
        }),
        agent({
          id: "live",
          trigger: ["NEXT"],
          emit: ["END"],
          inputSchema: [
            { field: "candidate_id", type: "string" },
            { field: "optional_note", type: "string", required: false },
            { field: "required_status", type: "string" },
          ],
          outputSchema: [],
        }),
      ],
      promotedIds: new Set(["candidate"]),
      domainId: "test",
    });
    expect(result.issues).toContainEqual(expect.objectContaining({
      kind: "payload_type_mismatch",
      field: "candidate_id",
      producerType: "number",
      consumerType: "string",
    }));
    expect(result.issues).toContainEqual(expect.objectContaining({
      kind: "payload_field_missing",
      field: "required_status",
    }));
    expect(result.issues).not.toContainEqual(expect.objectContaining({
      kind: "payload_field_missing",
      field: "optional_note",
    }));
  });
});
