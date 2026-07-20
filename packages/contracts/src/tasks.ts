import { z } from "zod";

export const TaskStatus = z.enum([
  "open",
  "resolving",
  "resolved",
  "snoozed",
  "failed",
]);
export const TaskResumeState = z.enum([
  "pending",
  "dispatching",
  "dispatched",
  "acknowledged",
  "failed",
]);
export const TaskPriority = z.enum(["low", "medium", "high"]);

export const TaskRow = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  priority: TaskPriority,
  status: TaskStatus,
  createdAt: z.coerce.date().nullable(),
  resolvedAt: z.coerce.date().nullable(),
  runId: z.string().nullable(),
  originEventId: z.string().nullable(),
  originEventName: z.string().nullable(),
  waitStepId: z.string().nullable(),
  awaitingRole: z.string().nullable(),
  payloadJson: z.unknown().nullable(),
  resolutionJson: z.unknown().nullable(),
  resumeMarker: z.string().nullable(),
  resumeState: TaskResumeState,
  resumeAttempts: z.number().int().nonnegative(),
  resolutionRequestedAt: z.coerce.date().nullable(),
  resumeDispatchedAt: z.coerce.date().nullable(),
  resumeAcknowledgedAt: z.coerce.date().nullable(),
  resumeError: z.string().nullable(),
});
export type TaskRow = z.infer<typeof TaskRow>;

export const ResolveTaskBody = z.object({
  decision: z.enum(["approve", "reject", "supplement"]),
  payload: z.unknown().optional(),
});
export type ResolveTaskBody = z.infer<typeof ResolveTaskBody>;

export const ResolveTaskResponse = z.object({
  task_id: z.string(),
  decision: z.enum(["approve", "reject", "supplement"]),
  status: z.enum(["resolving", "resolved"]),
  resume_marker: z.string(),
});
