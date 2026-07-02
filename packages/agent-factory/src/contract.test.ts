import { describe, it, expect } from "vitest";
import { deriveContractGraph, contractIssueStrings, contractAgentIssueMap } from "./contract";
import type { GeneratedAgentSpec } from "./spec-types";

// Minimal spec factory — only the fields the contract derivation reads.
function spec(p: Partial<GeneratedAgentSpec> & { actionName: string }): GeneratedAgentSpec {
  return {
    actionName: p.actionName,
    slug: p.slug ?? `d-${p.actionName}`,
    nameZh: p.nameZh ?? p.actionName,
    trigger: p.trigger ?? [],
    emit: p.emit ?? [],
    tools: p.tools ?? [],
    unresolvedTools: p.unresolvedTools ?? [],
    systemPrompt: p.systemPrompt ?? "",
    inputSchema: p.inputSchema,
    outputSchema: p.outputSchema,
  } as GeneratedAgentSpec;
}

describe("deriveContractGraph", () => {
  it("assembles agents + events with producers/consumers and entry/terminal flags", () => {
    const g = deriveContractGraph(
      [
        spec({ actionName: "parseResume", trigger: ["RESUME_DOWNLOADED"], emit: ["RESUME_PROCESSED"] }),
        spec({ actionName: "matchResume", trigger: ["RESUME_PROCESSED"], emit: ["MATCH_PASSED"] }),
      ],
      "rec",
    );
    expect(g.agents).toHaveLength(2);
    const downloaded = g.events.find((e) => e.name === "RESUME_DOWNLOADED")!;
    expect(downloaded.isEntry).toBe(true); // consumed, produced by nobody
    expect(downloaded.consumers).toEqual(["parseResume"]);
    const passed = g.events.find((e) => e.name === "MATCH_PASSED")!;
    expect(passed.isTerminal).toBe(true); // produced, consumed by nobody
    const processed = g.events.find((e) => e.name === "RESUME_PROCESSED")!;
    expect(processed.isEntry).toBe(false);
    expect(processed.isTerminal).toBe(false);
    expect(processed.producers).toEqual(["parseResume"]);
    expect(processed.consumers).toEqual(["matchResume"]);
  });

  it("flags a PAYLOAD GAP: consumer expects a field no producer provides", () => {
    const g = deriveContractGraph(
      [
        spec({
          actionName: "parseResume",
          trigger: ["RESUME_DOWNLOADED"],
          emit: ["RESUME_PROCESSED"],
          // producer puts only `profile` on RESUME_PROCESSED
          outputSchema: [{ field: "profile", type: "object" }],
        }),
        spec({
          actionName: "matchResume",
          trigger: ["RESUME_PROCESSED"],
          emit: ["MATCH_PASSED"],
          // consumer expects candidate_id — which nobody provides
          inputSchema: [
            { field: "profile", type: "object" },
            { field: "candidate_id", type: "string" },
          ],
        }),
      ],
      "rec",
    );
    const gap = g.issues.find((i) => i.kind === "payload_gap");
    expect(gap).toBeTruthy();
    expect(gap).toMatchObject({ event: "RESUME_PROCESSED", missingFields: ["candidate_id"], consumers: ["matchResume"] });
    expect(g.ok).toBe(false);
    // the offending PRODUCER is the one to refine
    expect(Object.keys(contractAgentIssueMap(g))).toContain("parseResume");
    expect(contractIssueStrings(g)[0]).toContain("candidate_id");
  });

  it("is OK when the producer provides every field the consumer expects", () => {
    const g = deriveContractGraph(
      [
        spec({
          actionName: "parseResume",
          trigger: ["RESUME_DOWNLOADED"],
          emit: ["RESUME_PROCESSED"],
          outputSchema: [
            { field: "profile", type: "object" },
            { field: "candidate_id", type: "string" },
          ],
        }),
        spec({
          actionName: "matchResume",
          trigger: ["RESUME_PROCESSED"],
          emit: ["MATCH_PASSED"],
          inputSchema: [{ field: "candidate_id", type: "string" }],
        }),
      ],
      "rec",
    );
    expect(g.issues.filter((i) => i.kind === "payload_gap")).toHaveLength(0);
  });

  it("flags an UNTYPED internal event (producer declared no outputSchema)", () => {
    const g = deriveContractGraph(
      [
        spec({ actionName: "a", trigger: ["E_IN"], emit: ["E_MID"] }), // no outputSchema
        spec({ actionName: "b", trigger: ["E_MID"], emit: ["E_OUT"], inputSchema: [{ field: "x", type: "string" }] }),
      ],
      "rec",
    );
    expect(g.issues.some((i) => i.kind === "untyped_event" && i.event === "E_MID")).toBe(true);
  });

  it("does NOT flag a failure terminal as untyped (signal-only events are fine)", () => {
    const g = deriveContractGraph(
      [spec({ actionName: "ruleCheck", trigger: ["RESUME_PROCESSED"], emit: ["MATCH_RULE_CHECK_FAILED"] })],
      "rec",
    );
    expect(g.issues.some((i) => i.event === "MATCH_RULE_CHECK_FAILED")).toBe(false);
  });

  // R1: canonical event_data is the authoritative payload contract.
  it("CANONICAL fields satisfy a consumer even when the producer under-typed (no false gap)", () => {
    const eventFields = new Map([["RESUME_PROCESSED", [{ field: "candidate_id", type: "string" }]]]);
    const g = deriveContractGraph(
      [
        // producer declares NOTHING, but the event's event_data canonically carries candidate_id
        spec({ actionName: "parseResume", trigger: ["RESUME_DOWNLOADED"], emit: ["RESUME_PROCESSED"] }),
        spec({ actionName: "matchResume", trigger: ["RESUME_PROCESSED"], emit: ["MATCH_PASSED"], inputSchema: [{ field: "candidate_id", type: "string" }] }),
      ],
      "rec",
      eventFields,
    );
    expect(g.issues.filter((i) => i.kind === "payload_gap")).toHaveLength(0);
    expect(g.events.find((e) => e.name === "RESUME_PROCESSED")!.providedFields.map((f) => f.field)).toContain("candidate_id");
  });

  it("CANONICAL grounding still flags a consumer reading a field the event does NOT define", () => {
    const eventFields = new Map([["RESUME_PROCESSED", [{ field: "candidate_id", type: "string" }]]]);
    const g = deriveContractGraph(
      [
        spec({ actionName: "parseResume", trigger: ["RESUME_DOWNLOADED"], emit: ["RESUME_PROCESSED"], outputSchema: [{ field: "candidate_id", type: "string" }] }),
        spec({ actionName: "matchResume", trigger: ["RESUME_PROCESSED"], emit: ["MATCH_PASSED"], inputSchema: [{ field: "salary_expectation", type: "number" }] }),
      ],
      "rec",
      eventFields,
    );
    const gap = g.issues.find((i) => i.kind === "payload_gap");
    expect(gap).toMatchObject({ event: "RESUME_PROCESSED", missingFields: ["salary_expectation"] });
  });

  // #COMMS Hole 1 — an untyped internal event now carries WHAT the consumers need (legibility).
  it("untyped_event reports the consumers + the fields they expect (not just the producer)", () => {
    const g = deriveContractGraph(
      [
        spec({ actionName: "a", trigger: ["E_IN"], emit: ["E_MID"] }), // untyped producer
        spec({ actionName: "b", trigger: ["E_MID"], emit: ["E_OUT"], inputSchema: [{ field: "job_requisition_id", type: "string" }] }),
      ],
      "rec",
    );
    const u = g.issues.find((i) => i.kind === "untyped_event" && i.event === "E_MID");
    expect(u).toMatchObject({ consumers: ["b"], expectedFields: ["job_requisition_id"] });
    expect(contractIssueStrings(g).some((s) => s.includes("job_requisition_id"))).toBe(true);
  });

  // #COMMS Hole 2 — a field used across an edge that the ontology's canonical event_data doesn't
  // declare (AI-invented / off-contract) is surfaced, but SOFT (doesn't fail the graph — the runtime
  // envelope carries it; it's a hygiene signal).
  it("flags a NON-CANONICAL field (off the ontology's event_data) as a soft warning", () => {
    const eventFields = new Map([["RESUME_PROCESSED", [{ field: "candidate_id", type: "string" }]]]);
    const g = deriveContractGraph(
      [
        // producer + consumer both use `resume_score`, which the event's canonical event_data omits
        spec({ actionName: "parseResume", trigger: ["RESUME_DOWNLOADED"], emit: ["RESUME_PROCESSED"], outputSchema: [{ field: "candidate_id", type: "string" }, { field: "resume_score", type: "number" }] }),
        spec({ actionName: "matchResume", trigger: ["RESUME_PROCESSED"], emit: ["MATCH_PASSED"], inputSchema: [{ field: "candidate_id", type: "string" }, { field: "resume_score", type: "number" }] }),
      ],
      "rec",
      eventFields,
    );
    // no payload_gap (resume_score IS provided by the producer) → contract still OK...
    expect(g.issues.filter((i) => i.kind === "payload_gap")).toHaveLength(0);
    expect(g.ok).toBe(true); // non_canonical is soft
    // ...but the off-contract field is now VISIBLE (was silently accepted before).
    const nc = g.issues.filter((i) => i.kind === "non_canonical_field");
    expect(nc.length).toBeGreaterThan(0);
    expect(nc.every((i) => i.fields.includes("resume_score"))).toBe(true);
    expect(nc.some((i) => i.side === "producer") && nc.some((i) => i.side === "consumer")).toBe(true);
    expect(contractIssueStrings(g).some((s) => s.includes("超出本体约定") && s.includes("resume_score"))).toBe(true);
    // the offending agents are refinable
    const map = contractAgentIssueMap(g);
    expect(Object.keys(map)).toEqual(expect.arrayContaining(["parseResume", "matchResume"]));
  });

  it("does NOT flag non-canonical when the event has no canonical contract (nothing to be off)", () => {
    const g = deriveContractGraph(
      [
        spec({ actionName: "a", trigger: ["E_IN"], emit: ["E_MID"], outputSchema: [{ field: "whatever", type: "string" }] }),
        spec({ actionName: "b", trigger: ["E_MID"], emit: ["E_OUT"], inputSchema: [{ field: "whatever", type: "string" }] }),
      ],
      "rec",
      // no eventFields map → no canonical contract for E_MID
    );
    expect(g.issues.some((i) => i.kind === "non_canonical_field")).toBe(false);
  });
});
