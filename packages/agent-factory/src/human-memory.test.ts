import { describe, expect, it } from "vitest";
import { humanMemoryQuestionKey, renderHumanMemorySeed } from "./human-memory";
import type { FactoryHumanMemory } from "./ports";

const memory = (overrides: Partial<FactoryHumanMemory> = {}): FactoryHumanMemory => ({
  id: "fhm-1",
  domain: "agents-generation",
  questionKey: "clarify:q1",
  kind: "clarify",
  question: "Webhook URL 是什么？",
  answer: "https://example.test/hook?x=原文",
  context: "用于失败通知；保留 标点 与 空格",
  source: "human",
  conversationId: "frn-1",
  confirmed: true,
  pinned: true,
  createdAt: "2026-07-13T00:00:00.000Z",
  updatedAt: "2026-07-13T00:00:00.000Z",
  ...overrides,
});

describe("human-confirmed factory memory", () => {
  it("derives a stable, bounded question key from normalized wording and separates decision kinds", () => {
    const a = humanMemoryQuestionKey("clarify", "  Webhook   URL 是什么？ ");
    const b = humanMemoryQuestionKey("clarify", "webhook url 是什么？");
    expect(a).toBe(b);
    expect(a).toMatch(/^clarify:[a-f0-9]{32}$/);
    expect(humanMemoryQuestionKey("directive", "webhook url 是什么？")).not.toBe(a);
  });

  it("renders human question, answer, and context verbatim with provenance and pin state", () => {
    const seeded = renderHumanMemorySeed([memory()]);
    expect(seeded).toContain("source=human");
    expect(seeded).toContain("pinned=true");
    expect(seeded).toContain("question(verbatim): Webhook URL 是什么？");
    expect(seeded).toContain("answer(verbatim): https://example.test/hook?x=原文");
    expect(seeded).toContain("context(verbatim): 用于失败通知；保留 标点 与 空格");
  });
});
