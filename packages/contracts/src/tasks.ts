import { z } from "zod";

export const TaskStatus = z.enum(["open", "resolved", "snoozed"]);
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
  awaitingRole: z.string().nullable(),
  payloadJson: z.unknown().nullable(),
  resolutionJson: z.unknown().nullable(),
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
});
