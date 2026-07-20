import { describe, expect, it } from "vitest";
import { __buildStateSummaryForTest as buildStateSummary } from "./conductor";
import type { BrainCtx } from "./brain-types";

// #PERSPECTIVES — 折叠存活：业务视角的选配与成败必须写进状态快照，
// 否则一次 compaction 后大脑不知道理解里已含（或缺）哪些视角结论。

const mk = (over: Partial<BrainCtx> = {}): BrainCtx =>
  ({
    domain: "rec",
    goal: "生成智能体",
    specs: [],
    createdSkills: [],
    humanDirectives: [],
    spent: { turns: 1, tokens: 1000, sandboxRuns: 0 },
    emit: () => {},
    ...over,
  }) as unknown as BrainCtx;

describe("#PERSPECTIVES — buildStateSummary 折叠存活", () => {
  it("有 ontologyPerspectives → 快照含视角行（标签+成败计数）", () => {
    const s = buildStateSummary(
      mk({
        ontologyUnderstanding: "深读理解正文",
        ontologyUnderstandingMode: "deep",
        ontologyPerspectives: {
          selected: [
            { id: "operation", label: "运营视角", focus: "…", adapted: true },
            { id: "backoffice", label: "后台对账视角", focus: "…", adapted: false },
          ],
          okCount: 2,
          total: 2,
          source: "llm",
        },
      }),
    );
    expect(s).toContain("业务视角");
    expect(s).toContain("运营视角");
    expect(s).toContain("2/2");
  });

  it("回退选配标注默认三视角来源", () => {
    const s = buildStateSummary(
      mk({
        ontologyUnderstanding: "x",
        ontologyPerspectives: { selected: [{ id: "operation", label: "运营视角", focus: "…", adapted: false }], okCount: 1, total: 3, source: "fallback" },
      }),
    );
    expect(s).toContain("默认三视角");
  });

  it("无 ontologyPerspectives → 快照不出现视角行", () => {
    const s = buildStateSummary(mk({ ontologyUnderstanding: "浅读理解", ontologyUnderstandingMode: "shallow" }));
    expect(s).not.toContain("业务视角(");
  });
});
