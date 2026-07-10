import { describe, it, expect } from "vitest";
import { buildOntologyBundle, classifyAttachment, stripExt } from "./ontology-upload";

const file = (name: string, obj: unknown) => ({ name, text: JSON.stringify(obj) });

describe("buildOntologyBundle", () => {
  it("reads actions/events/rules/dataObjects from one object file", () => {
    const r = buildOntologyBundle([
      file("bundle.json", { actions: [{ name: "a" }, { name: "b" }], events: [{ name: "E" }], rules: [{ id: "r" }], dataObjects: [{ name: "O" }] }),
    ]);
    expect(r.actionCount).toBe(2);
    expect(r.eventCount).toBe(1);
    expect(r.ruleCount).toBe(1);
    expect(r.objectCount).toBe(1);
    expect(r.skipped).toEqual([]);
    expect(r.used).toEqual(["bundle.json"]);
  });

  it("honours singular/alt keys (action/event/rule/objects/entities)", () => {
    const r = buildOntologyBundle([file("x.json", { action: [{ name: "a" }], event: [{ name: "E" }], rule: [{ id: "r" }], entities: [{ name: "O" }] })]);
    expect(r.actionCount).toBe(1);
    expect(r.eventCount).toBe(1);
    expect(r.ruleCount).toBe(1);
    expect(r.objectCount).toBe(1);
  });

  it("routes a bare ARRAY file into a bucket by filename", () => {
    expect(buildOntologyBundle([file("job.events.json", [{ name: "E" }])]).eventCount).toBe(1);
    expect(buildOntologyBundle([file("policy.rules.json", [{ id: "r" }])]).ruleCount).toBe(1);
    expect(buildOntologyBundle([file("entities.json", [{ name: "O" }])]).objectCount).toBe(1);
    // no keyword in name → actions
    expect(buildOntologyBundle([file("resume.json", [{ name: "a" }])]).actionCount).toBe(1);
  });

  it("MERGES multiple split files into one bundle (the actions.json + events.json case)", () => {
    const r = buildOntologyBundle([
      file("actions.json", [{ name: "a1" }, { name: "a2" }]),
      file("events.json", [{ name: "E1" }]),
      file("rules.json", [{ id: "r1" }]),
    ]);
    expect(r.actionCount).toBe(2);
    expect(r.eventCount).toBe(1);
    expect(r.ruleCount).toBe(1);
    expect(r.used).toHaveLength(3);
  });

  it("collects non-JSON files into skipped (never silently dropped)", () => {
    const r = buildOntologyBundle([
      { name: "good.json", text: JSON.stringify({ actions: [{ name: "a" }] }) },
      { name: "broken.json", text: "{ not json ," },
      { name: "notes.txt", text: "hello world" },
    ]);
    expect(r.actionCount).toBe(1);
    expect(r.skipped).toEqual(["broken.json", "notes.txt"]);
    expect(r.used).toEqual(["good.json"]);
  });

  it("returns zero actions for an empty/no-action upload (caller rejects → backend would too)", () => {
    expect(buildOntologyBundle([file("empty.json", { events: [{ name: "E" }] })]).actionCount).toBe(0);
    expect(buildOntologyBundle([]).actionCount).toBe(0);
  });
});

describe("classifyAttachment", () => {
  it("classifies an ontology-shaped object as ontology", () => {
    expect(classifyAttachment("x.json", JSON.stringify({ actions: [{ name: "a" }] }))).toBe("ontology");
    expect(classifyAttachment("x.json", JSON.stringify({ events: [] }))).toBe("ontology");
  });

  it("classifies an action-like array as ontology", () => {
    expect(classifyAttachment("acts.json", JSON.stringify([{ trigger: ["E"], name: "a" }]))).toBe("ontology");
    // array of objects whose FILENAME implies ontology
    expect(classifyAttachment("my-actions.json", JSON.stringify([{ name: "a" }]))).toBe("ontology");
    // bare actions array with a GENERIC filename + no action-signal fields (regression: this must
    // still be ontology so 📎 can create a domain — the old modal supported it).
    expect(classifyAttachment("list.json", JSON.stringify([{ name: "createJob" }, { name: "closeJob" }]))).toBe("ontology");
    expect(classifyAttachment("x.json", JSON.stringify([{ id: "a1" }]))).toBe("ontology");
  });

  it("classifies OpenAPI / prose / non-ontology JSON as tooldoc", () => {
    expect(classifyAttachment("api.json", JSON.stringify({ openapi: "3.0", paths: {} }))).toBe("tooldoc");
    expect(classifyAttachment("readme.md", "# How to use the CRM API\ncall POST /candidates")).toBe("tooldoc");
    expect(classifyAttachment("data.json", JSON.stringify([1, 2, 3]))).toBe("tooldoc");
    // an array of records with NO name/id and NO signal fields stays a tool/data doc
    expect(classifyAttachment("rows.json", JSON.stringify([{ foo: 1 }, { bar: 2 }]))).toBe("tooldoc");
  });
});

describe("stripExt", () => {
  it("drops a single trailing extension", () => {
    expect(stripExt("招聘本体.json")).toBe("招聘本体");
    expect(stripExt("a.b.json")).toBe("a.b");
    expect(stripExt("noext")).toBe("noext");
  });
});
