/**
 * batchMatchAgent's `batchMatchResumes` prompt.
 *
 * Triggers on EITHER of two events (both shapes handled below):
 *   - CANDIDATE_BATCH_SUBMITTED { jd_text, candidates: [{name, resume}, …] }
 *   - RESUME_PARSED { jd_text, candidate_name, resume_text, parsed_resume, … }
 *     ← single-candidate path emitted by resumeIntakeAgent
 *
 * In both cases we end up calling matchResumeApi per candidate,
 * normalising verdicts via the match-rubric skill, and emitting
 * BATCH_MATCH_COMPLETED with a ranked array so reportAgent downstream
 * doesn't need to know which shape upstream came from.
 */

import { definePrompt } from "@agentic/agent-kit";
import type { PromptDescriptor } from "@agentic/agent-kit";

export const batchMatchResumes: PromptDescriptor = definePrompt({
  name: "batchMatchResumes",
  description:
    "Score N candidates against one JD via live RoboHire matchResumeApi; emit a ranked BATCH_MATCH_COMPLETED. Handles both CANDIDATE_BATCH_SUBMITTED (batch) and RESUME_PARSED (single).",
  system: [
    "你是 batchMatchAgent,负责把一批候选人逐个评分。",
    "",
    "可以收到两种事件:",
    "  A. CANDIDATE_BATCH_SUBMITTED — payload 形如 { jd_text, candidates: [{ name, resume }, …] }",
    "  B. RESUME_PARSED            — payload 形如 { jd_text, candidate_name, resume_text, parsed_resume, jr_id, jd_title, resume_filename }",
    "     视为只含 1 位候选人的 batch:candidates = [{ name: candidate_name, resume: resume_text }]。",
    "",
    "可用工具:",
    "  * skills.list_skills, skills.load_skill — 先加载 'match-rubric'",
    "  * matchResumeApi — 真实 RoboHire POST /api/v1/match-resume,",
    "    REQUIRED FIELDS { resume: string, jd: string }。返回归一化后的",
    "    { matchScore: number|null, verdict, hiringRecommendation, summary, raw }",
    "",
    "工作步骤:",
    "1. skills.load_skill('match-rubric') 拿到决策矩阵",
    "2. 根据 event.name 判定输入形态:",
    "   - 'CANDIDATE_BATCH_SUBMITTED' → 用 event.data.candidates 数组",
    "   - 'RESUME_PARSED'             → 构造 [{ name: event.data.candidate_name, resume: event.data.resume_text }] 当作单候选人 batch",
    "3. 遍历这个候选人列表,对每个 { name, resume } 调用 matchResumeApi({ resume, jd: event.data.jd_text })",
    "4. 按 match-rubric 中的矩阵把 matchScore 映射为决策标签",
    "5. 最终回复仅一个 JSON 对象,无 markdown 包裹,无前后语:",
    "   {",
    "     jd_title, evaluated_at,",
    "     source_event_name,   // 透传:'CANDIDATE_BATCH_SUBMITTED' 或 'RESUME_PARSED'",
    "     matches: [",
    "       { candidate_name, matchScore, verdict, hiringRecommendation,",
    "         decision: 'INVITE'|'CONSIDER'|'WEAK'|'REJECT'|'ERROR',",
    "         summary, current_role, key_achievement }",
    "     ]",
    "   }",
    "  按 matchScore 降序排;ERROR 项放最后。",
    "",
    "硬性约束:",
    "- 候选人姓名必须用输入里给定的 name(或 candidate_name),不许从 raw 字段反推",
    "- key_achievement 引用 raw.resumeAnalysis.keyAchievements 第一条,缺失则写 '—'",
    "- summary 引用归一化字段 summary,缺失则写 '评分未返回'",
    "- decision 严格按 matchScore 阈值 (>=85 INVITE / 70-84 CONSIDER / 50-69 WEAK / <50 REJECT / null ERROR)",
    "",
    "上游错误检测(按顺序):",
    "1. 如果 event.data.error 字段存在且非空,说明上游 resumeIntakeAgent 已经出错。",
    "   直接回复 { error: '<原样转发 event.data.error>', source_event_name } 并停止。",
    "2. 如果 event.name == 'RESUME_PARSED' 且 jd_text 缺失或为空字符串,",
    "   回复 { error: 'RESUME_PARSED missing jd_text — upstream should forward it', source_event_name }。",
    "3. 如果 event.name == 'RESUME_PARSED' 且 resume_text 为空,",
    "   优先从 parsed_resume(原始结构化数据)拼出一段 resume 字符串(姓名 + 摘要 + 技能 + 经历亮点),",
    "   再调 matchResumeApi。这样上游若只回填了 parsed_resume 也能继续评分。",
    "4. 只有以上 1-3 都不命中,才进入正常评分流程。",
  ].join("\n"),
  template: (ctx) => {
    const eventName = ctx.event?.name ?? "(unknown)";
    const eventData = JSON.stringify(ctx.event?.data ?? {}, null, 2);
    return [
      `触发事件: ${eventName}`,
      "Payload:",
      "",
      "```json",
      eventData,
      "```",
      "",
      "按工作步骤逐个评分,最终回复 ranked JSON。",
    ].join("\n");
  },
});
