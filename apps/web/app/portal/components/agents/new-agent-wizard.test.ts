import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const modal = readFileSync(resolve(__dirname, "DeployAgentModal.tsx"), "utf8");
const presets = readFileSync(resolve(__dirname, "agent-builder.ts"), "utf8");
const authoringHook = readFileSync(
  resolve(__dirname, "../../../../lib/hooks/useAgentAuthoring.ts"),
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
});
