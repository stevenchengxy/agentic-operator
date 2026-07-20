import { describe, expect, it } from "vitest";
import {
  parseCompleteAgentDefinition,
  parseJsonArray,
  parseList,
  parseTypedPorts,
  summarizeAutomaticLinks,
  validateNumberInput,
} from "./AgentEditor";
import type { DagAgent } from "@/lib/hooks/useAgents";

describe("AgentEditor input parsing", () => {
  it("normalizes comma and whitespace-separated events without duplicates", () => {
    expect(parseList("READY, REVIEW\nREADY   COMPLETE")).toEqual([
      "READY",
      "REVIEW",
      "COMPLETE",
    ]);
  });

  it("accepts action and tool arrays while preserving nested extension data", () => {
    expect(
      parseJsonArray(
        '[{"type":"logic","extension":{"quality":"strict"}}]',
        "Actions",
      ),
    ).toEqual([{ type: "logic", extension: { quality: "strict" } }]);
  });

  it("rejects malformed JSON and non-array JSON", () => {
    expect(() => parseJsonArray("{", "Actions")).toThrow(
      "Actions must be valid JSON.",
    );
    expect(() => parseJsonArray('{"name":"meta.ping"}', "Tools")).toThrow(
      "Tools must be a JSON array.",
    );
  });

  it("validates typed input/output port JSON", () => {
    expect(
      parseTypedPorts(
        '[{"id":"request","kind":"value","schema":{"type":"object"}}]',
        "Inputs",
        "inputs",
      ),
    ).toHaveLength(1);
    expect(() =>
      parseTypedPorts(
        '[{"id":"request","schema":{"type":"object"}}]',
        "Inputs",
        "inputs",
      ),
    ).toThrow("Inputs[0].kind");
    expect(() =>
      parseTypedPorts('[{"id":"result"}]', "Outputs", "outputs"),
    ).toThrow("Outputs[0].schema");
  });

  it("reports malformed and out-of-range numeric values", () => {
    expect(
      validateNumberInput("0.5", "Temperature", { min: 0, max: 2 }),
    ).toBeNull();
    expect(validateNumberInput("2.5", "Temperature", { max: 2 })).toBe(
      "Temperature must be at most 2.",
    );
    expect(validateNumberInput("1.5", "Retries", { integer: true })).toBe(
      "Retries must be a whole number.",
    );
    expect(validateNumberInput("", "Stage", { required: true })).toBe(
      "Stage is required.",
    );
  });

  it("validates complete JSON without stripping extension fields", () => {
    const definition = parseCompleteAgentDefinition(
      JSON.stringify({
        id: "triage",
        name: "triage",
        actor: ["Agent"],
        trigger: ["CASE_OPENED"],
        actions: [],
        triggered_event: ["CASE_TRIAGED"],
        tenant_extension: { qualityGate: "strict" },
      }),
      "triage",
    );

    expect(definition.tenant_extension).toEqual({ qualityGate: "strict" });
    expect(() =>
      parseCompleteAgentDefinition(
        JSON.stringify({ ...definition, id: "different" }),
        "triage",
      ),
    ).toThrow('Agent id must remain "triage".');
    expect(() => parseCompleteAgentDefinition("{", "triage")).toThrow(
      "Agent definition must be valid JSON.",
    );
  });

  it("summarizes automatic upstream, downstream, and unmatched events", () => {
    const agents: DagAgent[] = [
      dagAgent("intake", [], ["CASE_OPENED"], "Intake"),
      dagAgent(
        "triage",
        ["CASE_OPENED", "MANUAL_REVIEW"],
        ["CASE_TRIAGED", "AUDIT_ONLY"],
        "Triage",
      ),
      dagAgent("assign", ["CASE_TRIAGED"], [], "Assignment"),
    ];

    expect(
      summarizeAutomaticLinks(
        "triage",
        agents,
        agents[1]!.triggers,
        agents[1]!.emits,
      ),
    ).toEqual({
      incoming: [
        { event: "CASE_OPENED", agentId: "intake", agentTitle: "Intake" },
      ],
      outgoing: [
        { event: "CASE_TRIAGED", agentId: "assign", agentTitle: "Assignment" },
      ],
      unmatchedTriggers: ["MANUAL_REVIEW"],
      unmatchedEmits: ["AUDIT_ONLY"],
      hasWorkflowContext: true,
    });
  });
});

function dagAgent(
  id: string,
  triggers: string[],
  emits: string[],
  title: string,
): DagAgent {
  return {
    id,
    kebabId: id,
    name: id,
    title,
    actor: "Agent",
    triggers,
    emits,
    stage: 0,
    recentRunCount: 0,
    isLive: false,
  };
}
