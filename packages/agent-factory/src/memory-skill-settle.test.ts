import { describe, it, expect } from "vitest";
import { consolidateRunMemory, extractMemoryFacts, decideMemoryOps, parseLooseArray, digestFromMessages } from "./memory-consolidation";
import { induceSkillsFromRun, isDuplicateSkill, kebab } from "./skill-induction";
import type { FactoryMemoryPort } from "./ports";
import type { GeneratedAgentSpec } from "./spec-types";

// #P0-5 (Mem0 write path) + #P0-6 (AWM skill induction) — pure-core tests with injected fake LLMs.

function fakeMemory(initial: Record<string, string> = {}): FactoryMemoryPort & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async search(_d, query, k) {
      return [...store.entries()]
        .filter(([, v]) => v.split("").some(() => true))
        .map(([key, value]) => ({ key, value, score: query.includes(value.slice(0, 4)) ? 0.9 : 0.3 }))
        .slice(0, k);
    },
    async put(_d, key, value) { store.set(key, value); },
    async del(_d, key) { store.delete(key); },
  };
}

describe("parseLooseArray", () => {
  it("parses fenced/prefixed arrays and preserves an explicit empty array", () => {
    expect(parseLooseArray('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }]);
    expect(parseLooseArray('前言 blah [ {"k":"v"} , 2 ] 后缀')).toEqual([{ k: "v" }, 2]);
    expect(parseLooseArray("```json\n[]\n```")).toEqual([]);
  });

  it("does not reinterpret missing, truncated, or malformed JSON as []", () => {
    expect(() => parseLooseArray("完全没有数组")).toThrow(/JSON array/);
    expect(() => parseLooseArray('[{"a":1}')).toThrow(/incomplete JSON/);
    expect(() => parseLooseArray("[not-json]")).toThrow(/malformed JSON/);
    expect(() => parseLooseArray('{"items":[]}')).toThrow(/must be an array/);
  });
});

describe("digestFromMessages", () => {
  it("flattens roles/content and caps size head+tail", () => {
    const msgs = [
      { role: "user", content: "造 agents" },
      { role: "assistant", content: [{ type: "text", text: "开始设计" }] },
    ];
    const d = digestFromMessages(msgs);
    expect(d).toContain("[user] 造 agents");
    expect(d).toContain("[assistant] 开始设计");
    const big = Array.from({ length: 200 }, (_, i) => ({ role: "assistant", content: `msg-${i} ${"x".repeat(300)}` }));
    const capped = digestFromMessages(big, 5000);
    expect(capped.length).toBeLessThanOrEqual(5200);
    expect(capped).toContain("[中略]");
  });
});

describe("#P0-5 consolidateRunMemory (extract → ADD/UPDATE/DELETE/NOOP → apply)", () => {
  it("ADD writes a new fact; NOOP writes nothing; DELETE removes", async () => {
    const mem = fakeMemory({ "old-fact": "RoboHire 接口走 multipart" });
    let call = 0;
    const llm = async (): Promise<string> => {
      call++;
      if (call === 1) return JSON.stringify([{ key: "jd-需要-审批", value: "该域 JD 创建后必须人工审批才能发布" }, { key: "noop-fact", value: "RoboHire 接口走 multipart 上传" }]);
      return JSON.stringify([
        { op: "ADD", key: "jd-需要-审批", value: "该域 JD 创建后必须人工审批才能发布" },
        { op: "NOOP", key: "old-fact" },
        { op: "DELETE", key: "old-fact", reason: "被新证据证伪(演示)" },
      ]);
    };
    const res = await consolidateRunMemory({ domain: "dom", digest: "…运行摘要…", memory: mem, llm });
    expect(res.extracted).toBe(2);
    expect(res.written).toBe(2); // 1 ADD + 1 DELETE (NOOP 不写)
    expect(mem.store.has("jd-需要-审批")).toBe(true);
    expect(mem.store.has("old-fact")).toBe(false);
  });

  it("allows a valid empty extraction without writing", async () => {
    const res = await consolidateRunMemory({ domain: "d", digest: "x", memory: fakeMemory(), llm: async () => "[]" });
    expect(res).toEqual({ extracted: 0, ops: [], written: 0 });
  });

  it("allows a valid empty operation decision after a successful extraction/search", async () => {
    let call = 0;
    const res = await consolidateRunMemory({
      domain: "d",
      digest: "x",
      memory: fakeMemory(),
      llm: async () => ++call === 1
        ? JSON.stringify([{ key: "durable", value: "一条足够长的事实内容示例" }])
        : "[]",
    });
    expect(res).toEqual({ extracted: 1, ops: [], written: 0 });
  });

  it("propagates LLM/JSON and retrieval failures instead of reporting zero work", async () => {
    await expect(consolidateRunMemory({ domain: "d", digest: "x", memory: fakeMemory(), llm: async () => "不是 JSON" }))
      .rejects.toThrow(/JSON array/);
    await expect(extractMemoryFacts("d", "x", { llm: async () => { throw new Error("llm down"); } }))
      .rejects.toThrow("llm down");
    const angry: FactoryMemoryPort = { search: async () => { throw new Error("db down"); }, put: async () => { throw new Error("db down"); }, del: async () => { throw new Error("db down"); } };
    await expect(consolidateRunMemory({
      domain: "d", digest: "x", memory: angry,
      llm: async () => JSON.stringify([{ key: "k", value: "一条足够长的事实内容示例" }]),
    })).rejects.toThrow("db down");
  });

  it("propagates mutation failures instead of returning a partial written count", async () => {
    const memory = fakeMemory();
    memory.put = async () => { throw new Error("put failed"); };
    let call = 0;
    await expect(consolidateRunMemory({
      domain: "d",
      digest: "x",
      memory,
      llm: async () => {
        call++;
        return call === 1
          ? JSON.stringify([{ key: "durable", value: "一条足够长的事实内容示例" }])
          : JSON.stringify([{ op: "ADD", key: "durable", value: "一条足够长的事实内容示例" }]);
      },
    })).rejects.toThrow("put failed");
  });

  it("extract drops too-short facts and caps at maxFacts", async () => {
    const facts = await extractMemoryFacts("d", "digest", {
      llm: async () => JSON.stringify([{ key: "a", value: "短" }, { key: "b", value: "这条足够长可以入选的事实" }, { key: "c", value: "另一条足够长可以入选的事实" }]),
      maxFacts: 1,
    });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.key).toBe("b");
  });

  it("decideMemoryOps rejects an unknown op instead of normalizing it to NOOP", async () => {
    await expect(decideMemoryOps(
      [{ key: "k", value: "一条足够长的事实内容示例" }],
      [[]],
      { llm: async () => JSON.stringify([{ op: "EXPLODE", key: "k" }]) },
    )).rejects.toThrow(/invalid op/);
  });

  it("rejects malformed search results and LLM operations targeting keys outside the batch", async () => {
    const facts = [{ key: "new-fact", value: "一条足够长的事实内容示例" }];
    await expect(decideMemoryOps(
      facts,
      [[{ key: "", value: "existing" }]],
      { llm: async () => "[]" },
    )).rejects.toThrow(/invalid shape/);
    await expect(decideMemoryOps(
      facts,
      [[{ key: "existing", value: "已存在的长期记忆" }]],
      { llm: async () => JSON.stringify([{ op: "DELETE", key: "not-retrieved" }]) },
    )).rejects.toThrow(/not returned by memory search/);
  });
});

const spec = (over: Partial<GeneratedAgentSpec>): GeneratedAgentSpec =>
  ({ slug: "s1", short: "S1", nameZh: "一号", actionName: "a", trigger: ["T"], emit: ["E"], tools: ["parseResumeApi", "meta.ping"], unresolvedTools: [], objects: [], systemPrompt: "", ...over }) as unknown as GeneratedAgentSpec;

describe("#P0-6 induceSkillsFromRun (AWM, verified-success only at call site)", () => {
  it("induces valid skills, filters tools to the run's tool set, dedups vs library", async () => {
    const llm = async (): Promise<string> =>
      JSON.stringify([
        { name: "闸口先取规则再判定", purpose: "规则闸 agent 的标准流程模式", promptFragment: "对任何规则闸 agent：第一步调用 {规则获取工具} 拉取该动作的业务规则，第二步逐条比对 {输入对象} 的字段，第三步只 emit 明确的通过/拒绝事件。", tools: ["parseResumeApi", "hallucinated.tool"], decisionRule: "设计规则闸类 agent 时使用" },
        { name: "重复技能", purpose: "已有技能的重复", promptFragment: "x".repeat(30), tools: [], decisionRule: "何时都不用" },
      ]);
    const out = await induceSkillsFromRun({
      domain: "dom", digest: "…", specs: [spec({})],
      existingSkills: [{ slug: "重复技能", purpose: "已有技能的重复" }].map((s) => ({ slug: kebab(s.slug), purpose: s.purpose })),
      llm,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toBe("闸口先取规则再判定");
    expect(out[0]!.tools).toEqual(["parseResumeApi"]); // hallucinated tool filtered out
  });

  it("allows quality gates and an explicit [] to produce no skills", async () => {
    const out = await induceSkillsFromRun({
      domain: "d", digest: "x", specs: [spec({})], existingSkills: [],
      llm: async () => JSON.stringify([{ name: "n", purpose: "p", promptFragment: "太短", decisionRule: "短" }]),
    });
    expect(out).toEqual([]);
    const out2 = await induceSkillsFromRun({ domain: "d", digest: "x", specs: [spec({})], existingSkills: [], llm: async () => "[]" });
    expect(out2).toEqual([]);
  });

  it("propagates LLM, malformed JSON, and invalid structured-output failures", async () => {
    const base = { domain: "d", digest: "x", specs: [spec({})], existingSkills: [] };
    await expect(induceSkillsFromRun({ ...base, llm: async () => { throw new Error("llm down"); } }))
      .rejects.toThrow("llm down");
    await expect(induceSkillsFromRun({ ...base, llm: async () => "not json" }))
      .rejects.toThrow(/JSON array/);
    await expect(induceSkillsFromRun({ ...base, llm: async () => JSON.stringify([{ name: "missing fields" }]) }))
      .rejects.toThrow(/must contain string/);
  });

  it("isDuplicateSkill: slug match or ≥60% purpose-token overlap", () => {
    expect(isDuplicateSkill({ name: "My Skill", purpose: "anything" }, [{ slug: "my-skill", purpose: "z" }])).toBe(true);
    expect(isDuplicateSkill({ name: "别的", purpose: "parse resume via robohire api" }, [{ slug: "x", purpose: "parse resume with robohire api" }])).toBe(true);
    expect(isDuplicateSkill({ name: "别的", purpose: "完全 不同 的 用途 描述" }, [{ slug: "x", purpose: "parse resume api" }])).toBe(false);
  });
});
