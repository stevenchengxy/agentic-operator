// #SKILL-PROMOTE (P2) — 跨域通用道晋升的纯判定核（P7 治理巡检挂载，仿 fleet-governance：
// 纯函数、无 I/O、无 Date.now，DI 便于测试）。
//
// ASI（arXiv 2504.06821）纪律的跨域延伸：单域验证有效 ≠ 跨域成立；只有当同一方法在
// ≥2 个不同域【各自】积累了足够验证（evalCount ≥ minEvals 且 Laplace 胜率 ≥ minRate）
// 才允许晋升 general（domainKey=""）。召回侧早已建成（DrizzleSkillStore.list 并入 general
// 行、domain-exact 覆盖 general）——本模块只补缺失的写入判定；已存在等价 general 行时
// 幂等跳过，绝不重复晋升。晋升只【复制】已通过安全门的赢家内容，从不生成新文本。

import { isDuplicateSkill, kebab } from "./skill-induction";

export interface PromotableSkillRow {
  slug: string;
  /** "" = 已是 general 行（作为幂等挡板参与判定，自身不再晋升）。 */
  domainKey: string;
  name: string;
  purpose: string;
  promptFragment: string;
  tools: string[];
  decisionRule: string;
  useCount: number;
  evalCount: number;
  successCount: number;
}

export interface GeneralPromotionDecision {
  slug: string;
  name: string;
  purpose: string;
  promptFragment: string;
  tools: string[];
  decisionRule: string;
  /** 支撑晋升的去重域清单（≥2）。 */
  domains: string[];
  /** 赢家的 Laplace 胜率 (success+1)/(eval+2)。 */
  effectiveness: number;
  reason: string;
}

const laplace = (r: { successCount: number; evalCount: number }): number => (r.successCount + 1) / (r.evalCount + 2);

/**
 * 判定哪些技能可晋升 general。判据（默认 minEvals=3, minRate=0.6, maxPromotions=3）：
 * 1) 按 slug 相同或 purpose ≥60% token 重合聚组（复用 isDuplicateSkill 的相似度）；
 * 2) 组内【达标变体】（evalCount≥minEvals 且胜率≥minRate）须覆盖 ≥2 个不同 domainKey；
 * 3) 已存在等价 general 行（同组）→ 幂等跳过；
 * 4) 赢家 = 达标变体中胜率最高（平局取 useCount 高、再 slug 字典序，保证确定性）。
 */
export function evaluateGeneralPromotion(
  rows: PromotableSkillRow[],
  opts?: { minEvals?: number; minRate?: number; maxPromotions?: number },
): GeneralPromotionDecision[] {
  const minEvals = opts?.minEvals ?? 3;
  const minRate = opts?.minRate ?? 0.6;
  const maxPromotions = opts?.maxPromotions ?? 3;

  // 贪心聚组：代表元匹配（slug 相等或 purpose 相似）即入组。
  const groups: PromotableSkillRow[][] = [];
  for (const r of rows) {
    const home = groups.find((g) =>
      g.some((m) => m.slug === r.slug || isDuplicateSkill({ name: r.slug, purpose: r.purpose }, [{ slug: m.slug, purpose: m.purpose }])),
    );
    if (home) home.push(r);
    else groups.push([r]);
  }

  const decisions: GeneralPromotionDecision[] = [];
  for (const group of groups) {
    if (decisions.length >= maxPromotions) break;
    // 幂等挡板：组内已有 general 行 → 该方法论已在通用道，跳过。
    if (group.some((r) => r.domainKey === "")) continue;
    const qualified = group.filter((r) => r.domainKey !== "" && r.evalCount >= minEvals && laplace(r) >= minRate);
    const domains = [...new Set(qualified.map((r) => r.domainKey))];
    if (domains.length < 2) continue;
    const winner = [...qualified].sort((a, b) =>
      laplace(b) - laplace(a) || b.useCount - a.useCount || a.slug.localeCompare(b.slug),
    )[0]!;
    decisions.push({
      slug: kebab(winner.slug),
      name: winner.name,
      purpose: winner.purpose,
      promptFragment: winner.promptFragment,
      tools: winner.tools,
      decisionRule: winner.decisionRule,
      domains,
      effectiveness: laplace(winner),
      reason: `在 ${domains.join("、")} 各自验证有效（赢家胜率 ${laplace(winner).toFixed(2)}，evals ${winner.evalCount}）`,
    });
  }
  return decisions;
}
