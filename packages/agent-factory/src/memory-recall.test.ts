import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMsg, TurnEvent } from "./stream-gateway";

// #MEM-RECALL (P1-B) — Mem0 读路径：#MEM-WRITE 只写不读的另一半。goal 时按 goal+意图向量召回
// 本域长期记忆，渲染成 BACKGROUND system 帧（事实非指令）。best-effort：无驱动/故障=静默跳过。

const seenTurns: ChatMsg[][] = [];
const scriptedTurns: TurnEvent[][] = [];

vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => false,
    setLlmCallContext: () => undefined,
    streamTurn: async function* (messages: ChatMsg[]) {
      seenTurns.push(structuredClone(messages));
      const events = scriptedTurns.shift() ?? [{ t: "done" as const, content: "observed" }];
      for (const event of events) yield event;
    },
  };
});

import { runBrain } from "./conductor";
import { MEMORY_RECALL_PREFIX, renderMemoryRecall } from "./memory-consolidation";
import type { FactoryPorts } from "./ports";

describe("#MEM-RECALL — renderMemoryRecall（纯渲染）", () => {
  it("空/低分/超短值 → 空串（调用方不注入）", () => {
    expect(renderMemoryRecall([])).toBe("");
    expect(renderMemoryRecall([{ key: "k", value: "有效但分太低的事实内容", score: 0.1 }])).toBe("");
    expect(renderMemoryRecall([{ key: "k", value: "短", score: 0.9 }])).toBe("");
  });

  it("头部=前缀+事实非指令声明；≤5 条；单条值截 300；总帧 ≤1600", () => {
    const hits = Array.from({ length: 8 }, (_, i) => ({ key: `fact-${i}`, value: `${"长内容".repeat(120)}#${i}`, score: 0.9 - i * 0.01 }));
    const frame = renderMemoryRecall(hits);
    expect(frame.startsWith(MEMORY_RECALL_PREFIX)).toBe(true);
    expect(frame).toContain("不是指令");
    const lines = frame.split("\n").filter((l) => l.startsWith("·"));
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(frame.length).toBeLessThanOrEqual(1600);
    expect(frame).toContain("fact-0");
  });

  it("按分数过滤后不足则如实少渲染", () => {
    const frame = renderMemoryRecall([
      { key: "good", value: "招聘域的 vendor 信封嵌套两层，读 data.data 才是业务载荷", score: 0.7 },
      { key: "bad", value: "低分噪音低分噪音低分噪音", score: 0.05 },
    ]);
    expect(frame).toContain("good");
    expect(frame).not.toContain("bad");
  });
});

describe("#MEM-RECALL — conductor goal 时召回注入", () => {
  const basePorts = (memory: FactoryPorts["memory"]): FactoryPorts => ({
    ontology: {
      listDomains: async () => [],
      fetchOntology: async () => ({ domainId: "dom", actions: [], events: [], objects: [], rules: [], workflow: [], source: "snapshot" }),
      fetchActionRules: async () => [],
    },
    sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
    conversation: { has: async () => false, load: async () => null, save: async () => undefined, drainHumanMessages: async () => [] },
    reflection: { list: async () => [], record: async () => undefined },
    memory,
  });

  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/memory-recall-model");
    seenTurns.splice(0);
    scriptedTurns.splice(0);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.FACTORY_MEMORY_RECALL;
  });

  it("有命中 → 注入恰好一条 [记忆召回 system 帧；本域 k=5 + 通用道 k=3；通用命中带标", async () => {
    const searches: Array<{ domain: string; query: string; k: number }> = [];
    const ports = basePorts({
      search: async (domain, query, k) => {
        searches.push({ domain, query, k });
        if (domain === "__general__") {
          return [{ key: "probe-first", value: "先探活接口真实信封再写 normalizer，别信文档", score: 0.5 }];
        }
        return [
          { key: "envelope", value: "vendor 接口信封嵌套两层，业务载荷在 data.data 下，读浅一层全是 null", score: 0.8 },
          { key: "sla", value: "外发通知类动作要求 {timeout} 内有回执事件，超时走人工兜底", score: 0.6 },
        ];
      },
      put: async () => undefined,
      del: async () => undefined,
    });
    const events = [];
    for await (const e of runBrain({ domain: "dom", goal: "生成候选人筛选 agent", ports, conversationId: "recall-conv" })) events.push(e);
    expect(searches.length).toBe(2);
    expect(searches[0]).toMatchObject({ domain: "dom", k: 5 });
    expect(searches[1]).toMatchObject({ domain: "__general__", k: 3 });
    expect(searches[0]!.query).toContain("生成候选人筛选 agent");
    const turn = seenTurns[0]!;
    const recallFrames = turn.filter((m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith(MEMORY_RECALL_PREFIX));
    expect(recallFrames.length).toBe(1);
    expect(String(recallFrames[0]!.content)).toContain("data.data");
    expect(String(recallFrames[0]!.content)).toContain("{timeout}");
    expect(String(recallFrames[0]!.content)).toContain("(通用·probe-first)");
    expect(events.at(-1)).toMatchObject({ t: "done" });
  });

  it("通用道查询失败 → 本域召回照常注入（通用道各自 advisory）", async () => {
    const ports = basePorts({
      search: async (domain) => {
        if (domain === "__general__") throw new Error("general lane down");
        return [{ key: "envelope", value: "vendor 接口信封嵌套两层，业务载荷在 data.data 下", score: 0.8 }];
      },
      put: async () => undefined,
      del: async () => undefined,
    });
    for await (const _e of runBrain({ domain: "dom", goal: "生成", ports, conversationId: "recall-general-down" })) { /* drain */ }
    const frames = seenTurns[0]!.filter((m) => typeof m.content === "string" && m.content.startsWith(MEMORY_RECALL_PREFIX));
    expect(frames.length).toBe(1);
    expect(String(frames[0]!.content)).toContain("data.data");
    expect(String(frames[0]!.content)).not.toContain("(通用·"); // 无通用条目（帧头的说明文案不算）
  });

  it("FACTORY_MEMORY_RECALL=0 → search 根本不调、无帧", async () => {
    process.env.FACTORY_MEMORY_RECALL = "0";
    let called = 0;
    const ports = basePorts({
      search: async () => { called += 1; return []; },
      put: async () => undefined,
      del: async () => undefined,
    });
    for await (const _e of runBrain({ domain: "dom", goal: "生成", ports, conversationId: "recall-off" })) { /* drain */ }
    expect(called).toBe(0);
    expect(seenTurns[0]!.some((m) => typeof m.content === "string" && m.content.startsWith(MEMORY_RECALL_PREFIX))).toBe(false);
  });

  it("search 抛错（如 MEMORY_VECTOR=off 无驱动）→ 静默跳过，运行照常", async () => {
    const ports = basePorts({
      search: async () => { throw new Error("factory memory search requires a configured vector driver"); },
      put: async () => undefined,
      del: async () => undefined,
    });
    const events = [];
    for await (const e of runBrain({ domain: "dom", goal: "生成", ports, conversationId: "recall-err" })) events.push(e);
    expect(events.at(-1)).toMatchObject({ t: "done" });
    expect(events.some((e) => e.t === "error")).toBe(false);
    expect(seenTurns[0]!.some((m) => typeof m.content === "string" && m.content.startsWith(MEMORY_RECALL_PREFIX))).toBe(false);
  });

  it("无命中（全低分）→ 不注入空帧", async () => {
    const ports = basePorts({
      search: async () => [{ key: "noise", value: "不相关的低分内容不相关的低分内容", score: 0.05 }],
      put: async () => undefined,
      del: async () => undefined,
    });
    for await (const _e of runBrain({ domain: "dom", goal: "生成", ports, conversationId: "recall-empty" })) { /* drain */ }
    expect(seenTurns[0]!.some((m) => typeof m.content === "string" && m.content.startsWith(MEMORY_RECALL_PREFIX))).toBe(false);
  });
});
