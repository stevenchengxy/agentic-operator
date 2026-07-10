/**
 * Composite ontology source — Allmeta-down 优雅降级：Allmeta 掉线时，工厂不该塌成只剩
 * 手写本地本体，而要用本地【已晋升的 workflow 产物】作为 thin 域兜底（否则用户看到"业务域少了好多"）。
 */

import { describe, it, expect } from "vitest";
import { CompositeOntologySource } from "../src/services/agent-factory/composite-ontology-source";
import type { DomainOntology } from "@agentic/agent-factory";

type DomList = Array<{ id: string; name: string; counts: { actions: number; events: number; objects: number; rules: number; workflow: number } }>;

function fakeManifest(local: DomList, artifacts: DomList) {
  return {
    listDomains: async () => local,
    listArtifactDomains: async () => artifacts,
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

describe("Composite — Allmeta-down 降级", () => {
  it("Allmeta 掉线（listDomains 抛错）→ 追加本地产物域，工厂不塌", async () => {
    const allmetaDown = { listDomains: async () => { throw new Error("ECONNREFUSED"); }, fetchOntology: async () => { throw new Error("down"); }, fetchActionRules: async () => { throw new Error("down"); } };
    const c = new CompositeOntologySource(allmetaDown, fakeManifest(LOCAL, ARTIFACTS));
    const doms = await c.listDomains();
    expect(doms.map((d) => d.id).sort()).toEqual(["agents-generation", "raas"]);
  });

  it("Allmeta 掉线 → fetchOntology 从本地 workflow 产物取 thin 本体", async () => {
    const allmetaDown = { listDomains: async () => [], fetchOntology: async () => { throw new Error("down"); }, fetchActionRules: async () => [] };
    const c = new CompositeOntologySource(allmetaDown, fakeManifest(LOCAL, ARTIFACTS));
    const ont = await c.fetchOntology("Agents-generation");
    expect(ont.actions.length).toBe(6); // 从 workflow 派生的 thin 本体
  });

  it("Allmeta 在线 → 不追加产物域（live 版优先，避免重复）", async () => {
    const allmetaUp = { listDomains: async () => [{ id: "Agents-generation", name: "Agents-generation", counts: { actions: 32, events: 41, objects: 44, rules: 262, workflow: 0 } }], fetchOntology: async () => ({ domainId: "Agents-generation", source: "allmeta", actions: new Array(32).fill({}), events: [], rules: [], objects: [], workflow: [] } as unknown as DomainOntology), fetchActionRules: async () => [] };
    const c = new CompositeOntologySource(allmetaUp, fakeManifest(LOCAL, ARTIFACTS));
    const doms = await c.listDomains();
    // raas(local) + Agents-generation(live) —— 产物兜底被跳过（remote 非空），且 normId 去重不重复
    expect(doms.map((d) => d.id).sort()).toEqual(["Agents-generation", "raas"]);
  });
});
