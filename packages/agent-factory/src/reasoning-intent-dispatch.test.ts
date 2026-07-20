import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMsg, TurnEvent } from "./stream-gateway";

// Phase-3b: for an analyze/question intent, the ANSWER is deliberated through the reasoning kernel (cot)
// instead of being raw ReAct output. Mock streamTurn (the loop) + chatOnce (intent gate + kernel).
const scriptedTurns: TurnEvent[][] = [];
vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => true,
    setLlmCallContext: () => undefined,
    streamTurn: async function* (_messages: ChatMsg[]) {
      const events = scriptedTurns.shift() ?? [{ t: "done" as const, content: "done" }];
      for (const event of events) yield event;
    },
    chatOnce: async (_system: string, _user: string, opts?: { purpose?: string }) => {
      // the intent gate classifies the goal; return an [分析] line so reasoningDefault becomes cot
      if (opts?.purpose === "specialist:intent") return "[分析] 分析这个本体 ｜ 约束: 无 ｜ 期望产物: 无";
      return `[${opts?.purpose}]`;
    },
  };
});

import { runBrain } from "./conductor";
import type { BrainEvent } from "./brain-types";
import type { FactoryPorts } from "./ports";

const ports = (): FactoryPorts => ({
  ontology: { listDomains: async () => [], fetchOntology: async () => ({ domainId: "dom", actions: [], events: [], objects: [], rules: [], workflow: [], source: "snapshot" }), fetchActionRules: async () => [] },
  sandbox: { deployAndObserve: async () => { throw new Error("not used"); }, teardown: async () => undefined },
  reflection: { list: async () => [], record: async () => undefined },
  conversation: { has: async () => false, load: async () => null, save: async () => undefined, drainHumanMessages: async () => [] },
} as unknown as FactoryPorts);

describe("#REASONING-KERNEL Phase-3b — intent-level answer routing", () => {
  beforeEach(() => { vi.stubEnv("FACTORY_AI_MODEL", "test/m"); scriptedTurns.splice(0); });
  afterEach(() => vi.unstubAllEnvs());

  it("an analyze answer is deliberated via the cot kernel (not raw react text)", async () => {
    const raw = "这个域包含 6 个动作、16 个事件和 44 个数据对象，核心链路是简历下载到处理再到匹配邀约。";
    scriptedTurns.push([{ t: "done", content: raw }]);

    const events: BrainEvent[] = [];
    for await (const event of runBrain({ domain: "dom", goal: "分析这个本体的结构", ports: ports(), conversationId: "analyze-conv" })) {
      events.push(event as BrainEvent);
    }

    // the kernel ran on the answer …
    const step = events.find((e): e is Extract<BrainEvent, { t: "reasoning.step" }> => e.t === "reasoning.step");
    expect(step?.strategy).toBe("cot");
    // … and the DELIBERATED conclusion is what surfaced as the answer, not the raw scripted text
    const answers = events.filter((e): e is Extract<BrainEvent, { t: "message" }> => e.t === "message").map((e) => e.text);
    expect(answers).toContain("[kernel:cot]");
    expect(answers).not.toContain(raw);
    // policy correctly classified this run as analyze
    expect(events.find((e): e is Extract<BrainEvent, { t: "policy" }> => e.t === "policy")?.pipeline).toBe("analyze");
    expect(events.at(-1)).toMatchObject({ t: "done" });
  });

  it("a short (<40 char) answer is never deliberated — no wasted kernel run", async () => {
    scriptedTurns.push([{ t: "done", content: "好的。" }]);
    const events: BrainEvent[] = [];
    for await (const event of runBrain({ domain: "dom", goal: "分析本体", ports: ports(), conversationId: "short-conv" })) {
      events.push(event as BrainEvent);
    }
    expect(events.some((e) => e.t === "reasoning.step")).toBe(false);
    expect(events.some((e) => e.t === "message" && e.text === "好的。")).toBe(true);
  });
});
