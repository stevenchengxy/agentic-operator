import { z } from "zod";

export const runtimeStatusSchema = z.enum([
  "completed",
  "warning",
  "blocked",
  "running",
  "waiting",
]);
export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>;

export const reasoningHarnessPlanSchema = z.object({
  version: z.literal("reasoning-harness/v2"),
  methods: z.array(
    z.enum([
      "graph_react",
      "evidence_grounding",
      "temporal_constraint",
      "rule_by_rule_verification",
    ]),
  ),
  capabilityAnchors: z.array(z.string()),
  objectAnchors: z.array(z.string()),
  evidenceAnchors: z.array(
    z.object({
      objectType: z.string(),
      evidencePaths: z.array(z.string()),
      purpose: z.string(),
    }),
  ),
  stopConditions: z.array(z.string()),
  publicRationale: z.string(),
});
export type ReasoningHarnessPlan = z.infer<typeof reasoningHarnessPlanSchema>;

const ruleLinkEndpointSchema = z.object({
  type: z.string(),
  id: z.string(),
  displayName: z.string(),
});

/** Legacy result receipts did not guarantee stable link metadata. */
export const legacyRuleLinkTripleSchema = z.object({
  linkId: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  confidence: z.number().nullable().default(null),
  subject: ruleLinkEndpointSchema,
  predicate: z.string(),
  object: ruleLinkEndpointSchema,
  semanticRelationship: z.string(),
  evidence: z.array(z.unknown()),
});
export const ruleLinkTripleSchema = legacyRuleLinkTripleSchema;
export type RuleLinkTriple = z.infer<typeof ruleLinkTripleSchema>;

/** v2 receipts are independently auditable only when the link is identifiable. */
export const ruleLinkTripleV2Schema = legacyRuleLinkTripleSchema.extend({
  linkId: z.string().trim().min(1),
  status: z.string().trim().min(1),
  confidence: z.number().min(0).max(1),
});

export const ruleQueryExecutionSchema = z.object({
  purpose: z
    .enum(["semantic-rule-selection", "mandatory-link-coverage"])
    .default("semantic-rule-selection"),
  language: z.literal("cypher"),
  query: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  fingerprint: z.string(),
  readOnly: z.literal(true),
  domainLocked: z.literal(true),
  linkOnly: z.literal(true),
  fallbackUsed: z.literal(false),
  durationMs: z.number().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  pathPattern: z.string(),
});
export type RuleQueryExecution = z.infer<typeof ruleQueryExecutionSchema>;

const ruleQueryExecutionV2Schema = ruleQueryExecutionSchema.extend({
  purpose: z.enum(["semantic-rule-selection", "mandatory-link-coverage"]),
});

const ruleQueryExecutionsV2Schema = z
  .array(ruleQueryExecutionV2Schema)
  .length(2)
  .superRefine((executions, context) => {
    const purposes = new Set(executions.map((execution) => execution.purpose));
    if (
      !purposes.has("semantic-rule-selection") ||
      !purposes.has("mandatory-link-coverage")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "v2 requires one semantic-rule-selection and one mandatory-link-coverage execution",
      });
    }
  });

export const assessmentStatusSchema = z.enum([
  "satisfied",
  "violated",
  "optional_unmet",
  "not_applicable",
  "insufficient_evidence",
]);
export type AssessmentStatus = z.infer<typeof assessmentStatusSchema>;

export const runtimeAgentSchema = z.object({
  id: z.string(),
  label: z.string(),
  status: runtimeStatusSchema,
  detail: z.string(),
});
export type RuntimeAgent = z.infer<typeof runtimeAgentSchema>;

const ruleAssessmentSchema = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  enforcementLevel: z.enum(["mandatory", "optional"]),
  failurePolicy: z.enum(["block", "warn"]),
  status: assessmentStatusSchema,
  reason: z.string(),
  evidence: z.array(z.string()),
});
export type RuleAssessment = z.infer<typeof ruleAssessmentSchema>;

export const retrievedRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  logic: z.string(),
  submissionCriteria: z.string(),
  businessReason: z.string(),
  enforcementLevel: z.enum(["mandatory", "optional"]),
  failurePolicy: z.enum(["block", "warn"]),
  executor: z.string(),
  applicableClient: z.string(),
  applicableDepartment: z.string(),
  relatedEntities: z.array(z.string()),
  relatedObjectTypes: z.array(z.string()),
  linkedActions: z.array(z.string()),
  applicabilityScope: z
    .enum(["csi_universal", "client_general", "client_department"])
    .optional(),
  selectionScore: z.number(),
  matchReasons: z.array(z.string()),
  linkPaths: z.array(ruleLinkTripleSchema).default([]),
  matchedAnchors: z.array(z.string()).default([]),
  scopeReason: z.string().default(""),
});
export type RetrievedRule = z.infer<typeof retrievedRuleSchema>;

const retrievedRuleV2Schema = retrievedRuleSchema.extend({
  applicabilityScope: z.enum([
    "csi_universal",
    "client_general",
    "client_department",
  ]),
  linkPaths: z.array(ruleLinkTripleV2Schema),
});

const queryIrV2Schema = z.object({
  version: z.literal("rule-link-query-ir/v2"),
  domainId: z.string(),
  actionHint: z.string(),
  query: z.string(),
  intentTerms: z.array(z.string()),
  capabilityAnchors: z.array(z.string()),
  objectAnchors: z.array(z.string()),
  evidenceAnchors: reasoningHarnessPlanSchema.shape.evidenceAnchors,
  strongKeywords: z.array(z.string()),
  keywords: z.array(z.string()),
  objectTypes: z.array(z.string()),
  applicableClient: z.string(),
  applicableDepartment: z.string(),
  executor: z.string(),
  enforcementLevels: z.tuple([z.literal("mandatory"), z.literal("optional")]),
  allowedRelationships: z.tuple([
    z.literal("SCOPED_TO"),
    z.literal("GOVERNS"),
    z.literal("APPLIES_TO"),
    z.literal("RELEVANT_TO"),
  ]),
  maxHops: z.literal(2),
  limit: z.number().int(),
});

const legacyQueryIrSchema = z
  .object({
    domainId: z.string(),
    action: z.string(),
    query: z.string(),
    strongKeywords: z.array(z.string()),
    keywords: z.array(z.string()),
    objectTypes: z.array(z.string()),
    applicableClient: z.string(),
    applicableDepartment: z.string(),
    executor: z.string(),
    enforcementLevels: z.tuple([z.literal("mandatory"), z.literal("optional")]),
    limit: z.number().int(),
  })
  .transform((query) => ({
    version: "rule-link-query-ir/v2" as const,
    domainId: query.domainId,
    actionHint: query.action,
    query: query.query,
    intentTerms: query.keywords,
    capabilityAnchors: query.strongKeywords,
    objectAnchors: query.objectTypes,
    evidenceAnchors: [],
    strongKeywords: query.strongKeywords,
    keywords: query.keywords,
    objectTypes: query.objectTypes,
    applicableClient: query.applicableClient,
    applicableDepartment: query.applicableDepartment,
    executor: query.executor,
    enforcementLevels: query.enforcementLevels,
    allowedRelationships: [
      "SCOPED_TO",
      "GOVERNS",
      "APPLIES_TO",
      "RELEVANT_TO",
    ] as ["SCOPED_TO", "GOVERNS", "APPLIES_TO", "RELEVANT_TO"],
    maxHops: 2 as const,
    limit: query.limit,
  }));

export const queryIrSchema = z.union([queryIrV2Schema, legacyQueryIrSchema]);
export type RuleSelectionQueryIr = z.infer<typeof queryIrSchema>;

const compilerVersionV2Schema = z.enum(["v2", "qualified-rule-check/v2"]);
const compilerVersionV3Schema = z.enum(["v3", "qualified-rule-check/v3"]);
const compilerVersionSchema = z.union([
  compilerVersionV2Schema,
  compilerVersionV3Schema,
]);

const compiledPromptBaseSchema = z.object({
  compilerId: z.string(),
  promptSha256: z.string().optional(),
  scenario: z.string(),
  ruleIds: z.array(z.string()),
  evidenceKeys: z.array(z.string()),
  harnessPlan: reasoningHarnessPlanSchema.optional(),
  semanticLinkCount: z.number().int().nonnegative().optional(),
  evidencePlan: z
    .array(
      z.object({
        ruleId: z.string(),
        relevance: z.enum(["direct", "scope_only", "no_direct_signal"]),
        summary: z.string(),
        evidence: z.array(
          z.object({
            path: z.string(),
            actualValue: z.string().nullable(),
            verified: z.boolean(),
          }),
        ),
      }),
    )
    .optional(),
  systemPrompt: z.string(),
  userPrompt: z.string(),
});

export const compiledPromptSchema = z.union([
  compiledPromptBaseSchema.extend({
    compilerVersion: compilerVersionV2Schema,
    fullSemanticPathsSha256: z.string().optional(),
  }),
  compiledPromptBaseSchema.extend({
    compilerVersion: compilerVersionV3Schema,
    fullSemanticPathsSha256: z.string().trim().min(1),
  }),
]);
export type CompiledPrompt = z.infer<typeof compiledPromptSchema>;

const compiledPromptV2Schema = z.union([
  compiledPromptBaseSchema.extend({
    compilerVersion: compilerVersionV2Schema,
    promptSha256: z.string().trim().min(1),
    fullSemanticPathsSha256: z.string().optional(),
  }),
  compiledPromptBaseSchema.extend({
    compilerVersion: compilerVersionV3Schema,
    promptSha256: z.string().trim().min(1),
    fullSemanticPathsSha256: z.string().trim().min(1),
  }),
]);

export const qualifiedAgentRunReceiptSchema = z.object({
  role: z.literal("qualified"),
  executionMode: z.literal("isolated-child-run"),
  runId: z.string(),
  parentRunId: z.string(),
  correlationId: z.string(),
  compilerId: z.string(),
  promptSha256: z.string(),
  ruleBundleId: z.string(),
  provider: z.string(),
  model: z.string(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  durationMs: z.number().nonnegative(),
  steps: z.number().int().nonnegative(),
  assessmentCount: z.number().int().nonnegative(),
});
export type QualifiedAgentRunReceipt = z.infer<
  typeof qualifiedAgentRunReceiptSchema
>;

const qualificationCompilerReceiptBaseSchema = z.object({
  compilerId: z.string(),
  promptSha256: z.string().trim().min(1),
});

export const qualificationCompilerReceiptSchema = z.union([
  qualificationCompilerReceiptBaseSchema.extend({
    compilerVersion: compilerVersionV2Schema,
    fullSemanticPathsSha256: z.string().optional(),
  }),
  qualificationCompilerReceiptBaseSchema.extend({
    compilerVersion: compilerVersionV3Schema,
    fullSemanticPathsSha256: z.string().trim().min(1),
  }),
]);
export type QualificationCompilerReceipt = z.infer<
  typeof qualificationCompilerReceiptSchema
>;

export const compactQualificationToolDataSchema = z.object({
  compilerReceipt: qualificationCompilerReceiptSchema,
  ruleCount: z.number().int().nonnegative(),
  qualifiedRun: qualifiedAgentRunReceiptSchema,
  assessmentCount: z.number().int().nonnegative(),
});
export type CompactQualificationToolData = z.infer<
  typeof compactQualificationToolDataSchema
>;

export const evidenceAnalysisSchema = z.object({
  agent: z.literal("Intent Reasoner"),
  mode: z.literal("llm-proposed/evidence-path-verified"),
  facts: z.array(
    z.object({
      category: z.enum([
        "candidate",
        "target_job",
        "employment_history",
        "qualification",
        "risk_signal",
        "other",
      ]),
      purpose: z.enum(["scope_selection", "rule_evaluation", "context"]),
      label: z.string(),
      value: z.string().nullable(),
      evidencePath: z.string(),
      relevance: z.string(),
      verified: z.boolean(),
    }),
  ),
  verifiedCount: z.number().int().nonnegative(),
  unverifiedCount: z.number().int().nonnegative(),
  temporalFacts: z.array(
    z.object({
      path: z.string(),
      value: z.string(),
      relationToAsOf: z.enum(["before", "same_day", "after"]),
      calendarDays: z.number(),
      completedCalendarMonths: z.number(),
    }),
  ),
  ruleEvidencePlan: compiledPromptBaseSchema.shape.evidencePlan
    .unwrap()
    .default([]),
});
export type EvidenceAnalysis = z.infer<typeof evidenceAnalysisSchema>;

const targetScopeSourceSchema = z.enum([
  "job_requisition",
  "jd",
  "explicit_fallback",
  "generic_inputs_fallback",
  "missing",
  "legacy_unknown",
]);

const targetScopeConflictSchema = z.object({
  field: z.enum(["client", "department"]),
  selectedValue: z.string(),
  selectedSource: targetScopeSourceSchema,
  ignoredValue: z.string(),
  ignoredSource: targetScopeSourceSchema,
});

const queryAgentAuditSchema = z.object({
  selectionStrategy: z.enum([
    "semantic-link-traversal",
    "action-binding-first",
    "semantic-fallback-no-action-binding",
  ]),
  modelRationale: z.string(),
  harnessPlan: reasoningHarnessPlanSchema.optional(),
  queryExecution: ruleQueryExecutionSchema.optional(),
  queryExecutions: z.array(ruleQueryExecutionSchema).optional(),
  filters: z.object({
    actionHint: z.string().optional(),
    action: z.string().optional(),
    client: z.string(),
    department: z.string(),
    clientSource: targetScopeSourceSchema.optional(),
    departmentSource: targetScopeSourceSchema.optional(),
    scopeConflicts: z.array(targetScopeConflictSchema).optional(),
    objectTypes: z.array(z.string()),
    keywords: z.array(z.string()),
    executor: z.string(),
    enforcementLevels: z.tuple([z.literal("mandatory"), z.literal("optional")]),
    includeCsiUniversal: z.literal(true),
    includeClientGeneral: z.boolean(),
    includeClientDepartment: z.boolean(),
    stageUsed: z.literal(false).optional(),
  }),
});
export type QueryAgentAudit = z.infer<typeof queryAgentAuditSchema>;

const semanticRuleQueryExecutionV2Schema = ruleQueryExecutionV2Schema.extend({
  purpose: z.literal("semantic-rule-selection"),
});

const queryAgentAuditV2Schema = queryAgentAuditSchema.extend({
  selectionStrategy: z.literal("semantic-link-traversal"),
  harnessPlan: reasoningHarnessPlanSchema,
  queryExecution: semanticRuleQueryExecutionV2Schema,
  queryExecutions: ruleQueryExecutionsV2Schema,
});

export const ruleSelectionToolOutputSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    bundleId: z.string(),
    domainId: z.string(),
    action: z.string(),
    scenario: z.string(),
    fetchedAt: z.string(),
    queryIr: queryIrSchema,
    rules: z.array(retrievedRuleSchema),
    selectionBasis: z.literal("semantic-links").optional(),
    harnessPlan: reasoningHarnessPlanSchema.optional(),
    queryExecution: ruleQueryExecutionSchema.optional(),
    queryExecutions: z.array(ruleQueryExecutionSchema).optional(),
    mandatoryCount: z.number().int().nonnegative(),
    optionalCount: z.number().int().nonnegative(),
    auditInput: z
      .object({
        userPrompt: z.string(),
        evidence: z.record(z.string(), z.unknown()),
        evidenceKeys: z.array(z.string()),
      })
      .optional(),
    evidenceAnalysis: evidenceAnalysisSchema.optional(),
    queryAgent: z.object({
      mode: z.enum([
        "generated-cypher/semantic-link-selection",
        "compiled-cypher/universal-rule-selection",
      ]),
      readOnly: z.literal(true),
      domainLocked: z.literal(true),
      linkOnly: z.literal(true).optional(),
      fallbackUsed: z.literal(false).optional(),
      stageIndependent: z.literal(true).optional(),
      rationale: z.string(),
      selectionStrategy:
        queryAgentAuditSchema.shape.selectionStrategy.optional(),
      modelRationale: z.string().optional(),
      harnessPlan: reasoningHarnessPlanSchema.optional(),
      queryExecution: ruleQueryExecutionSchema.optional(),
      queryExecutions: z.array(ruleQueryExecutionSchema).optional(),
      filters: queryAgentAuditSchema.shape.filters.optional(),
      diagnostics: z.record(z.string(), z.unknown()).nullable(),
    }),
  }),
});
export type RuleSelectionToolData = z.infer<
  typeof ruleSelectionToolOutputSchema
>["data"];

export const compiledPromptToolOutputSchema = z.object({
  ok: z.literal(true),
  data: z.union([
    compactQualificationToolDataSchema,
    compiledPromptSchema.and(
      z.object({
        qualifiedRun: qualifiedAgentRunReceiptSchema.optional(),
        assessmentCount: z.number().int().nonnegative().optional(),
      }),
    ),
  ]),
});

const traceEntrySchema = z.object({
  sequence: z.number().int(),
  agentId: z.enum(["reasoning", "query", "compiler", "qualified", "fold"]),
  event: z.string(),
  status: z.enum(["completed", "warning", "blocked"]),
  at: z.string(),
  durationMs: z.number().nullable(),
  summary: z.string(),
});

export const reasoningOutputSchema = z.object({
  intentSummary: z.string(),
  strategy: z.string(),
  answerSummary: z.string(),
  decision: z.enum([
    "eligible",
    "eligible_with_flags",
    "ineligible",
    "review_required",
  ]),
  domainId: z.string(),
  action: z.string(),
  scenario: z.string(),
  ruleBundleId: z.string(),
  ruleCount: z.number().int().nonnegative(),
  queryIr: queryIrSchema,
  harnessPlan: reasoningHarnessPlanSchema.optional(),
  promptCompiler: z.object({
    compilerId: z.string(),
    compilerVersion: compilerVersionSchema,
    evidenceKeys: z.array(z.string()),
  }),
  assessments: z.array(ruleAssessmentSchema),
  flags: z.array(z.string()),
  missingEvidence: z.array(z.string()),
  audit: z.object({
    visibility: z.literal("auditable_reasoning_summary"),
    hiddenChainOfThoughtExposed: z.literal(false),
    input: z.object({
      userPrompt: z.string(),
      evidence: z.record(z.string(), z.unknown()),
      evidenceKeys: z.array(z.string()),
    }),
    evidenceAnalysis: evidenceAnalysisSchema.optional(),
    harnessPlan: reasoningHarnessPlanSchema.optional(),
    ruleSelection: z.object({
      source: z.literal("allmeta"),
      mode: z.enum([
        "generated-cypher/semantic-link-selection",
        "compiled-cypher/universal-rule-selection",
      ]),
      selectionBasis: z.literal("semantic-links").optional(),
      cypherTemplateId: z.literal("allmeta.rule-selection/v1").optional(),
      queryFingerprint: z.string(),
      readOnly: z.literal(true),
      domainLocked: z.literal(true),
      linkOnly: z.literal(true).optional(),
      fallbackUsed: z.literal(false).optional(),
      stageIndependent: z.literal(true).optional(),
      queryExecution: ruleQueryExecutionSchema.optional(),
      queryExecutions: z.array(ruleQueryExecutionSchema).optional(),
      fetchedAt: z.string(),
      mandatoryCount: z.number().int().nonnegative(),
      optionalCount: z.number().int().nonnegative(),
      diagnostics: z.record(z.string(), z.unknown()).nullable(),
      queryAgent: queryAgentAuditSchema.optional(),
      selectedRules: z.array(retrievedRuleSchema),
    }),
    compiledPrompt: compiledPromptSchema,
    qualityCheck: z.object({
      agent: z.literal("QualifiedAgent"),
      executionMode: z
        .enum(["isolated-child-run", "inline-reasoning-agent"])
        .optional(),
      run: qualifiedAgentRunReceiptSchema.optional(),
      assessmentCount: z.number().int().nonnegative(),
      statusCounts: z.object({
        satisfied: z.number().int().nonnegative(),
        violated: z.number().int().nonnegative(),
        optional_unmet: z.number().int().nonnegative(),
        not_applicable: z.number().int().nonnegative(),
        insufficient_evidence: z.number().int().nonnegative(),
      }),
      mandatoryBlocked: z.number().int().nonnegative(),
      mandatoryPending: z.number().int().nonnegative(),
      optionalFlagged: z.number().int().nonnegative(),
    }),
    trace: z.array(traceEntrySchema),
  }),
  runtime: z.object({
    agents: z.array(runtimeAgentSchema),
    edges: z.array(z.object({ from: z.string(), to: z.string() })),
  }),
});

export type ReasoningOutput = z.infer<typeof reasoningOutputSchema>;

const reasoningRuleSelectionV2Schema =
  reasoningOutputSchema.shape.audit.shape.ruleSelection.extend({
    mode: z.literal("generated-cypher/semantic-link-selection"),
    selectionBasis: z.literal("semantic-links"),
    linkOnly: z.literal(true),
    fallbackUsed: z.literal(false),
    queryExecution: semanticRuleQueryExecutionV2Schema,
    queryExecutions: ruleQueryExecutionsV2Schema,
    queryAgent: queryAgentAuditV2Schema,
    selectedRules: z.array(retrievedRuleV2Schema),
  });

const reasoningQualityCheckV2Schema =
  reasoningOutputSchema.shape.audit.shape.qualityCheck.extend({
    executionMode: z.literal("isolated-child-run"),
    run: qualifiedAgentRunReceiptSchema,
  });

const reasoningAuditV2Schema = reasoningOutputSchema.shape.audit.extend({
  harnessPlan: reasoningHarnessPlanSchema,
  ruleSelection: reasoningRuleSelectionV2Schema,
  compiledPrompt: compiledPromptV2Schema,
  qualityCheck: reasoningQualityCheckV2Schema,
});

/**
 * The persisted v2 envelope is intentionally fail-closed. Compatibility
 * defaults remain available only through the v1 parser above.
 */
export const reasoningOutputV2Schema = reasoningOutputSchema
  .extend({
    queryIr: queryIrV2Schema,
    harnessPlan: reasoningHarnessPlanSchema,
    audit: reasoningAuditV2Schema,
  })
  .superRefine((output, context) => {
    const selection = output.audit.ruleSelection;
    const selectedExecution = selection.queryExecutions.find(
      (execution) => execution.purpose === "semantic-rule-selection",
    );
    if (
      selectedExecution?.fingerprint !== selection.queryExecution.fingerprint
    ) {
      context.addIssue({
        code: "custom",
        path: ["audit", "ruleSelection", "queryExecution", "fingerprint"],
        message:
          "v2 compatibility queryExecution must match semantic-rule-selection",
      });
    }
    if (
      output.audit.compiledPrompt.promptSha256 !==
      output.audit.qualityCheck.run.promptSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["audit", "qualityCheck", "run", "promptSha256"],
        message:
          "v2 QualifiedAgent receipt must match the compiled prompt hash",
      });
    }
  });

export type ReasoningResultSchemaVersion =
  | "reasoning-result/v1"
  | "reasoning-result/v2";

export function parseReasoningOutput(
  value: unknown,
  schemaVersion: string | null = "reasoning-result/v1",
): ReasoningOutput {
  if (
    schemaVersion !== "reasoning-result/v1" &&
    schemaVersion !== "reasoning-result/v2" &&
    schemaVersion !== null
  ) {
    throw new Error(`Unsupported reasoning result schema: ${schemaVersion}`);
  }
  const parsed =
    schemaVersion === "reasoning-result/v2"
      ? reasoningOutputV2Schema.safeParse(value)
      : reasoningOutputSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `Agent returned an invalid ${schemaVersion ?? "legacy/unversioned"} reasoning output envelope: ${parsed.error.issues[0]?.path.join(".") || "root"} ${parsed.error.issues[0]?.message ?? "unknown schema error"}`,
    );
  }
  return parsed.data;
}
