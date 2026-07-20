import { describe, expect, it } from "vitest";
import type { BrainCtx } from "./brain-types";
import type { GeneratedAgentSpec } from "./spec-types";
import { ensureCoverage } from "./test-cases";

describe("decision-table coverage matrix", () => {
  it("prepends exact 39/40/missing cases and records their cells", () => {
    const spec = {
      actionName: "match",
      short: "MatchAgent",
      trigger: ["MATCH_REQUESTED"],
      emit: ["MATCH_FAILED", "MATCH_PASSED", "MATCH_REVIEW"],
      tools: [],
      decisionTables: [{
        id: "score",
        rows: [
          { id: "low", all: [{ path: "score", op: "lt", value: 40 }], outcome: "reject", emitEvent: "MATCH_FAILED" },
          { id: "pass", all: [{ path: "score", op: "gte", value: 40 }], outcome: "pass", emitEvent: "MATCH_PASSED" },
        ],
        missing: { outcome: "review", emitEvent: "MATCH_REVIEW" },
        default: { outcome: "review", emitEvent: "MATCH_REVIEW" },
      }],
    } as unknown as GeneratedAgentSpec;
    const ctx = {
      specs: [spec],
      ontology: {
        objects: [], rules: [], actions: [], workflow: [], source: "allmeta", domainId: "d",
        events: [{ name: "MATCH_REQUESTED", payload: { source_action: null, event_data: [{ name: "score", type: "Number", target_object: null }], state_mutations: [] } }],
      },
    } as unknown as BrainCtx;
    const { cases, coverage } = ensureCoverage(ctx, []);
    expect(cases.slice(0, 3).map((testCase) => testCase.payload.score)).toEqual([39, 40, undefined]);
    expect(cases.slice(0, 3).map((testCase) => testCase.expectedEvent)).toEqual(["MATCH_FAILED", "MATCH_PASSED", "MATCH_REVIEW"]);
    expect(coverage.required).toEqual(expect.arrayContaining([
      "decision:match:score:low",
      "decision:match:score:pass",
      "decision:match:score:missing",
    ]));
  });
});
