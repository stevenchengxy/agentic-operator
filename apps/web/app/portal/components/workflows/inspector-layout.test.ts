import { describe, expect, it } from "vitest";
import {
  WORKFLOW_INSPECTOR_DEFAULT_WIDTH,
  WORKFLOW_INSPECTOR_MAX_WIDTH,
  WORKFLOW_INSPECTOR_MIN_WIDTH,
  WORKFLOW_INSPECTOR_WIDE_WIDTH,
  clampWorkflowInspectorWidth,
  workflowInspectorMaxWidth,
  workflowInspectorStorageKey,
  workflowInspectorWideWidth,
} from "./inspector-layout";

describe("workflow inspector layout", () => {
  it("reserves useful canvas space while allowing a complete settings panel", () => {
    expect(workflowInspectorMaxWidth(1_400)).toBe(960);
    expect(workflowInspectorMaxWidth(1_100)).toBe(666);
    expect(workflowInspectorMaxWidth(900)).toBe(466);
  });

  it("clamps persisted and dragged widths safely", () => {
    expect(clampWorkflowInspectorWidth(120, 1_400)).toBe(
      WORKFLOW_INSPECTOR_MIN_WIDTH,
    );
    expect(clampWorkflowInspectorWidth(2_000, 1_400)).toBe(
      WORKFLOW_INSPECTOR_MAX_WIDTH,
    );
    expect(clampWorkflowInspectorWidth(Number.NaN, 1_400)).toBe(
      WORKFLOW_INSPECTOR_DEFAULT_WIDTH,
    );
  });

  it("uses the preferred wide width when the workspace can support it", () => {
    expect(workflowInspectorWideWidth(1_400)).toBe(
      WORKFLOW_INSPECTOR_WIDE_WIDTH,
    );
    expect(workflowInspectorWideWidth(1_000)).toBe(566);
  });

  it("scopes saved panel preferences to the tenant", () => {
    expect(workflowInspectorStorageKey("raas")).toBe(
      "agentic:workflow-inspector-width:v1:raas",
    );
  });
});
