import { describe, expect, it } from "vitest";
import { translate } from "@/lib/i18n";
import { toBlocks, deriveBrainFlow, type Block } from "./model";
import type { BrainEvent } from "@/lib/hooks/useBrainStream";

const t = (key: string, vars?: Record<string, string | number>) => translate("zh", key, vars);

// #CLARIFY-CLEAR (Track 1-C) — the frontend projection of the ask_user lifecycle. The backend emits a
// clarify(awaitingAnswer:true) frame when the run parks, and a clarify(awaitingAnswer:false) frame when
// the user answers. toBlocks / deriveBrainFlow must flip the SAME card/step from "waiting" to "answered"
// instead of leaving a sticky "等你回答" indicator forever (the pre-fix bug).

const clarifyBlock = (blocks: Block[]) => blocks.find((b): b is Extract<Block, { kind: "clarify" }> => b.kind === "clarify");

describe("clarify lifecycle projection", () => {
  it("flips the single clarify card from awaiting→answered when the clearing frame arrives", () => {
    const events: BrainEvent[] = [
      { t: "clarify", question: "用哪个集成？", options: [{ label: "A", value: "a", recommended: true }, { label: "B", value: "b" }], awaitingAnswer: true },
      { t: "message", text: "✅ 收到你的回答：A" },
      { t: "clarify", question: "用哪个集成？", awaitingAnswer: false },
    ];
    const blocks = toBlocks(t, events);
    // exactly ONE clarify card (the clearing frame dedupes onto the pending one, not a second card)…
    expect(blocks.filter((b) => b.kind === "clarify")).toHaveLength(1);
    // …and it is now answered, not sticky-waiting
    expect(clarifyBlock(blocks)?.awaiting).toBe(false);

    // the timeline gate flips await→ok too (and does not push a duplicate "询问用户" step)
    const steps = deriveBrainFlow(t, events);
    const gateSteps = steps.filter((s) => s.kind === "gate" && s.label === "询问用户");
    expect(gateSteps).toHaveLength(1);
    expect(gateSteps[0]!.status).toBe("ok");
  });

  it("keeps the card waiting while genuinely parked (no clearing frame yet)", () => {
    const events: BrainEvent[] = [
      { t: "clarify", question: "用哪个集成？", awaitingAnswer: true },
    ];
    const blocks = toBlocks(t, events);
    expect(clarifyBlock(blocks)?.awaiting).toBe(true);
    const steps = deriveBrainFlow(t, events);
    expect(steps.find((s) => s.kind === "gate" && s.label === "询问用户")?.status).toBe("await");
  });

  it("replays cleanly: a full buffer re-render (reconnect) lands on answered, not a resurrected wait", () => {
    // toBlocks is a pure fold over the persisted event buffer — replaying the whole buffer (what a
    // reconnect does) must reproduce the answered state, which was the sticky-forever bug pre-fix.
    const events: BrainEvent[] = [
      { t: "clarify", question: "q", awaitingAnswer: true },
      { t: "message", text: "✅ 收到你的回答：x" },
      { t: "clarify", question: "q", awaitingAnswer: false },
    ];
    const first = clarifyBlock(toBlocks(t, events))?.awaiting;
    const replay = clarifyBlock(toBlocks(t, [...events]))?.awaiting;
    expect(first).toBe(false);
    expect(replay).toBe(false);
  });

  it("does not let a late resolution for an old id close a newer clarify card", () => {
    const events: BrainEvent[] = [
      { t: "clarify", interactionId: "hitl_old", question: "旧问题", awaitingAnswer: true },
      { t: "clarify", interactionId: "hitl_new", question: "新问题", awaitingAnswer: true },
      { t: "clarify", interactionId: "hitl_old", question: "旧问题", awaitingAnswer: false },
    ];
    const cards = toBlocks(t, events).filter((block): block is Extract<Block, { kind: "clarify" }> => block.kind === "clarify");
    expect(cards).toEqual([
      expect.objectContaining({ interactionId: "hitl_old", awaiting: false }),
      expect.objectContaining({ interactionId: "hitl_new", awaiting: true }),
    ]);
    const gates = deriveBrainFlow(t, events).filter((step) => step.kind === "gate" && step.label === "询问用户");
    expect(gates).toEqual([
      expect.objectContaining({ interactionId: "hitl_old", status: "ok" }),
      expect.objectContaining({ interactionId: "hitl_new", status: "await" }),
    ]);
  });

  it("does not let an unaddressed legacy resolution close an addressed current card", () => {
    const events: BrainEvent[] = [
      { t: "clarify", interactionId: "hitl_current", question: "当前问题", awaitingAnswer: true },
      { t: "clarify", question: "旧问题", awaitingAnswer: false },
    ];
    expect(clarifyBlock(toBlocks(t, events))).toMatchObject({
      interactionId: "hitl_current",
      awaiting: true,
    });
    expect(deriveBrainFlow(t, events).find((step) => step.interactionId === "hitl_current")).toMatchObject({ status: "await" });
  });
});
