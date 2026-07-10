import { describe, it, expect } from "vitest";
import { ontologyContentHash } from "./tools";

// #AUDIT-FIX(P2-03) — 本体【内容】哈希：等量换血（改规则文本/字段但总数不变）必须改变哈希，
// 否则旧的"数量签名"会漏判漂移、陈旧沙箱绿证不失效。
describe("ontologyContentHash (#P2-03)", () => {
  const base = {
    actions: [{ name: "a", trigger: ["E"], triggered_event: ["F"] }],
    events: [{ name: "E", payload: { event_data: [{ name: "x", type: "string" }] } }],
    rules: [{ id: "r1", text: "score >= 60" }],
    objects: [{ id: "o1", properties: [{ name: "p", type: "string" }] }],
  };

  it("same content → same hash (order-independent within a category)", () => {
    const reordered = { ...base, rules: [...base.rules] };
    expect(ontologyContentHash(base)).toBe(ontologyContentHash(reordered));
  });

  it("equal-count content swap → DIFFERENT hash (the whole point)", () => {
    const ruleTextChanged = { ...base, rules: [{ id: "r1", text: "score >= 80" }] }; // same count, changed text
    expect(ontologyContentHash(ruleTextChanged)).not.toBe(ontologyContentHash(base));
    const fieldChanged = { ...base, events: [{ name: "E", payload: { event_data: [{ name: "x", type: "number" }] } }] }; // type flip
    expect(ontologyContentHash(fieldChanged)).not.toBe(ontologyContentHash(base));
  });

  it("null → stable sentinel", () => {
    expect(ontologyContentHash(null)).toBe("0");
    expect(ontologyContentHash(undefined)).toBe("0");
  });
});
