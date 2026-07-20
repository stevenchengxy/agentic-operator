// #SKILL-INDUCE (P0-6) — AWM-style skill induction from SUCCESSFUL runs.
//
// Agent Workflow Memory (arXiv 2409.07429): induce reusable workflows from trajectories the
// evaluator judged successful — +51.1% relative success on WebArena, with instance details
// abstracted into placeholders ("dry cat food" → {product-name}). ASI (arXiv 2504.06821) adds the
// verification gate: skills enter the library ONLY off verified-successful executions (+23.5%).
//
// Our translation: when a factory run FINISHES with a real sandbox full-chain pass (the verified
// success), distill ≤2 reusable skills from the run digest, dedup against the existing library,
// apply create_skill's own safety gates (fragment length, no-rule-embedding is the caller's check,
// prompt-injection sanitizing), and persist through the SAME SkillStore the brain uses. The data
// (runs/steps/llm_turns telemetry) was already captured — this builds the missing pipe.

import type { GeneratedAgentSpec } from "./spec-types";
import { chatOnce } from "./stream-gateway";
import { sanitizeSkillFragment } from "./tools";
import { parseLooseArray } from "./memory-consolidation";

export interface InducedSkill { name: string; purpose: string; promptFragment: string; tools: string[]; decisionRule: string }

type Llm = (sys: string, usr: string) => Promise<string>;

export const kebab = (s: string): string =>
  (s || "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "skill";

const tokens = (s: string): Set<string> => new Set((s || "").toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((t) => t.length >= 2));

/** Similar-purpose dedup vs the existing library (slug match OR ≥60% purpose-token overlap). */
export function isDuplicateSkill(cand: { name: string; purpose: string }, existing: Array<{ slug: string; purpose: string }>): boolean {
  const slug = kebab(cand.name);
  for (const e of existing) {
    if (e.slug === slug) return true;
    const a = tokens(cand.purpose);
    const b = tokens(e.purpose);
    if (!a.size || !b.size) continue;
    const overlap = [...a].filter((t) => b.has(t)).length;
    if (overlap / Math.min(a.size, b.size) >= 0.6) return true;
  }
  return false;
}

/** Induce ≤maxSkills reusable skills from a VERIFIED-SUCCESSFUL run. Pure over the injected llm.
 * An explicit [] or candidates rejected by the safety/quality gates are legitimate empty results;
 * LLM and structured-output failures reject so the caller cannot claim learning was settled. */
export async function induceSkillsFromRun(opts: {
  domain: string;
  digest: string;
  specs: GeneratedAgentSpec[];
  existingSkills: Array<{ slug: string; purpose: string }>;
  llm?: Llm;
  maxSkills?: number;
}): Promise<InducedSkill[]> {
  const llm = opts.llm ?? chatOnce;
  const maxSkills = opts.maxSkills ?? 2;
  const toolsUsed = [...new Set(opts.specs.flatMap((s) => s.tools ?? []))];
  const sys =
    `你是技能归纳器（AWM 式）。从一次【已通过真实沙箱验收】的 Agent 工厂运行摘要中归纳 0-${maxSkills} 个可复用技能——` +
    `跨域可迁移的方法/套路（如"闸口 agent 先 fetch 规则再判定"这类流程模式），不是这次运行的具体产物复述。` +
    `硬要求：①实例值全部抽象成 {占位符}；②promptFragment 是可直接注入后续生成的指令片段（≥40 字）；③decisionRule 一句话说清何时用；` +
    `④不得与【已有技能】重复；⑤tools 只能从给定的工具清单里选（可为空）。没有值得沉淀的就输出 []。` +
    `只输出 JSON 数组：[{"name":"...","purpose":"...","promptFragment":"...","tools":["..."],"decisionRule":"..."}]。`;
  const usr =
    `业务域：${opts.domain}\n本次用到的工具：${toolsUsed.join("、") || "（无）"}\n` +
    `已有技能（勿重复）：${opts.existingSkills.map((s) => `${s.slug}(${s.purpose.slice(0, 40)})`).join("；") || "（空）"}\n` +
    `运行摘要：\n${opts.digest.slice(0, 12_000)}`;
  const rows = parseLooseArray(await llm(sys, usr));
  const toolSet = new Set(toolsUsed);
  const out: InducedSkill[] = [];
  for (const [index, row] of rows.entries()) {
    if (out.length >= maxSkills) break;
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new TypeError(`induced skill #${index + 1} must be an object`);
    }
    const raw = row as Record<string, unknown>;
    if (
      typeof raw.name !== "string" ||
      typeof raw.purpose !== "string" ||
      typeof raw.promptFragment !== "string" ||
      typeof raw.decisionRule !== "string"
    ) {
      throw new TypeError(`induced skill #${index + 1} must contain string name, purpose, promptFragment, and decisionRule fields`);
    }
    if (raw.tools != null && (!Array.isArray(raw.tools) || raw.tools.some((tool) => typeof tool !== "string"))) {
      throw new TypeError(`induced skill #${index + 1} tools must be an array of strings`);
    }
    const name = raw.name.trim().slice(0, 60);
    const purpose = raw.purpose.trim().slice(0, 200);
    const fragRaw = raw.promptFragment.trim();
    const decisionRule = raw.decisionRule.trim().slice(0, 200);
    // create_skill's own gates: fragment ≥24 chars, rule ≥8 chars (we ask ≥40 but enforce the floor).
    if (!name || !purpose || fragRaw.length < 24 || decisionRule.length < 8) continue;
    if (isDuplicateSkill({ name, purpose }, opts.existingSkills)) continue;
    const san = sanitizeSkillFragment(fragRaw);
    out.push({
      name,
      purpose,
      promptFragment: san.clean.slice(0, 1200),
      tools: (raw.tools ?? []).filter((tool): tool is string => typeof tool === "string" && toolSet.has(tool)).slice(0, 6),
      decisionRule,
    });
  }
  return out;
}
