import { describe, it, expect } from "vitest";
import { evaluateExecutionFidelity, expectedFieldsByEvent, fidelityStrings } from "./execution-fidelity";
import { deriveContractGraph } from "./contract";
import type { AgentRunIO } from "./brain-types";
import type { GeneratedAgentSpec } from "./spec-types";

function spec(p: Partial<GeneratedAgentSpec> & { actionName: string }): GeneratedAgentSpec {
  return {
    actionName: p.actionName,
    slug: p.slug ?? `d-${p.actionName}`,
    nameZh: p.nameZh ?? p.actionName,
    trigger: p.trigger ?? [],
    emit: p.emit ?? [],
    tools: p.tools ?? [],
    unresolvedTools: [],
    systemPrompt: "",
    inputSchema: p.inputSchema,
    outputSchema: p.outputSchema,
  } as unknown as GeneratedAgentSpec;
}

function run(p: Partial<AgentRunIO> & { agentShort: string; outputEvent: string | null }): AgentRunIO {
  return {
    agentSlug: p.agentSlug ?? `d-${p.agentShort}`,
    agentShort: p.agentShort,
    status: p.status ?? "ok",
    degraded: p.degraded ?? false,
    triggerEvent: p.triggerEvent ?? null,
    inputPayload: p.inputPayload ?? null,
    tools: p.tools ?? [],
    outputEvent: p.outputEvent,
    reasoning: p.reasoning ?? "",
    outputPayload: p.outputPayload ?? null,
    runId: p.runId ?? "run-1",
  };
}

// A chain where matchResume (consumer of RESUME_PROCESSED) needs candidate_id:string + score:number.
const graph = deriveContractGraph(
  [
    spec({ actionName: "parseResume", trigger: ["RESUME_DOWNLOADED"], emit: ["RESUME_PROCESSED"], outputSchema: [{ field: "candidate_id", type: "string" }, { field: "score", type: "number" }] }),
    spec({ actionName: "matchResume", trigger: ["RESUME_PROCESSED"], emit: ["MATCH_PASSED"], inputSchema: [{ field: "candidate_id", type: "string" }, { field: "score", type: "number" }] }),
  ],
  "rec",
);
const expected = expectedFieldsByEvent(graph);

describe("evaluateExecutionFidelity", () => {
  it("passes when the real emitted payload satisfies the downstream contract", () => {
    const f = evaluateExecutionFidelity(
      [run({ agentShort: "ParseResume", outputEvent: "RESUME_PROCESSED", outputPayload: { candidate_id: "c-1", score: 88 } })],
      expected,
    );
    expect(f.ok).toBe(true);
    expect(f.evaluated).toBe(1);
    expect(f.passed).toBe(1);
    expect(f.fidelity).toBe(1);
  });

  it("FAILS an agent that emitted a null payload where the downstream needs fields (the output_parse_error case)", () => {
    const f = evaluateExecutionFidelity(
      [run({ agentShort: "ParseResume", outputEvent: "RESUME_PROCESSED", outputPayload: null })],
      expected,
    );
    expect(f.ok).toBe(false);
    expect(f.failingShorts).toEqual(["ParseResume"]);
    expect(f.failed[0]?.errors[0]?.kind).toBe("not_object");
    expect(fidelityStrings(f)[0]).toContain("ParseResume");
  });

  it("FAILS an agent that emitted a wrong-typed field", () => {
    const f = evaluateExecutionFidelity(
      [run({ agentShort: "ParseResume", outputEvent: "RESUME_PROCESSED", outputPayload: { candidate_id: "c-1", score: "high" } })],
      expected,
    );
    expect(f.ok).toBe(false);
    expect(f.failed[0]?.errors).toContainEqual(expect.objectContaining({ field: "score", kind: "type_mismatch" }));
  });

  it("skips degraded agents (already caught elsewhere) and terminal/no-contract events (lenient)", () => {
    const f = evaluateExecutionFidelity(
      [
        run({ agentShort: "Degraded", outputEvent: "RESUME_PROCESSED", outputPayload: null, degraded: true }),
        run({ agentShort: "Match", outputEvent: "MATCH_PASSED", outputPayload: null }), // terminal → no downstream contract
        run({ agentShort: "Silent", outputEvent: null }),
      ],
      expected,
    );
    expect(f.ok).toBe(true);
    expect(f.evaluated).toBe(0); // nothing gradable
    expect(f.fidelity).toBe(1);
    expect(f.perAgent.map((a) => a.skipped)).toEqual(["degraded", "no_contract", "no_output_event"]);
  });

  // Review fix: with the canonical map supplied, only ontology-declared fields are hard-required.
  it("canonical-aware grading: consumer-invented field absence is OK, canonical field absence fails", () => {
    const canonical = new Map([["RESUME_PROCESSED", [{ field: "candidate_id", type: "string" }]]]);
    const exp = expectedFieldsByEvent(graph, canonical);
    // score is consumer-expected but NOT canonical → optional; candidate_id canonical → required
    const okRun = evaluateExecutionFidelity(
      [run({ agentShort: "P", outputEvent: "RESUME_PROCESSED", outputPayload: { candidate_id: "c-1" } })],
      exp,
    );
    expect(okRun.ok).toBe(true);
    const badRun = evaluateExecutionFidelity(
      [run({ agentShort: "P", outputEvent: "RESUME_PROCESSED", outputPayload: { score: 9 } })],
      exp,
    );
    expect(badRun.ok).toBe(false);
    expect(badRun.failed[0]?.errors).toContainEqual(expect.objectContaining({ field: "candidate_id", kind: "missing" }));
    // consumer-invented field still TYPE-checked when present
    const typed = evaluateExecutionFidelity(
      [run({ agentShort: "P", outputEvent: "RESUME_PROCESSED", outputPayload: { candidate_id: "c", score: "high" } })],
      exp,
    );
    expect(typed.ok).toBe(false);
    expect(typed.failed[0]?.errors).toContainEqual(expect.objectContaining({ field: "score", kind: "type_mismatch" }));
  });

  it("computes partial fidelity across a mixed batch", () => {
    const f = evaluateExecutionFidelity(
      [
        run({ agentShort: "Good", outputEvent: "RESUME_PROCESSED", outputPayload: { candidate_id: "c", score: 1 } }),
        run({ agentShort: "Bad", outputEvent: "RESUME_PROCESSED", outputPayload: { candidate_id: "c" } }), // missing score
      ],
      expected,
    );
    expect(f.evaluated).toBe(2);
    expect(f.passed).toBe(1);
    expect(f.fidelity).toBe(0.5);
    expect(f.failingShorts).toEqual(["Bad"]);
  });
});
