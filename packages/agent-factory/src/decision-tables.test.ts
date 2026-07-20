import { describe, expect, it } from "vitest";
import { deriveDecisionBoundaryFixtures, parseDecisionTables } from "./decision-tables";
import { evaluateDecisionTable } from "@agentic/shared";

describe("factory decision tables", () => {
  const raw = [{
    id: "score",
    rows: [
      { id: "low", all: [{ path: "score", op: "lt", value: 40 }], outcome: "reject", emitEvent: "FAILED" },
      { id: "ok", all: [{ path: "score", op: "gte", value: 40 }], outcome: "pass", emitEvent: "PASSED" },
    ],
    missing: { outcome: "review", emitEvent: "REVIEW" },
    default: { outcome: "review", emitEvent: "REVIEW" },
  }];

  it("parses only declared events", () => {
    expect(parseDecisionTables(raw, { declaredEvents: ["FAILED", "PASSED", "REVIEW"] }).ok).toBe(true);
    const invalid = parseDecisionTables(raw, { declaredEvents: ["FAILED"] });
    expect(invalid.ok).toBe(false);
  });

  it("derives 39/40/missing boundary fixtures", () => {
    const parsed = parseDecisionTables(raw, { declaredEvents: ["FAILED", "PASSED", "REVIEW"] });
    if (!parsed.ok) throw new Error(parsed.errors.join(";"));
    const cases = deriveDecisionBoundaryFixtures("match", parsed.tables, { score: 99, id: "x" });
    expect(cases.map((entry) => entry.payload.score)).toEqual([39, 40, undefined]);
    expect(cases.map((entry) => entry.expectedEvent)).toEqual(["FAILED", "PASSED", "REVIEW"]);
  });

  it("executes the same first-match table deterministically", () => {
    const parsed = parseDecisionTables(raw, { declaredEvents: ["FAILED", "PASSED", "REVIEW"] });
    if (!parsed.ok) throw new Error(parsed.errors.join(";"));
    expect(evaluateDecisionTable(parsed.tables[0]!, { input: { score: 39 } })).toMatchObject({ rowId: "low", emitEvent: "FAILED" });
    expect(evaluateDecisionTable(parsed.tables[0]!, { input: { score: 40 } })).toMatchObject({ rowId: "ok", emitEvent: "PASSED" });
    expect(evaluateDecisionTable(parsed.tables[0]!, { input: {} })).toMatchObject({ rowId: "__missing__", emitEvent: "REVIEW" });
  });
});
