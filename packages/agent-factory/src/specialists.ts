/**
 * Specialists — the LIGHT nesting channel of the factory's shared reasoning core.
 *
 * Two nesting channels exist (see docs/ao-architecture-layers.html §4.5):
 *   · HEAVY  — spawn_subagent: a full recursive runBrain with its own message history
 *     and read-only tools, for tasks that must fetch data / reason over turns.
 *   · LIGHT  — this module: role-prompted, single-shot structured calls run IN PARALLEL,
 *     for cognitive decomposition when the data is already in hand (e.g. digesting a big
 *     ontology by dimension: objects / rules / actions / events; parsing user intent).
 *
 * Both channels share the SAME reasoning infrastructure (stream-gateway model routing,
 * fallback chain, llm_calls telemetry) — "共用一个推理大脑": what specializes is the ROLE
 * and its context window, never a second model stack. Every specialist surfaces as a
 * subagent.start/done pair, so the chat transcript, the 大脑 tab and the 后台任务 panel
 * all show the fan-out for free.
 *
 * Testability: every entry point accepts an injectable `llm` (defaults to chatOnce), so
 * unit tests drive the orchestration with a fake — no provider calls.
 */

import { chatOnce } from "./stream-gateway";
import type { BrainCtx } from "./brain-types";
import type { DomainOntology } from "./ontology-types";

export type SpecialistLlm = (system: string, user: string, opts?: { maxTokens?: number; purpose?: string }) => Promise<string>;

export interface SpecialistTask {
  id: string;
  /** Short role name, e.g. "rules 专家" — becomes the subagent card title. */
  role: string;
  system: string;
  user: string;
  maxTokens?: number;
}

export interface SpecialistResult {
  id: string;
  role: string;
  ok: boolean;
  /** Parsed JSON when the reply carries one, else the raw text. */
  output: unknown;
  summary: string;
}

/** Tolerant JSON extraction — specialists are asked for JSON but models add fences/prose. */
export function extractJson(text: string): unknown {
  const t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = (fence ? fence[1]! : t).trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  // walk to the matching close so trailing prose doesn't break the parse
  const open = candidate[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(candidate.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Run role-prompted specialists IN PARALLEL. Single failures degrade to ok:false — the
 *  caller decides whether partial understanding is usable (it usually is). */
export async function runSpecialists(
  ctx: Pick<BrainCtx, "emit">,
  tasks: SpecialistTask[],
  opts?: { llm?: SpecialistLlm },
): Promise<SpecialistResult[]> {
  const llm: SpecialistLlm = opts?.llm ?? ((s, u, o) => chatOnce(s, u, { maxTokens: o?.maxTokens ?? 1600, purpose: o?.purpose }));
  return Promise.all(
    tasks.map(async (t): Promise<SpecialistResult> => {
      ctx.emit({ t: "subagent.start", task: `认知专家 · ${t.role}` });
      try {
        const text = await llm(t.system, t.user, { maxTokens: t.maxTokens ?? 1600, purpose: `specialist:${t.id}` });
        const parsed = extractJson(text);
        const output = parsed ?? text.trim();
        const summary = summarizeOutput(t.role, parsed, text);
        ctx.emit({ t: "subagent.done", task: `认知专家 · ${t.role}`, summary });
        return { id: t.id, role: t.role, ok: true, output, summary };
      } catch (e) {
        const summary = `${t.role} 分析失败：${(e as Error).message}`;
        ctx.emit({ t: "subagent.done", task: `认知专家 · ${t.role}`, summary });
        return { id: t.id, role: t.role, ok: false, output: null, summary };
      }
    }),
  );
}

function summarizeOutput(role: string, parsed: unknown, raw: string): string {
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    const findings = Array.isArray(o.keyFindings) ? o.keyFindings.length : 0;
    const risks = Array.isArray(o.risks) ? o.risks.length : 0;
    const amb = Array.isArray(o.ambiguities) ? o.ambiguities.length : 0;
    if (findings || risks || amb) return `${role}：${findings} 项发现 · ${risks} 项风险 · ${amb} 处歧义`;
  }
  return `${role}：${raw.trim().slice(0, 90)}`;
}

// ── ontology deep understanding（四维分治）─────────────────────────────────────────

const DIM_SYSTEM = (role: string, focus: string) =>
  `你是本体分析的「${role}」。只深入分析交给你的这一个维度：${focus}。\n` +
  `只输出 JSON：{"keyFindings":[…每条一句，具体到名字…],"risks":[…],"ambiguities":[…],"crossDimensionNotes":[…这一维度对其它维度（动作/事件/规则/对象）的关键牵连…]}。\n` +
  `所有名字必须逐字来自数据；不确定写进 ambiguities，绝不编造。发现要有判断力（"所以呢"），不要复读清单。`;

const capJson = (v: unknown, n: number): string => {
  const s = JSON.stringify(v, null, 1);
  return s.length > n ? `${s.slice(0, n)}\n…（截断，共 ${s.length} 字符）` : s;
};

/** Build the four dimension-specialist tasks. Each gets its OWN dimension in full plus a
 *  one-line census of the others — a clean, focused context window per dimension. */
export function buildOntologySpecialistTasks(ont: DomainOntology): SpecialistTask[] {
  const census = `全域概况：${ont.actions.length} 动作 · ${ont.events.length} 事件 · ${ont.rules.length} 规则 · ${ont.objects.length} 数据对象（你只负责自己的维度，其它维度另有专家）`;
  const actionsLite = ont.actions.map((a) => ({ name: a.name, actor: a.actor, trigger: a.trigger, triggered_event: a.triggered_event, tool_use: a.tool_use, description: (a.description ?? "").slice(0, 160) }));
  return [
    {
      id: "objects",
      role: "objects 专家",
      system: DIM_SYSTEM("数据对象专家", "领域数据模型——对象、属性、对象间关系、哪些对象是流程核心"),
      user: `${census}\n\n【你的维度：dataObjects 全量】\n${capJson(ont.objects, 26_000)}\n\n【参照：动作如何触碰对象】\n${capJson(actionsLite.map((a) => ({ name: a.name, targets: ont.actions.find((x) => x.name === a.name)?.target_objects ?? [] })), 6_000)}`,
    },
    {
      id: "rules",
      role: "rules 专家",
      system: DIM_SYSTEM("业务规则专家", "规则体系——强制级别分布、按业务阶段的聚类、关键把关逻辑、规则间冲突或缺口"),
      user: `${census}\n\n【你的维度：rules 全量】\n${capJson(ont.rules, 60_000)}\n\n【参照：动作清单】\n${capJson(actionsLite.map((a) => a.name), 2_000)}`,
      maxTokens: 2000,
    },
    {
      id: "actions",
      role: "actions 专家",
      system: DIM_SYSTEM("动作专家", "每个动作的职责边界、触发与产出、工具缺口、哪些动作是规则闸口"),
      user: `${census}\n\n【你的维度：actions 全量】\n${capJson(ont.actions, 40_000)}`,
    },
    {
      id: "events",
      role: "events 专家",
      system: DIM_SYSTEM("事件链专家", "事件流转——入口/终态/断链、并发扇出、事件载荷契约是否闭合"),
      user: `${census}\n\n【你的维度：events 全量】\n${capJson(ont.events, 30_000)}\n\n【参照：动作的触发/产出关系】\n${capJson(actionsLite.map((a) => ({ name: a.name, trigger: a.trigger, emit: a.triggered_event })), 8_000)}`,
    },
  ];
}

/** Reduce the four specialists' outputs into ONE coherent understanding (the fold-surviving
 *  ctx.ontologyUnderstanding). Uses one synthesis call; degrades to a deterministic stitch. */
export async function synthesizeUnderstanding(
  results: SpecialistResult[],
  ont: DomainOntology,
  opts?: { llm?: SpecialistLlm },
): Promise<string> {
  const llm: SpecialistLlm = opts?.llm ?? ((s, u, o) => chatOnce(s, u, { maxTokens: o?.maxTokens ?? 1400, purpose: o?.purpose }));
  const good = results.filter((r) => r.ok);
  const material = good.map((r) => `## ${r.role}\n${typeof r.output === "string" ? r.output : JSON.stringify(r.output)}`).join("\n\n");
  const fallback = () =>
    `【四维分治理解（确定性拼接）】\n${good.map((r) => `· ${r.summary}`).join("\n")}\n（合成调用失败——以上为各专家原始结论的拼接）`;
  if (!good.length) return "";
  try {
    const text = await llm(
      "你是本体理解的合成者。四位维度专家已各自深入分析，你把它们合成为一份连贯的整体理解，供后续设计智能体时持续参考。输出纯文本（非 JSON），必须覆盖：要造哪些 agent、主事件链与断链、规则闸口与合规要点、核心数据对象、待澄清歧义清单。名字逐字来自专家材料，不编造。600 字以内，信息密度优先。",
      `域：${ont.domainId}（${ont.actions.length} 动作 / ${ont.events.length} 事件 / ${ont.rules.length} 规则 / ${ont.objects.length} 对象）\n\n${material.slice(0, 24_000)}`,
      { maxTokens: 1400, purpose: "specialist:synthesize" },
    );
    return text.trim() || fallback();
  } catch {
    return fallback();
  }
}

// ── user intent（意图门）───────────────────────────────────────────────────────────

/** Parse the user's goal into a structured intent line, APPENDED to any prior intent so a
 *  conversation's intent history accumulates (fold-surviving via ctx.userIntent). Fail-safe:
 *  returns prior intent + raw goal on any LLM failure — the gate must never block a run. */
export async function parseUserIntent(
  goal: string,
  priorIntent: string | undefined,
  opts?: { llm?: SpecialistLlm },
): Promise<string> {
  const llm: SpecialistLlm = opts?.llm ?? ((s, u, o) => chatOnce(s, u, { maxTokens: o?.maxTokens ?? 400, purpose: o?.purpose }));
  const raw = goal.trim();
  const appendRaw = () => (priorIntent ? `${priorIntent}\n+ 追加：${raw.slice(0, 200)}` : `目标原文：${raw.slice(0, 240)}`);
  if (!raw) return priorIntent ?? "";
  try {
    const text = await llm(
      `把用户这句话解析成一行意图记录，格式固定：\n[类型] 一句话目标 ｜ 约束: …；… ｜ 期望产物: …\n类型从 生成/分析/修改/提问/报告/其它 中选一个。约束与期望产物没有就写 无。只输出这一行，不解释。`,
      priorIntent ? `（此前意图：${priorIntent.slice(-400)}）\n用户新输入：${raw.slice(0, 1200)}` : `用户输入：${raw.slice(0, 1200)}`,
      { maxTokens: 400, purpose: "specialist:intent" },
    );
    const line = text.trim().split("\n")[0]?.trim();
    if (!line || line.length < 4) return appendRaw();
    return priorIntent ? `${priorIntent}\n+ ${line}` : line;
  } catch {
    return appendRaw();
  }
}
