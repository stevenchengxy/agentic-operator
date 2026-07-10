import { describe, it, expect } from "vitest";
import { attributeFidelityFailures, attributionSummary } from "./failure-attribution";
import type { ExecutionFidelity } from "./execution-fidelity";
import type { ContractGraph } from "./contract";

const graph = {
  domain: "d",
  agents: [],
  issues: [],
  ok: true,
  events: [
    { name: "RESUME_PROCESSED", producers: ["processResume"], consumers: ["matchResume", "identityCheck"], providedFields: [], expectedFields: [], isEntry: false, isTerminal: false, isFailure: false },
  ],
} as unknown as ContractGraph;

const fid = (failed: ExecutionFidelity["failed"]): ExecutionFidelity => ({
  evaluated: failed.length,
  passed: 0,
  failed,
  perAgent: failed,
  fidelity: 0,
  failingShorts: failed.map((f) => f.agentShort),
  ok: failed.length === 0,
});

describe("attributeFidelityFailures (#ATTRIB)", () => {
  it("missing authoritative field → refine_producer with affected consumers named", () => {
    const [e] = attributeFidelityFailures(
      fid([{ agentSlug: "d-pr", agentShort: "processResume", outputEvent: "RESUME_PROCESSED", ok: false, errors: [{ field: "candidate_id", kind: "missing", expectedType: "string" }] }]),
      graph,
    );
    expect(e).toMatchObject({ recommend: "refine_producer", agentShort: "processResume", affectedConsumers: ["matchResume", "identityCheck"] });
    expect(e!.instruction).toContain("缺权威字段");
    expect(e!.instruction).toContain("candidate_id");
    expect(e!.instruction).toContain("matchResume");
  });

  it("type mismatch → align_contract naming both sides' types", () => {
    const [e] = attributeFidelityFailures(
      fid([{ agentSlug: "d-pr", agentShort: "processResume", outputEvent: "RESUME_PROCESSED", ok: false, errors: [{ field: "score", kind: "type_mismatch", expectedType: "number", actualType: "string" }] }]),
      graph,
    );
    expect(e!.recommend).toBe("align_contract");
    expect(e!.instruction).toContain("string≠number");
  });

  it("payload not an object → refine_producer", () => {
    const [e] = attributeFidelityFailures(
      fid([{ agentSlug: "d-pr", agentShort: "processResume", outputEvent: "RESUME_PROCESSED", ok: false, errors: [{ field: "*", kind: "not_object", actualType: "string" }] }]),
      graph,
    );
    expect(e!.recommend).toBe("refine_producer");
    expect(e!.instruction).toContain("不是对象");
  });

  it("summary block is empty when nothing failed, structured when something did", () => {
    expect(attributionSummary([])).toBe("");
    const entries = attributeFidelityFailures(
      fid([
        { agentSlug: "d-b", agentShort: "bAgent", outputEvent: "RESUME_PROCESSED", ok: false, errors: [{ field: "x", kind: "missing", expectedType: "string" }] },
        { agentSlug: "d-a", agentShort: "aAgent", outputEvent: "RESUME_PROCESSED", ok: false, errors: [{ field: "y", kind: "missing", expectedType: "string" }] },
      ]),
      graph,
    );
    // deterministic ordering by agentShort
    expect(entries.map((e) => e.agentShort)).toEqual(["aAgent", "bAgent"]);
    const s = attributionSummary(entries);
    expect(s).toContain("保真违约定位");
    expect(s).toContain("1. ");
    expect(s).toContain("2. ");
  });
});
