// Autonomous Harness Brain — the streaming ReAct loop.
//
// Re-implemented for the new arch from the OLD lib/agent-factory-v3/brain/conductor.ts:
// it reasons (streaming think deltas), calls tools, observes, loops — until it finishes
// (passing the acceptance gate) or exhausts its budget. All infrastructure is injected
// via ctx.ports, so the same loop runs in any runtime. Token cost is uncapped (the user
// vetoed hard caps); MAX_TURNS is the only runaway backstop + a soft cost meter nudges.

import { streamTurn, chatOnce, isGatewayConfigured, type ChatMsg, type ToolSchema } from "./stream-gateway";
import { systemPrompt } from "./system-prompt";
import { FACTORY_TOOLS, SUBAGENT_TOOLS } from "./tools";
import type { BrainEvent, BrainTool, BrainCtx, ReflectionLite, BoundaryEvent, FactoryStage } from "./brain-types";
import type { FactoryPorts } from "./ports";
import { isStopIntent } from "./intent";
import { modelChain, tierForContext } from "./model-router";
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
  verify_chain: "validate",
  propose_boundary_events: "validate",
  generate_test_cases: "sandbox",
  sandbox_run: "sandbox",
  inspect_run: "sandbox",
  finish: "deliver",
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
  parameters: { type: "object", properties: { reasoning: { type: "string", description: "为什么要派子大脑" }, task: { type: "string", description: "交给子大脑的聚焦子任务" } }, required: ["reasoning", "task"], additionalProperties: false },
  async execute(args, ctx) {
    const task = String(args.task ?? "").trim();
    if (!task) return { ok: false, summary: "task 不能为空。" };
    ctx.emit({ t: "subagent.start", task });
    let summary = "";
    try {
      // R9: propagate depth so the spawned sub-brain gets the depth-bounded toolset (it may
      // fan out one more level until MAX_SUBAGENT_DEPTH, then read-only). No explicit `tools`
      // override here — runBrain picks the right set from isSubAgent + depth.
      for await (const ev of runBrain({ domain: ctx.domain, goal: task, ports: ctx.ports, signal: ctx.signal, isSubAgent: true, depth: (ctx.subagentDepth ?? 0) + 1 })) {
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
  const saved =
    opts.conversationId && (await opts.ports.conversation.has(opts.conversationId).catch(() => false))
      ? await opts.ports.conversation.load(opts.conversationId).catch(() => null)
      : null;
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

  const toolSchemas: ToolSchema[] = tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const byName = new Map(tools.map((t) => [t.name, t]));

  // #9 (i18n): the brain's working language — follows FACTORY_BRAIN_LANG, else (auto) the ontology
  // content / the domain id, default zh. On a FRESH run ctx.ontology is null here, so under `auto`
  // it's re-resolved once read_ontology populates the ontology (see the turn loop) and the system
  // prompt refreshed — otherwise a Chinese-content domain with an ASCII slug would resolve to en.
  let lang = resolveBrainLang(opts.domain, ctx.ontology);
  let langFromOntology = !!ctx.ontology;
  const messages: ChatMsg[] = saved
    ? [...(saved.messages as ChatMsg[]), { role: "user", content: opts.goal }]
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
  const PARK_MAX_TICKS = 150; // ~3 min of polling before auto-approving the test cases

  try {
    for (let turn = 0; turn < MAX_TURNS; turn++) {
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

      // TEST-CASE APPROVAL GATE — if the brain proposed test cases, PARK here (poll the
      // mailbox, no LLM turn consumed) until the user clicks 执行/重新生成. The run is in
      // the background, so parking survives navigation — the user can return and decide.
      if (!opts.isSubAgent && ctx.awaitingApproval && opts.conversationId) {
        const human = await opts.ports.conversation.drainHumanMessages(opts.conversationId).catch(() => []);
        let decided: null | { decision: "approve" | "regenerate"; note: string } = null;
        for (const text of human) {
          const m = text.match(/^\[测试用例决策[:：]\s*(执行|approve|重新生成|regenerate)\]\s*([\s\S]*)$/i);
          if (m) decided = { decision: /执行|approve/i.test(m[1]!) ? "approve" : "regenerate", note: (m[2] ?? "").trim() };
          else {
            ctx.humanDirectives.push(text);
            messages.push({ role: "user", content: `[人工介入] ${text}` });
            yield { t: "message", text: `🧑 收到你的介入：「${text}」` };
          }
        }
        if (!decided && parkTicks >= PARK_MAX_TICKS) {
          decided = { decision: "approve", note: "(等待超时，自动确认执行)" };
          yield { t: "message", text: "⏱ 用例确认等待超时——自动按「执行」继续试运行。" };
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
        const human = await opts.ports.conversation.drainHumanMessages(opts.conversationId).catch(() => []);
        let decided: BoundaryEvent[] | null = null;
        for (const text of human) {
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
        if (!decided && parkTicks >= PARK_MAX_TICKS) {
          decided = (ctx.boundaryProposals ?? []).map((p) => ({ event: p.event, kind: p.suggestedKind, consumer: p.consumer, payloadContract: p.payloadContract }));
          yield { t: "message", text: "⏱ 边界事件确认超时——按你的初判处理继续。" };
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
        const human = await opts.ports.conversation.drainHumanMessages(opts.conversationId).catch(() => []);
        let answer: string | null = null;
        for (const text of human) {
          const m = text.match(/^\[澄清回答\]\s*([\s\S]+)$/);
          if (m) answer = m[1]!.trim();
          else { answer = text.trim(); } // any free reply while parked counts as the answer
        }
        if (!answer && parkTicks >= PARK_MAX_TICKS) {
          const rec = ctx.clarifyPrompt?.options?.find((o) => o.recommended);
          answer = rec ? `(等待超时，按你的推荐继续：${rec.label})` : "(等待超时，AI 自行按最佳判断继续)";
          yield { t: "message", text: `⏱ 澄清等待超时——${rec ? `按推荐项「${rec.label}」` : "AI 自行判断"}继续。` };
        }
        if (!answer) {
          parkTicks++;
          await new Promise((r) => setTimeout(r, 1200));
          turn--;
          continue;
        }
        parkTicks = 0;
        const q = ctx.clarifyPrompt?.question ?? ""; // snapshot BEFORE clearing state (idempotent, matches the other gates)
        ctx.awaitingClarify = false;
        ctx.clarifyPrompt = undefined;
        ctx.humanDirectives.push(`澄清「${q}」→ ${answer}`);
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

      // Constrained decoding: ground design/refine schemas to the REAL action + tool names.
      const groundedSchemas = ctx.ontology
        ? injectGroundingEnums(toolSchemas, {
            actionNames: ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name),
            toolNames: ctx.toolCatalog ?? [],
          })
        : toolSchemas;

      // #7: route this turn's model by difficulty (fast while reading/planning, hard once
      // designing/coding) through a config-driven fallback chain; annotate which model served it.
      const tier = tierForContext(ctx);
      let pendingCalls: { id: string; name: string; args: string }[] | null = null;
      let assistantContent = "";
      for await (const ev of streamTurn(messages, groundedSchemas, { signal: opts.signal, models: modelChain(tier) })) {
        if (ev.t === "think") yield { t: "think", delta: ev.delta };
        else if (ev.t === "model") yield { t: "model", model: ev.model, tier, turn: turn + 1 };
        else if (ev.t === "usage") ctx.spent.tokens += ev.promptTokens + ev.completionTokens;
        else if (ev.t === "tool_calls") {
          pendingCalls = ev.calls;
          assistantContent = ev.content;
        } else if (ev.t === "done") assistantContent = ev.content;
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
        if (!opts.isSubAgent && !finishedOk && ctx.ontology && ctx.specs.length > 0) {
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
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.args || "{}");
        } catch {
          args = {};
        }
        const reasoning = typeof args.reasoning === "string" ? args.reasoning : "";
        yield { t: "tool.call", id: call.id, name: call.name, reasoning, input: args };

        // Explicit stage signal: light the canvas rail as the brain ENTERS this stage, before
        // the (possibly long) tool runs, so the active-stage highlight tracks the live work.
        const stage = STAGE_OF_TOOL[call.name];
        if (stage) yield { t: "stage", stage, status: "active" };

        const tool = byName.get(call.name);
        let result;
        if (!tool) result = { ok: false, summary: `未知工具 ${call.name}` };
        else {
          try {
            result = await tool.execute(args, ctx);
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
        yield { t: "tool.result", id: call.id, name: call.name, ok: result.ok, summary: result.summary, output: outForUi };

        // Settle the stage once its tool returns. For `finish` only a PASSED gate (result.ok)
        // is a real 交付; a refused finish stays "error" so the rail never falsely shows shipped.
        if (stage) yield { t: "stage", stage, status: result.ok ? "ok" : "error" };

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
          } else {
            finishRefusals += 1;
            if (finishRefusals >= 4) {
              messages.push({ role: "system", content: `[诚实收尾] 验收门已拒绝 ${finishRefusals} 次。若反复跑不通，多半是数据/环境/本体限制——别硬试，调 analyze_failure 诚实收尾。` });
              yield { t: "message", text: `⚠ 验收门已拒绝 ${finishRefusals} 次——若确实跑不通，请 analyze_failure 诚实收尾。` };
            }
          }
        }
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
    if (opts.conversationId) {
      await opts.ports.conversation
        .save(opts.conversationId, { domain: opts.domain, messages: messages as unknown[], ctx: serializeCtx(ctx) })
        .catch(() => {});
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
  yield { t: "done", tokensUsed: ctx.spent.tokens, turns: ctx.spent.turns, status };
}
