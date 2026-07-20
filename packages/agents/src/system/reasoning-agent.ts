import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ChatMessage, ToolDef } from "@agentic/llm-gateway";
import { z } from "zod";
import { BaseAgent } from "../base-agent";
import { agentRegistry } from "../registry";
import type { AgentContext, ToolHandlerMap } from "../types";
import {
  compileQualificationPrompt,
  deriveTemporalFacts,
  qualificationPromptSha256,
  type CompiledQualificationPrompt,
  type TemporalFact,
} from "./prompt-compiler";
import { reasoningAllmetaJson } from "./reasoning-allmeta";

const MAX_CONTEXT_CHARS = 32_000;
export const REASONING_RESULT_ARTIFACT_NAME = "reasoning-result.json";

function reasoningResultArtifactPath(runId: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(runId)) {
    throw new Error(`Invalid reasoning run id for artifact path: ${runId}`);
  }
  return path.join(
    process.env.AGENTIC_ARTIFACTS_DIR ?? "./artifacts",
    runId,
    REASONING_RESULT_ARTIFACT_NAME,
  );
}

async function persistReasoningResult(
  runId: string,
  output: ReasoningAgentOutput,
): Promise<void> {
  const filePath = reasoningResultArtifactPath(runId);
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(
      tempPath,
      JSON.stringify(
        {
          schemaVersion: "reasoning-result/v2",
          runId,
          output,
        },
        null,
        2,
      ),
      "utf8",
    );
    await rename(tempPath, filePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

const reasoningInputSchema = z
  .object({
    prompt: z.string().trim().min(1).max(12_000),
    domainId: z.string().trim().min(1).max(200),
    action: z.string().trim().min(1).max(160),
    scenario: z.string().trim().min(1).max(240).optional(),
    inputs: z.record(z.string(), z.unknown()).optional(),
    objectTypes: z.array(z.string().trim().min(1)).max(30).optional(),
    capabilityAnchors: z.array(z.string().trim().min(1)).max(20).optional(),
    keywords: z.array(z.string().trim().min(1)).max(40).optional(),
    applicableClient: z.string().trim().max(200).optional(),
    applicableDepartment: z.string().trim().max(200).optional(),
    executor: z.string().trim().max(80).optional(),
    ruleLimit: z.number().int().min(1).max(100).optional(),
    candidate: z.unknown().optional(),
    resume: z.unknown().optional(),
    jobRequisition: z.unknown().optional(),
    job_requisition: z.unknown().optional(),
    jd: z.unknown().optional(),
    context: z.unknown().optional(),
  })
  .passthrough();

export type ReasoningAgentInput = z.input<typeof reasoningInputSchema>;

const assessmentStatusSchema = z.enum([
  "satisfied",
  "violated",
  "optional_unmet",
  "not_applicable",
  "insufficient_evidence",
]);

export type AssessmentStatus = z.infer<typeof assessmentStatusSchema>;
export type EnforcementLevel = "mandatory" | "optional";
export type FailurePolicy = "block" | "warn";
export type RuleApplicabilityScope =
  | "csi_universal"
  | "client_general"
  | "client_department";
export type ReasoningHarnessMethod =
  | "graph_react"
  | "evidence_grounding"
  | "temporal_constraint"
  | "rule_by_rule_verification";

export interface ReasoningHarnessEvidenceAnchor {
  objectType: string;
  evidencePaths: string[];
  purpose: string;
}

export interface ReasoningHarnessPlan {
  version: "reasoning-harness/v2";
  methods: ReasoningHarnessMethod[];
  capabilityAnchors: string[];
  objectAnchors: string[];
  evidenceAnchors: ReasoningHarnessEvidenceAnchor[];
  stopConditions: string[];
  publicRationale: string;
}

export interface RuleLinkEndpoint {
  type: string;
  id: string;
  displayName: string;
}

export interface RuleLinkTriple {
  linkId: string;
  status: string;
  confidence: number;
  subject: RuleLinkEndpoint;
  predicate: string;
  object: RuleLinkEndpoint;
  semanticRelationship: string;
  evidence: unknown[];
}

export interface RuleQueryExecution {
  purpose: "semantic-rule-selection" | "mandatory-link-coverage";
  language: "cypher";
  query: string;
  parameters: Record<string, unknown>;
  fingerprint: string;
  readOnly: true;
  domainLocked: true;
  linkOnly: true;
  fallbackUsed: false;
  durationMs: number;
  rowCount: number;
  pathPattern: string;
}
export type TargetScopeSource =
  | "job_requisition"
  | "jd"
  | "explicit_fallback"
  | "generic_inputs_fallback"
  | "missing"
  | "legacy_unknown";
export interface TargetScopeConflict {
  field: "client" | "department";
  selectedValue: string;
  selectedSource: TargetScopeSource;
  ignoredValue: string;
  ignoredSource: TargetScopeSource;
}
export interface TargetRuleScopeResolution {
  client: string;
  department: string;
  clientSource: TargetScopeSource;
  departmentSource: TargetScopeSource;
  conflicts: TargetScopeConflict[];
}
export type RuleDecision =
  | "eligible"
  | "eligible_with_flags"
  | "ineligible"
  | "review_required";

const modelAssessmentSchema = z
  .object({
    ruleId: z.string().trim().min(1),
    status: z.string().trim().min(1).max(80),
    reason: z.string().trim().min(1).max(2_000),
    evidence: z.array(z.string().trim().min(1).max(1_000)).max(12).default([]),
  })
  .strict();

const modelDraftSchema = z
  .object({
    intentSummary: z.string().trim().min(1).max(2_000),
    strategy: z
      .enum(["constrained_react", "evidence_first_rule_check"])
      .default("constrained_react"),
    answerSummary: z.string().trim().min(1).max(4_000),
    assessments: z.array(modelAssessmentSchema).max(300),
    missingEvidence: z
      .array(z.string().trim().min(1).max(1_000))
      .max(50)
      .default([]),
  })
  .strict();

export type ReasoningModelDraft = z.infer<typeof modelDraftSchema>;

interface InternalQualifiedAgentInput {
  compiledPrompt: CompiledQualificationPrompt;
  ruleBundleId: string;
  expectedRuleIds: string[];
}

/**
 * Private execution boundary for rule assessment. It deliberately reuses the
 * persisted `reasoningAgent` definition binding, but it is never registered or
 * exported, so it cannot appear in or be invoked from Agent Factory.
 */
class InternalQualifiedAgent extends BaseAgent<
  InternalQualifiedAgentInput,
  ReasoningModelDraft
> {
  readonly name = "reasoningAgent";
  readonly description =
    "Internal isolated QualifiedAgent child run for one compiled RuleBundle.";
  override readonly scope = "system" as const;
  override readonly runScope = "caller" as const;
  override readonly maxSteps = 1;
  override readonly maxOutputTokens = 8_000;
  override readonly outputSchema = modelDraftSchema;

  protected override buildMessages(
    input: InternalQualifiedAgentInput,
    ctx: AgentContext,
  ): ChatMessage[] {
    if (ctx.runtimeRole !== "qualified" || !ctx.parentRunId || !ctx.runId) {
      throw new Error(
        "Internal QualifiedAgent requires an audited qualified child-run context",
      );
    }
    const { compiledPrompt } = input;
    if (
      qualificationPromptSha256(compiledPrompt) !== compiledPrompt.promptSha256
    ) {
      throw new Error("QualifiedAgent compiled prompt receipt mismatch");
    }
    if (
      input.expectedRuleIds.length !== compiledPrompt.ruleIds.length ||
      input.expectedRuleIds.some(
        (ruleId, index) => ruleId !== compiledPrompt.ruleIds[index],
      )
    ) {
      throw new Error(
        "QualifiedAgent expected RuleBundle does not match prompt",
      );
    }
    return [
      { role: "system", content: compiledPrompt.systemPrompt },
      { role: "user", content: compiledPrompt.userPrompt },
    ];
  }
}

const internalQualifiedAgent = new InternalQualifiedAgent();

export interface QualifiedAgentRunReceipt {
  role: "qualified";
  executionMode: "isolated-child-run";
  runId: string;
  parentRunId: string;
  correlationId: string;
  compilerId: string;
  promptSha256: string;
  ruleBundleId: string;
  provider: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  durationMs: number;
  steps: number;
  assessmentCount: number;
}

export interface QualificationCompilerReceipt {
  compilerId: string;
  compilerVersion: string;
  promptSha256: string;
  fullSemanticPathsSha256: string;
}

export interface CompactQualificationToolData {
  compilerReceipt: QualificationCompilerReceipt;
  ruleCount: number;
  qualifiedRun: QualifiedAgentRunReceipt;
  assessmentCount: number;
}

/**
 * Keep the outer orchestrator handoff small. The complete prompt remains in
 * the isolated child input artifact and final Reasoning audit; returning it
 * here would inject the same large RuleBundle into the outer model again.
 */
export function compactQualificationToolData(
  compiledPrompt: CompiledQualificationPrompt,
  qualifiedRun: QualifiedAgentRunReceipt,
  assessmentCount: number,
): CompactQualificationToolData {
  return {
    compilerReceipt: {
      compilerId: compiledPrompt.compilerId,
      compilerVersion: compiledPrompt.compilerVersion,
      promptSha256: compiledPrompt.promptSha256,
      fullSemanticPathsSha256: compiledPrompt.fullSemanticPathsSha256,
    },
    ruleCount: compiledPrompt.ruleIds.length,
    qualifiedRun,
    assessmentCount,
  };
}

export interface RetrievedRule {
  id: string;
  name: string;
  logic: string;
  submissionCriteria: string;
  businessReason: string;
  enforcementLevel: EnforcementLevel;
  failurePolicy: FailurePolicy;
  executor: string;
  applicableClient: string;
  applicableDepartment: string;
  relatedEntities: string[];
  relatedObjectTypes: string[];
  linkedActions: string[];
  applicabilityScope: RuleApplicabilityScope;
  selectionScore: number;
  matchReasons: string[];
  linkPaths: RuleLinkTriple[];
  matchedAnchors: string[];
  scopeReason: string;
}

export interface RuleSelectionQueryIr {
  version: "rule-link-query-ir/v2";
  domainId: string;
  actionHint: string;
  query: string;
  intentTerms: string[];
  capabilityAnchors: string[];
  objectAnchors: string[];
  evidenceAnchors: ReasoningHarnessEvidenceAnchor[];
  strongKeywords: string[];
  keywords: string[];
  objectTypes: string[];
  applicableClient: string;
  applicableDepartment: string;
  executor: string;
  enforcementLevels: ["mandatory", "optional"];
  allowedRelationships: ["SCOPED_TO", "GOVERNS", "APPLIES_TO", "RELEVANT_TO"];
  maxHops: 2;
  limit: number;
}

export interface RuleBundle {
  bundleId: string;
  domainId: string;
  action: string;
  scenario: string;
  fetchedAt: string;
  queryIr: RuleSelectionQueryIr;
  rules: RetrievedRule[];
  actionSteps: Array<{
    id: string;
    name: string;
    order: string | number | null;
    ruleIds: string[];
  }>;
}

export interface QueryAgentAudit {
  selectionStrategy: "semantic-link-traversal";
  modelRationale: string;
  harnessPlan: ReasoningHarnessPlan;
  queryExecution: RuleQueryExecution;
  queryExecutions: RuleQueryExecution[];
  filters: {
    actionHint: string;
    client: string;
    department: string;
    clientSource: TargetScopeSource;
    departmentSource: TargetScopeSource;
    scopeConflicts: TargetScopeConflict[];
    objectTypes: string[];
    keywords: string[];
    executor: string;
    enforcementLevels: ["mandatory", "optional"];
    includeCsiUniversal: true;
    includeClientGeneral: boolean;
    includeClientDepartment: boolean;
  };
}

export interface RuleAssessment {
  ruleId: string;
  ruleName: string;
  enforcementLevel: EnforcementLevel;
  failurePolicy: FailurePolicy;
  status: AssessmentStatus;
  reason: string;
  evidence: string[];
}

export type EvidenceFactCategory =
  | "candidate"
  | "target_job"
  | "employment_history"
  | "qualification"
  | "risk_signal"
  | "other";

export type EvidenceFactPurpose =
  | "scope_selection"
  | "rule_evaluation"
  | "context";

export interface ProposedEvidenceFact {
  category: EvidenceFactCategory;
  purpose: EvidenceFactPurpose;
  label: string;
  evidencePath: string;
  relevance: string;
}

export interface AuditableEvidenceFact extends ProposedEvidenceFact {
  value: string | null;
  verified: boolean;
}

export type RuleEvidenceRelevance =
  | "direct"
  | "scope_only"
  | "no_direct_signal";

export interface ProposedRuleEvidenceLink {
  ruleId: string;
  relevance: RuleEvidenceRelevance;
  evidencePaths: string[];
  summary: string;
}

export interface AuditableRuleEvidenceLink extends Omit<
  ProposedRuleEvidenceLink,
  "evidencePaths"
> {
  evidence: Array<{
    path: string;
    actualValue: string | null;
    verified: boolean;
  }>;
}

export interface EvidenceAnalysisAudit {
  agent: "Intent Reasoner";
  mode: "llm-proposed/evidence-path-verified";
  facts: AuditableEvidenceFact[];
  verifiedCount: number;
  unverifiedCount: number;
  temporalFacts: TemporalFact[];
  ruleEvidencePlan: AuditableRuleEvidenceLink[];
}

export type ReasoningTraceAgentId =
  | "reasoning"
  | "query"
  | "compiler"
  | "qualified"
  | "fold";

export interface ReasoningTraceEntry {
  sequence: number;
  agentId: ReasoningTraceAgentId;
  event:
    | "intent.accepted"
    | "query_ir.compiled"
    | "evidence.extracted"
    | "rules.selected"
    | "prompt.compiled"
    | "quality.checked"
    | "decision.folded";
  status: "completed" | "warning" | "blocked";
  at: string;
  durationMs: number | null;
  summary: string;
}

export interface ReasoningAuditTrail {
  /**
   * This surface intentionally exposes concise, evidence-backed reasoning
   * summaries and tool receipts. It never exports private model chain-of-thought.
   */
  visibility: "auditable_reasoning_summary";
  hiddenChainOfThoughtExposed: false;
  input: {
    userPrompt: string;
    evidence: Record<string, unknown>;
    evidenceKeys: string[];
  };
  evidenceAnalysis: EvidenceAnalysisAudit;
  harnessPlan: ReasoningHarnessPlan;
  ruleSelection: {
    source: "allmeta";
    mode: "generated-cypher/semantic-link-selection";
    selectionBasis: "semantic-links";
    queryFingerprint: string;
    readOnly: true;
    domainLocked: true;
    linkOnly: true;
    fallbackUsed: false;
    queryExecution: RuleQueryExecution;
    queryExecutions: RuleQueryExecution[];
    fetchedAt: string;
    mandatoryCount: number;
    optionalCount: number;
    diagnostics: Record<string, unknown> | null;
    queryAgent: QueryAgentAudit;
    selectedRules: RetrievedRule[];
  };
  compiledPrompt: CompiledQualificationPrompt;
  qualityCheck: {
    agent: "QualifiedAgent";
    executionMode: "isolated-child-run";
    run: QualifiedAgentRunReceipt;
    assessmentCount: number;
    statusCounts: Record<AssessmentStatus, number>;
    mandatoryBlocked: number;
    mandatoryPending: number;
    optionalFlagged: number;
  };
  trace: ReasoningTraceEntry[];
}

export interface ReasoningAgentOutput {
  intentSummary: string;
  strategy: ReasoningModelDraft["strategy"];
  answerSummary: string;
  decision: RuleDecision;
  domainId: string;
  action: string;
  scenario: string;
  ruleBundleId: string;
  ruleCount: number;
  queryIr: RuleSelectionQueryIr;
  harnessPlan: ReasoningHarnessPlan;
  promptCompiler: {
    compilerId: string;
    compilerVersion: string;
    evidenceKeys: string[];
  };
  assessments: RuleAssessment[];
  flags: string[];
  missingEvidence: string[];
  audit: ReasoningAuditTrail;
  runtime: {
    agents: Array<{
      id: "reasoning" | "query" | "compiler" | "qualified" | "fold";
      label: string;
      status: "completed" | "warning" | "blocked";
      detail: string;
    }>;
    edges: Array<{ from: string; to: string }>;
  };
}

interface RetrievalState {
  phase: "initialized" | "selected" | "compiled" | "qualified";
  createdAt: number;
  domainId: string;
  action: string;
  scenario: string;
  prompt: string;
  evidence: Record<string, unknown>;
  queryIr: RuleSelectionQueryIr;
  scopeResolution: TargetRuleScopeResolution;
  trace: ReasoningTraceEntry[];
  queryDiagnostics: Record<string, unknown> | null;
  queryAgentAudit: QueryAgentAudit | null;
  harnessPlan: ReasoningHarnessPlan | null;
  queryExecution: RuleQueryExecution | null;
  queryExecutions: RuleQueryExecution[];
  evidenceAnalysis: EvidenceAnalysisAudit | null;
  qualifiedDraft?: ReasoningModelDraft;
  qualifiedRun?: QualifiedAgentRunReceipt;
  qualifiedExecution?: Promise<{
    draft: ReasoningModelDraft;
    receipt: QualifiedAgentRunReceipt;
  }>;
  bundle?: RuleBundle;
  compiledPrompt?: CompiledQualificationPrompt;
}

interface AllmetaRuleSelectionResponse {
  selectionBasis?: unknown;
  selectedRules?: unknown;
  queryIr?: unknown;
  queryExecution?: unknown;
  queryExecutions?: unknown;
  diagnostics?: unknown;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(stringValue).filter(Boolean).slice(0, 50);
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function enforcementOf(value: unknown): EnforcementLevel {
  const normalized = stringValue(value).toLowerCase();
  if (normalized === "mandatory" || normalized === "optional") {
    return normalized;
  }
  throw new TypeError(
    `Allmeta rule has invalid enforcementLevel ${JSON.stringify(value)}; expected mandatory or optional`,
  );
}

function failurePolicyOf(
  value: unknown,
  enforcementLevel: EnforcementLevel,
): FailurePolicy {
  const normalized = stringValue(value).toLowerCase();
  if (normalized === "warn") return "warn";
  if (normalized === "block") return "block";
  throw new TypeError(
    `Allmeta ${enforcementLevel} rule has invalid failurePolicy ${JSON.stringify(value)}; expected block or warn`,
  );
}

function endpointDisplayName(value: unknown): string {
  const endpoint = recordValue(value);
  const displayName = endpoint.displayName;
  if (typeof displayName === "string") return displayName.trim();
  const localized = recordValue(displayName);
  return (
    stringValue(localized.zh) ||
    stringValue(localized.en) ||
    stringValue(endpoint.name) ||
    stringValue(endpoint.id)
  );
}

function normalizeLinkEndpoint(value: unknown): RuleLinkEndpoint | null {
  const endpoint = recordValue(value);
  const id = stringValue(endpoint.id);
  const type = stringValue(endpoint.type || endpoint.kind || endpoint.label);
  if (!id || !type) return null;
  return { type, id, displayName: endpointDisplayName(endpoint) || id };
}

function normalizeRuleLinkTriple(value: unknown): RuleLinkTriple | null {
  const link = recordValue(value);
  const subject = normalizeLinkEndpoint(link.subject ?? link.from);
  const object = normalizeLinkEndpoint(link.object ?? link.to);
  const rawPredicate = stringValue(
    link.relationshipType ?? link.relationship ?? link.predicate ?? link.kind,
  );
  const predicateAliases: Record<string, string> = {
    scopedto: "SCOPED_TO",
    governs: "GOVERNS",
    appliesto: "APPLIES_TO",
    relevantto: "RELEVANT_TO",
  };
  const predicate =
    predicateAliases[rawPredicate.replace(/[^a-z]/gi, "").toLowerCase()] ??
    rawPredicate;
  if (!subject || !object || !predicate) return null;
  const semantic = link.semanticRelationship;
  const localized = recordValue(semantic);
  const evidence = Array.isArray(link.evidence)
    ? link.evidence.slice(0, 30)
    : link.evidenceJson !== undefined
      ? [link.evidenceJson]
      : [];
  const rawConfidence = link.confidence;
  const confidence =
    typeof rawConfidence === "number" && Number.isFinite(rawConfidence)
      ? rawConfidence
      : typeof rawConfidence === "string" &&
          rawConfidence.trim() &&
          Number.isFinite(Number(rawConfidence))
        ? Number(rawConfidence)
        : null;
  const linkId = stringValue(link.linkId ?? link.id);
  const status = stringValue(link.status);
  if (
    !linkId ||
    !status ||
    confidence == null ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new TypeError(
      "Allmeta semantic link requires non-empty linkId/status and confidence within [0,1]",
    );
  }
  return {
    linkId,
    status,
    confidence,
    subject,
    predicate,
    object,
    semanticRelationship:
      stringValue(semantic) ||
      stringValue(localized.zh) ||
      stringValue(localized.en) ||
      stringValue(link.semanticRelationshipZh) ||
      stringValue(link.semanticRelationshipEn) ||
      stringValue(link.naturalLanguageStatementZh) ||
      stringValue(link.naturalLanguageStatementEn) ||
      `${subject.type}:${subject.id} -[${predicate}]-> ${object.type}:${object.id}`,
    evidence,
  };
}

function normalizeRuleLinkPaths(value: unknown): RuleLinkTriple[] {
  if (!Array.isArray(value)) return [];
  const triples: RuleLinkTriple[] = [];
  for (const entry of value.slice(0, 100)) {
    const record = recordValue(entry);
    const candidates = Array.isArray(record.triples)
      ? record.triples
      : Array.isArray(record.links)
        ? record.links
        : [entry];
    for (const candidate of candidates) {
      const normalized = normalizeRuleLinkTriple(candidate);
      if (normalized) triples.push(normalized);
    }
  }
  return triples;
}

function scopeFromSemanticLinks(
  ruleId: string,
  linkPaths: RuleLinkTriple[],
): RuleApplicabilityScope {
  const scopes = linkPaths
    .filter(
      (link) =>
        link.predicate.toUpperCase() === "SCOPED_TO" &&
        link.subject.type.toLowerCase() === "rule" &&
        link.subject.id === ruleId,
    )
    .map((link) => link.object.id.trim().toLowerCase());
  if (scopes.length === 0) {
    throw new TypeError(
      `Allmeta rule ${JSON.stringify(ruleId)} has no direct Rule-[:SCOPED_TO]->PolicyScope link; refusing property-based scope inference`,
    );
  }

  const derived = scopes.map((scopeId): RuleApplicabilityScope => {
    if (scopeId === "csi:universal") return "csi_universal";
    if (/^client:[^/]+\/department:[^/]+$/.test(scopeId)) {
      return "client_department";
    }
    if (/^client:[^/]+$/.test(scopeId)) return "client_general";
    throw new TypeError(
      `Allmeta rule ${JSON.stringify(ruleId)} has unsupported SCOPED_TO target ${JSON.stringify(scopeId)}`,
    );
  });

  // A rule can expose more than one applicable scope path. The most specific
  // matched semantic scope controls the singular UI grouping; no Rule client,
  // department or lifecycle property participates in this derivation.
  if (derived.includes("client_department")) return "client_department";
  if (derived.includes("client_general")) return "client_general";
  return "csi_universal";
}

export function normalizeRule(value: unknown): RetrievedRule | null {
  const rule = recordValue(value);
  const id = stringValue(rule.id);
  if (!id) return null;
  const enforcementLevel = enforcementOf(rule.enforcementLevel);
  const failurePolicy = failurePolicyOf(rule.failurePolicy, enforcementLevel);
  const applicableClient = stringValue(rule.applicableClient);
  const applicableDepartment = stringValue(rule.applicableDepartment);
  const linkPaths = normalizeRuleLinkPaths(rule.linkPaths);
  const applicabilityScope = scopeFromSemanticLinks(id, linkPaths);
  return {
    id,
    name: stringValue(rule.businessLogicRuleName) || id,
    logic: stringValue(rule.standardizedLogicRule),
    submissionCriteria: stringValue(rule.submissionCriteria),
    businessReason: stringValue(rule.businessBackgroundReason),
    enforcementLevel,
    failurePolicy,
    executor: stringValue(rule.executor),
    applicableClient,
    applicableDepartment,
    relatedEntities: stringArray(rule.relatedEntities),
    relatedObjectTypes: stringArray(rule.relatedObjectTypes),
    linkedActions: stringArray(rule.linkedActions),
    applicabilityScope,
    selectionScore:
      typeof rule.selectionScore === "number" ? rule.selectionScore : 0,
    matchReasons: stringArray(rule.matchReasons),
    linkPaths,
    matchedAnchors: stringArray(rule.matchedAnchors),
    scopeReason: stringValue(rule.scopeReason),
  };
}

function bundleHash(
  domainId: string,
  action: string,
  scenario: string,
  queryIr: RuleSelectionQueryIr,
  rules: RetrievedRule[],
): string {
  const canonical = JSON.stringify({
    domainId,
    action,
    scenario,
    queryIr,
    rules: [...rules].sort((a, b) => a.id.localeCompare(b.id)),
  });
  return `sha256:${createHash("sha256").update(canonical).digest("hex")}`;
}

function buildRuleBundle(
  domainId: string,
  action: string,
  scenario: string,
  queryIr: RuleSelectionQueryIr,
  body: AllmetaRuleSelectionResponse,
): RuleBundle {
  const sourceRules = Array.isArray(body.selectedRules)
    ? body.selectedRules
    : [];
  const byId = new Map<string, RetrievedRule>();
  for (const value of sourceRules) {
    const normalized = normalizeRule(value);
    if (normalized) byId.set(normalized.id, normalized);
  }
  const rules = [...byId.values()];
  if (rules.length === 0) {
    throw new Error(
      `Allmeta selected no rules for scenario ${JSON.stringify(scenario)} / action ${JSON.stringify(action)} in ${JSON.stringify(domainId)}; refusing to fail open`,
    );
  }
  const missingLinkEvidence = rules
    .filter((rule) => rule.linkPaths.length === 0)
    .map((rule) => rule.id);
  if (missingLinkEvidence.length > 0) {
    throw new Error(
      `Allmeta semantic-link selection returned rules without linkPaths: ${missingLinkEvidence.join(", ")}; refusing a non-link-backed RuleBundle`,
    );
  }
  const allowedRelationships = new Set(queryIr.allowedRelationships);
  const invalidLinkEvidence = rules.flatMap((rule) =>
    rule.linkPaths
      .filter(
        (link) =>
          !allowedRelationships.has(
            link.predicate.toUpperCase() as RuleSelectionQueryIr["allowedRelationships"][number],
          ),
      )
      .map((link) => `${rule.id}:${link.predicate}`),
  );
  if (invalidLinkEvidence.length > 0) {
    throw new Error(
      `Allmeta returned unapproved semantic relationships: ${invalidLinkEvidence.join(", ")}`,
    );
  }
  const missingScopePaths = rules
    .filter(
      (rule) =>
        !rule.linkPaths.some(
          (link) => link.predicate.toUpperCase() === "SCOPED_TO",
        ),
    )
    .map((rule) => rule.id);
  if (missingScopePaths.length > 0) {
    throw new Error(
      `Allmeta semantic-link selection returned rules without SCOPED_TO paths: ${missingScopePaths.join(", ")}; refusing property-based scope inference`,
    );
  }
  if (queryIr.capabilityAnchors.length > 0) {
    const missingExecutionSemantics = rules
      .filter(
        (rule) =>
          !rule.linkPaths.some((link) =>
            ["GOVERNS", "RELEVANT_TO"].includes(link.predicate.toUpperCase()),
          ),
      )
      .map((rule) => rule.id);
    if (missingExecutionSemantics.length > 0) {
      throw new Error(
        `Allmeta capability selection returned rules without GOVERNS/RELEVANT_TO execution semantics: ${missingExecutionSemantics.join(", ")}; APPLIES_TO object links cannot bypass capability matching`,
      );
    }
  }
  return {
    bundleId: bundleHash(domainId, action, scenario, queryIr, rules),
    domainId,
    action,
    scenario,
    fetchedAt: new Date().toISOString(),
    queryIr,
    rules,
    actionSteps: [],
  };
}

export function normalizeSelectionQueryIr(
  value: unknown,
  fallback: RuleSelectionQueryIr,
): RuleSelectionQueryIr {
  const query = recordValue(value);
  const rawLimit = query.limit;
  const limit =
    typeof rawLimit === "number" && Number.isInteger(rawLimit)
      ? Math.min(fallback.limit, Math.max(1, rawLimit))
      : fallback.limit;
  return {
    version: "rule-link-query-ir/v2",
    // The LLM-authored, runtime-normalized plan is authoritative. Allmeta may
    // echo it, but a remote response can never rewrite anchors or widen scope.
    domainId: fallback.domainId,
    actionHint: fallback.actionHint,
    query: fallback.query,
    intentTerms: fallback.intentTerms,
    capabilityAnchors: fallback.capabilityAnchors,
    objectAnchors: fallback.objectAnchors,
    evidenceAnchors: fallback.evidenceAnchors,
    strongKeywords: fallback.strongKeywords,
    keywords: fallback.keywords,
    objectTypes: fallback.objectTypes,
    // Target scope is resolved from the caller's trusted Job Requisition/JD.
    // An external response may echo it but can never replace or widen it.
    applicableClient: fallback.applicableClient,
    applicableDepartment: fallback.applicableDepartment,
    executor: fallback.executor,
    enforcementLevels: ["mandatory", "optional"],
    allowedRelationships: ["SCOPED_TO", "GOVERNS", "APPLIES_TO", "RELEVANT_TO"],
    maxHops: 2,
    limit,
  };
}

export function normalizeRuleQueryExecution(
  value: unknown,
  domainId: string,
  expectedPurpose: RuleQueryExecution["purpose"] = "semantic-rule-selection",
): RuleQueryExecution {
  const execution = recordValue(value);
  const rawPurpose = stringValue(execution.purpose);
  const purpose = rawPurpose || expectedPurpose;
  const language = stringValue(execution.language).toLowerCase();
  const query = stringValue(execution.query);
  const parameters = recordValue(execution.parameters);
  const fingerprint = stringValue(execution.fingerprint);
  const durationMs = execution.durationMs;
  const rowCount = execution.rowCount;
  const pathPattern = stringValue(execution.pathPattern);
  if (language !== "cypher" || !query) {
    throw new TypeError(
      "Allmeta link-first selection must return the executed Cypher query",
    );
  }
  if (purpose !== expectedPurpose) {
    throw new TypeError(
      `Allmeta Cypher receipt purpose mismatch: expected ${expectedPurpose}, received ${purpose || "missing"}`,
    );
  }
  if (
    /\b(?:CREATE|MERGE|SET|DELETE|DETACH|REMOVE|DROP|LOAD\s+CSV|CALL\s+dbms)\b/i.test(
      query,
    )
  ) {
    throw new TypeError("Allmeta returned a non-read-only Cypher query");
  }
  if (
    !/\bSCOPED_TO\b/.test(query) ||
    /\.(?:specificScenarioStage|stage|applicableClient|applicableDepartment)\b/i.test(
      query,
    )
  ) {
    throw new TypeError(
      "Allmeta Cypher must resolve scope through SCOPED_TO links, not rule lifecycle/client/department properties",
    );
  }
  const boundDomain = stringValue(parameters.domain ?? parameters.domainId);
  if (
    !boundDomain ||
    boundDomain !== domainId ||
    !/\$(?:domain|domainId)\b/.test(query)
  ) {
    throw new TypeError(
      "Allmeta Cypher receipt is not bound to the locked Reasoning domain",
    );
  }
  if (
    execution.readOnly !== true ||
    execution.domainLocked !== true ||
    execution.linkOnly !== true ||
    execution.fallbackUsed !== false
  ) {
    throw new TypeError(
      "Allmeta selection must be read-only, domain-locked, link-only, and fallback-free",
    );
  }
  if (
    !fingerprint ||
    typeof durationMs !== "number" ||
    durationMs < 0 ||
    typeof rowCount !== "number" ||
    !Number.isInteger(rowCount) ||
    rowCount < 0 ||
    !pathPattern
  ) {
    throw new TypeError("Allmeta Cypher execution receipt is incomplete");
  }
  return {
    purpose: expectedPurpose,
    language: "cypher",
    query,
    parameters,
    fingerprint,
    readOnly: true,
    domainLocked: true,
    linkOnly: true,
    fallbackUsed: false,
    durationMs,
    rowCount,
    pathPattern,
  };
}

export function normalizeRuleQueryExecutions(
  values: unknown,
  compatibilitySelection: unknown,
  domainId: string,
): RuleQueryExecution[] {
  if (!Array.isArray(values)) {
    throw new TypeError(
      "Allmeta link-first selection must return exactly 2 Cypher receipts; queryExecutions is missing",
    );
  }
  if (values.length !== 2) {
    throw new TypeError(
      `Allmeta link-first selection must return exactly 2 Cypher receipts; received ${values.length}`,
    );
  }
  const byPurpose = new Map<string, unknown>();
  for (const value of values) {
    const purpose = stringValue(recordValue(value).purpose);
    if (!purpose || byPurpose.has(purpose)) {
      throw new TypeError(
        "Allmeta queryExecutions contains a missing or duplicate purpose",
      );
    }
    byPurpose.set(purpose, value);
  }
  const selection = normalizeRuleQueryExecution(
    byPurpose.get("semantic-rule-selection"),
    domainId,
    "semantic-rule-selection",
  );
  const coverage = normalizeRuleQueryExecution(
    byPurpose.get("mandatory-link-coverage"),
    domainId,
    "mandatory-link-coverage",
  );
  if (coverage.rowCount !== 0) {
    throw new TypeError(
      `Allmeta mandatory-link-coverage found ${coverage.rowCount} incomplete mandatory rule link(s)`,
    );
  }
  const compatibility = normalizeRuleQueryExecution(
    compatibilitySelection,
    domainId,
    "semantic-rule-selection",
  );
  if (compatibility.fingerprint !== selection.fingerprint) {
    throw new TypeError(
      "Allmeta queryExecution compatibility receipt does not match queryExecutions semantic-rule-selection",
    );
  }
  return [selection, coverage];
}

function buildQueryAgentAudit(
  queryIr: RuleSelectionQueryIr,
  modelRationale: string,
  harnessPlan: ReasoningHarnessPlan,
  queryExecution: RuleQueryExecution,
  queryExecutions: RuleQueryExecution[],
  scopeResolution?: TargetRuleScopeResolution,
): QueryAgentAudit {
  return {
    selectionStrategy: "semantic-link-traversal",
    modelRationale: modelRationale.trim() || harnessPlan.publicRationale,
    harnessPlan,
    queryExecution,
    queryExecutions,
    filters: {
      actionHint: queryIr.actionHint,
      client: queryIr.applicableClient,
      department: queryIr.applicableDepartment,
      clientSource:
        scopeResolution?.clientSource ??
        (queryIr.applicableClient ? "legacy_unknown" : "missing"),
      departmentSource:
        scopeResolution?.departmentSource ??
        (queryIr.applicableDepartment ? "legacy_unknown" : "missing"),
      scopeConflicts: scopeResolution?.conflicts ?? [],
      objectTypes: queryIr.objectTypes,
      keywords: queryIr.keywords,
      executor: queryIr.executor,
      enforcementLevels: ["mandatory", "optional"],
      includeCsiUniversal: true,
      includeClientGeneral: Boolean(queryIr.applicableClient),
      includeClientDepartment: Boolean(
        queryIr.applicableClient && queryIr.applicableDepartment,
      ),
    },
  };
}

export function buildReasoningEvidence(
  rawInput: ReasoningAgentInput,
): Record<string, unknown> {
  const input = reasoningInputSchema.parse(rawInput);
  const evidence: Record<string, unknown> = { ...(input.inputs ?? {}) };
  const add = (key: string, value: unknown) => {
    if (value !== undefined) evidence[key] = value;
  };
  add("candidate", input.candidate);
  add("resume", input.resume);
  add("jobRequisition", input.jobRequisition ?? input.job_requisition);
  add("jd", input.jd);
  add("context", input.context);
  return evidence;
}

export function deriveRuleSelectionQueryIr(
  rawInput: ReasoningAgentInput,
  evidence = buildReasoningEvidence(rawInput),
): RuleSelectionQueryIr {
  const input = reasoningInputSchema.parse(rawInput);
  const inferredObjectTypes = new Set<string>(input.objectTypes ?? []);
  const serializedKeys = collectKeys(evidence);
  const mappings: Array<[RegExp, string]> = [
    [/(^|_)(candidate|candidateid)($|_)/i, "Candidate"],
    [/(^|_)(resume|resumeid)($|_)/i, "Resume"],
    [/(job.?requisition|requisitionid|jd)/i, "Job_Requisition"],
    [/(application|applicationhistory)/i, "Application"],
    [/(interview|interviewhistory)/i, "Interview_Record"],
    [/(blacklist)/i, "Blacklist"],
    [/(csi.?department|csidepartment)/i, "CSI_Department"],
    [/(clientdepartment|department|studio)/i, "Client_Department"],
    [/(client)/i, "Client"],
    [/(compliance|credential|approval)/i, "Compliance_Document"],
  ];
  for (const key of serializedKeys) {
    for (const [pattern, objectType] of mappings) {
      if (pattern.test(key)) {
        inferredObjectTypes.add(objectType);
        break;
      }
    }
  }

  const scopeResolution = resolveTargetRuleScope(input);
  const scenario = input.scenario ?? input.action;
  const explicitCapabilityAnchors = [
    ...new Set([
      input.action,
      ...(input.capabilityAnchors ?? []),
      ...findEvidenceStringArray(evidence, [
        "capability_anchors",
        "capabilityAnchors",
        "rule_capability_anchors",
        "ruleCapabilityAnchors",
      ]),
    ]),
  ].slice(0, 20);
  const selectionKeywords = [
    ...new Set([
      ...(input.keywords ?? []),
      ...findEvidenceStringArray(evidence, [
        "selection_keywords",
        "rule_selection_keywords",
        "selectionKeywords",
        "ruleSelectionKeywords",
      ]),
    ]),
  ].slice(0, 40);
  return {
    version: "rule-link-query-ir/v2",
    domainId: input.domainId,
    actionHint: input.action,
    query: `${scenario} ${input.prompt}`.slice(0, 2_000),
    intentTerms: selectionKeywords,
    capabilityAnchors: explicitCapabilityAnchors,
    objectAnchors: [...inferredObjectTypes].slice(0, 30),
    evidenceAnchors: [],
    strongKeywords: selectionKeywords,
    keywords: selectionKeywords,
    objectTypes: [...inferredObjectTypes].slice(0, 30),
    applicableClient: scopeResolution.client,
    applicableDepartment: scopeResolution.department,
    executor: input.executor || "Agent",
    enforcementLevels: ["mandatory", "optional"],
    allowedRelationships: ["SCOPED_TO", "GOVERNS", "APPLIES_TO", "RELEVANT_TO"],
    maxHops: 2,
    limit: input.ruleLimit ?? 40,
  };
}

export function normalizeReasoningHarnessPlan(
  value: unknown,
  queryIr: RuleSelectionQueryIr,
  evidence: Record<string, unknown>,
): ReasoningHarnessPlan {
  const plan = recordValue(value);
  const allowedMethods = new Set<ReasoningHarnessMethod>([
    "graph_react",
    "evidence_grounding",
    "temporal_constraint",
    "rule_by_rule_verification",
  ]);
  const methods = stringArray(plan.methods).filter(
    (method): method is ReasoningHarnessMethod =>
      allowedMethods.has(method as ReasoningHarnessMethod),
  );
  if (methods.length === 0) {
    throw new TypeError(
      "Reasoning Harness must select at least one approved reasoning method",
    );
  }
  const proposedCapabilityAnchors = stringArray(plan.capabilityAnchors);
  // Caller-provided canonical ontology identifiers are authoritative. When a
  // generic flow has no catalog-backed identifiers, descriptive model prose
  // stays in intentTerms and must not become a hard capability boundary.
  const capabilityAnchors = (
    queryIr.capabilityAnchors.length > 0
      ? queryIr.capabilityAnchors
      : proposedCapabilityAnchors.filter((anchor) =>
          /^[A-Za-z][A-Za-z0-9_.:-]{1,159}$/.test(anchor),
        )
  ).slice(0, 20);
  const knownObjects = new Set(queryIr.objectTypes);
  const requestedObjects = stringArray(plan.objectAnchors).filter((anchor) =>
    knownObjects.has(anchor),
  );
  const objectAnchors = (
    requestedObjects.length > 0 ? requestedObjects : queryIr.objectTypes
  ).slice(0, 30);
  const evidenceAnchors = (
    Array.isArray(plan.evidenceAnchors) ? plan.evidenceAnchors : []
  )
    .slice(0, 30)
    .map((raw) => {
      const anchor = recordValue(raw);
      const objectType = stringValue(anchor.objectType);
      const evidencePaths = stringArray(anchor.evidencePaths)
        .filter((pathValue) => evidencePathValue(evidence, pathValue).found)
        .slice(0, 12);
      return {
        objectType,
        evidencePaths,
        purpose: stringValue(anchor.purpose).slice(0, 400),
      };
    })
    .filter(
      (anchor) =>
        knownObjects.has(anchor.objectType) && anchor.evidencePaths.length > 0,
    );
  const stopConditions = stringArray(plan.stopConditions).slice(0, 12);
  const publicRationale = stringValue(plan.publicRationale).slice(0, 1_000);
  if (stopConditions.length === 0 || !publicRationale) {
    throw new TypeError(
      "Reasoning Harness must expose stop conditions and a public rationale",
    );
  }
  return {
    version: "reasoning-harness/v2",
    methods,
    capabilityAnchors,
    objectAnchors,
    evidenceAnchors,
    stopConditions,
    publicRationale,
  };
}

interface ScopeTupleCandidate {
  client: string;
  department: string;
  source: Exclude<TargetScopeSource, "missing" | "legacy_unknown">;
}

const CLIENT_SCOPE_KEYS = [
  "client_name",
  "clientName",
  "client",
  "customer_name",
  "customerName",
  "customer",
];

const DEPARTMENT_SCOPE_KEYS = [
  "client_department_name",
  "clientDepartmentName",
  "client_department",
  "clientDepartment",
  "department_name",
  "departmentName",
  "department",
  "business_group",
  "businessGroup",
  "business_unit",
  "businessUnit",
];

function canonicalClientScope(value: string): string {
  // Client aliases belong to the ontology, not to this universal engine.
  // NFKC only removes representational differences without embedding tenants.
  return value.normalize("NFKC").trim();
}

function canonicalDepartmentScope(value: string): string {
  return value.normalize("NFKC").trim();
}

function directScopeString(value: unknown, keys: string[]): string {
  const record = recordValue(value);
  for (const key of keys) {
    const direct = stringValue(record[key]);
    if (direct) return direct;
  }
  return "";
}

function targetScopeTuple(
  value: unknown,
  source: ScopeTupleCandidate["source"],
): ScopeTupleCandidate {
  const record = recordValue(value);
  const clientRecord = recordValue(record.client);
  const departmentRecord = recordValue(
    record.client_department ?? record.clientDepartment,
  );
  return {
    client: canonicalClientScope(
      directScopeString(record, CLIENT_SCOPE_KEYS) ||
        directScopeString(clientRecord, [...CLIENT_SCOPE_KEYS, "name"]),
    ),
    department: canonicalDepartmentScope(
      directScopeString(record, DEPARTMENT_SCOPE_KEYS) ||
        directScopeString(departmentRecord, [
          ...DEPARTMENT_SCOPE_KEYS,
          "dept_name",
          "deptName",
          "name",
        ]),
    ),
    source,
  };
}

function genericScopeTuple(
  inputs: Record<string, unknown>,
): ScopeTupleCandidate {
  const ruleScope = recordValue(inputs.rule_scope ?? inputs.ruleScope);
  const clientRecord = recordValue(inputs.client);
  const departmentRecord = recordValue(
    inputs.client_department ?? inputs.clientDepartment ?? inputs.department,
  );
  return {
    client: canonicalClientScope(
      directScopeString(inputs, ["client_name", "clientName"]) ||
        directScopeString(ruleScope, CLIENT_SCOPE_KEYS) ||
        directScopeString(clientRecord, [...CLIENT_SCOPE_KEYS, "name"]),
    ),
    department: canonicalDepartmentScope(
      directScopeString(inputs, [
        "client_department_name",
        "clientDepartmentName",
        "department_name",
        "departmentName",
      ]) ||
        directScopeString(ruleScope, DEPARTMENT_SCOPE_KEYS) ||
        directScopeString(departmentRecord, [
          ...DEPARTMENT_SCOPE_KEYS,
          "dept_name",
          "deptName",
          "name",
        ]),
    ),
    source: "generic_inputs_fallback",
  };
}

function sameScopeValue(left: string, right: string): boolean {
  return (
    left
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "") ===
    right
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "")
  );
}

function authoritativeScopeConflicts(
  job: ScopeTupleCandidate,
  jd: ScopeTupleCandidate,
): string[] {
  const conflicts: string[] = [];
  if (job.client && jd.client && !sameScopeValue(job.client, jd.client)) {
    conflicts.push(`client: Job Requisition=${job.client}, JD=${jd.client}`);
  }
  if (
    job.department &&
    jd.department &&
    !sameScopeValue(job.department, jd.department)
  ) {
    conflicts.push(
      `department: Job Requisition=${job.department}, JD=${jd.department}`,
    );
  }
  return conflicts;
}

/**
 * Resolves the target policy scope from target-job evidence only. Historical
 * clients/departments inside a Resume are assessment evidence and must never
 * be mistaken for the client or department of the position being filled.
 */
export function resolveTargetRuleScope(
  rawInput: ReasoningAgentInput,
): TargetRuleScopeResolution {
  const input = reasoningInputSchema.parse(rawInput);
  const inputs = recordValue(input.inputs);
  const jobRequisition =
    input.jobRequisition ??
    input.job_requisition ??
    inputs.jobRequisition ??
    inputs.job_requisition;
  const jd = input.jd ?? inputs.jd;
  const jobTuple = targetScopeTuple(jobRequisition, "job_requisition");
  const jdTuple = targetScopeTuple(jd, "jd");
  if (
    (jobRequisition != null || jd != null) &&
    !jobTuple.client &&
    !jdTuple.client
  ) {
    throw new TypeError(
      "TARGET_SCOPE_INCOMPLETE: structured Job Requisition/JD was provided without a target client; refusing to check only universal rules.",
    );
  }
  const authoritativeConflicts = authoritativeScopeConflicts(jobTuple, jdTuple);
  if (authoritativeConflicts.length > 0) {
    throw new TypeError(
      `TARGET_SCOPE_CONFLICT: ${authoritativeConflicts.join("; ")}. Align Job Requisition and JD before rule selection.`,
    );
  }
  const explicitTuple: ScopeTupleCandidate = {
    client: canonicalClientScope(input.applicableClient ?? ""),
    department: canonicalDepartmentScope(input.applicableDepartment ?? ""),
    source: "explicit_fallback",
  };
  const genericTuple = genericScopeTuple(inputs);
  const candidates = [jobTuple, jdTuple, explicitTuple, genericTuple];
  const selectedClientTuple = candidates.find((candidate) => candidate.client);
  const client = selectedClientTuple?.client ?? "";
  const clientSource: TargetScopeSource =
    selectedClientTuple?.source ?? "missing";
  const compatibleDepartmentTuple = client
    ? candidates.find(
        (candidate) =>
          Boolean(candidate.department) &&
          (!candidate.client || sameScopeValue(candidate.client, client)),
      )
    : undefined;
  const department = compatibleDepartmentTuple?.department ?? "";
  const departmentSource: TargetScopeSource =
    compatibleDepartmentTuple?.source ?? "missing";
  const conflicts: TargetScopeConflict[] = [];
  for (const candidate of candidates) {
    if (
      client &&
      candidate.client &&
      !sameScopeValue(candidate.client, client)
    ) {
      conflicts.push({
        field: "client",
        selectedValue: client,
        selectedSource: clientSource,
        ignoredValue: candidate.client,
        ignoredSource: candidate.source,
      });
      continue;
    }
    if (
      department &&
      candidate.department &&
      (!candidate.client || sameScopeValue(candidate.client, client)) &&
      !sameScopeValue(candidate.department, department)
    ) {
      conflicts.push({
        field: "department",
        selectedValue: department,
        selectedSource: departmentSource,
        ignoredValue: candidate.department,
        ignoredSource: candidate.source,
      });
    }
  }
  return {
    client,
    department,
    clientSource,
    departmentSource,
    conflicts,
  };
}

function findEvidenceStringArray(
  value: unknown,
  preferredKeys: string[],
  depth = 0,
): string[] {
  if (depth > 4 || !value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 10)) {
      const found = findEvidenceStringArray(item, preferredKeys, depth + 1);
      if (found.length > 0) return found;
    }
    return [];
  }
  const record = value as Record<string, unknown>;
  for (const key of preferredKeys) {
    const found = stringArray(record[key]);
    if (found.length > 0) return found;
  }
  for (const child of Object.values(record)) {
    const found = findEvidenceStringArray(child, preferredKeys, depth + 1);
    if (found.length > 0) return found;
  }
  return [];
}

function collectKeys(
  value: unknown,
  depth = 0,
  out = new Set<string>(),
): Set<string> {
  if (depth > 4 || !value || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 10)) collectKeys(item, depth + 1, out);
    return out;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out.add(key.replace(/[\s_-]+/g, ""));
    collectKeys(child, depth + 1, out);
  }
  return out;
}

function tokenizeEvidencePath(
  pathValue: string,
): Array<string | number> | null {
  const path = pathValue.trim().replace(/^\$\.?/, "");
  if (
    !path ||
    !/^[A-Za-z_$][\w$]*(?:(?:\.[A-Za-z_$][\w$]*)|(?:\[\d+\]))*$/.test(path)
  ) {
    return null;
  }
  const tokens: Array<string | number> = [];
  for (const match of path.matchAll(/(?:^|\.)([A-Za-z_$][\w$]*)|\[(\d+)\]/g)) {
    if (match[1]) tokens.push(match[1]);
    else if (match[2]) tokens.push(Number(match[2]));
  }
  return tokens;
}

function evidencePathValue(
  evidence: Record<string, unknown>,
  pathValue: string,
): { found: boolean; value: unknown } {
  const tokens = tokenizeEvidencePath(pathValue);
  if (!tokens) return { found: false, value: undefined };
  let current: unknown = evidence;
  for (const token of tokens) {
    if (typeof token === "number") {
      if (!Array.isArray(current) || token >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[token];
      continue;
    }
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, token)) {
      return { found: false, value: undefined };
    }
    current = (current as Record<string, unknown>)[token];
  }
  return { found: true, value: current };
}

function printableEvidenceValue(value: unknown): string | null {
  if (value === null) return "null";
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value).slice(0, 500);
  }
  if (
    Array.isArray(value) &&
    value.length <= 50 &&
    value.every(
      (item) =>
        typeof item === "string" ||
        typeof item === "number" ||
        typeof item === "boolean" ||
        item === null,
    )
  ) {
    return JSON.stringify(value).slice(0, 500);
  }
  return null;
}

function isAuthoritativeScopeFactPath(pathValue: string): boolean {
  const normalized = pathValue.trim().replace(/^\$\.?/, "");
  if (!/^(?:jobRequisition|job_requisition|jd)\./.test(normalized)) {
    return false;
  }
  const leaf =
    normalized
      .split(".")
      .at(-1)
      ?.replace(/[\[\]\d]/g, "") ?? "";
  return /^(?:client|client_name|clientName|customer|customer_name|customerName|client_department|client_department_name|clientDepartment|clientDepartmentName|department|department_name|departmentName|business_group|businessGroup|business_unit|businessUnit)$/.test(
    leaf,
  );
}

/**
 * Converts model-proposed atomic facts into a public audit receipt. A fact is
 * verified only when its JSON path resolves to a primitive input value. The
 * model never supplies the value: the runtime reads it directly from the
 * immutable invocation evidence, preventing a fluent but false value from
 * entering the audit trail.
 */
export function auditExtractedEvidenceFacts(
  proposedFacts: ProposedEvidenceFact[],
  evidence: Record<string, unknown>,
): EvidenceAnalysisAudit {
  const facts = proposedFacts.slice(0, 24).map((fact) => {
    const resolved = evidencePathValue(evidence, fact.evidencePath);
    const value = resolved.found
      ? printableEvidenceValue(resolved.value)
      : null;
    const scopePurposeDowngraded =
      fact.purpose === "scope_selection" &&
      !isAuthoritativeScopeFactPath(fact.evidencePath);
    return {
      ...fact,
      purpose: scopePurposeDowngraded ? "rule_evaluation" : fact.purpose,
      relevance: scopePurposeDowngraded
        ? fact.relevance +
          "（runtime：该路径不是 Job Requisition/JD 的 client/department，已禁止作为筛选作用域。）"
        : fact.relevance,
      value,
      verified: resolved.found && value != null,
    };
  });
  const verifiedCount = facts.filter((fact) => fact.verified).length;
  return {
    agent: "Intent Reasoner",
    mode: "llm-proposed/evidence-path-verified",
    facts,
    verifiedCount,
    unverifiedCount: facts.length - verifiedCount,
    temporalFacts: deriveTemporalFacts(evidence),
    ruleEvidencePlan: [],
  };
}

export function auditRuleEvidencePlan(
  proposedPlan: ProposedRuleEvidenceLink[],
  evidence: Record<string, unknown>,
  rules: RetrievedRule[],
): AuditableRuleEvidenceLink[] {
  const proposedByRule = new Map(
    proposedPlan.slice(0, 100).map((entry) => [entry.ruleId, entry]),
  );
  return rules.map((rule) => {
    const proposed = proposedByRule.get(rule.id);
    if (!proposed) {
      return {
        ruleId: rule.id,
        relevance: "no_direct_signal",
        summary:
          "模型未提供预判证据映射；该规则仍保留在 RuleBundle，并由 QualifiedAgent fail-closed 逐条检查。",
        evidence: [],
      };
    }
    const resolvedEvidence = proposed.evidencePaths
      .slice(0, 12)
      .map((pathValue) => {
        const resolved = evidencePathValue(evidence, pathValue);
        return {
          path: pathValue,
          actualValue: resolved.found
            ? printableEvidenceValue(resolved.value)
            : null,
          verified:
            resolved.found && printableEvidenceValue(resolved.value) != null,
        };
      });
    const directSignalVerified = resolvedEvidence.some((item) => item.verified);
    const downgraded = proposed.relevance === "direct" && !directSignalVerified;
    return {
      ruleId: rule.id,
      relevance: downgraded ? "no_direct_signal" : proposed.relevance,
      summary: downgraded
        ? proposed.summary +
          "（提交的直接证据路径未通过 runtime 校验，已降级。）"
        : proposed.summary,
      evidence: resolvedEvidence,
    };
  });
}

function emptyEvidenceAnalysis(
  evidence: Record<string, unknown>,
): EvidenceAnalysisAudit {
  return auditExtractedEvidenceFacts([], evidence);
}

function clipJson(value: unknown): string {
  const encoded = JSON.stringify(value, null, 2);
  if (encoded.length <= MAX_CONTEXT_CHARS) return encoded;
  return `${encoded.slice(0, MAX_CONTEXT_CHARS)}\n…[input truncated]`;
}

export function foldRuleDecision(assessments: RuleAssessment[]): RuleDecision {
  if (
    assessments.some(
      (item) =>
        item.enforcementLevel === "mandatory" && item.status === "violated",
    )
  ) {
    return "ineligible";
  }
  if (
    assessments.some(
      (item) =>
        item.enforcementLevel === "mandatory" &&
        (item.status === "insufficient_evidence" ||
          item.status === "optional_unmet"),
    )
  ) {
    return "review_required";
  }
  if (
    assessments.some(
      (item) =>
        item.enforcementLevel === "optional" &&
        (item.status === "violated" ||
          item.status === "optional_unmet" ||
          item.status === "insufficient_evidence"),
    )
  ) {
    return "eligible_with_flags";
  }
  return "eligible";
}

function buildDeterministicAnswerSummary(
  decision: RuleDecision,
  assessments: RuleAssessment[],
): string {
  const blocked = assessments.filter(
    (item) =>
      item.enforcementLevel === "mandatory" && item.status === "violated",
  );
  const pending = assessments.filter(
    (item) =>
      item.enforcementLevel === "mandatory" &&
      item.status === "insufficient_evidence",
  );
  const optionalFlags = assessments.filter(
    (item) =>
      item.enforcementLevel === "optional" &&
      (item.status === "violated" ||
        item.status === "optional_unmet" ||
        item.status === "insufficient_evidence"),
  );
  const satisfied = assessments.filter(
    (item) => item.status === "satisfied",
  ).length;
  const notApplicable = assessments.filter(
    (item) => item.status === "not_applicable",
  ).length;

  const headline =
    decision === "ineligible"
      ? `规则检查不通过：${blocked.length} 条 mandatory 规则被违反。`
      : decision === "review_required"
        ? `规则检查需要人工复核：${pending.length} 条 mandatory 规则证据不足。`
        : decision === "eligible_with_flags"
          ? `规则检查通过，但有 ${optionalFlags.length} 条 optional 规则需要标记。`
          : "规则检查通过，未发现阻断项或待标记项。";
  const blockingDetail =
    blocked.length > 0
      ? `阻断项：${blocked
          .map((item) => `${item.ruleId} ${item.ruleName}`)
          .join("；")}。`
      : "";
  const pendingDetail =
    pending.length > 0
      ? `待补证：${pending
          .map((item) => `${item.ruleId} ${item.ruleName}`)
          .join("；")}。`
      : "";
  const optionalDetail =
    optionalFlags.length > 0
      ? `Optional 标记：${optionalFlags
          .map((item) => `${item.ruleId} ${item.ruleName}`)
          .join("；")}。`
      : "";
  const coverage = `共检查 ${assessments.length} 条规则：${satisfied} 条满足，${notApplicable} 条不适用。`;

  return [headline, blockingDetail, pendingDetail, optionalDetail, coverage]
    .filter(Boolean)
    .join(" ");
}

function normalizeModelAssessmentStatus(
  value: string,
  enforcementLevel: EnforcementLevel,
): { status: AssessmentStatus; recognized: boolean } {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (assessmentStatusSchema.safeParse(normalized).success) {
    return { status: normalized as AssessmentStatus, recognized: true };
  }
  if (["pass", "passed", "met", "compliant", "ok"].includes(normalized)) {
    return { status: "satisfied", recognized: true };
  }
  if (
    ["fail", "failed", "failure", "blocked", "non_compliant"].includes(
      normalized,
    )
  ) {
    return {
      status: enforcementLevel === "optional" ? "optional_unmet" : "violated",
      recognized: true,
    };
  }
  if (["unmet", "not_met", "missing_optional"].includes(normalized)) {
    return {
      status: enforcementLevel === "optional" ? "optional_unmet" : "violated",
      recognized: true,
    };
  }
  if (["n/a", "na", "not_applicable"].includes(normalized)) {
    return { status: "not_applicable", recognized: true };
  }
  if (
    [
      "unknown",
      "pending",
      "missing_evidence",
      "insufficient_information",
      "insufficient_info",
    ].includes(normalized)
  ) {
    return { status: "insufficient_evidence", recognized: true };
  }
  return { status: "insufficient_evidence", recognized: false };
}

function statusContradictsReason(
  status: AssessmentStatus,
  reason: string,
): boolean {
  const saysSatisfied =
    /(?:应为|应该为|修正为|标记为|判定为|status.{0,4}(?:为|=)?)\s*(?:satisfied|满足|通过)/i.test(
      reason,
    );
  const saysViolated =
    /(?:应为|应该为|修正为|标记为|判定为|status.{0,4}(?:为|=)?)\s*(?:violated|违反|拦截)/i.test(
      reason,
    );
  const describesBlockingShortfall =
    /(?:不足|不满)\s*\d+\s*(?:个)?月/.test(reason) &&
    /(?:拦截|违反|红线|挂起|禁止)/.test(reason);
  const describesAllowedElapsedTime =
    /(?:已|远)?超过\s*\d+\s*(?:个)?月/.test(reason) &&
    /(?:允许|满足|符合|放行)/.test(reason);
  if (status === "satisfied") {
    return saysViolated || describesBlockingShortfall;
  }
  if (status === "violated" || status === "optional_unmet") {
    return saysSatisfied || describesAllowedElapsedTime;
  }
  return false;
}

function verifyAssessmentEvidence(
  citations: string[],
  evidence: Record<string, unknown>,
): { verified: string[]; rejected: string[] } {
  const verified = new Set<string>();
  const rejected: string[] = [];
  for (const citation of citations) {
    const separator = citation.indexOf("=");
    const pathValue = separator > 0 ? citation.slice(0, separator).trim() : "";
    const claimedValue =
      separator > 0 ? citation.slice(separator + 1).trim() : "";
    const resolved = pathValue
      ? evidencePathValue(evidence, pathValue)
      : { found: false, value: undefined };
    const actualValue = resolved.found
      ? printableEvidenceValue(resolved.value)
      : null;
    if (!pathValue || !claimedValue || !resolved.found || actualValue == null) {
      rejected.push(citation);
      continue;
    }
    const canonicalPath = pathValue.replace(/^\$\.?/, "");
    // Never preserve a model-authored value. Re-read it from the immutable
    // invocation evidence so the public citation cannot claim a false value
    // even when the JSON path itself exists.
    verified.add(`${canonicalPath}=${actualValue}`);
  }
  return { verified: [...verified], rejected };
}

type TemporalThresholdUnit = "day" | "week" | "month" | "year";
type TemporalThresholdComparison = "lt" | "lte" | "gt" | "gte";

interface TemporalThresholdClaim {
  amount: number;
  unit: TemporalThresholdUnit;
  comparison: TemporalThresholdComparison;
  direction: "past" | "future" | "either";
  phrase: string;
}

interface TemporalAssessmentAudit {
  failed: boolean;
  message: string | null;
}

function temporalUnit(value: string): TemporalThresholdUnit | null {
  const normalized = value.trim().toLowerCase();
  if (["天", "日", "day", "days"].includes(normalized)) return "day";
  if (["周", "星期", "week", "weeks"].includes(normalized)) return "week";
  if (["月", "个月", "month", "months"].includes(normalized)) {
    return "month";
  }
  if (["年", "year", "years"].includes(normalized)) return "year";
  return null;
}

function temporalDirection(
  text: string,
  matchIndex: number,
  phraseLength: number,
): TemporalThresholdClaim["direction"] {
  const nearby = text.slice(
    Math.max(0, matchIndex - 48),
    Math.min(text.length, matchIndex + phraseLength + 48),
  );
  if (
    /(?:未来|之后|预计|计划|到岗|入职日期|开放日期|截止日期|next|future|after)/i.test(
      nearby,
    )
  ) {
    return "future";
  }
  if (
    /(?:离职|离场|离开|结束|终止|退出|毕业|上次|最近一次|距今|以来|已过|曾在|departure|left|ended|since)/i.test(
      nearby,
    )
  ) {
    return "past";
  }
  return "either";
}

function comparisonFromPrefix(
  value: string,
): TemporalThresholdComparison | null {
  const normalized = value.replace(/\s+/g, "").toLowerCase();
  if (
    /^(?:不足|不满|少于|低于|未满|不到|小于|lessthan|under|fewerthan)$/.test(
      normalized,
    )
  ) {
    return "lt";
  }
  if (
    /^(?:不超过|至多|最多|no more than|at most|within)$/i.test(value.trim())
  ) {
    return "lte";
  }
  if (
    /^(?:已远超过|远超过|已超过|超过|多于|大于|高于|超出|远超|morethan|over|greaterthan)$/.test(
      normalized,
    )
  ) {
    return "gt";
  }
  if (
    /^(?:至少|不少于|不低于|达到|已满|满|atleast|nolessthan)$/.test(
      normalized,
    )
  ) {
    return "gte";
  }
  return null;
}

function parseTemporalThresholdClaims(text: string): TemporalThresholdClaim[] {
  const claims: TemporalThresholdClaim[] = [];
  const add = (
    match: RegExpExecArray,
    amountValue: string,
    unitValue: string,
    comparison: TemporalThresholdComparison | null,
  ) => {
    const amount = Number(amountValue);
    const unit = temporalUnit(unitValue);
    if (!comparison || !unit || !Number.isFinite(amount) || amount < 0) return;
    claims.push({
      amount,
      unit,
      comparison,
      direction: temporalDirection(text, match.index, match[0].length),
      phrase: match[0],
    });
  };

  const chinesePrefix =
    /(?:已远超过|远超过|不超过|不少于|不低于|不足|不满|少于|低于|未满|不到|小于|至多|最多|已超过|超过|多于|大于|高于|超出|远超|至少|达到|已满|满)\s*(\d+(?:\.\d+)?)\s*(?:个)?\s*(天|日|周|星期|个月|月|年)/g;
  for (const match of text.matchAll(chinesePrefix)) {
    const prefix = match[0].slice(0, match[0].indexOf(match[1]!));
    add(match as RegExpExecArray, match[1]!, match[2]!, comparisonFromPrefix(prefix));
  }

  const chinesePostfix =
    /(\d+(?:\.\d+)?)\s*(?:个)?\s*(天|日|周|星期|个月|月|年)\s*(及)?\s*(以上|以下|以内)/g;
  for (const match of text.matchAll(chinesePostfix)) {
    add(
      match as RegExpExecArray,
      match[1]!,
      match[2]!,
      match[4] === "以上" ? "gte" : "lte",
    );
  }

  const englishPrefix =
    /\b(less than|under|fewer than|no more than|at most|within|more than|over|greater than|at least|no less than)\s+(\d+(?:\.\d+)?)\s+(days?|weeks?|months?|years?)\b/gi;
  for (const match of text.matchAll(englishPrefix)) {
    add(
      match as RegExpExecArray,
      match[2]!,
      match[3]!,
      comparisonFromPrefix(match[1]!),
    );
  }

  const seen = new Set<string>();
  return claims.filter((claim) => {
    const key = `${claim.comparison}:${claim.amount}:${claim.unit}:${claim.direction}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function equivalentTemporalThreshold(
  left: TemporalThresholdClaim,
  right: TemporalThresholdClaim,
): boolean {
  if (left.unit === right.unit) return left.amount === right.amount;
  if (
    (left.unit === "month" || left.unit === "year") &&
    (right.unit === "month" || right.unit === "year")
  ) {
    const leftMonths = left.unit === "year" ? left.amount * 12 : left.amount;
    const rightMonths =
      right.unit === "year" ? right.amount * 12 : right.amount;
    return leftMonths === rightMonths;
  }
  if (
    (left.unit === "day" || left.unit === "week") &&
    (right.unit === "day" || right.unit === "week")
  ) {
    const leftDays = left.unit === "week" ? left.amount * 7 : left.amount;
    const rightDays = right.unit === "week" ? right.amount * 7 : right.amount;
    return leftDays === rightDays;
  }
  return false;
}

function temporalFactSupportsClaim(
  fact: TemporalFact,
  claim: TemporalThresholdClaim,
): boolean {
  if (claim.direction === "past" && fact.relationToAsOf === "after") {
    return false;
  }
  if (claim.direction === "future" && fact.relationToAsOf === "before") {
    return false;
  }
  const interval =
    claim.unit === "day"
      ? fact.calendarDays
      : claim.unit === "week"
        ? fact.calendarDays / 7
        : claim.unit === "month"
          ? fact.completedCalendarMonths
          : fact.completedCalendarMonths / 12;
  switch (claim.comparison) {
    case "lt":
      return interval < claim.amount;
    case "lte":
      return interval <= claim.amount;
    case "gt":
      return interval > claim.amount;
    case "gte":
      return interval >= claim.amount;
  }
}

function auditTemporalAssessment(
  rule: RetrievedRule,
  status: AssessmentStatus,
  reason: string,
  verifiedCitations: string[],
  temporalFacts: TemporalFact[],
): TemporalAssessmentAudit {
  if (status === "insufficient_evidence" || status === "not_applicable") {
    return { failed: false, message: null };
  }
  const ruleClaims = parseTemporalThresholdClaims(
    `${rule.logic}\n${rule.submissionCriteria}`,
  );
  if (ruleClaims.length === 0) return { failed: false, message: null };
  const reasonClaims = parseTemporalThresholdClaims(reason);
  if (reasonClaims.length === 0) return { failed: false, message: null };

  const supportedClaims = reasonClaims.filter((reasonClaim) =>
    ruleClaims.some((ruleClaim) =>
      equivalentTemporalThreshold(reasonClaim, ruleClaim),
    ),
  );
  if (supportedClaims.length !== reasonClaims.length) {
    return {
      failed: true,
      message:
        "模型理由使用了规则 logic/submissionCriteria 未声明的时间阈值，无法形成可审计的时间裁决。",
    };
  }

  const temporalByPath = new Map(
    temporalFacts.map((fact) => [fact.path.replace(/^\$\.?/, ""), fact]),
  );
  const citedTemporalFacts = verifiedCitations.flatMap((citation) => {
    const separator = citation.indexOf("=");
    const pathValue =
      separator > 0
        ? citation.slice(0, separator).trim().replace(/^\$\.?/, "")
        : "";
    const fact = temporalByPath.get(pathValue);
    return fact ? [fact] : [];
  });
  if (citedTemporalFacts.length === 0) {
    return {
      failed: true,
      message:
        "模型给出了决定性时间阈值结论，但 assessment 未引用可由 deriveTemporalFacts 回读的日期 json.path。",
    };
  }

  const contradictedClaim = supportedClaims.find(
    (claim) =>
      !citedTemporalFacts.some((fact) =>
        temporalFactSupportsClaim(fact, claim),
      ),
  );
  if (!contradictedClaim) return { failed: false, message: null };
  const facts = citedTemporalFacts
    .map(
      (fact) =>
        `${fact.path}=${fact.value}(${fact.relationToAsOf}, ${fact.calendarDays}天, ${fact.completedCalendarMonths}个完整月)`,
    )
    .join("；");
  return {
    failed: true,
    message: `模型时间结论“${contradictedClaim.phrase}”与确定性时间事实冲突：${facts}。`,
  };
}

interface FinalizeAuditContext {
  parentRunId: string;
  correlationId: string;
  userPrompt: string;
  evidence: Record<string, unknown>;
  evidenceAnalysis?: EvidenceAnalysisAudit | null;
  harnessPlan?: ReasoningHarnessPlan | null;
  queryExecution?: RuleQueryExecution | null;
  queryExecutions?: RuleQueryExecution[];
  queryDiagnostics: Record<string, unknown> | null;
  queryAgentAudit?: QueryAgentAudit | null;
  trace: ReasoningTraceEntry[];
  qualifiedRun?: QualifiedAgentRunReceipt | null;
}

export function finalizeReasoningOutput(
  draftInput: unknown,
  bundle: RuleBundle,
  compiledPrompt?: CompiledQualificationPrompt,
  auditContext?: FinalizeAuditContext,
): ReasoningAgentOutput {
  const draft = modelDraftSchema.parse(draftInput);
  const supplied = new Map(
    draft.assessments.map((item) => [item.ruleId, item]),
  );
  const sourceIds = new Set(bundle.rules.map((rule) => rule.id));
  const unknownRuleIds = [...supplied.keys()].filter(
    (id) => !sourceIds.has(id),
  );
  const autoMissing: string[] = [];
  const authoritativeEvidence = auditContext?.evidence ?? {};
  const deterministicTemporalFacts = deriveTemporalFacts(
    authoritativeEvidence,
  );

  const assessments = bundle.rules.map((rule): RuleAssessment => {
    const proposed = supplied.get(rule.id);
    if (!proposed) {
      autoMissing.push(`规则 ${rule.id} 未返回评估，已按证据不足处理。`);
      return {
        ruleId: rule.id,
        ruleName: rule.name,
        enforcementLevel: rule.enforcementLevel,
        failurePolicy: rule.failurePolicy,
        status: "insufficient_evidence",
        reason: "推理模型未返回该规则的评估，系统按 fail-closed 补为证据不足。",
        evidence: [],
      };
    }
    const normalized = normalizeModelAssessmentStatus(
      proposed.status,
      rule.enforcementLevel,
    );
    if (!normalized.recognized) {
      autoMissing.push(
        `规则 ${rule.id} 返回未知状态 ${JSON.stringify(proposed.status)}，已按证据不足处理。`,
      );
    }
    const normalizedStatus =
      rule.enforcementLevel === "mandatory" &&
      normalized.status === "optional_unmet"
        ? "violated"
        : normalized.status;
    const contradictory = statusContradictsReason(
      normalizedStatus,
      proposed.reason,
    );
    const citationAudit = verifyAssessmentEvidence(
      proposed.evidence,
      authoritativeEvidence,
    );
    const temporalAudit = contradictory
      ? { failed: false, message: null }
      : auditTemporalAssessment(
          rule,
          normalizedStatus,
          proposed.reason,
          citationAudit.verified,
          deterministicTemporalFacts,
        );
    const decisive =
      !contradictory && normalizedStatus !== "insufficient_evidence";
    const citationFailure =
      decisive &&
      (citationAudit.verified.length === 0 ||
        citationAudit.rejected.length > 0);
    const status: AssessmentStatus =
      contradictory || citationFailure || temporalAudit.failed
        ? "insufficient_evidence"
        : normalizedStatus;
    if (contradictory) {
      autoMissing.push(
        `规则 ${rule.id} 的 status=${normalizedStatus} 与 reason 自相矛盾，Quality Guard 已按 fail-closed 转为 insufficient_evidence。`,
      );
    }
    if (citationFailure) {
      autoMissing.push(
        `规则 ${rule.id} 的决定性状态缺少完整、可回读的 json.path=value 引用（verified=${citationAudit.verified.length}, rejected=${citationAudit.rejected.length}），Quality Guard 已按 fail-closed 转为 insufficient_evidence。`,
      );
    }
    if (temporalAudit.failed) {
      autoMissing.push(
        `规则 ${rule.id} 的时间裁决未通过确定性 Quality Guard：${temporalAudit.message} 已按 fail-closed 转为 insufficient_evidence。`,
      );
    }
    return {
      ruleId: rule.id,
      ruleName: rule.name,
      enforcementLevel: rule.enforcementLevel,
      failurePolicy: rule.failurePolicy,
      status,
      reason: contradictory
        ? `Quality Guard 检测到模型状态与理由矛盾，需重新核验。原始理由：${proposed.reason}`
        : citationFailure
          ? `Quality Guard 无法从原始输入回验模型的全部证据引用，需补充或修正证据。原始理由：${proposed.reason}`
          : temporalAudit.failed
            ? `Quality Guard 无法确认模型的时间阈值裁决：${temporalAudit.message} 原始理由：${proposed.reason}`
            : proposed.reason,
      evidence: citationAudit.verified,
    };
  });

  const decision = foldRuleDecision(assessments);
  const flags = assessments
    .filter(
      (item) =>
        item.enforcementLevel === "optional" &&
        (item.status === "violated" ||
          item.status === "optional_unmet" ||
          item.status === "insufficient_evidence"),
    )
    .map((item) => `${item.ruleId} ${item.ruleName}: ${item.reason}`);
  if (unknownRuleIds.length > 0) {
    flags.push(
      `忽略了不在本次 RuleBundle 中的规则：${unknownRuleIds.join(", ")}`,
    );
  }

  const mandatoryBlocked = assessments.filter(
    (item) =>
      item.enforcementLevel === "mandatory" && item.status === "violated",
  ).length;
  const mandatoryPending = assessments.filter(
    (item) =>
      item.enforcementLevel === "mandatory" &&
      item.status === "insufficient_evidence",
  ).length;
  const harnessPlan = auditContext?.harnessPlan;
  const queryExecution = auditContext?.queryExecution;
  const qualifiedRun = auditContext?.qualifiedRun;
  const queryExecutions =
    auditContext?.queryExecutions ?? (queryExecution ? [queryExecution] : []);
  if (
    !harnessPlan ||
    !queryExecution ||
    queryExecutions.length === 0 ||
    !qualifiedRun
  ) {
    throw new Error(
      "Reasoning finalization requires the public Harness, executed Cypher receipts, and isolated QualifiedAgent child-run receipt",
    );
  }
  const compiler =
    compiledPrompt ??
    compileQualificationPrompt({
      domainId: bundle.domainId,
      action: bundle.action,
      scenario: bundle.scenario,
      userPrompt: "deterministic-finalize",
      evidence: {},
      queryIr: bundle.queryIr,
      rules: bundle.rules,
      harnessPlan,
    });
  const expectedRuleIds = bundle.rules.map((rule) => rule.id);
  if (
    qualificationPromptSha256(compiler) !== compiler.promptSha256 ||
    compiler.ruleIds.length !== expectedRuleIds.length ||
    compiler.ruleIds.some((ruleId, index) => ruleId !== expectedRuleIds[index])
  ) {
    throw new Error(
      "QualifiedAgent compiler receipt does not match the current RuleBundle",
    );
  }
  if (
    qualifiedRun.ruleBundleId !== bundle.bundleId ||
    qualifiedRun.compilerId !== compiler.compilerId ||
    qualifiedRun.promptSha256 !== compiler.promptSha256 ||
    qualifiedRun.parentRunId !== auditContext.parentRunId ||
    qualifiedRun.correlationId !== auditContext.correlationId ||
    qualifiedRun.assessmentCount !== compiler.ruleIds.length ||
    draft.assessments.length !== qualifiedRun.assessmentCount
  ) {
    throw new Error(
      "QualifiedAgent child-run receipt does not match the current bundle/compiler/parent/correlation/assessment count",
    );
  }
  if (
    queryExecutions.length !== 2 ||
    queryExecutions[0]?.purpose !== "semantic-rule-selection" ||
    queryExecutions[1]?.purpose !== "mandatory-link-coverage" ||
    queryExecutions[1].rowCount !== 0
  ) {
    throw new Error(
      "Reasoning finalization requires exactly two verified Link-only Cypher receipts",
    );
  }
  const optionalFlagged = assessments.filter(
    (item) =>
      item.enforcementLevel === "optional" &&
      (item.status === "violated" ||
        item.status === "optional_unmet" ||
        item.status === "insufficient_evidence"),
  ).length;
  const statusCounts: Record<AssessmentStatus, number> = {
    satisfied: 0,
    violated: 0,
    optional_unmet: 0,
    not_applicable: 0,
    insufficient_evidence: 0,
  };
  for (const assessment of assessments) statusCounts[assessment.status] += 1;
  const mandatoryCount = bundle.rules.filter(
    (rule) => rule.enforcementLevel === "mandatory",
  ).length;
  const auditAt = new Date().toISOString();
  const baseTrace: ReasoningTraceEntry[] = auditContext?.trace.length
    ? auditContext.trace
    : [
        {
          sequence: 1,
          agentId: "reasoning",
          event: "intent.accepted",
          status: "completed",
          at: bundle.fetchedAt,
          durationMs: null,
          summary: `已接收 ${bundle.scenario} 的规则判定请求。`,
        },
        {
          sequence: 2,
          agentId: "reasoning",
          event: "query_ir.compiled",
          status: "completed",
          at: bundle.fetchedAt,
          durationMs: null,
          summary: `已生成域锁定 Query IR，识别 ${bundle.queryIr.objectTypes.length} 类业务对象。`,
        },
        {
          sequence: 3,
          agentId: "query",
          event: "rules.selected",
          status: "completed",
          at: bundle.fetchedAt,
          durationMs: null,
          summary: `Allmeta 返回 ${bundle.rules.length} 条适用规则。`,
        },
        {
          sequence: 4,
          agentId: "compiler",
          event: "prompt.compiled",
          status: "completed",
          at: bundle.fetchedAt,
          durationMs: null,
          summary: `Prompt Compiler ${compiler.compilerVersion} 已生成 QualifiedAgent harness。`,
        },
      ];
  const nextSequence =
    baseTrace.reduce((highest, entry) => Math.max(highest, entry.sequence), 0) +
    1;
  const trace: ReasoningTraceEntry[] = [
    ...baseTrace,
    {
      sequence: nextSequence,
      agentId: "qualified",
      event: "quality.checked",
      status:
        mandatoryBlocked > 0
          ? "blocked"
          : mandatoryPending > 0 || optionalFlagged > 0
            ? "warning"
            : "completed",
      at: auditAt,
      durationMs: qualifiedRun.durationMs,
      summary: `QualifiedAgent child run ${qualifiedRun.runId} 完成 ${assessments.length} 条逐规则判定：mandatory blocked=${mandatoryBlocked}, pending=${mandatoryPending}, optional flagged=${optionalFlagged}。`,
    },
    {
      sequence: nextSequence + 1,
      agentId: "fold",
      event: "decision.folded",
      status:
        decision === "ineligible"
          ? "blocked"
          : decision === "review_required" || decision === "eligible_with_flags"
            ? "warning"
            : "completed",
      at: auditAt,
      durationMs: 0,
      summary: `确定性折叠得到 ${decision}；最终状态不是由模型自由决定。`,
    },
  ];

  return {
    intentSummary: draft.intentSummary,
    strategy: draft.strategy,
    // The model supplies per-rule assessments, but the user-facing summary is
    // rebuilt from the normalized assessments so a fluent draft can never
    // contradict the deterministic mandatory/optional fold.
    answerSummary: buildDeterministicAnswerSummary(decision, assessments),
    decision,
    domainId: bundle.domainId,
    action: bundle.action,
    scenario: bundle.scenario,
    ruleBundleId: bundle.bundleId,
    ruleCount: bundle.rules.length,
    queryIr: bundle.queryIr,
    harnessPlan,
    promptCompiler: {
      compilerId: compiler.compilerId,
      compilerVersion: compiler.compilerVersion,
      evidenceKeys: compiler.evidenceKeys,
    },
    assessments,
    flags,
    missingEvidence: [...new Set([...draft.missingEvidence, ...autoMissing])],
    audit: {
      visibility: "auditable_reasoning_summary",
      hiddenChainOfThoughtExposed: false,
      input: {
        userPrompt: auditContext?.userPrompt ?? "deterministic-finalize",
        evidence: auditContext?.evidence ?? {},
        evidenceKeys: compiler.evidenceKeys,
      },
      evidenceAnalysis:
        auditContext?.evidenceAnalysis ??
        emptyEvidenceAnalysis(auditContext?.evidence ?? {}),
      harnessPlan,
      ruleSelection: {
        source: "allmeta",
        mode: "generated-cypher/semantic-link-selection",
        selectionBasis: "semantic-links",
        queryFingerprint: queryExecution.fingerprint,
        readOnly: true,
        domainLocked: true,
        linkOnly: true,
        fallbackUsed: false,
        queryExecution,
        queryExecutions,
        fetchedAt: bundle.fetchedAt,
        mandatoryCount,
        optionalCount: bundle.rules.length - mandatoryCount,
        diagnostics: auditContext?.queryDiagnostics ?? null,
        queryAgent:
          auditContext?.queryAgentAudit ??
          buildQueryAgentAudit(
            bundle.queryIr,
            "",
            harnessPlan,
            queryExecution,
            queryExecutions,
          ),
        selectedRules: bundle.rules,
      },
      compiledPrompt: compiler,
      qualityCheck: {
        agent: "QualifiedAgent",
        executionMode: "isolated-child-run",
        run: qualifiedRun,
        assessmentCount: assessments.length,
        statusCounts,
        mandatoryBlocked,
        mandatoryPending,
        optionalFlagged,
      },
      trace,
    },
    runtime: {
      agents: [
        {
          id: "reasoning",
          label: "Intent Reasoner",
          status: "completed",
          detail: `${draft.strategy}: ${draft.intentSummary}`,
        },
        {
          id: "query",
          label: "Rule Selector / QueryAgent",
          status: "completed",
          detail: `Allmeta ${bundle.domainId} 执行 ${queryExecutions.length} 段 Link-only Cypher，通过 ${queryExecution.rowCount} 行选择结果筛选 ${bundle.rules.length} 条规则。`,
        },
        {
          id: "compiler",
          label: "Prompt Compiler",
          status: "completed",
          detail: `${compiler.compilerVersion} 为 ${bundle.scenario} 编译 ${bundle.rules.length} 条规则与 ${compiler.evidenceKeys.length} 类输入。`,
        },
        {
          id: "qualified",
          label: "QualifiedAgent",
          status:
            mandatoryBlocked > 0
              ? "blocked"
              : mandatoryPending > 0 || flags.length > 0
                ? "warning"
                : "completed",
          detail: `独立 child run ${qualifiedRun.runId} 使用 ${qualifiedRun.provider}/${qualifiedRun.model} 完成 ${assessments.length} 条逐规则检查。`,
        },
        {
          id: "fold",
          label: "Deterministic Fold",
          status:
            decision === "ineligible"
              ? "blocked"
              : decision === "review_required" ||
                  decision === "eligible_with_flags"
                ? "warning"
                : "completed",
          detail: `最终裁决：${decision}。mandatory blocked=${mandatoryBlocked}, pending=${mandatoryPending}。`,
        },
      ],
      edges: [
        { from: "reasoning", to: "query" },
        { from: "query", to: "compiler" },
        { from: "compiler", to: "qualified" },
        { from: "qualified", to: "fold" },
      ],
    },
  };
}

const SELECT_RULES_TOOL: ToolDef = {
  name: "select_applicable_rules",
  description:
    "Required first step. Design a public Reasoning Harness, extract auditable evidence anchors, and ask Allmeta to compile and execute a read-only, domain-locked Cypher traversal over semantic SCOPED_TO/GOVERNS/APPLIES_TO/RELEVANT_TO links. The trusted input Action is the first canonical capability anchor and every returned rule must be connected to it through GOVERNS/RELEVANT_TO, with its full link path.",
  input_schema: {
    type: "object",
    properties: {
      harnessPlan: {
        type: "object",
        description:
          "Public, auditable reasoning plan. It describes methods and anchors, never private chain-of-thought.",
        properties: {
          methods: {
            type: "array",
            minItems: 1,
            maxItems: 4,
            items: {
              type: "string",
              enum: [
                "graph_react",
                "evidence_grounding",
                "temporal_constraint",
                "rule_by_rule_verification",
              ],
            },
          },
          capabilityAnchors: {
            type: "array",
            maxItems: 20,
            items: { type: "string", maxLength: 160 },
          },
          objectAnchors: {
            type: "array",
            maxItems: 30,
            items: { type: "string", maxLength: 160 },
          },
          evidenceAnchors: {
            type: "array",
            maxItems: 30,
            items: {
              type: "object",
              properties: {
                objectType: { type: "string", maxLength: 160 },
                evidencePaths: {
                  type: "array",
                  maxItems: 12,
                  items: { type: "string", maxLength: 300 },
                },
                purpose: { type: "string", maxLength: 400 },
              },
              required: ["objectType", "evidencePaths", "purpose"],
              additionalProperties: false,
            },
          },
          stopConditions: {
            type: "array",
            minItems: 1,
            maxItems: 12,
            items: { type: "string", maxLength: 400 },
          },
          publicRationale: { type: "string", maxLength: 1000 },
        },
        required: [
          "methods",
          "capabilityAnchors",
          "objectAnchors",
          "evidenceAnchors",
          "stopConditions",
          "publicRationale",
        ],
        additionalProperties: false,
      },
      rationale: {
        type: "string",
        maxLength: 500,
        description:
          "Short auditable selection rationale; never hidden chain-of-thought.",
      },
      keywords: {
        type: "array",
        items: { type: "string" },
        maxItems: 20,
      },
      extractedFacts: {
        type: "array",
        minItems: 1,
        maxItems: 24,
        description:
          "Atomic facts proposed by the model. Provide only a path; the runtime resolves the real value from invocation evidence.",
        items: {
          type: "object",
          properties: {
            category: {
              type: "string",
              enum: [
                "candidate",
                "target_job",
                "employment_history",
                "qualification",
                "risk_signal",
                "other",
              ],
            },
            purpose: {
              type: "string",
              enum: ["scope_selection", "rule_evaluation", "context"],
            },
            label: { type: "string", maxLength: 120 },
            evidencePath: {
              type: "string",
              maxLength: 300,
              description:
                "Exact JSON path rooted at the supplied evidence, such as jobRequisition.client_name or resume.employment_history[0].end_date.",
            },
            relevance: { type: "string", maxLength: 400 },
          },
          required: [
            "category",
            "purpose",
            "label",
            "evidencePath",
            "relevance",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["harnessPlan", "keywords", "extractedFacts"],
    additionalProperties: false,
  },
};

const COMPILE_PROMPT_TOOL: ToolDef = {
  name: "compile_qualified_prompt",
  description:
    "Required second step after rule selection. Map evidence paths to every selected rule, then compile the invocation scenario, actual evidence, Query IR, and immutable RuleBundle into the exact QualifiedAgent assessment harness. The map is advisory and never removes a rule.",
  input_schema: {
    type: "object",
    properties: {
      ruleEvidencePlan: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            ruleId: { type: "string", maxLength: 160 },
            relevance: {
              type: "string",
              enum: ["direct", "scope_only", "no_direct_signal"],
            },
            evidencePaths: {
              type: "array",
              items: { type: "string", maxLength: 300 },
              maxItems: 12,
            },
            summary: { type: "string", maxLength: 600 },
          },
          required: ["ruleId", "relevance", "evidencePaths", "summary"],
          additionalProperties: false,
        },
      },
    },
    required: ["ruleEvidencePlan"],
    additionalProperties: false,
  },
};

const SEARCH_ONTOLOGY_TOOL: ToolDef = {
  name: "search_ontology_resources",
  description:
    "Progressively search compact rule/action/action-step/event candidates in Allmeta when extra ontology context is needed. This is a bounded Query IR; Allmeta compiles it to read-only, domain-scoped Cypher.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", maxLength: 300 },
      objectTypes: {
        type: "array",
        items: { type: "string" },
        maxItems: 10,
      },
      resourceTypes: {
        type: "array",
        items: {
          type: "string",
          enum: ["rules", "actions", "action_steps", "events"],
        },
        maxItems: 4,
      },
      limit: { type: "integer", minimum: 1, maximum: 12 },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const DETAIL_ONTOLOGY_TOOL: ToolDef = {
  name: "get_ontology_resource_detail",
  description:
    "Expand selected Allmeta rule/action/action-step/event references after a compact search. Keep refs small and only expand evidence relevant to the user's request.",
  input_schema: {
    type: "object",
    properties: {
      resourceType: {
        type: "string",
        enum: ["rules", "actions", "action_steps", "events"],
      },
      refs: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
        maxItems: 10,
      },
    },
    required: ["resourceType", "refs"],
    additionalProperties: false,
  },
};

const searchInputSchema = z.object({
  query: z.string().trim().max(300).default(""),
  objectTypes: z.array(z.string().trim().min(1)).max(10).default([]),
  resourceTypes: z
    .array(z.enum(["rules", "actions", "action_steps", "events"]))
    .max(4)
    .default(["rules", "actions"]),
  limit: z.number().int().min(1).max(12).default(8),
});

const detailInputSchema = z.object({
  resourceType: z.enum(["rules", "actions", "action_steps", "events"]),
  refs: z.array(z.string().trim().min(1)).min(1).max(10),
});

const proposedEvidenceFactSchema = z.object({
  category: z.enum([
    "candidate",
    "target_job",
    "employment_history",
    "qualification",
    "risk_signal",
    "other",
  ]),
  purpose: z.enum(["scope_selection", "rule_evaluation", "context"]),
  label: z.string().trim().min(1).max(120),
  evidencePath: z.string().trim().min(1).max(300),
  relevance: z.string().trim().min(1).max(400),
});

const proposedRuleEvidenceLinkSchema = z.object({
  ruleId: z.string().trim().min(1).max(160),
  relevance: z.enum(["direct", "scope_only", "no_direct_signal"]),
  evidencePaths: z.array(z.string().trim().min(1).max(300)).max(12).default([]),
  summary: z.string().trim().min(1).max(600),
});

const reasoningHarnessInputSchema = z.object({
  methods: z
    .array(
      z.enum([
        "graph_react",
        "evidence_grounding",
        "temporal_constraint",
        "rule_by_rule_verification",
      ]),
    )
    .min(1)
    .max(4),
  capabilityAnchors: z.array(z.string().trim().min(1).max(160)).min(1).max(20),
  objectAnchors: z.array(z.string().trim().min(1).max(160)).max(30).default([]),
  evidenceAnchors: z
    .array(
      z.object({
        objectType: z.string().trim().min(1).max(160),
        evidencePaths: z
          .array(z.string().trim().min(1).max(300))
          .max(12)
          .default([]),
        purpose: z.string().trim().min(1).max(400),
      }),
    )
    .max(30)
    .default([]),
  stopConditions: z.array(z.string().trim().min(1).max(400)).min(1).max(12),
  publicRationale: z.string().trim().min(1).max(1_000),
});

const selectInputSchema = z.object({
  harnessPlan: reasoningHarnessInputSchema,
  rationale: z.string().trim().max(500).optional(),
  keywords: z.array(z.string().trim().min(1)).max(20).default([]),
  extractedFacts: z.array(proposedEvidenceFactSchema).max(24).default([]),
});

const compileInputSchema = z.object({
  ruleEvidencePlan: z
    .array(proposedRuleEvidenceLinkSchema)
    .max(100)
    .default([]),
});

export class ReasoningAgent extends BaseAgent<
  ReasoningAgentInput,
  ReasoningAgentOutput
> {
  readonly name = "reasoningAgent";
  readonly description =
    "Universal link-first rule engine: designs a public reasoning harness, compiles semantic anchors into a domain-locked Cypher query, evaluates every linked rule, and applies a deterministic mandatory/optional fold.";
  override readonly scope = "system" as const;
  override readonly runScope = "caller" as const;
  override readonly inngestEnabled = true;
  override readonly maxSteps = 6;
  override readonly maxOutputTokens = 8_000;

  private readonly states = new Map<string, RetrievalState>();

  protected override buildMessages(
    rawInput: ReasoningAgentInput,
    ctx: AgentContext,
  ): ChatMessage[] {
    const stateKey = ctx.runId?.trim();
    if (!stateKey) {
      throw new Error("ReasoningAgent requires a runtime-assigned runId");
    }
    const input = reasoningInputSchema.parse(rawInput);
    const domainId = input.domainId;
    const action = input.action;
    const scenario = input.scenario ?? action;
    const evidence = buildReasoningEvidence(input);
    const scopeResolution = resolveTargetRuleScope(input);
    const queryIr = deriveRuleSelectionQueryIr(input, evidence);
    const createdAt = Date.now();
    const evidenceKeys = Object.keys(evidence).sort();
    this.pruneStates();
    this.states.set(stateKey, {
      phase: "initialized",
      createdAt,
      domainId,
      action,
      scenario,
      prompt: input.prompt,
      evidence,
      queryIr,
      scopeResolution,
      queryDiagnostics: null,
      queryAgentAudit: null,
      harnessPlan: null,
      queryExecution: null,
      queryExecutions: [],
      evidenceAnalysis: null,
      trace: [
        {
          sequence: 1,
          agentId: "reasoning",
          event: "intent.accepted",
          status: "completed",
          at: new Date(createdAt).toISOString(),
          durationMs: 0,
          summary: `已解析用户意图并锁定业务场景 ${scenario}、规范 Action 能力锚点 ${action} 与 ${evidenceKeys.length} 类输入证据。`,
        },
        {
          sequence: 2,
          agentId: "reasoning",
          event: "query_ir.compiled",
          status: "completed",
          at: new Date(createdAt).toISOString(),
          durationMs: 0,
          summary: `准备动态 Reasoning Harness；目标 client=${queryIr.applicableClient || "缺失"}（${scopeResolution.clientSource}），department=${queryIr.applicableDepartment || "缺失"}（${scopeResolution.departmentSource}），只允许批准的语义 Link 类型。`,
        },
      ],
    });

    return [
      {
        role: "system",
        content: [
          "你是 Agentic Operator 的通用规则推理编排 Agent。你要根据当前问题动态组合 Graph-ReAct、证据锚定、时间约束与逐规则核验方法，但只输出可审计的公开推理计划，不输出隐藏思维链。",
          `本次规则域固定为 ${domainId}，${action} 是规范 Action/ActionStep 能力锚点，业务场景为 ${scenario}。`,
          "第一步必须调用 select_applicable_rules：先生成 ReasoningHarnessPlan，再给出业务关键词，以及从 Candidate/Resume/Job Requisition/JD 抽取的关键原子事实。Harness 必须包含 capability/object/evidence anchors、停止条件与公开理由。capabilityAnchors 只能原样使用 Query IR seed 中的本体 Action/ActionStep 标识，不得翻译或创造描述性能力名称；若 seed 为空则保持为空并使用 object/intent anchors。每条事实只提交精确 evidencePath，不提交 value；运行时会从原始输入解析真实值并标记是否通过校验。不得自行编写 Cypher、凭记忆生成规则或绕过域锁定。",
          "只抽取对作用域、规则适用性或判定有直接意义的事实；电话、邮箱、证件号等联系/身份敏感字段除非规则明确要求，否则不得进入 extractedFacts。",
          "事实的 purpose 必须诚实区分：只有目标 Job Requisition/JD 的 client/department 可标 scope_selection；Resume/Candidate 历史、资质与风险事实只能标 rule_evaluation 或 context，不能借此预先删除任何 mandatory/optional 规则。",
          "Allmeta 会把 Harness anchors 编译成真实、只读、域锁定的 Cypher，并且只沿 SCOPED_TO、GOVERNS、APPLIES_TO、RELEVANT_TO Links 返回规则。SCOPED_TO 锁定 CSI/client/department；GOVERNS 只表示显式 ActionStep 绑定；RELEVANT_TO 只接受已审核语义关系。每条规则必须携带命中的三元组路径；没有 Link 路径、发生 fallback 或缺少 Cypher 回执时，运行必须失败关闭。",
          "第二步必须调用 compile_qualified_prompt，并为 RuleBundle 的每条规则提交 ruleEvidencePlan：direct 表示已有直接事实信号，scope_only 表示仅因作用域进入规则池，no_direct_signal 表示尚无直接信号。该计划只是可审计的查证路线，不能删除规则或决定状态。Prompt Compiler 会结合 ReasoningHarnessPlan、真实 Links、输入证据与 RuleBundle 动态生成 prompt，并立即交给独立 QualifiedAgent child run。",
          "作用域必须合并 CSI 通用、当前客户通用、当前客户部门规则，并排除其他客户和部门。只使用 enforcementLevel=mandatory|optional 与 failurePolicy=block|warn；规范 Action 必须作为 capabilityAnchors 的第一项，并通过 GOVERNS/RELEVANT_TO 构成确定性的能力语义门，不得读取 Rule stage。",
          "目标 client/department 只从目标 Job Requisition 与 JD 解析，优先级为 Job Requisition > JD > 显式兜底 > generic inputs。用户 prompt 以及 Resume 中的历史客户/部门不得覆盖目标岗位作用域；冲突只记录审计，不扩大筛选范围。",
          "事实必须来自输入或工具结果。最终裁决由系统代码确定性折叠，你不要输出 decision。",
          "compile_qualified_prompt 成功后只需简短确认 handoff 已完成；你不得再次生成或修改 QualifiedAgent assessments。最终裁决只读取独立 child run 的结构化输出并由系统确定性折叠。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `用户请求：\n${input.prompt}`,
          `业务场景：${scenario}`,
          `规范 Action 能力锚点：${action}`,
          `确定性 Query IR seed：\n${clipJson(queryIr)}`,
          `通用输入证据：\n${clipJson(evidence)}`,
        ].join("\n\n"),
      },
    ];
  }

  override getTools(): ToolDef[] {
    return [
      SELECT_RULES_TOOL,
      COMPILE_PROMPT_TOOL,
      SEARCH_ONTOLOGY_TOOL,
      DETAIL_ONTOLOGY_TOOL,
    ];
  }

  override getToolHandlers(ctx: AgentContext): ToolHandlerMap {
    const stateKey = ctx.runId?.trim();
    const state = stateKey ? this.states.get(stateKey) : undefined;
    if (!state) {
      throw new Error("ReasoningAgent invocation state was not initialized");
    }
    return {
      select_applicable_rules: async (raw) => {
        if (state.phase !== "initialized") {
          throw new Error(
            `select_applicable_rules is not allowed after phase=${state.phase}; the selected RuleBundle is immutable once accepted`,
          );
        }
        const startedAt = Date.now();
        const input = selectInputSchema.parse(raw);
        const harnessPlan = normalizeReasoningHarnessPlan(
          input.harnessPlan,
          state.queryIr,
          state.evidence,
        );
        const evidenceAnalysis = auditExtractedEvidenceFacts(
          input.extractedFacts,
          state.evidence,
        );
        state.evidenceAnalysis = evidenceAnalysis;
        const keywords = [
          ...new Set([
            ...state.queryIr.keywords,
            ...input.keywords,
            ...harnessPlan.capabilityAnchors,
          ]),
        ].slice(0, 40);
        const requestedQueryIr: RuleSelectionQueryIr = {
          ...state.queryIr,
          intentTerms: keywords,
          capabilityAnchors: harnessPlan.capabilityAnchors,
          objectAnchors: harnessPlan.objectAnchors,
          evidenceAnchors: harnessPlan.evidenceAnchors,
          strongKeywords: keywords,
          keywords,
        };
        const body = (await reasoningAllmetaJson(
          "/api/v1/ontology/rule-evaluation/select",
          { method: "POST", body: requestedQueryIr },
        )) as AllmetaRuleSelectionResponse;
        if (
          stringValue(body.selectionBasis).toLowerCase() !== "semantic-links"
        ) {
          throw new Error(
            "Allmeta did not confirm selectionBasis=semantic-links; refusing non-link rule selection",
          );
        }
        const queryExecutions = normalizeRuleQueryExecutions(
          body.queryExecutions,
          body.queryExecution,
          state.domainId,
        );
        const queryExecution = queryExecutions[0]!;
        const queryIr = normalizeSelectionQueryIr(
          body.queryIr,
          requestedQueryIr,
        );
        const bundle = buildRuleBundle(
          state.domainId,
          state.action,
          state.scenario,
          queryIr,
          body,
        );
        state.queryIr = queryIr;
        state.bundle = bundle;
        state.harnessPlan = harnessPlan;
        state.queryExecution = queryExecution;
        state.queryExecutions = queryExecutions;
        const diagnostics = recordValue(body.diagnostics);
        state.queryDiagnostics =
          Object.keys(diagnostics).length > 0 ? diagnostics : null;
        const queryAgentAudit = buildQueryAgentAudit(
          queryIr,
          input.rationale ?? harnessPlan.publicRationale,
          harnessPlan,
          queryExecution,
          queryExecutions,
          state.scopeResolution,
        );
        state.queryAgentAudit = queryAgentAudit;
        const mandatoryCount = bundle.rules.filter(
          (rule) => rule.enforcementLevel === "mandatory",
        ).length;
        const completedAt = Date.now();
        const scopeCounts = recordValue(diagnostics.selectedScopeCounts);
        state.trace.push({
          sequence: state.trace.length + 1,
          agentId: "reasoning",
          event: "evidence.extracted",
          status:
            evidenceAnalysis.unverifiedCount > 0 ? "warning" : "completed",
          at: new Date(completedAt).toISOString(),
          durationMs: 0,
          summary: `Intent Reasoner 提交 ${evidenceAnalysis.facts.length} 条原子事实路径；运行时验证 ${evidenceAnalysis.verifiedCount} 条，未验证 ${evidenceAnalysis.unverifiedCount} 条，并生成 ${evidenceAnalysis.temporalFacts.length} 条确定性时间事实。`,
        });
        state.trace.push({
          sequence: state.trace.length + 1,
          agentId: "query",
          event: "rules.selected",
          status: "completed",
          at: new Date(completedAt).toISOString(),
          durationMs: completedAt - startedAt,
          summary: `QueryAgent 执行 ${queryExecutions.length} 段 Link-only Cypher：选择查询返回 ${queryExecution.rowCount} 行，mandatory Links 覆盖检查返回 ${queryExecutions[1]?.rowCount ?? "兼容模式"} 行；选出 ${bundle.rules.length} 条规则（CSI通用=${String(scopeCounts.csi_universal ?? 0)}，客户通用=${String(scopeCounts.client_general ?? 0)}，客户部门=${String(scopeCounts.client_department ?? 0)}；mandatory=${mandatoryCount}, optional=${bundle.rules.length - mandatoryCount}）。`,
        });
        state.phase = "selected";
        return {
          ok: true,
          data: {
            ...bundle,
            selectionBasis: "semantic-links",
            harnessPlan,
            queryExecution,
            queryExecutions,
            mandatoryCount,
            optionalCount: bundle.rules.length - mandatoryCount,
            auditInput: {
              userPrompt: state.prompt,
              evidence: state.evidence,
              evidenceKeys: Object.keys(state.evidence).sort(),
            },
            evidenceAnalysis,
            queryAgent: {
              mode: "generated-cypher/semantic-link-selection",
              readOnly: true,
              domainLocked: true,
              linkOnly: true,
              fallbackUsed: false,
              rationale: input.rationale ?? harnessPlan.publicRationale,
              selectionStrategy: queryAgentAudit.selectionStrategy,
              modelRationale: queryAgentAudit.modelRationale,
              harnessPlan,
              queryExecution,
              queryExecutions,
              filters: queryAgentAudit.filters,
              diagnostics: state.queryDiagnostics,
            },
          },
          meta: {
            domainId: state.domainId,
            action: state.action,
            ruleBundleId: bundle.bundleId,
          },
        };
      },
      compile_qualified_prompt: async (raw) => {
        const startedAt = Date.now();
        if (
          !state.bundle ||
          !state.harnessPlan ||
          !state.queryExecution ||
          state.queryExecutions.length === 0
        ) {
          return {
            ok: false,
            error: {
              code: "RULE_BUNDLE_REQUIRED",
              message:
                "link-backed select_applicable_rules must succeed before Prompt Compiler runs",
            },
          };
        }
        if (
          state.phase !== "selected" &&
          state.phase !== "compiled" &&
          state.phase !== "qualified"
        ) {
          throw new Error(
            `compile_qualified_prompt is not allowed during phase=${state.phase}`,
          );
        }
        const input = compileInputSchema.parse(raw);
        const ruleEvidencePlan = auditRuleEvidencePlan(
          input.ruleEvidencePlan,
          state.evidence,
          state.bundle.rules,
        );
        const nextEvidenceAnalysis =
          state.evidenceAnalysis ?? emptyEvidenceAnalysis(state.evidence);
        const compiledPrompt = compileQualificationPrompt({
          domainId: state.domainId,
          action: state.action,
          scenario: state.scenario,
          userPrompt: state.prompt,
          evidence: state.evidence,
          queryIr: state.queryIr,
          rules: state.bundle.rules,
          harnessPlan: state.harnessPlan,
          evidencePlan: ruleEvidencePlan,
        });
        if (
          state.compiledPrompt &&
          (state.compiledPrompt.compilerId !== compiledPrompt.compilerId ||
            state.compiledPrompt.promptSha256 !== compiledPrompt.promptSha256)
        ) {
          throw new Error(
            "Prompt Compiler was invoked twice with different evidence plans",
          );
        }
        nextEvidenceAnalysis.ruleEvidencePlan = ruleEvidencePlan;
        state.evidenceAnalysis = nextEvidenceAnalysis;
        state.compiledPrompt ??= compiledPrompt;
        const completedAt = Date.now();
        if (!state.qualifiedExecution) {
          state.phase = "compiled";
          state.trace.push({
            sequence: state.trace.length + 1,
            agentId: "compiler",
            event: "prompt.compiled",
            status: "completed",
            at: new Date(completedAt).toISOString(),
            durationMs: completedAt - startedAt,
            summary: `Prompt Compiler ${compiledPrompt.compilerVersion} 已将 ${compiledPrompt.ruleIds.length} 条规则、${compiledPrompt.semanticLinkCount} 条语义 Links、${compiledPrompt.evidenceKeys.length} 类证据与 ${ruleEvidencePlan.length} 条 fact→rule 查证路线编译为 QualifiedAgent harness（prompt receipt ${compiledPrompt.promptSha256.slice(0, 24)}…）。`,
          });
          if (!ctx.runId) {
            throw new Error("QualifiedAgent child run requires a parent runId");
          }
          const parentRunId = ctx.runId;
          const lockedBundle = state.bundle;
          state.qualifiedExecution = (async () => {
            const result = await internalQualifiedAgent.run(
              {
                compiledPrompt,
                ruleBundleId: lockedBundle.bundleId,
                expectedRuleIds: compiledPrompt.ruleIds,
              },
              {
                tenantSlug: ctx.tenantSlug,
                correlationId: ctx.correlationId,
                invocationId: `${ctx.invocationId ?? parentRunId}:qualified:${compiledPrompt.compilerId.slice(-16)}`,
                provider: ctx.provider,
                providers: ctx.providers,
                model: ctx.model,
                parentRunId,
                runtimeRole: "qualified",
                testRun: ctx.testRun,
              },
            );
            if (result.status !== "ok" || !result.output) {
              throw new Error(
                `QualifiedAgent child run ${result.runId} did not return a valid structured assessment`,
              );
            }
            const receipt: QualifiedAgentRunReceipt = {
              role: "qualified",
              executionMode: "isolated-child-run",
              runId: result.runId,
              parentRunId,
              correlationId: ctx.correlationId,
              compilerId: compiledPrompt.compilerId,
              promptSha256: compiledPrompt.promptSha256,
              ruleBundleId: lockedBundle.bundleId,
              provider: result.provider,
              model: result.model,
              tokensIn: result.tokensIn,
              tokensOut: result.tokensOut,
              durationMs: result.durationMs,
              steps: result.steps ?? 0,
              assessmentCount: result.output.assessments.length,
            };
            return { draft: result.output, receipt };
          })();
        }
        const qualified = await state.qualifiedExecution;
        state.qualifiedDraft = qualified.draft;
        state.qualifiedRun = qualified.receipt;
        state.phase = "qualified";
        return {
          ok: true,
          data: compactQualificationToolData(
            compiledPrompt,
            qualified.receipt,
            qualified.draft.assessments.length,
          ),
          meta: {
            compilerId: compiledPrompt.compilerId,
            compilerVersion: compiledPrompt.compilerVersion,
            ruleCount: compiledPrompt.ruleIds.length,
            qualifiedRunId: qualified.receipt.runId,
          },
        };
      },
      search_ontology_resources: async (raw) => {
        const input = searchInputSchema.parse(raw);
        const data = await reasoningAllmetaJson(
          "/api/v1/ontology/rule-evaluation/search",
          {
            method: "POST",
            body: {
              domainId: state.domainId,
              query: input.query,
              objectTypes: input.objectTypes,
              resourceTypes: input.resourceTypes,
              limit: input.limit,
            },
          },
        );
        return {
          ok: true,
          data,
          meta: {
            domainId: state.domainId,
            queryMode: "compiled-cypher/resource-search",
          },
        };
      },
      get_ontology_resource_detail: async (raw) => {
        const input = detailInputSchema.parse(raw);
        const data = await reasoningAllmetaJson(
          "/api/v1/ontology/rule-evaluation/detail",
          {
            method: "POST",
            body: {
              domainId: state.domainId,
              resourceType: input.resourceType,
              refs: input.refs,
              limit: input.refs.length,
            },
          },
        );
        return {
          ok: true,
          data,
          meta: {
            domainId: state.domainId,
            queryMode: "compiled-cypher/resource-detail",
          },
        };
      },
    };
  }

  protected override async parseOutput(
    _text: string,
    ctx: AgentContext,
  ): Promise<ReasoningAgentOutput> {
    const stateKey = ctx.runId?.trim();
    const state = stateKey ? this.states.get(stateKey) : undefined;
    try {
      if (!state?.bundle) {
        throw new Error(
          "ReasoningAgent did not retrieve an authoritative RuleBundle; refusing to produce a rule decision",
        );
      }
      if (!state.compiledPrompt) {
        throw new Error(
          "ReasoningAgent did not run Prompt Compiler; refusing to produce a rule decision",
        );
      }
      if (!state.qualifiedDraft || !state.qualifiedRun) {
        throw new Error(
          "ReasoningAgent did not receive an isolated QualifiedAgent child-run result; refusing to let the outer model decide",
        );
      }
      if (state.phase !== "qualified") {
        throw new Error(
          `ReasoningAgent cannot finalize during phase=${state.phase}`,
        );
      }
      if (
        !state.harnessPlan ||
        !state.queryExecution ||
        state.queryExecutions.length === 0
      ) {
        throw new Error(
          "ReasoningAgent has no link-first Harness/Cypher receipt; refusing to produce a rule decision",
        );
      }
      const output = finalizeReasoningOutput(
        state.qualifiedDraft,
        state.bundle,
        state.compiledPrompt,
        {
          parentRunId: ctx.runId ?? "",
          correlationId: ctx.correlationId,
          userPrompt: state.prompt,
          evidence: state.evidence,
          evidenceAnalysis: state.evidenceAnalysis,
          harnessPlan: state.harnessPlan,
          queryExecution: state.queryExecution,
          queryExecutions: state.queryExecutions,
          queryDiagnostics: state.queryDiagnostics,
          queryAgentAudit: state.queryAgentAudit,
          trace: state.trace,
          qualifiedRun: state.qualifiedRun,
        },
      );
      if (ctx.runId) await persistReasoningResult(ctx.runId, output);
      return output;
    } finally {
      if (stateKey) this.states.delete(stateKey);
    }
  }

  private pruneStates(): void {
    const oldestAllowed = Date.now() - 30 * 60_000;
    for (const [key, state] of this.states) {
      if (state.createdAt < oldestAllowed) this.states.delete(key);
    }
    while (this.states.size >= 100) {
      const oldestKey = this.states.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.states.delete(oldestKey);
    }
  }
}

agentRegistry.register(new ReasoningAgent());
