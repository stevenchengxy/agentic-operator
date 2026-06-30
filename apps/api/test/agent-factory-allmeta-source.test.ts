/**
 * AllmetaOntologySource + CompositeOntologySource — the live AllmetaOntology
 * ontology source (Studio HTTP API at :3500) and the composite that routes the
 * factory between local models/ domains and live Allmeta domains
 * (e.g. "Agents-generation").
 *
 * Pure-unit: the HTTP path is exercised with a stubbed global fetch, so this never
 * touches a real Studio, the DB, or the test harness.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import type { OntologySource, DomainOntology } from "@agentic/agent-factory";
import {
  parseJsonField,
  normDomainId,
  dedupeActionsByName,
  buildEmitByAction,
  normalizeAllmetaAction,
  normalizeAllmetaEvent,
  normalizeAllmetaObject,
  AllmetaOntologySource,
} from "../src/services/agent-factory/allmeta-ontology-source";
import { CompositeOntologySource } from "../src/services/agent-factory/composite-ontology-source";

// ── fetch stub ──────────────────────────────────────────────────────────────
type Body = Record<string, unknown>;
/** Stub global fetch: pick the first route whose substring is in the URL. */
function stubFetch(routes: Array<[string, Body]>, opts?: { failAll?: boolean }) {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (opts?.failAll) return { ok: false, json: async () => ({}) } as Response;
    for (const [needle, body] of routes) {
      if (url.includes(needle)) return { ok: true, json: async () => body } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
}
afterEach(() => vi.unstubAllGlobals());

const cfg = { baseUrl: "http://localhost:3500", apiKey: "abc123", timeoutMs: 2000 };

describe("parseJsonField", () => {
  it("parses a stringified array", () => {
    expect(parseJsonField('["a","b"]', [] as string[])).toEqual(["a", "b"]);
  });
  it("passes an object through", () => {
    expect(parseJsonField({ x: 1 }, {} as Body)).toEqual({ x: 1 });
  });
  it("falls back on invalid JSON", () => {
    expect(parseJsonField("{not json", [] as string[])).toEqual([]);
  });
  it("falls back when an array is expected but an object arrives (type guard)", () => {
    expect(parseJsonField('{"x":1}', [] as string[])).toEqual([]);
  });
  it("falls back on null/undefined", () => {
    expect(parseJsonField(null, ["d"])).toEqual(["d"]);
    expect(parseJsonField(undefined, 7)).toBe(7);
  });
});

describe("normDomainId", () => {
  it("collapses case / spaces / underscores / hyphens", () => {
    expect(normDomainId("Agents-generation")).toBe("agentsgeneration");
    expect(normDomainId("Agents_Generation")).toBe("agentsgeneration");
    expect(normDomainId("RAAS-v1")).toBe("raasv1");
    expect(normDomainId("agents generation")).toBe("agentsgeneration");
  });
});

describe("normalizers", () => {
  it("normalizeAllmetaObject parses stringified properties + id/uid fallback", () => {
    const o = normalizeAllmetaObject({
      uid: "Job_Posting",
      name: "职位发布",
      properties: JSON.stringify([{ name: "job_posting_id", type: "String" }]),
    });
    expect(o.id).toBe("Job_Posting");
    expect(o.properties).toHaveLength(1);
    expect(o.properties?.[0]?.name).toBe("job_posting_id");
  });

  it("normalizeAllmetaEvent parses the stringified payload envelope", () => {
    const e = normalizeAllmetaEvent({
      name: "JD_GENERATED",
      payload: JSON.stringify({
        source_action: "createJD",
        event_data: [{ name: "job_posting_id", type: "String", target_object: "Job_Posting" }],
        state_mutations: [{ target_object: "Job_Posting", mutation_type: "CREATE", impacted_properties: ["x"] }],
      }),
    });
    expect(e.payload.source_action).toBe("createJD");
    expect(e.payload.event_data).toHaveLength(1);
    expect(e.payload.state_mutations).toHaveLength(1);
  });

  it("normalizeAllmetaAction parses *_json fields and reads action_id", () => {
    const a = normalizeAllmetaAction(
      {
        action_id: "4",
        name: "createJD",
        actor_json: '["Agent"]',
        trigger_json: '["REQUIREMENT_LOGGED"]',
        triggered_event_json: '["JD_GENERATED"]',
        target_objects_json: '["Job_Posting"]',
      },
      new Map(),
    );
    expect(a.id).toBe("4");
    expect(a.actor).toEqual(["Agent"]);
    expect(a.trigger).toEqual(["REQUIREMENT_LOGGED"]);
    expect(a.triggered_event).toEqual(["JD_GENERATED"]);
    expect(a.target_objects).toEqual(["Job_Posting"]);
  });

  it("normalizeAllmetaAction derives emitted events from emitByAction when the node lacks them", () => {
    const emitByAction = new Map([["processResume", ["RESUME_PROCESSED"]]]);
    const a = normalizeAllmetaAction({ name: "processResume", actor_json: '["Agent"]' }, emitByAction);
    expect(a.triggered_event).toEqual(["RESUME_PROCESSED"]);
  });

  it("buildEmitByAction maps source_action → emitted event names", () => {
    const map = buildEmitByAction([
      normalizeAllmetaEvent({ name: "RESUME_PROCESSED", payload: JSON.stringify({ source_action: "processResume" }) }),
      normalizeAllmetaEvent({ name: "JD_GENERATED", payload: JSON.stringify({ source_action: "createJD" }) }),
    ]);
    expect(map.get("processResume")).toEqual(["RESUME_PROCESSED"]);
    expect(map.get("createJD")).toEqual(["JD_GENERATED"]);
  });

  it("dedupeActionsByName keeps the first occurrence", () => {
    const mk = (name: string, id: string) =>
      normalizeAllmetaAction({ name, action_id: id, actor_json: '["Agent"]' }, new Map());
    const out = dedupeActionsByName([mk("createJD", "4"), mk("createJD", "4-dup"), mk("matchResume", "10")]);
    expect(out).toHaveLength(2);
    expect(out[0]?.id).toBe("4");
  });
});

describe("AllmetaOntologySource — unconfigured", () => {
  it("reports not configured, lists nothing, and throws on fetchOntology", async () => {
    const src = new AllmetaOntologySource({ baseUrl: "", apiKey: "", timeoutMs: 1000 });
    expect(src.configured).toBe(false);
    expect(await src.listDomains()).toEqual([]);
    await expect(src.fetchOntology("Agents-generation")).rejects.toThrow(/ALLMETA_BASE_URL/);
    expect(await src.fetchActionRules("Agents-generation", "createJD")).toEqual([]);
  });
});

describe("AllmetaOntologySource — live (stubbed fetch)", () => {
  it("fetches + normalizes a domain ontology with source 'allmeta'", async () => {
    stubFetch([
      ["/api/domains", { domains: [{ id: "Agents-generation", name: "Agents generation" }] }],
      [
        "/api/v1/ontology/actions",
        {
          items: [
            { action_id: "4", name: "createJD", actor_json: '["Agent"]', trigger_json: '["REQUIREMENT_LOGGED"]', triggered_event_json: '["JD_GENERATED"]' },
            // no triggered_event_json → emitted derived from the events below
            { action_id: "9", name: "processResume", actor_json: '["Agent"]', trigger_json: '["RESUME_DOWNLOADED"]' },
          ],
        },
      ],
      [
        "/api/v1/ontology/events",
        {
          items: [
            { name: "JD_GENERATED", payload: JSON.stringify({ source_action: "createJD" }) },
            { name: "RESUME_PROCESSED", payload: JSON.stringify({ source_action: "processResume" }) },
          ],
        },
      ],
      ["/api/v1/ontology/objects", { items: [{ id: "Job_Posting", name: "职位发布", properties: "[]" }] }],
      ["/api/v1/ontology/rules", { items: [{ id: "4-1", businessLogicRuleName: "x" }] }],
    ]);

    const src = new AllmetaOntologySource(cfg);
    const o: DomainOntology = await src.fetchOntology("agents_generation"); // odd casing → resolved
    expect(o.source).toBe("allmeta");
    expect(o.domainId).toBe("agents_generation"); // AO-facing id preserved
    expect(o.actions.map((a) => a.name)).toEqual(["createJD", "processResume"]);
    expect(o.actions.find((a) => a.name === "processResume")?.triggered_event).toEqual(["RESUME_PROCESSED"]);
    expect(o.objects).toHaveLength(1);
    expect(o.events).toHaveLength(2);
    expect(o.rules).toHaveLength(1);
    expect(o.workflow).toEqual([]);
  });

  it("STRICT: throws when the domain has no actions (empty graph / unreachable)", async () => {
    stubFetch([
      ["/api/domains", { domains: [{ id: "Agents-generation" }] }],
      ["/api/v1/ontology/actions", { items: [] }],
      ["/api/v1/ontology/events", { items: [] }],
    ]);
    const src = new AllmetaOntologySource(cfg);
    await expect(src.fetchOntology("Agents-generation")).rejects.toThrow(/未返回|本体读取失败/);
  });

  it("listDomains maps Allmeta domains to {id,name}", async () => {
    stubFetch([["/api/domains", { domains: [{ id: "Agents-generation", name: "Agents generation" }, { id: "RAAS-v1" }] }]]);
    const src = new AllmetaOntologySource(cfg);
    const ds = await src.listDomains();
    expect(ds.map((d) => d.id)).toEqual(["Agents-generation", "RAAS-v1"]);
  });

  it("fetchActionRules reads the per-action rules endpoint", async () => {
    stubFetch([
      ["/api/domains", { domains: [{ id: "Agents-generation" }] }],
      ["/rules", { rules: [{ id: "r1" }, { id: "r2" }] }],
    ]);
    const src = new AllmetaOntologySource(cfg);
    const rules = await src.fetchActionRules("Agents-generation", "createJD");
    expect(rules).toHaveLength(2);
  });
});

describe("CompositeOntologySource — routing", () => {
  const fakeManifest: OntologySource = {
    async listDomains() {
      return [{ id: "raas", name: "RAAS-v1", counts: { actions: 6 } }];
    },
    async fetchOntology(id) {
      return { domainId: id, objects: [], rules: [], actions: [], events: [], workflow: [], source: "snapshot" };
    },
    async fetchActionRules() {
      return ["manifest-rule"];
    },
  };
  const fakeAllmeta: OntologySource = {
    async listDomains() {
      return [{ id: "Agents-generation", name: "Agents generation" }];
    },
    async fetchOntology(id) {
      return { domainId: id, objects: [], rules: [], actions: [], events: [], workflow: [], source: "allmeta" };
    },
    async fetchActionRules() {
      return ["allmeta-rule"];
    },
  };
  const comp = new CompositeOntologySource(fakeAllmeta, fakeManifest);

  it("listDomains returns the union (deduped by normalized id)", async () => {
    const ids = (await comp.listDomains()).map((d) => d.id);
    expect(ids).toContain("raas");
    expect(ids).toContain("Agents-generation");
    expect(ids).toHaveLength(2);
  });

  it("routes a local domain to the manifest source", async () => {
    expect((await comp.fetchOntology("raas")).source).toBe("snapshot");
    expect(await comp.fetchActionRules("raas", "x")).toEqual(["manifest-rule"]);
  });

  it("routes an Allmeta-only domain to the live source (any casing)", async () => {
    expect((await comp.fetchOntology("Agents-generation")).source).toBe("allmeta");
    expect((await comp.fetchOntology("agents_generation")).source).toBe("allmeta");
    expect(await comp.fetchActionRules("Agents-generation", "x")).toEqual(["allmeta-rule"]);
  });

  it("listDomains degrades to local-only when Allmeta throws", async () => {
    const throwingAllmeta: OntologySource = {
      async listDomains() {
        throw new Error("down");
      },
      fetchOntology: fakeAllmeta.fetchOntology,
      fetchActionRules: fakeAllmeta.fetchActionRules,
    };
    const c2 = new CompositeOntologySource(throwingAllmeta, fakeManifest);
    const ids = (await c2.listDomains()).map((d) => d.id);
    expect(ids).toEqual(["raas"]);
  });
});
