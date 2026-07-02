// Live-runthrough harness helpers (pure, testable). Used by the api ManifestSandboxDeployer to:
//  (1) auto-synthesize MOCK external-platform agents so a chain with external handoffs still runs
//      end-to-end in the isolated sandbox (the brain's create_mock_agent, but automatic), and
//  (2) turn per-subject run observations into a CaseRunOutcome for chainVerdictByKind (verification.ts),
//      so a reject case that correctly reaches a FAIL terminal counts as a PASS.

import type { GeneratedAgentSpec } from "./spec-types";

function kebab(s: string): string {
  return (s || "").replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase() || "x";
}
function domainPrefix(domain: string): string {
  return kebab(domain).split("-")[0]!.slice(0, 12) || "d";
}

export interface MockSynthOpts {
  domainId: string;
  /** entry events actually fired in the sandbox (so they don't count as orphan triggers) */
  firedEntries?: string[];
  /** declared success/fail terminals (so a real terminal isn't treated as a dangling handoff) */
  terminals?: string[];
}

/** Detect orphan TRIGGER events — consumed by an internal agent but produced by neither an internal
 *  agent nor a fired entry — i.e. events an EXTERNAL platform would send back. For each, synthesize a
 *  mock agent that fires on the upstream handoff (a dangling internal emit) — or the fired entries
 *  when there's no handoff — and emits the orphan trigger, closing the chain. Mock slugs contain
 *  "-mock-" so acceptanceReport excludes them from the real-deliverable count. */
/** #REDESIGN P1b — the external-INPUT events a chain depends on: consumed by an internal agent but
 *  produced by neither an internal agent nor a fired entry (an external platform would send them).
 *  Instead of a MOCK producer agent, the deployer FIRES these directly as real entries (zero mock),
 *  so the chain closes on real events. Same set synthesizeMockExternalAgents used to stub. */
export function externalInputEvents(specs: GeneratedAgentSpec[], opts: MockSynthOpts): string[] {
  const produced = new Set(specs.flatMap((s) => s.emit ?? []).filter(Boolean));
  const consumed = new Set(specs.flatMap((s) => s.trigger ?? []).filter(Boolean));
  const fired = new Set(opts.firedEntries ?? []);
  return [...consumed].filter((e) => e && e !== "—" && !produced.has(e) && !fired.has(e));
}

export function synthesizeMockExternalAgents(specs: GeneratedAgentSpec[], opts: MockSynthOpts): GeneratedAgentSpec[] {
  const produced = new Set(specs.flatMap((s) => s.emit ?? []).filter(Boolean));
  const consumed = new Set(specs.flatMap((s) => s.trigger ?? []).filter(Boolean));
  const fired = new Set(opts.firedEntries ?? []);
  const terminals = new Set(opts.terminals ?? []);

  const orphanTriggers = [...consumed].filter((e) => e && e !== "—" && !produced.has(e) && !fired.has(e));
  if (!orphanTriggers.length) return [];

  const danglingEmits = [...produced].filter((e) => e && e !== "—" && !consumed.has(e) && !terminals.has(e));
  const upstream = danglingEmits.length ? danglingEmits : [...fired];
  if (!upstream.length) return []; // nothing to hang the mock on → can't safely close it

  const prefix = domainPrefix(opts.domainId);
  return orphanTriggers.map((trigEvent) => {
    const actionName = `mock_ext_${kebab(trigEvent).replace(/-/g, "_")}`;
    return {
      key: actionName,
      actionName,
      slug: `${prefix}-mock-ext-${kebab(trigEvent)}`,
      short: `MockExt_${kebab(trigEvent).replace(/-/g, "_")}`,
      domainId: opts.domainId,
      nameZh: `模拟外部平台→${trigEvent}`,
      kind: "llm",
      trigger: upstream,
      emit: [trigEvent],
      tools: [],
      unresolvedTools: [],
      objects: [],
      systemPrompt: `你在沙箱里【模拟一个外部平台】：当收到 ${upstream.join(" / ")} 后，按事件契约产出一份代表性的 ${trigEvent} payload（真实感数据，字段对齐 event_data），让事件链能端到端跑通。这是模拟桩，不是真实集成。`,
      userPrompt: "",
      steps: [],
      ruleRefs: [],
      retries: 1,
      hitl: false,
      confidence: 0.5,
      promptSource: "llm",
    } as GeneratedAgentSpec;
  });
}

// ── per-case outcome from observed runs ─────────────────────────────────────

export interface ObservedRun {
  status: string;
  /** the canonical event this run emitted (joined runs→events), if any */
  emittedEvent?: string | null;
}

export interface CaseRunOutcomeShape {
  kind: "pass" | "reject" | "edge" | "fault";
  reachedSuccessTerminal: boolean;
  reachedFailTerminal: boolean;
  crashed: boolean;
  degraded?: boolean;
}

// Aligned with the deployer: RUN_FAILED matches a run STATUS; FAILISH matches a fail-terminal EVENT
// name (REJECT/CONFLICT/DENIED count as clean reject paths, not crashes).
const RUN_FAILED_RE = /fail|cancel|abort|error/i;
const FAILISH_EVENT_RE = /FAIL|REJECT|ERROR|CONFLICT|DENIED|FAILED/i;

/** Compute a CaseRunOutcome from the runs observed for ONE test case's subject. crashed = no runs
 *  routed at all (broken wiring). A failed-status run OR a FAILish emitted event = reached a fail
 *  terminal (a clean reject path). A success-terminal emit = reached success. */
export function caseOutcomeFromRuns(
  kind: "pass" | "reject" | "edge" | "fault",
  runs: ObservedRun[],
  opts: { successTerminals: string[]; degraded?: boolean },
): CaseRunOutcomeShape {
  const success = new Set(opts.successTerminals);
  const crashed = runs.length === 0;
  const reachedSuccessTerminal = runs.some((r) => r.emittedEvent != null && success.has(r.emittedEvent));
  const reachedFailTerminal = runs.some(
    (r) => RUN_FAILED_RE.test(r.status) || (r.emittedEvent != null && FAILISH_EVENT_RE.test(r.emittedEvent)),
  );
  return { kind, reachedSuccessTerminal, reachedFailTerminal, crashed, degraded: opts.degraded };
}
