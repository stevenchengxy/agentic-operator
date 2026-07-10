import { describe, it, expect } from "vitest";
import { proposeOntologyRevisions, revisionSummary } from "./ontology-revision";
import type { AgentRunIO } from "./brain-types";

const run = (outputEvent: string, outputPayload: Record<string, unknown>, over: Partial<AgentRunIO> = {}): AgentRunIO =>
  ({ agentSlug: "d-a", agentShort: "a", status: "ok", degraded: false, triggerEvent: "E_IN", inputPayload: null, tools: [], outputEvent, reasoning: "", outputPayload, runId: "r", url: "", ...over }) as AgentRunIO;

const canonical = new Map([
  ["RESUME_PROCESSED", [
    { field: "candidate_id", type: "string" },
    { field: "score", type: "string" }, // 本体声明 string，但真实一直是 number → retype 证据
  ]],
]);

describe("proposeOntologyRevisions (#REVISION)", () => {
  it("consistent type drift → retype_field; consistently-carried unknown field → add_field", () => {
    const props = proposeOntologyRevisions(
      [
        run("RESUME_PROCESSED", { candidate_id: "c1", score: 88, client_id: "cl-1" }),
        run("RESUME_PROCESSED", { candidate_id: "c2", score: 92, client_id: "cl-2" }),
      ],
      canonical,
    );
    const retype = props.find((p) => p.kind === "retype_field")!;
    expect(retype).toMatchObject({ event: "RESUME_PROCESSED", field: "score", observedType: "number", canonicalType: "string", occurrences: 2 });
    const add = props.find((p) => p.kind === "add_field")!;
    expect(add).toMatchObject({ field: "client_id", observedType: "string", occurrences: 2 });
    // retype（更危险的漂移）排在前面
    expect(props[0]!.kind).toBe("retype_field");
  });

  it("contradictory observations do NOT propose (宁缺毋滥)", () => {
    const props = proposeOntologyRevisions(
      [run("RESUME_PROCESSED", { score: 88 }), run("RESUME_PROCESSED", { score: "high" })],
      canonical,
    );
    expect(props.find((p) => p.field === "score")).toBeUndefined();
  });

  it("matching types, envelope/meta fields, null values, unknown events → no proposals", () => {
    const props = proposeOntologyRevisions(
      [
        run("RESUME_PROCESSED", { candidate_id: "c1", _meta: { v: 1 }, reasoning: "x", empty: null }),
        run("UNKNOWN_EVENT", { anything: 1 }), // canonical 没有这个事件 → 无从对账
      ],
      canonical,
    );
    expect(props).toEqual([]);
  });

  it("degraded runs and non-object payloads are skipped as evidence", () => {
    const props = proposeOntologyRevisions(
      [run("RESUME_PROCESSED", { score: 88 }, { degraded: true }), run("RESUME_PROCESSED", null as unknown as Record<string, unknown>)],
      canonical,
    );
    expect(props).toEqual([]);
  });

  it("revisionSummary guides ask_user confirmation and never自作主张", () => {
    const props = proposeOntologyRevisions([run("RESUME_PROCESSED", { score: 88 })], canonical);
    const s = revisionSummary(props);
    expect(s).toContain("本体修订提案");
    expect(s).toContain("ask_user");
    expect(s).toContain("别硬改 agent");
    expect(revisionSummary([])).toBe("");
  });
});
