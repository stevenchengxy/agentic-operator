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
      actions: [{
        name: "createJD",
        actor: ["Agent"],
        trigger: ["REQUIREMENT_LOGGED"],
        emit: ["JD_GENERATED"],
        tool_use: ["parseJdApi"],
        instruction: "读取权威需求后生成 JD",
        on_success: "emit_jd_generated",
        on_failure: "fail_without_emit",
      }],
      events: [{ name: "JD_GENERATED" }],
      rules: [{ id: "1-1", text: "desensitize" }],
      dataObjects: [{ id: "Job", name: "职位" }],
      links: [{
        id: "createJD-emits-JD_GENERATED",
        kind: "action-emission",
        status: "approved",
        from: { type: "Action", id: "createJD" },
        to: { type: "Event", id: "JD_GENERATED" },
      }],
    });
    expect(ontology.domainId).toBe(slugifyDomain("Hiring Demo"));
    expect(ontology.source).toBe("snapshot");
    expect(ontology.actions).toHaveLength(1);
    expect(ontology.actions[0]!.triggered_event).toEqual(["JD_GENERATED"]); // emit → triggered_event
    expect(ontology.actions[0]!.tool_use).toEqual(["parseJdApi"]);
    expect(ontology.actions[0]).toMatchObject({
      instruction: "读取权威需求后生成 JD",
      on_success: "emit_jd_generated",
      on_failure: "fail_without_emit",
    });
    expect(ontology.objects).toHaveLength(1); // dataObjects → objects
    expect(ontology.events).toHaveLength(1);
    expect(ontology.rules).toHaveLength(1);
    expect(ontology.links).toEqual([
      expect.objectContaining({ id: "createJD-emits-JD_GENERATED", kind: "action-emission" }),
    ]);
    expect(meta.counts.actions).toBe(1);
  });

  it("accepts `objects` and `triggered_event` spellings too", () => {
    const { ontology } = normalizeBundle("d", { actions: [{ name: "a", actor: ["Agent"], triggered_event: ["E"] }], objects: [{ id: "O", name: "o" }] });
    expect(ontology.actions[0]!.triggered_event).toEqual(["E"]);
    expect(ontology.objects).toHaveLength(1);
  });

  it("distinguishes a legacy bundle with no links from an explicit links collection", () => {
    const legacy = normalizeBundle("legacy", { actions: [{ name: "a", actor: ["Agent"] }] });
    const modern = normalizeBundle("modern", { actions: [{ name: "a", actor: ["Agent"] }], links: [] });
    expect(legacy.ontology.links).toBeUndefined();
    expect(modern.ontology.links).toEqual([]);
  });

  it("attaches to a forced domainId (upload → the selected 业务域), independent of the display name", () => {
    // name "RAAS-v1" would slugify to "raas-v1"; forcing domainId "raas" stores it UNDER "raas" so it
    // shadows/updates the selected domain, while the display name stays "RAAS-v1".
    const { ontology, meta } = normalizeBundle("RAAS-v1", { actions: [{ name: "a", actor: ["Agent"], triggered_event: ["E"] }] }, "raas");
    expect(ontology.domainId).toBe("raas");
    expect(meta.id).toBe("raas");
    expect(meta.name).toBe("RAAS-v1");
    // A forced id is the catalog's canonical identity; only the backing filename is sanitized.
    expect(normalizeBundle("x", { actions: [{ name: "a", actor: ["Agent"] }] }, "Agents-Generation").ontology.domainId).toBe("Agents-Generation");
  });

  it("throws (fail-closed) on a bundle with no actions", () => {
    expect(() => normalizeBundle("empty", { events: [], rules: [] })).toThrow();
    expect(() => normalizeBundle("garbage", "not an object")).toThrow();
  });

  it("rejects incomplete or structurally invalid actions instead of inventing runtime metadata", () => {
    expect(() => normalizeBundle("missing-name", { actions: [{ actor: ["Agent"] }] })).toThrow(/name or id/);
    expect(() => normalizeBundle("missing-actor", { actions: [{ name: "run" }] })).toThrow(/actor is required/);
    expect(() => normalizeBundle("bad-actor", { actions: [{ name: "run", actor: [{}] }] })).toThrow(/without a name\/id/);
    expect(() => normalizeBundle("bad-inputs", { actions: [{ name: "run", actor: ["Agent"], inputs: {} }] })).toThrow(/inputs must be an array/);
    expect(() => normalizeBundle("bad-actions", { actions: { name: "run" } })).toThrow(/actions must be an array/);
    expect(() => normalizeBundle("bad-events", { actions: [{ name: "run", actor: ["Agent"] }], events: ["E"] })).toThrow(/events entries must be objects/);
  });

  it("gives CJK-only names a stable, NON-colliding id", () => {
    const a = slugifyDomain("我的招聘域");
    const b = slugifyDomain("另一个域");
    expect(a).not.toBe(b); // distinct names → distinct ids (no 'uploaded' collision)
    expect(slugifyDomain("我的招聘域")).toBe(a); // stable across calls
  });
});
