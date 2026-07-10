import { describe, it, expect } from "vitest";
import { rankRealTools, suggestToolsForAction, searchRealTools, toolSideEffect, type RealTool } from "./tool-catalog";
import type { OntologyAction } from "./ontology-types";

// #C — intelligent tool recommendation: an ontology ACTION maps to the right REAL tool by semantic
// rank, even when the ontology declared no tool_use[]. This is the "parseResume → parseResumeApi"
// capability the old AO had and the new AO had lost (it only echoed declared names).
const REAL: RealTool[] = [
  { name: "robohire.parseResumeApi", summary: "Turn a resume PDF into structured candidate fields", configKeys: ["api_key_env"], category: "robohire" },
  { name: "robohire.matchResumeApi", summary: "Score a resume against a job description", category: "robohire" },
  { name: "fs.readFromInbox", summary: "Read a file from the inbox folder", category: "fs" },
  { name: "ontology.fetchActionRules", summary: "Fetch the executor=Agent rules for an action", category: "ontology" },
];
const action = (name: string, objs: string[], declared: string[] = []): OntologyAction =>
  ({ id: name, name, target_objects: objs, tool_use: declared, actor: ["Agent"], trigger: [], triggered_event: [], system_prompt: "", user_prompt: "" });

describe("rankRealTools (#C)", () => {
  it("maps a parse-resume action to parseResumeApi even with NO declared tools", () => {
    expect(rankRealTools(action("parseResume", ["Resume"]), REAL)[0]).toBe("robohire.parseResumeApi");
  });
  it("maps a match action to matchResumeApi", () => {
    expect(rankRealTools(action("matchResume", ["Resume", "Job"]), REAL)[0]).toBe("robohire.matchResumeApi");
  });
  it("returns [] gracefully when there is no real registry", () => {
    expect(rankRealTools(action("parseResume", ["Resume"]), [])).toEqual([]);
  });
});

describe("suggestToolsForAction (#C — declared first, then ranked real)", () => {
  it("keeps declared tools first and appends the ranked real tools", () => {
    const sug = suggestToolsForAction(action("parseResume", ["Resume"], ["customTool"]), REAL);
    expect(sug[0]).toBe("customTool");
    expect(sug).toContain("robohire.parseResumeApi");
  });
});

describe("searchRealTools (#P3 — progressive tool discovery)", () => {
  it("finds a tool by natural-language intent (resume parsing → parseResumeApi)", () => {
    const hits = searchRealTools("parse resume pdf", REAL);
    expect(hits[0]?.name).toBe("robohire.parseResumeApi");
    expect(hits[0]?.configKeys).toContain("api_key_env");
  });
  it("filters by category (browse mode lists even with weak token overlap)", () => {
    const hits = searchRealTools("anything", REAL, { category: "robohire" });
    expect(hits.length).toBe(2);
    expect(hits.every((h) => h.name.startsWith("robohire."))).toBe(true);
  });
  it("returns [] for an unrelated query with no filter", () => {
    expect(searchRealTools("quantum teleportation", REAL)).toEqual([]);
  });
  it("derives side-effect class from name/category", () => {
    expect(toolSideEffect({ name: "robohire.parseResumeApi" })).toBe("read");
    expect(toolSideEffect({ name: "robohire.inviteCandidateApi" })).toBe("write");
    expect(toolSideEffect({ name: "fs.readFromInbox" })).toBe("read");
  });
});
