/**
 * 招聘-v1 (zhaopin) tenant prompts — one `definePrompt` per `logic` action in
 * `models/zhaopin-v1/workflow_v1.json`. This is a FAITHFUL 1:1 migration of the
 * old AO "招聘-v1" 6-agent recruitment pipeline (createJD / processResume /
 * ruleCheckForCandidateIdentity / ruleCheckForMatchResume / matchResume /
 * inviteInternalInterview), with the exact triggers/emits from the deployed
 * MANIFEST, adapted to this runtime's tools (RoboHire + SQLite + LLM gateway).
 *
 * Boot-time validation (`findMissingTenantPrompts` in
 * `packages/runtime/src/register.ts`) refuses to register this tenant if any
 * logic action lacks a matching prompt here. Key by `action.name`.
 *
 * Branch-emit actions set `_emit` to one of the agent's `triggered_event`
 * values; the runtime's `selectEmittedEvent` reads it. Single-outcome agents
 * (createJD → JD_GENERATED, 10-3 → CANDIDATE_IDENTITY_CHECKED) need no `_emit`.
 */

import { definePrompt } from "@agentic/agent-kit";
import type { PromptDescriptor, ToolContext } from "@agentic/agent-kit";
import { z } from "zod";

/** Build a "context bundle" the LLM can read — trigger event + previous step output. */
function ctxBundle(ctx: ToolContext): string {
  const parts: string[] = [];
  if (ctx.event) {
    parts.push(`Trigger event: ${ctx.event.name}`);
    parts.push(`Event data: ${JSON.stringify(ctx.event.data ?? {}, null, 2)}`);
  }
  if (ctx.subject) parts.push(`Subject: ${ctx.subject}`);
  if (ctx.lastResult !== undefined) {
    parts.push(
      `Previous step output: ${JSON.stringify(ctx.lastResult, null, 2)}`,
    );
  }
  return parts.join("\n");
}

// Runtime-enforced structured outputs. The prompts already asked for these
// exact JSON shapes, but without `output` the runtime returned raw model text
// and downstream tools saw a string (often a ```json fenced string).
const jdOutputSchema = z
  .object({
    title: z.string(),
    keywords: z.array(z.string()).length(5),
    responsibilities: z.array(z.string()),
    must_have: z.array(z.string()),
    nice_to_have: z.array(z.string()),
    company: z.string(),
    compensation: z.string(),
    logistics: z.string(),
    jd_content: z.string().min(1),
  })
  .passthrough();

const requisitionMappingSchema = z
  .object({
    mapping: z.array(
      z
        .object({
          posting_key: z.string(),
          requirement_ids: z.array(z.string()),
          channel: z.string().nullable(),
          variant_note: z.string().nullable(),
        })
        .passthrough(),
    ),
    rationale: z.string(),
  })
  .passthrough();

const completenessSchema = z
  .object({
    complete: z.boolean(),
    missing_fields: z.array(z.string()),
    candidate_id: z.string().nullable(),
    lock_conflict: z.boolean(),
  })
  .passthrough();

const candidacySchema = z
  .object({
    _emit: z.enum(["RESUME_PROCESSED", "RESUME_LOCKED_CONFLICT"]),
    decision: z.enum(["proceed", "lock_conflict"]),
    candidate_id: z.string().nullable(),
    missing_fields: z.array(z.string()),
    reason: z.string(),
  })
  .passthrough();

const candidateIdentitySchema = z
  .object({
    same_person: z.boolean(),
    same_as_candidate_id: z.string().nullable(),
    matched_tier: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .nullable(),
    dedup_action: z.enum(["merge", "new", "pending-review"]),
    needs_review: z.boolean(),
    decision_reason: z.string(),
  })
  .passthrough();

const ruleResultSchema = z
  .object({
    rule_id: z.string(),
    status: z.enum(["pass", "fail", "insufficient_info"]),
    reason: z.string(),
    evidence: z.string().nullable(),
  })
  .passthrough();

const ruleResultsSchema = z
  .object({
    rule_results: z.array(ruleResultSchema),
  })
  .passthrough();

const matchOutcomeSchema = z
  .object({
    _emit: z.enum(["MATCH_PASSED_NEED_INTERVIEW", "MATCH_FAILED"]),
    match_score: z.number(),
    decision_reason: z.string(),
  })
  .passthrough();

// ── 4 createJD (JDGenerator) ─────────────────────────────────────────────────
// Retained only for replaying historical zhaopin manifests. The live v1
// workflow calls the verified RoboHire generateJdApi adapter, as old AO did.

export const generateJDContent = definePrompt({
  name: "generateJDContent",
  description:
    "Draft a complete, platform-ready job description from a clarified hiring requirement.",
  system:
    "你是一名资深招聘内容专家，为中国招聘市场（前程无忧 / 智联 / BOSS 直聘 / 猎聘 / 企业官网）撰写规范、合规、有吸引力的职位描述（JD）。" +
    "输入是一份已澄清的招聘需求（岗位、部门、职级、技能、年限、学历、薪资带、工作地点、用工方式、招聘人数、紧急度、原始职责、澄清记录等；字段可能中英混合或部分缺失）。" +
    "规则：(1) 标题简洁可检索，含核心岗位 + 关键限定（如『高级 Java 后端工程师（上海）』）；" +
    "(2) 给出恰好 5 个最优搜索关键词，覆盖岗位同义词 + 核心技能，用于渠道投放；" +
    "(3) 职责与任职要求拆成清晰要点，区分硬性要求（must-have）与加分项（nice-to-have），忠实于输入、不臆造未提供的技能或年限；" +
    "(4) 薪资忠实于输入：给出区间则保留，缺失写『面议』，不得编造数字；" +
    "(5) 合规：不得包含年龄 / 性别 / 婚育 / 地域 / 院校歧视等违反《就业促进法》的措辞，并剔除任何个人隐私信息（PII）；" +
    "(6) 产出完整 Markdown 正文 jd_content，结构固定为：## 职位概述 / ## 岗位职责 / ## 任职要求 / ## 公司介绍 / ## 薪资福利 / ## 工作安排。",
  template: (ctx) =>
    `基于以下已澄清的招聘需求，生成一份可直接发布的标准化 JD。\n\n${ctxBundle(ctx)}\n\n` +
    `只返回 JSON（不要额外解释或 Markdown 代码块），结构：\n` +
    `{\n` +
    `  "title": string,              // 可检索的职位标题\n` +
    `  "keywords": string[],         // 恰好 5 个搜索关键词\n` +
    `  "responsibilities": string[], // 岗位职责要点\n` +
    `  "must_have": string[],        // 硬性任职要求\n` +
    `  "nice_to_have": string[],     // 加分项\n` +
    `  "company": string,            // 公司介绍（输入缺失则简短中性表述）\n` +
    `  "compensation": string,       // 薪资福利（忠实于输入，缺失写 "面议"）\n` +
    `  "logistics": string,          // 工作地点 / 用工方式 / 工作时间\n` +
    `  "jd_content": string          // 上述内容拼成的完整 Markdown 正文\n` +
    `}`,
  output: jdOutputSchema,
});

export const handleRequisitionMapping = definePrompt({
  name: "handleRequisitionMapping",
  description:
    "Decide how clarified requirements map to job postings (1-to-many / many-to-1).",
  system:
    "你是招聘运营规划专家。给定一个或多个已澄清的招聘需求与刚生成的 JD，判定『需求 ↔ 职位发布』的映射关系：" +
    "同一客户、相同岗位的多个需求可聚合为一个职位发布（many-to-1）；同一需求若需面向不同渠道定制，则拆为多个发布版本（1-to-many）。" +
    "posting_key 需稳定且可读；仅依据输入判断，信息不足时默认 1:1，并在 rationale 说明聚合 / 拆分理由。",
  template: (ctx) =>
    `规划需求与职位发布的映射。\n\n${ctxBundle(ctx)}\n\n` +
    `只返回 JSON：\n` +
    `{ "mapping": [ { "posting_key": string, "requirement_ids": string[], "channel": string | null, "variant_note": string | null } ], "rationale": string }`,
  output: requisitionMappingSchema,
});

// ── 9-1 processResume (ResumeParser) ─────────────────────────────────────────
// Migrated from old resume-parser-agent. Old chain: MinIO download → RoboHire
// parse → dedup/lock → completeness. Here: fs.readFromInbox → parseResumeApi →
// candidateDedupLookup (lock) → validateCompleteness → validateCandidacy.

export const validateCompleteness = definePrompt({
  name: "validateCompleteness",
  description: "Check resume completeness and surface a missing-fields list.",
  system:
    "你是简历解析质检员。核对已解析的候选人档案是否具备必填字段：姓名、手机号、邮箱、教育经历、工作经历、项目经历。" +
    "原样透传上一步查重/锁定结果中的 candidate_id、lock_conflict、is_new。只依据输入判断，缺失项如实列出，不臆造数据。",
  template: (ctx) =>
    `校验候选人档案完整性。\n\n${ctxBundle(ctx)}\n\n` +
    `只返回 JSON：\n` +
    `{ "complete": boolean, "missing_fields": string[], "candidate_id": string | null, "lock_conflict": boolean }`,
  output: completenessSchema,
});

// Routing gate (last action of 9-1). Faithful emits: RESUME_PROCESSED |
// RESUME_LOCKED_CONFLICT (the deployed 招聘-v1 processResume only emits these two
// — a recruiter-lock conflict terminates, everything else proceeds to matching).
export const validateCandidacy = definePrompt({
  name: "validateCandidacy",
  description:
    "Route the resume: RESUME_LOCKED_CONFLICT when the candidate is locked by another recruiter, else RESUME_PROCESSED.",
  system:
    "你是候选人入库门禁。依据上一步的完整性与锁定校验结果决定流转：" +
    "(a) 若 lock_conflict 为真 → 该候选人已被其他 Recruiter 锁定，归属冲突，终止本次处理；" +
    "(b) 否则 → 放行进入后续查重与匹配环节（缺失字段可在结果中标注，但不阻断主链路）。" +
    "必须在 `_emit` 字段给出最终事件名（只能是 RESUME_PROCESSED 或 RESUME_LOCKED_CONFLICT），运行时据此路由下游。",
  template: (ctx) =>
    `决定候选人下一步流转。\n\n${ctxBundle(ctx)}\n\n` +
    `只返回 JSON：\n` +
    `{\n` +
    `  "_emit": "RESUME_PROCESSED" | "RESUME_LOCKED_CONFLICT",  // 路由事件\n` +
    `  "decision": "proceed" | "lock_conflict",\n` +
    `  "candidate_id": string | null,\n` +
    `  "missing_fields": string[],\n` +
    `  "reason": string\n` +
    `}`,
  output: candidacySchema,
});

// ── 10-3 ruleCheckForCandidateIdentity (CandidateDedup) ──────────────────────
// Migrated from old candidate-identity-agent (audit-only, soft-fail). Runs the
// 9-15 three-tier identity ruleset; LLM only judges fuzzy-field equivalence.
// Single outcome → CANDIDATE_IDENTITY_CHECKED (no _emit needed).

export const checkCandidateIdentity = definePrompt({
  name: "checkCandidateIdentity",
  description:
    "Judge whether the just-parsed candidate is the same person as an existing candidate, per the 9-15 three-tier identity rules (audit-only, soft-fail).",
  system:
    "你是候选人身份去重审查员（仅审计、不阻断主流程）。基于上一步 candidateDedupLookup 返回的候选池比对结果，按 9-15『同一候选人判定规则』的三级优先级判定本次上传的候选人是否与系统已有候选人为同一人：" +
    "① 手机号一致（精确匹配，最强信号）；" +
    "② 姓名 + 邮箱一致（姓名走语义等价、邮箱精确）；" +
    "③ 姓名 + 性别 + 学校 + 专业 + 学历 + 毕业时间 六字段一致（四项语义等价、两项精确）—— 为弱信号，仅标记人工复核，绝不自动合并。" +
    "命中即停（取最先命中的层级）。姓名/学校/专业/学历等模糊字段做语义等价判断（如『张三』≈『张 三』、『清华』≈『清华大学』）。" +
    "判为同一人 → same_person=true 且给出 same_as_candidate_id（新简历挂到老档，一人多简历）；否则 same_person=false。" +
    "任何不确定从严标记 needs_review，不臆造。",
  template: (ctx) =>
    `判定候选人身份是否重复。\n\n${ctxBundle(ctx)}\n\n` +
    `只返回 JSON：\n` +
    `{\n` +
    `  "same_person": boolean,\n` +
    `  "same_as_candidate_id": string | null,  // 命中重复时指向已有候选人，否则 null\n` +
    `  "matched_tier": 1 | 2 | 3 | null,         // 命中的规则层级\n` +
    `  "dedup_action": "merge" | "new" | "pending-review",\n` +
    `  "needs_review": boolean,\n` +
    `  "decision_reason": string\n` +
    `}`,
  output: candidateIdentitySchema,
});

// ── 10-1 ruleCheckForMatchResume (RuleCheck) ─────────────────────────────────
// Migrated from old rule-check-agent (the match-rule GATE before scoring).
// Three rule domains run as ordered steps, each APPENDING to a cumulative
// `rule_results` array; the deterministic foldRuleDecision tool (last action)
// folds them fail-closed and routes MATCH_RULE_CHECK_PASSED / _FAILED.

export const checkRelatedCompaniesRecords = definePrompt({
  name: "checkRelatedCompaniesRecords",
  description:
    "Related-companies freeze check — flag candidates with Huawei/Honor or OPPO/Xiaomi (and affiliates) employment history.",
  system:
    "你是匹配前规则检查员（关联公司冷冻期）。检查候选人的历史工作经历是否包含华为 / 荣耀及其关联公司、OPPO / 小米及其关联公司等受限背景。" +
    "命中受限背景且处于冷冻期 → 该条规则 fail（引用简历中的具体公司与时间证据）；无受限背景 → pass；简历信息不足以判断 → insufficient_info（不要臆测）。" +
    "这是规则链的第一步：新建 rule_results 数组，仅放入本步判定。",
  template: (ctx) =>
    `执行关联公司冷冻期规则检查。\n\n${ctxBundle(ctx)}\n\n` +
    `只返回 JSON：\n` +
    `{ "rule_results": [ { "rule_id": "related_companies_freeze", "status": "pass" | "fail" | "insufficient_info", "reason": string, "evidence": string | null } ] }`,
  output: ruleResultsSchema,
});

export const checkNationality = definePrompt({
  name: "checkNationality",
  description:
    "Nationality eligibility check against the role's requirement; appends to rule_results.",
  system:
    "你是匹配前规则检查员（国籍限制）。根据候选人国籍判断是否符合岗位的国籍 / 工作品类要求（如非中国籍仅限特定外籍人在国内工作品类通道）。" +
    "不符合 → fail（引用证据）；符合 → pass；国籍字段缺失 → insufficient_info。" +
    "原样保留上一步 Previous step output 中已有的 rule_results 数组，并把本步判定 APPEND 进去后整体返回（不要丢弃前序结果）。",
  template: (ctx) =>
    `执行国籍规则检查，并在上一步 rule_results 基础上追加本步判定。\n\n${ctxBundle(ctx)}\n\n` +
    `只返回 JSON（rule_results 含此前所有规则 + 本步 nationality 规则）：\n` +
    `{ "rule_results": [ { "rule_id": string, "status": "pass" | "fail" | "insufficient_info", "reason": string, "evidence": string | null } ] }`,
  output: ruleResultsSchema,
});

export const checkReflux = definePrompt({
  name: "checkReflux",
  description:
    "Reflux freezing-period check (Tencent FTE/outsource, ByteDance secondment, etc.); appends to rule_results.",
  system:
    "你是匹配前规则检查员（回流冷冻期）。从候选人详细工作履历与职责描述中识别回流人员（腾讯正编、腾讯外包、友商字节派驻等），区分 BPO 与非 BPO 业务类型，按客户与事业群维度执行回流冷冻期拦截，并校验利益冲突（亲属回避）声明。" +
    "命中冷冻期或利益冲突 → fail（引用证据）；无回流风险 → pass；履历信息不足 → insufficient_info。" +
    "原样保留上一步 Previous step output 中已有的 rule_results 数组，并把本步判定 APPEND 进去后整体返回。这是规则链的最后一步，返回的 rule_results 即供确定性折叠（foldRuleDecision）使用。",
  template: (ctx) =>
    `执行回流冷冻期规则检查，并在上一步 rule_results 基础上追加本步判定。\n\n${ctxBundle(ctx)}\n\n` +
    `只返回 JSON（rule_results 含此前所有规则 + 本步 reflux 规则）：\n` +
    `{ "rule_results": [ { "rule_id": string, "status": "pass" | "fail" | "insufficient_info", "reason": string, "evidence": string | null } ] }`,
  output: ruleResultsSchema,
});

// ── 10-2 matchResume (Matcher) ───────────────────────────────────────────────
// Migrated from old match-resume-agent. Runs ONLY after the rule-check gate
// passes (trigger MATCH_RULE_CHECK_PASSED). Pure scoring: may call matchResumeApi
// (RoboHire) for a score, then routes via _emit on the three outcomes.

export const decideMatchOutcome = definePrompt({
  name: "decideMatchOutcome",
  description:
    "Score the (already rule-passed) candidate against the JD and route via _emit.",
  system:
    "你是简历匹配决策官。本节点的前置规则检查（关联公司 / 国籍 / 回流冷冻期）已通过，你只需做匹配评分与路由。" +
    "读取已由 matchResumeApi 返回的 RoboHire 0-100 量化打分，严格按生产阈值路由：" +
    "评分 < 40 → MATCH_FAILED；评分 >= 40 → MATCH_PASSED_NEED_INTERVIEW。" +
    "免面试分支已经下线，禁止输出 MATCH_PASSED_NO_INTERVIEW；评分缺失时不得编造。",
  template: (ctx) =>
    `给出最终匹配结论。\n\n${ctxBundle(ctx)}\n\n` +
    `只返回 JSON：\n` +
    `{\n` +
    `  "_emit": "MATCH_PASSED_NEED_INTERVIEW" | "MATCH_FAILED",\n` +
    `  "match_score": number,\n` +
    `  "decision_reason": string\n` +
    `}`,
  output: matchOutcomeSchema,
});

// ── registry export ──────────────────────────────────────────────────────────

/** Keyed by `action.name`. `findMissingTenantPrompts` validates every logic
 *  action in `models/zhaopin-v1/workflow_v1.json` resolves here. */
export const zhaopinPrompts: Record<string, PromptDescriptor> = {
  // 4 createJD
  generateJDContent,
  handleRequisitionMapping,
  // 9-1 processResume
  validateCompleteness,
  validateCandidacy,
  // 10-3 ruleCheckForCandidateIdentity
  checkCandidateIdentity,
  // 10-1 ruleCheckForMatchResume
  checkRelatedCompaniesRecords,
  checkNationality,
  checkReflux,
  // 10-2 matchResume
  decideMatchOutcome,
};
