import { describe, expect, it } from "vitest";
import type { AgentCardData, Block } from "../factory/model";
import type { BrainEvent } from "@/lib/hooks/useBrainStream";
import {
  boundaryDecisionText,
  clarifyAnswerText,
  deriveExecLine,
  deriveFlowGraph,
  deriveNextSteps,
  deriveTodos,
  testDecisionText,
} from "./oc-model";

const clarifyBlock = (over: Partial<Extract<Block, { kind: "clarify" }>> = {}): Block => ({
  kind: "clarify",
  id: "b-1",
  interactionId: "int-1",
  question: "高分邀约的分数线？",
  options: [
    { label: "≥80（推荐）", value: "80", recommended: true },
    { label: "≥70", value: "70" },
  ],
  awaiting: true,
  ...over,
});

describe("deriveTodos", () => {
  it("collects awaiting gates of all three kinds and skips resolved ones", () => {
    const blocks: Block[] = [
      clarifyBlock(),
      clarifyBlock({ id: "b-2", interactionId: "int-2", awaiting: false }),
      {
        kind: "testcases",
        id: "b-3",
        interactionId: "int-3",
        cases: [
          { id: "c1", name: "主链", kind: "pass", scenario: "s", entryEvent: "resume.submitted", expectedOutcome: "ok" },
        ],
        awaiting: true,
      },
      {
        kind: "boundarycases",
        id: "b-4",
        interactionId: "int-4",
        proposals: [
          { event: "ats.synced", suggestedKind: "terminal", why: "无消费者", producers: ["ats-writeback"] },
        ],
        awaiting: true,
      },
    ];
    const todos = deriveTodos(blocks);
    expect(todos.map((t) => t.kind)).toEqual(["clarify", "test_approval", "boundary"]);
    expect(todos[0]!.options).toHaveLength(2);
    expect(todos[1]!.cases).toHaveLength(1);
    expect(todos[2]!.proposals?.[0]?.event).toBe("ats.synced");
  });

  it("marks credential-flavoured clarify gates", () => {
    const todos = deriveTodos([
      clarifyBlock({ question: "gohireBgCheckApi 凭证未配置，请提供 API key" }),
    ]);
    expect(todos[0]!.credentialLike).toBe(true);
    expect(deriveTodos([clarifyBlock()])[0]!.credentialLike).toBe(false);
  });
});

describe("wire tags", () => {
  it("stays byte-identical to the factory transport", () => {
    expect(clarifyAnswerText("≥80")).toBe("[澄清回答] ≥80");
    expect(testDecisionText("approve")).toBe("[测试用例决策: 执行]");
    expect(testDecisionText("regenerate", "换个夹具")).toBe("[测试用例决策: 重新生成] 换个夹具");
    expect(boundaryDecisionText([{ event: "e", kind: "terminal" }])).toBe(
      '[边界事件决策] [{"event":"e","kind":"terminal"}]',
    );
  });
});

describe("deriveExecLine", () => {
  const ev = (t: string, rest: Record<string, unknown> = {}): BrainEvent => ({ t, ...rest });

  it("shows the open tool call while running", () => {
    const line = deriveExecLine(
      [
        ev("tool.call", { id: "t1", name: "ontology.query" }),
        ev("tool.result", { id: "t1", ok: true }),
        ev("tool.call", { id: "t2", name: "gohireMatchResumeApi" }),
      ],
      true,
    );
    expect(line.state).toBe("running");
    expect(line.text).toBe("调用 gohireMatchResumeApi");
    expect(line.toolCount).toBe(2);
  });

  it("falls back to 推理中 when no tool is open", () => {
    const line = deriveExecLine([ev("think", { delta: "…" })], true);
    expect(line).toMatchObject({ state: "running", text: "推理中" });
  });

  it("reports waiting_human and terminal done distinctly", () => {
    const base = [ev("agent.created", { spec: { slug: "jd-matcher" } })];
    expect(deriveExecLine([...base, ev("done", { status: "waiting_human" })], false)).toMatchObject({
      state: "done",
      text: "等待你的决定",
      agentCount: 1,
    });
    expect(deriveExecLine([...base, ev("done", { status: "finished" })], false)).toMatchObject({
      state: "done",
      text: "完成",
    });
  });

  it("surfaces a trailing error when not running", () => {
    const line = deriveExecLine([ev("error", { message: "上游 503" })], false);
    expect(line).toMatchObject({ state: "error", text: "上游 503" });
  });

  it("is idle with no events", () => {
    expect(deriveExecLine([], false).state).toBe("idle");
  });
});

describe("deriveFlowGraph", () => {
  const agent = (slug: string, trigger: string[], emit: string[]): AgentCardData => ({
    slug,
    actionName: slug,
    short: slug,
    nameZh: slug,
    trigger,
    emit,
    tools: [],
  });

  it("wires producer→consumer edges and classifies entry/terminal events", () => {
    const graph = deriveFlowGraph([
      agent("parser", ["resume.submitted"], ["resume.parsed"]),
      agent("matcher", ["resume.parsed"], ["match.scored"]),
    ]);
    expect(graph.edges).toEqual([{ from: "parser", to: "matcher", event: "resume.parsed" }]);
    expect(graph.entryEvents).toEqual([{ event: "resume.submitted", to: "parser" }]);
    expect(graph.terminalEvents).toEqual([{ event: "match.scored", from: "matcher" }]);
    expect(graph.nodes).toHaveLength(2);
  });
});

describe("deriveNextSteps", () => {
  it("suggests credential setup and advanced mode only after done", () => {
    const doneExec = { state: "done" as const, text: "完成", toolCount: 3, agentCount: 6 };
    const todos = deriveTodos([
      clarifyBlock({ question: "GoHire API 凭证未配置" }),
    ]);
    const steps = deriveNextSteps(doneExec, todos, "raas");
    expect(steps.map((s) => s.id)).toEqual(["credential", "advanced"]);
    expect(deriveNextSteps({ ...doneExec, state: "running" }, todos, "raas")).toEqual([]);
  });
});
