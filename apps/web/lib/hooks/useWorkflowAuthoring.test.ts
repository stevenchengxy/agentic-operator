import { describe, expect, it } from "vitest";
import {
  WorkflowAuthoringApiError,
  WorkflowAuthoringClientError,
  formatWorkflowAuthoringError,
} from "./useWorkflowAuthoring";

describe("formatWorkflowAuthoringError", () => {
  const t = (key: string, vars?: Record<string, string | number>) =>
    key === "workflowAuthoringError.requestFailed"
      ? `工作流创作请求失败（HTTP ${vars?.status}）。`
      : key;

  it("localizes client-owned failures", () => {
    expect(
      formatWorkflowAuthoringError(
        new WorkflowAuthoringClientError(
          "requestFailed",
          "Workflow authoring request failed (HTTP 503).",
          503,
        ),
        t,
      ),
    ).toBe("工作流创作请求失败（HTTP 503）。");
  });

  it("preserves server-authored error detail", () => {
    expect(
      formatWorkflowAuthoringError(
        new WorkflowAuthoringApiError("policy_denied", "server detail"),
        t,
      ),
    ).toBe("server detail");
  });
});
