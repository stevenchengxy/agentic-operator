import { z } from "zod";
import {
  AgentDefinitionV2Schema,
  AgentPromptProvenanceV2Schema,
  JsonSchemaSchema,
} from "./agent-definition";
import { AgentKindEnum, ActorEnum } from "./agents";
import {
  ProviderIdSchema,
  ReasoningConfigSchema,
  TextVerbositySchema,
} from "./llm";
import { RunStatus } from "./runs";

export const AgentLifecycleSchema = z.enum(["draft", "active", "archived"]);
export type AgentLifecycle = z.infer<typeof AgentLifecycleSchema>;

export const AgentValidationStatusSchema = z.enum([
  "unvalidated",
  "valid",
  "invalid",
  "stale",
]);
export type AgentValidationStatus = z.infer<typeof AgentValidationStatusSchema>;

export const AgentValidationIssueSchema = z.object({
  path: z.string(),
  code: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string(),
  suggestion: z.string().optional(),
});
export type AgentValidationIssue = z.infer<typeof AgentValidationIssueSchema>;

export const AgentValidationResultSchema = z.object({
  status: z.enum(["valid", "invalid"]),
  definitionHash: z.string(),
  issues: z.array(AgentValidationIssueSchema),
  validatedAt: z.coerce.date(),
});
export type AgentValidationResult = z.infer<typeof AgentValidationResultSchema>;

export const AgentDraftSummarySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  workflowId: z.string(),
  agentId: z.string(),
  baseAgentVersionId: z.string().nullable(),
  baseWorkflowVersionId: z.string().nullable(),
  definitionHash: z.string(),
  schemaVersion: z.literal(2),
  revision: z.number().int().positive(),
  validationStatus: AgentValidationStatusSchema,
  validatedHash: z.string().nullable(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});
export type AgentDraftSummary = z.infer<typeof AgentDraftSummarySchema>;

export const AgentDraftRecordSchema = AgentDraftSummarySchema.extend({
  definition: AgentDefinitionV2Schema,
  validation: z.object({
    status: AgentValidationStatusSchema,
    validatedHash: z.string().nullable(),
    issues: z.array(AgentValidationIssueSchema),
  }),
});
export type AgentDraftRecord = z.infer<typeof AgentDraftRecordSchema>;

export const AgentDraftRevisionReasonSchema = z.enum([
  "run",
  "checkpoint",
  "publish",
]);
export type AgentDraftRevisionReason = z.infer<
  typeof AgentDraftRevisionReasonSchema
>;

export const AgentDraftRevisionSchema = z.object({
  id: z.string(),
  draftId: z.string(),
  revision: z.number().int().positive(),
  definition: AgentDefinitionV2Schema,
  definitionHash: z.string(),
  schemaVersion: z.literal(2),
  reason: AgentDraftRevisionReasonSchema,
  createdBy: z.string().nullable(),
  createdAt: z.coerce.date(),
});
export type AgentDraftRevision = z.infer<typeof AgentDraftRevisionSchema>;

export const CreateAgentDraftBodySchema = z.object({
  definition: AgentDefinitionV2Schema.optional(),
  baseAgentVersionId: z.string().optional(),
  baseWorkflowVersionId: z.string().optional(),
});
export type CreateAgentDraftBody = z.infer<typeof CreateAgentDraftBodySchema>;

export const PatchAgentDraftBodySchema = z.object({
  definition: AgentDefinitionV2Schema,
});
export type PatchAgentDraftBody = z.infer<typeof PatchAgentDraftBodySchema>;

export const AgentDraftResponseSchema = z.object({
  draft: AgentDraftRecordSchema,
  etag: z.string(),
});
export type AgentDraftResponse = z.infer<typeof AgentDraftResponseSchema>;

export const DeleteAgentDraftResponseSchema = z.object({
  draftId: z.string(),
  deleted: z.literal(true),
});
export type DeleteAgentDraftResponse = z.infer<
  typeof DeleteAgentDraftResponseSchema
>;

export const ValidateAgentDraftResponseSchema = z.object({
  draft: AgentDraftSummarySchema,
  validation: AgentValidationResultSchema,
});
export type ValidateAgentDraftResponse = z.infer<
  typeof ValidateAgentDraftResponseSchema
>;

export const GenerateDraftInstructionsBodySchema = z.object({
  mode: z.enum(["generate", "improve", "shorten", "add_guardrails"]),
  instructions: z
    .string()
    .max(128 * 1024)
    .optional(),
  selectedText: z
    .string()
    .max(128 * 1024)
    .optional(),
  provider: ProviderIdSchema.optional(),
  model: z.string().trim().min(1).max(240).optional(),
});
export type GenerateDraftInstructionsBody = z.infer<
  typeof GenerateDraftInstructionsBodySchema
>;

export const GenerateDraftInstructionsResponseSchema = z.object({
  proposedInstructions: z
    .string()
    .min(1)
    .max(128 * 1024),
  explanation: z
    .string()
    .max(16 * 1024)
    .optional(),
  provenance: AgentPromptProvenanceV2Schema,
});
export type GenerateDraftInstructionsResponse = z.infer<
  typeof GenerateDraftInstructionsResponseSchema
>;

export const PublishAgentDraftBodySchema = z.object({
  note: z.string().trim().max(500).optional(),
  confirmImpact: z.boolean().default(false),
});
export type PublishAgentDraftBody = z.infer<typeof PublishAgentDraftBodySchema>;

export const PublishAgentDraftResponseSchema = z.object({
  workflowVersionId: z.string(),
  agentVersionId: z.string(),
  deploymentId: z.string(),
  version: z.string(),
  draftRevisionId: z.string(),
  definitionHash: z.string(),
  runtime: z.object({
    functionId: z.string(),
    registered: z.boolean(),
  }),
});
export type PublishAgentDraftResponse = z.infer<
  typeof PublishAgentDraftResponseSchema
>;

const AgentEditorIdentitySchema = z.object({
  id: z.string(),
  kebabId: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  actor: ActorEnum,
  kind: AgentKindEnum,
  enabled: z.boolean(),
  lifecycle: AgentLifecycleSchema,
});

export const AgentEditorResponseSchema = z.object({
  agent: AgentEditorIdentitySchema,
  live: z
    .object({
      agentVersionId: z.string(),
      workflowVersionId: z.string(),
      version: z.string(),
      definition: AgentDefinitionV2Schema,
      definitionHash: z.string(),
      publishedAt: z.coerce.date().nullable(),
    })
    .nullable(),
  draft: AgentDraftRecordSchema.nullable(),
  capabilities: z.object({
    canEdit: z.boolean(),
    canRun: z.boolean(),
    canPublish: z.boolean(),
  }),
});
export type AgentEditorResponse = z.infer<typeof AgentEditorResponseSchema>;

export const AgentVersionSummarySchema = z.object({
  id: z.string(),
  agentId: z.string(),
  workflowVersionId: z.string(),
  workflowVersion: z.string(),
  definitionHash: z.string().nullable(),
  schemaVersion: z.number().int().positive(),
  changeNote: z.string().nullable(),
  createdBy: z.string().nullable(),
  publishedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  live: z.boolean(),
});
export type AgentVersionSummary = z.infer<typeof AgentVersionSummarySchema>;

export const AgentVersionDetailSchema = AgentVersionSummarySchema.extend({
  definition: AgentDefinitionV2Schema,
});
export type AgentVersionDetail = z.infer<typeof AgentVersionDetailSchema>;

export const ListAgentVersionsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(30),
});
export type ListAgentVersionsQuery = z.infer<
  typeof ListAgentVersionsQuerySchema
>;

export const ListAgentVersionsResponseSchema = z.object({
  versions: z.array(AgentVersionSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ListAgentVersionsResponse = z.infer<
  typeof ListAgentVersionsResponseSchema
>;

export const GetAgentVersionResponseSchema = z.object({
  version: AgentVersionDetailSchema,
});
export type GetAgentVersionResponse = z.infer<
  typeof GetAgentVersionResponseSchema
>;

export const AgentVersionDiffQuerySchema = z.object({
  from: z.string(),
  to: z.string(),
});
export type AgentVersionDiffQuery = z.infer<typeof AgentVersionDiffQuerySchema>;

export const AgentDefinitionDiffEntrySchema = z.object({
  path: z.string(),
  kind: z.enum(["added", "removed", "changed"]),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type AgentDefinitionDiffEntry = z.infer<
  typeof AgentDefinitionDiffEntrySchema
>;

export const AgentVersionDiffResponseSchema = z.object({
  from: z.string(),
  to: z.string(),
  changes: z.array(AgentDefinitionDiffEntrySchema),
});
export type AgentVersionDiffResponse = z.infer<
  typeof AgentVersionDiffResponseSchema
>;

export const RestoreAgentVersionBodySchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type RestoreAgentVersionBody = z.infer<
  typeof RestoreAgentVersionBodySchema
>;

export const RestoreAgentVersionResponseSchema = AgentDraftResponseSchema;
export type RestoreAgentVersionResponse = z.infer<
  typeof RestoreAgentVersionResponseSchema
>;

export const StudioRunTargetSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("draft"),
    draftId: z.string(),
    revision: z.number().int().positive().optional(),
  }),
  z.object({
    kind: z.literal("live"),
    agentVersionId: z.string().optional(),
  }),
]);
export type StudioRunTarget = z.infer<typeof StudioRunTargetSchema>;

export const StudioToolPolicySchema = z.enum(["safe", "simulate", "live"]);
export type StudioToolPolicy = z.infer<typeof StudioToolPolicySchema>;

export const StudioContextModeSchema = z.enum(["isolated", "session"]);
export type StudioContextMode = z.infer<typeof StudioContextModeSchema>;

/**
 * Test Lab uses a private control event to execute pinned draft/live
 * definitions, but the durable payload carries the authored trigger name so
 * the agent observes the same event identity it would receive in production.
 */
export const STUDIO_AGENT_RUN_CONTROL_EVENT = "studio/agent.run" as const;
export const STUDIO_CHAT_MESSAGE_EVENT = "STUDIO_CHAT_MESSAGE" as const;

export const StudioConversationTurnSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string(),
});
export type StudioConversationTurn = z.infer<
  typeof StudioConversationTurnSchema
>;

export const StudioRuntimeOverridesSchema = z.object({
  provider: ProviderIdSchema.optional(),
  model: z.string().trim().min(1).max(240).optional(),
  reasoning: ReasoningConfigSchema.optional(),
  verbosity: TextVerbositySchema.optional(),
  store: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(1_000_000).optional(),
  timeoutS: z.number().int().positive().max(86_400).optional(),
});
export type StudioRuntimeOverrides = z.infer<
  typeof StudioRuntimeOverridesSchema
>;

export const CreateAgentRunBodySchema = z.object({
  sessionId: z.string().optional(),
  contextMode: StudioContextModeSchema.default("isolated"),
  target: StudioRunTargetSchema,
  /** Optional authored trigger to simulate; defaults to the first trigger. */
  triggerEvent: z.string().trim().min(1).max(160).optional(),
  prompt: z
    .string()
    .min(1)
    .max(128 * 1024),
  inputs: z.record(z.string(), z.unknown()).default({}),
  toolPolicy: StudioToolPolicySchema.default("safe"),
  runtimeOverrides: StudioRuntimeOverridesSchema.optional(),
});
export type CreateAgentRunBody = z.infer<typeof CreateAgentRunBodySchema>;

export const CreateAgentRunResponseSchema = z.object({
  runId: z.string(),
  sessionId: z.string(),
  /** Locally persisted trigger event that dispatched this reserved run. */
  eventId: z.string(),
  /** Authored bare trigger name, or STUDIO_CHAT_MESSAGE when none is declared. */
  eventName: z.string(),
  status: z.literal("queued"),
  definitionHash: z.string(),
  traceUrl: z.string(),
  outputUrl: z.string(),
});
export type CreateAgentRunResponse = z.infer<
  typeof CreateAgentRunResponseSchema
>;

/**
 * The authored trigger as observed by the agent and stored in the event
 * ledger. Studio dispatch metadata (tenant ids, definition hashes, tool
 * policy, conversation history, etc.) intentionally does not belong here.
 *
 * Snake-case identity aliases are included for compatibility with generated
 * workflow prompts that consume event payloads as JSON. Runtime identity and
 * chat fields are server-owned; authored `request_id` and `context` values are
 * retained when supplied. Arbitrary non-reserved fields from an authored
 * `payload` input pass through the catch-all portion of the schema.
 */
export const StudioLogicalTriggerPayloadSchema = z
  .object({
    event_type: z.string().trim().min(1).max(160),
    event_name: z.string().trim().min(1).max(160),
    event_id: z.string().min(1),
    request_id: z.string().min(1),
    run_id: z.string().min(1),
    session_id: z.string().min(1),
    correlation_id: z.string().min(1),
    prompt: z
      .string()
      .min(1)
      .max(128 * 1024),
    input: z
      .string()
      .min(1)
      .max(128 * 1024),
    /** Authored structured context, or the exact chat prompt when omitted. */
    context: z.unknown(),
    subject: z.string().optional(),
  })
  .catchall(z.unknown());
export type StudioLogicalTriggerPayload = z.infer<
  typeof StudioLogicalTriggerPayloadSchema
>;

/**
 * Durable data carried by the private Studio Inngest control event. `prompt`
 * is the exact user-owned chat text; `inputs` also contains that same value
 * under the definition's authored prompt-port id. `payload` is the immutable
 * logical trigger exposed to the agent; the remaining fields are private
 * reservation/control metadata.
 */
export const StudioAgentRunEventDataSchema = z
  .object({
    schemaVersion: z.literal(1),
    eventId: z.string(),
    eventName: z.string().trim().min(1).max(160),
    runId: z.string(),
    sessionId: z.string(),
    correlationId: z.string(),
    agentId: z.string(),
    definitionHash: z.string(),
    tenantId: z.string(),
    tenantSlug: z.string().min(1),
    subject: z.string().nullable(),
    prompt: z
      .string()
      .min(1)
      .max(128 * 1024),
    payload: StudioLogicalTriggerPayloadSchema,
    inputs: z.record(z.string(), z.unknown()),
    conversationHistory: z.array(StudioConversationTurnSchema).max(20),
    runtimeOverrides: StudioRuntimeOverridesSchema,
    toolPolicy: StudioToolPolicySchema,
  })
  .strict();
export type StudioAgentRunEventData = z.infer<
  typeof StudioAgentRunEventDataSchema
>;

export const RunInvocationSourceSchema = z.enum([
  "studio",
  "event",
  "api",
  "replay",
  "demo",
]);
export type RunInvocationSource = z.infer<typeof RunInvocationSourceSchema>;

export const AgentRunSessionSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  agentId: z.string(),
  createdBy: z.string().nullable(),
  title: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  lastRunAt: z.coerce.date().nullable(),
});
export type AgentRunSession = z.infer<typeof AgentRunSessionSchema>;

export const CreateRunSessionBodySchema = z.object({
  agentId: z.string(),
  title: z.string().trim().min(1).max(240).optional(),
});
export type CreateRunSessionBody = z.infer<typeof CreateRunSessionBodySchema>;

export const CreateRunSessionResponseSchema = z.object({
  session: AgentRunSessionSchema,
});
export type CreateRunSessionResponse = z.infer<
  typeof CreateRunSessionResponseSchema
>;

export const ListAgentRunsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).default(30),
  versionId: z.string().optional(),
  draftRevisionId: z.string().optional(),
  sessionId: z.string().optional(),
  source: RunInvocationSourceSchema.optional(),
  status: RunStatus.optional(),
});
export type ListAgentRunsQuery = z.infer<typeof ListAgentRunsQuerySchema>;

export const AgentRunHistoryRowSchema = z.object({
  id: z.string(),
  sessionId: z.string().nullable(),
  status: RunStatus,
  source: RunInvocationSourceSchema,
  target: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("live"),
      agentVersionId: z.string().nullable(),
    }),
    z.object({
      kind: z.literal("draft"),
      draftRevisionId: z.string(),
    }),
  ]),
  definitionHash: z.string().nullable(),
  subject: z.string().nullable(),
  promptPreview: z.string().nullable(),
  testRun: z.boolean(),
  sideEffectMode: z.enum(["suppressed", "safe", "live"]),
  outputValid: z.boolean().nullable(),
  queuedAt: z.coerce.date(),
  startedAt: z.coerce.date().nullable(),
  endedAt: z.coerce.date().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  provider: ProviderIdSchema.nullable(),
  model: z.string().nullable(),
  tokensIn: z.number().int().nonnegative().nullable(),
  tokensOut: z.number().int().nonnegative().nullable(),
  error: z.string().nullable(),
});
export type AgentRunHistoryRow = z.infer<typeof AgentRunHistoryRowSchema>;

export const ListAgentRunsResponseSchema = z.object({
  runs: z.array(AgentRunHistoryRowSchema),
  nextCursor: z.string().nullable(),
});
export type ListAgentRunsResponse = z.infer<typeof ListAgentRunsResponseSchema>;

export const RunMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  runId: z.string().nullable(),
  ord: z.number().int().nonnegative(),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.unknown(),
  createdAt: z.coerce.date(),
});
export type RunMessage = z.infer<typeof RunMessageSchema>;

/**
 * Server-authoritative values required to continue a saved Test Lab chat.
 * Draft revisions and alternate triggers must not silently fall back to the
 * editor's current selection when a session is reopened.
 */
export const StudioRunContinuationSchema = z.object({
  runId: z.string(),
  target: StudioRunTargetSchema,
  triggerEvent: z.string().trim().min(1).max(160),
  inputs: z.record(z.string(), z.unknown()),
  toolPolicy: StudioToolPolicySchema,
});
export type StudioRunContinuation = z.infer<typeof StudioRunContinuationSchema>;

export const GetRunSessionResponseSchema = z.object({
  session: AgentRunSessionSchema,
  messages: z.array(RunMessageSchema),
  runs: z.array(AgentRunHistoryRowSchema),
  continuation: StudioRunContinuationSchema.nullable().optional(),
});
export type GetRunSessionResponse = z.infer<typeof GetRunSessionResponseSchema>;

export const ArtifactRoleSchema = z.enum([
  "definition",
  "input",
  "output",
  "run_record",
  "raw_response",
  "step_input",
  "step_output",
  "trace",
  "attachment",
  "other",
]);
export type ArtifactRole = z.infer<typeof ArtifactRoleSchema>;

export const RunArtifactMetadataSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string().nullable(),
  role: ArtifactRoleSchema,
  logicalName: z.string().nullable(),
  contentType: z.string().nullable(),
  size: z.number().int().nonnegative(),
  sha256: z.string().nullable(),
  schemaId: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable(),
  redacted: z.boolean(),
  createdAt: z.coerce.date(),
  retentionUntil: z.coerce.date().nullable(),
});
export type RunArtifactMetadata = z.infer<typeof RunArtifactMetadataSchema>;

export const RunTraceKindSchema = z.enum([
  "run",
  "input",
  "prompt",
  "step",
  "llm",
  "tool",
  "output_validation",
  "artifact",
  "event",
]);
export type RunTraceKind = z.infer<typeof RunTraceKindSchema>;

export const RunTraceLevelSchema = z.enum(["minimal", "standard", "debug"]);
export type RunTraceLevel = z.infer<typeof RunTraceLevelSchema>;

export const RunTraceVisibilitySchema = z.enum(["user", "operator", "debug"]);
export type RunTraceVisibility = z.infer<typeof RunTraceVisibilitySchema>;

export const RunTraceStatusSchema = z.enum([
  "pending",
  "running",
  "ok",
  "failed",
  "skipped",
]);
export type RunTraceStatus = z.infer<typeof RunTraceStatusSchema>;

export const RunTraceEventSchema = z.object({
  id: z.string(),
  runId: z.string(),
  stepId: z.string().nullable(),
  parentId: z.string().nullable(),
  seq: z.number().int().nonnegative(),
  kind: RunTraceKindSchema,
  level: RunTraceLevelSchema,
  name: z.string(),
  status: RunTraceStatusSchema,
  startedAt: z.coerce.date().nullable(),
  endedAt: z.coerce.date().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  summary: z.string().nullable(),
  data: z.record(z.string(), z.unknown()).nullable(),
  artifactId: z.string().nullable(),
  visibility: RunTraceVisibilitySchema,
  createdAt: z.coerce.date(),
});
export type RunTraceEvent = z.infer<typeof RunTraceEventSchema>;

export const GetRunTraceQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(1_000).default(200),
});
export type GetRunTraceQuery = z.infer<typeof GetRunTraceQuerySchema>;

export const GetRunTraceResponseSchema = z.object({
  events: z.array(RunTraceEventSchema),
  nextAfter: z.number().int().nonnegative().nullable(),
});
export type GetRunTraceResponse = z.infer<typeof GetRunTraceResponseSchema>;

export const RunOutputResponseSchema = z.object({
  runId: z.string(),
  status: RunStatus,
  output: z.unknown().nullable(),
  outputValid: z.boolean().nullable(),
  artifact: RunArtifactMetadataSchema.nullable(),
});
export type RunOutputResponse = z.infer<typeof RunOutputResponseSchema>;

export const RunEmittedEventSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  eventName: z.string(),
  outputPortId: z.string(),
  createdAt: z.coerce.date(),
});
export type RunEmittedEvent = z.infer<typeof RunEmittedEventSchema>;

const AgentRunRecordTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("live"), agentVersionId: z.string() }),
  z.object({ kind: z.literal("draft"), draftRevisionId: z.string() }),
]);

export const AgentRunRecordSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string(),
  tenantId: z.string(),
  agentId: z.string(),
  status: RunStatus,
  invocationSource: RunInvocationSourceSchema,
  target: AgentRunRecordTargetSchema,
  definitionHash: z.string(),
  sessionId: z.string().nullable(),
  correlationId: z.string(),
  subject: z.string().nullable(),
  validation: z.object({
    inputValid: z.boolean(),
    outputValid: z.boolean().nullable(),
    issues: z.array(AgentValidationIssueSchema),
  }),
  artifacts: z.array(RunArtifactMetadataSchema),
  emittedEvents: z.array(RunEmittedEventSchema),
  model: z
    .object({
      provider: ProviderIdSchema.optional(),
      model: z.string().optional(),
      tokensIn: z.number().int().nonnegative().nullable().optional(),
      tokensOut: z.number().int().nonnegative().nullable().optional(),
    })
    .optional(),
  timing: z.object({
    queuedAt: z.coerce.date().nullable(),
    startedAt: z.coerce.date().nullable(),
    endedAt: z.coerce.date().nullable(),
    durationMs: z.number().int().nonnegative().nullable(),
  }),
  error: z
    .object({
      code: z.string().optional(),
      message: z.string(),
    })
    .nullable(),
});
export type AgentRunRecord = z.infer<typeof AgentRunRecordSchema>;

export const ReplayStudioRunBodySchema = z.object({
  version: z.enum(["same", "latest"]).default("same"),
  inputsPatch: z.record(z.string(), z.unknown()).default({}),
  sessionId: z.string().optional(),
});
export type ReplayStudioRunBody = z.infer<typeof ReplayStudioRunBodySchema>;

export const ReplayStudioRunResponseSchema = CreateAgentRunResponseSchema;
export type ReplayStudioRunResponse = z.infer<
  typeof ReplayStudioRunResponseSchema
>;

/** Optional output-schema document returned by editor schema endpoints. */
export const AgentCompiledOutputSchema = z.object({
  agentId: z.string(),
  definitionHash: z.string(),
  schema: JsonSchemaSchema,
});
export type AgentCompiledOutput = z.infer<typeof AgentCompiledOutputSchema>;
