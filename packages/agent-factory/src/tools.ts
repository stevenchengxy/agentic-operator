// The brain's tool/action space — the deterministic capabilities the autonomous loop
// orchestrates. Re-implemented for the new arch on ctx.ports + the ported foundation
// (graph / contract / codegen / tool-catalog). No Prisma, no Inngest, no Neo4j.
//
// Wave A: enriched read_ontology (event-flow digest + is_rule_check + suggested_tools
// + reusable_skills) and design_agent (tool grounding + rule-check floor + auto code
// render + hallucination/rule-leak warnings), plus the full tool set the OLD harness
// had: codegen_agent, refine_agent (w/ score delta), score_spec, read_spec, inspect_run,
// verify_chain, review_agent, diff_spec, revert_refine, list_domains, describe_domain,
// web_search, create_skill, use_skill, analyze_failure, finish.

import type { BrainTool, BrainCtx, BuildPlan, ScoreDims, RefineAttempt, BoundaryProposal } from "./brain-types";
import type { GeneratedAgentSpec, IoField, PlanStep } from "./spec-types";
import type { OntologyAction, DomainOntology } from "./ontology-types";
import { compileGraph, verifyGraph, coverageGap } from "./graph";
import { acceptanceGate } from "./acceptance";
import { parsePlan, validatePlan } from "./plan-projection";
import { deriveContractGraph, contractIssueStringsBySeverity, contractAgentIssueMap } from "./contract";
import { evaluateExecutionFidelity, expectedFieldsByEvent } from "./execution-fidelity";
import { attributeFidelityFailures, attributionSummary } from "./failure-attribution";
import { supervisorAudit, reconcileDefects, blockingDefects, supervisorSummary } from "./supervisor";
import { proposeOntologyRevisions, revisionSummary } from "./ontology-revision";
import { resolveCapabilityLadder } from "./capability-ladder";
import { parseStrategyPlan, describeStrategyPlan, selectStrategy, estimateDifficulty, classifyIntentKind, STRATEGY_DESC, type StrategyContext } from "./reasoning-policy";
import { deriveBusinessFlow } from "./business-flow";
import { shouldSuggestSplit } from "./reasoning-policy";
import { buildToolCatalog, suggestToolsForAction, rankRealTools, groundToolPicks, ungroundedEventTokens, searchRealTools } from "./tool-catalog";
import { specToAgentCode, validateAgentCode, probeAgentModule } from "./codegen";
import { lintGeneratedToolCode } from "./code-lint";
import { safeFetch } from "./egress-guard";
import { generate_test_cases, proposeTestCases } from "./test-cases";
import { runSpecialists, buildOntologySpecialistTasks, synthesizeUnderstanding } from "./specialists";
import { runInlineAnalysis } from "./inline-codeact";
import { designSelfCheck, internalDesignRefine, innerLoopEnabled, isSideEffectfulTool } from "./design-loop";
import { chatJson, isGatewayConfigured } from "./stream-gateway";
import { modelChain } from "./model-router";

// ── helpers ───────────────────────────────────────────────────────────────────
function params(props: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
  return {
    type: "object",
    properties: { reasoning: { type: "string", description: "动手前用一句话说清你为什么这么做。" }, ...props },
    required: ["reasoning", ...required],
    additionalProperties: false,
  };
}
const kebab = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[_\s]+/g, "-").toLowerCase();
const pascal = (s: string) => s.replace(/(^|[-_\s])([a-z])/g, (_, __, c) => c.toUpperCase()).replace(/[-_\s]/g, "");
const domainPrefix = (d: string) => kebab(d).replace(/-v\d+$/, "").slice(0, 12) || "dom";

function parseIoSchema(raw: unknown): IoField[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({ field: String(f.field ?? ""), type: String(f.type ?? "String"), description: f.description ? String(f.description) : undefined, source: f.source ? String(f.source) : undefined }))
    .filter((f) => f.field);
}

/** Canonical payload fields for a set of events, read from the ontology's typed
 *  event_data — the AUTHORITATIVE contract (NOT the AI's guess). R1: agent I/O,
 *  the contract graph, and test-case payloads all ground in these. */
function eventFieldsOf(eventNames: string[], ont: DomainOntology | null): IoField[] {
  if (!ont) return [];
  const byName = new Map(ont.events.map((e) => [e.name, e]));
  const out: IoField[] = [];
  const seen = new Set<string>();
  for (const ev of eventNames) {
    for (const f of byName.get(ev)?.payload?.event_data ?? []) {
      if (!f?.name || seen.has(f.name)) continue;
      seen.add(f.name);
      out.push({ field: f.name, type: f.type || "unknown", source: f.target_object ? `${f.target_object}.${f.name}` : undefined, description: `事件 ${ev} 的 payload 字段` });
    }
  }
  return out;
}

/** Ground AI-authored I/O on the canonical event_data: canonical fields are the base
 *  (always present), the AI may enrich a field's description or add an extension field. */
function mergeFields(ai: IoField[], canonical: IoField[]): IoField[] {
  const out = new Map<string, IoField>();
  for (const f of canonical) out.set(f.field, f);
  for (const f of ai) {
    const base = out.get(f.field);
    out.set(f.field, base ? { ...base, description: f.description || base.description } : f);
  }
  return [...out.values()];
}

/** The canonical event payload contract per event, for contract reconciliation. */
function canonicalEventFields(ont: DomainOntology | null): Map<string, IoField[]> | undefined {
  if (!ont) return undefined;
  return new Map(ont.events.map((e) => [e.name, (e.payload?.event_data ?? []).map((f) => ({ field: f.name, type: f.type || "unknown", source: f.target_object ?? undefined }))]));
}

/** R5: per-DataObject read/write intent for an action, grounded in the ontology — reads from the
 *  trigger events' event_data (fields sourced from that object), writes from the emit events'
 *  state_mutations (impacted_properties). Spans target_objects ∪ any object touched by I/O. */
function deriveStateBindings(action: OntologyAction, ont: DomainOntology | null): Array<{ object: string; reads: string[]; writes: string[] }> {
  if (!ont) return [];
  const byEvent = new Map(ont.events.map((e) => [e.name, e]));
  const reads = new Map<string, Set<string>>();
  const writes = new Map<string, Set<string>>();
  const add = (m: Map<string, Set<string>>, obj: string, field: string) => { if (!obj) return; (m.get(obj) ?? m.set(obj, new Set()).get(obj)!).add(field); };
  for (const t of action.trigger ?? []) for (const f of byEvent.get(t)?.payload?.event_data ?? []) if (f.target_object) add(reads, f.target_object, f.name);
  for (const e of action.triggered_event ?? []) for (const m of byEvent.get(e)?.payload?.state_mutations ?? []) for (const p of m.impacted_properties ?? []) add(writes, m.target_object, p);
  const objs = new Set<string>([...(action.target_objects ?? []), ...reads.keys(), ...writes.keys()]);
  return [...objs].map((o) => ({ object: o, reads: [...(reads.get(o) ?? [])], writes: [...(writes.get(o) ?? [])] }));
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
/** #AUDIT-FIX(P2-03) — 本体【内容】哈希（不止数量）：规则文本/event_data 字段/trigger·emit/
 *  对象属性变了但总数没变时，旧的"数量签名"会漏判漂移。折进 read_ontology 的 drift 签名与沙箱
 *  证据指纹，等量换血也能被识破、陈旧沙箱绿证会因本体变化自动失效。 */
export function ontologyContentHash(ont: { actions?: unknown[]; events?: unknown[]; rules?: unknown[]; objects?: unknown[] } | null | undefined): string {
  if (!ont) return "0";
  const norm = (arr: unknown[] | undefined) => (arr ?? []).map((x) => JSON.stringify(x)).sort().join("\u0001");
  return djb2([norm(ont.actions), norm(ont.events), norm(ont.rules), norm(ont.objects)].join("\u0002"));
}

/** Fingerprint tying sandbox evidence to the exact specs (incl. code) that ran. */
export function specsFingerprint(specs: GeneratedAgentSpec[]): string {
  return specs
    .map((s) => `${s.slug}|${(s.trigger ?? []).join(",")}|${(s.emit ?? []).join(",")}|${(s.tools ?? []).join(",")}|${s.codeSource ?? ""}|${djb2(s.generatedCode ?? "")}`)
    .sort()
    .join(";");
}

const RULE_GATE_RE = /rule.?check|校验|审核|风控|合规|查重|去重|dedup|\block\b|黑名单|blacklist/i;
function looksLikeRuleGate(action: { name: string; description?: string; category?: string }): boolean {
  // #9c: prefer the ontology-native `category` signal (domain-agnostic, straight from the
  // ontology) over name/description regex — the regex stays only as a fallback for ontologies that
  // don't categorize. Avoids hardcoding a fixed set of rule-gate name patterns per domain.
  if (action.category && /rule|check|gate|guard|校验|审核|风控|合规/i.test(action.category)) return true;
  return RULE_GATE_RE.test(action.name) || RULE_GATE_RE.test(action.description ?? "");
}
function specIsRuleGate(s: GeneratedAgentSpec): boolean {
  return s.tools.includes("ontology.fetchActionRules") || RULE_GATE_RE.test(s.actionName);
}

// #9 (de-hardcode): the distinctive identifiers of THIS domain's rules (ids / names / codes),
// pulled from the live ontology — NOT a fixed Chinese keyword list (冷冻期/竞对/…) or RAAS's
// `\d-\d` rule-id scheme. Used to detect when a NON-gate agent's prompt embeds a specific business
// rule (which should only live behind a rule gate that fetches rules at runtime).
function ruleIdentifiers(ctx: BrainCtx): string[] {
  const ids = new Set<string>();
  for (const r of ctx.ontology?.rules ?? []) {
    const ro = r as Record<string, unknown>;
    // Collect the distinctive human-readable rule names + logic text + ids — ANY string field whose
    // KEY looks rule-ish (businessLogicRuleName / standardizedLogicRule / ruleSource / name / title /
    // id / code …). A fixed 5-key allowlist missed RAAS's real `businessLogicRuleName`, so the check
    // was dead on the very domain it was derived from. Length ≥ 4 drops collision-prone short codes.
    for (const [k, v] of Object.entries(ro)) {
      if (typeof v === "string" && v.trim().length >= 4 && /rule|name|title|code|^id$|logic|policy|规则|条款/i.test(k)) {
        ids.add(v.trim());
      }
    }
  }
  return [...ids];
}
/** #B (design-time rule grounding): the business rules relevant to ONE Agent action. Two signals,
 *  domain-agnostic: (1) id-prefix — rules whose id starts with the action's id (the RAAS/Allmeta
 *  hierarchy scheme), (2) text match — a rule whose text mentions the action name or a target
 *  object. Union, ranked, top-K. Surfaced in read_ontology so design_agent reasons rule-grounded. */
function rulesForAction(action: OntologyAction, rules: Array<Record<string, unknown>>): Array<{ id: string; name: string; summary: string }> {
  const tokens = [action.name, ...(action.target_objects ?? [])].map((t) => String(t).toLowerCase()).filter((t) => t.length >= 2);
  const scored = rules
    .map((r) => {
      const id = String(r.id ?? "");
      let score = 0;
      if (id && action.id && id.startsWith(`${action.id}-`)) score += 10; // authoritative hierarchy match
      const hay = Object.values(r).filter((v) => typeof v === "string").join(" ").toLowerCase();
      for (const t of tokens) if (hay.includes(t)) score += 1;
      return { r, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
  return scored.map(({ r }) => ({
    id: String(r.id ?? ""),
    name: String(r.businessLogicRuleName ?? r.name ?? r.title ?? r.id ?? ""),
    summary: String(r.standardizedLogicRule ?? r.description ?? r.businessLogicRuleName ?? "").slice(0, 220),
  }));
}

/** Does a prompt hardcode a specific ontology rule (by its name/identifier)? Domain-agnostic.
 *  Boundary-matched so a short id like "2-1" doesn't substring-collide inside "2-10" / "step 2-1". */
function promptEmbedsRule(promptText: string, ruleIds: string[]): boolean {
  return ruleIds.some((id) => {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    try {
      return new RegExp(`(?<![\\w-])${esc}(?![\\w-])`).test(promptText);
    } catch {
      return promptText.includes(id);
    }
  });
}

/** Score one spec across 4 orthogonal dimensions (each 0-100). */
function scoreSpec(spec: GeneratedAgentSpec, refineCount: number): ScoreDims {
  const requested = spec.tools.length + (spec.unresolvedTools?.length ?? 0);
  const toolResolution = requested === 0 ? 100 : Math.round((spec.tools.length / requested) * 100);
  const len = (spec.systemPrompt ?? "").trim().length;
  let promptRichness = spec.promptSource === "fallback" ? 35 : Math.min(100, 45 + Math.round(len / 18));
  if (spec.promptSource === "llm") promptRichness = Math.min(100, promptRichness + 5);
  const emits = spec.emit ?? [];
  let decisionCoverage: number;
  if (emits.length <= 1) decisionCoverage = 100;
  else {
    const text = `${spec.systemPrompt ?? ""} ${spec.decisionLogic ?? ""}`;
    const covered = emits.filter((e) => text.includes(e)).length;
    decisionCoverage = Math.round((covered / emits.length) * 100);
  }
  const refineHealth = refineCount === 0 ? 80 : refineCount <= 2 ? 100 : Math.max(40, 100 - (refineCount - 2) * 20);
  return { toolResolution, promptRichness, decisionCoverage, refineHealth };
}
const scoreTotal = (d: ScoreDims) => Math.round((d.toolResolution + d.promptRichness + d.decisionCoverage + d.refineHealth) / 4);
const grade = (t: number) => (t >= 85 ? "A" : t >= 70 ? "B" : t >= 55 ? "C" : "D");

function buildSpec(
  action: OntologyAction,
  domain: string,
  authored: { systemPrompt: string; tools: string[]; decisionLogic: string; reasoning: string; toolRationale: string },
  inputSchema: IoField[],
  outputSchema: IoField[],
): GeneratedAgentSpec {
  const isHuman = action.actor.includes("Human");
  const nameZh = (action.description ?? "").trim().split(/[。\n.]/)[0]?.slice(0, 18) || action.name;
  return {
    key: action.name,
    actionName: action.name,
    slug: `${domainPrefix(domain)}-${kebab(action.name)}`,
    short: `${pascal(action.name)}Agent`,
    domainId: domain,
    nameZh,
    kind: isHuman ? "simulated-human" : "llm",
    trigger: action.trigger ?? [],
    emit: action.triggered_event ?? [],
    tools: authored.tools,
    unresolvedTools: [],
    objects: action.target_objects ?? [],
    systemPrompt: authored.systemPrompt,
    userPrompt: action.user_prompt ?? "",
    designReasoning: authored.reasoning,
    toolRationale: authored.toolRationale,
    decisionLogic: authored.decisionLogic,
    steps: authored.tools.map((t, i) => ({ name: `step_${i + 1}`, description: `调用 ${t}`, tool: t })),
    ruleRefs: [],
    retries: 3,
    hitl: isHuman,
    confidence: 0.8,
    promptSource: "llm",
    inputSchema,
    outputSchema,
  };
}

const cardOf = (s: GeneratedAgentSpec) => ({ slug: s.slug, actionName: s.actionName, short: s.short, nameZh: s.nameZh, trigger: s.trigger, emit: s.emit, tools: s.tools, unresolved: s.unresolvedTools, isSubAgent: s.isSubAgent === true });
const designOf = (s: GeneratedAgentSpec) => ({ reasoning: s.designReasoning ?? "", systemPrompt: s.systemPrompt, toolRationale: s.toolRationale ?? "", decisionLogic: s.decisionLogic ?? "", code: s.generatedCode, codeSource: s.codeSource, codeExecuted: s.codeExecuted ?? false, probeReason: s.probeReason });

/** Render the spec's reference .ts AND grade whether it can truly EXECUTE (CodeAct) in the sandbox:
 *  the rendered code must COMPILE (TS) and pass the security lint (no child_process/fs/net/eval).
 *  When it does, codeExecuted=true → the runtime runs the generated handler (with automatic
 *  declarative fallback if runGeneratedCode returns null), so "generated code" actually executes
 *  instead of being a dead scaffold. When it fails either check, the agent stays declarative. */
async function renderExecutableCode(spec: GeneratedAgentSpec): Promise<void> {
  spec.generatedCode = specToAgentCode(spec);
  const code = spec.generatedCode ?? "";
  try {
    // #REDESIGN FU3 — reviewLoop stages: (1) COMPILE (real tsc), (2) LINT (AST security), (3) PROBE
    // (loads + exposes a callable handler). Only code that clears all three is graded truly executable
    // (CodeAct) — a compile-only pass used to let "compiles but no runnable handler" claim execution.
    const v = await validateAgentCode(code);
    const compileLintOk = v.ok && lintGeneratedToolCode(code).ok;
    if (compileLintOk) {
      const probe = await probeAgentModule(code);
      spec.codeExecuted = probe.loads;
      spec.probeReason = probe.loads ? undefined : probe.reason;
    } else {
      spec.codeExecuted = false;
    }
  } catch {
    spec.codeExecuted = false;
  }
}

/** The dynamic rule-fetch instruction floored onto rule-check agents. */
const RULE_FETCH_INSTRUCTION =
  "\n\n【规则动态抓取机制（系统强制补全，运行时执行）】\n① 从触发事件 payload 识别本次要校验的对象与上下文；② 绑定并调用 ontology.fetchActionRules 按【当前 action + 上下文】实时抓取适用规则（绝不把规则写进本 prompt）；③ 逐条核对，命中任一强制(mandatory)规则即发失败事件并落库；④ 数据不足时 fail-close 保守拦截。";

// ── tools ───────────────────────────────────────────────────────────────────

const read_ontology: BrainTool = {
  name: "read_ontology",
  description:
    "读业务域本体：对象(DataObjects 属性)、动作(actor/trigger/triggered_event/description/inputs/outputs/is_rule_check/suggested_tools)、事件【含 payload 字段(event_data，权威 I/O 契约)+ state_mutations】、规则、事件流摘要(入口/终态/链路/闸口)、可复用技能库。这是你设计 agent 的事实地基——事件名/动作名/字段名/工具名都以这里为准，input_schema/output_schema 直接以事件的 payload 字段为准，不要脑补。",
  parameters: params({}),
  async execute(_args, ctx) {
    let ont: DomainOntology;
    try {
      ont = await ctx.ports.ontology.fetchOntology(ctx.domain);
    } catch (e) {
      // #NATIVE — 未命中【不写死话术、不写死分支】：把事实摆全（哪个域、底层错误、当前各来源
      // 合并后的可用域清单、平台支持上传本体 JSON 建新域），怎么向用户解释/引导由你推理决定。
      // 查找链路本身是分层的：租户上传的本体优先 → 本地 models/ → live Allmeta（错误文本里通常
      // 带来源信息）。唯一的硬约束：别编造本体、别不告知就擅自换域。
      const domains = await ctx.ports.ontology.listDomains().catch(() => [] as Array<{ id: string; name?: string }>);
      const list = domains.slice(0, 40).map((d) => (d.name && d.name !== d.id ? `${d.id}(${d.name})` : d.id));
      return {
        ok: false,
        summary:
          `读不到域「${ctx.domain}」的本体。事实：底层错误=「${String((e as Error).message ?? e).slice(0, 180)}」；` +
          `当前可用域(${domains.length} 个)=${list.join("、") || "（任何来源都没有可用域）"}；` +
          `平台支持用户上传 actions/events/dataObjects/rules 的 JSON 文件创建新的业务域（聊天框 📎 上传即可，租户内立即可用）。` +
          `基于这些事实自行判断并回应用户——别编造本体，也别不打招呼就换域。`,
        output: {
          requestedDomain: ctx.domain,
          error: String((e as Error).message ?? e).slice(0, 300),
          availableDomains: domains.map((d) => ({ id: d.id, name: d.name })),
          canUploadOntologyJson: true,
        },
      };
    }
    // #4: pin a signature on first read; flag drift on a re-read (the live Allmeta graph changed
    // under already-built specs) so the brain doesn't silently work against swapped ground truth.
    // #AUDIT-FIX(P2-03) — 数量 + 内容哈希：等量换血（改规则文本/字段但总数不变）也判为漂移。
    const sig = `${ont.actions.length}/${ont.events.length}/${ont.objects.length}/${ont.rules.length}#${ontologyContentHash(ont)}`;
    const drift = ctx.ontologySig && ctx.ontologySig !== sig ? `⚠ 本体自上次读取已变化（${ctx.ontologySig}→${sig}）：已设计的 specs 是基于旧本体的，请核对一致性。` : "";
    // #AUDIT-FIX(P2-04) — 严格源退化明示：本体是 Allmeta 失败后的薄 artifact（可能缺 events/objects/rules），
    // 告知 AI 别据此当完整本体设计/发布；需要完整本体时提示用户修复 Allmeta 连接或上传本体。
    const degradedNote = (ont as { degraded?: { from: string; reason: string } }).degraded
      ? `⚠ 本体为【退化源】：严格源 ${(ont as { degraded: { from: string } }).degraded.from} 读取失败，当前是本地薄 artifact，可能缺事件/对象/规则明细（原因：${(ont as { degraded: { reason: string } }).degraded.reason}）。据此设计要谨慎，别当完整本体；需要完整本体请修复严格源连接或让用户上传本体。`
      : "";
    ctx.ontologySig = sig;
    ctx.ontology = ont;
    // catalog = ontology tool_use ∪ any AI-authored persisted tools (Tool-Smith)
    const persistedTools = ctx.ports.tools ? await ctx.ports.tools.list(ctx.domain).catch(() => []) : [];
    // #C: load the REAL global tool registry so design_agent can be recommended real tools by
    // semantic rank (parseResume action → parseResumeApi) even when the ontology declared none.
    const realTools = ctx.ports.toolRegistry ? await ctx.ports.toolRegistry.list().catch(() => []) : [];
    ctx.realTools = realTools;
    ctx.toolCatalog = [...new Set([...buildToolCatalog(ont), ...persistedTools.map((t) => t.name), ...realTools.map((t) => t.name)])];
    const agentActions = ont.actions.filter((a) => a.actor.includes("Agent"));
    // #B (design-time rule grounding): map each Agent action → its relevant business rules, so
    // design_agent reasons rule-grounded (runtime fetchActionRules still enforces at exec time).
    const ruleRows = (ont.rules ?? []) as Array<Record<string, unknown>>;
    ctx.rulesByAction = Object.fromEntries(agentActions.map((a) => [a.name, rulesForAction(a, ruleRows)]));
    // event-flow digest
    const graph = compileGraph(ont.actions, { domainId: ctx.domain });
    const skills = ctx.ports.skills ? await ctx.ports.skills.list(ctx.domain).catch(() => []) : [];
    ctx.emit({ t: "catalog", domain: ctx.domain, actions: ont.actions.length, events: ont.events.length, agentActions: agentActions.length });
    return {
      ok: true,
      summary: `${degradedNote ? degradedNote + " " : ""}${drift ? drift + " " : ""}本体已读：${ont.actions.length} 动作（${agentActions.length} 个要造 agent）· ${ont.events.length} 事件 · ${ont.objects.length} 对象 · ${ont.rules.length} 规则 · 工具库 ${ctx.toolCatalog.length} 个 · 技能库 ${skills.length} 个（source=${ont.source}）· 下一步先 understand_ontology 把本体读懂消化（别读了就忘）`,
      output: {
        domain: ctx.domain,
        agentActions: agentActions.map((a) => ({
          name: a.name,
          description: a.description,
          trigger: a.trigger,
          triggered_event: a.triggered_event,
          target_objects: a.target_objects,
          inputs: a.inputs,
          outputs: a.outputs,
          is_rule_check: looksLikeRuleGate(a),
          // #C: ontology-declared tools FIRST, then top semantically-ranked REAL tools.
          suggested_tools: suggestToolsForAction(a, realTools),
          // #C: for each ranked real tool, what config the FDE must supply (api_key_env, subdir…) —
          // so the brain can ask_user for the right integration instead of silently mocking.
          tool_hints: rankRealTools(a, realTools).map((name) => { const rt = realTools.find((t) => t.name === name); return { name, summary: rt?.summary, configKeys: rt?.configKeys ?? [] }; }),
          // R3: forward the action's preconditions so design_agent compiles them into the prompt.
          submission_criteria: a.submission_criteria,
          side_effects: a.side_effects,
          // #B: the business rules relevant to THIS action — design_agent grounds the rule-gate
          // prompt on these (still fetched dynamically at runtime, never hardcoded into the prompt).
          relevant_rules: ctx.rulesByAction?.[a.name] ?? [],
        })),
        data_objects: ont.objects.map((o) => ({ id: o.id, name: o.name, primary_key: o.primary_key, properties: o.properties })),
        events: ont.events.map((e) => ({
          name: e.name,
          // R1: the authoritative payload contract — agents/test-cases ground on these, not guesses.
          payload_fields: (e.payload?.event_data ?? []).map((f) => ({ name: f.name, type: f.type, source_object: f.target_object })),
          state_mutations: e.payload?.state_mutations ?? [],
        })),
        event_flow: { entryEvents: graph.entryEvents, terminalEvents: graph.terminalEvents, branchActions: graph.branchActions, hitlActions: graph.hitlActions },
        available_tools: ctx.toolCatalog,
        reusable_skills: skills.map((s) => ({ slug: s.slug, name: s.name, purpose: s.purpose, useCount: s.useCount })),
      },
    };
  },
};

const create_plan: BrainTool = {
  name: "create_plan",
  description: "提交 BuildPlan：按事件链排序，每个 agent 的职责/触发/产出/候选工具/边界情况 + 跨 agent 注意点。会自检计划 vs 本体（未知动作、漏掉的 Agent 动作、未知工具）。设计前规划一次，发现计划错了可再调（version+1）。",
  parameters: params(
    {
      summary: { type: "string" },
      agents: { type: "array", items: { type: "object", properties: { actionName: { type: "string" }, role: { type: "string" }, triggerEvents: { type: "array", items: { type: "string" } }, emitEvents: { type: "array", items: { type: "string" } }, toolCandidates: { type: "array", items: { type: "string" } }, edgeCases: { type: "array", items: { type: "string" } } }, required: ["actionName", "role"] } },
      notes: { type: "array", items: { type: "string" } },
    },
    ["summary", "agents"],
  ),
  async execute(args, ctx) {
    const version = (ctx.currentPlan?.version ?? 0) + 1;
    const plan: BuildPlan = {
      summary: String(args.summary ?? ""),
      agents: Array.isArray(args.agents) ? (args.agents as Array<Record<string, unknown>>).map((a) => ({ actionName: String(a.actionName ?? ""), role: String(a.role ?? ""), triggerEvents: (a.triggerEvents as string[]) ?? [], emitEvents: (a.emitEvents as string[]) ?? [], toolCandidates: (a.toolCandidates as string[]) ?? [], edgeCases: (a.edgeCases as string[]) ?? [] })) : [],
      notes: (args.notes as string[]) ?? [],
      version,
    };
    ctx.currentPlan = plan;
    ctx.emit({ t: "plan", plan });
    // self-validate vs ontology
    const warns: string[] = [];
    if (ctx.ontology) {
      const known = new Set(ctx.ontology.actions.map((a) => a.name));
      const agentActions = ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name);
      const planned = new Set(plan.agents.map((a) => a.actionName));
      const unknown = plan.agents.map((a) => a.actionName).filter((n) => !known.has(n));
      const missed = agentActions.filter((n) => !planned.has(n));
      if (unknown.length) warns.push(`计划里有本体没有的动作：${unknown.join("、")}`);
      if (missed.length) warns.push(`还没规划的 Agent 动作：${missed.join("、")}`);
    }
    return { ok: true, summary: `BuildPlan v${version}（${plan.agents.length} agent）${warns.length ? " · ⚠ " + warns.join("；") : ""} · 设计前建议 critique_plan 让 AI 独立挑战这份分解`, output: { version, warnings: warns } };
  },
};

// understand_ontology — an EXPLICIT, AI-synthesized comprehension gate. After read_ontology dumps
// the raw graph, this makes the brain DIGEST it into a structured model (what to build, the event
// chain, rule gates, external handoffs, ambiguities to clarify) — real LLM reasoning, not a
// deterministic fold — so the design phase reasons over an understood model instead of "读了就忘",
// and the user can SEE that the AI understood + remembered. Answers 「我怎么知道 AI 分析好了并记住了」.
const understand_ontology: BrainTool = {
  name: "understand_ontology",
  description:
    "读完 read_ontology 后【先做一次显式理解+消化】再规划/设计：让 AI 把本体读懂的结论结构化输出——要造哪些 agent 及其职责、事件链怎么串、哪些是规则闸口、哪些产出是交给外部平台消费的「外部交接终态」、哪里有歧义/缺字段需要先 ask_user。结论会被记住贯穿后续设计。这是把『隐式读懂』变成『可见且被记住的理解』，create_plan 前调它。",
  parameters: params({ focus: { type: "string", description: "（可选）想重点理解的子问题" }, deep: { type: "boolean", description: "（可选）四维分治深读（objects/rules/actions/events 各派一位认知专家并行汇总）。是否深读由你判断：域大（规则多/对象多/动作多）、歧义重、或首次接触该域时建议 true；小域单跳即可" } }),
  async execute(args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    const ont = ctx.ontology;
    const agentActions = ont.actions.filter((a) => a.actor.includes("Agent"));
    const graph = compileGraph(ont.actions, { domainId: ctx.domain });
    // A structural skeleton always available — the deterministic floor under the LLM analysis, so
    // understand_ontology NEVER hard-fails (an LLM hiccup degrades to this rather than returning a
    // useless error that the brain then skips past).
    const skel = { domain: ctx.domain, agentsToBuild: agentActions.map((a) => a.name), eventChain: `入口 ${graph.entryEvents.join("、") || "—"} → 终态 ${graph.terminalEvents.join("、") || "—"}`, ruleGates: agentActions.filter((a) => looksLikeRuleGate(a)).map((a) => a.name), externalHandoffs: [] as unknown[], ambiguities: [] as string[], risks: [] as string[] };
    const useSkeleton = (note: string) => {
      ctx.ontologyUnderstanding = JSON.stringify(skel);
      ctx.emit({ t: "reflect", kind: "understanding", lesson: `本体理解（确定性骨架 · ${note}）：要造 ${skel.agentsToBuild.length} 个 agent；规则闸 ${skel.ruleGates.join("、") || "无"}；${skel.eventChain}。` });
      return { ok: true, summary: `已结构化理解本体（确定性骨架 · ${note}）：${skel.agentsToBuild.length} 个 agent，${skel.ruleGates.length} 个规则闸。`, output: skel };
    };
    if (!isGatewayConfigured()) return useSkeleton("未配网关");

    // ── v2 DEEP path：四维分治（认知专家轻通道，见 specialists.ts / 架构书 §4.5）──────────
    // 单跳消化大本体必然稀释（262 条规则在 v1 digest 里只剩 12 个名字）；超过阈值时按维度
    // fan out 四位专家（各拿本维度全量 + 全域概况），再由合成者 reduce 成整体理解。
    // 专家过半失败 → 诚实降级回 v1 单跳；再失败 → 确定性骨架。永不硬失败。
    // #NATIVE — 深读与否是【你的】决策（deep 参数），不再由本体规模阈值或 policy 确定性强制。
    // 规模事实会在结果里给你（后面 scaleHint）；policy/经验回喂的建议经 [推理路线] 消息呈给你参考。
    const deep = args.deep === true;
    if (deep) ctx.emit({ t: "message", text: "🧠 深读分治启动：对象/规则/动作/事件 4 位认知专家并行分析中（大本体通常需要 1~3 分钟；期间每 ~15s 有心跳回执，不是卡住）。" });
    const large = ont.rules.length > 60 || ont.objects.length > 20 || ont.actions.length > 8;
    const scaleHint = !deep && large ? `（规模提示：${ont.rules.length} 规则/${ont.objects.length} 对象/${ont.actions.length} 动作——如需更稳的理解可再调 understand_ontology(deep=true) 四维分治）` : "";
    if (deep) {
      ctx.emit({ t: "message", text: `🧠 本体较大（${ont.actions.length} 动作 · ${ont.rules.length} 规则 · ${ont.objects.length} 对象）——派 4 位认知专家按维度并行深读…` });
      const results = await runSpecialists(ctx, buildOntologySpecialistTasks(ont));
      const okCount = results.filter((r) => r.ok).length;
      if (okCount >= 2) {
        const understanding = await synthesizeUnderstanding(results, ont);
        if (understanding) {
          ctx.ontologyUnderstanding = understanding.slice(0, 4000);
          const ambig: string[] = [];
          for (const r of results) {
            if (r.ok && r.output && typeof r.output === "object") {
              const a = (r.output as Record<string, unknown>).ambiguities;
              if (Array.isArray(a)) ambig.push(...(a as unknown[]).map(String));
            }
          }
          ctx.emit({ t: "reflect", kind: "understanding", lesson: `本体理解（四维分治 · ${okCount}/4 专家）：${understanding.slice(0, 260)}${understanding.length > 260 ? "…" : ""}` });
          return {
            ok: true,
            summary: `已完成四维分治深读（${okCount}/4 专家成功，理解已记住贯穿全程）${ambig.length ? `；专家共标出 ${ambig.length} 处歧义，建议挑最关键的先 ask_user：${ambig.slice(0, 2).join("；")}` : "；无明显歧义，可 create_plan"}`,
            output: { mode: "deep", understanding, specialists: results.map((r) => ({ role: r.role, ok: r.ok, summary: r.summary })), ambiguities: ambig.slice(0, 20) },
          };
        }
      }
      ctx.emit({ t: "reflect", kind: "understanding", lesson: `四维分治未成（${okCount}/4 专家成功）——降级为单跳理解。` });
    }

    const digest = [
      `业务域：${ctx.domain}`,
      `要造 agent 的动作（actor=Agent，共 ${agentActions.length}）：\n${agentActions.map((a) => `· ${a.name}：${(a.description || "").slice(0, 110)} | 触发 ${a.trigger.join(",") || "—"} → 产出 ${a.triggered_event.join(",") || "—"}${looksLikeRuleGate(a) ? " [疑似规则闸]" : ""}`).join("\n")}`,
      `事件流：入口 ${graph.entryEvents.join("、") || "—"} · 终态 ${graph.terminalEvents.join("、") || "—"} · 分支 ${graph.branchActions.join("、") || "—"}`,
      `对象：${ont.objects.map((o) => o.name).join("、") || "—"}`,
      `规则（${ont.rules.length}）：${(ont.rules as Array<Record<string, unknown>>).slice(0, 12).map((r) => String(r.name ?? r.id ?? "")).join("、") || "—"}`,
      args.focus ? `重点：${String(args.focus)}` : "",
    ].filter(Boolean).join("\n\n");
    const sys =
      "你是 agent 工厂的【本体分析师】。把这份业务域本体读懂、消化，输出结构化理解，供后续设计直接引用。只输出 JSON：" +
      '{"agentsToBuild":[{"action":string,"responsibility":string}],"eventChain":string(按事件把链路顺序讲清),"ruleGates":[string],"externalHandoffs":[{"event":string,"why":string}],"ambiguities":[string],"risks":[string]}。externalHandoffs=产出交给外部平台消费、算合法终态的事件；ambiguities=本体里不清楚/缺字段/需要用户补充的地方。不要任何其它文字。';
    // #JSON-FIX — was: greedy regex + maxTokens:1500. A 6-agent Chinese digest ≈1 token/char blew
    // the cap mid-JSON EVERY run → unbalanced slice → JSON.parse threw → deterministic skeleton
    // fallback («每次都这样»). chatJson = balanced extraction + truncation-aware bigger retry.
    const parsed = await chatJson<Record<string, unknown>>(sys, digest, { temperature: 0.3, maxTokens: 4000, signal: ctx.signal, models: modelChain("review"), purpose: "understand_ontology" });
    if (!parsed) return useSkeleton("LLM 两次尝试仍未产出完整 JSON，已回退");
    ctx.ontologyUnderstanding = JSON.stringify(parsed).slice(0, 4000);
    const ambig = Array.isArray(parsed.ambiguities) ? (parsed.ambiguities as string[]) : [];
    const ext = Array.isArray(parsed.externalHandoffs) ? (parsed.externalHandoffs as unknown[]) : [];
    const nBuild = Array.isArray(parsed.agentsToBuild) ? (parsed.agentsToBuild as unknown[]).length : 0;
    const gates = Array.isArray(parsed.ruleGates) ? (parsed.ruleGates as string[]) : [];
    ctx.emit({ t: "reflect", kind: "understanding", lesson: `本体理解：要造 ${nBuild} 个 agent；规则闸 ${gates.join("、") || "无"}；外部交接 ${ext.length} 处；${ambig.length ? `⚠ 待澄清 ${ambig.length} 处：${ambig.slice(0, 3).join("；")}` : "无明显歧义"}。` });
    return { ok: true, summary: `已显式理解并记住本体${ambig.length ? `；有 ${ambig.length} 处歧义，建议先 ask_user 再设计：${ambig.slice(0, 2).join("；")}` : "（无明显歧义，可 create_plan）"}${scaleHint}`, output: parsed };
  },
};

// capability_resolve — G1 能力解析门（支柱④「选型优先于制造」，附录 B）。understand 之后、
// create_plan 之前：对每个 actor=Agent 动作先查三面资产（舰队 functions / 技能库 / 本体声明工具），
// 输出「复用 / 组合 / 新造」决策表 + 新造形态判据。DETERMINISTIC（无 LLM 调用）：命中靠名称
// 规整重合 + 触发/产出事件交集，结论落 ctx.capabilityResolution（折叠幸存），create_plan 据此
// 少造重复轮子。舰队端口未接线时诚实说明（跳过该面，绝不猜）。
const capability_resolve: BrainTool = {
  name: "capability_resolve",
  description:
    "understand_ontology 之后、create_plan 之前调用：能力解析——先查已有资产再决定造什么。对每个 actor=Agent 动作检查 ① 舰队已交付的 functions（同名/同触发同产出 → 可复用或组合）② 技能库 SKILLS（方法可注入）③ 本体声明的工具。输出每个动作的「复用/组合/新造」决策表；新造时给形态判据（tool=确定性 API 包装 / sub-agent=需推理的独立子能力 / skill=可复述方法 / agent=进事件链路的业务动作）。结论会被记住贯穿设计（折叠不丢）。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology（建议也先 understand_ontology）。" };
    const agentActions = ctx.ontology.actions.filter((a) => a.actor.includes("Agent"));
    const fleet = ctx.ports.fleet ? await ctx.ports.fleet.list().catch(() => []) : null;
    const skills = ctx.ports.skills ? await ctx.ports.skills.list(ctx.domain).catch(() => []) : [];
    const norm = (s: string) => (s || "").toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "");
    // CJK 双字重合（沿用 report-jobs 的 stage 匹配思路）：技能面向中文名/用途，动作名是 camelCase，
    // 所以拿动作【描述】与技能 名称+用途 做双字命中。
    const cjkHit = (a: string, b: string): boolean => {
      const na = norm(a);
      const nb = norm(b);
      if (!na || !nb) return false;
      for (let i = 0; i < nb.length - 1; i++) {
        const bi = nb.slice(i, i + 2);
        if (/[一-鿿]{2}/.test(bi) && na.includes(bi)) return true;
      }
      return false;
    };
    const rows = agentActions.map((a) => {
      const an = norm(a.name);
      const fleetMatches = (fleet ?? [])
        .filter((f) => f.enabled !== false)
        .filter((f) => {
          const names = [f.kebabId, f.name, f.title ?? ""].map(norm).filter(Boolean);
          const nameHit = names.some((n) => n.includes(an) || an.includes(n));
          const flowHit = (f.trigger ?? []).some((t) => a.trigger.includes(t)) && (f.emit ?? []).some((e) => a.triggered_event.includes(e));
          return nameHit || flowHit;
        })
        .slice(0, 4);
      // 人读名字优先（RAAS 老 workflow 的 kebabId 是数字编号）+ G2 生产战绩内联：
      // 复用一个生产上正在翻车的 agent，必须在选型时当场看见。
      const fleetHits = fleetMatches.map((f) => {
        const label = f.name || f.title || f.kebabId;
        const stat = f.prodRuns ? `·生产${f.prodRuns}次${f.prodFailRate ? `${Math.round(f.prodFailRate * 100)}%失败${f.prodFailRate >= 0.5 ? "⚠" : ""}` : "0失败"}` : "";
        return `${label}${stat}`;
      });
      const skillHits = skills
        .filter((sk) => cjkHit(`${a.description ?? ""}${a.name}`, `${sk.name}${sk.purpose ?? ""}`))
        .map((sk) => sk.name)
        .slice(0, 3);
      const desc = `${a.description ?? ""}`;
      // 新造形态判据（支柱④）：确定性 API 味道 → 先造 tool；无本体动作对应但需推理的子能力在
      // design 阶段再拆 sub-agent；这里对"进事件链的业务动作"默认 agent 本体。
      const makeForm = (a.tool_use ?? []).length === 0 && /api|接口|调用第三方|同步至|推送到|下载/i.test(desc) ? "agent+先补tool" : "agent";
      const decision = fleetHits.length ? "复用/组合" : "新造";
      return { action: a.name, decision, fleetHits, skillHits, declaredTools: a.tool_use ?? [], makeForm: decision === "新造" ? makeForm : undefined };
    });
    const reuse = rows.filter((r) => r.decision === "复用/组合");
    const fresh = rows.filter((r) => r.decision === "新造");
    const line = (r: (typeof rows)[number]) =>
      `${r.action}→${r.decision}${r.fleetHits.length ? `(舰队:${r.fleetHits.join("/")})` : ""}${r.skillHits.length ? `(技能:${r.skillHits.join("/")})` : ""}${r.makeForm && r.makeForm !== "agent" ? `(${r.makeForm})` : ""}`;
    ctx.capabilityResolution = rows.map(line).join("；").slice(0, 1600);
    const fleetNote = fleet === null ? "（舰队目录未接线——复用面跳过，仅按技能/工具面解析）" : `舰队 ${fleet.length} 个 functions`;
    ctx.emit({ t: "reflect", kind: "capability", lesson: `能力解析：${reuse.length} 个动作可复用/组合、${fresh.length} 个需新造（${fleetNote}；技能库 ${skills.length}）。${reuse.length ? `复用候选：${reuse.map((r) => `${r.action}←${r.fleetHits.join("/")}`).join("；").slice(0, 300)}` : ""}` });
    return {
      ok: true,
      summary: `能力解析完成：${reuse.length} 复用/组合 · ${fresh.length} 新造${fleet === null ? "（舰队面未接线）" : ""}。create_plan 时：复用项不要重复设计（在计划里注明沿用），新造项按形态判据造。`,
      output: { rows, fleetWired: fleet !== null, skillCount: skills.length },
    };
  },
};

// analyze_with_code — G4 系统 A 的即席 CodeAct（附录 B）：LLM 数不清 262 条规则的分布，
// 代码一趟循环就数清。大脑亲笔写一小段 JS 分析代码，AST 安审 + 全局遮蔽 + 3s 超时后
// 在纯计算沙盒里真跑（input = 本体 + 当前规格，只读副本；无 I/O 无网络无模块系统）。
const analyze_with_code: BrainTool = {
  name: "analyze_with_code",
  description:
    "【即席代码分析】需要精确统计/交叉核对/图计算时（如：规则按阶段分布、事件字段对齐矩阵、哪些动作的产出没人消费），写一小段 JS 真跑，别靠心算。代码契约：函数体形式，`input` 变量可用（{ontology:{actions,events,rules,objects}, specs:[已设计的agent规格摘要]}，只读），必须 `return` 一个 JSON 可序列化的结果。禁 import/require/fetch/process/eval（安审会驳回）。适合确定性计算；需要语义判断的用认知专家（understand/critique 自带）。",
  parameters: params(
    {
      purpose: { type: "string", description: "这段代码要回答什么问题（一句话）" },
      code: { type: "string", description: "JS 函数体：用 input，return 结果。例：const byStage={}; for(const r of input.ontology.rules){const k=r.specificScenarioStage||'未标注'; byStage[k]=(byStage[k]||0)+1;} return byStage;" },
    },
    ["purpose", "code"],
  ),
  async execute(args, ctx) {
    const purpose = String(args.purpose ?? "").trim() || "代码分析";
    const code = String(args.code ?? "");
    ctx.emit({ t: "subagent.start", task: `认知专家 · 代码分析（${purpose.slice(0, 24)}）`, role: "代码分析专家" });
    const input = {
      ontology: ctx.ontology ? { actions: ctx.ontology.actions, events: ctx.ontology.events, rules: ctx.ontology.rules, objects: ctx.ontology.objects } : null,
      specs: ctx.specs.map((s) => ({ actionName: s.actionName, slug: s.slug, trigger: s.trigger, emit: s.emit, tools: s.tools })),
    };
    const r = await runInlineAnalysis(code, input, { timeoutMs: 3000 });
    const summary = r.ok
      ? `代码分析（${purpose}）完成：${JSON.stringify(r.result).slice(0, 400)}`
      : `代码分析（${purpose}）失败：${r.error}`;
    ctx.emit({ t: "subagent.done", task: `认知专家 · 代码分析（${purpose.slice(0, 24)}）`, summary: r.ok ? `⚙ ${purpose} · ${r.durationMs}ms` : `✗ ${r.error?.slice(0, 80)}` });
    return { ok: r.ok, summary, output: { purpose, result: r.result ?? null, error: r.error, durationMs: r.durationMs } };
  },
};

// critique_plan — an INDEPENDENT AI review of the decomposition (review tier), after create_plan and
// before mass design_agent. Challenges: missing/extra agents, wrong ordering, mis-identified rule
// gates, external-handoff-as-broken-chain, cross-agent I/O misalignment. Real LLM, must propose fixes.
const critique_plan: BrainTool = {
  name: "critique_plan",
  description:
    "create_plan 之后、大规模 design_agent 之前，让 AI【独立审查并挑战这份分解计划】：agent 是否多了/少了、事件链顺序对不对、规则闸口认对没、有没有把外部交接误当断链、跨 agent 的 I/O 契约是否对齐。发现问题就改计划(create_plan version+1)再设计——不走过场。",
  parameters: params({ deep: { type: "boolean", description: "（可选）三视角深评（链路完整/规则合规/IO 契约三位评审并行汇总）。是否深评由你判断：计划里 agent 多、规则密、或历史上这个难度出过保真违约时建议 true" } }),
  async execute(args, ctx) {
    if (!ctx.currentPlan) return { ok: false, summary: "还没 create_plan。" };
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    const plan = ctx.currentPlan;
    const agentActions = ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name);
    if (!isGatewayConfigured()) {
      const planned = new Set(plan.agents.map((a) => a.actionName));
      const missed = agentActions.filter((n) => !planned.has(n));
      const findings = missed.length ? [`漏了 Agent 动作：${missed.join("、")}`] : [];
      ctx.emit({ t: "reflect", kind: "plan-critique", lesson: findings.length ? findings.join("；") : "计划覆盖完整（确定性检查）。" });
      return { ok: findings.length === 0, summary: findings.length ? `计划审查：${findings.join("；")}` : "计划审查通过（未配网关，确定性）。", output: { issues: findings } };
    }
    const digest = `业务域 ${ctx.domain}\n本体里 actor=Agent 的动作：${agentActions.join("、")}\n计划（v${plan.version}，${plan.agents.length} agent）：\n${plan.agents.map((a, i) => `${i + 1}. ${a.actionName}：${a.role ?? ""} | 触发 ${(a.triggerEvents ?? []).join(",")} → 产出 ${(a.emitEvents ?? []).join(",")} | 候选工具 ${(a.toolCandidates ?? []).join(",") || "—"}`).join("\n")}`;

    // ── G3 三视角分治评审（附录 B）：计划够大时，单跳评审必然顾此失彼——派三位视角专家
    // 并行挑战（链路完整 / 规则合规 / IO 契约），按 problem 去重合并；≥2 位专家成功才采用，
    // 否则诚实降级回单跳。事件冒泡沿用认知专家通道（UI 免费可视化）。
    const deepReview = args.deep === true; // #NATIVE — 深评与否由你决定（deep 参数）；计划大/规则多/历史保真教训时建议 true
    if (deepReview) {
      const und = ctx.ontologyUnderstanding ? `\n【本体理解（四维分治结论）】${ctx.ontologyUnderstanding.slice(0, 1200)}` : "";
      const mkTask = (id: string, role: string, focus: string, extra: string) => ({
        id,
        role,
        system: `你是方案评审的「${role}」，只从【${focus}】这一个视角挑战这份 agent 分解计划。只输出 JSON {"issues":[{"severity":"high"|"med"|"low","problem":string,"fix":string}]}；没问题输出 {"issues":[]}。名字必须逐字来自材料，不编造。发现要具体到 agent/事件名。`,
        user: `${digest}${extra}`,
        maxTokens: 1200,
      });
      const perspectives = await runSpecialists(ctx, [
        mkTask("chain", "链路完整视角", "覆盖与事件链：漏/多 agent、顺序错乱、把外部交接误判为断链", `\n【Agent 动作全集】${agentActions.join("、")}${und}`),
        mkTask("rules", "规则合规视角", "规则闸口：校验类动作是否被识别为闸口、强制规则是否有 agent 承接", und),
        mkTask("contract", "IO 契约视角", "跨 agent 输入输出对齐：上游产出的事件字段能否满足下游触发所需", und),
      ]);
      const okR = perspectives.filter((r) => r.ok && r.output && typeof r.output === "object");
      if (okR.length >= 2) {
        const merged: Array<Record<string, unknown>> = [];
        const seen = new Set<string>();
        for (const r of okR) {
          const iss = Array.isArray((r.output as Record<string, unknown>).issues) ? ((r.output as Record<string, unknown>).issues as Array<Record<string, unknown>>) : [];
          for (const i of iss) {
            const k = String(i.problem ?? "").slice(0, 30);
            if (k && !seen.has(k)) {
              seen.add(k);
              merged.push({ ...i, perspective: r.role });
            }
          }
        }
        const high = merged.filter((i) => i.severity === "high");
        const verdict = high.length ? "revise" : "ok";
        ctx.emit({ t: "reflect", kind: "plan-critique", lesson: merged.length ? `方案评审（三视角 · ${okR.length}/3）：${merged.length} 处（${high.length} 高危）：${merged.slice(0, 3).map((i) => `[${String(i.perspective).replace(/视角$/, "")}] ${String(i.problem)}`).join("；")}` : `方案评审（三视角 · ${okR.length}/3）：分解合理、覆盖完整 ✓` });
        return {
          ok: verdict !== "revise",
          summary: merged.length ? `三视角评审发现 ${merged.length} 处问题（${high.length} 高危）：${merged.slice(0, 3).map((i) => `${String(i.problem)}→${String(i.fix)}`).join("；")}${verdict === "revise" ? "。建议 create_plan v+1 改后再设计。" : ""}` : "三视角评审通过：链路/规则/契约均无异议 ✓",
          output: { verdict, issues: merged, perspectives: okR.map((r) => r.role) },
        };
      }
      ctx.emit({ t: "reflect", kind: "plan-critique", lesson: `三视角评审未成（${okR.length}/3 成功）——降级为单跳评审。` });
    }

    const sys =
      "你是 agent 工厂的【方案评审】，独立挑战这份 agent 分解计划。逐条判断：(1) 是否漏了/多了 agent（对照本体 Agent 动作）；(2) 事件链顺序对不对；(3) 规则校验类动作是否被识别为闸口；(4) 是否有 agent 的产出其实是交给外部平台的终态而被当成断链；(5) 跨 agent 的 I/O 契约是否对齐。只输出 JSON：" +
      '{"verdict":"ok"|"revise","issues":[{"severity":"high"|"med"|"low","problem":string,"fix":string}]}。没问题就 issues:[]、verdict:"ok"。不要任何其它文字。';
    const parsed = await chatJson<Record<string, unknown>>(sys, digest, { temperature: 0.3, maxTokens: 4000, signal: ctx.signal, models: modelChain("review"), purpose: "critique_plan" });
    if (!parsed) return { ok: true, summary: "方案评审网关错误，已跳过（可手动核对覆盖）。", output: { issues: [] } };
    const issues = Array.isArray(parsed.issues) ? (parsed.issues as Array<Record<string, unknown>>) : [];
    const high = issues.filter((i) => i.severity === "high");
    ctx.emit({ t: "reflect", kind: "plan-critique", lesson: issues.length ? `方案评审 ${issues.length} 处（${high.length} 高危）：${issues.slice(0, 3).map((i) => String(i.problem)).join("；")}` : "方案评审：分解合理、覆盖完整 ✓" });
    return { ok: parsed.verdict !== "revise", summary: issues.length ? `方案评审发现 ${issues.length} 处问题（${high.length} 高危）：${issues.slice(0, 3).map((i) => `${String(i.problem)}→${String(i.fix)}`).join("；")}${parsed.verdict === "revise" ? "。建议 create_plan v+1 改后再设计。" : ""}` : "方案评审通过：分解合理、覆盖完整 ✓", output: parsed };
  },
};

const design_agent: BrainTool = {
  name: "design_agent",
  description:
    "提交你为【一个】agent 动作设计好的 agent。先想清楚职责/边界/选哪些工具(为什么)/每个分支事件的触发条件，并【亲自写中文 system_prompt】。定义 input_schema/output_schema（参考 read_ontology 的 data_objects 真实属性）。规则校验类动作(is_rule_check)的 prompt 必须写成运行时动态抓规则，绝不写死规则。工具名优先用该动作的 suggested_tools / available_tools 里的真名。一次只交一个。",
  parameters: params(
    {
      action: { type: "string", description: "动作名（read_ontology agentActions[].name）" },
      role_name: { type: "string", description: "（可选）这个 function 的人类可读【显示名】（≤12 字，如「简历守门员」）——仅用于 UI 卡片/业务流全景的称呼；注意：角色设定属于生成过程中的工作者（过程角色），不属于交付的 functions。" },
      system_prompt: { type: "string", description: "你亲自写的中文系统提示：职责/依据/决策。要具体，别套模板。" },
      tools: { type: "array", items: { type: "string" }, description: "为它挑的工具（用 suggested_tools/available_tools 真名；没合适的留空并说明）" },
      decision_logic: { type: "string", description: "必填：分支决策逻辑——依据什么条件走哪个分支、成功/失败/拦截各 emit 什么事件、异常怎么兜底。UI 卡片与复审都读它。" },
      tool_rationale: { type: "string" },
      compensation_event: { type: "string", description: "#SAGA 可选：这个 agent 硬失败时 runtime 自动 emit 的【补偿事件】名（如 INVITATION_CANCELLED），用于撤销已发生的外部副作用（邀约已发/JD 已发布/已写外部系统）。有副作用工具的 agent 强烈建议声明；优先用本体已有事件名或与用户约定的补偿事件。" },
      input_schema: { type: "array", items: { type: "object", properties: { field: { type: "string" }, type: { type: "string" }, description: { type: "string" }, source: { type: "string" } }, required: ["field", "type"] } },
      output_schema: { type: "array", items: { type: "object", properties: { field: { type: "string" }, type: { type: "string" }, description: { type: "string" }, source: { type: "string" } }, required: ["field", "type"] } },
      plan: {
        type: "array",
        description:
          "强烈建议：这个 agent 的【有序多步 plan】——每个外部调用/写入是独立一步(运行时各包一个 step.run，可重放)。每步: stepId, kind(tool|logic|condition|invoke)。tool 步要给 tool 名 + idempotencyKeyFrom(派生稳定 step id 的业务键路径，如 entity_id/subject) + onError(terminal|soft|park)；condition 步给 condition 表达式；invoke 步给 invoke 目标(+timeoutS/onError/defaultResult)；用 dependsOn 引用更早的 condition 步做分支跳过。不写 plan 则回退单步 logic。",
        items: {
          type: "object",
          properties: {
            stepId: { type: "string" },
            kind: { type: "string", enum: ["tool", "logic", "condition", "invoke"] },
            tool: { type: "string" },
            condition: { type: "string" },
            invoke: { type: "string" },
            dependsOn: { type: "array", items: { type: "string" } },
            idempotencyKeyFrom: { type: "string" },
            onError: { type: "string", enum: ["terminal", "soft", "park"] },
            defaultResult: {},
            timeoutS: { type: "number" },
            description: { type: "string" },
          },
          required: ["stepId", "kind"],
        },
      },
    },
    ["action", "system_prompt", "decision_logic"],
  ),
  async execute(args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先调用 read_ontology。" };
    const name = String(args.action ?? "").trim();
    const action = ctx.ontology.actions.find((a) => a.name === name);
    if (!action) return { ok: false, summary: `找不到动作「${name}」，用 read_ontology 里的准确名字。` };
    if (!String(args.system_prompt ?? "").trim()) return { ok: false, summary: `agent「${name}」缺少 system prompt——必须亲自写，不能留空套模板。` };
    // Same fail-and-resubmit contract as the empty-prompt guard: decision_logic drives the UI
    // card + triple-review; an agent without branch logic reads as half-designed (and the model
    // DOES skip optional fields when it's busy authoring plan[] — hence required + this guard).
    if (!String(args.decision_logic ?? "").trim()) return { ok: false, summary: `agent「${name}」缺少 decision_logic——写清楚：依据什么条件走哪个分支、成功/失败/拦截各 emit 什么事件、异常怎么兜底。补上后重交。` };

    // ── 内部设计循环（内推演，架构书 §5）：确定性自检 → 命中硬问题就跑【一次】内部精修，把外层
    //    review→refine 的回环前移到设计当下。自检永远跑；精修 gateway-gated + env 可关 + 失败兜底原稿。 ──
    const isGate = looksLikeRuleGate(action);
    let rawPrompt = String(args.system_prompt ?? "");
    let rawLogic = String(args.decision_logic ?? "");
    {
      const knownEv0 = new Set(ctx.ontology.actions.flatMap((a) => [...a.trigger, ...a.triggered_event]));
      const draftOf = () => ({
        actionName: name,
        emitEvents: action.triggered_event ?? [],
        systemPrompt: rawPrompt,
        decisionLogic: rawLogic,
        toolCount: Array.isArray(args.tools) ? (args.tools as string[]).filter(Boolean).length : 0,
        hitl: false,
        isGate,
        ruleLeak: !isGate && promptEmbedsRule(`${rawPrompt}\n${rawLogic}`, ruleIdentifiers(ctx)),
        ungroundedEvents: ungroundedEventTokens([`${rawPrompt}\n${rawLogic}`], knownEv0),
        // #SAGA — 副作用工具却没补偿事件 → 自检软警告（⑥），提醒大脑设计撤销路径。
        sideEffectful: Array.isArray(args.tools) && (args.tools as string[]).some((t) => isSideEffectfulTool(String(t))),
        hasCompensation: Boolean(String(args.compensation_event ?? "").trim()),
      });
      const first = designSelfCheck(draftOf());
      if (first.hardCount > 0 && isGatewayConfigured() && innerLoopEnabled()) {
        const refined = await internalDesignRefine(draftOf(), first.issues, (sys, usr) =>
          chatJson<{ system_prompt?: string; decision_logic?: string }>(sys, usr, { temperature: 0.3, maxTokens: 3000, signal: ctx.signal, models: modelChain("review"), purpose: "design_self_refine" }),
        );
        if (refined) {
          rawPrompt = refined.systemPrompt;
          rawLogic = refined.decisionLogic;
          const after = designSelfCheck(draftOf());
          ctx.emit({ t: "reflect", kind: "design-refine", lesson: `内部设计自审「${name}」：修掉 ${first.hardCount - after.hardCount}/${first.hardCount} 处硬问题（${first.issues.filter((i) => i.hard).slice(0, 2).map((i) => i.message).join("；")}）` });
        }
      }
    }

    // ── tool grounding (de-hallucinate + floor) ──
    const picks = Array.isArray(args.tools) ? (args.tools as string[]).map(String).filter(Boolean) : [];
    const grounded = groundToolPicks(picks, ctx.toolCatalog ?? []);
    let tools = grounded.resolved;
    // FLOOR: if the brain picked nothing, fall back to ontology-declared tools + the top
    // semantically-ranked REAL tools (#C) — so an action that declared none still binds a real tool.
    let autoFloored: string[] = [];
    if (tools.length === 0) {
      const sug = suggestToolsForAction(action, ctx.realTools ?? []);
      if (sug.length) { tools = sug; autoFloored = [...sug]; } // #AUDIT-FIX(M19) — 自动补底必须被看见
    }

    let systemPrompt = rawPrompt; // 可能已被内部设计循环精修
    // RULE-CHECK FLOOR: bind the dynamic rule-fetch tool + instruction (the LLM ignores
    // a prompt-only instruction; this guarantees the contract closes for gate agents).
    if (isGate) {
      if (!tools.includes("ontology.fetchActionRules")) tools.push("ontology.fetchActionRules");
      if (!/fetchActionRules|动态抓取规则|实时抓取规则/.test(systemPrompt)) systemPrompt += RULE_FETCH_INSTRUCTION;
    }
    // weave in any skills the brain created this run
    if (ctx.createdSkills.length) {
      const frags = ctx.createdSkills.map((s) => `· ${s.name}：${s.decisionRule}`).join("\n");
      if (!systemPrompt.includes("【可复用技能】")) {
        systemPrompt += `\n\n【可复用技能】\n${frags}`;
        // Count each skill ACTUALLY woven into a delivered agent, so the effectiveness signal
        // (useCount vs successful-run evals) is meaningful for ranking reuse — weaving was the one
        // path that bumped nothing (only the explicit use_skill tool did).
        if (ctx.ports.skills?.bumpUse) for (const s of ctx.createdSkills) void ctx.ports.skills.bumpUse(kebab(s.name)).catch(() => {});
      }
    }
    // R3: compile the action's submission_criteria into a fail-close precondition block.
    const criteria = typeof action.submission_criteria === "string" ? action.submission_criteria.trim() : "";
    if (criteria && !systemPrompt.includes("【前置条件")) {
      systemPrompt += `\n\n【前置条件（运行前必须满足；不满足则 fail-close 发拦截/失败事件，不要继续）】\n${criteria}`;
    }

    const authored = { systemPrompt, tools, decisionLogic: rawLogic, reasoning: typeof args.reasoning === "string" ? args.reasoning : "", toolRationale: String(args.tool_rationale ?? "") };
    // R1: ground I/O on the canonical event_data (trigger/emit events' payload) so the
    // spec carries the AUTHORITATIVE fields even if the AI under-typed; AI annotations layer on.
    const inputSchema = mergeFields(parseIoSchema(args.input_schema), eventFieldsOf(action.trigger ?? [], ctx.ontology));
    const outputSchema = mergeFields(parseIoSchema(args.output_schema), eventFieldsOf(action.triggered_event ?? [], ctx.ontology));
    // Phase 1 — optional STRUCTURED plan. When the brain authors one, enforce production
    // discipline (side-effecting steps need idempotencyKeyFrom + onError; deps reference prior
    // steps) and REJECT a sloppy plan (mirrors the empty-prompt rejection). No plan → the deploy
    // falls back to a single logic action (back-compat).
    const plan = parsePlan(args.plan);
    if (plan.length) {
      const planCheck = validatePlan(plan, { knownTools: tools });
      if (!planCheck.ok) {
        return { ok: false, summary: `agent「${name}」的 plan 不合格——修正后重交：${planCheck.errors.slice(0, 5).join("；")}`, output: { planErrors: planCheck.errors } };
      }
    }

    const spec = buildSpec(action, ctx.domain, authored, inputSchema, outputSchema);
    // 显示名（非角色设定——角色属于过程 agents）：AI 给的显示名优先于描述截断兜底，
    // 仅供 UI 称呼；缺省时保留 buildSpec 的自动派生（永不为空）。
    const roleName = String(args.role_name ?? "").trim().slice(0, 18);
    if (roleName) spec.nameZh = roleName;
    if (plan.length) spec.plan = plan;
    spec.unresolvedTools = grounded.unresolved;
    // #SAGA — 补偿事件透传到 spec → mapToManifest 的 compensation_event → runtime 硬失败时幂等 emit。
    const comp = String(args.compensation_event ?? "").trim();
    if (comp) spec.compensationEvent = comp;
    spec.stateBindings = deriveStateBindings(action, ctx.ontology); // R5
    // auto-render readable code so every agent HAS code (codegen_agent can override w/ AI code), and
    // GRADE it so a compilable+safe render actually EXECUTES in the sandbox (true CodeAct), not just
    // sits there as a scaffold — this is what makes "生成的 code" really run.
    spec.codeSource = "render";
    await renderExecutableCode(spec);

    // warnings
    const promptText = `${systemPrompt}\n${authored.decisionLogic}`;
    const knownEv = new Set(ctx.ontology.actions.flatMap((a) => [...a.trigger, ...a.triggered_event]));
    const ungrounded = ungroundedEventTokens([promptText], knownEv);
    // #9: a non-gate agent leaks a rule if its prompt embeds a specific ontology rule identifier —
    // domain-agnostic (was a fixed Chinese-keyword + RAAS rule-id-regex check that never fired for
    // other domains, letting real leaks through).
    const ruleLeak = !isGate && promptEmbedsRule(promptText, ruleIdentifiers(ctx));

    ctx.specs = ctx.specs.filter((s) => s.actionName !== name);
    ctx.specs.push(spec);
    ctx.lastSandbox = null;
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec), forAgent: spec.actionName });
    ctx.emit({ t: "code", actionName: name, code: spec.generatedCode ?? "", codeSource: "render" });
    const execNote = spec.codeExecuted ? " · ⚙ 代码已过 编译+安全+加载探针，沙箱将真实执行（CodeAct）" : ` · 📄 声明式执行${spec.probeReason ? `（代码未过加载探针：${spec.probeReason}）` : ""}`;

    const agentActionNames = ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name);
    const done = new Set(ctx.specs.map((s) => s.actionName));
    const remaining = agentActionNames.filter((n) => !done.has(n));
    const noTool = tools.length === 0 && !spec.hitl;
    const warn =
      (grounded.bridged.length ? ` · 🔗 工具名已对到真名：${grounded.bridged.map((b) => `${b.raw}→${b.resolved}`).join("、")}` : "") +
      (grounded.unresolved.length ? ` · ⚠ 工具库没有：${grounded.unresolved.join("、")}。【先 ask_user，别默默造桩】给选项：①接入真实工具/补该外部API的I/O+凭证(recommended) ②create_mock_agent模拟 ③去掉该agent。` : "") +
      (noTool ? ` · ⚠ 这个 agent 没绑到任何工具。【先 ask_user】：可推荐的真实工具有 ${(rankRealTools(action, ctx.realTools ?? []).slice(0, 3).join("、") || "（语义匹配无）")}——问用户该接哪个/补什么凭证，确认无真实集成再 create_mock_agent。` : "") +
      (ungrounded.length ? ` · ⚠ prompt 出现本体没有的事件名:${ungrounded.join("、")}` : "") +
      (ruleLeak ? " · ⚠ 非校验 agent 写进了具体规则，应只属于校验闸口且运行时动态抓" : "") +
      (isGate ? " · 🔒 已自动绑定 ontology.fetchActionRules（运行时动态抓规则）" : "") +
      (plan.length ? ` · 🧭 已采纳 ${plan.length} 步可重放 plan（每步独立 step.run）` : " · 💡 建议补一份多步 plan（每个外部/写入步骤独立可重放）");
    return {
      ok: true,
      summary: `已提交「${spec.nameZh}」(${agentActionNames.length - remaining.length}/${agentActionNames.length}) · 工具 ${spec.tools.length} 个 · 已渲染代码${execNote}${warn}${autoFloored.length ? `｜🧲 你留空了 tools，系统按语义排名自动补底：${autoFloored.join("、")}——如不合适请显式改绑或 ask_user 与用户确认` : ""}`,
      output: {
        committed: spec.short, tools: spec.tools, unresolved: spec.unresolvedTools, autoFlooredTools: autoFloored.length ? autoFloored : undefined, done: agentActionNames.length - remaining.length, total: agentActionNames.length, remaining, needsCodegen: false,
        // #W3-1 — PROACTIVE provisioning: a structured gap signal (not just prose warnings) so the
        // brain/UI can act on "this agent lacks a capability" with concrete next actions.
        provisioning: noTool || grounded.unresolved.length
          ? { needed: true, gaps: [...(noTool ? ["no_tool_bound"] : []), ...(grounded.unresolved.length ? ["unresolved_tools"] : [])], options: ["search_tools", "create_tool", "extract_api_schema", "ask_user", "design_subagent"], suggested: rankRealTools(action, ctx.realTools ?? []).slice(0, 3) }
          : { needed: false },
      },
    };
  },
};

// #NEST design-time — decompose a COMPLEX parent agent into a parent + a deployable SUB-AGENT the
// parent invokes SYNCHRONOUSLY via a plan `kind:"invoke"` step (the "harness within harness").
// The sub-agent is a real registered function (excluded from ontology coverage — it's a helper, not
// an Agent action). ALSO the promotion path: pass `code` to formalize a runtime ctx.spawn-discovered
// sub-agent into a deployable one. Both P and S deploy → the end goal (deployable functions) holds.
const design_subagent: BrainTool = {
  name: "design_subagent",
  description:
    "把一个已 design_agent 的【复杂父 agent】拆出一个【子 agent】——可部署的辅助函数，父 agent 通过 plan 的 invoke 步骤同步调它（层层套的 harness）。子 agent 不是本体动作、不计入覆盖，但会真实注册+被父 invoke。用于把大 agent 分解成 父+子 都能上线的函数。也用于【固化】运行时 ctx.spawn 出来的子 agent：把它的完整 .ts 代码用 code 参数传进来即晋升为可部署子 agent（会过 TS+安全校验）。",
  parameters: params(
    {
      critical: { type: "boolean", description: "（建议显式声明）这个子任务对父 agent 是否关键：true=子失败即父失败（terminal）；false/缺省=失败降级为空结果继续（soft）。按业务后果判断，别默认都非关键。" },
      parent_action: { type: "string", description: "父 agent 的动作名（已 design_agent）" },
      task: { type: "string", description: "子 agent 负责的子任务（一句话，决定它的 slug）" },
      system_prompt: { type: "string", description: "子 agent 的中文系统提示（职责/决策）；不写会按父+任务生成一句" },
      decision_logic: { type: "string", description: "子 agent 的分支决策逻辑；不写会按父+任务合成一句（UI 卡片读它）" },
      tools: { type: "array", items: { type: "string" }, description: "子 agent 用的工具（真名，可空）" },
      input_schema: { type: "array", items: { type: "object", properties: { field: { type: "string" }, type: { type: "string" }, description: { type: "string" } }, required: ["field", "type"], additionalProperties: false }, description: "子 agent 输入字段（可空）" },
      output_schema: { type: "array", items: { type: "object", properties: { field: { type: "string" }, type: { type: "string" }, description: { type: "string" } }, required: ["field", "type"], additionalProperties: false }, description: "子 agent 输出字段（可空）" },
      code: { type: "string", description: "（可选）子 agent 的完整 .ts handler——用于晋升 ctx.spawn 出来的子 agent；过 TS+安全校验才采纳" },
      idempotency_key_from: { type: "string", description: "（可选）父 invoke 步骤的可重放业务键字段名；不填默认取父输入首字段/subject" },
    },
    ["parent_action", "task"],
  ),
  async execute(args, ctx) {
    const parentName = String(args.parent_action ?? "").trim();
    const parent = ctx.specs.find((s) => s.actionName === parentName && !s.isSubAgent);
    if (!parent) return { ok: false, summary: `没找到父 agent「${parentName}」——先 design_agent 它（子 agent 必须挂在一个已设计的父上）。` };
    const task = String(args.task ?? "").trim();
    if (!task) return { ok: false, summary: "task（子任务）不能为空。" };

    const taskKebab = (kebab(task).replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 24)) || "sub";
    const subSlug = `${parent.slug}-sub-${taskKebab}`;
    const subShort = subSlug; // = the manifest `name` fnRegistry indexes → the parent's invoke target
    const subActionName = `${parentName}__${taskKebab}`;
    // Collision guard: two DIFFERENT tasks that kebab to the same slug would silently clobber each
    // other (data loss). Reject with a clear message so the user disambiguates the task wording.
    const collides = ctx.specs.find((s) => s.slug === subSlug && s.isSubAgent && s.parentTask !== task);
    if (collides) return { ok: false, summary: `子任务命名冲突：「${collides.parentTask}」与「${task}」都规整成同一个 slug「${subSlug}」。换一个更具体的 task 描述来区分。`, output: { collision: true, collidesWith: collides.parentTask } };
    const grounded = groundToolPicks(Array.isArray(args.tools) ? (args.tools as string[]).map(String).filter(Boolean) : [], ctx.toolCatalog ?? []);
    const inputSchema = parseIoSchema(args.input_schema);
    const outputSchema = parseIoSchema(args.output_schema);

    const sub: GeneratedAgentSpec = {
      key: subActionName, actionName: subActionName, slug: subSlug, short: subShort, domainId: parent.domainId,
      nameZh: `${parent.nameZh}·子[${task.slice(0, 14)}]`, kind: "llm",
      // synthetic internal trigger so the Inngest fn registers cleanly; NEVER event-fired (only
      // step.invoke'd) and excluded from the event graph (isSubAgent).
      trigger: [`${subSlug}.invoked`], emit: [], tools: grounded.resolved, unresolvedTools: grounded.unresolved, objects: [],
      systemPrompt: String(args.system_prompt ?? "").trim() || `你是「${parent.nameZh}」的子 agent，专注完成一个子任务：${task}。用给定输入推理并返回结构化结果。`,
      // Sub-agents previously shipped with an EMPTY decisionLogic (the spec field is required,
      // but the literal skipped it behind the cast) — the UI's 决策逻辑 button rendered dead.
      // Author it or synthesize a truthful one from the invoke contract.
      decisionLogic:
        String(args.decision_logic ?? "").trim() ||
        `被父「${parent.nameZh}」的 plan invoke 步同步调用：按输入完成「${task}」并返回结构化结果；失败抛错，由父步骤的 onError(soft) 用 defaultResult 兜底，不阻断父链路。`,
      userPrompt: "", steps: [], ruleRefs: [], retries: 1, hitl: false, confidence: 1, promptSource: "llm",
      inputSchema, outputSchema, designReasoning: `父「${parent.nameZh}」的子任务分解：${task}`,
      isSubAgent: true, parentAction: parentName, parentTask: task,
    } as GeneratedAgentSpec;

    // Code: promotion (given code) OR render+grade.
    const providedCode = args.code ? String(args.code) : "";
    let promoted = false;
    if (providedCode.trim()) {
      const v = await validateAgentCode(providedCode);
      if (!v.ok) return { ok: false, summary: `晋升的子 agent 代码没过 TS 校验：${v.errors.slice(0, 3).join("；")}`, output: { errors: v.errors } };
      const lint = lintGeneratedToolCode(providedCode);
      if (!lint.ok) return { ok: false, summary: `子 agent 代码安全校验未过（禁危险 API）：${lint.violations.slice(0, 3).join("；")}`, output: { violations: lint.violations } };
      // #REDESIGN FU3 — full reviewLoop on promotion too: compile ✓ + AST-lint ✓ + PROBE (loads a
      // callable handler). A promoted spawn that compiles+lints but exposes no handler must NOT claim
      // executable — reject it so the brain fixes the code before it becomes a deployable sub-agent.
      const probe = await probeAgentModule(providedCode);
      if (!probe.loads) return { ok: false, summary: `晋升的子 agent 代码未过加载探针（编译+安全过了，但没有可调用 handler）：${probe.reason}`, output: { probeReason: probe.reason } };
      sub.generatedCode = providedCode;
      sub.codeSource = "ai";
      sub.codeExecuted = true;
      promoted = true;
    } else {
      await renderExecutableCode(sub);
    }

    // Wire the parent → invoke(sub). If the parent has no plan, seed a logic step first so it keeps
    // its main work, THEN the invoke. Idempotent: don't add a second invoke for the same sub.
    const idemKey = String(args.idempotency_key_from ?? "").trim() || parent.inputSchema?.[0]?.field || "subject";
    // #AUDIT-FIX(L32) — 子任务关键性由 AI 显式声明（critical=true → terminal：子 agent 失败即父
    // 失败），不再硬编码 soft+{}（旧行为把关键子任务的失败静默换成空对象继续）。
    const subCritical = args.critical === true;
    const invokeStep: PlanStep = { stepId: `invoke-${taskKebab}`, kind: "invoke", invoke: subShort, idempotencyKeyFrom: idemKey, onError: subCritical ? "terminal" : "soft", ...(subCritical ? {} : { defaultResult: {} }), timeoutS: 60, description: `同步调用子 agent ${subShort}：${task}${subCritical ? "（关键子任务：失败即父失败）" : "（非关键：失败降级为空结果）"}` };
    const basePlan: PlanStep[] = parent.plan && parent.plan.length ? parent.plan : [{ stepId: `${kebab(parentName)}-logic`, kind: "logic", description: (parent.designReasoning ?? parentName).slice(0, 120) }];
    parent.plan = basePlan.some((s) => s.kind === "invoke" && s.invoke === subShort) ? basePlan : [...basePlan, invokeStep];

    ctx.specs = ctx.specs.filter((s) => s.slug !== subSlug);
    ctx.specs.push(sub);
    ctx.lastSandbox = null;
    ctx.emit({ t: "agent.created", spec: cardOf(sub), design: designOf(sub), forAgent: sub.actionName, parentAgent: parentName });
    ctx.emit({ t: "reflect", kind: "subagent", lesson: `为「${parent.nameZh}」拆出子 agent ${subShort}（${task}）——${promoted ? "由运行时 spawn 晋升" : "新设计"}，父通过 invoke 同步调用；两者都是可部署函数。` });
    // Composition note: for a CodeAct parent (codeExecuted), the invoke runs as a SEPARATE plan step
    // AFTER the parent's handler — the handler can't use the sub's result inline. To use a sub-agent
    // result INSIDE the handler, call ctx.spawn(...) in the handler instead.
    const codeExecNote = parent.codeExecuted ? " · ⚠ 父是 CodeAct：invoke 在其 handler 之后独立执行；若要在 handler 内用子结果请改 ctx.spawn" : "";
    return {
      ok: true,
      summary: `已拆出子 agent ${subShort}（${promoted ? "晋升自 spawn 代码" : sub.codeExecuted ? "已渲染+可执行" : "已渲染"}）并接到「${parent.nameZh}」的 invoke 步骤（键=${idemKey}）${sub.unresolvedTools.length ? ` · ⚠ 未解析工具:${sub.unresolvedTools.join("、")}` : ""}${codeExecNote}。子 agent 不计入本体覆盖，但会真实部署+被父调用。`,
      output: { subSlug, subShort, parentAction: parentName, invokeWired: true, promoted, codeExecuted: sub.codeExecuted ?? false, idempotencyKeyFrom: idemKey },
    };
  },
};

const codegen_agent: BrainTool = {
  name: "codegen_agent",
  description: "为一个已 design_agent 的 agent【亲手写完整 .ts 代码】（从 import 到导出），覆盖自动渲染的脚手架。会用 TS 编译器校验语法；通过才采纳并标记 codeSource=ai。不写也行——design_agent 已自动渲染可读代码。handler 的 ctx 提供：ctx.reason(systemPrompt,input) 做判断、ctx.tool(name,args)/ctx.tools.run 调工具、ctx.emit(event,payload) 产出；若子任务复杂可 await ctx.spawn(task,input,{tools}) 让它生成并运行一个【子 agent】辅助（沙箱内、深度受限，子 agent 的产出会回灌）。",
  parameters: params({ action: { type: "string" }, code: { type: "string", description: "完整 .ts 文件" } }, ["action", "code"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const spec = ctx.specs.find((s) => s.actionName === name);
    if (!spec) return { ok: false, summary: `还没设计过「${name}」，先 design_agent。` };
    const code = String(args.code ?? "");
    if (!code.trim()) return { ok: false, summary: "code 不能为空。" };
    const { ok, errors } = await validateAgentCode(code);
    if (!ok) return { ok: false, summary: `代码没通过校验：${errors.slice(0, 3).join("；")}`, output: { errors } };
    // Phase 2 — security lint: AI-authored code that EXECUTES (codeExecuted/CodeAct) must not reach
    // for dangerous APIs (child_process / fs / net / eval / process.exit). Block + explain.
    const lint = lintGeneratedToolCode(code);
    if (!lint.ok) return { ok: false, summary: `代码安全校验未过（禁用危险 API，改用受控工具）：${lint.violations.slice(0, 3).join("；")}`, output: { violations: lint.violations } };
    // #W1-4 — 3-gate parity with design_agent: the AI code must also pass the LOAD PROBE (compiles+
    // lints but exposes no callable handler ≠ executable). Grade codeExecuted from THE NEW code —
    // previously the grade referred to the old rendered scaffold the AI code just replaced.
    const probe = await probeAgentModule(code);
    if (!probe.loads) return { ok: false, summary: `代码未过加载探针（编译+安全过了，但没有可调用 handler）：${probe.reason}——修正后重交。`, output: { probeReason: probe.reason } };
    spec.generatedCode = code;
    spec.codeSource = "ai";
    spec.codeExecuted = true;
    spec.probeReason = undefined;
    ctx.lastSandbox = null;
    ctx.emit({ t: "code", actionName: name, code, codeSource: "ai" });
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec), forAgent: spec.actionName });
    return { ok: true, summary: `「${spec.nameZh}」的代码已采纳（你亲手写、TS 校验通过）。`, output: { codeSource: "ai" } };
  },
};

const refine_agent: BrainTool = {
  name: "refine_agent",
  description: "精修一个已设计的 agent（针对 validate_graph / sandbox_run / score_spec 的具体问题）：覆盖 system_prompt / tools / decision_logic / input_schema / output_schema 中要改的部分。保留上一版快照到历史，自动算改前后分数变化，若退步会提示 revert_refine。改完该 agent 沙箱证据失效。",
  parameters: params(
    {
      action: { type: "string" },
      critique: { type: "string", description: "上一版哪里不对（要修的根因）" },
      system_prompt: { type: "string" },
      tools: { type: "array", items: { type: "string" } },
      decision_logic: { type: "string" },
      input_schema: { type: "array", items: { type: "object", properties: { field: { type: "string" }, type: { type: "string" }, description: { type: "string" }, source: { type: "string" } }, required: ["field", "type"] } },
      output_schema: { type: "array", items: { type: "object", properties: { field: { type: "string" }, type: { type: "string" }, description: { type: "string" }, source: { type: "string" } }, required: ["field", "type"] } },
    },
    ["action", "critique"],
  ),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const spec = ctx.specs.find((s) => s.actionName === name);
    if (!spec) return { ok: false, summary: `还没设计过「${name}」，先 design_agent。` };
    const history = (ctx.attemptHistory[name] ??= []);
    // In-loop deliberation budget (ported from old AO): more refines tend to regress, not improve.
    // On hit, REFUSE + steer the brain to step UP a level (revert / verify_chain / re-plan / diagnose)
    // instead of grinding the same agent or churning across agents. Env-overridable; no domain logic.
    const REFINE_BUDGET = Number(process.env.FACTORY_REFINE_BUDGET) || 4;
    const GLOBAL_REFINE_FACTOR = Number(process.env.FACTORY_GLOBAL_REFINE_FACTOR) || 3;
    const priorAttempts = history.length;
    if (priorAttempts >= REFINE_BUDGET) {
      // #ADAPT — 卡住才拆：复杂 agent 磨到预算上限，多半是"一个 agent 承载了太多步骤"，
      // 正确动作是 design_subagent 拆出同步 invoke 子 agent，而不是第 N+1 次改 prompt。
      const spSplit = ctx.specs.find((x) => x.actionName === name || x.short === name);
      const splitNote = shouldSuggestSplit(spSplit) ? `该 agent 较复杂（${spSplit?.tools?.length ?? 0} 工具${spSplit?.plan?.length ? `、${spSplit.plan.length} 步 plan` : ""}）——符合"卡住才拆"：考虑 design_subagent 把最容易失败的子步骤拆成同步 invoke 子 agent，父 agent 只保留编排。` : "";
      return { ok: false, summary: `agent「${name}」已 refine ${priorAttempts} 次，达到重试上限——别再硬修了。${splitNote}要么 revert_refine("${name}") 回滚到最好的一版并接受，要么 verify_chain 看链路全貌定位真断点；若方向就是错的，create_plan 重新规划，或 analyze_failure 诚实记根因。`, output: { actionName: name, attemptsUsed: priorAttempts, budget: REFINE_BUDGET, advice: splitNote ? "split_or_revert_or_replan" : "revert_or_verify_or_replan" } };
    }
    const totalRefines = Object.values(ctx.attemptHistory).reduce((s, h) => s + (h?.length ?? 0), 0);
    const globalCap = GLOBAL_REFINE_FACTOR * Math.max(1, ctx.specs.length);
    if (totalRefines >= globalCap) {
      return { ok: false, summary: `全域已累计 refine ${totalRefines} 次（上限 ${globalCap}≈${GLOBAL_REFINE_FACTOR}×${ctx.specs.length} 个 agent）——再逐个微调大概率解决不了，问题很可能在设计/数据/本体层面。停下：verify_chain 看链路全貌定位真断点，或 analyze_failure 诚实记根因收尾，别继续 churn。`, output: { totalRefines, globalCap, advice: "stop_churn_verify_or_analyze" } };
    }
    // #W1-13 — CONVERGENCE DETECTION: two consecutive near-zero deltas mean grinding, not improving.
    // Refuse further refines and steer to verify_chain / revert / replan instead of burning budget.
    const recent = history.slice(-2).map((h) => h.delta).filter((d): d is number => typeof d === "number");
    if (recent.length === 2 && recent.every((d) => Math.abs(d) < 5)) {
      const spConv = ctx.specs.find((x) => x.actionName === name || x.short === name);
      const convSplit = shouldSuggestSplit(spConv) ? `该 agent 较复杂（${spConv?.tools?.length ?? 0} 工具${spConv?.plan?.length ? `、${spConv.plan.length} 步 plan` : ""}），"卡住才拆"（ADaPT）：考虑 design_subagent 拆出子步骤。` : "";
      return { ok: false, summary: `agent「${name}」最近两轮 refine 分数几乎没动（Δ ${recent.join("、")}）——继续磨大概率无效。${convSplit}改走 verify_chain 看链路全貌、revert_refine 回滚到最好一版、或 create_plan 重新规划。`, output: { actionName: name, recentDeltas: recent, advice: "converged_stop_refining" } };
    }
    const priorScore = scoreTotal(scoreSpec(spec, history.length));
    // #W2 — structured review findings (from review_agent/review_context/review_completeness) can be
    // passed straight in; they are folded into the recorded critique so the refine visibly addresses them.
    const reviewFindings = Array.isArray(args.review_findings) ? (args.review_findings as string[]).map(String).filter(Boolean) : [];
    const critiqueText = [String(args.critique ?? ""), ...reviewFindings.map((f) => `[审查] ${f}`)].filter(Boolean).join("；");
    const snapshot: RefineAttempt = { attemptNumber: history.length + 1, priorSpecSnapshot: { systemPrompt: spec.systemPrompt, tools: [...spec.tools], decisionLogic: spec.decisionLogic }, fullSnapshot: JSON.parse(JSON.stringify(spec)) as Record<string, unknown>, critique: critiqueText, changes: "" };

    const toolsBefore = [...spec.tools];
    if (typeof args.system_prompt === "string" && args.system_prompt.trim()) spec.systemPrompt = args.system_prompt;
    if (Array.isArray(args.tools) && (args.tools as string[]).length) {
      const grounded = groundToolPicks((args.tools as string[]).map(String).filter(Boolean), ctx.toolCatalog ?? []);
      spec.tools = grounded.resolved;
      spec.unresolvedTools = grounded.unresolved;
    }
    if (specIsRuleGate(spec) && !spec.tools.includes("ontology.fetchActionRules")) spec.tools.push("ontology.fetchActionRules");
    if (typeof args.decision_logic === "string") spec.decisionLogic = args.decision_logic;
    if (Array.isArray(args.input_schema)) spec.inputSchema = parseIoSchema(args.input_schema);
    if (Array.isArray(args.output_schema)) spec.outputSchema = parseIoSchema(args.output_schema);
    // re-render + re-grade code unless the user hand-wrote AI code (a refined spec → fresh executable render)
    if (spec.codeSource !== "ai") await renderExecutableCode(spec);
    ctx.lastSandbox = null;

    const newDims = scoreSpec(spec, history.length + 1);
    const newScore = scoreTotal(newDims);
    const delta = newScore - priorScore;
    const regression = delta <= -10;
    snapshot.changes = `prompt${args.system_prompt ? "改" : "未改"} · tools ${toolsBefore.length}→${spec.tools.length}`;
    snapshot.delta = delta; // #W1-13 — feeds convergence detection
    history.push(snapshot);

    ctx.emit({
      t: "refine",
      actionName: name,
      critique: String(args.critique ?? ""),
      diff: { systemPromptChanged: !!args.system_prompt, toolsAdded: spec.tools.filter((t) => !toolsBefore.includes(t)), toolsRemoved: toolsBefore.filter((t) => !spec.tools.includes(t)), decisionLogicChanged: typeof args.decision_logic === "string" },
    });
    ctx.emit({ t: "score.delta", actionName: name, priorTotal: priorScore, newTotal: newScore, delta, regression, dimensions: newDims });
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec), forAgent: spec.actionName });
    return { ok: true, summary: `已精修「${spec.nameZh}」 · 分 ${priorScore}→${newScore}(${delta >= 0 ? "+" : ""}${delta})${regression ? " · ⚠ 退步了，可 revert_refine 回滚" : ""} · 记得重新 sandbox_run`, output: { priorScore, newScore, delta, regression, attempt: history.length } };
  },
};

const revert_refine: BrainTool = {
  name: "revert_refine",
  description: "把一个 agent 回滚到上一次 refine 之前的快照（当 score.delta 显示这轮精修退步时用）。",
  parameters: params({ action: { type: "string" } }, ["action"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const spec = ctx.specs.find((s) => s.actionName === name);
    const history = ctx.attemptHistory[name];
    if (!spec || !history?.length) return { ok: false, summary: `「${name}」没有可回滚的精修历史。` };
    const last = history.pop()!;
    if (last.fullSnapshot) {
      // #W1-12 — FULL rollback: restore every field (schemas/plan/code included), not just 3. The old
      // partial restore left half-reverted schema state after a refine that touched input/output_schema.
      Object.assign(spec, last.fullSnapshot);
    } else {
      spec.systemPrompt = last.priorSpecSnapshot.systemPrompt;
      spec.tools = [...last.priorSpecSnapshot.tools];
      spec.decisionLogic = last.priorSpecSnapshot.decisionLogic;
    }
    if (spec.codeSource !== "ai") await renderExecutableCode(spec);
    ctx.lastSandbox = null;
    ctx.emit({ t: "revert", actionName: name, revertedToAttempt: last.attemptNumber - 1 });
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec), forAgent: spec.actionName });
    return { ok: true, summary: `已把「${spec.nameZh}」回滚到第 ${last.attemptNumber} 次精修之前。`, output: {} };
  },
};

// Boundary events — events emitted with no INTERNAL consumer. Inngest events are global,
// so an emit can legitimately be consumed by an EXTERNAL platform / webhook / terminal,
// NOT a broken chain. The AI proposes a classification; the user confirms + supplements the
// external contract; verifyGraph then honors them so they aren't false-flagged as orphans.
const propose_boundary_events: BrainTool = {
  name: "propose_boundary_events",
  description:
    "当 validate_graph 报某些事件【悬空】(emit 了却没有内部 agent 消费),而你判断它们其实是【交给外部平台消费的交接事件】或【本就是终态】(不是真的链断了),用这个工具列出来交给【用户确认】。每个给:event(本体真事件名)、kind(external=外部交接 / terminal=终态)、why 一句理由、(external 时)consumer 外部消费方 + payloadContract 你猜的 payload 契约。提交后会暂停等用户逐个确认/补充;确认后这些事件不再算断点,external 的留一份对外契约给下游核对。【真正该修的断点别放进来】,那些用 refine_agent 修。",
  parameters: params({
    events: {
      type: "array",
      description: "你判断为外部交接/终态的悬空事件",
      items: {
        type: "object",
        properties: {
          event: { type: "string", description: "事件名(本体真事件名)" },
          kind: { type: "string", enum: ["external", "terminal"], description: "external=交给外部平台消费 / terminal=终态" },
          why: { type: "string", description: "一句理由" },
          consumer: { type: "string", description: "(external)外部消费方:平台/服务/团队" },
          payloadContract: { type: "string", description: "(external)payload 契约:外部消费方会拿到哪些字段" },
        },
        required: ["event", "kind"],
      },
    },
  }, ["events"]),
  async execute(args, ctx) {
    const raw = Array.isArray((args as { events?: unknown }).events) ? ((args as { events: Array<Record<string, unknown>> }).events) : [];
    if (!raw.length) return { ok: false, summary: "没有给出任何边界事件——如果是真断点请用 refine_agent 修,不要走这个流程。" };
    const producersOf = (ev: string) => ctx.specs.filter((s) => (s.emit ?? []).includes(ev)).map((s) => s.short);
    const proposals: BoundaryProposal[] = raw
      .filter((e) => !!e && typeof e === "object" && typeof e.event === "string")
      .map((e) => ({
        event: String(e.event),
        suggestedKind: (["external", "terminal", "break"].includes(String(e.kind)) ? String(e.kind) : "external") as BoundaryProposal["suggestedKind"],
        why: String(e.why ?? ""),
        producers: producersOf(String(e.event)),
        consumer: typeof e.consumer === "string" ? e.consumer : undefined,
        payloadContract: typeof e.payloadContract === "string" ? e.payloadContract : undefined,
      }));
    ctx.awaitingBoundary = true;
    ctx.boundaryProposals = proposals; // kept so a park timeout can auto-apply them
    ctx.emit({ t: "boundary.cases", proposals, awaitingDecision: true });
    return {
      ok: true,
      summary: `已把 ${proposals.length} 个边界事件交给用户确认(${proposals.map((p) => p.event).join("、")})。【现在暂停,等用户逐个确认是外部交接/终态/还是真断点并补充契约——不要继续调别的工具】。用户决定后我会把结果作为消息发给你,你再据此总结对外契约并继续。`,
      output: { proposals, awaitingDecision: true },
    };
  },
};

const validate_graph: BrainTool = {
  name: "validate_graph",
  description: "静态校验所有 agent 的事件图：①结构闭合(emit被消费/是终态、trigger有产出者/是入口、可达)②覆盖(每个 Agent 动作都有 agent)③字段合同(下游 input 要的字段上游 output 有没有产出)。返回 agentIssueMap 把问题绑到具体 agent。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    if (!ctx.specs.length) return { ok: false, summary: "还没设计任何 agent。" };
    const specActions: OntologyAction[] = ctx.specs.map((s) => ({ id: s.slug, name: s.actionName, actor: s.hitl ? ["Human"] : ["Agent"], trigger: s.trigger ?? [], triggered_event: s.emit ?? [], target_objects: s.objects ?? [], tool_use: s.tools ?? [], system_prompt: s.systemPrompt, user_prompt: s.userPrompt }));
    const known = compileGraph(ctx.ontology.actions, { domainId: ctx.domain });
    const specGraph = compileGraph(specActions, { domainId: ctx.domain });
    const v = verifyGraph(specGraph, { knownEntries: known.entryEvents, knownTerminals: known.terminalEvents, boundaryEvents: (ctx.boundaryEvents ?? []).filter((b) => b.kind !== "break").map((b) => b.event) });
    const gap = coverageGap(ctx.ontology.actions, ctx.specs.map((s) => s.actionName));
    const contract = deriveContractGraph(ctx.specs, ctx.domain, canonicalEventFields(ctx.ontology));
    const contractMap = contractAgentIssueMap(contract);
    // #SIMPLIFY 契约问题分级（结构化，替代旧的 summary 字符串 includes 判断——那种写法既脆、
    // 又漏了 type_mismatch/type_conflict 两类硬问题）：硬 = 运行期会解析爆炸，入主列表；
    // 软（untyped/non_canonical，envelope 可携带）折一行摘要，防止灌爆上下文触发过早压缩。
    const { hard: hardContract, soft: softContract } = contractIssueStringsBySeverity(contract);
    // #NATIVE（设计期契约降级）— 契约问题不再阻断（不翻 ok）：它们是【高置信事实提醒】——
    // 双方 schema 都是 AI 自己声明的，冲突=自相矛盾，提醒即修；真正的裁判是沙箱真实执行的
    // 保真结果（execution_fidelity，10 判据之一）。静态分析只告知，不替 AI 决定能否继续。
    const contractAdvisory = hardContract.map((l) => `⚠[契约提醒·高置信] ${l}`);
    const issues: string[] = [
      ...(gap.length ? [`缺少 agent 的动作：${gap.join("、")}`] : []),
      ...v.issues.map((i) => (i.kind === "missing_producer" ? `「${i.action}」消费的 ${i.event} 没人产出` : i.kind === "orphan_emit" ? `「${i.action}」产出的 ${i.event} 没人消费且非终态` : i.kind === "unreachable_node" ? `「${i.action}」从入口不可达` : i.kind === "dead_end" ? `「${i.action}」从入口可达但到不了任何终态（困在环里/死路——补一条通向终态的分支或显式声明退出）` : i.kind === "no_entry" ? "无入口节点" : "到不了终态")),
      ...contractAdvisory,
      ...(softContract.length ? [`（另有 ${softContract.length} 处字段靠 envelope 携带，非阻断——如需严格对齐可补进本体）`] : []),
    ];
    const emptyTools = ctx.specs.filter((s) => !s.tools?.length && !s.hitl).map((s) => s.short);
    if (emptyTools.length) issues.push(`无工具的 agent：${emptyTools.join("、")}`);
    const agentIssueMap: Record<string, unknown[]> = {};
    for (const i of v.issues) if ("action" in i) (agentIssueMap[i.action] ??= []).push(i);
    for (const [action, list] of Object.entries(contractMap)) agentIssueMap[action] = [...(agentIssueMap[action] ?? []), ...list];
    // ok = 结构性事实（覆盖齐 + 事件图闭合 + 有工具）。契约提醒不计入——设计期不阻断，
    // 沙箱保真才是行为裁判（AI 无视提醒 → 真实失败 + #ATTRIB 定位会把它带回来）。
    const ok = gap.length === 0 && v.ok && emptyTools.length === 0;
    ctx.lastValidation = { ok, agentIssueMap };
    ctx.emit({ t: "validation", ok, issues, agentIssueMap });
    // #BIZFLOW — the moment specs + ontology + boundary decisions are all on hand, derive the
    // complete business-flow model (external platforms · reads/calls/writes · branch semantics)
    // so the UI can render the generated end-to-end business diagram.
    ctx.emit({ t: "flow.business", model: deriveBusinessFlow(ctx.specs, ctx.ontology, ctx.boundaryEvents) as unknown as Record<string, unknown> });
    const contractNote = contractAdvisory.length ? `；另有 ${contractAdvisory.length} 条契约提醒（高置信，建议当场修——沙箱保真会按真实行为裁定）：${contractAdvisory.slice(0, 2).join("；")}` : "";
    return { ok, summary: ok ? `事件图闭合 ✓（覆盖 + 结构）${contractNote}` : `未闭合：${issues.slice(0, 4).join("；")}${contractNote}`, output: { ok, issues, agentIssueMap, coverageGap: gap, contract: { ok: contract.ok, payloadGaps: contract.events.filter((e) => e.payloadGaps.length).map((e) => ({ event: e.name, missing: e.payloadGaps })) } } };
  },
};

const verify_chain: BrainTool = {
  name: "verify_chain",
  description: "本体接地的链路体检：从入口事件出发，沿真实事件链逐跳走，定位链路在哪个 agent 断了（消费了没人产的事件 / 产了没人收的事件），帮你精准定位要 refine 谁，而不是泛泛重试。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.ontology || !ctx.specs.length) return { ok: false, summary: "需要先 read_ontology + design_agent。" };
    // Sub-agents are invoke-only (synthetic trigger, never event-fired) — exclude from the event-chain
    // closure analysis so they aren't false-flagged as broken/orphan nodes.
    const chainSpecs = ctx.specs.filter((s) => !s.isSubAgent);
    const emitters = new Map<string, string[]>();
    const consumers = new Map<string, string[]>();
    for (const s of chainSpecs) {
      for (const e of s.emit ?? []) (emitters.get(e) ?? emitters.set(e, []).get(e)!).push(s.actionName);
      for (const e of s.trigger ?? []) (consumers.get(e) ?? consumers.set(e, []).get(e)!).push(s.actionName);
    }
    const known = compileGraph(ctx.ontology.actions, { domainId: ctx.domain });
    const entrySet = new Set(known.entryEvents);
    const termSet = new Set(known.terminalEvents);
    const breaks: string[] = [];
    for (const s of chainSpecs) {
      for (const e of s.trigger ?? []) if (!emitters.has(e) && !entrySet.has(e)) breaks.push(`「${s.actionName}」等的事件 ${e} 没有上游产出（链路在此断）`);
      for (const e of s.emit ?? []) if (!consumers.has(e) && !termSet.has(e)) breaks.push(`「${s.actionName}」发的事件 ${e} 没有下游消费且非终态（链路悬空）`);
    }
    const ok = breaks.length === 0;
    return { ok, summary: ok ? "链路体检通过：每一跳都接得上 ✓" : `链路有 ${breaks.length} 处断点：${breaks.slice(0, 4).join("；")}`, output: { ok, breaks } };
  },
};

const sandbox_run: BrainTool = {
  name: "sandbox_run",
  description: "把当前这套 agent 部署到沙箱并真跑一次：发入口事件，观察事件链是否端到端到成功终态。返回真实部署证据（部署几个函数、跑了几个、是否到成功终态）。finish 之前必须有一次匹配当前 agent 的 sandbox_run 成功证据。",
  parameters: params({ dry_run: { type: "boolean" } }),
  async execute(args, ctx) {
    if (!ctx.specs.length) return { ok: false, summary: "还没 agent 可部署。" };
    // First-run auto-gate: author full-flow test cases for the user to approve BEFORE
    // any real deploy/fire — so the inputs fed to the sandbox are user-reviewed.
    if (!ctx.testCases?.length && !ctx.awaitingApproval) return proposeTestCases(ctx);
    ctx.spent.sandboxRuns += 1;
    const res = await ctx.ports.sandbox.deployAndObserve(ctx.domain, ctx.specs, {
      dryRun: args.dry_run === true,
      testCases: (ctx.testCases ?? []).map((c) => ({ entryEvent: c.entryEvent, payload: applyTestDataOverrides(c.payload, ctx.testDataOverrides), kind: c.kind })), // #W3-FAULT kind threads to per-kind verdicts
      // #D: thread the user's boundary classification so an external-handoff emit counts as a
      // legitimate terminal in the verdict — not a broken chain (matches validate_graph).
      boundaryEvents: (ctx.boundaryEvents ?? []).map((b) => ({ event: b.event, kind: b.kind })),
    });
    // #AUDIT-FIX(M10) — 证据指纹必须包含【测试用例 + 真实值覆盖】：换了更严的用例后，新一轮
    // 真实失败曾被旧指纹的通过记录 OR 掉（finish 拿陈旧证据过关）。用例变 → 指纹变 → 从零取证。
    const testFp = (() => { let h = 0; const str = JSON.stringify({ c: (ctx.testCases ?? []).map((c) => ({ e: c.entryEvent, p: c.payload, k: c.kind })), o: ctx.testDataOverrides ?? {} }); for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; } return h.toString(36); })();
    // #AUDIT-FIX(P2-03) — 本体内容哈希进证据指纹：本体变化（等量换血）使旧沙箱绿证自动失效。
    const sbFp = `${specsFingerprint(ctx.specs)}:${testFp}:${ontologyContentHash(ctx.ontology)}`;
    // #R3 — grade REAL execution fidelity: does each agent's ACTUAL emitted payload satisfy the
    // downstream field contract? Only for a real (non-simulated) run with captured agentRuns —
    // a simulated/mock run has nothing real to grade (→ undefined ⇒ acceptance stays lenient).
    const canonFields = canonicalEventFields(ctx.ontology);
    const fidelity =
      !res.simulated && Array.isArray(res.agentRuns) && res.agentRuns.length
        ? evaluateExecutionFidelity(res.agentRuns, expectedFieldsByEvent(deriveContractGraph(ctx.specs, ctx.domain, canonFields), canonFields))
        : null;
    const fresh = { specsFingerprint: sbFp, deployed: res.functionsRegistered, agentsRan: res.ran, ranAgents: res.runs.map((r) => r.id), reachedTerminal: res.reachedSuccessTerminal || res.fullChainRan, reachedSuccessTerminal: res.reachedSuccessTerminal, fullChainRan: res.fullChainRan, codeRanAgents: res.codeRanAgents ?? [], degradedAgents: res.degradedAgents, fidelityFailures: fidelity ? fidelity.failingShorts : undefined, simulated: res.simulated ?? false, ts: Date.now() };
    // Keep the STRONGEST evidence across same-fingerprint runs — snapshot-timing flakiness (a re-run
    // that samples too early → ran=0 → reachedSuccessTerminal=false) must NOT downgrade a prior pass,
    // or finish dead-loops. A spec change bumps the fingerprint → start fresh (no stale credit).
    const prev = ctx.lastSandbox;
    // OR the success signals (timing flakiness mustn't downgrade a prior pass) but keep the FRESH
    // degradedAgents — degradation is purely spec-derived (an agent with no tools/hitl), identical
    // across same-fingerprint runs, so never carry a stale "clean" value forward over a new run.
    ctx.lastSandbox = prev && prev.specsFingerprint === sbFp
      ? {
          ...fresh,
          reachedSuccessTerminal: fresh.reachedSuccessTerminal || prev.reachedSuccessTerminal,
          fullChainRan: fresh.fullChainRan || prev.fullChainRan,
          reachedTerminal: fresh.reachedTerminal || prev.reachedTerminal,
          codeRanAgents: [...new Set([...(fresh.codeRanAgents ?? []), ...((prev as { codeRanAgents?: string[] }).codeRanAgents ?? [])])],
          // #R3 review fix — an UNGRADED re-run (no agentRuns captured / simulated) must not launder a
          // prior real fidelity failure into a lenient pass: keep the strongest available evidence.
          fidelityFailures: fresh.fidelityFailures ?? prev.fidelityFailures,
        }
      : fresh;
    ctx.emit({
      t: "sandbox",
      ran: res.ran,
      reachedTerminal: res.reachedSuccessTerminal,
      reachedSuccessTerminal: res.reachedSuccessTerminal,
      agents: ctx.specs.map((s) => s.short),
      events: [],
      appId: res.appId,
      functionsRegistered: res.functionsRegistered,
      registeredIds: res.registeredIds ?? [],
      // #REDESIGN P1a — which agents' GENERATED CODE actually EXECUTED (真跑) vs fell back to
      // declarative. Surfaced as per-agent execution badges in the sandbox panel.
      codeRanAgents: res.codeRanAgents ?? [],
      deployed: res.deployed,
      fullChainRan: res.fullChainRan,
      deployFailed: res.functionsRegistered === 0,
      degradedAgents: res.degradedAgents,
      runUrls: res.runs.map((r) => ({ runId: r.id, url: `#run-${r.id}`, status: r.status, fn: r.id })),
      agentRuns: res.agentRuns ?? [],
      cases: (ctx.testCases ?? []).map((c) => ({ name: c.name, entryEvent: c.entryEvent, payload: c.payload })),
      // #W3-FAULT — per-kind verdicts (incl. fault: passed = chain refused a success terminal under
      // an injected fault). Dropped previously; now surfaced so the UI can prove error propagation.
      caseVerdicts: res.caseVerdicts,
      simulated: res.simulated,
      // #R3 — which agents' REAL emit payload violated the downstream contract (execution fidelity).
      fidelityFailures: fidelity?.failingShorts,
      // #D: how the chain closed — N internal chains + M legitimate external handoffs.
      internalChains: res.internalChains,
      externalTerminals: res.externalTerminals,
    });
    // #SCALE-TOOLS — record per-tool sandbox outcomes (empirical effectiveness): every tool bound to
    // an agent that RAN gets invoked++, succeeded++ when that agent's run status is ok. Best-effort.
    if (ctx.ports.toolStats && Array.isArray(res.agentRuns)) {
      for (const ar of res.agentRuns) {
        const sp = ctx.specs.find((x) => x.short === ar.agentShort || x.slug === ar.agentSlug);
        for (const tname of sp?.tools ?? []) {
          void ctx.ports.toolStats.record(tname, ar.status === "ok" || ar.status === "Completed").catch(() => {});
        }
      }
    }
    // #ATTRIB — 保真违约的结构化定位：join 契约图，产出"回哪个 agent、改什么"的定点指令。
    // 论据：LLM 事后读日志归因仅 53.5% 准——所以这里直接把答案算出来，别让大脑猜。
    const attribution = fidelity && !fidelity.ok
      ? attributeFidelityFailures(fidelity, deriveContractGraph(ctx.specs, ctx.domain, canonFields))
      : [];
    const attribNote = attribution.length ? `\n${attributionSummary(attribution)}` : "";
    // #P3 — 独立监督者审计:客观证据(保真违约归因)→ 版本锁定缺陷,结转+复验(证据消失且指纹已变才关闭)。
    // 证据指纹变 → sandboxSeq+1 作"版本"信号。finish 门读 ctx.defects 的阻塞数清零。
    if (!prev || prev.specsFingerprint !== sbFp) ctx.sandboxSeq = (ctx.sandboxSeq ?? 0) + 1;
    const sbSeq = ctx.sandboxSeq ?? 1;
    const sbVersions = Object.fromEntries(ctx.specs.map((s) => [s.slug, sbSeq]));
    ctx.defects = reconcileDefects(ctx.defects ?? [], supervisorAudit({ attribution, versions: sbVersions }), sbVersions);
    const openDefects = blockingDefects(ctx.defects);
    const supervisorNote = ctx.defects.length ? `\n${supervisorSummary(ctx.defects)}` : "";
    if (openDefects.length) ctx.emit({ t: "reflect", kind: "supervisor", lesson: supervisorSummary(ctx.defects) });
    // #REVISION — 本体漂移对账：真实载荷与 canonical 持续不一致 → 修订提案（提案不写回，
    // 大脑走 ask_user 确认）。只在真实（非模拟）运行上取证。
    const revisions = !res.simulated && Array.isArray(res.agentRuns) && res.agentRuns.length && canonFields
      ? proposeOntologyRevisions(res.agentRuns, canonFields)
      : [];
    if (revisions.length) ctx.emit({ t: "ontology.revision", proposals: revisions });
    const revisionNote = revisions.length ? `\n${revisionSummary(revisions)}` : "";
    const ok = res.functionsRegistered > 0 && res.fullChainRan && (fidelity?.ok ?? true);
    // Be honest: a simulated pass is graph-closure inference, NOT a real run. Say so in
    // the summary the brain reads (so it never claims a real "跑通"); FACTORY_REAL_DEPLOY=1 for real.
    const simNote = res.simulated ? "（⚠ 模拟验证：按事件图闭包推断会跑通，未真实部署执行；设 FACTORY_REAL_DEPLOY=1 做真实部署验证）" : "（真实部署执行 ✓）";
    // R2: a swallowed fire used to look like a silent ran:0 — now surface which entry events failed to dispatch.
    const failedFires = (res.fires ?? []).filter((f) => !f.ok);
    const fireNote = failedFires.length ? ` · ⚠ ${failedFires.length} 个入口事件没发成功：${failedFires.map((f) => `${f.event}(${f.error ?? "失败"})`).join("；")}` : "";
    // #AUDIT-FIX(H2) — 环境归因：app 没在 Inngest 完成注册时 ran:0 是【环境问题】，绝不能让
    // 大脑当成"事件名没对齐"去 refine agents（既往 finish-loop 死循环的同类根因）。
    const envNote = !res.simulated && res.appReady === false
      ? ` · 🛑 环境问题：沙箱 app 未在 Inngest dev server 完成注册${res.syncError ? `（${res.syncError.slice(0, 120)}）` : "（readiness 超时）"}——ran:0 与 agent 设计无关，检查 Inngest 是否在跑 / AGENTIC_SERVE_ORIGIN 配置，别去改 agent`
      : "";
    // Phase 5 — close the reflection loop: a non-passing sandbox run AUTO-records a failure
    // reflection (it never did before — the brain had to remember to analyze_failure), so the next
    // build for this domain learns from it without manual prompting.
    if (!ok) {
      const lesson = (!res.simulated && res.appReady === false)
        ? `环境问题：沙箱 app 未在 Inngest 注册成功${res.syncError ? `（${res.syncError.slice(0, 100)}）` : ""}——ran:0 不是 agent 设计问题；先修环境（Inngest dev server / serve URL），别 refine agent。`
        : attribution.length
        ? `保真违约（emit 载荷不满足下游契约）：${attribution.map((a) => `${a.agentShort}→${a.event}(${a.recommend})`).join("；")}。按定位指令定点修，别整链重造。`
        : res.degradedAgents.length
          ? `降级 agent：${res.degradedAgents.join("、")} —— 多为没绑到真实工具。下次先 ask_user 接入真实工具/补 I/O 契约，再 design_agent。`
          : failedFires.length
            ? `入口事件没发成功：${failedFires.map((f) => f.event).join("、")} —— 检查事件名是否对齐本体、Inngest 是否在跑。`
            : "事件链没到成功终态——用 inspect_run 看断在哪个 agent，多半是 trigger/emit 没对齐本体事件名。";
      await ctx.ports.reflection.record(ctx.domain, { summary: `沙箱未跑通：部署${res.functionsRegistered}·跑${res.ran}·成功终态=${res.reachedSuccessTerminal}${fidelity && !fidelity.ok ? `·保真${Math.round(fidelity.fidelity * 100)}%` : ""}`, lesson, failedStep: fidelity && !fidelity.ok ? "execution_fidelity" : "sandbox_chain", kind: "failure" }).catch(() => {});
    }
    return { ok, summary: ok ? `沙箱已部署 ${res.functionsRegistered} 函数、跑 ${res.ran}、到成功终态 ✓${fidelity ? `、保真 ${Math.round(fidelity.fidelity * 100)}%` : ""}${simNote}${fireNote}${revisionNote}` : `沙箱未完全跑通：部署 ${res.functionsRegistered}、跑 ${res.ran}、成功终态=${res.reachedSuccessTerminal}${fidelity && !fidelity.ok ? `、保真违约 ${fidelity.failingShorts.join("、")}` : ""}${res.degradedAgents.length ? `、降级:${res.degradedAgents.join("、")}` : ""}${res.simulated ? "（模拟）" : ""}${fireNote}${envNote}${attribNote}${supervisorNote}${revisionNote}`, output: res };
  },
};

const inspect_run: BrainTool = {
  name: "inspect_run",
  description: "看上次 sandbox_run 每个 agent 的执行结果（跑没跑、是否降级、断在哪），用来诊断链路为什么没跑通，而不是盲目重试。",
  parameters: params({ failed_only: { type: "boolean" } }),
  async execute(args, ctx) {
    if (!ctx.lastSandbox) return { ok: false, summary: "还没 sandbox_run，没有可诊断的运行。" };
    const ran = new Set(ctx.lastSandbox.ranAgents);
    const degraded = new Set(ctx.lastSandbox.degradedAgents);
    const rows = ctx.specs
      .map((s) => ({ agentSlug: s.slug, short: s.nameZh, status: ran.has(s.slug) ? (degraded.has(s.short) ? "degraded" : "ran") : "missed", degraded: degraded.has(s.short) }))
      .filter((r) => (args.failed_only ? r.status !== "ran" : true));
    for (const r of rows) ctx.emit({ t: "inspect", runId: "sandbox", agentSlug: r.agentSlug, status: r.status, degraded: r.degraded });
    const broken = rows.filter((r) => r.status !== "ran");
    return { ok: true, summary: broken.length ? `${broken.length} 个 agent 没正常跑：${broken.map((r) => `${r.short}(${r.status})`).join("、")}` : "上次运行每个 agent 都正常跑了 ✓", output: { rows } };
  },
};

const read_spec: BrainTool = {
  name: "read_spec",
  description: "读出某个已设计 agent 的完整规格（system prompt、工具、IO schema、精修历史、代码），修订前看清上次设计了什么，或做跨 agent 一致性检查。",
  parameters: params({ action: { type: "string" } }, ["action"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const spec = ctx.specs.find((s) => s.actionName === name);
    if (!spec) return { ok: false, summary: `还没设计过「${name}」。` };
    return { ok: true, summary: `「${spec.nameZh}」：工具 ${spec.tools.length} · 精修 ${(ctx.attemptHistory[name] ?? []).length} 次 · 代码 ${spec.codeSource ?? "无"}`, output: { spec: { actionName: spec.actionName, slug: spec.slug, systemPrompt: spec.systemPrompt, tools: spec.tools, unresolvedTools: spec.unresolvedTools, decisionLogic: spec.decisionLogic, inputSchema: spec.inputSchema, outputSchema: spec.outputSchema, codeSource: spec.codeSource, generatedCode: spec.generatedCode }, attemptHistory: ctx.attemptHistory[name] ?? [] } };
  },
};

const score_spec: BrainTool = {
  name: "score_spec",
  description: "给一个已设计 agent 打分（4 维 0-100：工具接地 / prompt 丰富度 / 分支覆盖 / 精修健康），返回总分 + 等级 + 最弱维度，帮你决定要不要再 refine。",
  parameters: params({ action: { type: "string" } }, ["action"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const spec = ctx.specs.find((s) => s.actionName === name);
    if (!spec) return { ok: false, summary: `还没设计过「${name}」。` };
    const dims = scoreSpec(spec, (ctx.attemptHistory[name] ?? []).length);
    const total = scoreTotal(dims);
    const weakest = (Object.entries(dims).sort((a, b) => a[1] - b[1])[0] ?? ["", 0]) as [string, number];
    return { ok: true, summary: `「${spec.nameZh}」总分 ${total}（${grade(total)}）· 最弱：${weakest[0]} ${weakest[1]}`, output: { total, grade: grade(total), dimensions: dims, weakest: weakest[0] } };
  },
};

const diff_spec: BrainTool = {
  name: "diff_spec",
  description: "对比一个 agent 当前版本 vs 上一次 refine 之前的快照（看这轮精修到底改了什么）。",
  parameters: params({ action: { type: "string" } }, ["action"]),
  async execute(args, ctx) {
    const name = String(args.action ?? "").trim();
    const spec = ctx.specs.find((s) => s.actionName === name);
    const history = ctx.attemptHistory[name];
    if (!spec || !history?.length) return { ok: false, summary: `「${name}」没有精修历史可对比。` };
    const prior = history[history.length - 1]!.priorSpecSnapshot;
    const added = spec.tools.filter((t) => !prior.tools.includes(t));
    const removed = prior.tools.filter((t) => !spec.tools.includes(t));
    return { ok: true, summary: `工具 +[${added.join("、") || "无"}] -[${removed.join("、") || "无"}] · prompt ${prior.systemPrompt === spec.systemPrompt ? "未变" : "已变"}`, output: { toolsAdded: added, toolsRemoved: removed, promptChanged: prior.systemPrompt !== spec.systemPrompt } };
  },
};

const review_agent: BrainTool = {
  name: "review_agent",
  description: "独立审查所有已设计 agent 是否合规：规则校验闸口是否绑了动态抓规则、prompt 是否为空、非校验 agent 是否误写了规则。返回需要修的清单。",
  parameters: params({}),
  async execute(_args, ctx) {
    // Tier 1 — free deterministic set-membership checks (fast, certain).
    const findings: string[] = [];
    const ruleIds = ruleIdentifiers(ctx); // #9: ontology-driven, not RAAS's \d-\d scheme
    for (const s of ctx.specs) {
      if (!s.systemPrompt.trim()) findings.push(`「${s.nameZh}」prompt 为空`);
      if (specIsRuleGate(s) && !s.tools.includes("ontology.fetchActionRules")) findings.push(`「${s.nameZh}」是校验闸口但没绑 ontology.fetchActionRules`);
      const txt = `${s.systemPrompt}\n${s.decisionLogic ?? ""}`;
      if (!specIsRuleGate(s) && promptEmbedsRule(txt, ruleIds)) findings.push(`「${s.nameZh}」非校验 agent 写进了具体业务规则`);
      // #REDESIGN FU3 — surface reviewLoop PROBE downgrades: code that compiled+linted but didn't load
      // a callable handler, so it fell back to declarative. Legible instead of silent.
      if (s.probeReason) findings.push(`「${s.nameZh}」代码未过加载探针（已回退声明式执行）：${s.probeReason}`);
    }
    // Tier 2 — independent cite-the-span LLM JUDGE on the SEMANTIC question code can't decide:
    // does each rule-gate's prompt ACTUALLY fetch rules at runtime (vs hardcode), and does each
    // prompt truly fit the agent's responsibility? Layered on the free pass; best-effort + must cite.
    let judge: string[] = [];
    if (isGatewayConfigured() && ctx.specs.length) {
      const digest = ctx.specs
        .map((s) => `## ${s.actionName}（${specIsRuleGate(s) ? "规则闸口" : "普通"} · 工具:${s.tools.join(",") || "无"}）\nsystem_prompt:\n${(s.systemPrompt || "").slice(0, 1400)}\n决策逻辑: ${(s.decisionLogic || "").slice(0, 500)}`)
        .join("\n\n");
      const sys =
        "你是 agent 设计的【独立质检裁判】。对每个 agent 判断并【必须引用它 prompt 里的片段为证】：(1) 若是规则闸口，它的 prompt 是否让它【运行时按上下文动态抓规则核对】而不是把具体规则写死；(2) prompt 是否真的贴合该动作的职责、不是空泛套话或张冠李戴。只输出 JSON 数组：" +
        '[{"agent":string,"issue":string,"evidence":string}]（evidence 必须是引用的 prompt 原文片段）。没问题就输出 []。不要任何其它文字。';
      try {
        const arr = (await chatJson<Array<Record<string, unknown>>>(sys, digest, { temperature: 0.2, maxTokens: 4000, signal: ctx.signal, models: modelChain("review"), purpose: "review_agent.judge" })) ?? [];
        if (Array.isArray(arr)) judge = arr.filter((x) => x && x.issue).map((x) => `🧠裁判·「${String(x.agent ?? "")}」: ${String(x.issue)}${x.evidence ? `（证据「${String(x.evidence).slice(0, 70)}」）` : ""}`);
      } catch {
        /* best-effort — fall back to the deterministic pass */
      }
    }
    // Tier 3 (#REDESIGN FU3) — CODE critique for the agents graded truly executable (CodeAct). Their
    // handler runs for real in the sandbox, so review whether the code actually DOES its job (calls
    // ctx.tool/ctx.reason per the decision logic, emits its declared output event) vs. a shell that
    // compiles+loads but returns a constant. One batched review-tier pass over ONLY executable specs
    // (declarative scaffolds don't run — skip them). Best-effort; must cite the code span.
    let codeCritique: string[] = [];
    const execSpecs = ctx.specs.filter((s) => s.codeExecuted && (s.generatedCode ?? "").trim());
    if (isGatewayConfigured() && execSpecs.length) {
      const digest = execSpecs
        .map((s) => `## ${s.actionName}（期望 emit:${(s.emit ?? []).join(",") || "—"} · 工具:${s.tools.join(",") || "无"}）\n决策逻辑: ${(s.decisionLogic || "").slice(0, 300)}\n代码:\n${(s.generatedCode || "").slice(0, 1500)}`)
        .join("\n\n");
      const sys =
        "你是【生成代码质检】。下列 agent 的 handler 会在沙箱里【真实执行】(CodeAct)。逐个判断代码是不是【真的在做事】并【引用代码原文为证】：(1) 是否按决策逻辑调用了 ctx.tool/ctx.tools.run 或 ctx.reason；(2) 是否 emit 了它声明的产出事件；(3) 是不是只是编译能过、但 handler 直接 return 常量的空壳。只输出 JSON 数组：" +
        '[{"agent":string,"issue":string,"evidence":string}]（evidence 必须引用代码原文片段）。没问题就输出 []。不要任何其它文字。';
      try {
        const arr = (await chatJson<Array<Record<string, unknown>>>(sys, digest, { temperature: 0.2, maxTokens: 4000, signal: ctx.signal, models: modelChain("review"), purpose: "review_agent.code" })) ?? [];
        if (Array.isArray(arr)) codeCritique = arr.filter((x) => x && x.issue).map((x) => `⚙代码·「${String(x.agent ?? "")}」: ${String(x.issue)}${x.evidence ? `（证据「${String(x.evidence).slice(0, 60)}」）` : ""}`);
      } catch {
        /* best-effort — the deterministic + design passes still hold */
      }
    }
    const all = [...findings, ...judge, ...codeCritique];
    if (codeCritique.length) ctx.emit({ t: "reflect", kind: "code-critique", lesson: `生成代码质检 ${codeCritique.length} 处：${codeCritique.slice(0, 3).join("；")}` });
    return { ok: all.length === 0, summary: all.length ? `审查发现 ${all.length} 处问题：${all.slice(0, 4).join("；")}` : "审查通过：确定性检查 + LLM 设计裁判 + 生成代码质检均合规 ✓", output: { findings: all, deterministic: findings, judge, codeCritique } };
  },
};

// #REVIEW 透镜② · 上下文审查 —— 生成期三重审查环的第二环:每个 agent 是否【读懂并契合了自己的上下文】。
// 确定性层查触发/产出事件是否存在于本体 + 契约图字段缺口;LLM 层对照 ontologyUnderstanding 查语义误读/张冠李戴。
const review_context: BrainTool = {
  name: "review_context",
  description:
    "上下文审查(生成期审查环·透镜②):对照本体理解 + 字段契约图,逐个 agent 判它是否【读懂并契合了自己的上下文】——触发事件的业务语义、上游产出、下游所需、I/O 是否对齐,有没有张冠李戴。发现问题就 refine 再审。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    if (!ctx.specs.length) return { ok: false, summary: "还没设计 agent，无从审查上下文。" };
    // Tier 1 — deterministic: trigger/emit events must exist in the ontology; field contract gaps.
    const findings: string[] = [];
    const knownEvents = new Set(ctx.ontology.actions.flatMap((a) => [...a.trigger, ...a.triggered_event]));
    for (const s of ctx.specs) {
      for (const t of s.trigger ?? []) if (t && !knownEvents.has(t)) findings.push(`「${s.nameZh}」触发事件「${t}」本体里不存在（张冠李戴?）`);
      for (const e of s.emit ?? []) if (e && e !== "—" && !knownEvents.has(e)) findings.push(`「${s.nameZh}」产出事件「${e}」本体里不存在`);
    }
    const contract = deriveContractGraph(ctx.specs, ctx.domain, canonicalEventFields(ctx.ontology));
    for (const line of contractIssueStringsBySeverity(contract).hard) findings.push(line); // #SIMPLIFY 结构化分级
    // Tier 2 — LLM: did each agent READ its context correctly (vs the ontology understanding)?
    let judge: string[] = [];
    if (isGatewayConfigured()) {
      const understanding = ctx.ontologyUnderstanding ? `【本体理解摘要】\n${ctx.ontologyUnderstanding.slice(0, 1500)}\n\n` : "";
      const digest =
        understanding +
        ctx.specs.map((s) => `## ${s.actionName}\n触发:${(s.trigger ?? []).join(",") || "—"} → 产出:${(s.emit ?? []).join(",") || "—"} · 工具:${s.tools.join(",") || "无"}\nsystem_prompt:${(s.systemPrompt || "").slice(0, 900)}`).join("\n\n");
      const sys =
        "你是【上下文审查】。对照本体理解,逐个 agent 判并【引用 prompt 片段为证】:(1) 是否读懂了它触发事件的业务语义;(2) 消费/产出的字段是否和上下游对齐;(3) 有没有把 A 动作的职责误当 B(张冠李戴)。只输出 JSON 数组:" +
        '[{"agent":string,"issue":string,"evidence":string}]。没问题就输出 []。不要任何其它文字。';
      try {
        const arr = (await chatJson<Array<Record<string, unknown>>>(sys, digest, { temperature: 0.2, maxTokens: 4000, signal: ctx.signal, models: modelChain("review"), purpose: "review_context" })) ?? [];
        if (Array.isArray(arr)) judge = arr.filter((x) => x && x.issue).map((x) => `🧭上下文·「${String(x.agent ?? "")}」: ${String(x.issue)}${x.evidence ? `（证据「${String(x.evidence).slice(0, 60)}」）` : ""}`);
      } catch {
        /* best-effort — deterministic pass still holds */
      }
    }
    const all = [...findings, ...judge];
    ctx.emit({ t: "reflect", kind: "context-review", lesson: all.length ? `上下文审查 ${all.length} 处：${all.slice(0, 3).join("；")}` : "上下文审查:各 agent 读懂并契合上下文 ✓" });
    return { ok: all.length === 0, summary: all.length ? `上下文审查发现 ${all.length} 处：${all.slice(0, 4).join("；")}` : "上下文审查通过 ✓", output: { findings: all, deterministic: findings, judge } };
  },
};

// #REVIEW 透镜③ · 完整性/元认知审查 —— 生成期三重审查环的第三环:【是否都思考全了】。
// 确定性层查覆盖/分支/规则绑定/裸 agent;LLM 层做元认知"还有什么没想到"——运行时事实(错误分类/foreach/HITL/外部交接/边界)。
const review_completeness: BrainTool = {
  name: "review_completeness",
  description:
    "完整性/元认知审查(生成期审查环·透镜③):审查【是否都思考全了】——所有 Agent 动作覆盖了吗、多分支事件是否都分流、运行时事实(失败该 throw 还是 emit 失败事件/可恢复 vs 业务失败/集合入参 foreach/HITL/外部交接/边界)想到了吗、规则闸口是否都绑定。返回『还缺什么』清单。finish 前的元认知门。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    // Tier 1 — deterministic completeness checks.
    const gaps: string[] = [];
    const agentActions = ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name);
    const done = new Set(ctx.specs.map((s) => s.actionName));
    const uncovered = agentActions.filter((n) => !done.has(n));
    if (uncovered.length) gaps.push(`漏了 ${uncovered.length} 个 Agent 动作没设计:${uncovered.join("、")}`);
    for (const s of ctx.specs) {
      const emits = (s.emit ?? []).filter((e) => e && e !== "—");
      if (emits.length >= 2 && !(s.plan && s.plan.some((p) => p.kind === "condition"))) gaps.push(`「${s.nameZh}」有 ${emits.length} 个分支产出(${emits.join("/")})但没有 condition 分支步——多结果未分流?`);
      if (specIsRuleGate(s) && !s.tools.includes("ontology.fetchActionRules")) gaps.push(`「${s.nameZh}」规则闸口未绑动态抓规则`);
      if ((s.tools ?? []).length === 0 && !s.hitl) gaps.push(`「${s.nameZh}」没绑任何工具(是否漏了外部集成?)`);
    }
    // Tier 2 — metacognitive LLM: given the understanding + designed specs, what's MISSING?
    let missing: string[] = [];
    if (isGatewayConfigured() && ctx.specs.length) {
      const understanding = ctx.ontologyUnderstanding ? `【本体理解(含 ambiguities/risks/externalHandoffs)】\n${ctx.ontologyUnderstanding.slice(0, 1800)}\n\n` : "";
      const digest =
        understanding +
        `【已设计 ${ctx.specs.length} 个 agent】\n` +
        ctx.specs.map((s) => `· ${s.actionName}: 触发 ${(s.trigger ?? []).join(",") || "—"} → ${(s.emit ?? []).join(",") || "—"} · plan ${s.plan?.length || 0} 步`).join("\n");
      const sys =
        "你是【完整性/元认知审查】。别复述已做的——只找【还没想到的】。逐条判断:(1) 有没有 Agent 动作/事件分支被漏掉;(2) 运行时事实是否想全了:失败该 throw 还是 emit 失败事件、可恢复(infra)vs 业务失败、集合入参要不要 foreach、要不要 HITL、有没有外部交接终态被当断链;(3) 有没有边界/异常场景没处理;(4) 规则是否都绑定。只输出 JSON 数组:" +
        '[{"gap":string,"severity":"high"|"med"|"low"}]。都想全了就输出 []。不要任何其它文字。';
      try {
        const arr = (await chatJson<Array<Record<string, unknown>>>(sys, digest, { temperature: 0.3, maxTokens: 4000, signal: ctx.signal, models: modelChain("review"), purpose: "review_completeness" })) ?? [];
        if (Array.isArray(arr)) missing = arr.filter((x) => x && x.gap).map((x) => `🧩[${String(x.severity ?? "med")}] ${String(x.gap)}`);
      } catch {
        /* best-effort — deterministic pass still holds */
      }
    }
    const all = [...gaps, ...missing];
    const high = gaps.length + missing.filter((m) => m.includes("[high]")).length;
    ctx.emit({ t: "reflect", kind: "completeness", lesson: all.length ? `完整性审查 ${all.length} 处未想全(${high} 重要):${all.slice(0, 3).join("；")}` : "完整性审查:覆盖/分支/运行时事实/规则均已想全 ✓" });
    return {
      ok: all.length === 0,
      summary: all.length ? `完整性审查:还有 ${all.length} 处没想全(${high} 重要):${all.slice(0, 4).join("；")}` : "完整性审查通过:都想全了 ✓",
      output: { gaps: all, deterministic: gaps, missing, blocking: high > 0 },
    };
  },
};

const list_agents: BrainTool = {
  name: "list_agents",
  description: "列出已设计的所有 agent + 还没覆盖的 actor=Agent 动作，掌握进度。",
  parameters: params({}),
  async execute(_args, ctx) {
    const agentActions = ctx.ontology ? ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name) : [];
    const done = new Set(ctx.specs.map((s) => s.actionName));
    const remaining = agentActions.filter((n) => !done.has(n));
    return { ok: true, summary: `已设计 ${ctx.specs.length} · 还差 ${remaining.length}：${remaining.join("、") || "无"}`, output: { agents: ctx.specs.map(cardOf), remaining } };
  },
};

const list_domains: BrainTool = {
  name: "list_domains",
  description: "列出工厂可以生成的所有业务域（当用户问『有几个域』『都有哪些域』这类信息问题时用，不必跑生成流水线）。",
  parameters: params({}),
  async execute(_args, ctx) {
    const domains = await ctx.ports.ontology.listDomains();
    return { ok: true, summary: `共 ${domains.length} 个业务域：${domains.map((d) => d.name ?? d.id).join("、")}`, output: { domains } };
  },
};

const describe_domain: BrainTool = {
  name: "describe_domain",
  description: "概述一个业务域的规模（多少动作/事件/对象/规则、多少要造 agent），回答信息类问题用，不跑生成。",
  parameters: params({ domain: { type: "string", description: "域 id，省略=当前域" } }),
  async execute(args, ctx) {
    const id = String(args.domain ?? ctx.domain).trim();
    try {
      const ont = await ctx.ports.ontology.fetchOntology(id);
      const agentN = ont.actions.filter((a) => a.actor.includes("Agent")).length;
      return { ok: true, summary: `「${id}」：${ont.actions.length} 动作（${agentN} 个要造 agent）· ${ont.events.length} 事件 · ${ont.objects.length} 对象 · ${ont.rules.length} 规则`, output: { domain: id, actions: ont.actions.length, agentActions: agentN, events: ont.events.length, objects: ont.objects.length, rules: ont.rules.length } };
    } catch (e) {
      return { ok: false, summary: `读不到域「${id}」：${(e as Error).message}` };
    }
  },
};

const describe_object: BrainTool = {
  name: "describe_object",
  // #3/#4 (memory recall): targeted retrieval of ONE DataObject's full detail from the cached
  // ontology — so after context compaction, the brain can recover an object's exact field names
  // (to write input_schema/output_schema) WITHOUT a full, heavy read_ontology re-fetch.
  description: "取回某个数据对象(DataObject)的完整属性(主键 + 每个字段的 name/type/description)。压缩后忘了对象字段、要写 input_schema/output_schema 时用，避免重新全量 read_ontology。",
  parameters: params({ name: { type: "string", description: "对象 id 或显示名（read_ontology data_objects[].id/name）" } }, ["name"]),
  async execute(args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    const q = String(args.name ?? "").trim().toLowerCase();
    if (!q) return { ok: false, summary: "要给对象 id 或名字。" };
    const objs = ctx.ontology.objects;
    const o =
      objs.find((x) => x.id.toLowerCase() === q || (x.name ?? "").toLowerCase() === q) ??
      objs.find((x) => x.id.toLowerCase().includes(q) || (x.name ?? "").toLowerCase().includes(q));
    if (!o) return { ok: false, summary: `找不到对象「${args.name}」。现有对象：${objs.map((x) => x.name || x.id).slice(0, 40).join("、")}` };
    const props = o.properties ?? [];
    return {
      ok: true,
      summary: `对象「${o.name || o.id}」：主键 ${o.primary_key ?? "—"} · ${props.length} 个属性：${props.map((p) => p.name).slice(0, 30).join("、")}`,
      output: { id: o.id, name: o.name, description: o.description, primary_key: o.primary_key, properties: props },
    };
  },
};

const web_search: BrainTool = {
  name: "web_search",
  description: "联网搜索开发文档/行业规则/字段含义等外部知识，结果会作为 grounding 喂进后续 agent 设计。仅在确实需要外部事实时用。",
  parameters: params({ query: { type: "string" } }, ["query"]),
  async execute(args, ctx) {
    const query = String(args.query ?? "").trim();
    if (!ctx.ports.web) return { ok: true, summary: "联网搜索未配置（FactoryPorts.web 缺省）——跳过，用本体已有信息继续。", output: { results: [] } };
    const results = await ctx.ports.web.search(query).catch(() => []);
    if (results.length) {
      ctx.research.push({ query, findings: results.map((r) => `${r.title}: ${r.snippet}`).join("\n") });
      ctx.emit({ t: "web.result", query, results });
    }
    return { ok: true, summary: `搜「${query}」→ ${results.length} 条结果`, output: { results } };
  },
};

// #P2 — skills are woven RAW into every relevant agent's prompt, so a malicious/noisy skill fragment
// is a prompt-injection surface that poisons all downstream agents. Neutralize role markers +
// instruction-override patterns before storing/weaving. Returns the cleaned text + whether it tripped.
const SKILL_INJECTION =
  /(?:^|\n)[ \t]*(?:system|assistant|user)[ \t]*[:：]|ignore[ \t]+(?:all[ \t]+|the[ \t]+)?(?:previous|above|prior)[ \t]+(?:instructions?|rules?|prompts?)|disregard[ \t]+[^\n]{0,24}(?:instructions?|rules?)|you[ \t]+are[ \t]+now[ \t]|<\/?[ \t]*(?:system|instructions?)[ \t]*>/gi;
export function sanitizeSkillFragment(text: string): { clean: string; flagged: boolean } {
  let flagged = false;
  const clean = text.replace(SKILL_INJECTION, () => {
    flagged = true;
    return "[已移除可疑指令片段]";
  });
  return { clean, flagged };
}

const create_skill: BrainTool = {
  name: "create_skill",
  description: "把一段可复用的 know-how 沉淀成技能：织入 agent prompt 的指导片段 + 推荐工具 + 决策规则。会①本次运行织进 design_agent，②持久化到技能库供以后复用。general=true 则跨域可用。先 use_skill 看库里有没有现成的。",
  parameters: params({ name: { type: "string" }, purpose: { type: "string" }, prompt_fragment: { type: "string" }, tools: { type: "array", items: { type: "string" } }, decision_rule: { type: "string" }, general: { type: "boolean" } }, ["name", "purpose", "decision_rule"]),
  async execute(args, ctx) {
    const name = String(args.name ?? "").trim();
    const promptFragment = String(args.prompt_fragment ?? "").trim();
    const decisionRule = String(args.decision_rule ?? "").trim();
    // #REDESIGN P3 — lightweight review: a skill gets woven into EVERY relevant agent's prompt, so it
    // must carry SUBSTANTIVE, reusable know-how — reject an empty/trivial skill (noise), and reject one
    // that hardcodes a specific business rule (rules belong in the rule-gate, fetched at runtime).
    // A real skill needs a substantive prompt_fragment (the reusable guidance woven into agents) AND
    // a real decision_rule — trivial content just dilutes every prompt it touches.
    if (promptFragment.length < 24 || decisionRule.length < 8) {
      return { ok: false, summary: `技能「${name}」内容太空——prompt_fragment 需 ≥24 字的实质指导、decision_rule 需 ≥8 字，别把空话织进 agent。`, output: { rejected: "empty" } };
    }
    if (promptEmbedsRule(`${promptFragment}\n${decisionRule}`, ruleIdentifiers(ctx))) {
      return { ok: false, summary: `技能「${name}」把具体业务规则写死进了片段——规则应留给校验闸口在运行时动态抓，别织进通用技能。`, output: { rejected: "rule_leak" } };
    }
    // #P2 — sanitize prompt-injection out of the fragment before it's woven into every relevant agent.
    const san = sanitizeSkillFragment(promptFragment);
    if (san.flagged) ctx.emit({ t: "reflect", kind: "skill-sanitize", lesson: `技能「${name}」的片段含疑似 prompt 注入指令，已中和后再织入。` });
    const skill = { name, purpose: String(args.purpose ?? ""), promptFragment: san.clean, tools: (args.tools as string[]) ?? [], decisionRule };
    ctx.createdSkills.push(skill);
    ctx.emit({ t: "skill.created", name, purpose: skill.purpose });
    if (ctx.ports.skills) {
      const slug = kebab(name);
      await ctx.ports.skills.save({ slug, name, purpose: skill.purpose, promptFragment: skill.promptFragment, tools: skill.tools, decisionRule: skill.decisionRule, domain: args.general ? null : ctx.domain }).catch(() => {});
    }
    // #W3-3 — RETROACTIVE weaving: agents designed BEFORE this skill existed never benefited (only
    // future design_agent calls wove skills). Weave the new skill into every existing spec that
    // doesn't carry it yet, and re-grade their rendered code. Sandbox evidence invalidates.
    const retroWove: string[] = [];
    for (const sp of ctx.specs ?? []) {
      const line = `· ${skill.name}：${skill.decisionRule}`;
      if (sp.systemPrompt.includes(line)) continue;
      sp.systemPrompt += sp.systemPrompt.includes("【可复用技能】") ? `\n${line}` : `\n\n【可复用技能】\n${line}`;
      if (sp.codeSource !== "ai") await renderExecutableCode(sp);
      retroWove.push(sp.short);
    }
    if (retroWove.length) ctx.lastSandbox = null;
    return { ok: true, summary: `技能「${name}」已创建${ctx.ports.skills ? "并入库" : "（本次运行内）"}${retroWove.length ? `，并已【追溯织入】${retroWove.length} 个已设计 agent(${retroWove.slice(0, 4).join("、")})` : "，会织进相关 agent"}。`, output: { name, retroWove } };
  },
};

const use_skill: BrainTool = {
  name: "use_skill",
  description: "查看/复用技能库里已有的技能（以前运行沉淀的 know-how）。不传 name → 列出本域可用技能；传 name → 调入本次运行，design_agent 会织进对应 agent。设计前先看一眼能不能复用。",
  parameters: params({ name: { type: "string" } }),
  async execute(args, ctx) {
    if (!ctx.ports.skills) return { ok: true, summary: "技能库未配置。需要时用 create_skill 在本次运行内创建。", output: { skills: [] } };
    const available = await ctx.ports.skills.list(ctx.domain).catch(() => []);
    const want = String(args.name ?? "").trim();
    if (!want) return { ok: true, summary: available.length ? `技能库有 ${available.length} 个：${available.map((s) => `${s.name}(用过${s.useCount}次)`).join("、")}` : "技能库为空。", output: { skills: available.map((s) => ({ slug: s.slug, name: s.name, purpose: s.purpose, useCount: s.useCount })) } };
    const found = available.find((s) => s.slug === kebab(want) || s.name === want);
    if (!found) return { ok: false, summary: `技能库里没有「${want}」。`, output: {} };
    ctx.createdSkills.push({ name: found.name, purpose: found.purpose, promptFragment: found.promptFragment, tools: found.tools, decisionRule: found.decisionRule });
    await ctx.ports.skills.bumpUse(found.slug).catch(() => {});
    ctx.emit({ t: "skill.created", name: found.name, purpose: found.purpose });
    return { ok: true, summary: `已调入技能「${found.name}」，会织进相关 agent。`, output: { name: found.name } };
  },
};

// #P5 — 能力梯:发现"需要一个当前没有的能力"时,按六级从便宜到贵解析怎么获得它。这是【顾问式】
// 工具——它综合你已经用 search_tools/list_agents 查到的命中(经参数传入)+ 技能库现状,给出该走哪级
// + 下一步该调哪个工具。真正的实例化/锻造执行(instantiate_subagent / skill_forge)依赖站长工具面
// (P2.5),本工具先把决策与路由做对、可解释。
const resolve_capability_ladder: BrainTool = {
  name: "resolve_capability_ladder",
  description:
    "能力梯(#P5):当你或某 agent 需要一个当前没有的能力时,用它决定怎么获得——六级从便宜到贵:①复用已交付函数 ②工具库 ③MCP ④实例化 active 技能 ⑤锻造新技能(带 spawnSpec,落 draft,监督下首用)⑥造工具。传 need 描述;若你已用 search_tools/list_agents 查到命中,把 fleet_has/tool_hit/mcp_hit 传进来;能力本质是缺工具就传 is_missing_tool=true。返回推荐动作 + 下一步该调的工具。",
  parameters: params(
    {
      need: { type: "string", description: "缺什么能力(自然语言)" },
      fleet_has: { type: "boolean", description: "已交付函数是否覆盖(来自 list_agents/capability_resolve)" },
      tool_hit: { type: "string", description: "search_tools 命中的工具名(无则不传)" },
      mcp_hit: { type: "string", description: "命中的 MCP 工具名 <server>.<tool>(无则不传)" },
      is_missing_tool: { type: "boolean", description: "该能力本质是缺一个工具/集成(而非缺会推理的 sub-agent)" },
    },
    ["need"],
  ),
  async execute(args, ctx) {
    const need = String(args.need ?? "").trim();
    if (!need) return { ok: false, summary: "need 为空——描述你缺的能力。" };
    // 技能库:找一个 active 且带 spawnSpec(可实例化)、名称/用途与 need 相关的技能。
    const skills = ctx.ports.skills ? await ctx.ports.skills.list(ctx.domain).catch(() => []) : [];
    const needWords = need.toLowerCase().split(/[\s，,、]+/).filter((w) => w.length >= 2);
    const spawnable = skills.filter((s) => s.spawnSpec && (s.lifecycle ?? "active") === "active");
    const skillHit = spawnable.find((s) => needWords.some((w) => `${s.name}${s.purpose}`.toLowerCase().includes(w)));
    const anySkillHit = skillHit ?? skills.find((s) => s.spawnSpec && needWords.some((w) => `${s.name}${s.purpose}`.toLowerCase().includes(w)));
    const res = resolveCapabilityLadder({
      description: need,
      fleetHas: !!args.fleet_has,
      toolHas: (args.tool_hit ? String(args.tool_hit) : null) || null,
      mcpHas: (args.mcp_hit ? String(args.mcp_hit) : null) || null,
      skillHas: anySkillHit ? { slug: anySkillHit.slug, lifecycle: anySkillHit.lifecycle ?? "active" } : null,
      isMissingTool: !!args.is_missing_tool,
    });
    const nextTool: Record<string, string> = {
      reuse_function: "list_agents / capability_resolve 拿到函数并复用/组合",
      call_tool: `直接把工具「${res.target}」绑进 design_agent 的 tool_use`,
      call_mcp: `调用 MCP 工具「${res.target}」`,
      instantiate_subagent: `use_skill「${res.target}」调入(实例化执行依赖 P2.5 站长工具面)`,
      forge_skill: "create_skill(写 promptFragment+决策规则,将来补 spawnSpec 落 draft)+ 需要调研就 spawn_subagent",
      create_tool: "create_tool 或 extract_api_schema(文档→工具)",
    };
    ctx.emit({ t: "reflect", kind: "capability", lesson: `能力梯:${need} → L${res.level} ${res.action}${res.target ? `(${res.target})` : ""}` });
    return { ok: true, summary: `能力梯 L${res.level}:${res.reason}。下一步 → ${nextTool[res.action]}`, output: { ...res, nextTool: nextTool[res.action] } };
  },
};

// #STRATEGY-COMBO — AI 自选推理方法【组合】。推理【不默认 ReAct】:你按当前子问题/意图,自己选一个
// 策略或一个【组合】(如 tot→debate→reflection),并给理由。不传 proposed → 返回一个【先验建议】(表 +
// 各策略说明)供你参考,你再决定。传 proposed → 记录你的选择并广播(UI 每张 agent 卡会显示它在用什么推理)。
const select_strategy: BrainTool = {
  name: "select_strategy",
  description:
    "选择本次子问题用什么推理方法(不默认 ReAct,由你按任务/意图判断)。可选单个或【组合】:react(工具循环)/reflection(产出→自评→重写)/debate(挑战者+评委)/tot(思维树 K 分叉)/cot(单链)。不传 proposed → 我给你先验建议 + 各策略适用场景;传 proposed(如「tot→debate→reflection」或「cot」)+ rationale → 记录你的选择。有的任务不适合 ReAct,组合往往比单一更好。",
  parameters: params(
    {
      subproblem: { type: "string", description: "你正要推理的子问题/当前决策(一句话)" },
      context: { type: "string", description: "语境(可选):plan/design/code/review/arbitrate/finish/analyze/subproblem" },
      proposed: { type: "string", description: "你选的策略或组合(可选)。单个如「reflection」,组合如「tot→debate→reflection」。不传=让我先给建议。" },
      rationale: { type: "string", description: "为什么这么选(为什么这个任务适合/不适合某策略)" },
    },
    ["subproblem"],
  ),
  async execute(args, ctx) {
    const subproblem = String(args.subproblem ?? "").trim();
    const ctxKind = (String(args.context ?? "subproblem").trim() || "subproblem") as StrategyContext;
    const forAgent = (ctx as unknown as { currentAgentSlug?: string }).currentAgentSlug;
    // 先验建议:确定性表按 意图+难度+语境 给一个默认——只作参考,不替 AI 选。
    const difficulty = estimateDifficulty(ctx.ontology ?? null);
    const suggestion = selectStrategy({ intentKind: classifyIntentKind(ctx.userIntent), difficulty, context: ctxKind });

    if (!args.proposed) {
      const menu = Object.entries(STRATEGY_DESC).map(([k, v]) => `  · ${k}:${v}`).join("\n");
      return {
        ok: true,
        summary: `先验建议:${suggestion.strategy}(${suggestion.reasons[suggestion.reasons.length - 1]})。你可采纳,或自选单个/组合。`,
        output: { suggestion: suggestion.strategy, expensive: suggestion.expensive, why: suggestion.reasons, menu: STRATEGY_DESC, hint: `可选策略与适用场景:\n${menu}\n组合示例:复杂设计「tot→debate」;高风险落地「debate→reflection」;简单答疑「cot」。` },
      };
    }
    const plan = parseStrategyPlan(String(args.proposed), { rationale: String(args.rationale ?? ""), chosenBy: "ai" });
    ctx.emit({ t: "strategy", mode: plan.mode, steps: plan.steps.map((s) => String(s.strategy)), chosenBy: plan.chosenBy, rationale: plan.rationale, forAgent });
    const unknownNote = plan.unknown.length ? `(词表外策略「${plan.unknown.join("、")}」已保留,消费端按 react 处理)` : "";
    return { ok: true, summary: `已选推理${describeStrategyPlan(plan)}${unknownNote}`, output: { plan: { mode: plan.mode, steps: plan.steps.map((s) => s.strategy), chosenBy: plan.chosenBy }, suggestion: suggestion.strategy } };
  },
};

const fetch_doc: BrainTool = {
  name: "fetch_doc",
  description: "Doc-Fetcher：抓取一个【公网】开发文档/API 说明页面的文本，作为造工具(create_tool)或设计 agent 的依据。走 SSRF 防护（拒绝内网/本机/元数据地址）。",
  parameters: params({ url: { type: "string", description: "公网 http(s) 文档地址" } }, ["url"]),
  async execute(args, ctx) {
    const url = String(args.url ?? "").trim();
    try {
      const res = await safeFetch(url, { headers: { accept: "text/html,text/plain,*/*" } });
      const text = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
      ctx.research.push({ query: url, findings: text.slice(0, 2000) });
      ctx.emit({ t: "web.result", query: url, results: [{ title: url, url, snippet: text.slice(0, 200) }] });
      return { ok: true, summary: `已抓取 ${url}（${text.length} 字，已截断喂给后续设计）`, output: { text } };
    } catch (e) {
      return { ok: false, summary: `抓取失败：${(e as Error).message}` };
    }
  },
};

const create_tool: BrainTool = {
  name: "create_tool",
  description:
    "Tool-Smith：当本体工具库缺一个 agent 真正需要的工具时，【声明式】造一个 HTTP 工具（名字+方法+URL模板+头/体模板+读写副作用）。它是声明，永不 eval；运行时由受防护的 fetch 执行。造完会①加入本次工具库供 design_agent 绑定，②持久化供以后复用。先确认本体 suggested_tools / available_tools 里确实没有再造。",
  parameters: params(
    {
      name: { type: "string", description: "工具名（带命名空间，如 acme.createTicket）" },
      description: { type: "string" },
      method: { type: "string", description: "GET / POST / PUT / DELETE" },
      url_template: { type: "string", description: "URL，可含 {placeholder}（运行时用事件 payload 填）" },
      headers: { type: "object", description: "请求头键值（可选）" },
      body_template: { type: "string", description: "请求体模板（可选，可含 {placeholder}）" },
      side_effect: { type: "string", enum: ["read", "write", "dual"], description: "读=查询；写=会改外部状态" },
      params_schema: { type: "object", description: "（建议）入参契约：字段名→类型/说明。外部平台工具务必填，运行时据此校验。" },
      returns_schema: { type: "object", description: "（建议）返回契约：字段名→类型/说明（如 RoboHire 包在 data.data.* 下）。" },
    },
    ["name", "description", "method", "url_template", "side_effect"],
  ),
  async execute(args, ctx) {
    const name = String(args.name ?? "").trim();
    if (!name) return { ok: false, summary: "工具名不能为空。" };
    // Collision guard: a created tool must NOT reuse a real global tool's name (the runtime would
    // resolve the global one and silently shadow this — so refuse and ask the brain to namespace it).
    if ((ctx.realTools ?? []).some((t) => t.name === name)) {
      return { ok: false, summary: `「${name}」与内置全局工具同名，会被运行时遮蔽。换个带命名空间的名字（如 ${ctx.domain.toLowerCase().replace(/[^a-z0-9]+/g, "")}.${name}）再造。` };
    }
    const tool = {
      name,
      description: String(args.description ?? ""),
      method: String(args.method ?? "GET").toUpperCase(),
      urlTemplate: String(args.url_template ?? ""),
      headers: (args.headers as Record<string, string>) ?? undefined,
      bodyTemplate: args.body_template ? String(args.body_template) : undefined,
      sideEffect: (args.side_effect === "write" || args.side_effect === "dual" ? args.side_effect : "read") as string,
      domain: ctx.domain,
      paramsSchema: args.params_schema && typeof args.params_schema === "object" ? (args.params_schema as Record<string, unknown>) : undefined,
      returnsSchema: args.returns_schema && typeof args.returns_schema === "object" ? (args.returns_schema as Record<string, unknown>) : undefined,
    };
    // ground design_agent against it immediately
    if (!ctx.toolCatalog.includes(name)) ctx.toolCatalog.push(name);
    if (ctx.ports.tools) await ctx.ports.tools.save(tool).catch(() => {});
    ctx.emit({ t: "tool.created", name, description: tool.description });
    return { ok: true, summary: `已造工具「${name}」(${tool.method} · ${tool.sideEffect})${ctx.ports.tools ? "并入库" : "（本次运行内）"}，design_agent 现在可以绑定它。`, output: { name } };
  },
};

const search_tools: BrainTool = {
  name: "search_tools",
  description:
    "Tool-Finder（渐进式工具检索）：按自然语言意图在【真实工具库】里搜可用工具，而不是把整个目录一次性背下来。给某个 action 找工具时先 search_tools 看有没有现成的，再 design_agent 绑真名；真没有再 fetch_doc + extract_api_schema + create_tool 造。可按 category(robohire/fs/http/ontology) 或读写副作用过滤。",
  parameters: params(
    {
      query: { type: "string", description: "要找的能力，自然语言，如「解析简历PDF」「给候选人发面试邀请」「把HTML写进归档」" },
      category: { type: "string", description: "（可选）限定分类，如 robohire / fs / http / ontology" },
      side_effect: { type: "string", enum: ["read", "write", "dual", "call"], description: "（可选）只看读/写/双写/纯调用" },
      limit: { type: "number", description: "（可选）返回条数，默认 6" },
    },
    ["query"],
  ),
  async execute(args, ctx) {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, summary: "search_tools 需要 query（要找什么能力）。" };
    let pool = ctx.realTools ?? [];
    if (!pool.length && ctx.ports.toolRegistry) pool = await ctx.ports.toolRegistry.list().catch(() => []);
    // Also surface persisted 造工具 tools (create_tool / the library's standalone 造工具 entry) so the
    // brain rediscovers tools it (or a human) built earlier — not just the built-in global registry.
    if (ctx.ports.tools) {
      const created = await ctx.ports.tools.list(ctx.domain).catch(() => []);
      const have = new Set(pool.map((t) => t.name));
      for (const dt of created) {
        if (have.has(dt.name)) continue;
        pool = [...pool, { name: dt.name, summary: dt.description, category: dt.name.includes(".") ? dt.name.slice(0, dt.name.indexOf(".")) : "created", aliases: [] }];
      }
    }
    const hits = searchRealTools(query, pool, {
      category: args.category ? String(args.category) : undefined,
      sideEffect: args.side_effect ? String(args.side_effect) : undefined,
      limit: Number(args.limit) || 6,
    });
    ctx.emit({ t: "tool.search", query, results: hits.map((h) => ({ name: h.name, summary: h.summary ?? "", sideEffect: h.sideEffect })) });
    if (!hits.length) {
      return { ok: true, summary: `工具库没搜到「${query}」相关工具。可 fetch_doc 看公网 API → extract_api_schema → create_tool 造，或 ask_user 让用户补真实集成。`, output: { query, results: [], none: true } };
    }
    return {
      ok: true,
      summary: `命中 ${hits.length} 个：${hits.map((h) => `${h.name}(${h.sideEffect})`).join("、")}。design_agent 用真名绑定；缺凭证看每个的 configKeys。`,
      output: { query, results: hits },
    };
  },
};

const extract_api_schema: BrainTool = {
  name: "extract_api_schema",
  description:
    "Schema-Extractor：把一段【已抓取的 API 文档文本】(fetch_doc 之后) 自动提炼成一个 HTTP 工具的契约——方法 + URL 模板 + 请求/返回字段 schema + 鉴权方式，作为 create_tool 的草稿。LLM 提炼，可能不全，造前自己核一遍。doc_text 不传则用最近一次 fetch_doc/web_search 的结果。",
  parameters: params(
    {
      tool_intent: { type: "string", description: "这个工具要干嘛，如「按 jobId 拉取职位详情」——帮助提炼聚焦到对的端点" },
      doc_text: { type: "string", description: "（可选）API 文档原文；不传则用 ctx.research 最近一条" },
    },
    ["tool_intent"],
  ),
  async execute(args, ctx) {
    const intent = String(args.tool_intent ?? "").trim();
    const doc = String(args.doc_text ?? "").trim() || (ctx.research.length ? ctx.research[ctx.research.length - 1]!.findings : "");
    if (!doc) return { ok: false, summary: "没有文档文本可提炼——先 fetch_doc 抓一个公网 API 文档，或把 doc_text 传进来。" };
    if (!isGatewayConfigured()) return { ok: false, summary: "未配置 LLM 网关，无法自动提炼 schema；请直接 create_tool 手写契约。" };
    const sys =
      "你是 API 契约提炼器。给你一个工具意图和一段 API 文档文本，提炼出【最贴合该意图的单个 HTTP 端点】的可用契约。" +
      '只输出 JSON：{"name":string(带命名空间如 acme.getJob),"method":"GET|POST|PUT|DELETE","url_template":string(可含{placeholder}),"headers":object,"body_template":string,"side_effect":"read|write|dual","params_schema":object(字段名→类型/说明),"returns_schema":object(字段名→类型/说明,注意嵌套如data.data.*),"auth_hint":string(鉴权方式与所需凭证),"confidence":number(0-1),"notes":string}。文档没写的字段就留空或合理推断并在 notes 里标注。不要任何其它文字。';
    const user = `工具意图：${intent}\n\nAPI 文档文本（截断）：\n${doc.slice(0, 5000)}`;
    try {
      const j = await chatJson<Record<string, unknown>>(sys, user, { temperature: 0.2, maxTokens: 4000, signal: ctx.signal, models: modelChain("review"), purpose: "extract_api_schema" });
      if (!j || !j.name) return { ok: false, summary: "没能从文档提炼出契约；可换更具体的 tool_intent，或直接 create_tool 手写。" };
      const fields = (j.params_schema && typeof j.params_schema === "object" ? Object.keys(j.params_schema as object).length : 0)
        + (j.returns_schema && typeof j.returns_schema === "object" ? Object.keys(j.returns_schema as object).length : 0);
      ctx.emit({ t: "tool.schema", name: String(j.name), method: String(j.method ?? "GET"), url: String(j.url_template ?? ""), fields });
      return {
        ok: true,
        summary: `提炼出契约「${String(j.name)}」(${String(j.method ?? "GET")} · 置信度${j.confidence ?? "?"})${j.auth_hint ? ` · 鉴权:${String(j.auth_hint).slice(0, 50)}` : ""}。核对后用 create_tool 落地。`,
        output: j,
      };
    } catch (e) {
      return { ok: false, summary: `提炼失败：${(e as Error).message}。可直接 create_tool 手写契约。` };
    }
  },
};

const analyze_failure: BrainTool = {
  name: "analyze_failure",
  description: "反复试仍跑不通、或确认是数据/环境/本体限制时，诚实记录一条反思（根因+下次经验）并据此收尾。比假装成功有价值。",
  parameters: params({ kind: { type: "string", enum: ["failure", "success", "caveat"] }, summary: { type: "string" }, root_cause: { type: "string" }, lesson: { type: "string" } }, ["kind", "summary", "lesson"]),
  async execute(args, ctx) {
    const kind = (args.kind === "success" || args.kind === "caveat" ? args.kind : "failure") as "failure" | "success" | "caveat";
    let rootCause = String(args.root_cause ?? "").trim();
    let lesson = String(args.lesson ?? "").trim();
    // Diagnostic reflexion (ported from old AO): if the brain left root_cause/lesson thin, DERIVE a
    // real diagnosis from the run state (validation issues, refine churn, sandbox outcome, untooled
    // specs) so the stored reflection is actionable — not a restate. Best-effort; keeps the brain's
    // own words if they're already substantive.
    if (isGatewayConfigured() && (rootCause.length < 20 || lesson.length < 20)) {
      const sb = ctx.lastSandbox;
      const state = [
        `域:${ctx.domain} · 目标:${ctx.goal}`,
        `已设计 ${ctx.specs.length} 个 agent: ${ctx.specs.map((s) => `${s.actionName}(工具${s.tools.length}${(s.unresolvedTools ?? []).length ? `·未解析${s.unresolvedTools!.length}` : ""}${s.degraded ? "·降级" : ""})`).join("；") || "无"}`,
        ctx.lastValidation ? `上次校验: ${ctx.lastValidation.ok ? "闭合✓" : `未闭合，问题 agent: ${Object.keys(ctx.lastValidation.agentIssueMap).slice(0, 6).join("、")}`}` : "未校验",
        sb ? `上次沙箱: 部署${sb.deployed}·跑${sb.agentsRan}·${sb.fullChainRan ? "整链通" : "未通"}${sb.degradedAgents.length ? `·降级 ${sb.degradedAgents.join(",")}` : ""}${sb.simulated ? "（模拟）" : ""}` : "未沙箱",
        `精修历史: ${Object.entries(ctx.attemptHistory).map(([k, h]) => `${k}×${h.length}`).join(" ") || "无"}`,
        rootCause ? `大脑初判根因: ${rootCause}` : "",
      ].filter(Boolean).join("\n");
      const sys =
        "你是 Agent 工厂的【诊断专家】。给定一次「用本体生成 agents」运行的状态，找出它跑不通/降级的【真实根因】属于哪一层(数据缺失 / 本体不全 / 工具没接 / 设计错误 / 外部平台没对接)，并给一条【下次该怎么做】的具体经验。" +
        '只输出 JSON：{"root_cause":string,"lesson":string}，中文、具体到层与动作。不要任何其它文字。';
      try {
        const j = await chatJson<{ root_cause?: unknown; lesson?: unknown }>(sys, state, { temperature: 0.3, maxTokens: 2000, signal: ctx.signal, models: modelChain("review"), purpose: "diagnose_failure" });
        if (j) {
          if (j.root_cause && String(j.root_cause).length > rootCause.length) rootCause = String(j.root_cause);
          if (j.lesson && String(j.lesson).length > lesson.length) lesson = String(j.lesson);
        }
      } catch {
        /* best-effort — keep the brain's own words */
      }
    }
    await ctx.ports.reflection.record(ctx.domain, { summary: String(args.summary ?? ""), lesson, failedStep: rootCause || undefined, kind });
    ctx.emit({ t: "reflect", kind, lesson });
    return { ok: true, summary: `已记录一条 ${kind} 反思${rootCause ? `（根因: ${rootCause.slice(0, 40)}${rootCause.length > 40 ? "…" : ""}）` : ""}。`, output: { kind, rootCause, lesson } };
  },
};

const finish: BrainTool = {
  name: "finish",
  description: "交付。仅当【每个 actor=Agent 动作都已设计】【每个 agent 都有代码】【当前这套 agent 有一次匹配的 sandbox_run 成功证据】时通过；否则打回继续。通过时附一句交付说明。",
  parameters: params({ summary: { type: "string" } }, ["summary"]),
  async execute(args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "还没 read_ontology，无法验收覆盖。" };
    const gap = coverageGap(ctx.ontology.actions, ctx.specs.map((s) => s.actionName));
    if (gap.length) return { ok: false, summary: `还有未覆盖的 Agent 动作：${gap.join("、")}——继续 design_agent。` };
    const noCode = ctx.specs.filter((s) => !s.generatedCode).map((s) => s.nameZh);
    if (noCode.length) return { ok: false, summary: `这些 agent 还没代码：${noCode.join("、")}——design_agent 会自动渲染，或用 codegen_agent。` };
    const fp = specsFingerprint(ctx.specs);
    if (!ctx.lastSandbox) return { ok: false, summary: "finish 前必须先 sandbox_run 真跑一次验证。" };
    if (ctx.lastSandbox.specsFingerprint !== fp) return { ok: false, summary: "agent 在上次沙箱后又改过——证据过期，请重新 sandbox_run。" };
    if (ctx.lastSandbox.deployed === 0) return { ok: false, summary: "上次沙箱没真部署成功（0 函数）。" };
    // Accept fullChainRan OR (reachedSuccessTerminal && zero degraded). fullChainRan can flicker false
    // purely on SNAPSHOT TIMING — a slow rule-gate cascade (ontology.fetchActionRules) is still
    // `running` when the poll samples — even though the chain DID reach a success terminal. Requiring
    // fullChainRan alone dead-looped finish (re-sandbox → another early snapshot → reject → forever).
    // The poll window is also extended now, so fullChainRan is usually reliable; this is the
    // legitimate-timing fallback, and acceptanceGate still enforces zero-degraded + the rest.
    if (!ctx.lastSandbox.fullChainRan && !(ctx.lastSandbox.reachedSuccessTerminal && (ctx.lastSandbox.degradedAgents?.length ?? 0) === 0)) {
      return { ok: false, summary: "上次沙箱既没整链跑通、也没到成功终态——先修到能跑通（或确认是真断点而非快照时机）。" };
    }
    // R2: a SIMULATED pass is graph-closure inference, not a real deploy+run — don't accept it as
    // delivery. Tell the user to start the Inngest stack and re-run; escape hatch for standalone dev.
    if (ctx.lastSandbox.simulated && process.env.FACTORY_ALLOW_SIMULATED_FINISH !== "1") {
      return { ok: false, summary: "上次沙箱是【模拟验证】(Inngest 未运行)，不算真交付。请启动 pnpm dev 后重新 sandbox_run 做真实部署+真跑验证；确需接受模拟证据可设 FACTORY_ALLOW_SIMULATED_FINISH=1。" };
    }
    // Phase 0a — enforce the FULL documented acceptance bar, not just the inline checks above.
    // This catches the gaps finish ignored: an agent with an unresolved tool, a chain that ran
    // but DEGRADED, an unbound rule gate, or an agent with no typed I/O payload.
    // #P3 — 监督者的版本锁定缺陷进 finish 门:0 阻塞缺陷才放行(阻塞缺陷在 sandbox_run 审计+结转到
    // ctx.defects,须在【更新版本】上复验消失才关闭——防同版本重跑洗白)。
    const gate = acceptanceGate(ctx.specs, ctx.ontology, ctx.lastSandbox, { blockingDefects: blockingDefects(ctx.defects ?? []).length });
    // #P1-6 — persist per-criterion verdicts (pass OR fail) so acceptance pass-rate is trendable
    // without replaying transcripts. Fail-safe — never blocks the gate.
    if (ctx.conversationId) {
      try {
        await ctx.ports.acceptance?.record(ctx.conversationId, ctx.domain, undefined, gate.report.criteria);
      } catch {
        /* acceptance telemetry best-effort */
      }
    }
    if (!gate.pass) {
      return {
        ok: false,
        summary: `验收未达标：${gate.failing.map((c) => `${c.label}（${c.detail}）`).join("；")}——先修复再 finish。`,
        output: { acceptance: gate.report },
      };
    }
    // Persist the accepted agents as durable, reviewable DRAFTS (the OLD syncDomainDrafts).
    // Optional port — a no-op when unwired, and fail-safe so a storage hiccup never blocks
    // a passing finish gate.
    let persisted = 0;
    try {
      persisted = (await ctx.ports.drafts?.save(ctx.domain, ctx.specs)) ?? 0;
    } catch {
      /* never block finish on a draft-store hiccup */
    }
    await ctx.ports.reflection.record(ctx.domain, { summary: `交付 ${ctx.specs.length} 个 agent：${String(args.summary ?? "")}`.slice(0, 500), lesson: "该域已成功生成并沙箱验证通过的一套 agent 可作后续参考。", kind: "success" });
    ctx.emit({ t: "reflect", kind: "success", lesson: "交付成功，留下一条成功反思。" });
    if (persisted > 0) ctx.emit({ t: "message", text: `📦 已把 ${persisted} 个 agent 存为草稿（可复用 / 后续晋升为正式 Fleet agent）。` });
    return { ok: true, summary: `✅ 交付通过：${ctx.specs.length} 个 agent，覆盖全部 Agent 动作、都有代码、沙箱端到端跑通${persisted > 0 ? `；已存 ${persisted} 个草稿` : ""}。`, output: { delivered: ctx.specs.map((s) => s.short), persisted, summary: String(args.summary ?? "") } };
  },
};

/** The full tool set (the harness's action space). */
/** ask_user — the general HITL clarification. The brain calls it when it's uncertain or
 *  missing info (e.g. an external platform's API I/O isn't in the tool library, an ambiguous
 *  requirement, a test it can't diagnose) instead of guessing or silently degrading an agent.
 *  Parks the run (awaitingClarify) until the user answers — free text or an offered option
 *  (one may be the AI's recommendation). Mirrors the test-case / boundary HITL gates. */
const ask_user: BrainTool = {
  name: "ask_user",
  description:
    "拿不准 / 缺信息 / 测试卡住、且你自己判断不了时，直接问用户——不要瞎猜、也不要把 agent 默默降级。给一个清晰的问题 + 2-4 个具体可选项（其中标一个 recommended:true 作你的最佳推荐），用户可以选一个或补充文字。典型：某外部平台 API 的 input/output 工具库里查不到、需求歧义、某测试反复失败拿不准根因、是否要造模拟桩。问完【暂停等用户回答】再继续，别在等待时调别的工具。同一问题问过一次就不会再打断用户——会直接把上次的答案回放给你。",
  parameters: params(
    {
      question: { type: "string", description: "要问用户的具体问题（一句话说清你需要什么）" },
      options: {
        type: "array",
        description: "2-4 个具体可选项；标一个 recommended:true 作你的最佳推荐",
        items: { type: "object", properties: { label: { type: "string" }, value: { type: "string" }, recommended: { type: "boolean" } }, required: ["label", "value"], additionalProperties: false },
      },
      context: { type: "string", description: "背景：你卡在哪、为什么需要这个信息" },
    },
    ["question"],
  ),
  async execute(args, ctx) {
    const question = String(args.question ?? "").trim();
    if (!question) return { ok: false, summary: "question 不能为空。" };
    // #ASK-DEDUP（审查修复：同一问题跨轮重复问）— 问过且已有答案 → 直接回放，不再打断用户。
    const norm = normalizeQuestion(question);
    const prior = ctx.askedQuestions?.[norm];
    if (prior !== undefined && prior !== "") {
      return { ok: true, summary: `这个问题已经问过了，用户当时的答复是：「${prior}」——直接采用这个答案继续，别再重复问。`, output: { question, answer: prior, replayed: true } };
    }
    const options = Array.isArray(args.options)
      ? (args.options as Array<Record<string, unknown>>).map((o) => ({ label: String(o.label ?? ""), value: String(o.value ?? o.label ?? ""), recommended: Boolean(o.recommended) })).filter((o) => o.label)
      : undefined;
    const context = args.context ? String(args.context) : undefined;
    (ctx.askedQuestions ??= {})[norm] = ""; // pending 标记：答案由 conductor 的澄清门写入
    ctx.clarifyPrompt = { question, options, context };
    ctx.awaitingClarify = true;
    ctx.emit({ t: "clarify", question, options, context, awaitingAnswer: true });
    return { ok: true, summary: `已向用户提问并【暂停等待回答】：「${question}」。用户回答后我会把答案发给你，你再继续——别在等待时调别的工具。`, output: { question, options, awaitingAnswer: true } };
  },
};

/** #ASK-DEDUP — 问题归一化键：去标点/空白、小写。同义改写不追求识别（那要语义比对，成本高
 *  且误伤风险大）——只拦"字面上基本相同的问题被反复问"这一最常见的泛化来源。 */
export function normalizeQuestion(q: string): string {
  return q.toLowerCase().replace(/[\s，。？！,.?!、:："'（）()【】\[\]-]+/g, "").slice(0, 120);
}

// supply_test_data — contact / credential / id fields (an interview email, a callback URL, an API
// key, a real candidate id) should NOT be tested with demo placeholders (candidate@example.com,
// `<field>_demo`): the run "passes" but never reflects the real integration. This detects such
// fields and asks the user for REAL values, then threads them into the fired test payloads (still
// via the mock gateway — nothing is actually sent). Reuses the clarify park: SCAN-and-ask first,
// then the brain parses the answer and calls again with `values`.
const REAL_DATA_FIELD = /e?-?mail|邮箱|recipient|收件|notify|通知|webhook|callback|回调|\bphone\b|mobile|\btel\b|手机|api[_-]?key|access[_-]?token|\bsecret\b|credential|凭证|账号|account_id/i;
const DEMO_VALUE = /example\.com|_demo\b|^13800138000$|^Alex Chen$|^demo|占位/i;
const isDemoValue = (v: unknown): boolean => typeof v === "string" && DEMO_VALUE.test(v);

/** Fields across the designed agents' inputSchema (and the authored test payloads) that read like
 *  real contact/credential/id and aren't already user-overridden — the ones worth asking about. */
function scanRealDataNeeds(ctx: BrainCtx): Array<{ field: string; type: string; sample?: string; agents: string[] }> {
  const needs = new Map<string, { field: string; type: string; sample?: string; agents: Set<string> }>();
  for (const s of ctx.specs) {
    for (const io of s.inputSchema ?? []) {
      if (!REAL_DATA_FIELD.test(io.field)) continue;
      const cur = needs.get(io.field) ?? { field: io.field, type: io.type, agents: new Set<string>() };
      cur.agents.add(s.short || s.nameZh);
      needs.set(io.field, cur);
    }
  }
  for (const tc of ctx.testCases ?? []) {
    for (const [k, v] of Object.entries(tc.payload)) {
      const n = needs.get(k);
      if (n && isDemoValue(v)) n.sample = String(v);
    }
  }
  const overridden = ctx.testDataOverrides ?? {};
  return [...needs.values()].filter((n) => !(n.field in overridden)).map((n) => ({ field: n.field, type: n.type, sample: n.sample, agents: [...n.agents] }));
}

/** Apply the user's real values onto a test payload — only keys the payload already carries (so we
 *  never inject foreign fields the canonical event_data doesn't define). */
export function applyTestDataOverrides(payload: Record<string, unknown>, overrides?: Record<string, unknown>): Record<string, unknown> {
  if (!overrides || !Object.keys(overrides).length) return payload;
  const out = { ...payload };
  for (const k of Object.keys(overrides)) if (k in out) out[k] = overrides[k];
  return out;
}

const supply_test_data: BrainTool = {
  name: "supply_test_data",
  description:
    "测试用例里有【真实联系/凭证/ID 类字段】(面试邀约 email、回调 URL、API key、真实候选人 ID 等) 时，别用 demo 占位——调它。不带 values：它会扫出这些字段并【暂停问用户】要真实值；用户回答后，你把回答解析成 {字段名:真实值} 再带 values 调一次，把真实值织进测试 payload（仍走 mock 网关，不会真发邮件/请求）。用户若回复『用占位』就直接 sandbox_run。",
  parameters: params({
    values: { type: "object", description: "用户给的 {字段名:真实值}（从用户回答解析）。不传=先扫描+问用户。" },
  }),
  async execute(args, ctx) {
    if (!ctx.testCases?.length) return { ok: false, summary: "还没 generate_test_cases——先造测试用例，再补真实数据。" };
    const values = args.values && typeof args.values === "object" && !Array.isArray(args.values) ? (args.values as Record<string, unknown>) : null;
    // APPLY mode — store overrides + thread into every test payload that carries the field.
    if (values && Object.keys(values).length) {
      ctx.testDataOverrides = { ...(ctx.testDataOverrides ?? {}), ...values };
      let touched = 0;
      for (const tc of ctx.testCases) {
        const before = JSON.stringify(tc.payload);
        tc.payload = applyTestDataOverrides(tc.payload, values);
        if (JSON.stringify(tc.payload) !== before) touched++;
      }
      ctx.awaitingClarify = false;
      ctx.emit({ t: "test.cases", cases: ctx.testCases, awaitingApproval: ctx.awaitingApproval ?? false });
      const shown = Object.entries(values).map(([k, v]) => `${k}=${String(v).slice(0, 48)}`).join("、");
      return { ok: true, summary: `已把真实数据织进 ${touched} 条测试用例：${shown}。现在可以 sandbox_run。`, output: { applied: values, touched } };
    }
    // SCAN + ASK mode — find real-data fields still on placeholders and park for the user's values.
    const needs = scanRealDataNeeds(ctx);
    if (!needs.length) return { ok: true, summary: "没有需要真实值的联系/凭证类字段——demo 值即可，直接 sandbox_run。", output: { needs: [] } };
    const lines = needs.map((n) => `· ${n.field}${n.sample ? `（现为占位「${n.sample}」）` : ""} — 用于 ${n.agents.join("、")}`).join("\n");
    const question = `这些字段是真实联系/凭证/ID 类，建议用真实值替代占位让测试更可信（仍走 mock 不会真发）：\n${lines}\n请按「字段: 值」逐行回复；或回复『用占位』沿用 demo。`;
    ctx.clarifyPrompt = { question, options: [{ label: "用占位值即可", value: "用占位" }], context: "补全测试真实数据" };
    ctx.awaitingClarify = true;
    ctx.emit({ t: "clarify", question, options: ctx.clarifyPrompt.options, context: ctx.clarifyPrompt.context, awaitingAnswer: true });
    return { ok: true, summary: `已【暂停】请用户补 ${needs.length} 个真实字段：${needs.map((n) => n.field).join("、")}。用户回答后→解析成 {字段:值}→supply_test_data(values=…)；若回复『用占位』就直接 sandbox_run。`, output: { needs, awaitingAnswer: true } };
  },
};

/** describe_design_constraints (R8) — lets the brain INTROSPECT its design envelope: the real
 *  Agent actions (designed vs remaining), the available tool library, reusable skills, and the
 *  event entry/terminal set. So it reasons over the actual legal symbols instead of guessing
 *  (constrained-decoding enums exist but the model can't otherwise see them). */
const describe_design_constraints: BrainTool = {
  name: "describe_design_constraints",
  description:
    "查看你当前的设计约束与可用资源：本体里所有 actor=Agent 的动作（哪些已设计 / 还差哪些）、可用工具库（真名）、可复用技能、事件入口 / 终态。设计或选工具前想确认自己有哪些『合法符号』可用时调它——避免脑补不存在的动作 / 工具 / 事件。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先 read_ontology。" };
    const agentActions = ctx.ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name);
    const done = new Set(ctx.specs.map((s) => s.actionName));
    const graph = compileGraph(ctx.ontology.actions, { domainId: ctx.domain });
    return {
      ok: true,
      summary: `约束：${agentActions.length} 个 Agent 动作（已设计 ${done.size}）· 工具库 ${ctx.toolCatalog?.length ?? 0} 个 · 入口事件 ${graph.entryEvents.length} · 技能 ${ctx.createdSkills.length}`,
      output: {
        agent_actions: agentActions.map((n) => ({ name: n, designed: done.has(n) })),
        available_tools: ctx.toolCatalog ?? [],
        created_skills: ctx.createdSkills.map((s) => ({ name: s.name, decisionRule: s.decisionRule })),
        entry_events: graph.entryEvents,
        terminal_events: graph.terminalEvents,
        note: "事件名 / 动作名 / 字段名 / 工具名只能用这里列出的真实符号，别发明；缺工具或缺信息就 ask_user。",
      },
    };
  },
};

/** create_mock_agent (R11) — when a real external platform's API isn't in the tool library (or
 *  has no key), generate a SYNTHETIC agent that SIMULATES it so the sandbox can run the chain
 *  end-to-end instead of degrading/stalling. Because the runtime is declarative (the agent
 *  reasons per its prompt), a mock is just an agent whose prompt says "simulate <platform>:
 *  produce a representative <emit> payload". Honestly named 模拟<platform>; not in the ontology,
 *  so it doesn't affect coverage and can be excluded from a production promote. */
const create_mock_agent: BrainTool = {
  name: "create_mock_agent",
  description:
    "为某个外部平台 / 服务造一个【模拟 agent】，让沙箱把链路跑通（真实外部 API 不在工具库、或没有真实 key 时）。它消费外发事件、产出该平台会回传的事件，prompt 写成『模拟 <平台>：按契约产出代表性 payload』。诚实标注为 mock，不算本体动作。",
  parameters: params(
    {
      user_confirmed: { type: "boolean", description: "【结构性前置】必须为 true 且【只有在用户明确同意用模拟桩之后】才允许传 true（先 ask_user 给出真实接入/模拟/去掉三选项）。未确认就调用会被拒绝。" },
      platform: { type: "string", description: "被模拟的外部平台 / 服务名（如 RoboHire、Email、企业微信）" },
      trigger: { type: "array", items: { type: "string" }, description: "它消费的事件（外发给该平台的事件）" },
      emit: { type: "array", items: { type: "string" }, description: "它产出的事件（该平台会回传的事件）" },
      system_prompt: { type: "string", description: "（可选）自定义模拟逻辑；不填则自动生成" },
    },
    ["platform", "trigger", "emit"],
  ),
  async execute(args, ctx) {
    const platform = String(args.platform ?? "").trim();
    const trigger = Array.isArray(args.trigger) ? (args.trigger as string[]).map(String).filter(Boolean) : [];
    const emit = Array.isArray(args.emit) ? (args.emit as string[]).map(String).filter(Boolean) : [];
    if (!platform || !trigger.length || !emit.length) return { ok: false, summary: "platform / trigger / emit 都必填。" };
    // #AUDIT-FIX(L31) — 「先问用户再造桩」从 prompt 散文升级为结构闸（与 stageAdmission 同款
    // 原则：顺序由结构强制）。要求 user_confirmed=true 且 askedQuestions 里存在一条已答的、
    // 提及该平台的澄清记录——两个证据都在才放行。
    if (args.user_confirmed !== true) {
      return { ok: false, summary: `未经用户确认不能造模拟桩。先 ask_user 给出三选项（① 接入真实 ${platform} / ② 先用模拟桩跑通 / ③ 去掉该环节），用户明确选择模拟后，再带 user_confirmed:true 重新调用。` };
    }
    const platformAsked = Object.entries(ctx.askedQuestions ?? {}).some(([q, a]) => a && a !== "" && (q.includes(platform.toLowerCase().replace(/[^a-z0-9一-鿿]/g, "")) || q.includes("模拟") || q.includes("mock")));
    if (!platformAsked) {
      return { ok: false, summary: `没有找到与「${platform}」相关的已答澄清记录——user_confirmed 必须以真实的 ask_user 确认为前提，不能自行断言。先 ask_user 征求用户选择。` };
    }
    const actionName = `mock_${kebab(platform).replace(/-/g, "_")}`;
    const sp = String(args.system_prompt ?? "").trim() || `你在沙箱里【模拟外部平台「${platform}」】：收到 ${trigger.join(" / ")} 后，按事件契约产出代表性的 ${emit.join(" / ")} payload（真实感数据，字段对齐 event_data），让事件链能端到端跑通。这是模拟桩，不是真实集成。`;
    const spec: GeneratedAgentSpec = {
      key: actionName, actionName, slug: `${domainPrefix(ctx.domain)}-${kebab(actionName)}`, short: `Mock${pascal(platform)}Agent`, domainId: ctx.domain, nameZh: `模拟${platform}`, kind: "llm",
      trigger, emit, tools: [], unresolvedTools: [], objects: [], systemPrompt: sp, userPrompt: "",
      steps: [], ruleRefs: [], retries: 1, hitl: false, confidence: 0.6, promptSource: "llm",
      inputSchema: eventFieldsOf(trigger, ctx.ontology), outputSchema: eventFieldsOf(emit, ctx.ontology),
    };
    spec.generatedCode = specToAgentCode(spec);
    spec.codeSource = "render";
    ctx.specs = ctx.specs.filter((s) => s.actionName !== actionName);
    ctx.specs.push(spec);
    ctx.lastSandbox = null;
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec), forAgent: spec.actionName });
    // #C: record a "needs real integration" punch-list item — a mock closes the sandbox chain but
    // isn't deployable, so surface exactly what the FDE must wire post-generation.
    await ctx.ports.reflection.record(ctx.domain, { summary: `需要真实集成：${platform}（当前用模拟桩 ${spec.slug} 让链路跑通）`, lesson: `「${actionName}」依赖外部平台「${platform}」。晋升前需：① 在工具库接入 ${platform} 的真实工具（或 create_tool 包装其 HTTP API），② 提供其凭证/配置(env/config)，③ 把模拟桩 ${spec.slug} 换成真实 agent。`, failedStep: `external_integration_pending:${platform}`, kind: "caveat" }).catch(() => {});
    ctx.emit({ t: "reflect", kind: "caveat", lesson: `⚠ 待补真实集成：${platform}（${actionName} 现为模拟桩，晋升前需接入真实工具+凭证）` });
    return { ok: true, summary: `已造模拟外部平台 agent「模拟${platform}」(${trigger.join("/")} → ${emit.join("/")})——沙箱可借它跑通链路（标注 mock，可在晋升时排除）。⚠ 已记入待办：晋升前需为 ${platform} 接入真实工具+凭证。`, output: { slug: spec.slug, mock: true, needsRealIntegration: platform } };
  },
};

// ── 领域分析报告（正式产物，走 reportGenerator agent 管线，不在聊天里手写 HTML）──────────
const generate_report: BrainTool = {
  name: "generate_report",
  description:
    "为当前业务域生成一份正式的 Ontology 领域分析报告：走 reportGenerator agent 管线（结构化断链/规则覆盖/数据模型分析 + 确定性 SVG 图表），产出可下载的 HTML/PDF 文件（右上「后台任务」面板可见进度与下载）。用户在聊天里要「分析本体 / 生成分析报告」时用这个。绝不要自己在聊天里手写整份 HTML 报告；也不要调用 report.htmlToPdf / viz.svgChart / fs.writeHtmlToArchive——那些是给生成的 agent 绑定的运行时工具，不是你的工具。",
  parameters: params(
    {
      format: { type: "string", enum: ["html", "pdf", "both"], description: "产物格式；默认 html（pdf 需要本机 Chrome）" },
      focus: { type: "string", description: "分析重点（可选），如：事件链断点与规则覆盖" },
    },
    [],
  ),
  async execute(args, ctx) {
    const runner = ctx.ports.report;
    if (!runner) return { ok: false, summary: "报告管线未接入（ports.report 未配置）。告诉用户：可在右上「后台任务」面板手动点「报告」生成。不要手写 HTML 代替。" };
    let format = ["html", "pdf", "both"].includes(String(args.format)) ? (String(args.format) as "html" | "pdf" | "both") : "html";
    // 意图兜底：用户目标/意图门里提到 PDF，但模型没传 format=pdf/both（常见）——按意图升级为 both，
    // 免得"要 PDF 却只出 HTML"。（PDF 需要本机 Chrome；缺时 report-jobs 会诚实降级为 HTML + note。）
    if (format === "html") {
      const wantsPdf = /pdf|PDF/.test(`${ctx.userIntent ?? ""} ${ctx.goal ?? ""} ${String(args.focus ?? "")}`);
      if (wantsPdf) format = "both";
    }
    const focus = typeof args.focus === "string" && args.focus.trim() ? args.focus.trim().slice(0, 300) : undefined;
    let job: { id: string };
    try {
      job = await runner.start({ domain: ctx.domain, format, focus });
    } catch (e) {
      return { ok: false, summary: `报告任务启动失败：${(e as Error).message}` };
    }
    ctx.emit({ t: "message", text: `📊 领域分析报告开始生成（${format.toUpperCase()}${focus ? ` · 重点：${focus}` : ""}）——进度见右上「后台任务」面板。` });
    // Brief inline wait: a typical job lands in 30-60s, so fast runs hand back download links in
    // the same turn; slow ones degrade to "继续，后台完成后可下载" instead of blocking the brain.
    const deadline = Date.now() + 90_000;
    let lastPhase = "";
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const st = await runner.status(job.id).catch(() => null);
      if (!st) break;
      if (st.phase && st.phase !== lastPhase) {
        lastPhase = st.phase;
        ctx.emit({ t: "message", text: `⏳ ${st.phase}…` });
      }
      if (st.status === "error") return { ok: false, summary: `报告生成失败：${st.error ?? "未知错误"}` };
      if (st.status === "done") {
        const links = st.artifacts.map((a) => `${a.label} → /v1/artifacts/${a.id}`).join("；");
        return {
          ok: true,
          summary: `报告已生成${st.title ? `「${st.title}」` : ""}：${links}${st.note ? `（${st.note}）` : ""}。告诉用户：在右上「后台任务」面板点击下载即可，不必贴出报告全文。【重要】你没有读过报告正文——转述时只说标题/下载位置/审校状态，绝不要编造报告的章节目录或内容摘要（如"漏斗/图谱/热力图"这类正文里可能根本不存在的东西）。`,
          output: { jobId: job.id, title: st.title, artifacts: st.artifacts, note: st.note },
        };
      }
    }
    return { ok: true, summary: `报告仍在后台生成（任务 ${job.id}）——完成后出现在右上「后台任务」面板，用户可随时下载。你可以继续其它工作，不用等待。【重要】你没有也不会读到报告正文——之后向用户转述时只说任务状态与下载位置，绝不要编造报告内容/目录。`, output: { jobId: job.id, background: true } };
  },
};

export const FACTORY_TOOLS: BrainTool[] = [
  ask_user,
  generate_report,
  describe_design_constraints,
  create_mock_agent,
  read_ontology,
  understand_ontology,
  capability_resolve,
  analyze_with_code,
  list_domains,
  describe_domain,
  describe_object,
  create_plan,
  critique_plan,
  design_agent,
  design_subagent,
  codegen_agent,
  refine_agent,
  revert_refine,
  validate_graph,
  propose_boundary_events,
  verify_chain,
  generate_test_cases,
  supply_test_data,
  sandbox_run,
  inspect_run,
  read_spec,
  score_spec,
  diff_spec,
  review_agent,
  review_context,
  review_completeness,
  list_agents,
  web_search,
  search_tools,
  fetch_doc,
  extract_api_schema,
  create_tool,
  create_skill,
  use_skill,
  resolve_capability_ladder,
  select_strategy,
  analyze_failure,
  finish,
];

/** Test-only: the de-hardcoded rule-detection + design-time grounding helpers (#9/#B). */
export const __ruleTestHelpers = { ruleIdentifiers, promptEmbedsRule, looksLikeRuleGate, specIsRuleGate, rulesForAction };

/** Read-only subset for sub-agents (no deploy / no mutation). */
// R9: subagents are still read-only for AGENT/tool authoring, but gain scoped SKILL authoring
// (create_skill persists to the shared store so the parent + future runs absorb it) and
// constraint introspection. spawn_subagent is added by the conductor under a depth cap.
export const SUBAGENT_TOOLS: BrainTool[] = [read_ontology, list_domains, describe_domain, describe_object, list_agents, read_spec, inspect_run, web_search, search_tools, fetch_doc, extract_api_schema, analyze_failure, create_skill, resolve_capability_ladder, select_strategy, describe_design_constraints];
