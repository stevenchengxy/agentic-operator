import { describe, it, expect } from "vitest";
import { detectLang, resolveBrainLang } from "./i18n";
import { systemPrompt, factoryRoles } from "./system-prompt";
import { deriveBaseFixture as deriveBaseFixtureForTest } from "./test-cases";

// #9 — brain language (i18n) + ontology-derived seed fixtures (de-hardcode).
describe("i18n (#9 — brain language)", () => {
  it("detectLang: CJK→zh, Latin→en", () => {
    expect(detectLang("为这个业务域生成智能体")).toBe("zh");
    expect(detectLang("generate agents for this domain")).toBe("en");
  });

  it("defaults to zh (preserves current behavior) when FACTORY_BRAIN_LANG is unset", () => {
    expect(resolveBrainLang("Agents-generation", null, {})).toBe("zh");
  });

  it("FACTORY_BRAIN_LANG=en|zh is authoritative", () => {
    expect(resolveBrainLang("招聘-v1", null, { FACTORY_BRAIN_LANG: "en" })).toBe("en");
    expect(resolveBrainLang("Agents-generation", null, { FACTORY_BRAIN_LANG: "zh" })).toBe("zh");
  });

  it("auto follows the ONTOLOGY content over the domain id", () => {
    const env = { FACTORY_BRAIN_LANG: "auto" };
    // Latin domain id but Chinese ontology content → zh
    expect(resolveBrainLang("Agents-generation", { actions: [{ name: "处理简历", description: "对简历进行处理" }] }, env)).toBe("zh");
    // English ontology content → en
    expect(resolveBrainLang("domain-x", { actions: [{ name: "processResume", description: "process the resume" }] }, env)).toBe("en");
  });

  it("systemPrompt + roles render in the resolved language", () => {
    expect(systemPrompt("D", [], "zh")).toContain("主控大脑");
    const en = systemPrompt("D", [], "en");
    expect(en).toContain("MASTER BRAIN");
    expect(en).toContain('domain "D"');
    expect(factoryRoles("en")[0]!.role).toBe("Business Analyst");
    expect(factoryRoles("zh")[0]!.role).toBe("业务分析师");
  });
});

describe("deriveBaseFixture (#9 — ontology-derived seed, no hardcoded recruitment data)", () => {
  it("derives seed values from ontology objects + events, with NO recruitment/energy hardcoding", () => {
    const ctx = {
      ontology: {
        objects: [{ id: "Shipment", primary_key: "shipment_id", properties: [{ name: "weight_kg", type: "number" }, { name: "origin", type: "string" }] }],
        events: [{ name: "SHIPMENT_CREATED", payload: { event_data: [{ name: "carrier", type: "string" }] } }],
      },
    } as unknown as Parameters<typeof deriveBaseFixtureForTest>[0];
    const base = deriveBaseFixtureForTest(ctx);
    expect(base.shipment_id).toBe("shipment_id_demo");
    expect(base.weight_kg).toBe(1);
    expect(base.origin).toBe("origin_demo");
    expect(base.carrier).toBe("carrier_demo");
    // the old recruitment leak must be gone
    expect(base.candidate_id).toBeUndefined();
    expect(base.name).toBeUndefined();
  });
});
