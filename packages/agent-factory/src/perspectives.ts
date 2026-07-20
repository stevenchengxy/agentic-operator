/**
 * #PERSPECTIVES — 利益相关者视角库（stakeholder lenses）：understand_ontology 深读的第二梯队。
 *
 * 结构四维专家（objects/rules/actions/events）回答「数据是什么」；本模块的视角回答「数据服务谁」——
 * 客户触点/SLA、运营接管、对账审计、合规敞口、外部协作契约。二者正交：视角是跨维读者，拿全域
 * 压缩速览 + 四维已有要点做补充检视，不重复结构专家的逐条覆盖工作。
 *
 * 选配是混合制：库限定 id（确定性、可回归），AI 按域挑 2-4 个并把 focus 改写成贴合本域的检视
 * 要点（领域贴合）。任何失败回退默认三视角，永不阻塞深读。
 *
 * 设计铁律（system-prompt ②c，EMNLP24-backed）：视角=「查什么」的结构焦点 + 独立上下文切片，
 * 绝不是「你是资深XX专家」式人格扮演——sanitize 层用人设守卫强制执行。
 */

import { chatOnce } from "./stream-gateway";
import { modelChain } from "./model-router";
import { extractJson, ruleEnforcementTag, type SpecialistLlm, type SpecialistResult, type SpecialistTask } from "./specialists";
import type { DomainOntology } from "./ontology-types";

export interface StakeholderLens {
  /** 库内稳定 id（选配 LLM 只能引用这些）。 */
  id: string;
  /** 短中文角色标签——成为「认知专家 · {label}」卡片标题。 */
  label: string;
  /** 结构焦点模板：这一视角【查什么】。选配 LLM 可按域改写，人设口吻会被 sanitize 打回。 */
  focus: string;
  /** 适用性提示，供选配 LLM 判断该域要不要这个视角。 */
  appliesWhen: string;
}

export interface SelectedLens {
  id: string;
  label: string;
  focus: string;
  /** true = focus 是 AI 按域改写并通过守卫的；false = 库原文。 */
  adapted: boolean;
}

export interface LensSelection {
  lenses: SelectedLens[];
  source: "llm" | "fallback";
}

export const DEFAULT_LENS_IDS = ["business_customer", "operation", "backoffice"] as const;

export const STAKEHOLDER_LENSES: StakeholderLens[] = [
  {
    id: "business_customer",
    label: "客户价值视角",
    focus:
      "端到端客户体验——哪些动作/事件是客户可感知的触点；触点之间客户在等什么（时延与 SLA 预期，本体有没有超时/催办机制）；哪些失败路径会把坏体验静默漏给客户（无告知 vs 有告知）；链路最终产出对客户的价值是否成立，有没有客户视角下有头无尾的流程",
    appliesWhen: "域里存在外部客户/候选人/用户可感知的触点或交付（消息、通知、结果送达）时",
  },
  // ONLY-IT-CATCHES：events 专家查链路闭合、actions 专家查职责边界——都不问
  // 「链上哪个点客户看得见、客户等多久、失败时客户被告知了吗」。
  {
    id: "operation",
    label: "运营视角",
    focus:
      "上线后由谁盯、怎么盯——哪些环节缺可观测信号（无事件/无状态可监控）；异常路径与人工接管点：卡住时长什么样、谁来解卡、人工交接负荷集中在哪个动作；吞吐与积压：扇出/批量/外部依赖环节有没有背压与重试考虑",
    appliesWhen: "流程含长链路、批处理、外部依赖或人工节点，需要日常运维时",
  },
  // ONLY-IT-CATCHES：events 专家管链是否闭合，不管「链路运行时的可观测性与人工接管成本」。
  {
    id: "backoffice",
    label: "后台对账视角",
    focus:
      "事后可对账、可追溯、可问责——哪些动作改了核心对象却没有留下可追溯事件（审计断档）；跨系统流水能否对上账（凭据由谁产生、对账键是哪个字段）；权限与职责分离：哪些动作的 actor 组合存在既当运动员又当裁判的问题",
    appliesWhen: "域内有资金、单据、状态流转需要事后追溯或多方核对时",
  },
  // ONLY-IT-CATCHES：rules 专家分析本体已声明的规则体系；它不问「出了事能不能凭数据还原现场、账能不能对平」。
  {
    id: "compliance_risk",
    label: "合规风险视角",
    focus:
      "对外监管暴露与最坏情况——事件载荷/对象字段里的敏感信息（个人身份/联系方式/凭证）流经哪些环节、是否必要；不可逆的对外副作用动作（已发出的消息/已写入外部系统）有没有补偿事件；最坏情况爆炸半径：哪个单点出错会造成对外不可撤回的影响",
    appliesWhen: "域内处理个人信息/对外发送/写外部系统，或行业有强监管时",
  },
  // ONLY-IT-CATCHES：rules 专家只看本体【已声明】的规则；本视角专找本体【没写但外部世界要求】的义务敞口。
  {
    id: "partner_integration",
    label: "外部协作方视角",
    focus:
      "站在外部平台/协作方一侧回看——每个外部交接终态事件，对方消费时需要什么契约（字段/时序/幂等键），本体是否给全；对方回传/回调在本体里有没有承接入口；上游外部依赖不可用时链路的退化行为是什么",
    appliesWhen: "存在外部交接终态、外部工具写入或跨平台协作时",
  },
  // ONLY-IT-CATCHES：actions 专家从内部方向查工具缺口；本视角从【对方消费我们产出】的反方向查契约闭合。
];

/** kill-switch：FACTORY_PERSPECTIVES=0|false|off 关闭整个视角系统（含保真门收紧），默认开。 */
export function perspectivesEnabled(): boolean {
  const raw = process.env.FACTORY_PERSPECTIVES?.trim().toLowerCase();
  return !(raw === "0" || raw === "false" || raw === "off");
}

/** 人设守卫——改写后的 focus 不得写成人格扮演；命中即弃用改写、回落库原文。 */
const PERSONA_GUARD = /你是|资深|扮演|多年经验|世界级|顶级/;

function libraryLens(id: string): StakeholderLens | undefined {
  return STAKEHOLDER_LENSES.find((l) => l.id === id);
}

function fallbackSelection(): LensSelection {
  return {
    source: "fallback",
    lenses: DEFAULT_LENS_IDS.map((id) => {
      const lens = libraryLens(id)!;
      return { id: lens.id, label: lens.label, focus: lens.focus, adapted: false };
    }),
  };
}

/**
 * 纯函数钳制选配 LLM 的输出：只认库内 id、去重、≤4；改写 focus 须 20-400 字且过人设守卫，
 * 否则回落库原文（adapted:false）。可用条目 <2 → null（调用方回退默认三视角）。
 */
export function sanitizeLensSelection(raw: unknown): SelectedLens[] | null {
  const parsed = typeof raw === "string" ? extractJson(raw) : raw;
  if (!parsed || typeof parsed !== "object") return null;
  const selected = (parsed as Record<string, unknown>).selected;
  if (!Array.isArray(selected)) return null;
  const out: SelectedLens[] = [];
  const seen = new Set<string>();
  for (const entry of selected) {
    if (out.length >= 4) break;
    if (!entry || typeof entry !== "object") continue;
    const id = String((entry as Record<string, unknown>).id ?? "");
    const lens = libraryLens(id);
    if (!lens || seen.has(id)) continue;
    seen.add(id);
    const rewritten = String((entry as Record<string, unknown>).focus ?? "").trim();
    const usable = rewritten.length >= 20 && rewritten.length <= 400 && !PERSONA_GUARD.test(rewritten);
    out.push({ id: lens.id, label: lens.label, focus: usable ? rewritten : lens.focus, adapted: usable });
  }
  return out.length >= 2 ? out : null;
}

const globalCensus = (ont: DomainOntology): string =>
  `全域概况：${ont.actions.length} 动作 · ${ont.events.length} 事件 · ${ont.rules.length} 规则 · ${ont.objects.length} 数据对象`;

/** 只喂 ok 的维度结论（role + keyFindings + risks），失败维度不进载荷。 */
function dimDigest(dimResults: SpecialistResult[], cap: number): string {
  const rows = dimResults
    .filter((r) => r.ok && r.output && typeof r.output === "object")
    .map((r) => {
      const o = r.output as Record<string, unknown>;
      return JSON.stringify({ role: r.role, keyFindings: o.keyFindings ?? [], risks: o.risks ?? [] });
    });
  const joined = rows.join("\n");
  return joined.length > cap ? `${joined.slice(0, cap)}\n…（截断）` : joined;
}

const SELECT_SYSTEM =
  "你是本体深读的「视角调度员」。结构四维（对象/规则/动作/事件）专家已完成分析。从【视角库】中为这个域挑选 2-4 个最有价值的业务视角，并把每个选中视角的 focus 改写成【贴合本域】的检视要点——保留结构化的『查什么』，禁止写成人设口吻。\n" +
  '只输出 JSON：{"selected":[{"id":"库中的 id","focus":"改写后的检视要点（≤200 字）","why":"一句话为什么该域需要"}]}。\n' +
  "选择依据：域的业务性质、四维专家已发现的风险与歧义、各视角的 appliesWhen。对本域无意义的视角不要选；至少 2 个，最多 4 个。";

/**
 * 选配：一次 fast 档 LLM 调用按域挑视角并改写焦点。四维结果是最好的廉价选择信号（已在手）。
 * 永不 throw——任何失败（网关/解析/钳制不足）回退默认三视角。
 */
export async function selectLenses(
  ont: DomainOntology,
  dimResults: SpecialistResult[],
  opts?: { llm?: SpecialistLlm },
): Promise<LensSelection> {
  const llm: SpecialistLlm =
    opts?.llm ?? ((s, u, o) => chatOnce(s, u, { maxTokens: o?.maxTokens ?? 700, purpose: o?.purpose, models: modelChain("fast") }));
  try {
    const user = [
      globalCensus(ont),
      `【视角库】\n${JSON.stringify(STAKEHOLDER_LENSES, null, 1)}`,
      `【四维专家已有要点】\n${dimDigest(dimResults, 4_000) || "（无）"}`,
    ].join("\n\n");
    const text = await llm(SELECT_SYSTEM, user, { maxTokens: 700, purpose: "perspective:select" });
    const lenses = sanitizeLensSelection(text);
    if (!lenses) return fallbackSelection();
    return { lenses, source: "llm" };
  } catch {
    return fallbackSelection();
  }
}

const LENS_SYSTEM = (label: string, focus: string) =>
  `你是本体分析的「${label}」。结构维度（对象/规则/动作/事件）已各有专家逐条分析完毕；你不重复他们的工作，只从这一个业务视角检视全局：${focus}\n` +
  `只输出 JSON：{"keyFindings":[…每条一句，具体到动作/事件/对象名…],"risks":[…],"ambiguities":[…本视角发现的、需要用户澄清的缺口…],"crossDimensionNotes":[…本视角对结构维度结论的关键补充…]}。\n` +
  `所有名字必须逐字来自数据；数据里没有的不要编造——本体【缺失】本视角必需的东西（如无监控事件、无审计动作、无补偿事件）本身就是发现，写进 keyFindings 或 risks。发现要有判断力（「所以呢」），不要复读清单。`;

const capText = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n…（截断，共 ${s.length} 字符）` : s);

/**
 * 构建镜头任务：所有镜头共享同一份素材（构建一次）——全域压缩速览 + 四维已有要点。
 * 刻意不带 coverage/batches/census：逐条覆盖声明是结构专家的契约，镜头不做（诚实渲染无覆盖横幅）。
 */
export function buildLensTasks(
  ont: DomainOntology,
  lenses: SelectedLens[],
  dimResults: SpecialistResult[],
): SpecialistTask[] {
  const actionsLite = ont.actions.map((a) => ({
    name: a.name,
    actor: a.actor,
    trigger: a.trigger,
    triggered_event: a.triggered_event,
    tool_use: a.tool_use,
    description: (a.description ?? "").slice(0, 160),
  }));
  const eventRoster = (ont.events as Array<Record<string, unknown>>)
    .map((e) => {
      const src = (e.payload as Record<string, unknown> | undefined)?.source_action;
      return `${String(e.name ?? e.id ?? "")}${src ? `←${String(src)}` : ""}`;
    })
    .join("、");
  const ruleRoster = (ont.rules as Array<Record<string, unknown>>)
    .map((r) => `${String(r.name ?? r.id ?? "")}${ruleEnforcementTag(r)}`)
    .join("、");
  const material = [
    globalCensus(ont),
    `【动作总览】\n${capText(JSON.stringify(actionsLite, null, 1), 10_000)}`,
    `【事件总览】\n${capText(eventRoster || "—", 3_000)}`,
    `【对象总览】\n${capText(ont.objects.map((o) => o.name).join("、") || "—", 1_500)}`,
    `【规则总览】\n${capText(ruleRoster || "—", 8_000)}`,
    `【结构四维已有要点（供补充，不要复述）】\n${dimDigest(dimResults, 4_000) || "（无）"}`,
  ].join("\n\n");
  return lenses.map((lens) => ({
    id: `lens.${lens.id}`,
    role: lens.label,
    system: LENS_SYSTEM(lens.label, lens.focus),
    user: material,
    maxTokens: 1400,
  }));
}
