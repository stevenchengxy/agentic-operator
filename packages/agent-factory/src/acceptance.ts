// R15 — the RAAS-v1 acceptance bar, as an executable check (not just prose).
//
// Reverse-engineered from the 6 real RAAS-v1 agents: a generated agent set "reaches the
// standard" when it covers every Agent action, every tool resolves, a NON-simulated sandbox
// registered real functions and ran the chain to terminal with no degrade, the rule gates are
// bound to the runtime fetchActionRules, and every I/O is typed from the ontology event_data.
// This makes the bar testable + surfaceable; the actual live end-to-end run is the manual step.

import type { GeneratedAgentSpec } from "./spec-types";
import type { DomainOntology } from "./ontology-types";
import { coverageGap } from "./graph";

export interface AcceptanceSandbox {
  registeredIds?: string[];
  functionsRegistered?: number;
  ran?: number;
  fullChainRan?: boolean;
  /** the chain reached a SUCCESS (non-failish) terminal — strong evidence even when fullChainRan
   *  flickers false because slow rule-gate agents were still `running` at snapshot time. */
  reachedSuccessTerminal?: boolean;
  /** #REDESIGN P1 — spec shorts whose GENERATED CODE actually ran (not fell back to declarative). */
  codeRanAgents?: string[];
  degradedAgents?: string[];
  /** #R3 — shorts whose REAL emitted payload violated the downstream field contract
   *  (from evaluateExecutionFidelity over the sandbox agentRuns). Undefined ⇒ not graded ⇒ lenient pass. */
  fidelityFailures?: string[];
  simulated?: boolean;
}

export interface AcceptanceCriterion { key: string; label: string; pass: boolean; detail: string }
export interface AcceptanceReport { criteria: AcceptanceCriterion[]; allPass: boolean }

// #9 (de-hardcode): a rule gate is one bound to the runtime rule fetcher, OR whose action name
// matches a domain-agnostic, bilingual rule/check/gate vocabulary (not the narrow RAAS terms).
const isRuleGate = (s: GeneratedAgentSpec) => s.tools.includes("ontology.fetchActionRules") || /rule.?check|gate|guard|校验|审核|风控|合规|查重|dedup/i.test(s.actionName);

export function acceptanceReport(specs: GeneratedAgentSpec[], ontology: DomainOntology | null, sandbox: AcceptanceSandbox | null): AcceptanceReport {
  const agentActions = ontology ? ontology.actions.filter((a) => a.actor.includes("Agent")).map((a) => a.name) : [];
  const gap = ontology ? coverageGap(ontology.actions, specs.map((s) => s.actionName)) : agentActions;
  const unresolved = specs.filter((s) => (s.unresolvedTools ?? []).length);
  // Sub-agents are invoke-only helpers (invoked with the parent's data) — exempt from typed-payload
  // + ontology coverage, but still must have code + resolve their tools like any deliverable.
  const noPayload = specs.filter((s) => !s.isSubAgent).filter((s) => !(s.inputSchema?.length) && !(s.outputSchema?.length));
  const noCode = specs.filter((s) => !((s.generatedCode ?? "").trim())); // finish() enforces code — the bar must surface it too
  const gatesUnbound = specs.filter((s) => isRuleGate(s) && !s.tools.includes("ontology.fetchActionRules"));
  const reg = sandbox?.registeredIds?.length ?? sandbox?.functionsRegistered ?? 0;
  const realSpecs = specs.filter((s) => !/-mock-/.test(s.slug)); // mocks are sandbox stand-ins, not deliverables
  // #NEST — every SUB-AGENT must be referenced by some parent's plan `invoke` step (no orphans that
  // deploy but nothing calls). invoke targets the sub's `short` (= its manifest name).
  const subAgents = specs.filter((s) => s.isSubAgent);
  const invokedTargets = new Set(specs.flatMap((s) => (s.plan ?? []).filter((p) => p.kind === "invoke" && p.invoke).map((p) => p.invoke as string)));
  const orphanSubs = subAgents.filter((s) => !invokedTargets.has(s.short));
  // A parent invoke whose target isn't a deployed spec = a dangling call that soft-fails at runtime
  // (e.g. the sub was refined/reverted away). Catch it at finish, not silently in production.
  const allShorts = new Set(specs.map((s) => s.short));
  const danglingInvokes = [...invokedTargets].filter((t) => !allShorts.has(t));
  // #REDESIGN P1 — code-delivered agents (codeExecuted) whose generated code did NOT actually run in
  // the sandbox (fell back to declarative). A real sandbox must prove the code ran, or finish is a lie.
  const codeSpecs = specs.filter((s) => s.codeExecuted);
  const ranSet = new Set(sandbox?.codeRanAgents ?? []);
  const codeFellBack = sandbox && !sandbox.simulated ? codeSpecs.filter((s) => !ranSet.has(s.short)) : [];
  // #R3 — execution fidelity: agents whose REAL emitted payload violated the downstream contract.
  // Graded upstream (from the sandbox agentRuns) and threaded here.
  // #AUDIT-FIX(P1-02) — 三态而非二态：undefined 不再一律当 pass（fail-open）。真实跑过且有 agent
  // 运行、却【没采到保真证据】= UNKNOWN，按未知【阻断】finish（不能证明 emit 合法就不算通过）。
  // 模拟/未跑沙箱由 real_register/chain_ran 兜底，这里不重复扣分。
  const fidelityFail = sandbox?.fidelityFailures ?? [];
  const fidelityEvaluated = sandbox?.fidelityFailures !== undefined;
  const fidelityUnknown = !!sandbox && sandbox.simulated === false && (sandbox.ran ?? 0) > 0 && !fidelityEvaluated;

  const criteria: AcceptanceCriterion[] = [
    { key: "coverage", label: "覆盖全部 Agent 动作", pass: !!ontology && gap.length === 0, detail: gap.length ? `还差：${gap.join("、")}` : `${agentActions.length} 个全覆盖` },
    { key: "tools_resolve", label: "所有工具都能解析", pass: unresolved.length === 0, detail: unresolved.length ? `未解析：${unresolved.map((s) => s.short).join("、")}` : "无未解析工具" },
    { key: "real_register", label: "真实注册（非模拟）", pass: !!sandbox && sandbox.simulated === false && reg >= Math.max(1, realSpecs.length), detail: sandbox ? (sandbox.simulated ? "上次是模拟验证" : `注册 ${reg} 个函数`) : "未跑沙箱" },
    // Pass on fullChainRan OR reachedSuccessTerminal (both with zero degraded). reachedSuccessTerminal
    // means the fired chain reached a non-failish terminal; with verify_chain (static closure) +
    // zero degraded that's sufficient — fullChainRan alone can flicker false purely on snapshot timing
    // (slow ontology.fetchActionRules), which used to dead-loop finish.
    { key: "chain_ran", label: "链路端到端跑通", pass: (!!sandbox?.fullChainRan || !!sandbox?.reachedSuccessTerminal) && (sandbox?.degradedAgents?.length ?? 0) === 0, detail: sandbox ? `跑 ${sandbox.ran ?? 0}${sandbox.fullChainRan ? "·整链通" : sandbox.reachedSuccessTerminal ? "·达成功终态" : ""}${(sandbox.degradedAgents?.length ?? 0) ? ` · 降级 ${sandbox.degradedAgents!.join("、")}` : ""}` : "未跑沙箱" },
    { key: "rule_gates", label: "规则闸已绑 fetchActionRules", pass: gatesUnbound.length === 0, detail: gatesUnbound.length ? `未绑：${gatesUnbound.map((s) => s.short).join("、")}` : "已绑或无规则闸" },
    { key: "typed_payloads", label: "I/O 都从 event_data 类型化", pass: specs.length > 0 && noPayload.length === 0, detail: noPayload.length ? `无 schema：${noPayload.map((s) => s.short).join("、")}` : "全部已类型化" },
    { key: "has_code", label: "所有 agent 都有代码", pass: specs.length > 0 && noCode.length === 0, detail: noCode.length ? `缺代码：${noCode.map((s) => s.short).join("、")}` : "全部已生成代码" },
    { key: "sub_agents_bound", label: "子 agent 都被父 invoke·无悬空调用", pass: orphanSubs.length === 0 && danglingInvokes.length === 0, detail: danglingInvokes.length ? `悬空 invoke（目标不存在）：${danglingInvokes.join("、")}` : subAgents.length ? (orphanSubs.length ? `孤儿子 agent（没被 invoke）：${orphanSubs.map((s) => s.short).join("、")}` : `${subAgents.length} 个子 agent 均已被父调用`) : "无子 agent" },
    { key: "code_really_ran", label: "生成代码真的执行（非回退声明式）", pass: codeFellBack.length === 0, detail: codeFellBack.length ? `标了执行代码但回退了声明式（没真跑）：${codeFellBack.map((s) => s.short).join("、")}` : codeSpecs.length ? `${codeSpecs.length} 个代码型 agent 的代码均真跑` : "无代码执行型 agent（声明式）" },
    { key: "execution_fidelity", label: "真实 emit 满足下游契约（不 output_parse_error）", pass: fidelityFail.length === 0 && !fidelityUnknown, detail: fidelityUnknown ? "⚠ 无法评估执行保真（真实跑了但没采到 emit 载荷/证据）——按未知阻断，不算通过；重跑沙箱或检查 agentRuns 采集" : fidelityFail.length ? `emit 载荷违反下游契约：${fidelityFail.join("、")}` : fidelityEvaluated ? "全部 emit 载荷满足契约" : "未评估（模拟或未跑沙箱）" },
  ];
  return { criteria, allPass: criteria.every((c) => c.pass) };
}

/** The conductor records sandbox evidence under its OWN field names (deployed / agentsRan /
 *  ranAgents — see tools.ts ctx.lastSandbox). This is the shape the finish gate has on hand. */
export interface SandboxEvidenceLike {
  deployed?: number;
  functionsRegistered?: number;
  agentsRan?: number;
  ran?: number;
  ranAgents?: string[];
  registeredIds?: string[];
  fullChainRan?: boolean;
  reachedSuccessTerminal?: boolean;
  codeRanAgents?: string[];
  degradedAgents?: string[];
  fidelityFailures?: string[];
  simulated?: boolean;
}

/** Phase 0a — bridge the conductor's lastSandbox shape onto the documented acceptance bar and
 *  return the failing criteria, so `finish` can enforce coverage + tools_resolve + real_register +
 *  chain_ran(no-degrade) + rule_gates + typed_payloads instead of its weaker inline checks. */
export function acceptanceGate(
  specs: GeneratedAgentSpec[],
  ontology: DomainOntology | null,
  sandbox: SandboxEvidenceLike | null,
): { pass: boolean; failing: AcceptanceCriterion[]; report: AcceptanceReport } {
  const sb: AcceptanceSandbox | null = sandbox
    ? {
        // ranAgents = who ran, not the registration count — leave registeredIds to an explicit
        // value and otherwise fall back to the deployed/functionsRegistered count.
        registeredIds: sandbox.registeredIds,
        functionsRegistered: sandbox.functionsRegistered ?? sandbox.deployed,
        ran: sandbox.ran ?? sandbox.agentsRan,
        fullChainRan: sandbox.fullChainRan,
        reachedSuccessTerminal: sandbox.reachedSuccessTerminal,
        codeRanAgents: sandbox.codeRanAgents,
        degradedAgents: sandbox.degradedAgents ?? [],
        fidelityFailures: sandbox.fidelityFailures,
        simulated: sandbox.simulated,
      }
    : null;
  const report = acceptanceReport(specs, ontology, sb);
  return { pass: report.allPass, failing: report.criteria.filter((c) => !c.pass), report };
}
