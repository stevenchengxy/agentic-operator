import { describe, expect, it } from "vitest";
import {
  containsDomainKnowledgeSecret,
  parseHumanDomainMemories,
  redactDomainKnowledge,
} from "./domain-knowledge";

describe("domain knowledge safety", () => {
  it("redacts credentials before displaying legacy or imported memory", () => {
    const text = [
      "Authorization: Bearer abcdefghijklmnop",
      "api_key=sk-abcdefghijklmnop",
      "postgres://reader:very-secret@db.internal/app",
      "eyJabc.def.ghi",
    ].join("\n");

    const redacted = redactDomainKnowledge(text);
    expect(redacted).not.toContain("abcdefghijklmnop");
    expect(redacted).not.toContain("very-secret");
    expect(redacted).not.toContain("eyJabc.def.ghi");
    expect(redacted).toContain("[REDACTED]");
    expect(containsDomainKnowledgeSecret(text)).toBe(true);
    expect(containsDomainKnowledgeSecret("人工批准后再发送邀请")).toBe(false);
  });

  it("only accepts confirmed human rows and sorts pinned knowledge first", () => {
    const memories = parseHumanDomainMemories({
      memories: [
        {
          id: "newer",
          domain: "Agents-generation",
          questionKey: "directive:newer",
          kind: "directive",
          question: "普通问题",
          answer: "普通回答",
          source: "human",
          confirmed: true,
          pinned: false,
          createdAt: "2026-07-14T01:00:00.000Z",
          updatedAt: "2026-07-14T03:00:00.000Z",
        },
        {
          id: "pinned",
          domain: "Agents-generation",
          questionKey: "boundary:invite",
          kind: "boundary",
          question: "token=do-not-show",
          answer: "人工审批产生 REQUESTED",
          source: "human",
          confirmed: true,
          pinned: true,
          createdAt: "2026-07-14T01:00:00.000Z",
          updatedAt: "2026-07-14T02:00:00.000Z",
        },
        {
          id: "ai-row",
          domain: "Agents-generation",
          questionKey: "ai",
          kind: "directive",
          question: "AI 猜测",
          answer: "不应显示",
          source: "ai",
          confirmed: true,
          pinned: true,
          createdAt: "2026-07-14T01:00:00.000Z",
          updatedAt: "2026-07-14T04:00:00.000Z",
        },
        {
          id: "foreign-row",
          domain: "Other-domain",
          questionKey: "foreign",
          kind: "directive",
          question: "另一个域",
          answer: "不应显示",
          source: "human",
          confirmed: true,
          pinned: true,
          createdAt: "2026-07-14T01:00:00.000Z",
          updatedAt: "2026-07-14T05:00:00.000Z",
        },
      ],
    }, "Agents-generation");

    expect(memories.map((memory) => memory.id)).toEqual(["pinned", "newer"]);
    expect(memories[0]?.question).toBe("token=[REDACTED]");
    expect(memories.every((memory) => memory.source === "human")).toBe(true);
  });
});
