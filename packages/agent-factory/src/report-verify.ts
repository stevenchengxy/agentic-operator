// #REPORT-VERIFY — 报告接地审校器（"自己检查、纠错、知道去哪找错"应用在报告上）。
//
// 问题：报告管线的事实层已经确定性化（图表/结构分析/分层采样都由代码算），但 LLM 写的
// 叙事 HTML 无人复核——它仍可能引用不存在的事件/动作名、写错四类核心计数。这正是
// "Ontology 分析报告不正确"的残余失真面。
//
// 方案（精确优先，宁漏勿误伤）：两类高置信检查——
//   1. unknown_reference：正文里长得像事件/常量的 UPPER_SNAKE token，必须在【模型看到的
//      digest ∪ 本体全量】里出现过；否则就是编造的引用（模型不可能"恰好猜对"一个真名）。
//   2. count_mismatch：动作/事件/规则/数据对象的计数声明，必须命中该实体的合法数集
//      （全量数 + 常见口径如 Agent 动作数、事件图去重数）；其它数字一律不管（避免误伤）。
// 违规 → 一次【定向修正重写】→ 复检；仍有残留 → 在报告里插入可见的"审校警示"块（诚实
// 披露，绝不静默交付错误内容）。纯函数、零 LLM、可单测。

import type { DomainOntology } from "./ontology-types";

export type ReportViolation =
  | { kind: "unknown_reference"; token: string; note: string }
  | { kind: "count_mismatch"; entity: string; claimed: number; allowed: number[]; excerpt: string };

/** 剥掉 style/script 与标签，取报告的可见正文（检查只对读者看得见的内容负责）。 */
export function visibleText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ");
}

/** 事件/常量样式的 token：UPPER_SNAKE 且至少一个下划线（RESUME_PROCESSED / MATCH_RULE_CHECK_PASSED）。 */
const EVENTISH = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;

/** 计数声明：只查 `N 个/条 实体` 正向短语（量词必选）。反向模式（"规则…N 个"）在连续列举
 *  （"300 条规则与 5 个动作"）里会把下一实体的数字抓给上一实体——按"宁漏勿误伤"原则不用。 */
const COUNT_FWD = /(\d{1,5})\s*[个条项]\s*(Agent\s*动作|动作|事件|规则|数据对象|对象)/g;

function entityKey(raw: string): "动作" | "事件" | "规则" | "对象" {
  if (/Agent\s*动作|动作/.test(raw)) return "动作";
  if (raw === "事件") return "事件";
  if (raw === "规则") return "规则";
  return "对象";
}

/** 每类实体的【合法数集】——全量数 + 报告里常见的合法口径。 */
export function allowedCounts(ont: DomainOntology): Record<"动作" | "事件" | "规则" | "对象", Set<number>> {
  const agentActions = ont.actions.filter((a) => (a.actor ?? []).includes("Agent")).length;
  const humanActions = ont.actions.length - agentActions;
  const graphEvents = new Set<string>([
    ...ont.actions.flatMap((a) => a.trigger ?? []),
    ...ont.actions.flatMap((a) => a.triggered_event ?? []),
  ]).size;
  return {
    动作: new Set([ont.actions.length, agentActions, humanActions]),
    事件: new Set([ont.events.length, graphEvents]),
    规则: new Set([ont.rules.length]),
    对象: new Set([ont.objects.length]),
  };
}

const MAX_VIOLATIONS = 12;

export function verifyReportGrounding(
  html: string,
  ont: DomainOntology,
  digest?: unknown,
): { ok: boolean; violations: ReportViolation[] } {
  const text = visibleText(html);
  const violations: ReportViolation[] = [];

  // ① 引用接地：token 必须出现在【digest ∪ 本体全量序列化】里（模型只可能合法转述它见过的名字）。
  const corpus = `${JSON.stringify(digest ?? "")}\n${JSON.stringify({
    ev: ont.events.map((e) => e.name),
    tr: ont.actions.flatMap((a) => [...(a.trigger ?? []), ...(a.triggered_event ?? [])]),
    ac: ont.actions.map((a) => a.name),
    tools: ont.actions.flatMap((a) => a.tool_use ?? []),
    obj: ont.objects.map((o) => `${o.id} ${o.name ?? ""}`),
  })}`;
  const seenTokens = new Set<string>();
  for (const m of text.matchAll(EVENTISH)) {
    const token = m[0]!;
    if (seenTokens.has(token)) continue;
    seenTokens.add(token);
    if (!corpus.includes(token)) {
      violations.push({ kind: "unknown_reference", token, note: "正文引用了本体与数据摘要中都不存在的名字（疑似编造）" });
      if (violations.length >= MAX_VIOLATIONS) return { ok: false, violations };
    }
  }

  // ② 计数接地：四类核心实体的数字声明必须命中合法数集。
  const allowed = allowedCounts(ont);
  const flagged = new Set<string>();
  const checkCount = (numRaw: string, entityRaw: string, excerpt: string) => {
    const n = Number(numRaw);
    if (!Number.isFinite(n)) return;
    const key = entityKey(entityRaw);
    if (allowed[key].has(n)) return;
    const sig = `${key}:${n}`;
    if (flagged.has(sig)) return;
    flagged.add(sig);
    violations.push({ kind: "count_mismatch", entity: key, claimed: n, allowed: [...allowed[key]], excerpt: excerpt.trim().slice(0, 80) });
  };
  for (const m of text.matchAll(COUNT_FWD)) checkCount(m[1]!, m[2]!, m[0]!);

  return { ok: violations.length === 0, violations: violations.slice(0, MAX_VIOLATIONS) };
}

/** #DEGEN — 退化正文检测：接地审校只回答"引用可否核到"，回答不了"这到底是不是一份报告"。
 *  实锤事故：主 LLM 网关为 mock（demo/沙箱模式）时，reportGenerator 的"正文"是
 *  "Mock response from mock-model-v1: received …" 的回声——审校器因为里面没有任何可核引用
 *  而给它盖了 ✓。现在先做结构性 sanity：mock 回声 / 过短 / 无实质结构 → 拒绝当报告交付。 */
export function looksDegenerate(html: string): { degenerate: boolean; reason?: string } {
  const text = visibleText(html ?? "").trim();
  if (/mock response from|mock-model/i.test(text.slice(0, 500))) {
    return { degenerate: true, reason: "正文是 mock 提供商的回声（LLM 网关当前为 mock，不是模型撰写的分析）" };
  }
  if (text.length < 500) {
    return { degenerate: true, reason: `正文过短（${text.length} 字符）——不构成完整报告` };
  }
  return { degenerate: false };
}

/** 给修正重写用的指令（附违规清单——告诉模型错在哪、去哪核对）。 */
export function correctionInstruction(violations: ReportViolation[]): string {
  const lines = violations.map((v, i) =>
    v.kind === "unknown_reference"
      ? `${i + 1}. 正文引用了不存在的名字「${v.token}」——删除或替换为 data 里真实存在的名字`
      : `${i + 1}. 「${v.excerpt}」计数不对：${v.entity}的合法数是 ${v.allowed.join(" 或 ")}，正文写了 ${v.claimed}——按 data.counts / data.analysis 修正`,
  );
  return `【审校修正·必须执行】上一稿存在 ${violations.length} 处接地错误（引用/数字与源数据不符）。逐条修正后重新输出【完整】HTML：\n${lines.join("\n")}\n硬规则：所有事件/动作/工具/对象名只能来自 data；所有计数只能来自 data.counts 与 data.analysis 的统计，不得自行推算或概数化。`;
}

/** 残留违规的可见警示块（诚实披露，插入报告正文末尾、方法附注之前）。 */
export function residualWarningHtml(violations: ReportViolation[]): string {
  const items = violations
    .map((v) =>
      v.kind === "unknown_reference"
        ? `<li>正文引用「${v.token}」在本体与数据摘要中不存在（疑似模型编造，请勿采信该处表述）</li>`
        : `<li>计数「${v.excerpt}」与源数据不符（${v.entity}合法数：${v.allowed.join(" / ")}，正文写 ${v.claimed}）</li>`,
    )
    .join("");
  return `<section style="max-width:880px;margin:24px auto 8px;padding:14px 18px;border:1.5px solid #d9822b;border-radius:10px;background:#fff8f0;font-size:13px;color:#7a4a10;line-height:1.7"><b>⚠ 审校警示（系统自动核对）</b>：以下 ${violations.length} 处内容经一次自动修正后仍与源数据不符，已标出请勿采信：<ul style="margin:6px 0 0;padding-left:20px">${items}</ul></section>`;
}
