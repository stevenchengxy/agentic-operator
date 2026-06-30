import { z } from "zod";

export const RunStatus = z.enum([
  "queued",
  "running",
  "ok",
  "failed",
  "waiting",
  "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const StepType = z.enum([
  "tool",
  "logic",
  "manual",
  "condition",
  "delay",
  "subflow",
]);
export const StepStatus = z.enum([
  "pending",
  "running",
  "ok",
  "failed",
  "skipped",
]);

export const RunRow = z.object({
  id: z.string(),
  status: RunStatus,
  agentName: z.string(),
  agentTitle: z.string().nullable(),
  subject: z.string().nullable(),
  triggerEvent: z.string().nullable(),
  /**
   * UC-V11-21 / AR-GAP-06 — name of the downstream event the run emitted on
   * success. Hydrated by a `LEFT JOIN events ON events.id = runs.emitted_event_id`
   * in `apps/api/src/queries/runs.ts`. Null while the run is still in flight
   * or when the agent has no `triggered_event` in its manifest.
   */
  emittedEvent: z.string().nullable(),
  startedAt: z.coerce.date().nullable(),
  endedAt: z.coerce.date().nullable(),
  durationMs: z.number().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  model: z.string().nullable(),
  correlationId: z.string(),
  errorMessage: z.string().nullable(),
  /**
   * P2-FE-18 — alias of `errorMessage` surfaced on the wire under the shorter
   * key the portal `runs/[id]/page.tsx` already reads. Optional so existing
   * fixtures (which only set `errorMessage`) keep parsing. The query layer
   * mirrors `errorMessage → error` so both are always populated together.
   */
  error: z.string().nullable().optional(),
  logPath: z.string().nullable(),
  /** For Active Runs: in-flight step's name + ord + total step count. */
  currentStepName: z.string().nullable(),
  currentStepOrd: z.number().nullable(),
  stepCount: z.number().nullable(),
  /**
   * P2-FE-18 — surfaces `runs.is_test` so cold-loaded run-detail views can
   * paint the TEST badge without waiting for the SSE `run.started` event.
   * Optional so legacy fixtures parse; the API query layer always populates
   * it (defaulting to false when the column is null/absent).
   */
  testRun: z.boolean().optional(),
  /**
   * Parent run id when this run was spawned as a subflow/child (or is a
   * replay descendant). Lets the list paint a child/REPLAY badge and the
   * trace tree fetch children via `?parentRunId=`. Null for top-level runs.
   */
  parentRunId: z.string().nullable().optional(),
  /**
   * Resolved real payloads for the run-detail IO/Events tabs — the trigger
   * event payload (the run's INPUT) and the emitted event payload (its
   * OUTPUT). Detail-only: the list endpoint never reads payload files, so
   * these stay undefined there. Bounded server-side (oversized payloads
   * collapse to a `{ _truncated, _preview }` marker).
   */
  inputPayload: z.unknown().optional(),
  outputPayload: z.unknown().optional(),
});
export type RunRow = z.infer<typeof RunRow>;

export const StepRow = z.object({
  id: z.string(),
  ord: z.number(),
  name: z.string(),
  type: StepType,
  status: StepStatus,
  startedAt: z.coerce.date().nullable(),
  endedAt: z.coerce.date().nullable(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  /**
   * Execution attempt count. >1 means Inngest retried this step's body in
   * place (the run viewer renders an "attempt N" badge). Defaults to 1.
   */
  attempts: z.number().optional(),
  // Resolved real input/output payloads for this step (run-detail only — the
  // list endpoint leaves these undefined). Powers the Timeline/Trace/IO tabs'
  // Inngest-style per-step 📥 input / 📤 output.
  input: z.unknown().optional(),
  output: z.unknown().optional(),
});
export type StepRow = z.infer<typeof StepRow>;

export const ListRunsQuery = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
  status: z.string().optional(),
  agent: z.string().optional(),
  q: z.string().optional(),
  /** Filter to a parent run's children (trace-tree lazy expand). */
  parentRunId: z.string().optional(),
});

/**
 * A human task this run is currently blocked on (HITL `waitForEvent`). Lets
 * the run viewer show an Inngest-style "waiting for event/approval" state and
 * deep-link to the task inbox instead of going dark.
 */
export const RunWaitingTask = z.object({
  id: z.string(),
  title: z.string(),
  awaitingRole: z.string().nullable(),
  createdAt: z.coerce.date().nullable(),
});
export type RunWaitingTask = z.infer<typeof RunWaitingTask>;

export const GetRunResponse = z.object({
  run: RunRow,
  steps: z.array(StepRow),
  /** Present + non-null while the run is blocked on a human task. */
  waitingTask: RunWaitingTask.nullable().optional(),
});

export const ReplayRunResponse = z.object({
  replayed_run: z.string(),
  new_event_id: z.string(),
});

/**
 * Response of `POST /v1/runs/:id/cancel` — operator kill-switch.
 *
 * `cancelled` is true when this call flipped the row from an active state
 * (running / waiting / queued) to `cancelled`. It is false on the no-op
 * idempotent paths (run is already terminal — `ok`, `failed`, or already
 * `cancelled`). `note` is a human-readable summary of what the route did
 * (e.g. "Inngest cancel signal sent; manifest fn will exit at next
 * checkpoint" vs. "Run already terminal; no-op").
 */
export const CancelRunResponse = z.object({
  runId: z.string(),
  status: RunStatus,
  cancelled: z.boolean(),
  note: z.string(),
});
export type CancelRunResponse = z.infer<typeof CancelRunResponse>;
