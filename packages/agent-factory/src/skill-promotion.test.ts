import { describe, expect, it } from "vitest";
import { evaluateGeneralPromotion, type PromotableSkillRow } from "./skill-promotion";

// #SKILL-PROMOTE (P2) — 跨域通用道晋升的纯判定核。ASI 纪律：只有在 ≥2 个不同域各自被
// 验证有效（evalCount≥3 且 Laplace 胜率≥0.6）的技能才晋升 general（domainKey=""）；
// 已存在 general 等价技能则幂等跳过。召回侧已建成（list 早已并入 general 行），这里只补写入判定。

const row = (over: Partial<PromotableSkillRow>): PromotableSkillRow => ({
  slug: "gate-fetch-rules-first",
  domainKey: "zhaopin",
  name: "闸口先取规则",
  purpose: "闸口 agent 先 fetch 规则再判定，避免凭记忆放行",
  promptFragment: "在任何规则闸口动作里，先调用 {rules_fetch_tool} 取回当前规则全文再做判定。",
  tools: [],
  decisionRule: "动作是规则闸口时",
  useCount: 5,
  evalCount: 5,
  successCount: 4,
  ...over,
});

describe("#SKILL-PROMOTE — evaluateGeneralPromotion", () => {
  it("同 slug 跨 2 域、双双达标 → 晋升一次，赢家=胜率更高的变体", async () => {
    const decisions = evaluateGeneralPromotion([
      row({ domainKey: "zhaopin", evalCount: 5, successCount: 4, promptFragment: "赢家片段：先调用 {rules_fetch_tool} 取回规则全文再判定。" }), // 5/7≈0.714
      row({ domainKey: "raas", evalCount: 4, successCount: 2, promptFragment: "次席片段" }), // 3/6=0.5 → 未达标!
      row({ domainKey: "raas", slug: "gate-fetch-rules-first", evalCount: 6, successCount: 5, promptFragment: "raas 变体片段" }), // 6/8=0.75
    ]);
    expect(decisions).toHaveLength(1);
    const d = decisions[0]!;
    expect(d.slug).toBe("gate-fetch-rules-first");
    expect(d.domains.sort()).toEqual(["raas", "zhaopin"]);
    expect(d.promptFragment).toBe("raas 变体片段"); // 0.75 > 0.714
    expect(d.effectiveness).toBeCloseTo(0.75, 2);
  });

  it("只有 1 个域达标（另一域 evalCount 不足或胜率低）→ 不晋升", () => {
    expect(
      evaluateGeneralPromotion([
        row({ domainKey: "zhaopin", evalCount: 5, successCount: 5 }),
        row({ domainKey: "raas", evalCount: 2, successCount: 2 }), // evals 不足
      ]),
    ).toHaveLength(0);
    expect(
      evaluateGeneralPromotion([
        row({ domainKey: "zhaopin", evalCount: 5, successCount: 5 }),
        row({ domainKey: "raas", evalCount: 10, successCount: 3 }), // 胜率 4/12 < 0.6
      ]),
    ).toHaveLength(0);
  });

  it("同域多变体不算跨域；单域永不晋升", () => {
    expect(
      evaluateGeneralPromotion([
        row({ domainKey: "zhaopin", evalCount: 9, successCount: 9 }),
        row({ domainKey: "zhaopin", slug: "gate-fetch-rules-first", evalCount: 8, successCount: 8 }),
      ]),
    ).toHaveLength(0);
  });

  it("已存在等价 general 行（同 slug 或 purpose 相似）→ 幂等跳过", () => {
    const generalExisting = row({ domainKey: "", evalCount: 0, successCount: 0 });
    expect(
      evaluateGeneralPromotion([
        generalExisting,
        row({ domainKey: "zhaopin", evalCount: 5, successCount: 5 }),
        row({ domainKey: "raas", evalCount: 5, successCount: 5 }),
      ]),
    ).toHaveLength(0);
    // purpose 相似（≥60% token 重合）但 slug 不同的 general 行同样挡住
    expect(
      evaluateGeneralPromotion([
        row({ domainKey: "", slug: "another-slug", purpose: "闸口 agent 先 fetch 规则再判定，避免凭记忆放行（改写）" }),
        row({ domainKey: "zhaopin", evalCount: 5, successCount: 5 }),
        row({ domainKey: "raas", evalCount: 5, successCount: 5 }),
      ]),
    ).toHaveLength(0);
  });

  it("slug 不同但 purpose 相似的跨域变体合成一组，只晋升一次", () => {
    const decisions = evaluateGeneralPromotion([
      row({ domainKey: "zhaopin", slug: "gate-rules-first", evalCount: 5, successCount: 5 }),
      row({ domainKey: "raas", slug: "rule-gate-fetch", purpose: "闸口 agent 先 fetch 规则全文再判定，避免凭记忆放行", evalCount: 6, successCount: 5 }),
    ]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.domains.sort()).toEqual(["raas", "zhaopin"]);
  });

  it("maxPromotions 钳制单次晋升数量", () => {
    const mk = (slug: string, purpose: string) => [
      row({ slug, purpose, domainKey: "zhaopin", evalCount: 5, successCount: 5 }),
      row({ slug, purpose, domainKey: "raas", evalCount: 5, successCount: 5 }),
    ];
    const decisions = evaluateGeneralPromotion(
      [
        ...mk("skill-a", "第一种完全不同的方法论甲乙丙"),
        ...mk("skill-b", "第二种完全不同的套路丁戊己"),
        ...mk("skill-c", "第三种完全不同的流程庚辛壬"),
      ],
      { maxPromotions: 2 },
    );
    expect(decisions).toHaveLength(2);
  });
});
