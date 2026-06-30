/**
 * TC-100 — uploaded Ontology bundle normalization: a hand-authored {actions,events,rules,dataObjects}
 * JSON becomes a valid DomainOntology (reusable local domain), and an empty/action-less bundle is
 * refused (fail-closed — the factory must not generate against an empty stub).
 */

import { describe, it, expect } from "vitest";
import { normalizeBundle, slugifyDomain } from "../src/services/agent-factory/uploaded-ontology-store";

describe("TC-100: ontology upload normalize", () => {
  it("normalizes a {actions, events, rules, dataObjects} bundle into a DomainOntology", () => {
    const { ontology, meta } = normalizeBundle("Hiring Demo", {
      actions: [{ name: "createJD", trigger: ["REQUIREMENT_LOGGED"], emit: ["JD_GENERATED"], tool_use: ["parseJdApi"] }],
      events: [{ name: "JD_GENERATED" }],
      rules: [{ id: "1-1", text: "desensitize" }],
      dataObjects: [{ id: "Job", name: "职位" }],
    });
    expect(ontology.domainId).toBe(slugifyDomain("Hiring Demo"));
    expect(ontology.source).toBe("snapshot");
    expect(ontology.actions).toHaveLength(1);
    expect(ontology.actions[0]!.triggered_event).toEqual(["JD_GENERATED"]); // emit → triggered_event
    expect(ontology.actions[0]!.tool_use).toEqual(["parseJdApi"]);
    expect(ontology.objects).toHaveLength(1); // dataObjects → objects
    expect(ontology.events).toHaveLength(1);
    expect(ontology.rules).toHaveLength(1);
    expect(meta.counts.actions).toBe(1);
  });

  it("accepts `objects` and `triggered_event` spellings too", () => {
    const { ontology } = normalizeBundle("d", { actions: [{ name: "a", triggered_event: ["E"] }], objects: [{ id: "O", name: "o" }] });
    expect(ontology.actions[0]!.triggered_event).toEqual(["E"]);
    expect(ontology.objects).toHaveLength(1);
  });

  it("throws (fail-closed) on a bundle with no actions", () => {
    expect(() => normalizeBundle("empty", { events: [], rules: [] })).toThrow();
    expect(() => normalizeBundle("garbage", "not an object")).toThrow();
  });

  it("gives CJK-only names a stable, NON-colliding id", () => {
    const a = slugifyDomain("我的招聘域");
    const b = slugifyDomain("另一个域");
    expect(a).not.toBe(b); // distinct names → distinct ids (no 'uploaded' collision)
    expect(slugifyDomain("我的招聘域")).toBe(a); // stable across calls
  });
});
