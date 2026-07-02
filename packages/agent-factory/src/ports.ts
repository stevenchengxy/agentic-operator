// The injected PORTS that decouple the brain from the OLD repo's concrete
// infrastructure (Prisma/Postgres, Inngest dynamic createFunction, Neo4j/Allmeta).
//
// This is the keystone of the migration. The conductor + tools will depend ONLY on
// these interfaces; each runtime provides a concrete implementation:
//   - the OLD app  → Neo4j/Allmeta + dynamic createFunction + Postgres tables
//   - the NEW apps/api → manifest JSON (models/<tenant>/) + manifest-import + Drizzle
//
// Defining the ports up-front (M1-b) is what lets M1-c port the conductor without
// dragging Prisma/Inngest/Neo4j along, and lets M2/M3 implement deploy + storage for
// the new architecture behind a stable surface. Signatures are the migration's
// design contract; concrete method shapes get finalized as the conductor is ported.

import type { DomainOntology } from "./ontology-types";
import type { GeneratedAgentSpec } from "./spec-types";
import type { AgentRunIO } from "./brain-types";
import type { RealTool } from "./tool-catalog";

/** Reads the business ontology the factory grounds agents in.
 *  OLD: Neo4j/Allmeta (lib/ontology-generator/ontology-source).
 *  NEW: manifest JSON under models/<tenant>/ (the new monorepo dropped Neo4j). */
export interface OntologySource {
  /** front-desk intent: enumerate available domains (the list_domains tool). */
  listDomains(): Promise<Array<{ id: string; name?: string; counts?: Record<string, number> }>>;
  /** Strict, no-fallback live read — the factory refuses to hallucinate against a
   *  stub, so a missing domain throws rather than returning an empty ontology. */
  fetchOntology(domainId: string): Promise<DomainOntology>;
  /** Action→step→Rule edges fetched live, so rule-check BINDS rules at run time
   *  instead of baking them into a prompt (the fetchActionRules tool). */
  fetchActionRules(domainId: string, actionName: string): Promise<unknown[]>;
}

/** What a sandbox deploy + observe returns — the deploy evidence the finish gate
 *  checks (functionsRegistered>0, ran===deployed, reachedSuccessTerminal). */
export interface SandboxDeployResult {
  appId: string;
  functionsRegistered: number;
  ran: number;
  deployed: number;
  reachedSuccessTerminal: boolean;
  fullChainRan: boolean;
  /** #REDESIGN P1 — spec shorts whose GENERATED CODE actually EXECUTED (runs.code_ran=true), not
   *  fell back to declarative. finish requires every codeExecuted spec to be here. */
  codeRanAgents?: string[];
  degradedAgents: string[];
  runs: Array<{ id: string; status: string }>;
  /** per-agent REAL I/O reconstructed after the run settled (Feature: agent-io). */
  agentRuns?: AgentRunIO[];
  /** content hash of the deployed specs — guards against a stale prior sandbox. */
  fingerprint: string;
  /** TRUE = the result is a graph-closure SIMULATION (DryRunSandboxDeployer), not a
   *  real Inngest deploy+run. The finish gate + UI must never present a simulated pass
   *  as a verified real deploy — surface it as "模拟" so green checks are trustworthy. */
  simulated?: boolean;
  /** R2: per-fired-event delivery trace — was silently swallowed (.catch(()=>{})). Lets the
   *  brain/UI see which `${tenant}/${event}` envelopes Inngest actually accepted. */
  fires?: Array<{ event: string; ok: boolean; error?: string }>;
  /** R2: the Inngest function ids registered by the commit (proof, not just a count). */
  registeredIds?: string[];
  /** #D — 跑通 redefinition: how the chain closed. internalChains = agents that ran into an
   *  internal/success terminal; externalTerminals = agents whose emit is a legitimate external
   *  HANDOFF (consumed by an external platform, not a broken chain). Surfaced so the UI shows
   *  "整链跑通：N 内部链 + M 外部交接终态". */
  internalChains?: number;
  externalTerminals?: number;
  /** T1 — per-test-case verdict by KIND (pass→reached success terminal; reject→reached FAIL
   *  terminal, NOT counted against success; edge→completed without crash). Present when the fired
   *  cases carried a kind; its allPass then drives fullChainRan (resolving the reject-case
   *  contradiction where a correct rejection used to fail a success-only chain gate). */
  caseVerdicts?: {
    allPass: boolean;
    results: Array<{ kind: string; pass: boolean; reason: string }>;
    byKind: Record<string, { total: number; passed: number }>;
  };
  /** T2 — mock external-platform agents auto-synthesized to close external handoffs in the sandbox
   *  (slugs contain "-mock-"; excluded from the real-deliverable count). */
  mockExternalAgents?: string[];
}

/** Deploys generated specs to a sandbox, fires an entry event, observes the run,
 *  then tears down.
 *  OLD: dynamic createFunction + registerDomainApp (server/inngest/domain-app).
 *  NEW: write models/<tenant>/workflow.json → manifest-import commit → reregister. */
export interface SandboxDeployer {
  deployAndObserve(
    domainId: string,
    specs: GeneratedAgentSpec[],
    opts?: {
      dryRun?: boolean;
      // T1: a test case may carry its KIND so the deployer fires it on a distinct subject and
      // judges its outcome per-kind (reject reaching a FAIL terminal = pass).
      testCases?: Array<{ entryEvent: string; payload: Record<string, unknown>; kind?: "pass" | "reject" | "edge" | "fault" }>;
      /** #D — the user's boundary classification, threaded to the verdict so an external-handoff
       *  emit (consumed by an external platform) counts as a legitimate terminal, not a broken chain. */
      boundaryEvents?: Array<{ event: string; kind: string }>;
    },
  ): Promise<SandboxDeployResult>;
  /** revert the sandbox app to 0 functions (the steady state). */
  teardown(domainId: string): Promise<void>;
}

/** Durable brain conversation + the human-message mailbox (HITL inject).
 *  OLD: Postgres factory_conversation + factory_human_msg.
 *  NEW: Drizzle/SQLite. Rehydrate-before-resume is what survives a server restart. */
export interface ConversationStore {
  has(conversationId: string): Promise<boolean>;
  load(conversationId: string): Promise<{ messages: unknown[]; ctx: Record<string, unknown> } | null>;
  save(
    conversationId: string,
    snapshot: { domain: string; messages: unknown[]; ctx: Record<string, unknown> },
  ): Promise<void>;
  /** drain queued human messages to inject at the next turn boundary (HITL). */
  drainHumanMessages(conversationId: string): Promise<string[]>;
}

/** Persists + loads failure reflections (what failed + the lesson) so later runs
 *  learn. OLD: FailureReflection table. NEW: Drizzle/SQLite.
 *  Fail-safe by contract: `record` must never throw back into the loop. */
export interface ReflectionWriter {
  record(
    domainId: string,
    // Phase 5 — `kind` carries the real failure/success/caveat distinction so it round-trips into
    // the next build's lessons (was dropped: stores hardcoded "caveat", flattening the signal).
    reflection: { summary: string; lesson: string; failedStep?: string; kind?: "failure" | "success" | "caveat" },
  ): Promise<void>;
  /** prior reflections for this domain, newest first — injected into the system prompt. */
  list(
    domainId: string,
  ): Promise<Array<{ kind: "failure" | "success" | "caveat"; summary: string; rootCause?: string; lesson: string; createdAt: string }>>;
}

/** A reusable SKILL the brain authored — woven into agent prompts + persisted across
 *  runs (the OLD skills-library/<slug>/SKILL.md, now Drizzle-backed). */
export interface LibrarySkill {
  slug: string;
  name: string;
  purpose: string;
  promptFragment: string;
  tools: string[];
  decisionRule: string;
  domain: string | null; // null = cross-domain (general)
  useCount: number;
  evalCount: number;
  successCount: number;
}

/** Persistent skills library — create/use/persist + effectiveness scoring. */
export interface SkillStore {
  /** skills usable for a domain (domain-specific + general), ranked by effectiveness then use. */
  list(domain: string): Promise<LibrarySkill[]>;
  save(skill: Omit<LibrarySkill, "useCount" | "evalCount" | "successCount">): Promise<void>;
  bumpUse(slug: string): Promise<void>;
  /** record whether a run that USED this skill ended green (effectiveness signal). */
  recordEval(slug: string, ok: boolean): Promise<void>;
}

/** Optional web search for the brain's research (web_search tool). */
export interface WebSearch {
  search(query: string): Promise<Array<{ title: string; url: string; snippet: string }>>;
}

/** A declarative, AI-authored HTTP tool (Tool-Smith). NEVER eval'd — it's a spec the
 *  runtime executes via a guarded fetch (egress-guard). Persisted so a future run /
 *  a deployed agent can bind it by name. */
export interface DeclarativeTool {
  name: string;
  description: string;
  method: string; // GET | POST | ...
  urlTemplate: string; // may contain {placeholders} filled from the event payload
  headers?: Record<string, string>;
  bodyTemplate?: string;
  sideEffect: string; // "read" | "write" | "dual" — gating hint
  domain: string | null;
  /** R6 — typed I/O contracts (regression vs the OLD PersistedToolSpec): the args the tool
   *  takes + the shape it returns, as JSON-schema-ish field maps. Let the step-engine validate
   *  output and let generated agents agree on shapes (e.g. parseResumeApi is multipart `file`-only,
   *  match wraps under data.data.*). For an EXTERNAL-platform handoff this is the egress contract. */
  paramsSchema?: Record<string, unknown>;
  returnsSchema?: Record<string, unknown>;
}

/** Persistent tool library (Tool-Smith create_tool) — declarative HTTP tools the brain
 *  authors so a domain that lacks a needed tool can grow one. */
export interface ToolStore {
  list(domain: string): Promise<DeclarativeTool[]>;
  save(tool: DeclarativeTool): Promise<void>;
}

/** A persisted, generated agent — the durable DRAFT a finished run produces. */
export interface AgentDraft {
  domain: string;
  slug: string;
  spec: GeneratedAgentSpec;
  createdAt: string;
}

/** Persists the agents the factory GENERATED as durable, reviewable DRAFTS — the OLD
 *  repo's syncDomainDrafts (which wrote draft AgentVersion rows). Without this port a
 *  finished run threw its agents away (they lived only in the transcript). With it,
 *  `finish` writes them so a completed run produces inspectable, promotable artifacts.
 *  Fail-safe by contract: `save` must never throw back into the finish gate. */
export interface AgentDraftStore {
  /** Persist this run's accepted specs for the domain; returns how many were written. */
  save(domain: string, specs: GeneratedAgentSpec[]): Promise<number>;
  /** List a domain's persisted drafts (newest spec per slug). */
  list(domain: string): Promise<AgentDraft[]>;
}

/** The dependency-injection root the brain is constructed with. */
export interface FactoryPorts {
  ontology: OntologySource;
  sandbox: SandboxDeployer;
  conversation: ConversationStore;
  reflection: ReflectionWriter;
  /** optional: when absent, create_skill/use_skill are no-ops + web_search returns empty. */
  skills?: SkillStore;
  web?: WebSearch;
  /** optional: when absent, create_tool persists only in-run (still grounds design_agent). */
  tools?: ToolStore;
  /** optional: the REAL global tool registry (@agentic/tools listGlobalTools), injected by the api
   *  so the pure factory package can recommend real tools (parseResumeApi, fs.*) by semantic rank
   *  even when the ontology declared none. Absent → falls back to ontology-declared tools only. */
  toolRegistry?: ToolRegistry;
  /** optional: when absent, finish() doesn't persist drafts (agents live only in the
   *  transcript). When wired, a finished run writes durable, promotable agent drafts. */
  drafts?: AgentDraftStore;
  /** optional (#SCALE-TOOLS): record per-tool sandbox outcomes so ranking can demote empirically
   *  failing tools. No-op when unwired; fail-safe. */
  toolStats?: { record(toolName: string, ok: boolean): Promise<void>; successRates(): Promise<Record<string, { invoked: number; succeeded: number }>> };
  /** optional (P1-6): persist per-criterion acceptance verdicts so pass-rate can be trended without
   *  replaying transcripts. No-op when unwired; fail-safe (never throws into the finish gate). */
  acceptance?: AcceptanceRecorder;
  /** optional: the domain-analysis REPORT pipeline (reportGenerator agent → HTML/PDF artifacts).
   *  Wired by the api to report-jobs; when absent, generate_report refuses with a clear message
   *  (the brain must never hand-write a full report into the chat as a fallback). */
  report?: ReportRunner;
  /** optional: 系统 B 的舰队目录（已交付/已启用的 functions）——capability_resolve 的「复用面」。
   *  Wired by the api; absent → resolution honestly skips the fleet face (never guesses). */
  fleet?: FleetCatalog;
}

/** Delivered functions visible to the GENERATION system for reuse resolution (G1, 附录 B)。
 *  G2 回流飞轮：条目可携带近期【生产】运行战绩（prodRuns/prodFailRate，系统 B → 系统 A），
 *  capability_resolve 在复用判定旁展示，让"复用一个正在生产上翻车的 agent"当场可见。 */
export interface FleetCatalog {
  list(): Promise<Array<{ kebabId: string; name: string; title?: string; enabled: boolean; trigger: string[]; emit: string[]; prodRuns?: number; prodFailRate?: number }>>;
}

/** Starts/polls an ontology-analysis report job. Artifacts download at /v1/artifacts/:id and the
 *  job is visible in the portal's 后台任务 panel (report-jobs is the single implementation). */
export interface ReportRunner {
  start(opts: { domain: string; format: "html" | "pdf" | "both"; focus?: string }): Promise<{ id: string }>;
  status(id: string): Promise<{
    status: "running" | "done" | "error";
    phase?: string;
    error?: string;
    note?: string;
    title?: string;
    artifacts: Array<{ id: string; kind: string; label: string; size: number }>;
  } | null>;
}

/** #P1-6 — records one row per acceptance criterion per run (for trend dashboards). */
export interface AcceptanceRecorder {
  record(runId: string, domain: string, tenantId: string | undefined, criteria: Array<{ key: string; label: string; pass: boolean; detail: string }>): Promise<void>;
}

/** The real global tool registry surfaced to the factory (config-injected, see FactoryPorts.toolRegistry). */
export interface ToolRegistry {
  list(): Promise<RealTool[]>;
}
