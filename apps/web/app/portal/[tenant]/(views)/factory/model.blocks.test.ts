import { describe, expect, it } from "vitest";
import { translate } from "@/lib/i18n";
import { toBlocks } from "./model";
import { isNoiseBlock } from "./transcript";
import type { BrainEvent } from "@/lib/hooks/useBrainStream";

const t = (key: string, vars?: Record<string, string | number>) => translate("zh", key, vars);

describe("toBlocks — user.message renders the human side of the dialogue", () => {
  it("maps user.message to a user bubble block (never folded as noise)", () => {
    const blocks = toBlocks(t, [
      { t: "user.message", text: "你是谁?" },
      { t: "message", text: "你好!" },
    ] as BrainEvent[]);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "message"]);
    expect(blocks[0]).toMatchObject({ kind: "user", text: "你是谁?" });
    expect(isNoiseBlock("user")).toBe(false);
  });

  it("flushes a pending think buffer before the user bubble (ordering preserved)", () => {
    const blocks = toBlocks(t, [
      { t: "think", delta: "琢磨中" },
      { t: "user.message", text: "继续" },
    ] as BrainEvent[]);
    expect(blocks.map((b) => b.kind)).toEqual(["think", "user"]);
  });
});

describe("#CLEAN-ANSWER — reasoning.step renders as a foldable reasoning block; the message stays clean", () => {
  it("maps reasoning.step to a reasoning block (NOISE — folds in 精简, shown in 详尽)", () => {
    const blocks = toBlocks(t, [
      { t: "reasoning.step", strategy: "cot", index: 0, total: 1, output: "先理清约束……最后给出结论" },
      { t: "message", text: "你好！我是这座工厂的主控大脑。" },
    ] as BrainEvent[]);
    expect(blocks.map((b) => b.kind)).toEqual(["reasoning", "message"]);
    expect(blocks[0]).toMatchObject({ kind: "reasoning", strategy: "cot" });
    expect(isNoiseBlock("reasoning")).toBe(true); // folds in brief
    expect(isNoiseBlock("message")).toBe(false); // the clean answer card is never folded
  });

  it("carries forAgent (e.g. a blueprint phase) and flushes pending think first", () => {
    const blocks = toBlocks(t, [
      { t: "think", delta: "草稿答案" },
      { t: "reasoning.step", strategy: "cot", index: 0, total: 6, output: "阶段推理正文", forAgent: "蓝图·需求接收" },
    ] as BrainEvent[]);
    expect(blocks.map((b) => b.kind)).toEqual(["think", "reasoning"]);
    expect(blocks[1]).toMatchObject({ forAgent: "蓝图·需求接收" });
  });

  it("drops an empty reasoning.step (no blank blocks)", () => {
    const blocks = toBlocks(t, [{ t: "reasoning.step", strategy: "cot", index: 0, total: 1, output: "   " }] as BrainEvent[]);
    expect(blocks).toHaveLength(0);
  });
});

describe("toBlocks — flow.blueprint lands in the chat as a clickable viz card", () => {
  const model = {
    domain: "d",
    phases: [{ id: "p1" }, { id: "p2" }],
    unresolved: [],
    diagrams: [
      { kind: "phase-flow", title: "蓝图 · d", svg: "<svg>1</svg>" },
      { kind: "sequence", title: "时序 · d", svg: "<svg>2</svg>" },
      { kind: "mermaid", title: "源", source: "graph TD" }, // no svg → not a thumbnail
    ],
  };

  it("collects only svg-bearing diagrams into one viz block", () => {
    const blocks = toBlocks(t, [{ t: "flow.blueprint", model } as unknown as BrainEvent]);
    expect(blocks).toHaveLength(1);
    const viz = blocks[0]!;
    expect(viz.kind).toBe("viz");
    if (viz.kind !== "viz") return;
    expect(viz.svgs).toHaveLength(2);
    expect(viz.title).toContain("2 阶段");
    expect(isNoiseBlock("viz")).toBe(false);
  });

  it("emits NO viz block when no diagram carries an svg", () => {
    const blocks = toBlocks(t, [
      { t: "flow.blueprint", model: { ...model, diagrams: [{ kind: "mermaid", source: "x" }] } } as unknown as BrainEvent,
    ]);
    expect(blocks).toHaveLength(0);
  });

  it("surfaces the unresolved count honestly in the note", () => {
    const blocks = toBlocks(t, [
      { t: "flow.blueprint", model: { ...model, unresolved: [{}, {}] } } as unknown as BrainEvent,
    ]);
    const viz = blocks[0]!;
    if (viz.kind !== "viz") throw new Error("expected viz");
    expect(viz.note).toContain("2 项缺本体证据");
  });
});
