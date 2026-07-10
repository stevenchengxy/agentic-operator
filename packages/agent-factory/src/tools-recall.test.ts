import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";

// #4 — targeted ontology recall so a compacted brain can recover detail without a full re-fetch.
const describeObject = FACTORY_TOOLS.find((t) => t.name === "describe_object")!;

const ctxWith = (objects: unknown[]): BrainCtx =>
  ({ ontology: { domainId: "D", objects, actions: [], events: [], rules: [], workflow: [], source: "allmeta" } }) as unknown as BrainCtx;

describe("describe_object (#4 recall tool)", () => {
  it("is registered in FACTORY_TOOLS", () => {
    expect(describeObject).toBeTruthy();
  });

  it("returns a DataObject's primary_key + full properties from the cached ontology", async () => {
    const c = ctxWith([{ id: "Candidate", name: "候选人", primary_key: "candidate_id", properties: [{ name: "candidate_id", type: "string" }, { name: "phone", type: "string" }] }]);
    const r = await describeObject.execute({ name: "Candidate" }, c);
    expect(r.ok).toBe(true);
    const out = r.output as { primary_key: string; properties: Array<{ name: string }> };
    expect(out.primary_key).toBe("candidate_id");
    expect(out.properties.map((p) => p.name)).toEqual(["candidate_id", "phone"]);
  });

  it("matches by display name and falls back to a substring match", async () => {
    const c = ctxWith([{ id: "Candidate", name: "候选人", properties: [] }]);
    expect((await describeObject.execute({ name: "候选人" }, c)).ok).toBe(true);
    expect((await describeObject.execute({ name: "cand" }, c)).ok).toBe(true);
  });

  it("fails clearly (listing real names) when the object isn't found", async () => {
    const r = await describeObject.execute({ name: "Nope" }, ctxWith([{ id: "Candidate", name: "候选人", properties: [] }]));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("找不到对象");
    expect(r.summary).toContain("候选人");
  });

  it("requires read_ontology first (no cached ontology)", async () => {
    const r = await describeObject.execute({ name: "X" }, { ontology: null } as unknown as BrainCtx);
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("read_ontology");
  });
});
