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
const splitter = readFileSync(resolve(__dirname, "..", "Splitter.tsx"), "utf8");

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

  it("renders response text in chat while retaining ambiguous structured JSON", () => {
    expect(source).toContain("assistantTextFromValue");
    expect(source).toContain("textOutputKeys={textOutputKeys}");
    expect(source).toContain(
      'assistantText != null ? (\n          <div className="agent-studio-chat-text">{assistantText}</div>',
    );
    expect(source).toContain("isStructuredChatValue(message.content)");
    expect(source).toContain('<pre className="agent-studio-chat-json">');
  });

  it("keeps the complete selected-run JSON in a collapsed output textarea", () => {
    expect(source).toContain(
      '<details className="agent-studio-output-details">',
    );
    expect(source).not.toContain(
      '<details open className="agent-studio-output-details">',
    );
    expect(source).toContain('aria-label="Selected run JSON output"');
    expect(source).toContain("readOnly");
    expect(source).toContain("value={selectedOutputText}");
    expect(source).toContain("prettyJsonOutput(output.data.output)");
    expect(css).toContain(".agent-studio-output-details textarea");
  });

  it("adds accessible splitters on both chat edges and hides them on mobile", () => {
    expect(source).toContain(
      'ariaLabel="Resize Test setup and Conversation panels"',
    );
    expect(source).toContain('"Resize Conversation and Run history panels"');
    expect(source).toContain('"Resize Conversation and Run history rows"');
    expect(source).toContain("max={setupPanelMaxWidth}");
    expect(source).toContain(
      "historyInline ? historyPanelMaxWidth : TEST_HISTORY_MAX_HEIGHT",
    );
    expect(source).toContain("invert");
    expect(css).toContain("--agent-studio-test-setup-width");
    expect(css).toContain("--agent-studio-test-history-width");
    expect(css).toMatch(
      /@media \(max-width: 900px\)[\s\S]*?\.agent-studio-test-splitter\s*\{[\s\S]*?display: none/,
    );
    expect(css).toContain(
      '.agent-studio-test-splitter [role="separator"]:focus-visible',
    );
    expect(splitter).toContain("onPointerDown={onPointerDown}");
    expect(splitter).toContain('window.addEventListener("pointermove", move)');
    expect(splitter).toContain(
      'window.addEventListener("pointercancel", finish)',
    );
    expect(splitter).toContain("target.setPointerCapture(pointerId)");
    expect(splitter).toContain('touchAction: "none"');
    expect(source).toContain('axis={historyInline ? "x" : "y"}');
    expect(source).toContain("setHistoryPanelHeight");
    expect(source).toContain('"--agent-studio-test-history-height"');
    expect(css).toMatch(
      /@media \(max-width: 1280px\)[\s\S]*?\.agent-studio-test-splitter--history\s*\{[\s\S]*?grid-column: 1 \/ -1/,
    );
  });

  it("lets the operator hide, reopen, and continue resizing run history", () => {
    expect(source).toContain(
      "const [historyOpen, setHistoryOpen] = useState(true)",
    );
    expect(source).toContain("agent-studio-test-grid--history-closed");
    expect(source).toContain("historyInline && historyOpen");
    expect(source).toContain(
      'historyOpen ? "Hide run history" : "Show run history"',
    );
    expect(source).toContain("ariaExpanded={historyOpen}");
    expect(source).toContain("setHistoryOpen((open) => !open)");
    expect(source).toContain('display: historyOpen ? "flex" : "none"');
    expect(source).toContain("{historyOpen && (");
    expect(css).toContain(".agent-studio-test-grid--history-closed");
    expect(css).toContain(".agent-studio-test-history-header");
  });

  it("shows the authored emitted events beside the trigger event setting", () => {
    expect(source).toContain("definition.triggered_event");
    expect(source).toContain("new Set(");
    expect(source).toContain('aria-label="Emitted events"');
    expect(source).toContain("emittedEvents.map");
    expect(source).toContain("Configured outgoing events.");
    expect(source).toContain("title={name}");
    expect(source).toContain("No emitted events configured");
    expect(css).toContain(".agent-studio-test-event-list");
    expect(css).toContain(".agent-studio-test-event-chip");
  });

  it("loads models for the effective provider and prevents stale provider/model pairs", () => {
    expect(source).toContain("useAvailableModels(effectiveProvider)");
    expect(source).toContain("providerModelIds(");
    expect(source).toContain("testModelOptions({");
    expect(source).toContain("providerOverrideNeedsModel(provider, model)");
    expect(source).toContain(
      "numericRuntimeOverridesInvalid || providerModelMissing",
    );
    expect(source).toContain("onChange={changeProvider}");
    expect(source).toContain("onChange={changeCatalogModel}");
    expect(source).toContain('setModel("")');
    expect(source).toContain("setManualModelEntry(false)");
    expect(source).toContain("clearModelSpecificOverrides()");
    expect(source).toContain('setStoreResponse("")');
    expect(source).toContain("onChange={changeManualModel}");
    expect(source).toContain("CUSTOM_MODEL_OPTION");
    expect(source).not.toContain(
      'label="Temporary AI model"\\n                    hint="Only changes this test run.',
    );
  });
});
