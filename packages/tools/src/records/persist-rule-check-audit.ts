/**
 * persistRuleCheckAudit — durable, write-before-emit persistence for one
 * ontology rule-evaluation result.
 *
 * The tool is intentionally data-driven: it consumes the structured output of
 * `reasoning.evaluateRules`, verifies the deterministic fold, and persists one
 * audit row plus one evidence row per evaluated rule.  Trusted manifest config
 * selects the tenant/domain/action scope and environment references; event data
 * can never select a database, token, domain, action, or table.
 *
 * PostgreSQL is the required system of record.  Allmeta mirroring is optional
 * and uses only its strict HTTP instance API — this module never talks to a
 * graph database directly.  PostgreSQL commits first; an Allmeta failure then
 * rejects the step.  Retrying is safe because both writes use a stable audit id.
 */

import { createHash } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import { defineTool } from "@agentic/agent-kit";
import {
  readEnvironmentReference,
  readOptionalEnvironmentReference,
} from "../config/env-ref";

type JsonRecord = Record<string, unknown>;

export type RuleAuditDecision = "PASS" | "FAIL";

export interface NormalizedRuleAuditFlag {
  rule_id: string;
  rule_name: string;
  enforcement_level: "mandatory" | "optional";
  failure_policy: "block" | "warn";
  status:
    | "satisfied"
    | "violated"
    | "optional_unmet"
    | "not_applicable"
    | "insufficient_evidence";
  reason: string;
  evidence: string[];
  applicable: boolean;
  result: "PASS" | "FAIL" | "NOT_APPLICABLE";
  severity: "terminal" | "needs_human" | "flag_only";
  next_action: "continue" | "block";
}

export interface RuleCheckAuditRecord {
  audit_id: string;
  run_id: string;
  scenario_id: string | null;
  trace_id: string;
  upload_id: string;
  candidate_id: string;
  resume_id: string;
  job_requisition_id: string;
  client_name: string | null;
  business_group: string | null;
  studio: string | null;
  decision: RuleAuditDecision;
  llm_decision: string;
  failure_reasons: string[];
  llm_model: string;
  llm_duration_ms: number;
  llm_prompt_tokens: number | null;
  llm_completion_tokens: number | null;
  rules_evaluated: number;
  rules_total_in_ontology: number;
  rule_source: string;
  missing_evidence: string[];
  rule_provenance: unknown;
  parsed_resume: unknown;
  job_requisition: unknown;
  user_prompt: string | null;
  system_prompt: string | null;
  parent_audit_id: string | null;
  llm_round_trips: number;
  flags: NormalizedRuleAuditFlag[];
}

export interface RuleAuditPersistenceReceipt {
  audit_id: string;
  decision: RuleAuditDecision;
  rules_evaluated: number;
  postgres: "written";
  allmeta: "written" | "disabled";
  domain: string;
  action: string;
}

export interface RuleAuditPersistenceAdapters {
  postgres?: (args: {
    connectionString: string;
    timeoutMs: number;
    audit: RuleCheckAuditRecord;
  }) => Promise<void>;
  allmeta?: (args: {
    baseUrl: string;
    apiKey: string;
    domain: string;
    timeoutMs: number;
    audit: RuleCheckAuditRecord;
  }) => Promise<void>;
}

export interface PersistRuleCheckAuditExternalArgs {
  tenantSlug: string;
  ontologyActionName?: string;
  agentName: string;
  correlationId: string;
  runId?: string;
  eventData?: JsonRecord;
  lastResult?: unknown;
  results?: Record<string, unknown>;
  config: JsonRecord;
  env?: Record<string, string | undefined>;
}

const MAX_RULES = 300;
const MAX_TEXT = 16_000;
const MAX_JSON = 1_000_000;
const DEFAULT_TIMEOUT_MS = 8_000;

function record(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function text(value: unknown, max = MAX_TEXT): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function nullableText(value: unknown, max = MAX_TEXT): string | null {
  return text(value, max) || null;
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function nonNegativeInteger(value: unknown, fallback = 0): number {
  const parsed = integer(value);
  return parsed !== null && parsed >= 0 ? parsed : fallback;
}

function strings(value: unknown, maxItems = 100): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, 2_000))
    .filter(Boolean)
    .slice(0, maxItems);
}

function safeJson(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new Error(`persistRuleCheckAudit: ${field} is not JSON-serializable`, {
      cause: error,
    });
  }
  if (Buffer.byteLength(encoded, "utf8") > MAX_JSON) {
    throw new Error(
      `persistRuleCheckAudit: ${field} exceeds ${MAX_JSON} bytes`,
    );
  }
  return encoded;
}

function requireText(value: unknown, field: string): string {
  const parsed = text(value, 500);
  if (!parsed) throw new Error(`persistRuleCheckAudit: ${field} is required`);
  return parsed;
}

function firstRecordValue(
  roots: Array<JsonRecord | null>,
  keys: readonly string[],
): unknown {
  for (const root of roots) {
    if (!root) continue;
    for (const key of keys) {
      if (root[key] !== undefined && root[key] !== null) return root[key];
    }
  }
  return undefined;
}

function firstString(
  roots: Array<JsonRecord | null>,
  keys: readonly string[],
): string {
  return text(firstRecordValue(roots, keys), 500);
}

function nested(root: JsonRecord | null, ...keys: string[]): JsonRecord | null {
  let current: JsonRecord | null = root;
  for (const key of keys) current = record(current?.[key]);
  return current;
}

function stableAuditId(input: {
  tenant: string;
  domain: string;
  action: string;
  runId: string;
  uploadId: string;
  candidateId: string;
  resumeId: string;
  jobRequisitionId: string;
}): string {
  return `rca_${createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 40)}`;
}

function normalizeStatus(value: unknown): NormalizedRuleAuditFlag["status"] {
  const normalized = text(value, 80).toLowerCase().replaceAll("-", "_");
  switch (normalized) {
    case "satisfied":
    case "pass":
    case "passed":
    case "通过":
      return "satisfied";
    case "violated":
    case "fail":
    case "failed":
    case "未通过":
    case "不通过":
      return "violated";
    case "optional_unmet":
    case "warn":
    case "warning":
      return "optional_unmet";
    case "not_applicable":
    case "not_triggered":
    case "n/a":
      return "not_applicable";
    case "insufficient_evidence":
    case "insufficient_info":
    case "review":
    case "pending":
      return "insufficient_evidence";
    default:
      throw new Error(
        `persistRuleCheckAudit: unsupported rule status ${JSON.stringify(value)}`,
      );
  }
}

function normalizeEnforcement(
  raw: JsonRecord,
): "mandatory" | "optional" {
  const value = text(
    raw.enforcement_level ?? raw.enforcementLevel ?? raw.mandatory,
    80,
  ).toLowerCase();
  if (["mandatory", "required", "true", "必须", "强制"].includes(value)) {
    return "mandatory";
  }
  if (["optional", "false", "可选", "参考"].includes(value)) {
    return "optional";
  }
  if (raw.flag_only === true) return "optional";
  if (raw.flag_only === false) return "mandatory";
  throw new Error(
    `persistRuleCheckAudit: rule ${JSON.stringify(raw.rule_id ?? raw.ruleId ?? raw.id)} has no explicit enforcement level`,
  );
}

export function normalizeRuleAuditFlags(
  value: unknown,
): NormalizedRuleAuditFlag[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      "persistRuleCheckAudit: rule_results/assessments must be a non-empty array",
    );
  }
  if (value.length > MAX_RULES) {
    throw new Error(
      `persistRuleCheckAudit: rule result count exceeds ${MAX_RULES}`,
    );
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    const raw = record(item);
    if (!raw) {
      throw new Error(
        `persistRuleCheckAudit: rule result ${index} must be an object`,
      );
    }
    const ruleId = requireText(
      raw.rule_id ?? raw.ruleId ?? raw.id,
      `rule result ${index}.rule_id`,
    );
    if (seen.has(ruleId)) {
      throw new Error(
        `persistRuleCheckAudit: duplicate rule result '${ruleId}'`,
      );
    }
    seen.add(ruleId);
    const enforcement = normalizeEnforcement(raw);
    const failurePolicyRaw = text(
      raw.failure_policy ?? raw.failurePolicy,
      80,
    ).toLowerCase();
    const failurePolicy = failurePolicyRaw
      ? failurePolicyRaw === "block"
        ? "block"
        : failurePolicyRaw === "warn"
          ? "warn"
          : null
      : null;
    if (!failurePolicy) {
      throw new Error(
        `persistRuleCheckAudit: rule '${ruleId}' has no explicit supported failure_policy`,
      );
    }
    if (
      (enforcement === "mandatory" && failurePolicy !== "block") ||
      (enforcement === "optional" && failurePolicy !== "warn")
    ) {
      throw new Error(
        `persistRuleCheckAudit: rule '${ruleId}' enforcement/failure_policy conflict`,
      );
    }
    const status = normalizeStatus(raw.status ?? raw.result);
    const blocking =
      enforcement === "mandatory" &&
      (status === "violated" ||
        status === "optional_unmet" ||
        status === "insufficient_evidence");
    const evidence = Array.isArray(raw.evidence)
      ? strings(raw.evidence, 12)
      : text(raw.evidence, 2_000)
        ? [text(raw.evidence, 2_000)]
        : [];
    const reason = requireText(
      raw.reason ?? raw.decision_reason ?? raw.explanation,
      `rule '${ruleId}'.reason`,
    );
    return {
      rule_id: ruleId,
      rule_name:
        text(raw.rule_name ?? raw.ruleName ?? raw.name, 500) || ruleId,
      enforcement_level: enforcement,
      failure_policy: failurePolicy,
      status,
      reason,
      evidence,
      applicable: status !== "not_applicable",
      result:
        status === "not_applicable"
          ? "NOT_APPLICABLE"
          : status === "satisfied"
            ? "PASS"
            : "FAIL",
      severity:
        enforcement === "optional"
          ? "flag_only"
          : status === "insufficient_evidence"
            ? "needs_human"
            : "terminal",
      next_action: blocking ? "block" : "continue",
    };
  });
}

function upstreamDecision(value: unknown): RuleAuditDecision {
  const normalized = text(value, 100).toLowerCase();
  if (
    ["eligible", "eligible_with_flags", "pass", "passed", "通过"].includes(
      normalized,
    )
  ) {
    return "PASS";
  }
  if (
    [
      "ineligible",
      "review_required",
      "fail",
      "failed",
      "review",
      "未通过",
      "不通过",
    ].includes(normalized)
  ) {
    return "FAIL";
  }
  throw new Error(
    `persistRuleCheckAudit: unsupported or missing rule decision ${JSON.stringify(value)}`,
  );
}

function decisionFromFlags(flags: NormalizedRuleAuditFlag[]): RuleAuditDecision {
  return flags.some((flag) => flag.next_action === "block") ? "FAIL" : "PASS";
}

function snapshotRoots(args: PersistRuleCheckAuditExternalArgs): JsonRecord[] {
  const roots: JsonRecord[] = [];
  if (args.eventData) roots.push(args.eventData);
  for (const value of Object.values(args.results ?? {})) {
    const item = record(value);
    if (item) roots.push(item);
  }
  const previous = record(args.lastResult);
  if (previous) roots.push(previous);
  return roots;
}

export function buildRuleCheckAuditRecord(
  args: PersistRuleCheckAuditExternalArgs,
  scope: { tenant: string; domain: string; action: string },
): RuleCheckAuditRecord {
  const roots = snapshotRoots(args);
  const merged = Object.assign({}, ...roots) as JsonRecord;
  const reasoning = record(merged.reasoning_rule_engine);
  const reasoningAudit = record(reasoning?.audit);
  const qualityRun = nested(reasoningAudit, "qualityCheck", "run");
  const compiledPrompt = record(reasoningAudit?.compiledPrompt);
  const inputAudit = record(reasoningAudit?.input);
  const ruleSelection = record(reasoningAudit?.ruleSelection);
  const jobRequisition =
    record(firstRecordValue([...roots].reverse(), ["job_requisition", "jobRequisition", "jd"])) ??
    null;
  const parsedResume = firstRecordValue([...roots].reverse(), [
    "parsed_resume",
    "parsedResume",
    "parsed",
  ]);
  const identityRoots = [...roots].reverse();
  if (jobRequisition) identityRoots.unshift(jobRequisition);

  const uploadId = requireText(
    firstString(identityRoots, ["upload_id", "uploadId"]),
    "upload_id",
  );
  const candidateId = requireText(
    firstString(identityRoots, ["candidate_id", "candidateId"]),
    "candidate_id",
  );
  const resumeId = requireText(
    firstString(identityRoots, ["resume_id", "resumeId"]),
    "resume_id",
  );
  const jobRequisitionId = requireText(
    firstString(identityRoots, [
      "job_requisition_id",
      "jobRequisitionId",
      "requisition_id",
    ]),
    "job_requisition_id",
  );
  const runId = requireText(
    args.runId ?? merged.nested_reasoning_run_id ?? args.correlationId,
    "run_id/correlation_id",
  );
  const rawRules =
    merged.rule_results ?? reasoning?.assessments ?? merged.rule_check_rules;
  const flags = normalizeRuleAuditFlags(rawRules);
  const rawDecision = merged.rule_decision ?? reasoning?.decision;
  const claimedDecision = upstreamDecision(rawDecision);
  const foldedDecision = decisionFromFlags(flags);
  if (claimedDecision !== foldedDecision) {
    throw new Error(
      `persistRuleCheckAudit: claimed decision ${claimedDecision} conflicts with deterministic per-rule fold ${foldedDecision}`,
    );
  }
  const infraFailure = firstString(identityRoots, [
    "fail_reason",
    "infra_failure",
    "infrastructure_failure",
  ]);
  if (infraFailure) {
    throw new Error(
      "persistRuleCheckAudit: infrastructure failures must be parked/retried, not persisted as a business verdict",
    );
  }
  const rulesTotal = integer(reasoning?.ruleCount ?? merged.rule_count);
  if (rulesTotal === null || rulesTotal < 0) {
    throw new Error(
      "persistRuleCheckAudit: reasoning audit rule_count is required",
    );
  }
  if (rulesTotal < flags.length) {
    throw new Error(
      "persistRuleCheckAudit: rules_total_in_ontology cannot be smaller than rules_evaluated",
    );
  }
  const llmModel = requireText(
    qualityRun?.model ?? merged.llm_model,
    "reasoning audit llm_model",
  );
  const llmDurationValue = integer(
    qualityRun?.durationMs ?? merged.llm_duration_ms,
  );
  if (llmDurationValue === null || llmDurationValue < 0) {
    throw new Error(
      "persistRuleCheckAudit: reasoning audit llm_duration_ms is required",
    );
  }
  const missingEvidence = strings(
    reasoning?.missingEvidence ?? merged.rule_missing_evidence,
    100,
  );
  const failureReasons = flags
    .filter((flag) => flag.next_action === "block")
    .map((flag) => `${flag.rule_id}: ${flag.reason}`);
  const ruleProvenance =
    ruleSelection?.selectedRules ??
    reasoning?.assessments ??
    flags.map((flag) => ({
      rule_id: flag.rule_id,
      rule_name: flag.rule_name,
      enforcement_level: flag.enforcement_level,
      failure_policy: flag.failure_policy,
      status: flag.status,
      reason: flag.reason,
      evidence: flag.evidence,
    }));
  const auditId = stableAuditId({
    tenant: scope.tenant,
    domain: scope.domain,
    action: scope.action,
    runId,
    uploadId,
    candidateId,
    resumeId,
    jobRequisitionId,
  });

  return {
    audit_id: auditId,
    run_id: runId,
    scenario_id:
      nullableText(reasoning?.ruleBundleId ?? merged.rule_bundle_id, 500),
    trace_id: args.correlationId,
    upload_id: uploadId,
    candidate_id: candidateId,
    resume_id: resumeId,
    job_requisition_id: jobRequisitionId,
    client_name:
      nullableText(
        jobRequisition?.client_name ??
          jobRequisition?.client_id ??
          merged.client_name ??
          merged.client_id,
        500,
      ),
    business_group: nullableText(
      jobRequisition?.business_group ?? merged.business_group,
      500,
    ),
    studio: nullableText(jobRequisition?.studio ?? merged.studio, 500),
    decision: foldedDecision,
    llm_decision: requireText(rawDecision, "rule_decision"),
    failure_reasons: failureReasons,
    llm_model: llmModel,
    llm_duration_ms: llmDurationValue,
    llm_prompt_tokens: integer(qualityRun?.tokensIn ?? merged.llm_prompt_tokens),
    llm_completion_tokens: integer(
      qualityRun?.tokensOut ?? merged.llm_completion_tokens,
    ),
    rules_evaluated: flags.length,
    rules_total_in_ontology: rulesTotal,
    rule_source: requireText(
      ruleSelection?.source ?? merged.rule_source,
      "reasoning audit rule_source",
    ),
    missing_evidence: missingEvidence,
    rule_provenance: ruleProvenance,
    parsed_resume: parsedResume ?? null,
    job_requisition: jobRequisition,
    user_prompt: nullableText(inputAudit?.userPrompt ?? merged.user_prompt),
    system_prompt: nullableText(compiledPrompt?.systemPrompt ?? merged.system_prompt),
    parent_audit_id: nullableText(merged.parent_audit_id, 500),
    llm_round_trips: nonNegativeInteger(qualityRun?.steps ?? merged.llm_round_trips),
    flags,
  };
}

function positiveTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = integer(value);
  if (parsed === null || parsed <= 0 || parsed > 120_000) {
    throw new Error(
      "persistRuleCheckAudit: config.timeout_ms must be an integer between 1 and 120000",
    );
  }
  return parsed;
}

function exactScope(args: PersistRuleCheckAuditExternalArgs): {
  tenant: string;
  domain: string;
  action: string;
} {
  const tenant = requireText(args.config.tenant, "config.tenant");
  const domain = requireText(args.config.domain, "config.domain");
  const action = requireText(args.config.action, "config.action");
  if (tenant !== args.tenantSlug) {
    throw new Error(
      `persistRuleCheckAudit: tenant scope mismatch (configured '${tenant}', runtime '${args.tenantSlug}')`,
    );
  }
  const runtimeActions = [args.ontologyActionName, args.agentName]
    .map((value) => text(value, 500))
    .filter(Boolean);
  if (!runtimeActions.includes(action)) {
    throw new Error(
      `persistRuleCheckAudit: action scope mismatch (configured '${action}')`,
    );
  }
  return { tenant, domain, action };
}

function compact<T extends JsonRecord>(value: T): JsonRecord {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined && item !== null),
  );
}

export function buildRuleCheckAuditAllmetaPayload(
  audit: RuleCheckAuditRecord,
): JsonRecord {
  return compact({
    audit_id: audit.audit_id,
    run_id: audit.run_id,
    trace_id: audit.trace_id,
    upload_id: audit.upload_id,
    candidate_id: audit.candidate_id,
    resume_id: audit.resume_id,
    job_requisition_id: audit.job_requisition_id,
    decision: audit.decision,
    llm_decision: audit.llm_decision,
    failure_reasons: safeJson(audit.failure_reasons, "failure_reasons"),
    rules_evaluated: audit.rules_evaluated,
    rules_total_in_ontology: audit.rules_total_in_ontology,
    rule_source: audit.rule_source,
    rule_provenance: safeJson(
      audit.flags.map((flag) => ({
        rule_id: flag.rule_id,
        rule_name: flag.rule_name,
        enforcement_level: flag.enforcement_level,
        failure_policy: flag.failure_policy,
        status: flag.status,
        reason: flag.reason,
        evidence: flag.evidence,
        blocking: flag.next_action === "block",
      })),
      "rule_provenance",
    ),
    llm_model: audit.llm_model,
    llm_duration_ms: audit.llm_duration_ms,
    llm_round_trips: audit.llm_round_trips,
    llm_prompt_tokens: audit.llm_prompt_tokens,
    llm_completion_tokens: audit.llm_completion_tokens,
    system_prompt: audit.system_prompt,
    user_prompt: audit.user_prompt,
    parsed_resume_json: safeJson(audit.parsed_resume, "parsed_resume"),
    job_requisition_json: safeJson(
      audit.job_requisition,
      "job_requisition",
    ),
    parent_audit_id: audit.parent_audit_id,
  });
}

interface PgClientLike {
  query(text: string, values?: unknown[]): Promise<unknown>;
  release(): void;
}

async function persistPostgres(args: {
  connectionString: string;
  timeoutMs: number;
  audit: RuleCheckAuditRecord;
}): Promise<void> {
  const pool = new Pool({
    connectionString: args.connectionString,
    max: 1,
    connectionTimeoutMillis: args.timeoutMs,
    idleTimeoutMillis: 5_000,
    application_name: "agentic-operator-rule-audit",
  });
  let client: PgClientLike | undefined;
  try {
    client = (await pool.connect()) as PgClientLike;
    await persistRuleCheckAuditWithSession(client, args.audit);
  } finally {
    client?.release();
    await pool.end();
  }
}

export async function persistRuleCheckAuditWithSession(
  session: Pick<PgClientLike, "query">,
  audit: RuleCheckAuditRecord,
): Promise<void> {
  await session.query("BEGIN");
  try {
    await session.query(
      `INSERT INTO "RuleCheckAudit" (
         audit_id, run_id, scenario_id, trace_id,
         upload_id, candidate_id, resume_id, job_requisition_id,
         client_name, business_group, studio,
         decision, llm_decision, failure_reasons, fail_reason,
         llm_model, llm_duration_ms, llm_prompt_tokens,
         llm_completion_tokens, parse_error,
         rules_evaluated, rules_total_in_ontology, rule_source,
         partial_resume_fields, filtered_out_rules, rule_provenance,
         parsed_resume_json, job_requisition_json,
         user_prompt, system_prompt, llm_raw_text,
         resume_augmentation, parent_audit_id, created_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,$15,$16,$17,
         $18,NULL,$19,$20,$21,$22,NULL,$23,$24,$25,$26,$27,NULL,NULL,$28,NOW()
       )
       ON CONFLICT (audit_id) DO UPDATE SET
         run_id = EXCLUDED.run_id,
         scenario_id = EXCLUDED.scenario_id,
         trace_id = EXCLUDED.trace_id,
         upload_id = EXCLUDED.upload_id,
         candidate_id = EXCLUDED.candidate_id,
         resume_id = EXCLUDED.resume_id,
         job_requisition_id = EXCLUDED.job_requisition_id,
         client_name = EXCLUDED.client_name,
         business_group = EXCLUDED.business_group,
         studio = EXCLUDED.studio,
         decision = EXCLUDED.decision,
         llm_decision = EXCLUDED.llm_decision,
         failure_reasons = EXCLUDED.failure_reasons,
         fail_reason = NULL,
         llm_model = EXCLUDED.llm_model,
         llm_duration_ms = EXCLUDED.llm_duration_ms,
         llm_prompt_tokens = EXCLUDED.llm_prompt_tokens,
         llm_completion_tokens = EXCLUDED.llm_completion_tokens,
         parse_error = NULL,
         rules_evaluated = EXCLUDED.rules_evaluated,
         rules_total_in_ontology = EXCLUDED.rules_total_in_ontology,
         rule_source = EXCLUDED.rule_source,
         partial_resume_fields = EXCLUDED.partial_resume_fields,
         filtered_out_rules = NULL,
         rule_provenance = EXCLUDED.rule_provenance,
         parsed_resume_json = EXCLUDED.parsed_resume_json,
         job_requisition_json = EXCLUDED.job_requisition_json,
         user_prompt = EXCLUDED.user_prompt,
         system_prompt = EXCLUDED.system_prompt,
         llm_raw_text = NULL,
         resume_augmentation = NULL,
         parent_audit_id = EXCLUDED.parent_audit_id`,
      [
        audit.audit_id,
        audit.run_id,
        audit.scenario_id,
        audit.trace_id,
        audit.upload_id,
        audit.candidate_id,
        audit.resume_id,
        audit.job_requisition_id,
        audit.client_name,
        audit.business_group,
        audit.studio,
        audit.decision,
        audit.llm_decision,
        safeJson(audit.failure_reasons, "failure_reasons") ?? "[]",
        audit.llm_model,
        audit.llm_duration_ms,
        audit.llm_prompt_tokens,
        audit.llm_completion_tokens,
        audit.rules_evaluated,
        audit.rules_total_in_ontology,
        audit.rule_source,
        safeJson(audit.missing_evidence, "missing_evidence") ?? "[]",
        safeJson(audit.rule_provenance, "rule_provenance"),
        safeJson(audit.parsed_resume, "parsed_resume"),
        safeJson(audit.job_requisition, "job_requisition"),
        audit.user_prompt,
        audit.system_prompt,
        audit.parent_audit_id,
      ],
    );
    await session.query(
      `DELETE FROM "RuleCheckFlag" WHERE audit_id = $1`,
      [audit.audit_id],
    );
    for (const flag of audit.flags) {
      await session.query(
        `INSERT INTO "RuleCheckFlag" (
           flag_id, audit_id, rule_id, rule_name_snapshot, severity,
           applicable_client, applicable, result, evidence,
           next_action, created_at
         ) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$8,$9,NOW())`,
        [
          `${audit.audit_id}::${flag.rule_id}`,
          audit.audit_id,
          flag.rule_id,
          flag.rule_name,
          flag.severity,
          flag.applicable,
          flag.result,
          safeJson(
            { reason: flag.reason, evidence: flag.evidence },
            `rule ${flag.rule_id} evidence`,
          ),
          flag.next_action,
        ],
      );
    }
    await session.query("COMMIT");
  } catch (error) {
    try {
      await session.query("ROLLBACK");
    } catch {
      // Preserve the real persistence error.
    }
    throw error;
  }
}

async function postAllmeta(args: {
  baseUrl: string;
  apiKey: string;
  domain: string;
  timeoutMs: number;
  audit: RuleCheckAuditRecord;
}): Promise<void> {
  const endpoint =
    `${args.baseUrl}/api/v1/ontology/instances/Rule_Check_Audit` +
    `?domain=${encodeURIComponent(args.domain)}&validate=strict`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        "idempotency-key": args.audit.audit_id,
      },
      body: JSON.stringify({
        ...buildRuleCheckAuditAllmetaPayload(args.audit),
        domainId: args.domain,
      }),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `persistRuleCheckAudit: Allmeta request failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `persistRuleCheckAudit: Allmeta returned HTTP ${response.status}: ${body.slice(0, 300)}`,
    );
  }
}

function trustedBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      "persistRuleCheckAudit: Allmeta base URL environment value is invalid",
    );
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(
      "persistRuleCheckAudit: Allmeta base URL must use http or https",
    );
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(
      "persistRuleCheckAudit: Allmeta base URL must not contain credentials, query, or fragment",
    );
  }
  return parsed.toString().replace(/\/+$/, "");
}

export async function persistRuleCheckAuditExternal(
  args: PersistRuleCheckAuditExternalArgs,
  adapters: RuleAuditPersistenceAdapters = {},
): Promise<{ audit: RuleCheckAuditRecord; receipt: RuleAuditPersistenceReceipt }> {
  const scope = exactScope(args);
  const env = args.env ?? process.env;
  const connectionString = readEnvironmentReference(
    env,
    args.config.postgres_url_env,
    "persistRuleCheckAudit config.postgres_url_env",
  );
  let postgresUrl: URL;
  try {
    postgresUrl = new URL(connectionString);
  } catch {
    throw new Error(
      "persistRuleCheckAudit: configured PostgreSQL URL is invalid",
    );
  }
  if (!["postgres:", "postgresql:"].includes(postgresUrl.protocol)) {
    throw new Error(
      "persistRuleCheckAudit: configured URL must use postgres or postgresql",
    );
  }
  const allmetaBaseRef = args.config.allmeta_base_url_env;
  const allmetaKeyRef = args.config.allmeta_api_key_env;
  if (Boolean(allmetaBaseRef) !== Boolean(allmetaKeyRef)) {
    throw new Error(
      "persistRuleCheckAudit: allmeta_base_url_env and allmeta_api_key_env must be configured together",
    );
  }
  const allmetaBaseRaw = readOptionalEnvironmentReference(
    env,
    allmetaBaseRef,
    "persistRuleCheckAudit config.allmeta_base_url_env",
  );
  const allmetaKey = readOptionalEnvironmentReference(
    env,
    allmetaKeyRef,
    "persistRuleCheckAudit config.allmeta_api_key_env",
  );
  const audit = buildRuleCheckAuditRecord(args, scope);
  const timeoutMs = positiveTimeout(args.config.timeout_ms);
  await (adapters.postgres ?? persistPostgres)({
    connectionString,
    timeoutMs,
    audit,
  });
  if (allmetaBaseRaw && allmetaKey) {
    await (adapters.allmeta ?? postAllmeta)({
      baseUrl: trustedBaseUrl(allmetaBaseRaw),
      apiKey: allmetaKey,
      domain: scope.domain,
      timeoutMs,
      audit,
    });
  }
  return {
    audit,
    receipt: {
      audit_id: audit.audit_id,
      decision: audit.decision,
      rules_evaluated: audit.rules_evaluated,
      postgres: "written",
      allmeta: allmetaBaseRaw ? "written" : "disabled",
      domain: scope.domain,
      action: scope.action,
    },
  };
}

export const persistRuleCheckAudit = defineTool({
  name: "persistRuleCheckAudit",
  description:
    "Fail-closed write-before-emit persistence for a completed ontology rule " +
    "evaluation. Verifies the per-rule deterministic fold, atomically upserts " +
    "RuleCheckAudit plus RuleCheckFlag evidence in configured PostgreSQL, and " +
    "optionally mirrors Rule_Check_Audit through Allmeta's strict HTTP instance API. " +
    "Trusted config pins tenant/domain/action and environment references.",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const result = await persistRuleCheckAuditExternal({
      tenantSlug: ctx.tenantSlug,
      ontologyActionName: ctx.ontologyActionName,
      agentName: ctx.agentName,
      correlationId: ctx.correlationId,
      runId: ctx.runId,
      eventData: ctx.event?.data,
      lastResult: ctx.lastResult,
      results: ctx.results,
      config: ctx.config ?? {},
    });
    const previous = record(ctx.lastResult) ?? {};
    return {
      data: {
        ...previous,
        audit_id: result.audit.audit_id,
        audit: {
          audit_id: result.audit.audit_id,
          decision: result.audit.decision,
          rules_evaluated: result.audit.rules_evaluated,
          rules_total_in_ontology: result.audit.rules_total_in_ontology,
          rule_source: result.audit.rule_source,
          llm_model: result.audit.llm_model,
          fail_reason: null,
        },
        rule_check_result:
          result.audit.decision === "PASS" ? "通过" : "未通过",
        rule_check_reason: result.audit.failure_reasons.join("; "),
        rule_check_rules: result.audit.flags,
        _rule_audit_persistence: result.receipt,
      },
    };
  },
});
