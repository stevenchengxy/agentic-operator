// Autonomous Harness Brain — shared types (migrated + adapted for the new arch).
//
// The brain is a streaming ReAct loop: it reasons, calls tools, observes, loops.
// These are the streamed events (rendered live in the chatbot) + the tool contract.
// Adapted from the OLD lib/agent-factory-v3/brain/types.ts: the registry/prisma
// couplings are gone — the brain now depends only on the injected FactoryPorts.

import type { DomainOntology } from "./ontology-types";
import type { GeneratedAgentSpec } from "./spec-types";
import type { FactoryPorts } from "./ports";

/** A generated agent, trimmed for the UI card. */
export type AgentCardLite = {
  slug: string;
  /** the ontology action this agent implements — the key score.delta/refine events use, so the
   *  UI can match a score to its node (slug/short are derived forms that never equal it). */
  actionName: string;
  short: string;
  nameZh: string;
  trigger: string[];
  emit: string[];
  tools: string[];
  /** tools the brain wanted but the library doesn't have yet (shown as "待人工实现"). */
  unresolved?: string[];
};

/** The LLM's authored design for one agent — surfaced as collapsible reasoning. */
export type AgentDesignLite = {
  reasoning: string;
  systemPrompt: string;
  toolRationale: string;
  decisionLogic: string;
  code?: string;
  codeSource?: "ai" | "render";
  /** #REDESIGN FU3 — graded truly executable (CodeAct): compiled + AST-linted + load-probed. When
   *  false the runtime executes it declaratively; `probeReason` says why the code was rejected. */
  codeExecuted?: boolean;
  probeReason?: string;
};

/** An explicit plan artifact the brain produces after read_ontology and before
 *  per-agent design — lets it decompose once and replan if validation reveals a flaw. */
export type BuildPlan = {
  summary: string;
  agents: Array<{
    actionName: string;
    role: string;
    triggerEvents: string[];
    emitEvents: string[];
    toolCandidates: string[];
    edgeCases: string[];
  }>;
  notes: string[];
  version: number;
};

/** 4-dimension deterministic quality score for one spec (each 0-100). */
export type ScoreDims = {
  toolResolution: number;
  promptRichness: number;
  decisionCoverage: number;
  refineHealth: number;
};

/** One revision attempt on a single agent — stored in ctx.attemptHistory so
 *  refine_agent passes the prior spec + critique back instead of blind-overwriting,
 *  and revert_refine can roll back. */
export type RefineAttempt = {
  attemptNumber: number;
  priorSpecSnapshot: { systemPrompt: string; tools: string[]; decisionLogic?: string };
  /** #W1 — FULL deep snapshot of the prior spec (schemas/plan/code included) so revert_refine is a
   *  complete rollback, not the 3-field partial one that left half-reverted schema state. */
  fullSnapshot?: Record<string, unknown>;
  /** #W1 — this attempt's score delta, for convergence detection (two near-zero deltas → stop). */
  delta?: number;
  critique: string;
  changes: string;
};

/** A full-flow test case the brain authors before sandbox_run (pass/reject/edge) —
 *  one entry event + a real payload that exercises one path of the event graph. The
 *  user approves/regenerates before any real fire. */
export type TestCase = {
  id: string;
  name: string;
  scenario: string;
  kind: "pass" | "reject" | "edge" | "fault";
  entryEvent: string;
  payload: Record<string, unknown>;
  expectedOutcome: string;
};

/** A boundary event = an event some agent EMITS but no INTERNAL agent consumes. Inngest
 *  events are global, so a consumer-less emit is often a legitimate handoff to an EXTERNAL
 *  platform / webhook / terminal — NOT a broken chain. The user classifies each. */
export type BoundaryEvent = {
  event: string;
  kind: "external" | "terminal" | "break";
  consumer?: string;        // external: which platform/service/team consumes it
  payloadContract?: string; // external: the payload the consumer should expect
  note?: string;
};
/** The brain's proposed classification for a dangling event, shown on the decision card. */
export type BoundaryProposal = {
  event: string;
  suggestedKind: "external" | "terminal" | "break";
  why: string;
  producers: string[];
  consumer?: string;
  payloadContract?: string;
};

/** Per-agent REAL I/O after a sandbox settles — the evidence the verification panel
 *  shows (real runId + real payloads, not a paper claim). */
export type AgentRunIO = {
  agentSlug: string;
  agentShort: string;
  status: string;
  degraded: boolean;
  triggerEvent: string | null;
  inputPayload: Record<string, unknown> | null;
  tools: string[];
  outputEvent: string | null;
  reasoning: string;
  outputPayload: Record<string, unknown> | null;
  runId: string;
  url?: string;
};

/** A reflection persisted via analyze_failure, loaded on the next run for the domain. */
export type ReflectionLite = {
  kind: "failure" | "success" | "caveat";
  summary: string;
  rootCause?: string;
  lesson: string;
  createdAt: string;
};

/** The 6 canonical factory pipeline stages — drives the live-canvas stage rail and the
 *  always-visible health/progress strip. The conductor emits an explicit `stage` event on
 *  each stage-bearing tool; the web client also infers a fallback from `event.t` so runs
 *  recorded before stage events existed (and sub-agent runs) still light the rail. */
export type FactoryStage = "read" | "plan" | "design" | "validate" | "sandbox" | "deliver";

/** Streamed to the chatbot — the live trace of the brain's reasoning + acts. */
export type BrainEvent =
  | { t: "think"; delta: string } // streamed reasoning token
  | { t: "tool.call"; id: string; name: string; reasoning: string; input: unknown }
  | { t: "tool.result"; id: string; name: string; ok: boolean; summary: string; output?: string }
  | { t: "agent.created"; spec: AgentCardLite; design?: AgentDesignLite }
  | { t: "catalog"; domain: string; actions: number; events: number; agentActions: number } // read_ontology summary
  | { t: "plan"; plan: BuildPlan }
  | { t: "validation"; ok: boolean; issues: string[]; agentIssueMap?: Record<string, unknown[]> }
  | {
      t: "sandbox";
      ran: number;
      reachedTerminal: boolean;
      reachedSuccessTerminal?: boolean;
      agents: string[];
      events: string[];
      appId?: string;
      functionsRegistered?: number;
      /** the function ids actually registered on the sandbox app this commit (= agent slugs) —
       *  proof of WHICH agents deployed, surfaced in the UI as the per-app registration list. */
      registeredIds?: string[];
      /** #REDESIGN P1a — spec shorts whose GENERATED CODE actually EXECUTED (真跑, not fell back). */
      codeRanAgents?: string[];
      deployed?: number;
      fullChainRan?: boolean;
      deployFailed?: boolean;
      degradedAgents?: string[];
      /** #D — how the chain closed: N internal chains + M legitimate external-handoff terminals. */
      internalChains?: number;
      externalTerminals?: number;
      runUrls?: Array<{ runId: string; url: string; status: string; fn: string }>;
      /** per-agent REAL I/O captured after the run settled (Feature: agent-io). */
      agentRuns?: AgentRunIO[];
      /** the approved test cases that were fired (Feature: test-case loop). */
      cases?: Array<{ name: string; entryEvent: string; payload: Record<string, unknown> }>;
      /** #W3-FAULT — per-fired-case verdict by KIND (pass/reject/edge/fault). A fault case PASSES
       *  precisely when the chain REFUSED to reach a success terminal under an injected tool fault
       *  (proving error propagation, not silent success). Surfaced as per-kind verdict chips. */
      caseVerdicts?: {
        allPass: boolean;
        results: Array<{ kind: string; pass: boolean; reason: string }>;
        byKind: Record<string, { total: number; passed: number }>;
      };
      /** TRUE = a graph-closure SIMULATION, not a real Inngest deploy+run. The UI must
       *  badge it so a simulated pass is never mistaken for a verified real deploy. */
      simulated?: boolean;
    }
  | { t: "refine"; actionName: string; critique: string; diff?: { systemPromptChanged: boolean; toolsAdded: string[]; toolsRemoved: string[]; decisionLogicChanged: boolean } }
  | { t: "score.delta"; actionName: string; priorTotal: number; newTotal: number; delta: number; regression: boolean; dimensions: ScoreDims }
  | { t: "revert"; actionName: string; revertedToAttempt: number }
  | { t: "inspect"; runId: string; agentSlug: string; status: string; degraded?: boolean; error?: string }
  | { t: "skill.created"; name: string; purpose: string }
  | { t: "tool.created"; name: string; description: string }
  | { t: "tool.search"; query: string; results: Array<{ name: string; summary: string; sideEffect: string }> } // progressive tool discovery
  | { t: "tool.schema"; name: string; method: string; url: string; fields: number } // doc→tool schema extracted
  | { t: "web.result"; query: string; results: Array<{ title: string; url: string; snippet: string }> }
  | { t: "subagent.start"; task: string }
  | { t: "subagent.done"; task: string; summary: string }
  | { t: "code"; actionName: string; code: string; codeSource: "ai" | "render" }
  // Explicit pipeline-stage signal. status: "active" = the brain entered/is working this
  // stage; "ok"/"error" = its tool settled. Drives the live-canvas stage rail + health strip
  // directly, instead of every consumer re-inferring a stage from heterogeneous event types.
  | { t: "stage"; stage: FactoryStage; status: "active" | "ok" | "error"; detail?: string }
  | { t: "test.cases"; cases: TestCase[]; awaitingApproval: boolean; coverage?: { required: string[]; covered: string[]; backfilled: string[]; uncoveredNeedingData: string[] } }
  | { t: "test.decision"; decision: "approve" | "regenerate"; note?: string }
  // Boundary events the brain proposes for the user to classify (external handoff /
  // terminal / break). awaitingDecision=true → the conductor is PARKED for the choice.
  | { t: "boundary.cases"; proposals: BoundaryProposal[]; awaitingDecision: boolean }
  | { t: "boundary.decided"; events: BoundaryEvent[] }
  // ask_user: a general clarification the brain raises when uncertain / missing info. The
  // conductor PARKS (awaitingAnswer) until the user supplies a free-text answer or picks an
  // option (one may be the AI's recommendation). Keeps generation flexible, not rigid.
  | { t: "clarify"; question: string; options?: Array<{ label: string; value: string; recommended?: boolean }>; context?: string; awaitingAnswer: boolean }
  | { t: "reflect"; kind: string; lesson: string; count?: number }
  // #7 — which model served this turn + the difficulty tier it was routed to (annotated in the
  // activity log). The router picks fast/default/hard from the live context, config-driven.
  | { t: "model"; model: string; tier: string; turn: number }
  | {
      t: "budget";
      turn: number;
      maxTurns: number;
      tokens: number;
      maxTokens: number | null;
      specsBuilt: number;
      sandboxRuns?: number;
      level?: "ok" | "elevated" | "high";
      costNote?: string;
    }
  | { t: "message"; text: string } // the brain's narration / final answer
  // #2d — auto-compaction made visible: `summary` is the one-line notice, `state` is the full
  // structured snapshot that was folded, rendered behind an expand toggle in the transcript.
  | { t: "compaction"; summary: string; state: string }
  // Only "finished" (finish PASSED the acceptance gate) is success; everything else
  // is a failed/incomplete run so a budget/turn-exhausted/errored run never reads green.
  | { t: "done"; tokensUsed: number; turns: number; status: "finished" | "budget_exhausted" | "turns_exhausted" | "errored" | "incomplete" }
  | { t: "error"; message: string };

export type BrainEmit = (e: BrainEvent) => void;

export interface BrainToolResult {
  ok: boolean;
  /** one-line result the model sees + the UI shows */
  summary: string;
  /** structured payload fed back to the model as the tool result */
  output?: unknown;
}

/** The brain's working state for a run. Carries the injected ports + accumulated
 *  artifacts. Serializable subset (everything except `emit`/`ports`/`signal`) is what
 *  the ConversationStore persists so a follow-up message resumes mid-build. */
export interface BrainCtx {
  domain: string;
  goal: string;
  emit: BrainEmit;
  ports: FactoryPorts;
  /** accumulated generated specs (design_agent appends here) */
  specs: GeneratedAgentSpec[];
  /** cached after read_ontology */
  ontology: DomainOntology | null;
  /** #4 — signature of the ontology at first read (counts), so a mid-run re-read can flag drift
   *  (the Allmeta graph changed under already-built specs) instead of silently swapping ground truth. */
  ontologySig?: string;
  budget: { maxTokens: number | null; maxTurns: number };
  spent: { tokens: number; turns: number; sandboxRuns: number;
    /** #W2-STAGE — token spend attributed to the current pipeline stage (admission-gated state machine). */
    stageTokens?: Record<string, number> };
  /** explicit BuildPlan (create_plan sets it; design/refine read it). */
  currentPlan: BuildPlan | null;
  /** the domain's tool grounding catalog (built from the ontology's tool_use on read). */
  toolCatalog: string[];
  /** #C — the REAL global tools (name/summary/configKeys), loaded from ports.toolRegistry at
   *  read_ontology, so the brain can be recommended real tools by semantic rank + told what config
   *  to supply, even when the ontology declared none. */
  realTools?: Array<{ name: string; summary?: string; configKeys?: string[]; category?: string; aliases?: string[] }>;
  /** #B — design-time rule grounding: per Agent-action, the relevant business rules (id-prefix or
   *  text match) so design_agent reasons rule-grounded, not blind. Runtime fetchActionRules still
   *  enforces at execution time. Keyed by action name. */
  rulesByAction?: Record<string, Array<{ id: string; name: string; summary: string }>>;
  /** per-action refinement history (refine snapshots + critiques; read by refine/revert/read_spec). */
  attemptHistory: Record<string, RefineAttempt[]>;
  /** #W2-HITL — human messages drained but TAGGED for a different gate: re-queued here so the right
   *  gate consumes them next tick instead of the wrong gate eating (and mis-parsing) them. */
  pendingHuman?: string[];
  /** skills the brain authored this run (woven into generated agents). */
  createdSkills: Array<{ name: string; purpose: string; promptFragment: string; tools: string[]; decisionRule: string }>;
  /** facts gathered via web_search (fed into agent prompts as grounding). */
  research: Array<{ query: string; findings: string }>;
  /** test cases the brain authored (generate_test_cases); fired by sandbox_run after approval. */
  testCases?: TestCase[];
  /** real values the USER supplied (supply_test_data) to replace demo placeholders for contact /
   *  credential / id fields (e.g. a real interview email) — applied into the fired test payloads. */
  testDataOverrides?: Record<string, unknown>;
  /** true while parked waiting for the user's 执行/重新生成 decision on the test cases. */
  awaitingApproval?: boolean;
  /** boundary events the user CLASSIFIED (external handoff / terminal / break) — graph
   *  validation honors external + terminal so they aren't false-flagged as broken chains. */
  boundaryEvents?: BoundaryEvent[];
  /** true while parked for the user's boundary-event decision (`[边界事件决策…]`). */
  awaitingBoundary?: boolean;
  /** ask_user park: true while waiting for the user's clarification answer; the prompt is
   *  kept so a park timeout can fall back to the AI's recommended option. */
  awaitingClarify?: boolean;
  clarifyPrompt?: { question: string; options?: Array<{ label: string; value: string; recommended?: boolean }>; context?: string };
  /** the proposals awaiting decision, kept so a park TIMEOUT can auto-apply the AI's kinds. */
  boundaryProposals?: BoundaryProposal[];
  /** outcome of the last sandbox_run — the finish gate requires real end-to-end
   *  evidence, tied to the exact specs via fingerprint so a changed spec can't
   *  finish on stale-green evidence. */
  lastSandbox: {
    specsFingerprint: string;
    deployed: number;
    agentsRan: number;
    ranAgents: string[];
    reachedTerminal: boolean;
    reachedSuccessTerminal: boolean;
    fullChainRan: boolean;
    /** #REDESIGN P1 — spec shorts whose generated code actually executed (not fell back). */
    codeRanAgents?: string[];
    degradedAgents: string[];
    /** R2: true = graph-closure SIMULATION (Inngest not reachable), not a real deploy+run.
     *  The finish gate refuses simulated evidence unless FACTORY_ALLOW_SIMULATED_FINISH=1. */
    simulated: boolean;
    ts: number;
  } | null;
  /** last validate_graph result with per-agent backref (refine reads agentIssueMap[slug]). */
  lastValidation: { agentIssueMap: Record<string, unknown[]>; ok: boolean } | null;
  /** authoritative directives a human injected mid-run (HITL). */
  humanDirectives: string[];
  /** the intent gate's structured reading of the user's goal(s) — APPENDED per new goal so the
   *  conversation's intent history accumulates. Fold-surviving + serialized via serializeCtx. */
  userIntent?: string;
  /** capability_resolve 的决策表摘要（复用/组合/新造 per action，G1 能力解析门）——设计阶段
   *  持续引用「先选型再制造」的结论。Fold-surviving + serialized via serializeCtx. */
  capabilityResolution?: string;
  /** the brain's explicit, AI-synthesized understanding of the ontology (understand_ontology) —
   *  kept so the design phase reasons over a digested model, not a raw re-read ("读了就忘"). */
  ontologyUnderstanding?: string;
  /** reflections loaded on start from prior runs of this domain. */
  priorReflections: ReflectionLite[];
  /** the conversation key (durability) + abort signal (client disconnect). */
  conversationId?: string;
  signal?: AbortSignal;
  /** sub-brain recursion depth (0 = main brain) — bounds spawn_subagent fan-out (R9). */
  subagentDepth?: number;
}

export interface BrainTool {
  name: string;
  description: string;
  /** JSON schema for the args. MUST include a `reasoning` string so the model
   *  articulates WHY before acting (some models emit no content before tool calls). */
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, ctx: BrainCtx): Promise<BrainToolResult>;
}
