import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS, applyTestDataOverrides } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { GeneratedAgentSpec } from "./spec-types";
import type { TestCase } from "./brain-types";

// supply_test_data: real contact/credential/id fields (e.g. an interview email) must be collectable
// from the user and threaded into the fired test payloads instead of demo placeholders.

const supply = FACTORY_TOOLS.find((t) => t.name === "supply_test_data")!;

function spec(actionName: string, inputSchema: Array<{ field: string; type: string }>): GeneratedAgentSpec {
  return {
    key: actionName, actionName, slug: `d-${actionName}`, short: actionName, domainId: "rec", nameZh: actionName,
    kind: "llm", trigger: [], emit: [], tools: ["x"], unresolvedTools: [], objects: [], systemPrompt: "p",
    userPrompt: "", steps: [], ruleRefs: [], retries: 1, hitl: false, confidence: 1, promptSource: "llm", inputSchema,
  } as unknown as GeneratedAgentSpec;
}

function ctx(specs: GeneratedAgentSpec[], testCases: TestCase[]): BrainCtx {
  return { specs, testCases, emit: () => {} } as unknown as BrainCtx;
}

const tc = (payload: Record<string, unknown>): TestCase => ({ id: "tc1", name: "case", scenario: "s", kind: "pass", entryEvent: "E", payload, expectedOutcome: "ok" });

describe("applyTestDataOverrides", () => {
  it("overrides only keys already present in the payload (never injects foreign fields)", () => {
    const out = applyTestDataOverrides({ candidate_email: "talent@example.com", other: 1 }, { candidate_email: "real@me.com", ghost: "x" });
    expect(out.candidate_email).toBe("real@me.com");
    expect(out.other).toBe(1);
    expect("ghost" in out).toBe(false);
  });
  it("is a no-op when there are no overrides", () => {
    const p = { a: 1 };
    expect(applyTestDataOverrides(p, undefined)).toBe(p);
  });
});

describe("supply_test_data — scan/ask mode", () => {
  it("detects a real contact field on a placeholder and PARKS for the user's value", async () => {
    const c = ctx([spec("invite", [{ field: "candidate_email", type: "string" }])], [tc({ candidate_email: "talent@example.com" })]);
    const r = await supply.execute({}, c);
    expect(r.ok).toBe(true);
    expect((r.output as { needs: unknown[] }).needs.length).toBe(1);
    expect(c.awaitingClarify).toBe(true); // parked waiting for the user
    expect(c.clarifyPrompt?.question).toContain("candidate_email");
  });

  it("returns cleanly (no park) when there are no real-data fields", async () => {
    const c = ctx([spec("createJD", [{ field: "title", type: "string" }])], [tc({ title: "Senior Engineer" })]);
    const r = await supply.execute({}, c);
    expect(r.ok).toBe(true);
    expect((r.output as { needs: unknown[] }).needs.length).toBe(0);
    expect(c.awaitingClarify).toBeFalsy();
  });
});

describe("supply_test_data — apply mode", () => {
  it("threads the user's real value into every matching test payload + records the override", async () => {
    const c = ctx([spec("invite", [{ field: "candidate_email", type: "string" }])], [tc({ candidate_email: "talent@example.com", role: "eng" })]);
    const r = await supply.execute({ values: { candidate_email: "stevenchengxy19@gmail.com" } }, c);
    expect(r.ok).toBe(true);
    expect(c.testCases![0]!.payload.candidate_email).toBe("stevenchengxy19@gmail.com");
    expect(c.testCases![0]!.payload.role).toBe("eng"); // untouched
    expect(c.testDataOverrides?.candidate_email).toBe("stevenchengxy19@gmail.com");
    expect(c.awaitingClarify).toBe(false);
  });

  it("requires test cases to exist first", async () => {
    const c = { specs: [], emit: () => {} } as unknown as BrainCtx;
    const r = await supply.execute({ values: { x: 1 } }, c);
    expect(r.ok).toBe(false);
  });
});
