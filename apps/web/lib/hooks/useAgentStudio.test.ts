import { describe, expect, it } from "vitest";
import { AgentStudioApiError, formatAgentStudioError } from "./useAgentStudio";

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
});
