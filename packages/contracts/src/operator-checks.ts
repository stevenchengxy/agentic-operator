import { z } from "zod";

/**
 * One-click production reliability check contracts.
 *
 * The API persists lifecycle events in audit_log and reconstructs this
 * operator-facing projection on reads. Keeping the wire contract independent
 * from the audit row shape lets the implementation add evidence without
 * coupling the portal to storage details.
 */

export const OperatorCheckStatusSchema = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
]);
export type OperatorCheckStatus = z.infer<typeof OperatorCheckStatusSchema>;

export const OperatorCheckScenarioIdSchema = z.enum([
  "support-triage",
  "context-probe",
]);
export type OperatorCheckScenarioId = z.infer<
  typeof OperatorCheckScenarioIdSchema
>;

export const OperatorCheckPhaseSchema = z.enum([
  "preflight",
  "agent",
  "draft",
  "validate",
  "publish",
  "trigger",
  "discover-run",
  "await-run",
  "output",
  "trace",
  "logs",
  "artifacts",
  "complete",
]);
export type OperatorCheckPhase = z.infer<typeof OperatorCheckPhaseSchema>;

export const OperatorCheckAssertionSchema = z.object({
  name: z.string(),
  passed: z.boolean(),
  message: z.string(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
});
export type OperatorCheckAssertion = z.infer<
  typeof OperatorCheckAssertionSchema
>;

export const OperatorCheckStageSchema = z.object({
  id: z.string(),
  phase: OperatorCheckPhaseSchema,
  scenario: OperatorCheckScenarioIdSchema.nullable(),
  label: z.string(),
  status: OperatorCheckStatusSchema,
  startedAt: z.coerce.date().nullable(),
  endedAt: z.coerce.date().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  message: z.string().nullable(),
  details: z.record(z.string(), z.unknown()).nullable(),
});
export type OperatorCheckStage = z.infer<typeof OperatorCheckStageSchema>;

export const OperatorCheckScenarioResultSchema = z.object({
  id: OperatorCheckScenarioIdSchema,
  title: z.string(),
  description: z.string(),
  status: OperatorCheckStatusSchema,
  agentId: z.string().nullable(),
  agentName: z.string(),
  draftId: z.string().nullable(),
  deploymentId: z.string().nullable(),
  workflowVersionId: z.string().nullable(),
  agentVersionId: z.string().nullable(),
  eventId: z.string().nullable(),
  runId: z.string().nullable(),
  output: z.unknown().nullable(),
  assertions: z.array(OperatorCheckAssertionSchema),
  stages: z.array(OperatorCheckStageSchema),
});
export type OperatorCheckScenarioResult = z.infer<
  typeof OperatorCheckScenarioResultSchema
>;

export const OperatorCheckRecordSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  tenantSlug: z.string(),
  status: OperatorCheckStatusSchema,
  startedAt: z.coerce.date(),
  endedAt: z.coerce.date().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  currentStage: z.string().nullable(),
  summary: z.string().nullable(),
  scenarios: z.array(OperatorCheckScenarioResultSchema),
  stages: z.array(OperatorCheckStageSchema),
});
export type OperatorCheckRecord = z.infer<typeof OperatorCheckRecordSchema>;

export const StartOperatorCheckResponseSchema = z.object({
  checkId: z.string(),
  status: z.literal("queued"),
  detailUrl: z.string(),
});
export type StartOperatorCheckResponse = z.infer<
  typeof StartOperatorCheckResponseSchema
>;

export const GetOperatorCheckResponseSchema = z.object({
  check: OperatorCheckRecordSchema,
});
export type GetOperatorCheckResponse = z.infer<
  typeof GetOperatorCheckResponseSchema
>;

export const OperatorCheckSummarySchema = OperatorCheckRecordSchema.pick({
  id: true,
  tenantId: true,
  tenantSlug: true,
  status: true,
  startedAt: true,
  endedAt: true,
  durationMs: true,
  currentStage: true,
  summary: true,
});
export type OperatorCheckSummary = z.infer<typeof OperatorCheckSummarySchema>;

export const ListOperatorChecksQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(20),
  cursor: z.string().optional(),
});
export type ListOperatorChecksQuery = z.infer<
  typeof ListOperatorChecksQuerySchema
>;

export const ListOperatorChecksResponseSchema = z.object({
  checks: z.array(OperatorCheckSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ListOperatorChecksResponse = z.infer<
  typeof ListOperatorChecksResponseSchema
>;
