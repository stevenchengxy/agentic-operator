import { describe, expect, it } from "vitest";
import { buildStudioChatRunRequest } from "./chat-request";

describe("Test Lab chat request", () => {
  it("publishes the exact textarea value as the agent prompt", () => {
    const textareaValue = "  Keep my leading spaces\n\nand trailing spaces.  ";

    const request = buildStudioChatRunRequest({
      target: { kind: "live", agentVersionId: "av-1" },
      sessionId: "ars-1",
      triggerEvent: "SUPPORT_REQUESTED",
      prompt: textareaValue,
      inputs: { account_id: "acct-1" },
      toolPolicy: "safe",
    });

    expect(request).toEqual({
      target: { kind: "live", agentVersionId: "av-1" },
      sessionId: "ars-1",
      contextMode: "session",
      triggerEvent: "SUPPORT_REQUESTED",
      prompt: textareaValue,
      inputs: { account_id: "acct-1" },
      toolPolicy: "safe",
    });
    expect(request.prompt).toBe(textareaValue);
  });

  it("starts a new session when no session id is supplied", () => {
    const request = buildStudioChatRunRequest({
      target: { kind: "draft", draftId: "agd-1", revision: 3 },
      prompt: "First turn",
      inputs: {},
      toolPolicy: "simulate",
    });

    expect(request.sessionId).toBeUndefined();
    expect(request.contextMode).toBe("session");
    expect(request.triggerEvent).toBeUndefined();
  });
});
