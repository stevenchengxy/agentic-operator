import { describe, it, expect } from "vitest";
import { localEmbed, cosine } from "@agentic/runtime";

// The vector-recall MemoryDriver replaces the v1 NoMemoryDriverError stub. The core is a
// deterministic offline embedding + cosine ranking; these tests prove it genuinely ranks related
// text above unrelated (i.e. it is real semantic-overlap recall, not a keyword LIKE).

describe("localEmbed — deterministic offline embedding", () => {
  it("is deterministic (same text → identical vector)", () => {
    const a = localEmbed("候选人简历匹配规则校验未通过");
    const b = localEmbed("候选人简历匹配规则校验未通过");
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("produces an L2-normalized vector (self-cosine ≈ 1)", () => {
    const v = localEmbed("resume parse error");
    expect(cosine(v, v)).toBeCloseTo(1, 5);
  });

  it("empty text is safe (no NaN)", () => {
    const v = localEmbed("");
    expect(cosine(v, v)).toBeGreaterThanOrEqual(0);
  });
});

describe("cosine ranking — related text ranks above unrelated", () => {
  it("English: a resume-error query is closer to a resume-error doc than to a JD doc", () => {
    const q = localEmbed("resume parsing failed for candidate");
    const related = cosine(q, localEmbed("candidate resume parse error"));
    const unrelated = cosine(q, localEmbed("generate a job description posting"));
    expect(related).toBeGreaterThan(unrelated);
  });

  it("Chinese: a rule-check-fail query is closer to a match-fail doc than to a JD doc", () => {
    const q = localEmbed("简历匹配规则校验未通过");
    const related = cosine(q, localEmbed("候选人简历匹配失败，规则未过"));
    const unrelated = cosine(q, localEmbed("生成职位描述并发布招聘"));
    expect(related).toBeGreaterThan(unrelated);
  });

  it("orders a small corpus by relevance to the query", () => {
    const q = localEmbed("interview invitation email to candidate");
    const corpus = [
      "generate job description",
      "send interview invite email to the candidate",
      "parse resume pdf into fields",
    ];
    const ranked = corpus
      .map((t) => ({ t, s: cosine(q, localEmbed(t)) }))
      .sort((a, b) => b.s - a.s);
    expect(ranked[0]!.t).toContain("interview invite");
  });
});
