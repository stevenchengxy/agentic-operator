/**
 * RAAS tenant prompts — one `definePrompt` per `logic` action in
 * `models/RAAS-v1/workflow_v1.json`.
 *
 * Boot-time validation (`findMissingTenantPrompts` in
 * `packages/runtime/src/register.ts`) refuses to register the RAAS tenant if
 * any logic action lacks a matching prompt here. See
 * `docs/tech-design/ar-tool.md` § "Option B — strict".
 *
 * Prompts are deliberately minimal — they describe the role (1-2 sentences)
 * and a short template that pipes `ctx.lastResult` + the trigger event into
 * the LLM. They are NOT the final production prompts; engineers should refine
 * per-action wording with the recruiting team. The goal here is to make RAAS
 * boot cleanly so the v1 Wave 5 test sweep can exercise the runtime end-to-end.
 *
 * Key by `action.name` (NOT agent.name). One agent may contain multiple logic
 * actions and each needs its own prompt entry.
 */

import { definePrompt } from "@agentic/agent-kit";
import type { PromptDescriptor, ToolContext } from "@agentic/agent-kit";

/** Build a "context bundle" the LLM can read — trigger event + previous step output. */
function ctxBundle(ctx: ToolContext): string {
  const parts: string[] = [];
  if (ctx.event) {
    parts.push(`Trigger event: ${ctx.event.name}`);
    parts.push(`Event data: ${JSON.stringify(ctx.event.data ?? {}, null, 2)}`);
  }
  if (ctx.subject) parts.push(`Subject: ${ctx.subject}`);
  if (ctx.lastResult !== undefined) {
    parts.push(`Previous step output: ${JSON.stringify(ctx.lastResult, null, 2)}`);
  }
  if (ctx.results && Object.keys(ctx.results).length > 0) {
    parts.push(`Completed step outputs: ${JSON.stringify(ctx.results, null, 2)}`);
  }
  return parts.join("\n");
}

// ── syncFromClientSystem ─────────────────────────────────────────────────────

// Prompt fallbacks for logic-typed manifest versions. Newer manifests convert
// checkDeduplicatedRequisition/persistRequisitionData to deterministic tenant
// TOOLS (tools/requirement-sync.ts); these prompts keep older logic-typed
// versions bootable and are unused by tool-typed actions.
export const checkDeduplicatedRequisition = definePrompt({
  name: "checkDeduplicatedRequisition",
  description:
    "Deduplicate inbound recruiting requisitions against existing records.",
  system:
    "You are a recruiting-operations assistant. Inspect a client recruiting requisition and decide whether it is a NEW requisition, an UPDATE to an existing one, or a TERMINATION. Use the client_role_unique_id and client_role_name fields to match.",
  template: (ctx) =>
    `Determine whether this requisition is new, an update, or terminated.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "decision": "new" | "update" | "terminate", "matched_requisition_id": string | null, "reason": string }.`,
});

export const persistRequisitionData = definePrompt({
  name: "persistRequisitionData",
  description:
    "Plan the database writes that persist or update a recruiting requisition.",
  system:
    "You are a recruiting-operations data steward. Given a dedup decision, decide which fields to write to the recruiting_requirement and recruiting_role records, and what change-log entry to emit.",
  template: (ctx) =>
    `Plan persistence actions for this requisition.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "writes": [...], "change_log": string, "failed_items": [...] }.`,
});

export const notifyRecruiter = definePrompt({
  name: "notifyRecruiter",
  description:
    "Generate a recruiter-facing handoff message for the interview invite.",
  system:
    "You are a recruiter-ops assistant. Compose a short message the recruiter can forward via WeCom to the candidate, including a copy-paste script and the interview link.",
  template: (ctx) =>
    `Compose recruiter-facing handoff.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "recruiter_id": string, "wecom_message": string, "interview_link": string }.`,
});

export const generateInterviewInvitation = definePrompt({
  name: "generateInterviewInvitation",
  description:
    "Compose a personalized interview invitation (recipient + subject + body) for delivery.",
  system:
    "你是面试协调助理。为通过匹配的候选人撰写个性化的面试邀请。" +
    "可调用 inviteCandidateApi 生成邀请正文初稿（仅生成、不投递）再润色。" +
    "邀请需包含：称呼、岗位与公司、面试形式（线上 / 线下 / AI 面试）、时间窗口与截止日期、参与方式或链接占位、以及礼貌的确认请求。" +
    "语气专业友好；从上下文提取候选人邮箱或手机号作为收件人；不要编造未提供的时间或地点（缺失则用占位并注明需确认）。",
  template: (ctx) =>
    `撰写面试邀请。\n\n${ctxBundle(ctx)}\n\n` +
    `只返回 JSON（字段名固定，供下一步投递读取）：\n` +
    `{ "to": string, "subject": string, "body": string, "deadline_days": number, "invite_link_placeholder": string }`,
});


// ── analyzeRequirement ───────────────────────────────────────────────────────

export const assessFeasibilityAndDifficulty = definePrompt({
  name: "assessFeasibilityAndDifficulty",
  description:
    "Assess feasibility and difficulty of a recruiting requirement.",
  system:
    "You are a senior recruiter analyst. Evaluate whether a requirement is realistic given contract scope, market salary bands, timeline, and internal consistency. Rate hiring difficulty.",
  template: (ctx) =>
    `Assess feasibility and difficulty for this requirement.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "feasible": boolean, "difficulty": "easy" | "medium" | "hard" | "extreme", "key_risks": string[], "rationale": string }.`,
});

export const generateClarificationAndStrategy = definePrompt({
  name: "generateClarificationAndStrategy",
  description:
    "Generate clarifying questions and an initial recruiting strategy.",
  system:
    "You are a senior recruiter. Given an analyzed requirement, produce a prioritized list of questions to clarify with the client and an initial recruiting strategy (channels, timeline, expected conversion).",
  template: (ctx) =>
    `Generate clarification questions and recruiting strategy.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "questions": [{ "q": string, "priority": "high" | "medium" | "low", "background": string }], "strategy": { "channels": string[], "timeline_weeks": number, "expected_conversion": number } }.`,
});

// ── clarifyRequirement ───────────────────────────────────────────────────────

export const prepareClarificationMaterial = definePrompt({
  name: "prepareClarificationMaterial",
  description: "Compile clarification material for the delivery manager.",
  system:
    "You are a recruiting-operations assistant. Compile a clarification packet: prioritized questions, background context for each, and 1-2 historical analogues if available.",
  template: (ctx) =>
    `Compile clarification material.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "packet": [{ "q": string, "background": string, "suggested_followup": string }], "references": string[] }.`,
});

export const recordAndValidateResult = definePrompt({
  name: "recordAndValidateResult",
  description:
    "Parse a clarification response and validate completeness.",
  system:
    "You are a recruiting-operations validator. Parse the clarification result, update the must-have / nice-to-have / excluded fields on the requirement, and check whether all critical questions were answered without contradiction.",
  template: (ctx) =>
    `Parse and validate this clarification result.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "updates": { "must_have": string[], "nice_to_have": string[], "exclusions": string[] }, "complete": boolean, "unresolved_questions": string[] }.`,
});

// ── createJD ─────────────────────────────────────────────────────────────────

// Migrated from the old `createJD` production agent (server/inngest/agents/
// create-jd-agent.ts). The old agent flattened ~40 requisition/spec/
// clarification fields (buildPromptFromRequirement) and stitched a Markdown JD
// (assembleJdContent). In the new app there is no partner-Postgres: the
// clarified requirement arrives in the trigger event / previous step output,
// so the prompt reads it from `ctxBundle(ctx)` and produces the JD directly.
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
});

// ── assignRecruitTasks ───────────────────────────────────────────────────────

export const assignRecruitTasks = definePrompt({
  name: "assignRecruitTasks",
  description:
    "Suggest which recruiters should own a given role based on skills + workload.",
  system:
    "You are a recruiting-ops dispatcher. Given role attributes (type, difficulty, urgency, skills) and recruiter profiles (specialty, history, current load), suggest the best-fit recruiters.",
  template: (ctx) =>
    `Recommend recruiter assignments.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "recommendations": [{ "recruiter_id": string, "score": number, "reason": string }] }.`,
});

// ── processResume ────────────────────────────────────────────────────────────

// Migrated from the old ResumeParser agent's completeness gate. Its input
// (`ctx.lastResult`) is the candidateDedupLookup result, which carries
// candidate_id / lock_conflict / is_new plus the extracted name/phone/email.
export const validateCompleteness = definePrompt({
  name: "validateCompleteness",
  description: "Check resume completeness and surface a missing-fields list.",
  system:
    "你是简历解析质检员。核对已解析的候选人档案是否具备必填字段：姓名、手机号、邮箱、教育经历、工作经历、项目经历。" +
    "原样透传上一步查重结果中的 candidate_id、lock_conflict、is_new。只依据输入判断，缺失项如实列出，不臆造数据。",
  template: (ctx) =>
    `校验候选人档案完整性。\n\n${ctxBundle(ctx)}\n\n` +
    `只返回 JSON：\n` +
    `{ "complete": boolean, "missing_fields": string[], "candidate_id": string | null, "lock_conflict": boolean }`,
});

// Routing gate. Emits one of the node's two triggered_event values via `_emit`
// (the runtime's branch-emit reads it). lock_conflict OR missing info →
// RESUME_INFO_MISSING (退回 Recruiter); otherwise RESUME_PROCESSED.
export const validateCandidacy = definePrompt({
  name: "validateCandidacy",
  description:
    "Route the resume: RESUME_PROCESSED when complete & unlocked, else RESUME_INFO_MISSING.",
  system:
    "你是候选人入库门禁。依据上一步的完整性校验结果决定流转：" +
    "(a) 若 lock_conflict 为真 → 该候选人已被其他 Recruiter 锁定，退回并提示冲突；" +
    "(b) 否则若信息完整（complete 为真且无缺失项）→ 放行进入后续匹配；" +
    "(c) 否则信息缺失 → 退回 Recruiter 补充。" +
    "必须在 `_emit` 字段给出最终事件名（只能是 RESUME_PROCESSED 或 RESUME_INFO_MISSING），运行时据此路由下游。",
  template: (ctx) =>
    `决定候选人下一步流转。\n\n${ctxBundle(ctx)}\n\n` +
    `只返回 JSON：\n` +
    `{\n` +
    `  "_emit": "RESUME_PROCESSED" | "RESUME_INFO_MISSING",  // 路由事件\n` +
    `  "decision": "proceed" | "info_missing" | "lock_conflict",\n` +
    `  "candidate_id": string | null,\n` +
    `  "missing_fields": string[],\n` +
    `  "reason": string\n` +
    `}`,
});

// ── ruleCheckerForClientResume ───────────────────────────────────────────────

// Migrated from the old RuleCheck agent's rule-evaluator. IMPORTANT: this LLM
// step evaluates each client rule INDEPENDENTLY; it does NOT decide the overall
// verdict — the deterministic, fail-closed `foldRuleDecision` tool (next action)
// owns that, so an LLM outage can never silently pass a candidate.
export const ruleCheckerForClientResume = definePrompt({
  name: "检查客户规则",
  description:
    "Evaluate each client resume rule independently and report a per-rule status (the fold step decides the verdict).",
  system:
    "你是客户规则合规审查员。对照该客户的简历规则（背景限制、资质/证书要求、排除条件、竞业/红线等，规则集见上下文）逐条独立评估候选人简历。" +
    "对每条规则给出 status：pass（明确满足）/ fail（明确违反，必须引用简历中的具体字段或证据）/ insufficient_info（简历未提供足以判断的信息，不要猜测）。" +
    "只做逐条判定，不要给出整体通过/不通过结论（由后续确定性折叠决定）。规则集为空时返回空数组。",
  template: (ctx) =>
    `逐条评估客户规则。\n\n${ctxBundle(ctx)}\n\n` +
    `只返回 JSON：\n` +
    `{ "rule_results": [ { "rule_id": string, "status": "pass" | "fail" | "insufficient_info", "reason": string, "evidence": string | null } ] }`,
});

// ── matchResume ──────────────────────────────────────────────────────────────

export const validateRedlineAndBlacklist = definePrompt({
  name: "validateRedlineAndBlacklist",
  description:
    "Run redline + blacklist checks against a candidate.",
  system:
    "You are a recruiting-compliance checker. Verify the candidate against company and client blacklists, redline restrictions (non-compete, banned employers, high-risk separation codes), and historical employment flags.",
  template: (ctx) =>
    `Run redline + blacklist checks.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "passed": boolean, "blacklist_hits": string[], "redline_hits": string[], "tencent_history": boolean }.`,
});

export const matchHardRequirements = definePrompt({
  name: "matchHardRequirements",
  description:
    "Match a candidate against the requirement's hard criteria.",
  system:
    "You are a recruiting matcher. Compare the candidate against the role's hard requirements (education, years of experience, certifications, age range) using the And/Or logic from the clarified requirement.",
  template: (ctx) =>
    `Match hard requirements.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "matched": boolean, "criteria": [{ "name": string, "required": string, "actual": string, "passed": boolean }] }.`,
});

export const evaluateBonusAndCheckReflux = definePrompt({
  name: "evaluateBonusAndCheckReflux",
  description:
    "Score bonus attributes and check reflux freezing-period rules.",
  system:
    "You are a recruiting evaluator. Score the candidate's bonus attributes (top-tier employer, project highlights, skill overmatch), compute a composite match score, and enforce reflux freezing rules (Tencent FTE / Tencent outsource / competitor staffing) per client and BG.",
  template: (ctx) =>
    `Score bonus attributes and check reflux rules.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "match_score": number, "bonus_factors": string[], "reflux_blocked": boolean, "reflux_reason": string | null }.`,
});

// New routing action (replaces the old generateMatchResult tool — matchResumeApi
// can't be a direct type:tool action without {resume,jd}; it's advertised in the
// node's tool_use[] for this step to call instead). Aggregates the three checks
// and emits one of the node's three outcomes via `_emit` (branch-emit).
export const decideMatchOutcome = definePrompt({
  name: "decideMatchOutcome",
  description:
    "Aggregate compliance + hard-requirement + bonus results into a final match decision; route via _emit.",
  system:
    "你是终审匹配决策官。综合前序检查（红线/黑名单、硬性条件、加分与回流冷静期）的结论，给出候选人与岗位的最终匹配结论。" +
    "可调用 matchResumeApi（传入 {resume, jd} 文本）获取 RoboHire 量化打分作为参考，但最终判定以合规与硬性条件为先：" +
    "(a) 命中黑名单 / 红线，或回流冷静期未过，或硬性条件不达标 → 不通过（MATCH_FAILED）；" +
    "(b) 合规且硬性达标、综合评分高、需进一步面试核实 → 通过需面试（MATCH_PASSED_NEED_INTERVIEW）；" +
    "(c) 合规且硬性达标、已足够明确、无需面试即可推进 → 通过免面试（MATCH_PASSED_NO_INTERVIEW）。" +
    "必须在 `_emit` 给出三者之一，运行时据此路由；合规存疑时从严判定为不通过。",
  template: (ctx) =>
    `给出最终匹配结论。\n\n${ctxBundle(ctx)}\n\n` +
    `只返回 JSON：\n` +
    `{\n` +
    `  "_emit": "MATCH_PASSED_NEED_INTERVIEW" | "MATCH_PASSED_NO_INTERVIEW" | "MATCH_FAILED",\n` +
    `  "match_score": number,\n` +
    `  "compliance_blocked": boolean,\n` +
    `  "decision_reason": string\n` +
    `}`,
});

// ── evaluateInterview ────────────────────────────────────────────────────────

export const receiveInterviewResult = definePrompt({
  name: "receiveInterviewResult",
  description:
    "Acknowledge and normalize an inbound AI-interview result payload.",
  system:
    "You are an interview-results intake processor. Confirm the AI interview payload contains video, transcript, and per-question durations; emit a normalized record id for downstream analysis.",
  template: (ctx) =>
    `Acknowledge and normalize this interview result.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "interview_id": string, "ready_for_analysis": boolean, "missing_artifacts": string[] }.`,
});

export const analyzeInterviewResult = definePrompt({
  name: "analyzeInterviewResult",
  description:
    "Analyze interview answers and compare against role requirements.",
  system:
    "You are an interview analyst. Extract the key signals from the candidate's answers and compare them against the role's requirements. Score domain depth, problem-solving, communication, and reasoning.",
  template: (ctx) =>
    `Analyze interview content.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "scores": { "domain": number, "problem_solving": number, "communication": number, "reasoning": number }, "key_signals": string[], "concerns": string[] }.`,
});

export const evaluateWithModel = definePrompt({
  name: "evaluateWithModel",
  description:
    "Apply the supplied evaluation weights and threshold to the real interview-analysis scores.",
  system:
    "You are a quantitative interview evaluator. Use only the dimension scores, weights, and pass threshold present in the live context. Do not invent a missing model configuration. If weights or threshold are absent, return configuration_complete:false and explain what is missing; never silently pass.",
  template: (ctx) =>
    `Apply the configured evaluation model to the interview analysis.\n\n${ctxBundle(ctx)}\n\n` +
    `Return JSON: { "configuration_complete": boolean, "dimension_scores": Record<string, number>, "weights": Record<string, number>, "weighted_total": number | null, "pass_threshold": number | null, "passed": boolean, "missing_configuration": string[], "rationale": string }. ` +
    `passed must be false whenever configuration_complete is false.`,
});

export const generateEvaluationReport = definePrompt({
  name: "generateEvaluationReport",
  description:
    "Produce the final interview evaluation report with a recommendation.",
  system:
    "You are an interview-report writer. Produce a complete evaluation from the actual scoring result. Route EVALUATION_PASSED only when the scoring step has configuration_complete:true and passed:true; every missing/failed/ambiguous score routes EVALUATION_FAILED.",
  template: (ctx) =>
    `Write the evaluation report.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "_emit": "EVALUATION_PASSED" | "EVALUATION_FAILED", "overall_score": number | null, "dimensions": Record<string, number>, "highlights": string[], "strengths": string[], "concerns": string[], "risks": string[], "recommendation": "recommend" | "hold" | "reject", "decision_reason": string }.`,
});

// ── refineResume ─────────────────────────────────────────────────────────────

export const selectTemplateAndFormat = definePrompt({
  name: "selectTemplateAndFormat",
  description:
    "Pick the right client resume template and reformat the candidate resume.",
  system:
    "You are a resume formatter. Pick the client-specific template and restructure the candidate's resume content into it, unifying fonts, sizes, and spacing.",
  template: (ctx) =>
    `Pick template and reformat.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "template_id": string, "reformatted_sections": Record<string, string>, "format_notes": string }.`,
});

export const generateRefinedResume = definePrompt({
  name: "generateRefinedResume",
  description:
    "Generate the polished client-ready resume PDF content with keyword highlighting.",
  system:
    "You are a resume polisher. Identify role-relevant keywords in the candidate's resume, highlight them, and produce the final client-ready content. Preserve all core information exactly.",
  template: (ctx) =>
    `Polish the resume.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "highlighted_keywords": string[], "final_content_markdown": string, "pdf_filename_hint": string }.`,
});

// ── generateRecommendationPackage ────────────────────────────────────────────

export const checkCompleteness = definePrompt({
  name: "checkCompleteness",
  description:
    "Validate the submission-package material set for completeness and compliance.",
  system:
    "You are a submission-package validator. Check required artifacts (portfolio, compliance proofs, separation docs), clean PII fields, recognize non-traditional education credentials, and validate WeChat IDs.",
  template: (ctx) =>
    `Validate the package.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "complete": boolean, "missing_items": string[], "data_cleaning_notes": string[], "compliance_issues": string[] }.`,
});

export const requestMissingInfo = definePrompt({
  name: "requestMissingInfo",
  description:
    "Compose a missing-info request to the recruiter for the package.",
  system:
    "You are a recruiting-ops assistant. Compose a clear list of missing items for the recruiter to chase down with the candidate and set a follow-up reminder.",
  template: (ctx) =>
    `Compose missing-info request.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "recruiter_id": string, "missing_items": string[], "message": string, "followup_days": number }.`,
});

export const generateFinalPackage = definePrompt({
  name: "generateFinalPackage",
  description:
    "Compose the final submission package document.",
  system:
    "You are a submission-package writer. Assemble only artifacts that are present in the completed-step evidence. If completeness failed or any required material is missing, do not claim a ready package and route PACKAGE_MISSING_INFO.",
  template: (ctx) =>
    `Assemble the final package.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "_emit": "PACKAGE_GENERATED" | "PACKAGE_MISSING_INFO", "package_id": string | null, "sections": [{ "section": string, "content_ref": string }], "ready_for_submission": boolean, "missing_items": string[] }. A package_id may be returned only when ready_for_submission is true.`,
});

// ── submitToClientPortal ─────────────────────────────────────────────────────

export const prepareSubmissionData = definePrompt({
  name: "prepareSubmissionData",
  description:
    "Map the submission package into the client portal's expected payload shape.",
  system:
    "You are a client-portal integration adapter. Map our internal package fields to the client system's expected JSON/form fields. Determine API versus manual mode only from explicit integration metadata in the input; if no evidence exists, use unknown rather than guessing.",
  template: (ctx) =>
    `Prepare submission payload.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "client_system": string, "submission_mode": "api" | "manual" | "unknown", "client_api_supported": boolean | null, "mode_evidence": string | null, "payload": Record<string, unknown>, "field_mapping": Record<string, string> }.`,
});

export const handleSubmissionResult = definePrompt({
  name: "handleSubmissionResult",
  description:
    "Classify a client-portal submission result and decide next step.",
  system:
    "You are a submission-results triager. APPLICATION_SUBMITTED requires the preceding tool receipt to contain submitted:true and success:true. Manual tasks, missing receipts, ambiguous responses, and failures must route SUBMISSION_FAILED.",
  template: (ctx) =>
    `Triage submission result.\n\n${ctxBundle(ctx)}\n\nReturn JSON: { "_emit": "APPLICATION_SUBMITTED" | "SUBMISSION_FAILED", "outcome": "success" | "retry" | "human_handoff" | "delivery_manager", "application_id": string | null, "error_class": string | null, "next_step": string }.`,
});

// ── registry export ──────────────────────────────────────────────────────────

/**
 * The map keyed by `action.name` consumed by `TenantRegistry.prompts`.
 * Boot-time validation (`findMissingTenantPrompts`) walks the manifest's
 * logic actions and looks them up here.
 */
export const raasPrompts: Record<string, PromptDescriptor> = {
  // analyzeRequirement
  assessFeasibilityAndDifficulty,
  generateClarificationAndStrategy,
  // clarifyRequirement
  prepareClarificationMaterial,
  recordAndValidateResult,
  // createJD
  generateJDContent,
  handleRequisitionMapping,
  // assignRecruitTasks
  assignRecruitTasks,
  // syncFromClientSystem / inviteInternalInterview (fallbacks; see above)
  checkDeduplicatedRequisition,
  persistRequisitionData,
  generateInterviewInvitation,
  notifyRecruiter,
  // processResume
  validateCompleteness,
  validateCandidacy,
  // ruleCheckerForClientResume  (action name is Chinese)
  检查客户规则: ruleCheckerForClientResume,
  // matchResume
  validateRedlineAndBlacklist,
  matchHardRequirements,
  evaluateBonusAndCheckReflux,
  decideMatchOutcome,
  // evaluateInterview
  receiveInterviewResult,
  analyzeInterviewResult,
  evaluateWithModel,
  generateEvaluationReport,
  // refineResume
  selectTemplateAndFormat,
  generateRefinedResume,
  // generateRecommendationPackage
  checkCompleteness,
  requestMissingInfo,
  generateFinalPackage,
  // submitToClientPortal
  prepareSubmissionData,
  handleSubmissionResult,
};
