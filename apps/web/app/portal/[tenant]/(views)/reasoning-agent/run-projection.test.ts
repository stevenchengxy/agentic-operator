import { describe, expect, it } from "vitest";
import type { Translate } from "@/app/portal/lib/preferences-context";
import { translate } from "@/lib/i18n";
import type {
  ReasoningRunResponse,
  ReasoningRunStep,
} from "@/lib/hooks/useReasoningAgentContext";
import { humanStepName, projectRuntimeAgents } from "./run-projection";

const enT: Translate = (key, vars) => translate("en", key, vars);
const zhT: Translate = (key, vars) => translate("zh", key, vars);

function step(
  ord: number,
  name: string,
  status: string = "ok",
): ReasoningRunStep {
  return {
    id: `step-${ord}`,
    ord,
    name,
    type: name === "llm.call" ? "logic" : "tool",
    status,
    startedAt: null,
    endedAt: null,
    durationMs: null,
    error: null,
    provider: null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    input: null,
    output: null,
  };
}

function qualifiedChild(
  status: string,
): ReasoningRunResponse["children"][number] {
  return {
    role: "qualified",
    runtimeRole: "qualified",
    run: {
      id: "run-qualified",
      parentRunId: "run-parent",
      status,
      agentName: "reasoningAgent",
      startedAt: null,
      endedAt: null,
      durationMs: null,
      tokensIn: null,
      tokensOut: null,
      model: null,
      error: null,
      currentStepName: null,
      currentStepOrd: null,
      stepCount: null,
    },
    steps: [step(1, "llm.call", status === "running" ? "running" : "ok")],
  };
}

describe("reasoning runtime projection", () => {
  it("shows no synthetic graph before a durable run exists", () => {
    expect(projectRuntimeAgents(null, [], null, zhT)).toEqual([]);
  });

  it("projects real tool steps into the five logical agents", () => {
    const projected = projectRuntimeAgents(
      "running",
      [
        step(1, "llm.call"),
        step(2, "select_applicable_rules"),
        step(3, "llm.call"),
        step(4, "compile_qualified_prompt"),
        step(5, "llm.call", "running"),
      ],
      null,
      zhT,
      [qualifiedChild("running")],
    );

    expect(projected.map((agent) => [agent.id, agent.status])).toEqual([
      ["reasoning", "completed"],
      ["query", "completed"],
      ["compiler", "completed"],
      ["qualified", "running"],
      ["fold", "waiting"],
    ]);
  });

  it("marks unfinished stages blocked when the durable run fails", () => {
    const projected = projectRuntimeAgents(
      "failed",
      [step(1, "llm.call"), step(2, "select_applicable_rules", "failed")],
      null,
      zhT,
    );
    expect(projected.find((agent) => agent.id === "query")?.status).toBe(
      "blocked",
    );
    expect(projected.find((agent) => agent.id === "compiler")?.status).toBe(
      "blocked",
    );
    expect(projected.find((agent) => agent.id === "qualified")?.status).toBe(
      "blocked",
    );
    expect(projected.find((agent) => agent.id === "fold")?.status).toBe(
      "blocked",
    );
  });

  it("marks an in-flight parent and child blocked when liveness expires", () => {
    const projected = projectRuntimeAgents(
      "stalled",
      [
        step(1, "llm.call"),
        step(2, "select_applicable_rules"),
        step(3, "llm.call"),
        step(4, "compile_qualified_prompt", "running"),
      ],
      null,
      zhT,
      [qualifiedChild("running")],
    );
    expect(projected.map((agent) => [agent.id, agent.status])).toEqual([
      ["reasoning", "completed"],
      ["query", "completed"],
      ["compiler", "blocked"],
      ["qualified", "blocked"],
      ["fold", "blocked"],
    ]);
  });

  it("never infers QualifiedAgent from a parent LLM step after compilation", () => {
    const steps = [
      step(1, "llm.call"),
      step(2, "select_applicable_rules"),
      step(3, "llm.call"),
      step(4, "compile_qualified_prompt"),
      step(5, "llm.call", "running"),
    ];
    const projected = projectRuntimeAgents("running", steps, null, zhT, []);
    expect(projected.find((agent) => agent.id === "qualified")?.status).toBe(
      "waiting",
    );
    expect(humanStepName(steps[4]!, zhT, steps)).toContain("推理编排器");
    expect(humanStepName(steps[4]!, enT, steps)).toBe(
      "Reasoning Orchestrator · Child Handoff Confirmation",
    );
  });
});
