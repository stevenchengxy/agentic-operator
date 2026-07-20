/**
 * reportAgent's `buildReport` prompt.
 *
 * Receives BATCH_MATCH_COMPLETED with the ranked matches array, builds
 * a complete HTML document per the report-template skill, and persists
 * it via writeReportToDisk. Emits REPORT_GENERATED with the path so the
 * operator can open it.
 */

import { definePrompt } from "@agentic/agent-kit";
import type { PromptDescriptor } from "@agentic/agent-kit";

export const buildReport: PromptDescriptor = definePrompt({
  name: "buildReport",
  description:
    "Assemble a complete HTML hiring-funnel report from BATCH_MATCH_COMPLETED, persist via writeReportToDisk.",
  system: [
    "你是 reportAgent,生成可读性强的 HTML 招聘漏斗报告。",
    "",
    "可用工具:",
    "  * skills.list_skills, skills.load_skill — 必须先加载 'report-template'",
    "  * writeReportToDisk — 持久化 HTML 到磁盘",
    "",
    "工作步骤:",
    "1. skills.load_skill('report-template') 拿到模板和约束",
    "2. 严格按模板组装一个 *完整* HTML 文档 (含 <!DOCTYPE html>、<head>、<style>、<body>)",
    "3. 候选人按 matchScore 降序排,每名一行,样式 badge 与 rubric 颜色一致",
    "4. 调用 writeReportToDisk({ html, report_title }) 保存",
    "5. 最终回复仅一个 JSON 对象: { reportId, reportPath, report_title, candidates_count, top_candidate }",
    "",
    "硬性约束:",
    "- HTML 必须 *自包含* (CSS inline 在 <style>,不引外部 CDN)",
    "- 不允许编造任何候选人姓名 / 分数 / 理由 — 全部来自输入 payload",
    "- 没有 INVITE 候选人时,'推荐行动' section 写 '无强匹配候选人,建议调整 JD 或扩大渠道'",
  ].join("\n"),
  template: (ctx) => {
    const eventData = JSON.stringify(ctx.event?.data ?? {}, null, 2);
    return [
      "BATCH_MATCH_COMPLETED 事件 payload 如下:",
      "",
      "```json",
      eventData,
      "```",
      "",
      "按工作步骤组装 HTML、保存,然后回复最终 JSON。",
    ].join("\n");
  },
});
