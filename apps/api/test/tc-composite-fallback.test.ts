/**
 * Composite ontology source strictness: local promoted domains augment a live
 * ontology catalog, but an unavailable authoritative Allmeta source must not
 * be disguised as a complete local/thin ontology.
 */

import { describe, it, expect } from "vitest";
import { CompositeOntologySource } from "../src/services/agent-factory/composite-ontology-source";
import type { DomainOntology } from "@agentic/agent-factory";

type DomList = Array<{ id: string; name: string; counts: { actions: number; events: number; objects: number; rules: number; workflow: number } }>;

function fakeManifest(local: DomList, artifacts: DomList) {
  return {
    listDomains: async () => local,
    fetchOntology: async (id: string): Promise<DomainOntology> => {
      const hit = [...local, ...artifacts].find((d) => d.id.toLowerCase() === id.toLowerCase());
      if (!hit) throw new Error("no local folder");
      return { domainId: hit.id, source: "snapshot", actions: new Array(hit.counts.actions).fill({ name: "a", actor: ["Agent"], trigger: [], triggered_event: [], target_objects: [], tool_use: [] }), events: [], rules: [], objects: [], workflow: [] } as unknown as DomainOntology;
    },
    fetchActionRules: async () => [],
  };
}

const LOCAL: DomList = [{ id: "raas", name: "RAAS-v1", counts: { actions: 22, events: 3, objects: 0, rules: 0, workflow: 0 } }];
const ARTIFACTS: DomList = [{ id: "agents-generation", name: "agents-generation-v1", counts: { actions: 6, events: 0, objects: 0, rules: 0, workflow: 6 } }];

describe("Composite ontology source truthfulness", () => {
  it("surfaces an Allmeta list failure instead of claiming a local catalog is complete", async () => {
    const allmetaDown = { listDomains: async () => { throw new Error("ECONNREFUSED"); }, fetchOntology: async () => { throw new Error("down"); }, fetchActionRules: async () => { throw new Error("down"); } };
    const c = new CompositeOntologySource(allmetaDown, fakeManifest(LOCAL, ARTIFACTS));
    await expect(c.listDomains()).rejects.toThrow("ECONNREFUSED");
  });

  it("surfaces an Allmeta ontology failure instead of fabricating a thin ontology", async () => {
    const allmetaDown = { listDomains: async () => [], fetchOntology: async () => { throw new Error("down"); }, fetchActionRules: async () => [] };
    const c = new CompositeOntologySource(allmetaDown, fakeManifest(LOCAL, ARTIFACTS));
    await expect(c.fetchOntology("Agents-generation")).rejects.toThrow("down");
  });

  it("Allmeta 在线 → 不追加产物域（live 版优先，避免重复）", async () => {
    const allmetaUp = { listDomains: async () => [{ id: "Agents-generation", name: "Agents-generation", counts: { actions: 32, events: 41, objects: 44, rules: 262, workflow: 0 } }], fetchOntology: async () => ({ domainId: "Agents-generation", source: "allmeta", actions: new Array(32).fill({}), events: [], rules: [], objects: [], workflow: [] } as unknown as DomainOntology), fetchActionRules: async () => [] };
    const c = new CompositeOntologySource(allmetaUp, fakeManifest(LOCAL, ARTIFACTS));
    const doms = await c.listDomains();
    // raas(local) + Agents-generation(live) —— 产物兜底被跳过（remote 非空），且 normId 去重不重复
    expect(doms.map((d) => d.id).sort()).toEqual(["Agents-generation", "raas"]);
  });
});
