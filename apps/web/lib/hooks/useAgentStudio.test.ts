import { describe, expect, it } from "vitest";
import {
  AgentStudioApiError,
  AgentStudioClientError,
  formatAgentStudioError,
} from "./useAgentStudio";

describe("formatAgentStudioError", () => {
  it("shows the API message, stable code, and recovery hint", () => {
    const error = new AgentStudioApiError({
      status: 409,
      code: "draft_conflict",
      message: "The live agent changed while this draft was open.",
      hint: "Refresh the editor and create a new draft from the live version.",
    });

    expect(formatAgentStudioError(error)).toBe(
      "The live agent changed while this draft was open. · Error code: draft_conflict · What to do: Refresh the editor and create a new draft from the live version.",
    );
  });

  it("keeps ordinary client-side errors concise", () => {
    expect(formatAgentStudioError(new Error("Create a draft first."))).toBe(
      "Create a draft first.",
    );
  });

  it("localizes client-owned copy without translating API-authored detail", () => {
    const t = (key: string, vars?: Record<string, string | number>) =>
      key === "agentStudioError.errorCode"
        ? `错误代码：${vars?.code}`
        : key === "agentStudioError.whatToDo"
          ? `处理建议：${vars?.hint}`
          : key === "agentStudioError.draftRequiredSave"
            ? "请先创建草稿，再保存更改。"
            : key;
    const apiError = new AgentStudioApiError({
      status: 409,
      code: "draft_conflict",
      message: "server detail",
      hint: "server hint",
    });
    expect(formatAgentStudioError(apiError, t)).toBe(
      "server detail · 错误代码：draft_conflict · 处理建议：server hint",
    );
    expect(
      formatAgentStudioError(
        new AgentStudioClientError(
          "draftRequiredSave",
          "Create a draft before saving changes.",
        ),
        t,
      ),
    ).toBe("请先创建草稿，再保存更改。");
  });
});
