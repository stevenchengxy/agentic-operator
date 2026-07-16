import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(__dirname, "TestLab.tsx"), "utf8");
const hooks = readFileSync(
  resolve(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "lib",
    "hooks",
    "useAgentStudio.ts",
  ),
  "utf8",
);
const css = readFileSync(
  resolve(__dirname, "..", "..", "..", "global.css"),
  "utf8",
);

describe("Test Lab chat wiring", () => {
  it("opens on the chat result and loads a pollable run session", () => {
    expect(source).toContain('useState<ResultTab>("chat")');
    expect(source).toContain("useRunSession(sessionId)");
    expect(source).toContain('role="log"');
    expect(hooks).toContain("GetRunSessionResponseSchema.parse");
    expect(hooks).toContain("AGENT_STUDIO_KEYS.session(sessionId)");
    expect(hooks).toMatch(/refetchInterval:[\s\S]{0,320}run\.status/);
  });

  it("sends exact composer text with explicit session context", () => {
    expect(source).toContain('const [prompt, setPrompt] = useState("")');
    expect(source).not.toContain("String(promptInput?.default");
    expect(source).toContain("const submittedPrompt = prompt");
    expect(source).toContain("buildStudioChatRunRequest({");
    expect(source).toContain("prompt: submittedPrompt");
    expect(hooks).toContain("CreateAgentRunBodySchema.parse(body)");
    expect(hooks).toContain("`/v1/agents/${encodeURIComponent(agentId)}/runs`");
    expect(hooks).toContain("body: JSON.stringify(payload)");
    expect(source.indexOf('setPrompt("")')).toBeGreaterThan(
      source.indexOf("await createRun.mutateAsync"),
    );
    expect(source).toMatch(
      /event\.key === "Enter"[\s\S]{0,100}!event\.shiftKey[\s\S]{0,220}void run\(\)/,
    );
  });

  it("guards click/key races so one message dispatches one event", () => {
    expect(source).toContain("dispatchInFlightRef");
    expect(source).toContain(
      "if (submitDisabled || dispatchInFlightRef.current) return",
    );
    const acquired = source.indexOf("dispatchInFlightRef.current = true");
    const finallyBlock = source.indexOf("finally {", acquired);
    const released = source.indexOf(
      "dispatchInFlightRef.current = false",
      finallyBlock,
    );
    expect(acquired).toBeGreaterThan(-1);
    expect(finallyBlock).toBeGreaterThan(acquired);
    expect(released).toBeGreaterThan(finallyBlock);
  });

  it("refreshes run history even when dispatch fails after reservation", () => {
    expect(hooks).toContain("onSettled: async (response)");
    expect(hooks).toContain('["agent-studio", "history", agentId]');
  });

  it("shows the queued event immediately and correlates it to the returned run", () => {
    expect(source).toContain('state: "publishing"');
    expect(source).toContain('state: "queued"');
    expect(source).toContain("runId: response.runId");
    expect(source).toContain("eventId: response.eventId");
    expect(source).toContain("eventName: response.eventName");
    expect(source).toContain("event · {lastDispatch.eventName}");
    expect(source).toContain("events?eventId=");
    expect(source).toContain(
      "Publishing the trigger event to the agent runtime…",
    );
    expect(source).toContain('pendingTurn.eventName ?? "The trigger event"');
  });

  it("pins the target for a conversation and makes New chat reset it", () => {
    expect(source).toContain("conversationTarget");
    expect(source).toContain("setConversationTarget(requestedTarget)");
    expect(source).toContain("session.data?.continuation");
    expect(source).toContain("setConversationTarget(continuation.target)");
    expect(source).toContain(
      "setConversationTriggerEvent(continuation.triggerEvent)",
    );
    expect(source).toContain("setInputs(continuation.inputs)");
    expect(source).toMatch(
      /function newChat\(\)[\s\S]{0,240}setConversationTarget\(null\)/,
    );
    expect(source).toContain("Start a new chat to change it.");
  });

  it("selects an authored trigger once and pins it for follow-ups", () => {
    expect(source).toContain('label="Trigger event"');
    expect(source).toContain("definition.trigger[0]");
    expect(source).toContain("requestedTriggerEvent");
    expect(source).toContain("triggerEvent: requestedTriggerEvent");
    expect(source).toContain("setConversationTriggerEvent(response.eventName)");
    expect(source).toMatch(
      /function newChat\(\)[\s\S]{0,320}setConversationTriggerEvent\(undefined\)/,
    );
  });

  it("keeps the composer sticky and collapses Test Lab to one column", () => {
    expect(css).toMatch(
      /\.agent-studio-chat-composer\s*\{[\s\S]{0,100}position: sticky/,
    );
    expect(css).toMatch(
      /@media \(max-width: 900px\)[\s\S]{0,140}\.agent-studio-test-grid[\s\S]{0,100}grid-template-columns: minmax\(0, 1fr\)/,
    );
  });
});
