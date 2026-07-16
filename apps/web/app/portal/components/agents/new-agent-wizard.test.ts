import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const modal = readFileSync(resolve(__dirname, "DeployAgentModal.tsx"), "utf8");
const presets = readFileSync(resolve(__dirname, "agent-builder.ts"), "utf8");
const authoringHook = readFileSync(
  resolve(__dirname, "../../../../lib/hooks/useAgentAuthoring.ts"),
  "utf8",
);
const authoringResponse = readFileSync(
  resolve(__dirname, "../../../../lib/hooks/agent-authoring-response.ts"),
  "utf8",
);
const globalCss = readFileSync(
  resolve(__dirname, "../../../global.css"),
  "utf8",
);

describe("New Agent wizard wiring", () => {
  it("is stage-free and requires a complete event contract", () => {
    expect(modal).not.toContain('label="Workflow stage"');
    expect(modal).not.toMatch(/\bstage:\s*(context\.)?stage/);
    expect(modal).toContain(
      "const eventsValid = triggers.length > 0 && emits.length > 0",
    );
  });

  it("sends authored steps, Deep Search depth, and optional model overrides", () => {
    expect(modal).toContain("steps: authoredSteps()");
    expect(modal).toContain("searchMode: deepSearchMode");
    expect(modal).toContain('item.execution === "human" ? "manual" : "logic"');
    expect(modal).toContain("item.modelOverride !== INHERIT_MODEL");
    expect(modal).toContain("modelChoice === AUTO_MODEL");
  });

  it("uses the requested product language and live publish completion", () => {
    expect(modal).toContain('"New Agent"');
    expect(modal).toContain("Create & publish");
    expect(modal).toContain("Open &amp; run");
    expect(presets).toContain('name: "Deep Search"');
    expect(presets).not.toContain("RAG retriever");
  });

  it("makes ontology access part of every agent", () => {
    expect(modal).toContain("Every agent can discover the graph schema");
    expect(modal).toContain('["ontology.query"]');
  });

  it("checks name availability before leaving Identity", () => {
    expect(modal).toContain("useAgentNameAvailability(name, nameValid)");
    expect(modal).toContain("nameAvailability.data?.available === true");
    expect(modal).toMatch(
      /const identityValid\s*=\s*[\s\S]*?nameAvailable[\s\S]*?title\.trim\(\)/,
    );
    expect(modal).toContain("Checking whether this agent ID is available");
    expect(modal).toContain("Choose a different name");
  });

  it("debounces and schema-validates the tenant-scoped availability request", () => {
    expect(authoringHook).toContain(
      "AGENT_NAME_AVAILABILITY_DEBOUNCE_MS = 400",
    );
    expect(authoringHook).toContain(
      "`/v1/agents/availability?name=${encodeURIComponent(debouncedName)}`",
    );
    expect(authoringHook).toContain("AgentNameAvailabilityResponse.parse");
    expect(authoringHook).toContain("requestedName === debouncedName");
  });

  it("aligns paired event fields and gives every text control a shared rhythm", () => {
    expect(modal).toContain('className="new-agent-events-grid"');
    expect(modal).toContain("new-agent-paired-field new-agent-events-field");
    expect(modal).toContain("new-agent-edit-field-label");
    expect(modal).toContain("new-agent-edit-field-hint");
    expect(modal).toContain("new-agent-edit-control");
    expect(globalCss).toContain(
      ".new-agent-paired-field .new-agent-edit-field-hint",
    );
    expect(globalCss).toContain(".new-agent-event-picker__tokens");
    expect(globalCss).toMatch(
      /\.new-agent-event-picker__tokens\s*\{[\s\S]*?height: 48px;[\s\S]*?overflow-y: auto;/,
    );
    expect(modal).toContain('htmlFor="new-agent-name"');
    expect(modal).toContain('htmlFor="new-agent-trigger-event"');
    expect(modal).toContain('htmlFor="new-agent-emit-event"');
  });

  it("makes prompt generation vivid, explicit, and accessible", () => {
    expect(modal).toContain("PromptGenerationProgress");
    expect(modal).toContain('role="status"');
    expect(modal).toContain('aria-live="polite"');
    expect(modal).toContain("aria-busy={generatePrompt.isPending}");
    expect(modal).toContain("Generating system prompt");
    expect(modal).toContain("Generating prompt…");
    expect(modal).toContain("new-agent-generate-icon--active");
    expect(globalCss).toContain("@keyframes new-agent-prompt-glow");
    expect(globalCss).toContain(".new-agent-prompt-progress");
    expect(globalCss).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("handles plain-text proxy failures without surfacing JSON parser errors", () => {
    expect(authoringHook).toContain("readAgentAuthoringResponse");
    expect(authoringHook).not.toContain("await response.json()");
    expect(authoringResponse).toContain("await response.text()");
    expect(authoringResponse).toContain("is temporarily unavailable");
    expect(authoringResponse).toContain("returned an invalid response");
  });

  it("ignores prompt results that no longer match the latest source fields", () => {
    expect(modal).toContain("promptRequestSequenceRef");
    expect(modal).toContain("currentPromptFingerprintRef");
    expect(modal).toContain("isCurrentPromptRequest");
    expect(modal).toContain("generatedPromptFingerprint");
    expect(modal).toContain("promptIsStale");
    expect(modal).toContain(
      "setGeneratedPromptFingerprint(promptSourceFingerprint)",
    );
    expect(modal).toContain("Agent details changed after this prompt");
  });
});
