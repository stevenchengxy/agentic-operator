// Autonomous Harness Brain — the streaming ReAct loop.
//
// Re-implemented for the new arch from the OLD lib/agent-factory-v3/brain/conductor.ts:
// it reasons (streaming think deltas), calls tools, observes, loops — until it finishes
// (passing the acceptance gate) or exhausts its budget. All infrastructure is injected
// via ctx.ports, so the same loop runs in any runtime. Token cost is uncapped (the user
// vetoed hard caps); MAX_TURNS is the only runaway backstop + a soft cost meter nudges.

import { streamTurn, chatOnce, isGatewayConfigured, setLlmCallContext, type ChatMsg, type ToolSchema } from "./stream-gateway";
import { systemPrompt } from "./system-prompt";
import { FACTORY_TOOLS, SUBAGENT_TOOLS, normalizeQuestion } from "./tools";
import type { BrainEvent, BrainTool, BrainCtx, ReflectionLite, BoundaryEvent, FactoryStage } from "./brain-types";
import type { FactoryPorts } from "./ports";
import { isStopIntent } from "./intent";
import { parseUserIntent } from "./specialists";
import { modelChain, tierForContext } from "./model-router";
import { classifyIntentKind, estimateDifficulty, selectPolicy } from "./reasoning-policy";
import { anchorDue, buildOntologyAnchor, DEFAULT_ANCHOR_EVERY } from "./ontology-anchor";
import { roleOfTool } from "./process-roles";
import { adjustPolicyWithStats, recordOutcome } from "./policy-learning";
import { warmModelCatalog } from "./model-catalog";
import { resolveBrainLang } from "./i18n";

// ── auto-compaction ───────────────────────────────────────────────────────────
// Keep the context bounded on long runs WITHOUT turn-capping: once the transcript
// grows large, fold everything except the last few turns into a structured state
// summary re-derived from ctx (nothing the brain needs is lost — specs/plan/sandbox
// all live in ctx). No extra LLM call.
// #9c: tuning is env-overridable (different domains/budgets want different limits) — not baked in.
const envInt = (k: string, d: number): number => {
  const n = Number(process.env[k]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
};
const COMPACT_AT_MSGS = envInt("FACTORY_COMPACT_AT_MSGS", 40);
// Clamp so KEEP_RECENT is ALWAYS strictly less than COMPACT_AT_MSGS — otherwise `recent` could
// swallow the system prompt and the fold would GROW the array each turn (runaway context).
const KEEP_RECENT = Math.min(envInt("FACTORY_KEEP_RECENT", 12), COMPACT_AT_MSGS - 1);

function buildStateSummary(ctx: BrainCtx): string {
  const lines: string[] = [`【已折叠早期对话，这是结构化状态快照】`, `域: ${ctx.domain} · 目标: ${ctx.goal}`];
  if (ctx.ontology) {
    lines.push(`本体: ${ctx.ontology.actions.length} 动作 / ${ctx.ontology.events.length} 事件 / 工具库 ${ctx.toolCatalog.length}`);
    // #3 FIX (memory): keep the real action/event NAMES inside the folded summary — counts alone
    // let the brain hallucinate forgotten symbols after compaction. Cap with a "+N" tail.
    const cap = (arr: string[], n: number) => (arr.length > n ? `${arr.slice(0, n).join("、")}…(+${arr.length - n})` : arr.join("、"));
    const agentActs = ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name);
    lines.push(`本体快照(只能用这些真名，别脑补) · Agent动作: ${cap(agentActs, 30)} · 事件: ${cap(ctx.ontology.events.map((e) => e.name), 40)}`);
    // #3/#4 (memory): ALSO keep DataObject + rule NAMES in the fold — object property detail and
    // rule text are recoverable via describe_object / fetchActionRules, but the NAMES must survive
    // so the brain knows what exists to recall.
    const objNames = ctx.ontology.objects.map((o) => o.name || o.id);
    if (objNames.length) lines.push(`数据对象(共${objNames.length}，字段用 describe_object 取回): ${cap(objNames, 30)}`);
    if (ctx.ontology.rules.length) {
      const ruleNames = ctx.ontology.rules.map((r) => { const ro = r as Record<string, unknown>; return String(ro.businessLogicRuleName ?? ro.name ?? ro.title ?? ro.id ?? ""); }).filter(Boolean);
      lines.push(`规则(共${ctx.ontology.rules.length}，运行时用 ontology.fetchActionRules 抓): ${ruleNames.length ? cap(ruleNames, 25) : "(按动作动态抓)"}`);
    }
  }
  if (ctx.currentPlan) lines.push(`计划 v${ctx.currentPlan.version}: ${ctx.currentPlan.summary}`);
  if (ctx.specs.length) lines.push(`已设计 ${ctx.specs.length} 个 agent: ${ctx.specs.map((s) => `${s.short}(工具${s.tools.length}${s.generatedCode ? "·有码" : ""})`).join("、")}`);
  if (ctx.lastValidation) lines.push(`上次校验: ${ctx.lastValidation.ok ? "闭合✓" : "未闭合"}`);
  if (ctx.lastSandbox) lines.push(`上次沙箱: 部署${ctx.lastSandbox.deployed}·跑${ctx.lastSandbox.agentsRan}·${ctx.lastSandbox.fullChainRan ? "端到端通✓" : "未通"}`);
  if (ctx.createdSkills.length) lines.push(`本次创造技能: ${ctx.createdSkills.map((s) => s.name).join("、")}`);
  // The AI's DIGESTED understanding of the ontology (understand_ontology) is reasoning the brain
  // owes itself — keep it verbatim through a fold so the design phase still reasons over the
  // understood model after early turns compact away ("读了就忘" insurance).
  if (ctx.ontologyUnderstanding) lines.push(`本体理解(AI 消化结论·understand_ontology): ${ctx.ontologyUnderstanding.slice(0, 700)}`);
  // The intent gate's reading of WHAT THE USER WANTS — the one thing the brain must never
  // forget, however long the run gets. Appended per goal, kept verbatim through every fold.
  if (ctx.userIntent) lines.push(`用户意图(意图门·逐条累积): ${ctx.userIntent.slice(0, 500)}`);
  // #POLICY — 折叠后大脑仍要记得"这次请求走什么路线"（analyze 别 sandbox、skinny 别全量重走）。
  if (ctx.policy) lines.push(`推理路线(前置路由): ${ctx.policy.pipeline}${ctx.policy.strategy ? `·策略 ${ctx.policy.strategy}` : ""}${ctx.policy.deepUnderstand ? "·深读" : ""}${ctx.policy.deepCritique ? "·深评" : ""}${ctx.policy.tierBias ? `·${ctx.policy.tierBias}档` : ""} — ${ctx.policy.reasons.slice(0, 2).join("；")}`);
  // capability_resolve 的选型结论（复用/组合/新造）——设计阶段的"别造重复轮子"依据。
  if (ctx.capabilityResolution) lines.push(`能力解析(选型优先于制造): ${ctx.capabilityResolution.slice(0, 600)}`);
  if (ctx.humanDirectives.length) lines.push(`人工介入指令: ${ctx.humanDirectives.join(" / ")}`);
  // Open-problems anchor (ported from old AO): the work STILL OWED, kept verbatim so it never
  // compacts away — after a fold the brain reasons from a live problem list, not just counts.
  const open: string[] = [];
  if (ctx.ontology) {
    const done = new Set(ctx.specs.map((s) => s.actionName));
    const uncovered = ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name).filter((n) => !done.has(n));
    if (uncovered.length) open.push(`还没设计的 Agent 动作: ${uncovered.join("、")}`);
  }
  const untooled = ctx.specs.filter((s) => !s.tools.length && !s.hitl).map((s) => s.actionName);
  if (untooled.length) open.push(`没绑任何工具(会降级)的 agent: ${untooled.join("、")}`);
  const unresolved = ctx.specs.filter((s) => (s.unresolvedTools ?? []).length).map((s) => `${s.actionName}[${s.unresolvedTools!.join(",")}]`);
  if (unresolved.length) open.push(`工具没解析的 agent: ${unresolved.join("、")}`);
  if (ctx.lastValidation && !ctx.lastValidation.ok) { const bad = Object.keys(ctx.lastValidation.agentIssueMap); if (bad.length) open.push(`上次校验未闭合，问题 agent: ${bad.join("、")}`); }
  if (ctx.lastSandbox && !ctx.lastSandbox.fullChainRan) open.push(`上次沙箱未整链跑通${ctx.lastSandbox.degradedAgents.length ? `（降级: ${ctx.lastSandbox.degradedAgents.join(",")}）` : ""}`);
  if (open.length) lines.push(`⚠ 还没解决的问题（处理完才能 finish）:\n  - ${open.join("\n  - ")}`);
  lines.push(`花费: ${ctx.spent.turns} 轮 · ${Math.round(ctx.spent.tokens / 1000)}k tokens · ${ctx.spent.sandboxRuns} 次沙箱。需要细节用 describe_object(对象字段) / read_spec / inspect_run / list_agents 取回，别凭记忆脑补。`);
  return lines.join("\n");
}

/** Tier-2 abstractive compaction (ported from old AO): a best-effort LLM pass over the dropped
 *  turns that preserves REASONING NUANCE the deterministic snapshot can't (key decisions + WHY,
 *  diagnoses, open todos, concrete names). Cheap (fast tier); falls back to "" on any error. */
async function summarizeDropped(dropped: ChatMsg[], ctx: BrainCtx): Promise<string> {
  const text = dropped
    .map((m) => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 800) : JSON.stringify(m.content).slice(0, 400)}`)
    .join("\n")
    .slice(0, 24000);
  const sys =
    "把下面这段 Agent 工厂运行对话压成要点，只保留对【后续决策】有用的：做过的关键决策与原因、遇到的问题与诊断结论、还没解决的事、涉及的具体名字(agent/事件/工具/runId)。简洁中文要点，别复述全文，别编造。";
  return chatOnce(sys, text, { temperature: 0.2, maxTokens: 700, signal: ctx.signal, models: modelChain("fast") });
}

/** Returns true if it compacted. Folds [system, ...old] → [system, stateSummary(+narrative)] + recent. */
async function maybeCompact(messages: ChatMsg[], ctx: BrainCtx): Promise<boolean> {
  if (messages.length <= COMPACT_AT_MSGS) return false;
  const system = messages[0]!;
  const dropped = messages.slice(1, Math.max(1, messages.length - KEEP_RECENT));
  // Slice `recent` from the SAME lower boundary so messages[0] (the system prompt) is never
  // included — `slice(-KEEP_RECENT)` would swallow it when KEEP_RECENT >= messages.length.
  const recent = messages.slice(Math.max(1, messages.length - KEEP_RECENT));
  // don't split a tool-call/tool-result pair at the boundary: drop a leading orphan tool msg
  while (recent.length && recent[0]!.role === "tool") recent.shift();
  let summaryText = buildStateSummary(ctx);
  if (process.env.FACTORY_COMPACT_ABSTRACTIVE !== "0" && isGatewayConfigured() && dropped.length > 4) {
    const narrative = await summarizeDropped(dropped, ctx).catch(() => "");
    if (narrative.trim()) summaryText += `\n\n【折叠轮次的推理脉络（摘要，仅供延续决策）】\n${narrative.trim()}`;
    else {
      // #W2 — summarization failed (rate-limit/timeout): DON'T silently drop the reasoning narrative.
      // Deterministic fallback: keep the tail of the dropped assistant turns verbatim + surface a
      // visible warning so "reasoning continuity degraded" is legible, not invisible.
      const tail = dropped
        .filter((m) => m.role === "assistant")
        .slice(-3)
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)).slice(0, 400))
        .join("\n---\n");
      if (tail) summaryText += `\n\n【折叠轮次的原文尾段（摘要生成失败的确定性兜底）】\n${tail}`;
      ctx.emit({ t: "reflect", kind: "compact-fallback", lesson: "压缩摘要 LLM 调用失败——已用确定性截断兜底，推理连续性可能受损。" });
    }
  }
  const summary: ChatMsg = { role: "system", content: summaryText };
  messages.length = 0;
  messages.push(system, summary, ...recent);
  return true;
}

// ── constrained decoding (grounding enums) ─────────────────────────────────────
// Once the ontology is known, constrain the design/refine tool schemas' `action`
// (and tool-name fields) to the REAL names, so the model can't emit invented symbols
// (when the gateway honors JSON-schema enums). Cheap to rebuild each turn.
function injectGroundingEnums(schemas: ToolSchema[], g: { actionNames: string[]; toolNames: string[] }): ToolSchema[] {
  if (!g.actionNames.length) return schemas;
  return schemas.map((s) => {
    if (s.function.name !== "design_agent" && s.function.name !== "refine_agent" && s.function.name !== "codegen_agent" && s.function.name !== "read_spec" && s.function.name !== "score_spec") return s;
    const params = JSON.parse(JSON.stringify(s.function.parameters)) as { properties?: Record<string, Record<string, unknown>> };
    if (params.properties?.action) params.properties.action.enum = g.actionNames;
    if (params.properties?.tools && g.toolNames.length) (params.properties.tools as { items?: Record<string, unknown> }).items = { type: "string", enum: g.toolNames };
    return { ...s, function: { ...s.function, parameters: params } };
  });
}

// Maps a stage-bearing tool to the pipeline stage it advances, so the conductor can emit an
// explicit `stage` event when the brain enters it. Only the primary stage-advancing tools are
// listed — auxiliary reads (read_spec, score_spec, web_search, list_domains…) deliberately do
// NOT move the rail, so it doesn't jump backward on incidental lookups. A refine_agent firing
// after validate legitimately moves it back to "design" — that IS the refine loop the canvas
// draws. The web client mirrors this in stageOf() as a fallback for stage-less old transcripts.
const STAGE_OF_TOOL: Record<string, FactoryStage> = {
  read_ontology: "read",
  create_plan: "plan",
  design_agent: "design",
  codegen_agent: "design",
  refine_agent: "design",
  revert_refine: "design",
  validate_graph: "validate",
  review_agent: "validate",
  review_context: "validate",
  review_completeness: "validate",
  verify_chain: "validate",
  propose_boundary_events: "validate",
  generate_test_cases: "sandbox",
  sandbox_run: "sandbox",
  inspect_run: "sandbox",
  finish: "deliver",
};

// #W2-STAGE — the OUTER STAGE STATE MACHINE: phaseFor was a display signal; these are ADMISSION
// GATES. A stage-bearing tool is refused with a structured steer unless its stage's entry conditions
// hold — the pipeline order is enforced by structure, not by system-prompt prose ("别跳过"). ReAct
// stays free INSIDE a stage; only cross-stage jumps are gated. Read-only/info tools are never gated.
export function stageAdmission(toolName: string, ctx: BrainCtx): string | null {
  const stage = STAGE_OF_TOOL[toolName];
  if (!stage) return null; // non-stage tools (info/skill/tool-smith/HITL) are always admitted
  switch (stage) {
    case "read":
      return null;
    case "plan":
      return ctx.ontology ? null : `[阶段闸门] ${toolName} 属于 PLAN 阶段——入口条件未满足：还没 read_ontology。先读本体。`;
    case "design":
      if (!ctx.ontology) return `[阶段闸门] ${toolName} 属于 DESIGN 阶段——先 read_ontology。`;
      if (toolName === "design_agent" && !ctx.currentPlan) return `[阶段闸门] design_agent 需要先有分解计划——先 create_plan（并建议 critique_plan 挑战它），再逐个设计。`;
      return null;
    case "validate":
      return ctx.specs.length ? null : `[阶段闸门] ${toolName} 属于 VALIDATE 阶段——还没有任何已设计 agent 可审。先 design_agent。`;
    case "sandbox":
      if (!ctx.specs.length) return `[阶段闸门] ${toolName} 属于 SANDBOX 阶段——先 design_agent。`;
      if (toolName === "sandbox_run" && !ctx.lastValidation) return `[阶段闸门] sandbox_run 前先 validate_graph（事件图闭合 + 字段合同）——没校验就部署是在浪费一次真实沙箱。`;
      return null;
    case "deliver":
      return ctx.lastSandbox ? null : `[阶段闸门] finish 属于 DELIVER 阶段——还没有沙箱证据。先 generate_test_cases → sandbox_run。`;
  }
  return null;
}

// #W2-STAGE — per-stage token budgets. DEFAULT OFF (0 = unlimited) per user 2026-07-02
// («token预算取消，设置最高预算»): live Allmeta domains routinely exceeded the old 50k/80k
// READ/PLAN defaults, so the «超出 token 预算——已提示收敛» nudge fired every run and steered the
// brain for no reason. A deployment that WANTS budgets re-enables per stage via
// FACTORY_STAGE_BUDGET_<STAGE>=<tokens>; the admission gates (stageAdmission) — which are about
// ORDER, not spend — are untouched.
const STAGE_BUDGETS: Record<string, number> = {
  read: envInt("FACTORY_STAGE_BUDGET_READ", 0),
  plan: envInt("FACTORY_STAGE_BUDGET_PLAN", 0),
  design: envInt("FACTORY_STAGE_BUDGET_DESIGN", 0),
  validate: envInt("FACTORY_STAGE_BUDGET_VALIDATE", 0),
  sandbox: envInt("FACTORY_STAGE_BUDGET_SANDBOX", 0),
  deliver: envInt("FACTORY_STAGE_BUDGET_DELIVER", 0),
};

// Runaway backstop, not the real bound. Auto-compaction keeps context bounded. Env-overridable (#9c).
const MAX_TURNS = envInt("FACTORY_MAX_TURNS", 200);
// UNCAPPED by default (user vetoed token caps). Escape hatch: FACTORY_BRAIN_MAX_SESSION_TOKENS.
const MAX_TOKENS: number | null = (() => {
  const n = Number(process.env.FACTORY_BRAIN_MAX_SESSION_TOKENS);
  return Number.isFinite(n) && n > 0 ? n : null;
})();
const TOOL_RESULT_CAP = 60_000;

function freshCtx(domain: string, goal: string, ports: FactoryPorts, emit: (e: BrainEvent) => void, priorReflections: ReflectionLite[]): BrainCtx {
  return {
    domain,
    goal,
    emit,
    ports,
    specs: [],
    ontology: null,
    budget: { maxTokens: MAX_TOKENS, maxTurns: MAX_TURNS },
    spent: { tokens: 0, turns: 0, sandboxRuns: 0 },
    currentPlan: null,
    toolCatalog: [],
    attemptHistory: {},
    createdSkills: [],
    research: [],
    lastSandbox: null,
    lastValidation: null,
    humanDirectives: [],
    priorReflections,
  };
}

/** spawn_subagent — a real isolated sub-brain for a focused research subtask. It gets
 *  its OWN message history + ctx (read-only tools only: no deploy, no mutation) and
 *  returns its summary, so a side investigation doesn't pollute the main conversation. */
const spawnSubagentTool: BrainTool = {
  name: "spawn_subagent",
  description: "派一个隔离的子大脑做聚焦子任务（只读研究：read_ontology / describe_domain / web_search / inspect_run 等，不能部署也不能改 agent）。完成后回传它的总结。某个子问题要独立深入分析、又不想污染主对话时用。",
  parameters: { type: "object", properties: { reasoning: { type: "string", description: "为什么要派子大脑" }, task: { type: "string", description: "交给子大脑的聚焦子任务" }, role: { type: "string", description: "【由你自动拟定】给这个子大脑设定的角色名（≤10 字，按任务定制，如「证据调查员」「规则考古学家」「链路侦探」）——后台任务卡与活动叙事用它称呼这个子 agent" }, tools: { type: "array", items: { type: "string" }, description: "#W3-2 可选:限定子大脑只能用这些工具(作用域工具集,避免 38 个全量工具污染其决策);不传=默认只读集" } }, required: ["reasoning", "task"], additionalProperties: false },
  async execute(args, ctx) {
    const task = String(args.task ?? "").trim();
    if (!task) return { ok: false, summary: "task 不能为空。" };
    // #ROLE — 子大脑的角色由 AI 在 spawn 时自动设定（开放词汇，不设注册表）；缺省不显示。
    const role = String(args.role ?? "").trim().slice(0, 16) || undefined;
    // #W3-2 — scoped toolset: filter the sub-brain's tools to the requested subset (of the read-only
    // sub-agent set) so a narrow research task isn't confused by the full catalog.
    const toolFilter = Array.isArray(args.tools) ? new Set((args.tools as string[]).map(String)) : null;
    const scopedTools = toolFilter ? SUBAGENT_TOOLS.filter((t) => toolFilter.has(t.name)) : undefined;
    ctx.emit({ t: "subagent.start", task, role });
    let summary = "";
    try {
      // R9: propagate depth so the spawned sub-brain gets the depth-bounded toolset (it may
      // fan out one more level until MAX_SUBAGENT_DEPTH, then read-only). No explicit `tools`
      // override here — runBrain picks the right set from isSubAgent + depth.
      for await (const ev of runBrain({ domain: ctx.domain, goal: task, ports: ctx.ports, signal: ctx.signal, isSubAgent: true, depth: (ctx.subagentDepth ?? 0) + 1, ...(scopedTools?.length ? { tools: scopedTools } : {}) })) {
        if (ev.t === "message") summary = ev.text;
      }
    } catch (e) {
      summary = `子大脑出错：${(e as Error).message}`;
    }
    ctx.emit({ t: "subagent.done", task, summary });
    return { ok: true, summary: `子大脑完成：${summary.slice(0, 200)}`, output: { summary } };
  },
};

/** The serializable slice of ctx (everything except the runtime handles). */
function serializeCtx(ctx: BrainCtx): Record<string, unknown> {
  const { emit: _e, ports: _p, signal: _s, ...rest } = ctx;
  void _e; void _p; void _s;
  return rest;
}

export async function* runBrain(opts: {
  domain: string;
  goal: string;
  ports: FactoryPorts;
  /** defaults to FACTORY_TOOLS */
  tools?: BrainTool[];
  /** aborts the loop when the SSE client disconnects */
  signal?: AbortSignal;
  /** conversation key — resume if it exists (load prior messages + ctx), else fresh. */
  conversationId?: string;
  /** internal: this run IS a spawned sub-brain (read-only, no persistence side effects). */
  isSubAgent?: boolean;
  /** sub-brain recursion depth (R9) — bounds spawn_subagent fan-out. */
  depth?: number;
}): AsyncGenerator<BrainEvent> {
  const depth = opts.depth ?? 0;
  const MAX_SUBAGENT_DEPTH = 2;
  // R9: a sub-brain may itself fan out one more level (until MAX), then it's read-only research.
  const tools = opts.tools ?? (opts.isSubAgent ? (depth < MAX_SUBAGENT_DEPTH ? [...SUBAGENT_TOOLS, spawnSubagentTool] : SUBAGENT_TOOLS) : [...FACTORY_TOOLS, spawnSubagentTool]);
  const buffer: BrainEvent[] = [];
  const emit = (e: BrainEvent) => buffer.push(e);

  // #7: warm the live model catalog (best-effort, non-blocking) so the difficulty router can
  // validate/derive tier chains against the models the gateway actually serves.
  warmModelCatalog();

  // resume or fresh
  // #AUDIT-FIX(H1) — 区分「行不存在」与「读取失败」：读失败曾被吞成 fresh，随后每轮 checkpoint
  // 用全新 ctx 覆盖同一 conversationId——一次瞬时读故障即永久摧毁会话历史。现在：读失败 →
  // 按 fresh 继续本次运行（不阻断用户），但【禁用全部落盘】保护旧行，并发出可见告警。
  let convReadFailed = false;
  const savedExists = opts.conversationId
    ? await opts.ports.conversation.has(opts.conversationId).catch(() => { convReadFailed = true; return false; })
    : false;
  const saved = savedExists
    ? await opts.ports.conversation.load(opts.conversationId!).catch(() => { convReadFailed = true; return null; })
    : null;
  const checkpointWritesDisabled = convReadFailed;
  // #AUDIT-FIX(L28) — 崩溃自动续跑的哨兵目标：不当作新需求（跳过意图门/policy/目标追加），
  // 只提示大脑从状态摘要接续，避免同一请求被登记两次意图、注入错误路线。
  const isCrashResume = !opts.isSubAgent && opts.goal.trim().startsWith("[恢复继续]");
  const priorReflections: ReflectionLite[] = saved
    ? ((saved.ctx.priorReflections as ReflectionLite[]) ?? [])
    : await opts.ports.reflection.list(opts.domain).catch(() => []);

  const ctx: BrainCtx = saved
    ? ({ ...(saved.ctx as unknown as BrainCtx), emit, ports: opts.ports } as BrainCtx)
    : freshCtx(opts.domain, opts.goal, opts.ports, emit, priorReflections);
  ctx.emit = emit;
  ctx.ports = opts.ports;
  ctx.goal = opts.goal;
  ctx.signal = opts.signal;
  ctx.conversationId = opts.conversationId;
  ctx.subagentDepth = depth;
  // #P0-3 — bind LLM telemetry to this run so every chatOnce records against the right conversation/
  // domain (single-instance: one brain run at a time). No-op unless a sink is wired at bootstrap.
  setLlmCallContext({ conversationId: opts.conversationId, domain: opts.domain });

  const toolSchemas: ToolSchema[] = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const byName = new Map(tools.map((t) => [t.name, t]));

  // #9 (i18n): the brain's working language — follows FACTORY_BRAIN_LANG, else (auto) the ontology
  // content / the domain id, default zh. On a FRESH run ctx.ontology is null here, so under `auto`
  // it's re-resolved once read_ontology populates the ontology (see the turn loop) and the system
  // prompt refreshed — otherwise a Chinese-content domain with an ASCII slug would resolve to en.
  let lang = resolveBrainLang(opts.domain, ctx.ontology);
  let langFromOntology = !!ctx.ontology;
  const messages: ChatMsg[] = saved
    ? [...(saved.messages as ChatMsg[])]
    : [
        { role: "system", content: systemPrompt(opts.domain, priorReflections, lang) },
        { role: "user", content: opts.goal },
      ];
  // On RESUME, messages[0] is the system prompt frozen when the conversation started.
  // Refresh it so prompt improvements (the routing 铁律) apply to ongoing conversations
  // too, not just brand-new ones — otherwise the brain keeps obeying the old prompt.
  if (saved && messages[0]?.role === "system") {
    messages[0] = { role: "system", content: systemPrompt(opts.domain, priorReflections, lang) };
  }

  if (convReadFailed) {
    emit({ t: "reflect", kind: "warning", lesson: "⚠ 会话存档读取失败——本次按临时会话运行且【不落盘】以保护既有历史；修复存储后重新发送可恢复原会话。" });
  }

  // #AUDIT-FIX(H3) — resume 时的残留 park 门调和：崩溃/停止时 park 标志随 checkpoint 幸存，
  // 老逻辑会带着空邮箱重新 park ~3 分钟然后自动做出【用户从未批准的】决定（含真实部署）。
  // 现在：① 若在等澄清且用户发来了新消息 → 新消息就是答案（走澄清门同款登记路径）；
  // ② 若在等测试用例/边界确认 → 取消旧等待并明确告知大脑（提案仍在上下文，可重新发起），
  // 绝不自动替用户拍板。
  let goalRoutedToClarify = false;
  if (saved && !opts.isSubAgent) {
    const goalText = opts.goal.trim();
    if (ctx.awaitingClarify && ctx.clarifyPrompt && goalText && !isCrashResume && !isStopIntent(goalText)) {
      const q = ctx.clarifyPrompt.question;
      const hit = ctx.clarifyPrompt.options?.find((o) => o.label === goalText || o.value === goalText);
      const answer = hit ? hit.value : goalText;
      ctx.awaitingClarify = false;
      ctx.clarifyPrompt = undefined;
      ctx.humanDirectives.push(`澄清「${q}」→ ${answer}`);
      (ctx.askedQuestions ??= {})[normalizeQuestion(q)] = answer;
      messages.push({ role: "user", content: `[用户澄清回答] 针对你的问题「${q}」，用户回答：${answer}。据此继续，别再重复问同样的问题。` });
      emit({ t: "message", text: `✅（恢复会话）已把你的新消息作为此前澄清问题「${q.slice(0, 40)}」的回答。` });
      goalRoutedToClarify = true;
    }
    if (ctx.awaitingApproval) {
      ctx.awaitingApproval = false;
      messages.push({ role: "user", content: "[门已重置] 恢复会话时存在未决的【测试用例确认】——原等待已取消，没有也不会自动执行部署。测试用例仍在上下文；若仍需沙箱验证，请重新征求用户确认（generate_test_cases 或直接 ask_user）。先处理用户的新消息。" });
      emit({ t: "message", text: "ℹ️（恢复会话）此前有一个未决的测试用例确认——已取消等待，不会自动执行部署。" });
    }
    if (ctx.awaitingBoundary) {
      ctx.awaitingBoundary = false;
      messages.push({ role: "user", content: "[门已重置] 恢复会话时存在未决的【边界事件分类】——原等待已取消（不会按 AI 初判自动生效）。boundaryProposals 仍在上下文；若需要请重新 propose_boundary_events 征求用户确认。先处理用户的新消息。" });
      emit({ t: "message", text: "ℹ️（恢复会话）此前有一个未决的边界事件分类——已取消等待，不会自动按初判生效。" });
    }
  }
  if (saved && !goalRoutedToClarify) messages.push({ role: "user", content: opts.goal });

  // ── INTENT GATE（意图门）— understand the user before executing them. Every new goal
  // (fresh run OR a resumed conversation's follow-up) gets a fast structured read:
  // [类型] 目标 ｜ 约束 ｜ 期望产物 — APPENDED to ctx.userIntent so the conversation's intent
  // history accumulates. Fold-surviving (buildStateSummary) + restart-surviving (serializeCtx).
  // Skipped for sub-brains (machine-authored goals); fail-safe inside parseUserIntent: an LLM
  // hiccup degrades to recording the raw goal — the gate never blocks a run.
  if (!opts.isSubAgent && isGatewayConfigured() && opts.goal.trim() && !goalRoutedToClarify && !isCrashResume) {
    const before = ctx.userIntent;
    ctx.userIntent = await parseUserIntent(opts.goal, ctx.userIntent);
    if (ctx.userIntent && ctx.userIntent !== before) {
      const latest = ctx.userIntent.split("\n").pop() ?? ctx.userIntent;
      emit({ t: "reflect", kind: "intent", lesson: `意图理解：${latest.replace(/^\+\s*/, "")}` });
    }
  }

  // ── #POLICY 前置自适应路由 — 意图门之后、任何工具调用之前，按【问题类型】选流水线形状 +
  // 档位偏置（analyze/question 降 fast 省钱）。#NATIVE 修订：规模/难度/历史教训只作为【事实
  // 与建议】注入上下文（下方 guide 消息），分治深度（understand/critique 的 deep 参数）由 AI
  // 原生决定——不再由本体规模阈值确定性强制。对 sub-brain 跳过（机器目标，无需分诊）。
  if (!opts.isSubAgent && !goalRoutedToClarify && !isCrashResume) {
    const difficulty = estimateDifficulty(ctx.ontology);
    // ontologyUnderstanding 是折叠幸存的文本摘要——understand_ontology 的产出固定含"N 处歧义"。
    // 首轮（还没理解）为 0；续轮（resume 的追加目标）能据此建议 ask_first。
    const ambiguityCount = Number(ctx.ontologyUnderstanding?.match(/(\d+)\s*处歧义/)?.[1] ?? 0);
    let policy = selectPolicy({ intentKind: classifyIntentKind(ctx.userIntent), difficulty, hasSpecs: ctx.specs.length > 0, ambiguityCount });
    // #POLICY-LEARN — 历史 arm 统计做证据偏置（保真差→强制深评；fast 答疑砸→撤降档）。best-effort。
    try {
      const stats = (await ctx.ports.policyStats?.load(opts.domain)) ?? null;
      policy = adjustPolicyWithStats(policy, stats, difficulty.band);
    } catch { /* 无统计 → 原样 */ }
    ctx.policy = { ...policy, band: difficulty.band };
    emit({ t: "policy", pipeline: policy.pipeline, strategy: policy.strategy, band: difficulty.band, deepUnderstand: policy.deepUnderstand, deepCritique: policy.deepCritique, tierBias: policy.tierBias, reasons: policy.reasons });
    // #POLICY — 非 full 路线：把路线指令直接注入对话（阶段闸门不动——它守的是"生成时的顺序"，
    // 路线守的是"这次要不要生成"；analyze/skinny 由大脑按指令执行，指令进 messages 可折叠幸存）。
    // #NATIVE — full 路线也注入一条【事实与建议】（决定权在 AI）：难度事实、经验回喂的深评建议
    // （policy-learning 的 deepCritique 现在只经这里到达 AI，不再被工具强制消费）。
    const suggests = [
      policy.deepUnderstand ? "understand_ontology 建议 deep=true" : null,
      policy.deepCritique ? "critique_plan 建议 deep=true（历史保真教训）" : null,
    ].filter(Boolean);
    const guide =
      policy.pipeline === "analyze"
        ? "[推理路线] 本次是只读分析/答疑：直接用已有知识与 read_ontology/understand_ontology 回答，【不要】进入生成流水线（不 create_plan / design_agent / sandbox_run / finish）。"
        : policy.pipeline === "skinny"
          ? "[推理路线] 本次是修改请求且已有设计成果：先定位目标 agent → refine_agent 定点修 → validate_graph（必要时 sandbox_run）验证。【不要】create_plan 全量重造。"
          : policy.pipeline === "ask_first"
            ? "[推理路线] 本体理解已标出多处歧义：先 ask_user 澄清最关键的 1-2 处（给具体选项），拿到答案再进入设计。"
            : `[推理路线] 完整生成路线。默认推理策略=${policy.strategy}（可按理由否决改选：react 工具循环 / reflection 自评重写 / debate 挑战者+评委 / tot K 分叉 / cot 单链）。参考事实与建议（深读/深评等分治深度由你在工具的 deep 参数里自行决定）：${policy.reasons.slice(-3).join("；")}${suggests.length ? `；${suggests.join("；")}` : ""}`;
    if (guide) messages.push({ role: "user", content: guide });
  }

  let finishedOk = false;
  // COMPLETION GUARD: the brain must design ALL Agent actions before stopping. When it
  // chats mid-generation (no tool call) with coverage still incomplete, nudge it on
  // instead of ending the run. Budget resets on real progress (a new agent designed),
  // so only a genuinely stuck brain hits the cap.
  let incompleteNudges = 0;
  let nudgeBaselineSpecs = 0;
  let erroredOut = false;
  let finishRefusals = 0;
  let sawReflect = false;
  let parkTicks = 0;
  // #AUDIT-FIX(H5) — park 超时节拍 env 可配；批准/边界门超时【挂起】而非自动拍板（见各门）。
  const PARK_MAX_TICKS = Math.max(10, Number(process.env.FACTORY_PARK_MAX_TICKS) || 150);

  try {
    // #W2 — duplicate-call breaker state (consecutive same tool+args).
    let lastToolSig = "";
    let dupCount = 0;
    // #W2-STAGE — current stage for token attribution + one-shot budget steers.
    let currentStage: FactoryStage = "read";
    const stageBudgetWarned = new Set<string>();
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      // #W1-1 — re-assert THIS run's telemetry context every turn (concurrent runs share the module
      // global; per-turn re-assert + per-call entry snapshot bounds misattribution to a same-instant race).
      setLlmCallContext({ conversationId: opts.conversationId, domain: opts.domain });
      if (opts.signal?.aborted) break;

      // #9: once read_ontology has loaded the ontology, re-resolve the language from its CONTENT
      // (under `auto`) and refresh the system prompt if it changed — fixes a fresh run on a
      // Chinese-content domain whose slug is ASCII (which would otherwise stay English).
      if (!langFromOntology && ctx.ontology) {
        langFromOntology = true;
        const l2 = resolveBrainLang(opts.domain, ctx.ontology);
        if (l2 !== lang && messages[0]?.role === "system") {
          lang = l2;
          messages[0] = { role: "system", content: systemPrompt(opts.domain, priorReflections, lang) };
        }
      }

      // #W2-HITL — gate tag routing: a drained message TAGGED for a DIFFERENT gate must be
      // RE-QUEUED (ctx.pendingHuman), never consumed by the wrong gate. Before this fix the clarify
      // gate's "any free text counts" greedily ate [测试用例决策]/[边界事件决策] messages → the right
      // gate then timed out into its auto-fallback (wrong decision).
      const GATE_TAG = { approval: /^\[测试用例决策/, boundary: /^\[边界事件决策\]/, clarify: /^\[澄清回答\]/ };
      const drainRouted = async (): Promise<string[]> => {
        const fresh = opts.conversationId ? await opts.ports.conversation.drainHumanMessages(opts.conversationId).catch(() => []) : [];
        const all = [...(ctx.pendingHuman ?? []), ...fresh];
        ctx.pendingHuman = [];
        return all;
      };
      const requeueFor = (msgs: string[]) => { if (msgs.length) (ctx.pendingHuman ??= []).push(...msgs); };

      // TEST-CASE APPROVAL GATE — if the brain proposed test cases, PARK here (poll the
      // mailbox, no LLM turn consumed) until the user clicks 执行/重新生成. The run is in
      // the background, so parking survives navigation — the user can return and decide.
      if (!opts.isSubAgent && ctx.awaitingApproval && opts.conversationId) {
        const human = await drainRouted();
        let decided: null | { decision: "approve" | "regenerate"; note: string } = null;
        let hardStop = false;
        for (const text of human) {
          if (isStopIntent(text)) { hardStop = true; break; } // #AUDIT-FIX(H6) — park 中的「停止」是硬停止，不是数据
          if (GATE_TAG.boundary.test(text) || GATE_TAG.clarify.test(text)) { requeueFor([text]); continue; } // #W2-HITL
          const m = text.match(/^\[测试用例决策[:：]\s*(执行|approve|重新生成|regenerate)\]\s*([\s\S]*)$/i);
          if (m) decided = { decision: /执行|approve/i.test(m[1]!) ? "approve" : "regenerate", note: (m[2] ?? "").trim() };
          else if (/^(执行|approve|确认执行|ok|好)$/i.test(text.trim())) decided = { decision: "approve", note: "" }; // #AUDIT-FIX(M16) 纯文本关键词可解门
          else if (/^(重新生成|regenerate|重做)/i.test(text.trim())) decided = { decision: "regenerate", note: text.trim().replace(/^(重新生成|regenerate|重做)[，,：:]?\s*/i, "") };
          else {
            ctx.humanDirectives.push(text);
            messages.push({ role: "user", content: `[人工介入] ${text}` });
            yield { t: "message", text: `🧑 收到你的介入：「${text}」` };
          }
        }
        if (hardStop) {
          yield { t: "message", text: "⏹ 收到停止指令——立即停止本次运行（等待中的确认已取消，已生成的内容保留）。" };
          ctx.awaitingApproval = false;
          break;
        }
        if (!decided && parkTicks >= PARK_MAX_TICKS) {
          // #AUDIT-FIX(H5) — 旧行为在超时后自动按「执行」触发真实部署（用户从未批准，且可能
          // 正是为了阻止部署才停下）。现在：挂起运行、保留 park 状态，等用户回来决定；恢复
          // 会话时 H3 调和逻辑接手。绝不自动选择风险更高的一侧。
          parkTicks = 0;
          yield { t: "message", text: "⏸ 测试用例确认等待超时——运行已挂起（不会自动执行部署）。回来后点【执行/重新生成】或直接发消息即可继续。" };
          break;
        }
        if (!decided) {
          parkTicks++;
          await new Promise((r) => setTimeout(r, 1200));
          turn--;
          continue; // poll again without consuming a turn
        }
        parkTicks = 0;
        ctx.awaitingApproval = false;
        yield { t: "test.decision", decision: decided.decision, note: decided.note || undefined };
        if (decided.decision === "approve") {
          messages.push({ role: "user", content: "[测试用例决策] 用户已确认执行这批测试用例。现在调用 sandbox_run 真实部署并用这些用例触发跑通，然后让我看每个 agent 的真实输入/输出。" });
          yield { t: "message", text: "✅ 你确认了用例——开始真实试运行。" };
        } else {
          messages.push({ role: "user", content: `[测试用例决策] 用户要求重新生成测试用例${decided.note ? `，要求：${decided.note}` : ""}。请调用 generate_test_cases 重新设计一批给用户确认。` });
          yield { t: "message", text: `🔄 你要求重做用例${decided.note ? `：${decided.note}` : ""}——重新生成中。` };
        }
      }

      // BOUNDARY-EVENT GATE (mirrors the test-case gate). After the brain proposes boundary
      // events, PARK polling the mailbox until the user submits their per-event classification
      // (external handoff / terminal / break) + external contracts.
      if (!opts.isSubAgent && ctx.awaitingBoundary && opts.conversationId) {
        const human = await drainRouted();
        let decided: BoundaryEvent[] | null = null;
        let hardStopB = false;
        for (const text of human) {
          if (isStopIntent(text)) { hardStopB = true; break; } // #AUDIT-FIX(H6)
          if (GATE_TAG.approval.test(text) || GATE_TAG.clarify.test(text)) { requeueFor([text]); continue; } // #W2-HITL
          const m = text.match(/^\[边界事件决策\]\s*([\s\S]+)$/);
          if (m) {
            try {
              const parsed = JSON.parse(m[1]!.trim());
              if (Array.isArray(parsed)) {
                decided = parsed
                  .filter((e) => e && typeof e === "object" && typeof e.event === "string")
                  .map((e) => ({
                    event: String(e.event),
                    kind: (["external", "terminal", "break"].includes(String(e.kind)) ? String(e.kind) : "external") as BoundaryEvent["kind"],
                    consumer: typeof e.consumer === "string" ? e.consumer : undefined,
                    payloadContract: typeof e.payloadContract === "string" ? e.payloadContract : undefined,
                    note: typeof e.note === "string" ? e.note : undefined,
                  }));
              }
            } catch { /* malformed → keep parking */ }
          } else {
            ctx.humanDirectives.push(text);
            messages.push({ role: "user", content: `[人工介入] ${text}` });
            yield { t: "message", text: `🧑 收到你的介入：「${text}」` };
          }
        }
        if (hardStopB) {
          yield { t: "message", text: "⏹ 收到停止指令——立即停止本次运行（等待中的分类已取消，已生成的内容保留）。" };
          ctx.awaitingBoundary = false;
          break;
        }
        if (!decided && parkTicks >= PARK_MAX_TICKS) {
          // #AUDIT-FIX(M18) — 这个门存在的全部意义是「AI 提案、用户确认」；超时把 AI 初判当用户
          // 决定生效（直接影响断链判定与 finish）违背该原则。改为挂起等用户，恢复时 H3 接手。
          parkTicks = 0;
          yield { t: "message", text: "⏸ 边界事件确认等待超时——运行已挂起（不会按 AI 初判自动生效）。回来后提交分类或直接发消息即可继续。" };
          break;
        }
        if (!decided) {
          parkTicks++;
          await new Promise((r) => setTimeout(r, 1200));
          turn--;
          continue;
        }
        parkTicks = 0;
        ctx.awaitingBoundary = false;
        ctx.boundaryProposals = undefined;
        const byEv = new Map((ctx.boundaryEvents ?? []).map((b) => [b.event, b]));
        for (const b of decided) byEv.set(b.event, b);
        ctx.boundaryEvents = [...byEv.values()];
        ctx.lastValidation = null; // re-validate honoring the new boundary classification
        yield { t: "boundary.decided", events: decided };
        const ext = decided.filter((b) => b.kind === "external");
        const brk = decided.filter((b) => b.kind === "break");
        messages.push({ role: "user", content: `[边界事件决策] 用户已分类：${decided.map((b) => `${b.event}=${b.kind}${b.consumer ? `(${b.consumer})` : ""}`).join("; ")}。${ext.length ? `把这些【外部交接】事件各总结成一份「对外契约」(事件名、payload 字段、触发时机、含义)用文字清晰呈现给我看,供下游消费方核对。` : ""}${brk.length ? `这些被判为【真断点】的事件(${brk.map((b) => b.event).join("、")})要你 refine_agent/补 agent 修。` : ""}外部/终态事件已不再算断点，继续推进。` });
        yield { t: "message", text: `✅ 边界事件已确认(${ext.length} 外部交接 · ${decided.filter((b) => b.kind === "terminal").length} 终态 · ${brk.length} 待修断点)。` };
      }

      // CLARIFICATION GATE (ask_user) — park polling the mailbox until the user answers (free
      // text via `[澄清回答] …`, or just a message). Mirrors the test-case / boundary gates;
      // a park timeout falls back to the AI's recommended option so a run never hangs forever.
      if (!opts.isSubAgent && ctx.awaitingClarify && opts.conversationId) {
        const human = await drainRouted();
        let answer: string | null = null;
        let hardStopC = false;
        const untagged: string[] = [];
        for (const text of human) {
          if (isStopIntent(text)) { hardStopC = true; break; } // #AUDIT-FIX(H6) — 「停止」不是答案
          if (GATE_TAG.approval.test(text) || GATE_TAG.boundary.test(text)) { requeueFor([text]); continue; } // #W2-HITL — was greedily eaten here
          const m = text.match(/^\[澄清回答\]\s*([\s\S]+)$/);
          if (m) untagged.push(m[1]!.trim());
          else untagged.push(text.trim()); // any UNTAGGED free reply while parked counts as answer material
        }
        // #AUDIT-FIX(M16) — 多条自由回复【累积】为完整答案（旧逻辑只留最后一条，前面的静默丢弃）。
        if (untagged.length) answer = untagged.join("\n");
        if (hardStopC) {
          yield { t: "message", text: "⏹ 收到停止指令——立即停止本次运行（待答的问题保留，回来可继续）。" };
          break;
        }
        let autoFallback = false;
        if (!answer && parkTicks >= PARK_MAX_TICKS) {
          const rec = ctx.clarifyPrompt?.options?.find((o) => o.recommended);
          // #ASK-FIX（审查修复）— 超时回退必须用【机器可用的 value】而不是人类可读 label：
          // 大脑拿 label 当叙述读，拿 value 才能当决策执行。label 只进给用户看的消息。
          answer = rec ? rec.value : "(等待超时，AI 自行按最佳判断继续)";
          autoFallback = true; // #AUDIT-FIX(H7) — 机器代答，绝不能冒充用户答案进入去重回放
          yield { t: "message", text: `⏱ 澄清等待超时——${rec ? `按推荐项「${rec.label}」(${rec.value})` : "AI 自行判断"}继续。` };
        }
        if (!answer) {
          parkTicks++;
          await new Promise((r) => setTimeout(r, 1200));
          turn--;
          continue;
        }
        parkTicks = 0;
        const q = ctx.clarifyPrompt?.question ?? ""; // snapshot BEFORE clearing state (idempotent, matches the other gates)
        // #ASK-FIX — 用户自由回复若命中某个选项的 label，规范化为该选项的 value（答案进入
        // 决策路径时统一是机器值；原文保留在给用户的回显里）。
        const hitOpt = ctx.clarifyPrompt?.options?.find((o) => o.label === answer || o.value === answer);
        if (hitOpt) answer = hitOpt.value;
        const clarifyContext = ctx.clarifyPrompt?.context ?? ""; // M20 用，clear 前快照
        ctx.awaitingClarify = false;
        ctx.clarifyPrompt = undefined;
        ctx.humanDirectives.push(`澄清「${q}」→ ${autoFallback ? "(auto·超时代答) " : ""}${answer}`);
        // #ASK-DEDUP — 记住"这个问题已经答过"：同一问题再被 ask_user 时直接回放答案，不再打断用户。
        // #AUDIT-FIX(H7) — 超时的机器代答【不写入】去重表（并清掉 pending 标记）：用户回来后
        // 这个问题必须还能被真正问到，而不是永远回放一个机器决定并声称"用户当时的答复"。
        if (autoFallback) {
          if (ctx.askedQuestions) delete ctx.askedQuestions[normalizeQuestion(q)];
        } else {
          (ctx.askedQuestions ??= {})[normalizeQuestion(q)] = answer;
        }
        // If this was a supply_test_data request, capture any "field: value" lines into the test-data
        // overrides directly — so real values (e.g. a real interview email) thread into the fired
        // payloads even if the brain doesn't explicitly re-call supply_test_data. Safe: the overrides
        // only replace keys ALREADY present in a test payload (applyTestDataOverrides), so unrelated
        // clarify answers are no-ops.
        // #AUDIT-FIX(M20) — 只在明确的【测试数据补全】上下文才做 kv 捕获（旧条件 /字段/ 过宽：
        // 任何提到"字段"的澄清，答案里的 key: value 都被静默织进测试载荷）。捕获结果可见披露。
        if (/测试数据|真实联系|真实值/.test(clarifyContext) || q.includes("真实联系") || q.includes("真实值")) {
          const captured: string[] = [];
          for (const line of answer.split(/\n+/)) {
            const kv = line.match(/^\s*([A-Za-z_][\w.]*)\s*[:：=]\s*(.+?)\s*$/);
            const key = kv?.[1];
            const val = kv?.[2]?.trim();
            if (key && val && val !== "用占位") { (ctx.testDataOverrides ??= {})[key] = val; captured.push(key); }
          }
          if (captured.length) yield { t: "message", text: `🧷 已登记测试真实值：${captured.join("、")}（只会替换测试载荷中已存在的同名字段）。` };
        }
        messages.push({ role: "user", content: `[用户澄清回答] 针对你的问题「${q}」，用户回答：${answer}。据此继续，别再重复问同样的问题。` });
        yield { t: "message", text: `✅ 收到你的回答：${answer}` };
      }

      ctx.spent.turns = turn + 1;

      // HITL: drain human messages injected since the last turn (authoritative steering).
      // A clear "停止/取消/stop" is a HARD stop, not advisory steering — break the loop now
      // (backup to the frontend /stop path, in case the stop arrived via inject).
      if (opts.conversationId) {
        const human = await opts.ports.conversation.drainHumanMessages(opts.conversationId).catch(() => []);
        let stopRequested = false;
        for (const text of human) {
          if (isStopIntent(text)) { yield { t: "message", text: "⏹ 收到停止指令——立即停止本次运行（已生成的内容保留）。" }; stopRequested = true; break; }
          ctx.humanDirectives.push(text);
          messages.push({ role: "user", content: `[人工介入] ${text}` });
          yield { t: "message", text: `🧑 收到你的介入：「${text}」——下一步会纳入。` };
        }
        if (stopRequested) break;
      }

      // #AUDIT-FIX(M14) — pendingHuman 只被 park 门排空；错时投递的带标消息在门关闭后会永远滞留。
      // 常规轮顶：没有任何门在等时，把滞留消息按 [人工介入] 补送（可见），不再无声吞没。
      if (!ctx.awaitingApproval && !ctx.awaitingBoundary && !ctx.awaitingClarify && ctx.pendingHuman?.length) {
        for (const text of ctx.pendingHuman) {
          ctx.humanDirectives.push(text);
          messages.push({ role: "user", content: `[人工介入] ${text}` });
          yield { t: "message", text: `🧑（补送）收到你此前的消息：「${text.slice(0, 80)}」——对应的等待已结束，按介入处理。` };
        }
        ctx.pendingHuman = [];
      }

      // Soft cost meter every 3 turns (NOT a hard cap — user vetoed caps).
      if (turn > 0 && turn % 3 === 0) {
        const tokenK = Math.round(ctx.spent.tokens / 1000);
        const elevatedAt = Number(process.env.FACTORY_COST_ELEVATED_TOKENS) || 2_000_000;
        const highAt = Number(process.env.FACTORY_COST_HIGH_TOKENS) || 4_000_000;
        const level: "ok" | "elevated" | "high" = ctx.spent.tokens >= highAt ? "high" : ctx.spent.tokens >= elevatedAt ? "elevated" : "ok";
        const costNote =
          level === "high"
            ? `⚠ 成本偏高(${tokenK}k tokens · ${ctx.spent.sandboxRuns} 次沙箱)——若已接近可交付，优先收敛到 finish。`
            : level === "elevated"
              ? `成本中高(${tokenK}k tokens)——能 finish 就别再额外 refine。`
              : undefined;
        messages.push({
          role: "system",
          content: `[预算检查] 已用 ${turn}/${MAX_TURNS} turn · ${tokenK}k tokens · ${ctx.spent.sandboxRuns} 次沙箱 · 已造 ${ctx.specs.length} 个 agent · ${ctx.lastSandbox ? "上次沙箱已跑过" : "尚未跑沙箱"}。${costNote ?? "前期探索就继续；接近 finish 就收敛。"}`,
        });
        yield { t: "budget", turn, maxTurns: MAX_TURNS, tokens: ctx.spent.tokens, maxTokens: MAX_TOKENS, specsBuilt: ctx.specs.length, sandboxRuns: ctx.spent.sandboxRuns, level, costNote };
      }

      // Auto-compaction: fold verbose early history into a state summary once large.
      if (await maybeCompact(messages, ctx)) {
        // #2d FIX: emit the folded content as a first-class, EXPANDABLE compaction event (state =
        // the structured snapshot the brain kept), so the user can see exactly what was compacted.
        yield { t: "compaction", summary: "上下文已自动压缩：保留近期若干轮 + 结构化状态摘要，早期冗长输出已折叠（细节可用 read_spec / inspect_run / list_agents 取回）。", state: buildStateSummary(ctx) };
      }

      // #ANCHOR — 本体记忆心跳：按节拍把【本体事实 + 消化结论 + 还欠的覆盖】重新注入对话，
      // 防止长跑中早期理解被几十轮工具结果稀释（折叠幸存解决"丢"，锚点解决"淡"）。
      // 事实提醒而非指令；FACTORY_ONTOLOGY_ANCHOR_EVERY 调节拍（0=关）。
      {
        const anchorEvery = Number(process.env.FACTORY_ONTOLOGY_ANCHOR_EVERY ?? DEFAULT_ANCHOR_EVERY);
        if (anchorDue(turn, anchorEvery)) {
          const anchor = buildOntologyAnchor(ctx, turn);
          if (anchor) {
            messages.push({ role: "user", content: anchor });
            yield { t: "reflect", kind: "anchor", lesson: `本体锚点已注入（第 ${turn} 轮心跳）——理解与覆盖清单已刷新到上下文。` };
          }
        }
      }

      // Constrained decoding: ground design/refine schemas to the REAL action + tool names.
      const groundedSchemas = ctx.ontology
        ? injectGroundingEnums(toolSchemas, {
            actionNames: ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name),
            toolNames: ctx.toolCatalog ?? [],
          })
        : toolSchemas;

      // #AUDIT-FIX(L24) — 排空事件缓冲：工具调用之外 emit 的事件（policy/意图反思/锚点/调和提示）
      // 曾只在工具循环里 drain，纯对话轮会静默滞留、run 结束整批丢弃。
      while (buffer.length) {
        const ev0 = buffer.shift()!;
        if (ev0.t === "reflect") sawReflect = true;
        yield ev0;
      }

      // #7: route this turn's model by difficulty (fast while reading/planning, hard once
      // designing/coding) through a config-driven fallback chain; annotate which model served it.
      const tier = tierForContext(ctx);
      let pendingCalls: { id: string; name: string; args: string }[] | null = null;
      let assistantContent = "";
      // #AUDIT-FIX(M17) — 单轮流中断（看门狗/断流/瞬时 5xx）不再炸掉整个 run：本轮重试一次
      // （messages 在成功前不变，重放安全）；连续两次才向上抛。
      for (let sAttempt = 0; ; sAttempt++) {
        try {
          pendingCalls = null;
          assistantContent = "";
          for await (const ev of streamTurn(messages, groundedSchemas, { signal: opts.signal, models: modelChain(tier) })) {
        if (ev.t === "think") yield { t: "think", delta: ev.delta };
        else if (ev.t === "model") yield { t: "model", model: ev.model, tier, turn: turn + 1 };
        else if (ev.t === "usage") {
          ctx.spent.tokens += ev.promptTokens + ev.completionTokens;
          // #W2-STAGE — attribute this turn's spend to the current stage; steer ONCE when a stage
          // blows its budget (converge/escalate, don't grind inside the stage).
          const st = (ctx.spent.stageTokens ??= {});
          st[currentStage] = (st[currentStage] ?? 0) + ev.promptTokens + ev.completionTokens;
          const budget = STAGE_BUDGETS[currentStage];
          if (budget && st[currentStage]! > budget && !stageBudgetWarned.has(currentStage)) {
            stageBudgetWarned.add(currentStage);
            messages.push({ role: "system", content: `[阶段预算] ${currentStage.toUpperCase()} 阶段已花 ${Math.round(st[currentStage]! / 1000)}k tokens（预算 ${Math.round(budget / 1000)}k）。别在本阶段继续磨：要么收敛进入下一阶段，要么 verify_chain/analyze_failure 定位真问题后换思路。` });
            yield { t: "message", text: `⚠ ${currentStage.toUpperCase()} 阶段超出 token 预算——已提示收敛。` };
          }
        }
        else if (ev.t === "tool_calls") {
          pendingCalls = ev.calls;
          assistantContent = ev.content;
        } else if (ev.t === "done") assistantContent = ev.content;
          }
          break;
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          const transientTurn = !opts.signal?.aborted && /看门狗|空转|overload|\b50[234]\b|temporarily|unavailable|timeout|timed out|too many requests|rate.?limit|econn|socket hang|abort/i.test(msg);
          if (sAttempt === 0 && transientTurn) {
            yield { t: "message", text: `⚠ 本轮模型流中断（${msg.slice(0, 70)}）——自动重试一次。` };
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }
          throw e;
        }
      }

      // No tool calls → the brain is talking: its final answer for this turn. We do NOT
      // second-guess it with a greeting/no-op guard — forcing a tool call because the output
      // "looks like a menu" (regex) was hardcoded routing, deciding FOR the model. The
      // empowering system prompt now lets the model judge for itself whether a message needs
      // a tool; trust that. (An explicit stop intent is still honored at the turn top.)
      if (!pendingCalls || pendingCalls.length === 0) {
        const text = assistantContent.trim();
        if (text) yield { t: "message", text };
        // COMPLETION GUARD — don't let a generation stop mid-way on a chatty turn. If the
        // brain committed to generating (made a plan / designed ≥1 agent) but the ontology's
        // Agent actions aren't all covered and it hasn't successfully finished, tell it
        // exactly what's left and KEEP LOOPING (fixes the "stops after createJD (1/6)" bug).
        // The nudge budget resets on real progress, so a stuck brain still exits.
        // #8 FIX: gate ONLY on real specs existing — NOT on a plan alone. A plan can exist for an
        // analysis/exploration turn the user never asked to finish; nudging then makes "分析一下本体"
        // requests loop. The genuine generation path still trips this the moment the first spec exists.
        // #AUDIT-FIX(H4) — analyze/ask_first/skinny 路线与已交付会话不再被「去 finish」推搡：
        // 旧守卫会连发 5 条与 [推理路线] 直接矛盾的催促（甚至触发不想要的真实部署）。
        const guardExempt = ["analyze", "ask_first", "skinny"].includes(String(ctx.policy?.pipeline ?? "")) || ctx.delivered === true;
        if (!opts.isSubAgent && !finishedOk && !guardExempt && ctx.ontology && ctx.specs.length > 0) {
          const agentActions = ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name);
          const covered = new Set(ctx.specs.map((s) => s.actionName));
          const remaining = agentActions.filter((a) => !covered.has(a));
          if (ctx.specs.length > nudgeBaselineSpecs) { incompleteNudges = 0; nudgeBaselineSpecs = ctx.specs.length; } // progress → refill budget
          if (incompleteNudges < 5) {
            incompleteNudges += 1;
            if (remaining.length > 0) {
              messages.push({ role: "user", content: `[继续生成 · 别停在中途] 这个任务要为本域生成【全部 ${agentActions.length} 个 Agent】,你现在只设计了 ${ctx.specs.length} 个(${[...covered].join("、") || "无"}),还差 ${remaining.length} 个:${remaining.join("、")}。立刻 design_agent 设计【下一个还没设计的】(${remaining[0]}),逐个把剩下的都设计完(每个 design_agent + codegen_agent),全齐了再 validate_graph → sandbox_run → finish。别只反复改 ${[...covered][0] ?? "同一个"}、也别现在停下来问我。` });
              yield { t: "message", text: `↪ 还差 ${remaining.length} 个 agent 没设计(${remaining.join("、")})——继续把它们造完，别停。` };
            } else {
              messages.push({ role: "user", content: `[完成它] 全部 ${ctx.specs.length} 个 agent 都已设计。现在按顺序收尾:validate_graph → (有问题就 refine_agent 修) → sandbox_run(用测试用例真跑通事件链) → finish。别停在这里、别只是描述,真去调工具完成。` });
              yield { t: "message", text: `↪ ${ctx.specs.length} 个 agent 都设计好了——继续 validate → sandbox → finish，别停。` };
            }
            continue; // keep the ReAct loop running instead of ending mid-generation
          }
        }
        break;
      }

      messages.push({
        role: "assistant",
        content: assistantContent || null,
        tool_calls: pendingCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args } })),
      });

      let finished = false;
      for (const call of pendingCalls) {
        // #W2 — consecutive-identical-call breaker: the same tool with the same args twice in a row is
        // grinding; a third is refused outright with a structured steer (no silent token burn).
        const dupSig = `${call.name}:${call.args ?? ""}`;
        if (dupSig === lastToolSig) dupCount += 1; else { dupCount = 0; lastToolSig = dupSig; }
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.args || "{}");
        } catch {
          args = {};
        }
        const reasoning = typeof args.reasoning === "string" ? args.reasoning : "";
        // #UI-DRILL — the generated agent this harness step targets (agent-scoped tools carry
        // `action`; `design_subagent` carries `parent_action`). Lets the ops panel group every
        // reasoning step + tool call under the agent it was building.
        const forAgent = typeof args.action === "string" ? args.action : typeof args.parent_action === "string" ? args.parent_action : undefined;
        yield { t: "tool.call", id: call.id, name: call.name, reasoning, input: args, role: roleOfTool(call.name), forAgent };

        // Explicit stage signal: light the canvas rail as the brain ENTERS this stage, before
        // the (possibly long) tool runs, so the active-stage highlight tracks the live work.
        const stage = STAGE_OF_TOOL[call.name];
        if (stage) yield { t: "stage", stage, status: "active", role: roleOfTool(call.name) };

        const tool = byName.get(call.name);
        // #W2-STAGE — admission gate: refuse a stage-jumping tool with a structured steer (this is the
        // phaseFor→control upgrade; order enforced by structure, not prompt prose).
        const admission = stageAdmission(call.name, ctx);
        // #AUDIT-FIX(L29) — 只有闸门放行才更新 stage 归因：被拒绝的跳段不应把后续 token 记到它头上。
        if (!admission && STAGE_OF_TOOL[call.name]) currentStage = STAGE_OF_TOOL[call.name]!;
        let result;
        if (admission) {
          result = { ok: false, summary: admission };
        } else if (dupCount >= 2) {
          result = { ok: false, summary: `重复调用检测：你已连续 ${dupCount + 1} 次用【完全相同的参数】调用 ${call.name}——重复不会改变结果。改变输入、换工具（verify_chain/analyze_failure/ask_user），或 revert 后换思路。` };
        } else if (!tool) result = { ok: false, summary: `未知工具 ${call.name}` };
        else {
          // #HEARTBEAT — 工具执行心跳：长工具（understand_ontology 四维分治 / sandbox_run 轮询）
          // 曾在 UI 上只有一句"运行中…"，慢/卡/死不可区分。现在每 ~15s yield 一条 tool.progress
          // （elapsed 递增 + 阶梯升级提示），SSE 持续有流量 → 前端 staleness 不误报"无响应"。
          try {
            const HEARTBEAT_MS = Math.max(5000, Number(process.env.FACTORY_TOOL_HEARTBEAT_MS) || 15000);
            const toolP = Promise.resolve(tool.execute(args, ctx)).then(
              (v) => ({ kind: "ok" as const, v }),
              (e) => ({ kind: "err" as const, e }),
            );
            let elapsedMs = 0;
            type Settled = Awaited<typeof toolP>;
            let settled: Settled | null = null;
            for (;;) {
              const raced: Settled | null = await Promise.race([toolP, new Promise<null>((r) => { const t = setTimeout(() => r(null), HEARTBEAT_MS); (t as unknown as { unref?: () => void }).unref?.(); })]);
              if (raced) { settled = raced; break; }
              elapsedMs += HEARTBEAT_MS;
              const es = Math.round(elapsedMs / 1000);
              const note =
                es >= 420 ? "仍在执行。若长期无进展可停止运行——心跳仍在说明进程没死，多半是外部依赖极慢。"
                : es >= 180 ? "仍在执行（长任务：多次 LLM 调用/沙箱轮询属正常）。"
                : es >= 60 ? "仍在执行——这一步涉及多次 LLM 调用或外部等待。"
                : undefined;
              yield { t: "tool.progress", id: call.id, name: call.name, role: roleOfTool(call.name), elapsedS: es, ...(note ? { note } : {}) };
            }
            if (settled!.kind === "ok") result = settled!.v;
            else throw settled!.e;
          } catch (e) {
            result = { ok: false, summary: `工具 ${call.name} 出错：${(e as Error).message}` };
          }
        }
        // drain events the tool emitted (agent.created / validation / sandbox / plan / reflect)
        while (buffer.length) {
          const ev = buffer.shift()!;
          if (ev.t === "reflect") sawReflect = true;
          yield ev;
        }
        // #5: stream the FULL tool output (not just the one-line summary) so the activity log
        // shows complete I/O. Cap is generous + configurable so a huge read_ontology doesn't bloat
        // the SSE, but the "完整输出" pane is genuinely complete for normal tool calls.
        const outStr = result.output !== undefined ? (typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)) : undefined;
        const UI_OUTPUT_CAP = Number(process.env.FACTORY_UI_OUTPUT_CAP) || 64000;
        const outForUi = outStr && outStr.length > UI_OUTPUT_CAP ? outStr.slice(0, UI_OUTPUT_CAP) + "\n…[输出过长已截断，完整内容用对应工具重取]" : outStr;
        yield { t: "tool.result", id: call.id, name: call.name, ok: result.ok, summary: result.summary, output: outForUi, forAgent };

        // Settle the stage once its tool returns. For `finish` only a PASSED gate (result.ok)
        // is a real 交付; a refused finish stays "error" so the rail never falsely shows shipped.
        if (stage) yield { t: "stage", stage, status: result.ok ? "ok" : "error", role: roleOfTool(call.name) };

        const toolBody = result.output !== undefined ? { summary: result.summary, output: result.output } : { ok: result.ok, summary: result.summary };
        let toolContent = JSON.stringify(toolBody);
        if (toolContent.length > TOOL_RESULT_CAP) {
          toolContent = toolContent.slice(0, TOOL_RESULT_CAP) + `…[结果过长已截断到 ${TOOL_RESULT_CAP} 字符；需要完整内容请用对应工具重取，别凭记忆脑补]`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: toolContent });

        // #3 FIX (memory safety net): if a grounding tool rejected an unknown action/event/field
        // name — the brain forgot the real symbol after compaction — don't just surface the error.
        // Re-inject the REAL names from ctx.ontology (which survives compaction in memory) so the
        // next turn can self-correct without a wasted re-read. Cheap: no extra LLM/tool call.
        if (!result.ok && ctx.ontology && /design_agent|refine_agent|create_agent/.test(call.name) && /未知|不存在|unknown|not found|没有该|无效|invalid/.test(String(result.summary ?? ""))) {
          const acts = ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name);
          const evs = ctx.ontology.events.map((e) => e.name);
          messages.push({ role: "system", content: `[名称纠偏] 你引用了本体里不存在的名称。只能用这些真名(别脑补)：可用 Agent 动作: ${acts.join("、")}；可用事件: ${evs.join("、")}。据此改正后重试。` });
        }

        // Only a PASSED finish ends the loop; a refused finish forces the brain back.
        if (call.name === "finish") {
          if (result.ok) {
            finished = true;
            finishedOk = true;
            ctx.delivered = true; // #AUDIT-FIX(H4) — 跨 run 持久（serializeCtx），交付后的追问不再被催 finish
          } else {
            finishRefusals += 1;
            if (finishRefusals >= 4) {
              messages.push({ role: "system", content: `[诚实收尾] 验收门已拒绝 ${finishRefusals} 次。若反复跑不通，多半是数据/环境/本体限制——别硬试，调 analyze_failure 诚实收尾。` });
              yield { t: "message", text: `⚠ 验收门已拒绝 ${finishRefusals} 次——若确实跑不通，请 analyze_failure 诚实收尾。` };
            }
          }
        }
      }

      // #CRASH-CKPT — checkpoint EVERY turn, not only at run end. The end-of-run `finally` save
      // covers normal exits and parks, but a mid-run PROCESS DEATH (tsx-watch restart on a file
      // edit, manual pnpm-dev restart, crash) used to lose every turn since the last interaction —
      // the «思考过程突然中断且无法续跑» incident: a follow-up build died mid-stream with its
      // conversation checkpoint still frozen at the PREVIOUS interaction. One SQLite upsert per
      // turn is cheap; crash-resume then continues from the latest completed turn.
      if (opts.conversationId && !checkpointWritesDisabled) {
        await opts.ports.conversation
          .save(opts.conversationId, { domain: opts.domain, messages: messages as unknown[], ctx: serializeCtx(ctx) })
          .catch((e) => { try { console.warn(`[factory] 每轮检查点写入失败（崩溃续跑保障降级）：${(e as Error)?.message}`); } catch { /* best-effort */ } }); // #AUDIT-FIX(L25)
      }

      if (finished) break;
      if (MAX_TOKENS != null && ctx.spent.tokens >= MAX_TOKENS) {
        yield { t: "message", text: "已达 token 预算上限，停止。" };
        break;
      }
    }
  } catch (e) {
    erroredOut = true;
    const raw = (e as Error).message ?? "";
    const transient = /overload|\b50[234]\b|temporarily|unavailable|timeout|timed out|too many requests|rate.?limit|econn|socket hang/i.test(raw);
    yield {
      t: "error",
      message: transient
        ? `AI 网关临时过载/不可用(${raw.slice(0, 80)})——已自动重试多次仍未恢复。这是上游算力波动，不是 agent 的问题。已生成的内容都在，稍等重试即可。`
        : raw,
    };
  } finally {
    // Persist messages + ctx so the user's NEXT message resumes this conversation.
    if (opts.conversationId && !checkpointWritesDisabled) {
      await opts.ports.conversation
        .save(opts.conversationId, { domain: opts.domain, messages: messages as unknown[], ctx: serializeCtx(ctx) })
        .catch((e) => { try { console.warn(`[factory] 收尾检查点写入失败：${(e as Error)?.message}`); } catch { /* best-effort */ } }); // #AUDIT-FIX(L25)
    }
    // Tear the sandbox app back down at run-end (revert to 0 functions) — the OLD
    // conductor's session-end teardown. Only if a sandbox actually ran. Best-effort.
    if (!opts.isSubAgent && ctx.spent.sandboxRuns > 0) {
      await opts.ports.sandbox.teardown(opts.domain).catch(() => {});
    }
    // Record skill effectiveness against this run's sandbox verdict (did reuse help?).
    if (!opts.isSubAgent && ctx.ports.skills && ctx.createdSkills.length) {
      const ok = ctx.lastSandbox?.fullChainRan ?? false;
      for (const s of ctx.createdSkills) {
        await ctx.ports.skills.recordEval(s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""), ok).catch(() => {});
      }
    }
  }

  // Fail-safe reflection: if the LLM wrote none, synthesize one so next time isn't amnesiac.
  if (!opts.isSubAgent && !sawReflect) {
    try {
      const note =
        MAX_TOKENS != null && ctx.spent.tokens >= MAX_TOKENS
          ? `token 预算耗尽前未能结束`
          : ctx.spent.turns >= MAX_TURNS
            ? `turn 预算耗尽前未能结束`
            : `循环退出但没正常 finish`;
      await opts.ports.reflection.record(opts.domain, {
        summary: `${note}：${ctx.specs.length} 个 agent · sandbox ${ctx.lastSandbox ? "已跑" : "未跑"}`,
        lesson: "下次为该域生成时：循环走偏时早点 finish 总结现状，或 analyze_failure 留下根因，比空手退出有价值。",
      });
      yield { t: "reflect", kind: "caveat", lesson: "(自动) 退出前留下了一条警示反思" };
    } catch {
      /* never block the done event on a storage hiccup */
    }
  }

  const status: Extract<BrainEvent, { t: "done" }>["status"] = finishedOk
    ? "finished"
    : erroredOut
      ? "errored"
      : MAX_TOKENS != null && ctx.spent.tokens >= MAX_TOKENS
        ? "budget_exhausted"
        : ctx.spent.turns >= MAX_TURNS
          ? "turns_exhausted"
          : "incomplete";
  // #POLICY-LEARN — 把本次 (pipeline|band) 的结果回喂进 arm 统计：ok = 体面收束；fidelityBad =
  // 出现过保真违约。下次同域同难度选路时用作证据偏置。best-effort（存储缺席/失败零影响）。
  if (!opts.isSubAgent && ctx.policy?.band && ctx.ports.policyStats) {
    try {
      const prev = (await ctx.ports.policyStats.load(opts.domain)) ?? null;
      const next = recordOutcome(prev, {
        pipeline: ctx.policy.pipeline,
        band: ctx.policy.band,
        ok: status === "finished",
        fidelityBad: Boolean(ctx.lastSandbox?.fidelityFailures?.length),
      });
      await ctx.ports.policyStats.save(opts.domain, next);
    } catch { /* best-effort */ }
  }
  yield { t: "done", tokensUsed: ctx.spent.tokens, turns: ctx.spent.turns, status };
}
