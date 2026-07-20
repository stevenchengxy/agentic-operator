import { describe, expect, it } from "vitest";
import type { OperatorCheckRecord } from "@agentic/contracts";
import {
  OPERATOR_CHECK_SCENARIOS,
  isOperatorCheckTerminal,
  operatorCheckProgress,
  operatorCheckStatusLabel,
} from "./model";

function record(
  status: OperatorCheckRecord["status"],
  completedStages = 0,
  totalStages = completedStages,
): OperatorCheckRecord {
  return {
    id: "opc-test",
    tenantId: "ten-test",
    tenantSlug: "raas",
    status,
    startedAt: new Date("2026-07-15T00:00:00Z"),
    endedAt: null,
    durationMs: null,
    currentStage: null,
    summary: null,
    scenarios: [],
    stages: Array.from({ length: totalStages }, (_, index) => ({
      id: `stage-${index}`,
      phase: "validate" as const,
      scenario: null,
      label: `Stage ${index}`,
      status:
        index < completedStages ? ("passed" as const) : ("queued" as const),
      startedAt: null,
      endedAt: null,
      durationMs: null,
      message: null,
      details: null,
    })),
  };
}

describe("operator check presentation model", () => {
  it("defines exactly the two reliability scenarios", () => {
    expect(OPERATOR_CHECK_SCENARIOS.map((scenario) => scenario.id)).toEqual([
      "support-triage",
      "context-probe",
    ]);
  });

  it("keeps active progress below 100 and makes terminal states complete", () => {
    expect(operatorCheckProgress(record("queued"))).toBe(0);
    expect(operatorCheckProgress(record("running", 1, 26))).toBe(4);
    expect(operatorCheckProgress(record("running", 25, 26))).toBe(96);
    expect(operatorCheckProgress(record("passed", 2))).toBe(100);
    expect(operatorCheckProgress(record("failed", 2))).toBe(100);
  });

  it("provides plain status labels and terminal detection", () => {
    expect(operatorCheckStatusLabel("running")).toBe("Running");
    expect(operatorCheckStatusLabel("passed")).toBe("Passed");
    expect(isOperatorCheckTerminal("failed")).toBe(true);
    expect(isOperatorCheckTerminal("queued")).toBe(false);
  });
});
