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
import type { GeneratedAgentSpec, IoField } from "./spec-types";
import type { OntologyAction, DomainOntology } from "./ontology-types";
import { compileGraph, verifyGraph, coverageGap } from "./graph";
import { acceptanceGate } from "./acceptance";
import { parsePlan, validatePlan } from "./plan-projection";
import { deriveContractGraph, contractIssueStrings, contractAgentIssueMap } from "./contract";
import { buildToolCatalog, suggestToolsForAction, rankRealTools, groundToolPicks, ungroundedEventTokens, searchRealTools } from "./tool-catalog";
import { specToAgentCode, validateAgentCode } from "./codegen";
import { lintGeneratedToolCode } from "./code-lint";
import { safeFetch } from "./egress-guard";
import { generate_test_cases, proposeTestCases } from "./test-cases";
import { chatOnce, isGatewayConfigured } from "./stream-gateway";
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

const cardOf = (s: GeneratedAgentSpec) => ({ slug: s.slug, actionName: s.actionName, short: s.short, nameZh: s.nameZh, trigger: s.trigger, emit: s.emit, tools: s.tools, unresolved: s.unresolvedTools });
const designOf = (s: GeneratedAgentSpec) => ({ reasoning: s.designReasoning ?? "", systemPrompt: s.systemPrompt, toolRationale: s.toolRationale ?? "", decisionLogic: s.decisionLogic ?? "", code: s.generatedCode, codeSource: s.codeSource });

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
    const ont = await ctx.ports.ontology.fetchOntology(ctx.domain);
    // #4: pin a signature on first read; flag drift on a re-read (the live Allmeta graph changed
    // under already-built specs) so the brain doesn't silently work against swapped ground truth.
    const sig = `${ont.actions.length}/${ont.events.length}/${ont.objects.length}/${ont.rules.length}`;
    const drift = ctx.ontologySig && ctx.ontologySig !== sig ? `⚠ 本体自上次读取已变化（${ctx.ontologySig}→${sig}）：已设计的 specs 是基于旧本体的，请核对一致性。` : "";
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
      summary: `${drift ? drift + " " : ""}本体已读：${ont.actions.length} 动作（${agentActions.length} 个要造 agent）· ${ont.events.length} 事件 · ${ont.objects.length} 对象 · ${ont.rules.length} 规则 · 工具库 ${ctx.toolCatalog.length} 个 · 技能库 ${skills.length} 个（source=${ont.source}）`,
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
    return { ok: true, summary: `BuildPlan v${version}（${plan.agents.length} agent）${warns.length ? " · ⚠ " + warns.join("；") : ""}`, output: { version, warnings: warns } };
  },
};

const design_agent: BrainTool = {
  name: "design_agent",
  description:
    "提交你为【一个】agent 动作设计好的 agent。先想清楚职责/边界/选哪些工具(为什么)/每个分支事件的触发条件，并【亲自写中文 system_prompt】。定义 input_schema/output_schema（参考 read_ontology 的 data_objects 真实属性）。规则校验类动作(is_rule_check)的 prompt 必须写成运行时动态抓规则，绝不写死规则。工具名优先用该动作的 suggested_tools / available_tools 里的真名。一次只交一个。",
  parameters: params(
    {
      action: { type: "string", description: "动作名（read_ontology agentActions[].name）" },
      system_prompt: { type: "string", description: "你亲自写的中文系统提示：职责/依据/决策。要具体，别套模板。" },
      tools: { type: "array", items: { type: "string" }, description: "为它挑的工具（用 suggested_tools/available_tools 真名；没合适的留空并说明）" },
      decision_logic: { type: "string" },
      tool_rationale: { type: "string" },
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
    ["action", "system_prompt"],
  ),
  async execute(args, ctx) {
    if (!ctx.ontology) return { ok: false, summary: "请先调用 read_ontology。" };
    const name = String(args.action ?? "").trim();
    const action = ctx.ontology.actions.find((a) => a.name === name);
    if (!action) return { ok: false, summary: `找不到动作「${name}」，用 read_ontology 里的准确名字。` };
    if (!String(args.system_prompt ?? "").trim()) return { ok: false, summary: `agent「${name}」缺少 system prompt——必须亲自写，不能留空套模板。` };

    // ── tool grounding (de-hallucinate + floor) ──
    const picks = Array.isArray(args.tools) ? (args.tools as string[]).map(String).filter(Boolean) : [];
    const grounded = groundToolPicks(picks, ctx.toolCatalog ?? []);
    let tools = grounded.resolved;
    // FLOOR: if the brain picked nothing, fall back to ontology-declared tools + the top
    // semantically-ranked REAL tools (#C) — so an action that declared none still binds a real tool.
    if (tools.length === 0) {
      const sug = suggestToolsForAction(action, ctx.realTools ?? []);
      if (sug.length) tools = sug;
    }

    let systemPrompt = String(args.system_prompt ?? "");
    const isGate = looksLikeRuleGate(action);
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

    const authored = { systemPrompt, tools, decisionLogic: String(args.decision_logic ?? ""), reasoning: typeof args.reasoning === "string" ? args.reasoning : "", toolRationale: String(args.tool_rationale ?? "") };
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
    if (plan.length) spec.plan = plan;
    spec.unresolvedTools = grounded.unresolved;
    spec.stateBindings = deriveStateBindings(action, ctx.ontology); // R5
    // auto-render readable code so every agent HAS code (codegen_agent can override w/ AI code)
    spec.generatedCode = specToAgentCode(spec);
    spec.codeSource = "render";

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
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec) });
    ctx.emit({ t: "code", actionName: name, code: spec.generatedCode ?? "", codeSource: "render" });

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
      summary: `已提交「${spec.nameZh}」(${agentActionNames.length - remaining.length}/${agentActionNames.length}) · 工具 ${spec.tools.length} 个 · 已渲染代码${warn}`,
      output: { committed: spec.short, tools: spec.tools, unresolved: spec.unresolvedTools, done: agentActionNames.length - remaining.length, total: agentActionNames.length, remaining, needsCodegen: false },
    };
  },
};

const codegen_agent: BrainTool = {
  name: "codegen_agent",
  description: "为一个已 design_agent 的 agent【亲手写完整 .ts 代码】（从 import 到导出），覆盖自动渲染的脚手架。会用 TS 编译器校验语法；通过才采纳并标记 codeSource=ai。不写也行——design_agent 已自动渲染可读代码。",
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
    spec.generatedCode = code;
    spec.codeSource = "ai";
    ctx.lastSandbox = null;
    ctx.emit({ t: "code", actionName: name, code, codeSource: "ai" });
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec) });
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
      return { ok: false, summary: `agent「${name}」已 refine ${priorAttempts} 次，达到重试上限——别再硬修了。要么 revert_refine("${name}") 回滚到最好的一版并接受，要么 verify_chain 看链路全貌定位真断点；若方向就是错的，create_plan 重新规划，或 analyze_failure 诚实记根因。`, output: { actionName: name, attemptsUsed: priorAttempts, budget: REFINE_BUDGET, advice: "revert_or_verify_or_replan" } };
    }
    const totalRefines = Object.values(ctx.attemptHistory).reduce((s, h) => s + (h?.length ?? 0), 0);
    const globalCap = GLOBAL_REFINE_FACTOR * Math.max(1, ctx.specs.length);
    if (totalRefines >= globalCap) {
      return { ok: false, summary: `全域已累计 refine ${totalRefines} 次（上限 ${globalCap}≈${GLOBAL_REFINE_FACTOR}×${ctx.specs.length} 个 agent）——再逐个微调大概率解决不了，问题很可能在设计/数据/本体层面。停下：verify_chain 看链路全貌定位真断点，或 analyze_failure 诚实记根因收尾，别继续 churn。`, output: { totalRefines, globalCap, advice: "stop_churn_verify_or_analyze" } };
    }
    const priorScore = scoreTotal(scoreSpec(spec, history.length));
    const snapshot: RefineAttempt = { attemptNumber: history.length + 1, priorSpecSnapshot: { systemPrompt: spec.systemPrompt, tools: [...spec.tools], decisionLogic: spec.decisionLogic }, critique: String(args.critique ?? ""), changes: "" };

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
    // re-render code unless the user hand-wrote AI code
    if (spec.codeSource !== "ai") spec.generatedCode = specToAgentCode(spec);
    ctx.lastSandbox = null;

    const newDims = scoreSpec(spec, history.length + 1);
    const newScore = scoreTotal(newDims);
    const delta = newScore - priorScore;
    const regression = delta <= -10;
    snapshot.changes = `prompt${args.system_prompt ? "改" : "未改"} · tools ${toolsBefore.length}→${spec.tools.length}`;
    history.push(snapshot);

    ctx.emit({
      t: "refine",
      actionName: name,
      critique: String(args.critique ?? ""),
      diff: { systemPromptChanged: !!args.system_prompt, toolsAdded: spec.tools.filter((t) => !toolsBefore.includes(t)), toolsRemoved: toolsBefore.filter((t) => !spec.tools.includes(t)), decisionLogicChanged: typeof args.decision_logic === "string" },
    });
    ctx.emit({ t: "score.delta", actionName: name, priorTotal: priorScore, newTotal: newScore, delta, regression, dimensions: newDims });
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec) });
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
    spec.systemPrompt = last.priorSpecSnapshot.systemPrompt;
    spec.tools = [...last.priorSpecSnapshot.tools];
    spec.decisionLogic = last.priorSpecSnapshot.decisionLogic;
    if (spec.codeSource !== "ai") spec.generatedCode = specToAgentCode(spec);
    ctx.lastSandbox = null;
    ctx.emit({ t: "revert", actionName: name, revertedToAttempt: last.attemptNumber - 1 });
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec) });
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
    const issues: string[] = [
      ...(gap.length ? [`缺少 agent 的动作：${gap.join("、")}`] : []),
      ...v.issues.map((i) => (i.kind === "missing_producer" ? `「${i.action}」消费的 ${i.event} 没人产出` : i.kind === "orphan_emit" ? `「${i.action}」产出的 ${i.event} 没人消费且非终态` : i.kind === "unreachable_node" ? `「${i.action}」从入口不可达` : i.kind === "no_entry" ? "无入口节点" : "到不了终态")),
      ...contractIssueStrings(contract),
    ];
    const emptyTools = ctx.specs.filter((s) => !s.tools?.length && !s.hitl).map((s) => s.short);
    if (emptyTools.length) issues.push(`无工具的 agent：${emptyTools.join("、")}`);
    const agentIssueMap: Record<string, unknown[]> = {};
    for (const i of v.issues) if ("action" in i) (agentIssueMap[i.action] ??= []).push(i);
    for (const [action, list] of Object.entries(contractMap)) agentIssueMap[action] = [...(agentIssueMap[action] ?? []), ...list];
    const ok = gap.length === 0 && v.ok && contract.ok && emptyTools.length === 0;
    ctx.lastValidation = { ok, agentIssueMap };
    ctx.emit({ t: "validation", ok, issues, agentIssueMap });
    return { ok, summary: ok ? "事件图闭合 ✓（覆盖 + 字段合同）" : `未闭合：${issues.slice(0, 4).join("；")}`, output: { ok, issues, agentIssueMap, coverageGap: gap, contract: { ok: contract.ok, payloadGaps: contract.events.filter((e) => e.payloadGaps.length).map((e) => ({ event: e.name, missing: e.payloadGaps })) } } };
  },
};

const verify_chain: BrainTool = {
  name: "verify_chain",
  description: "本体接地的链路体检：从入口事件出发，沿真实事件链逐跳走，定位链路在哪个 agent 断了（消费了没人产的事件 / 产了没人收的事件），帮你精准定位要 refine 谁，而不是泛泛重试。",
  parameters: params({}),
  async execute(_args, ctx) {
    if (!ctx.ontology || !ctx.specs.length) return { ok: false, summary: "需要先 read_ontology + design_agent。" };
    const emitters = new Map<string, string[]>();
    const consumers = new Map<string, string[]>();
    for (const s of ctx.specs) {
      for (const e of s.emit ?? []) (emitters.get(e) ?? emitters.set(e, []).get(e)!).push(s.actionName);
      for (const e of s.trigger ?? []) (consumers.get(e) ?? consumers.set(e, []).get(e)!).push(s.actionName);
    }
    const known = compileGraph(ctx.ontology.actions, { domainId: ctx.domain });
    const entrySet = new Set(known.entryEvents);
    const termSet = new Set(known.terminalEvents);
    const breaks: string[] = [];
    for (const s of ctx.specs) {
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
      testCases: (ctx.testCases ?? []).map((c) => ({ entryEvent: c.entryEvent, payload: c.payload })),
      // #D: thread the user's boundary classification so an external-handoff emit counts as a
      // legitimate terminal in the verdict — not a broken chain (matches validate_graph).
      boundaryEvents: (ctx.boundaryEvents ?? []).map((b) => ({ event: b.event, kind: b.kind })),
    });
    ctx.lastSandbox = { specsFingerprint: specsFingerprint(ctx.specs), deployed: res.functionsRegistered, agentsRan: res.ran, ranAgents: res.runs.map((r) => r.id), reachedTerminal: res.reachedSuccessTerminal || res.fullChainRan, reachedSuccessTerminal: res.reachedSuccessTerminal, fullChainRan: res.fullChainRan, degradedAgents: res.degradedAgents, simulated: res.simulated ?? false, ts: Date.now() };
    ctx.emit({
      t: "sandbox",
      ran: res.ran,
      reachedTerminal: res.reachedSuccessTerminal,
      reachedSuccessTerminal: res.reachedSuccessTerminal,
      agents: ctx.specs.map((s) => s.short),
      events: [],
      appId: res.appId,
      functionsRegistered: res.functionsRegistered,
      deployed: res.deployed,
      fullChainRan: res.fullChainRan,
      deployFailed: res.functionsRegistered === 0,
      degradedAgents: res.degradedAgents,
      runUrls: res.runs.map((r) => ({ runId: r.id, url: `#run-${r.id}`, status: r.status, fn: r.id })),
      agentRuns: res.agentRuns ?? [],
      cases: (ctx.testCases ?? []).map((c) => ({ name: c.name, entryEvent: c.entryEvent, payload: c.payload })),
      simulated: res.simulated,
      // #D: how the chain closed — N internal chains + M legitimate external handoffs.
      internalChains: res.internalChains,
      externalTerminals: res.externalTerminals,
    });
    const ok = res.functionsRegistered > 0 && res.fullChainRan;
    // Be honest: a simulated pass is graph-closure inference, NOT a real run. Say so in
    // the summary the brain reads (so it never claims a real "跑通"); FACTORY_REAL_DEPLOY=1 for real.
    const simNote = res.simulated ? "（⚠ 模拟验证：按事件图闭包推断会跑通，未真实部署执行；设 FACTORY_REAL_DEPLOY=1 做真实部署验证）" : "（真实部署执行 ✓）";
    // R2: a swallowed fire used to look like a silent ran:0 — now surface which entry events failed to dispatch.
    const failedFires = (res.fires ?? []).filter((f) => !f.ok);
    const fireNote = failedFires.length ? ` · ⚠ ${failedFires.length} 个入口事件没发成功：${failedFires.map((f) => `${f.event}(${f.error ?? "失败"})`).join("；")}` : "";
    // Phase 5 — close the reflection loop: a non-passing sandbox run AUTO-records a failure
    // reflection (it never did before — the brain had to remember to analyze_failure), so the next
    // build for this domain learns from it without manual prompting.
    if (!ok) {
      const lesson = res.degradedAgents.length
        ? `降级 agent：${res.degradedAgents.join("、")} —— 多为没绑到真实工具。下次先 ask_user 接入真实工具/补 I/O 契约，再 design_agent。`
        : failedFires.length
          ? `入口事件没发成功：${failedFires.map((f) => f.event).join("、")} —— 检查事件名是否对齐本体、Inngest 是否在跑。`
          : "事件链没到成功终态——用 inspect_run 看断在哪个 agent，多半是 trigger/emit 没对齐本体事件名。";
      await ctx.ports.reflection.record(ctx.domain, { summary: `沙箱未跑通：部署${res.functionsRegistered}·跑${res.ran}·成功终态=${res.reachedSuccessTerminal}`, lesson, failedStep: "sandbox_chain", kind: "failure" }).catch(() => {});
    }
    return { ok, summary: ok ? `沙箱已部署 ${res.functionsRegistered} 函数、跑 ${res.ran}、到成功终态 ✓${simNote}${fireNote}` : `沙箱未完全跑通：部署 ${res.functionsRegistered}、跑 ${res.ran}、成功终态=${res.reachedSuccessTerminal}${res.degradedAgents.length ? `、降级:${res.degradedAgents.join("、")}` : ""}${res.simulated ? "（模拟）" : ""}${fireNote}`, output: res };
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
        const text = await chatOnce(sys, digest, { temperature: 0.2, maxTokens: 1400, signal: ctx.signal, models: modelChain("review") });
        const m = text.match(/\[[\s\S]*\]/);
        const arr = m ? (JSON.parse(m[0]) as Array<Record<string, unknown>>) : [];
        if (Array.isArray(arr)) judge = arr.filter((x) => x && x.issue).map((x) => `🧠裁判·「${String(x.agent ?? "")}」: ${String(x.issue)}${x.evidence ? `（证据「${String(x.evidence).slice(0, 70)}」）` : ""}`);
      } catch {
        /* best-effort — fall back to the deterministic pass */
      }
    }
    const all = [...findings, ...judge];
    return { ok: all.length === 0, summary: all.length ? `审查发现 ${all.length} 处问题：${all.slice(0, 4).join("；")}` : "审查通过：确定性检查 + LLM 裁判均合规 ✓", output: { findings: all, deterministic: findings, judge } };
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

const create_skill: BrainTool = {
  name: "create_skill",
  description: "把一段可复用的 know-how 沉淀成技能：织入 agent prompt 的指导片段 + 推荐工具 + 决策规则。会①本次运行织进 design_agent，②持久化到技能库供以后复用。general=true 则跨域可用。先 use_skill 看库里有没有现成的。",
  parameters: params({ name: { type: "string" }, purpose: { type: "string" }, prompt_fragment: { type: "string" }, tools: { type: "array", items: { type: "string" } }, decision_rule: { type: "string" }, general: { type: "boolean" } }, ["name", "purpose", "decision_rule"]),
  async execute(args, ctx) {
    const name = String(args.name ?? "").trim();
    const skill = { name, purpose: String(args.purpose ?? ""), promptFragment: String(args.prompt_fragment ?? ""), tools: (args.tools as string[]) ?? [], decisionRule: String(args.decision_rule ?? "") };
    ctx.createdSkills.push(skill);
    ctx.emit({ t: "skill.created", name, purpose: skill.purpose });
    if (ctx.ports.skills) {
      const slug = kebab(name);
      await ctx.ports.skills.save({ slug, name, purpose: skill.purpose, promptFragment: skill.promptFragment, tools: skill.tools, decisionRule: skill.decisionRule, domain: args.general ? null : ctx.domain }).catch(() => {});
    }
    return { ok: true, summary: `技能「${name}」已创建${ctx.ports.skills ? "并入库" : "（本次运行内）"}，会织进相关 agent。`, output: { name } };
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
      const text = await chatOnce(sys, user, { temperature: 0.2, maxTokens: 1200, signal: ctx.signal, models: modelChain("review") });
      const m = text.match(/\{[\s\S]*\}/);
      const j = m ? (JSON.parse(m[0]) as Record<string, unknown>) : null;
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
        const text = await chatOnce(sys, state, { temperature: 0.3, maxTokens: 800, signal: ctx.signal, models: modelChain("review") });
        const m = text.match(/\{[\s\S]*\}/);
        const j = m ? (JSON.parse(m[0]) as { root_cause?: unknown; lesson?: unknown }) : null;
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
    if (!ctx.lastSandbox.fullChainRan) return { ok: false, summary: "上次沙箱没端到端跑到成功终态——先修到能跑通。" };
    // R2: a SIMULATED pass is graph-closure inference, not a real deploy+run — don't accept it as
    // delivery. Tell the user to start the Inngest stack and re-run; escape hatch for standalone dev.
    if (ctx.lastSandbox.simulated && process.env.FACTORY_ALLOW_SIMULATED_FINISH !== "1") {
      return { ok: false, summary: "上次沙箱是【模拟验证】(Inngest 未运行)，不算真交付。请启动 pnpm dev 后重新 sandbox_run 做真实部署+真跑验证；确需接受模拟证据可设 FACTORY_ALLOW_SIMULATED_FINISH=1。" };
    }
    // Phase 0a — enforce the FULL documented acceptance bar, not just the inline checks above.
    // This catches the gaps finish ignored: an agent with an unresolved tool, a chain that ran
    // but DEGRADED, an unbound rule gate, or an agent with no typed I/O payload.
    const gate = acceptanceGate(ctx.specs, ctx.ontology, ctx.lastSandbox);
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
    "拿不准 / 缺信息 / 测试卡住、且你自己判断不了时，直接问用户——不要瞎猜、也不要把 agent 默默降级。给一个清晰的问题 + 2-4 个具体可选项（其中标一个 recommended:true 作你的最佳推荐），用户可以选一个或补充文字。典型：某外部平台 API 的 input/output 工具库里查不到、需求歧义、某测试反复失败拿不准根因、是否要造模拟桩。问完【暂停等用户回答】再继续，别在等待时调别的工具。",
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
    const options = Array.isArray(args.options)
      ? (args.options as Array<Record<string, unknown>>).map((o) => ({ label: String(o.label ?? ""), value: String(o.value ?? o.label ?? ""), recommended: Boolean(o.recommended) })).filter((o) => o.label)
      : undefined;
    const context = args.context ? String(args.context) : undefined;
    ctx.clarifyPrompt = { question, options, context };
    ctx.awaitingClarify = true;
    ctx.emit({ t: "clarify", question, options, context, awaitingAnswer: true });
    return { ok: true, summary: `已向用户提问并【暂停等待回答】：「${question}」。用户回答后我会把答案发给你，你再继续——别在等待时调别的工具。`, output: { question, options, awaitingAnswer: true } };
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
    ctx.emit({ t: "agent.created", spec: cardOf(spec), design: designOf(spec) });
    // #C: record a "needs real integration" punch-list item — a mock closes the sandbox chain but
    // isn't deployable, so surface exactly what the FDE must wire post-generation.
    await ctx.ports.reflection.record(ctx.domain, { summary: `需要真实集成：${platform}（当前用模拟桩 ${spec.slug} 让链路跑通）`, lesson: `「${actionName}」依赖外部平台「${platform}」。晋升前需：① 在工具库接入 ${platform} 的真实工具（或 create_tool 包装其 HTTP API），② 提供其凭证/配置(env/config)，③ 把模拟桩 ${spec.slug} 换成真实 agent。`, failedStep: `external_integration_pending:${platform}`, kind: "caveat" }).catch(() => {});
    ctx.emit({ t: "reflect", kind: "caveat", lesson: `⚠ 待补真实集成：${platform}（${actionName} 现为模拟桩，晋升前需接入真实工具+凭证）` });
    return { ok: true, summary: `已造模拟外部平台 agent「模拟${platform}」(${trigger.join("/")} → ${emit.join("/")})——沙箱可借它跑通链路（标注 mock，可在晋升时排除）。⚠ 已记入待办：晋升前需为 ${platform} 接入真实工具+凭证。`, output: { slug: spec.slug, mock: true, needsRealIntegration: platform } };
  },
};

export const FACTORY_TOOLS: BrainTool[] = [
  ask_user,
  describe_design_constraints,
  create_mock_agent,
  read_ontology,
  list_domains,
  describe_domain,
  describe_object,
  create_plan,
  design_agent,
  codegen_agent,
  refine_agent,
  revert_refine,
  validate_graph,
  propose_boundary_events,
  verify_chain,
  generate_test_cases,
  sandbox_run,
  inspect_run,
  read_spec,
  score_spec,
  diff_spec,
  review_agent,
  list_agents,
  web_search,
  search_tools,
  fetch_doc,
  extract_api_schema,
  create_tool,
  create_skill,
  use_skill,
  analyze_failure,
  finish,
];

/** Test-only: the de-hardcoded rule-detection + design-time grounding helpers (#9/#B). */
export const __ruleTestHelpers = { ruleIdentifiers, promptEmbedsRule, looksLikeRuleGate, specIsRuleGate, rulesForAction };

/** Read-only subset for sub-agents (no deploy / no mutation). */
// R9: subagents are still read-only for AGENT/tool authoring, but gain scoped SKILL authoring
// (create_skill persists to the shared store so the parent + future runs absorb it) and
// constraint introspection. spawn_subagent is added by the conductor under a depth cap.
export const SUBAGENT_TOOLS: BrainTool[] = [read_ontology, list_domains, describe_domain, describe_object, list_agents, read_spec, inspect_run, web_search, search_tools, fetch_doc, extract_api_schema, analyze_failure, create_skill, describe_design_constraints];
