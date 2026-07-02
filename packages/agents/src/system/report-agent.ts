/**
 * ReportAgent (`reportGenerator`) — turns a subject + structured context into a
 * COMPLETE self-contained HTML analysis report, optionally printed to PDF by
 * the caller (see report.htmlToPdf / apps/api report-jobs).
 *
 * Design decisions:
 *  - Single LLM call (BaseAgent v1 contract). The caller does data gathering
 *    (e.g. ontology fetch) and deterministic chart rendering (viz.svgChart);
 *    the agent does narrative + layout + custom SVG where it adds value.
 *  - Pre-rendered charts are passed in `input.charts` and referenced by the
 *    model as `{{CHART:id}}` placeholders — the caller substitutes the real
 *    SVG afterwards. This keeps multi-KB SVG out of the completion (token
 *    cost + the model corrupting coordinates when re-quoting).
 *  - The SVG SKILLS section teaches the model the report house style: stat
 *    cards, tables, inline badges, and hand-drawn SVG only for small
 *    diagrams; data charts must use the provided placeholders.
 */

import type { ChatMessage } from "@agentic/llm-gateway";
import { BaseAgent } from "../base-agent";
import { agentRegistry } from "../registry";

export interface ReportChart {
  id: string;
  title: string;
  svg: string;
}

export interface ReportInput {
  /** What the report analyses, e.g. "招聘领域 Ontology（32 动作 / 41 事件）". */
  subject: string;
  title?: string;
  /** Optional emphasis, e.g. "重点分析事件链断点与规则覆盖". */
  focus?: string;
  /** BCP-47-ish; defaults to zh-CN. */
  language?: string;
  /** Structured context (already digested) — serialized into the prompt. */
  data?: unknown;
  /** Deterministically pre-rendered charts to embed via {{CHART:id}}. */
  charts?: ReportChart[];
}

export interface ReportOutput {
  title: string;
  /** Complete HTML document. May still contain {{CHART:id}} placeholders. */
  html: string;
}

/** Strip markdown fences / preamble and return the complete HTML document. */
export function extractHtmlDocument(text: string): string {
  let t = text.trim();
  const fence = t.match(/```(?:html)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]!.trim().length > t.length * 0.5) t = fence[1]!.trim();
  const docStart = t.search(/<!DOCTYPE\s+html/i);
  if (docStart > 0) t = t.slice(docStart);
  else if (docStart < 0) {
    const htmlStart = t.search(/<html[\s>]/i);
    if (htmlStart >= 0) t = `<!DOCTYPE html>\n${t.slice(htmlStart)}`;
  }
  return t;
}

const escAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Substitute {{CHART:id}} placeholders; unplaced charts are appended before </body>.
 *  Replacements are FUNCTIONS throughout — SVG bodies routinely contain `$&`/`$'`-style
 *  sequences (escaped labels), which a string replacement would expand as match patterns
 *  and silently corrupt the delivered document. */
export function substituteCharts(html: string, charts: ReportChart[] | undefined): string {
  if (!charts?.length) return html.replace(/\{\{CHART:[^}]+\}\}/g, "");
  let out = html;
  const unplaced: ReportChart[] = [];
  for (const c of charts) {
    const marker = new RegExp(`\\{\\{CHART:${c.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\}\\}`, "g");
    if (marker.test(out)) out = out.replace(marker, () => c.svg);
    else unplaced.push(c);
  }
  out = out.replace(/\{\{CHART:[^}]+\}\}/g, ""); // unknown ids → drop, never leak markers
  if (unplaced.length) {
    const block = unplaced
      .map((c) => `<figure style="margin:24px 0"><figcaption style="font-weight:600;margin-bottom:8px">${escAttr(c.title)}</figcaption>${c.svg}</figure>`)
      .join("\n");
    out = out.includes("</body>") ? out.replace("</body>", () => `${block}\n</body>`) : `${out}\n${block}`;
  }
  return out;
}

const SVG_SKILLS = `
## 可视化 SKILLS（必须遵守）
1. 数据图表（柱状/环形/折线/流程）一律使用提供的预渲染图表占位符：在合适的位置单独一行写 {{CHART:<id>}}。
   绝不要自己手绘数据图表的坐标轴/比例 —— 占位符会被替换成几何精确的 SVG。
2. 你可以（也应该）自己写小型示意 SVG：架构框图、关系箭头、时间线、图标点缀。控制在 30 行以内，viewBox 固定，颜色用报告的 CSS 变量。
3. 统计卡（stat cards）：用 <div class="stats"> 网格放 3-5 个大数字卡片（数值 + 标签 + 一句洞察）。
4. 表格：<table> 带斑马纹，首列左对齐，数字列右对齐；超过 12 行就只放 Top 10 + "其余 N 项"汇总行。
5. 徽章：状态/等级用内联 <span class="badge">，色彩语义：绿=健康，橙=需注意，红=风险。

## HTML 报告规范
- 输出一个完整、自包含的 HTML 文档：<!DOCTYPE html> 开头，所有 CSS 内联在 <style>，禁止外部资源（无 CDN/字体/图片链接）。
- 打印友好：A4 纵向排版良好，包含 @media print 规则（隐藏交互元素、避免跨页断裂 .card { break-inside: avoid }）。
- 视觉：浅色主题，中性配色 + 一个主题蓝 (#5b8def)；字体 system-ui；行高 1.65；正文最大宽度 880px 居中。

## 数据忠实性契约（违反任何一条 = 报告不合格）
1. 事件名、动作名、规则编号、规则名、数字**只能逐字取自数据**。数据里不存在的名词、案例、机制（配额、账号类型、系统名等）一律不得出现——宁可写"（本体未提供）"。
2. 事件分类**直接引用** analysis.eventGraph.events 里每个事件的 class / producers / consumers，不得自行改判类别（外部入口 ≠ 终态 ≠ 内部链路，混淆即错）。
3. 并发结构以 analysis.eventGraph.fanOuts 为准：一个事件有多个消费者 = 并行支线，不得叙述成串行漏斗。
4. 断链判断以 analysis.suggestedBridges（终态↔入口的命名重合候选）与每个终态的 verdictHint 为起点做业务解读；hint 只是启发，你可以给出不同判断，但必须给理由。
5. 规则章节：全量统计只用 analysis.ruleAnalysis（total / levelDistribution / clusters / perAction / unmodeledStages）；明细引用 rulesSample 时**必须注明采样范围**（见 rulesSampleNote）。若 linkageMethod 是 text-heuristic，必须注明"本体未提供规则→动作的显式关联，以下为启发式对应"，不得把关联缺失说成"动作缺规则"。

## 分析深度要求（这是报告的核心——绝不能只做"清单摘要"）
报告至少包含这些章节：
1. **执行摘要**：4-6 条最重要的结论（自动化程度、链路完整性、主要风险），每条一句话点明"所以呢"。
2. **业务流程分析**：charts 里每条 event-flow-N 链路图都要嵌入（{{CHART:event-flow-1}} 等），逐链讲清楚"事件 → 动作 → 事件"的业务含义；"∥"节点 = 并发分支，必须指出各支线随后的走向（哪条继续、哪条终止）。说明每个外部入口由谁触发、每个终态去了哪里。
3. **事件链完整性（断点分析）**：先用一张完整表格列出 analysis.eventGraph.events 中全部「终态或外部交接」与「外部入口」事件（名称/类别/生产者/消费者/判断），再重点深挖 suggestedBridges——这些是"本应衔接却断开"的最强候选（如共享命名 token 的终态→入口对），逐个判断是"真断点需补衔接动作"还是"合理的外部系统边界"，并给出修复建议。
4. **规则与合规覆盖**：基于 ruleAnalysis.clusters 讲规则在业务阶段上的分布（哪些阶段规则最密、mandatory 占比），基于 perAction + linkageMethod 讲动作侧覆盖，基于 unmodeledStages 指出"规则覆盖面 > 动作建模面"的部分（这些阶段有规则但本体没有对应动作——通常是建模缺口而非规则缺口）。引用 3-5 条代表性规则（规则名+编号来自 rulesSample）说明把关作用。
5. **数据模型分析**：objectTouch——核心数据对象是什么、在流程中如何流转；用 {{CHART:actor-donut}} 说明人工 vs 自动化的分工。
6. **自动化与工具化程度**：{{CHART:action-bar}} + gaps.agentActionsWithoutTools——哪些动作还没绑定工具（自动化缺口），结合每个动作的职责说需要什么类型的工具。
7. **风险与改进建议**：按优先级（高/中/低，用 <span class="badge"> 标色）给出可执行建议，每条必须对应上面发现的一个具体问题（引用具体事件/动作/规则名）。
8. **附录**：动作清单表（名称/执行者/触发/产出/工具）+ 事件分类清单。

每个图表旁必须有 2-4 句解读（"这说明…/这里的风险是…"）；每个章节要有真正的分析判断，不能只是把数据翻译成中文句子。宁可深入分析 5 个关键点，也不要浮光掠影地过 20 个。
`.trim();

export class ReportAgent extends BaseAgent<ReportInput, ReportOutput> {
  readonly name = "reportGenerator";
  readonly description =
    "Analysis-report author: renders a subject + structured data into a complete self-contained HTML report (charts via deterministic placeholders), printable to PDF.";

  protected override buildMessages(input: ReportInput): ChatMessage[] {
    const lang = input.language ?? "zh-CN";
    const chartList = (input.charts ?? [])
      .map((c) => `- id: ${c.id} — ${c.title}`)
      .join("\n");
    const dataBlock =
      input.data === undefined
        ? "（无结构化数据 —— 基于 subject 与常识做定性分析，明确标注这是定性判断）"
        : JSON.stringify(input.data, null, 2).slice(0, 60_000);
    return [
      {
        role: "system",
        content: `你是资深行业分析师 + 信息设计师。你产出可以直接交付客户的 HTML 分析报告（之后可能被打印成 PDF）。\n报告语言：${lang}。\n\n${SVG_SKILLS}\n\n输出要求：只输出 HTML 文档本身，不要任何解释或 markdown 代码围栏。`,
      },
      {
        role: "user",
        content: [
          `# 报告主题\n${input.title ?? ""}\n${input.subject}`,
          input.focus ? `# 分析重点\n${input.focus}` : "",
          chartList ? `# 可用的预渲染图表（用 {{CHART:id}} 占位引用，每个至少用一次）\n${chartList}` : "",
          `# 结构化数据\n\`\`\`json\n${dataBlock}\n\`\`\``,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];
  }

  protected override parseOutput(text: string): ReportOutput {
    const html = extractHtmlDocument(text);
    const m = html.match(/<title>([^<]*)<\/title>/i);
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const title = (m?.[1] ?? h1?.[1]?.replace(/<[^>]+>/g, "") ?? "分析报告").trim() || "分析报告";
    return { title, html };
  }
}

agentRegistry.register(new ReportAgent());
