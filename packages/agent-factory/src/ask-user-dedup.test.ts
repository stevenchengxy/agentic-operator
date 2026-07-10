import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS, normalizeQuestion } from "./tools";
import type { BrainCtx, BrainEvent } from "./brain-types";

// #ASK-DEDUP — ask_user must not re-interrupt the user with an already-answered question:
// the recorded answer is replayed to the brain instead (no park, no clarify event).

const askUser = FACTORY_TOOLS.find((t) => t.name === "ask_user")!;

function stubCtx(over: Partial<BrainCtx> = {}): { ctx: BrainCtx; emitted: BrainEvent[] } {
  const emitted: BrainEvent[] = [];
  const ctx = {
    emit: (e: BrainEvent) => emitted.push(e),
    humanDirectives: [],
    specs: [],
    ...over,
  } as unknown as BrainCtx;
  return { ctx, emitted };
}

describe("normalizeQuestion", () => {
  it("ignores punctuation/whitespace/case so trivially-rephrased duplicates collide", () => {
    expect(normalizeQuestion("Webhook URL 是什么？")).toBe(normalizeQuestion("webhook url 是什么"));
    expect(normalizeQuestion("要不要用真实工具?")).toBe(normalizeQuestion("要不要用真实工具！！"));
  });
});

describe("ask_user dedup (#ASK-DEDUP)", () => {
  it("first ask parks + emits clarify + records a pending marker", async () => {
    const { ctx, emitted } = stubCtx();
    const res = await askUser.execute({ question: "webhook URL 是什么？" }, ctx);
    expect(res.ok).toBe(true);
    expect(ctx.awaitingClarify).toBe(true);
    expect(emitted.some((e) => e.t === "clarify")).toBe(true);
    expect(ctx.askedQuestions![normalizeQuestion("webhook URL 是什么？")]).toBe("");
  });

  it("an ANSWERED question is replayed, not re-asked (no park, no clarify event)", async () => {
    const { ctx, emitted } = stubCtx({ askedQuestions: { [normalizeQuestion("webhook URL 是什么？")]: "https://x.example/hook" } });
    const res = await askUser.execute({ question: "Webhook url 是什么" }, ctx); // rephrased punctuation/case
    expect(res.ok).toBe(true);
    expect(res.summary).toContain("已经问过");
    expect(res.summary).toContain("https://x.example/hook");
    expect(ctx.awaitingClarify).toBeUndefined();
    expect(emitted.some((e) => e.t === "clarify")).toBe(false);
  });

  it("a PENDING (unanswered) question does not short-circuit re-parking after restart", async () => {
    // "" marks pending — a crash/restart mid-park may re-ask; that's correct (no answer exists yet).
    const { ctx } = stubCtx({ askedQuestions: { [normalizeQuestion("webhook URL 是什么？")]: "" } });
    const res = await askUser.execute({ question: "webhook URL 是什么？" }, ctx);
    expect(res.ok).toBe(true);
    expect(ctx.awaitingClarify).toBe(true); // parks again — pending means the user never answered
  });
});
