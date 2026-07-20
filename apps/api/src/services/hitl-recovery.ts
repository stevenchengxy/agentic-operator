import { createHash } from "node:crypto";
import {
  and,
  eq,
  getDb,
  inArray,
  runs,
  steps,
  tasks,
  tenants,
} from "@agentic/db";
import { getTenantInngest, inputBindingValueMatchesType, tenantEventName } from "@agentic/runtime";

export type HumanDecision = "approve" | "reject" | "supplement";

interface StoredResolution {
  taskId: string;
  decision: HumanDecision;
  payload: unknown;
  actorUserId: string | null;
  resumeMarker: string;
}

export interface ResumeEvent {
  id: string;
  name: `${string}/${string}`;
  data: StoredResolution & { tenantId: string };
}

export type ResumeSender = (event: ResumeEvent) => Promise<unknown>;

export interface HumanTaskResolutionResult {
  taskId: string;
  decision: HumanDecision;
  status: "resolving" | "resolved";
  resumeMarker: string;
  attempt: number;
}

export class HumanTaskError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "HumanTaskError";
  }
}

export class HumanTaskDispatchError extends HumanTaskError {
  readonly accepted = true;

  constructor(
    readonly taskId: string,
    readonly resumeMarker: string,
    cause: unknown,
  ) {
    super(
      `task decision was persisted but resume dispatch failed: ${String(
        (cause as { message?: unknown } | null)?.message ?? cause,
      ).slice(0, 240)}`,
      "resume_dispatch_failed",
      503,
    );
    this.name = "HumanTaskDispatchError";
  }
}

type HumanInputTaskDescriptor = {
  kind: "human_input";
  field: string;
  type: string;
  required: boolean;
  prompt: string;
};

function humanInputTaskDescriptor(value: unknown): HumanInputTaskDescriptor | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const raw = row.inputBinding;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const binding = raw as Record<string, unknown>;
  if (
    binding.kind !== "human_input"
    || typeof binding.field !== "string"
    || !binding.field.trim()
    || typeof binding.type !== "string"
    || !binding.type.trim()
    || typeof binding.required !== "boolean"
    || typeof binding.prompt !== "string"
    || !binding.prompt.trim()
  ) return null;
  return binding as HumanInputTaskDescriptor;
}

/** Validate before the task is claimed/resume-dispatched. This keeps a bad or
 * empty answer on the open task so the operator can correct it instead of
 * waking the durable run with unusable input. */
export function validateHumanInputTaskResolution(args: {
  taskPayload: unknown;
  decision: HumanDecision;
  payload: unknown;
}): string | null {
  if (args.decision === "reject") return null;
  const binding = humanInputTaskDescriptor(args.taskPayload);
  if (!binding) return null;
  const payload = args.payload;
  const value = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (Object.prototype.hasOwnProperty.call(payload, binding.field)
        ? (payload as Record<string, unknown>)[binding.field]
        : (payload as Record<string, unknown>).value)
    : payload;
  const missing = value === undefined || value === null || (typeof value === "string" && !value.trim());
  if (missing) return binding.required ? `请先回答「${binding.prompt}」` : null;
  if (!inputBindingValueMatchesType(value, binding.type)) {
    return `「${binding.field}」需要 ${binding.type} 类型的值，请检查后再提交`;
  }
  return null;
}

function canonicalize(value: unknown): unknown {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

/** Stable across object key order and transport retries. */
export function humanResolutionRequestKey(input: {
  tenantId: string;
  taskId: string;
  decision: HumanDecision;
  payload?: unknown;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          tenantId: input.tenantId,
          taskId: input.taskId,
          decision: input.decision,
          payload: input.payload ?? null,
        }),
      ),
    )
    .digest("hex");
}

function legacyResumeMarker(task: {
  tenantId: string;
  runId: string | null;
  id: string;
}): string {
  return `hitl:${task.tenantId}:${task.runId ?? "orphan"}:${task.id}`;
}

function resolutionFrom(value: unknown): StoredResolution | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.taskId !== "string" ||
    (row.decision !== "approve" &&
      row.decision !== "reject" &&
      row.decision !== "supplement") ||
    typeof row.resumeMarker !== "string"
  ) {
    return null;
  }
  return {
    taskId: row.taskId,
    decision: row.decision,
    payload: row.payload ?? null,
    actorUserId: typeof row.actorUserId === "string" ? row.actorUserId : null,
    resumeMarker: row.resumeMarker,
  };
}

function storedResolutionRequestKey(
  tenantId: string,
  taskId: string,
  value: unknown,
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.decision !== "approve" &&
    row.decision !== "reject" &&
    row.decision !== "supplement"
  ) {
    return null;
  }
  return humanResolutionRequestKey({
    tenantId,
    taskId,
    decision: row.decision,
    payload: row.payload ?? null,
  });
}

function findRecoveryContext(
  db: ReturnType<typeof getDb>,
  task: typeof tasks.$inferSelect,
): {
  recoverable: boolean;
  reason: string;
  run: typeof runs.$inferSelect | null;
  waitStep: typeof steps.$inferSelect | null;
} {
  if (!task.runId) {
    return { recoverable: false, reason: "task_has_no_owning_run", run: null, waitStep: null };
  }
  const run = db
    .select()
    .from(runs)
    .where(and(eq(runs.id, task.runId), eq(runs.tenantId, task.tenantId)))
    .all()[0] ?? null;
  if (!run) {
    return { recoverable: false, reason: "owning_run_missing", run: null, waitStep: null };
  }
  if (run.status !== "waiting" && run.status !== "running") {
    return {
      recoverable: false,
      reason: `owning_run_not_waiting:${run.status}`,
      run,
      waitStep: null,
    };
  }
  const waitStep = task.waitStepId
    ? db
        .select()
        .from(steps)
        .where(and(eq(steps.id, task.waitStepId), eq(steps.runId, run.id)))
        .all()[0] ?? null
    : db
        .select()
        .from(steps)
        .where(
          and(
            eq(steps.runId, run.id),
            eq(steps.type, "manual"),
            eq(steps.status, "running"),
          ),
        )
        .all()[0] ?? null;
  if (!waitStep) {
    return {
      recoverable: false,
      reason: "manual_wait_step_missing",
      run,
      waitStep: null,
    };
  }
  if (waitStep.type !== "manual" || waitStep.status !== "running") {
    return {
      recoverable: false,
      reason: `manual_wait_step_not_recoverable:${waitStep.type}:${waitStep.status}`,
      run,
      waitStep,
    };
  }
  return { recoverable: true, reason: "recoverable", run, waitStep };
}

function failHumanTask(
  task: typeof tasks.$inferSelect,
  reason: string,
  nowMs: number,
): boolean {
  const db = getDb();
  let changed = false;
  db.transaction((tx) => {
    const taskResult = tx
      .update(tasks)
      .set({
        status: "failed",
        resumeState: "failed",
        resumeError: reason,
      })
      .where(
        and(
          eq(tasks.id, task.id),
          eq(tasks.tenantId, task.tenantId),
          inArray(tasks.status, ["open", "resolving"]),
        ),
      )
      .run() as { changes?: number };
    changed = (taskResult.changes ?? 0) === 1;
    if (!changed) return;
    if (task.waitStepId) {
      tx.update(steps)
        .set({ status: "failed", endedAt: new Date(nowMs), error: reason })
        .where(
          and(
            eq(steps.id, task.waitStepId),
            inArray(steps.status, ["pending", "running"]),
          ),
        )
        .run();
    } else if (task.runId) {
      tx.update(steps)
        .set({ status: "failed", endedAt: new Date(nowMs), error: reason })
        .where(
          and(
            eq(steps.runId, task.runId),
            eq(steps.type, "manual"),
            inArray(steps.status, ["pending", "running"]),
          ),
        )
        .run();
    }
    if (task.runId) {
      const run = tx.select().from(runs).where(eq(runs.id, task.runId)).all()[0];
      if (run && ["queued", "running", "waiting"].includes(run.status)) {
        tx.update(runs)
          .set({
            status: "failed",
            endedAt: new Date(nowMs),
            durationMs: run.startedAt ? Math.max(0, nowMs - run.startedAt.getTime()) : null,
            errorMessage: reason,
          })
          .where(eq(runs.id, run.id))
          .run();
      }
    }
  });
  return changed;
}

async function defaultResumeSender(
  tenantSlug: string,
  event: ResumeEvent,
): Promise<unknown> {
  return getTenantInngest(tenantSlug).send(event);
}

/**
 * Dispatch a decision already durably stored on a `resolving` task. Attempts
 * use distinct transport ids, while the persisted resumeMarker is stable; this
 * lets startup reconciliation redeliver after an ambiguous process crash.
 */
export async function dispatchStoredHumanResolution(args: {
  taskId: string;
  tenantId: string;
  tenantSlug: string;
  send?: ResumeSender;
  now?: () => number;
}): Promise<HumanTaskResolutionResult> {
  const db = getDb();
  const now = args.now ?? Date.now;
  const initial = db
    .select()
    .from(tasks)
    .where(and(eq(tasks.id, args.taskId), eq(tasks.tenantId, args.tenantId)))
    .all()[0];
  if (!initial) throw new HumanTaskError("task not found", "not_found", 404);
  if (initial.status === "resolving") {
    const recovery = findRecoveryContext(db, initial);
    if (!recovery.recoverable) {
      failHumanTask(initial, recovery.reason, now());
      throw new HumanTaskError(
        `task cannot resume because ${recovery.reason}`,
        "task_not_recoverable",
        409,
      );
    }
    const durableResolution = resolutionFrom(initial.resolutionJson);
    if (
      !durableResolution ||
      durableResolution.taskId !== initial.id ||
      durableResolution.resumeMarker !== initial.resumeMarker
    ) {
      failHumanTask(initial, "invalid_resolution_envelope", now());
      throw new HumanTaskError(
        "task has no valid durable resolution envelope",
        "invalid_resolution_envelope",
        409,
      );
    }
  }
  let attempt = 0;
  let resolution: StoredResolution | null = null;
  let alreadyAcknowledged = false;

  db.transaction((tx) => {
    const task = tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, args.taskId), eq(tasks.tenantId, args.tenantId)))
      .all()[0];
    if (!task) throw new HumanTaskError("task not found", "not_found", 404);
    if (task.status === "resolved" && task.resumeState === "acknowledged") {
      resolution = resolutionFrom(task.resolutionJson);
      attempt = task.resumeAttempts;
      alreadyAcknowledged = true;
      return;
    }
    if (task.status !== "resolving") {
      throw new HumanTaskError(
        `task is ${task.status}; resume cannot be dispatched`,
        "task_not_resolving",
        409,
      );
    }
    resolution = resolutionFrom(task.resolutionJson);
    if (!resolution) {
      throw new HumanTaskError(
        "task has no valid durable resolution envelope",
        "invalid_resolution_envelope",
        409,
      );
    }
    attempt = task.resumeAttempts + 1;
    tx.update(tasks)
      .set({
        resumeAttempts: attempt,
        resumeState: "dispatching",
        resumeError: null,
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, "resolving")))
      .run();
  });

  if (!resolution) {
    throw new HumanTaskError(
      "acknowledged task has no resolution envelope",
      "invalid_resolution_envelope",
      409,
    );
  }
  const stableResolution: StoredResolution = resolution;
  if (alreadyAcknowledged) {
    return {
      taskId: args.taskId,
      decision: stableResolution.decision,
      status: "resolved",
      resumeMarker: stableResolution.resumeMarker,
      attempt,
    };
  }
  const event: ResumeEvent = {
    id: `hitl-resume-${args.taskId}-a${attempt}`,
    name: tenantEventName(args.tenantSlug, "task.resolved") as `${string}/${string}`,
    data: { ...stableResolution, tenantId: args.tenantId },
  };

  try {
    await (args.send
      ? args.send(event)
      : defaultResumeSender(args.tenantSlug, event));
  } catch (error) {
    db.update(tasks)
      .set({
        resumeState: "pending",
        resumeError: String((error as { message?: unknown } | null)?.message ?? error).slice(0, 500),
      })
      .where(and(eq(tasks.id, args.taskId), eq(tasks.status, "resolving")))
      .run();
    throw new HumanTaskDispatchError(args.taskId, stableResolution.resumeMarker, error);
  }

  const dispatchedAt = now();
  db.update(tasks)
    .set({
      resumeState: "dispatched",
      resumeDispatchedAt: new Date(dispatchedAt),
      resumeError: null,
    })
    // If the Inngest wait acknowledged synchronously, its close step has
    // already changed status to resolved; never overwrite acknowledged.
    .where(and(eq(tasks.id, args.taskId), eq(tasks.status, "resolving")))
    .run();
  const after = db.select().from(tasks).where(eq(tasks.id, args.taskId)).all()[0];
  return {
    taskId: args.taskId,
    decision: stableResolution.decision,
    status: after?.status === "resolved" ? "resolved" : "resolving",
    resumeMarker: stableResolution.resumeMarker,
    attempt,
  };
}

/** Claim a human decision durably, validate the owning wait, then dispatch. */
export async function requestHumanTaskResolution(args: {
  taskId: string;
  tenantId: string;
  tenantSlug: string;
  actorUserId?: string | null;
  decision: HumanDecision;
  payload?: unknown;
  send?: ResumeSender;
  now?: () => number;
}): Promise<HumanTaskResolutionResult> {
  const db = getDb();
  const now = args.now ?? Date.now;
  const requestedAt = now();
  const requestKey = humanResolutionRequestKey(args);
  let marker = "";
  let acknowledged = false;
  let alreadyResolving = false;
  let failure: HumanTaskError | null = null;

  db.transaction((tx) => {
    const task = tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, args.taskId), eq(tasks.tenantId, args.tenantId)))
      .all()[0];
    if (!task) {
      failure = new HumanTaskError("task not found", "not_found", 404);
      return;
    }
    const humanInputError = validateHumanInputTaskResolution({
      taskPayload: task.payloadJson,
      decision: args.decision,
      payload: args.payload,
    });
    if (humanInputError) {
      failure = new HumanTaskError(humanInputError, "invalid_human_input", 422);
      return;
    }
    marker = task.resumeMarker ?? legacyResumeMarker(task);

    if (task.status === "resolved") {
      const priorRequestKey =
        task.resolutionRequestKey ??
        storedResolutionRequestKey(task.tenantId, task.id, task.resolutionJson);
      if (!priorRequestKey || priorRequestKey !== requestKey) {
        failure = new HumanTaskError(
          "task was already resolved with a different decision",
          "resolution_conflict",
          409,
        );
      } else {
        acknowledged = true;
      }
      return;
    }
    if (task.status === "resolving") {
      if (task.resolutionRequestKey !== requestKey) {
        failure = new HumanTaskError(
          "a different decision is already being resumed",
          "resolution_conflict",
          409,
        );
        return;
      }
      alreadyResolving = true;
    } else if (task.status !== "open") {
      failure = new HumanTaskError(
        `task is ${task.status} and cannot be resolved`,
        "task_not_recoverable",
        409,
      );
      return;
    }

    // Query on the same synchronous SQLite transaction/connection for both a
    // fresh claim and an idempotent retry. A prior `resolving` row whose wait
    // became terminal must fail explicitly, never emit another orphan event.
    const run = task.runId
      ? tx
          .select()
          .from(runs)
          .where(and(eq(runs.id, task.runId), eq(runs.tenantId, task.tenantId)))
          .all()[0] ?? null
      : null;
    const waitStep = run
      ? task.waitStepId
        ? tx
            .select()
            .from(steps)
            .where(and(eq(steps.id, task.waitStepId), eq(steps.runId, run.id)))
            .all()[0] ?? null
        : tx
            .select()
            .from(steps)
            .where(
              and(
                eq(steps.runId, run.id),
                eq(steps.type, "manual"),
                eq(steps.status, "running"),
              ),
            )
            .all()[0] ?? null
      : null;
    const recoverable =
      run &&
      (run.status === "waiting" || run.status === "running") &&
      waitStep?.type === "manual" &&
      waitStep.status === "running";
    if (!recoverable || !run || !waitStep) {
      const reason = !run
        ? "owning_run_missing"
        : run.status !== "waiting" && run.status !== "running"
          ? `owning_run_not_waiting:${run.status}`
          : "manual_wait_step_not_recoverable";
      tx.update(tasks)
        .set({ status: "failed", resumeState: "failed", resumeError: reason })
        .where(eq(tasks.id, task.id))
        .run();
      if (waitStep && ["pending", "running"].includes(waitStep.status)) {
        tx.update(steps)
          .set({ status: "failed", endedAt: new Date(requestedAt), error: reason })
          .where(eq(steps.id, waitStep.id))
          .run();
      }
      if (run && ["queued", "running", "waiting"].includes(run.status)) {
        tx.update(runs)
          .set({
            status: "failed",
            endedAt: new Date(requestedAt),
            durationMs: run.startedAt
              ? Math.max(0, requestedAt - run.startedAt.getTime())
              : null,
            errorMessage: reason,
          })
          .where(eq(runs.id, run.id))
          .run();
      }
      failure = new HumanTaskError(
        `task cannot resume because ${reason}`,
        "task_not_recoverable",
        409,
      );
      return;
    }

    if (alreadyResolving) {
      tx.update(tasks)
        .set({ waitStepId: waitStep.id, resumeMarker: marker })
        .where(and(eq(tasks.id, task.id), eq(tasks.status, "resolving")))
        .run();
      if (run.status === "running") {
        tx.update(runs)
          .set({ status: "waiting" })
          .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
          .run();
      }
      return;
    }

    const resolution: StoredResolution = {
      taskId: task.id,
      decision: args.decision,
      payload: args.payload ?? null,
      actorUserId: args.actorUserId ?? null,
      resumeMarker: marker,
    };
    tx.update(tasks)
      .set({
        status: "resolving",
        waitStepId: waitStep.id,
        resumeMarker: marker,
        resumeState: "pending",
        resolutionJson: resolution as never,
        resolutionRequestKey: requestKey,
        resolutionRequestedAt: new Date(requestedAt),
        resumeError: null,
      })
      .where(and(eq(tasks.id, task.id), eq(tasks.status, "open")))
      .run();
    if (run.status === "running") {
      tx.update(runs)
        .set({ status: "waiting" })
        .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
        .run();
    }
  });

  if (failure) throw failure;
  if (acknowledged) {
    return {
      taskId: args.taskId,
      decision: args.decision,
      status: "resolved",
      resumeMarker: marker,
      attempt:
        db.select({ value: tasks.resumeAttempts }).from(tasks).where(eq(tasks.id, args.taskId)).all()[0]
          ?.value ?? 0,
    };
  }
  return dispatchStoredHumanResolution({
    taskId: args.taskId,
    tenantId: args.tenantId,
    tenantSlug: args.tenantSlug,
    send: args.send,
    now,
  });
}

export interface HumanTaskReconcileReport {
  inspected: number;
  retried: number;
  failed: number;
  dispatchErrors: number;
  failedTaskIds: string[];
}

interface HitlLogger {
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

function positiveEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Startup/periodic recovery for human waits. It retries ambiguous dispatches
 * while the owning run+manual step remain recoverable. Once that invariant or
 * the ACK deadline is lost, task/run/step are atomically marked failed — a
 * human decision can never remain falsely `resolved` without consumption.
 */
export async function reconcileHumanTasks(
  logger: HitlLogger = {},
  opts: { send?: ResumeSender; now?: () => number } = {},
): Promise<HumanTaskReconcileReport> {
  const db = getDb();
  const now = opts.now ?? Date.now;
  const nowMs = now();
  const retryMs = positiveEnv("AGENTIC_HITL_RESUME_RETRY_MS", 30_000);
  const ackTimeoutMs = positiveEnv("AGENTIC_HITL_RESUME_TIMEOUT_MS", 300_000);
  const openTimeoutMs = positiveEnv("AGENTIC_HITL_WAIT_TIMEOUT_MS", 7 * 24 * 60 * 60 * 1000);
  const candidates = db
    .select()
    .from(tasks)
    .where(inArray(tasks.status, ["open", "resolving"]))
    .all();
  const report: HumanTaskReconcileReport = {
    inspected: candidates.length,
    retried: 0,
    failed: 0,
    dispatchErrors: 0,
    failedTaskIds: [],
  };

  for (const task of candidates) {
    const context = findRecoveryContext(db, task);
    let failureReason: string | null = context.recoverable ? null : context.reason;
    if (
      !failureReason &&
      task.status === "open" &&
      task.createdAt &&
      nowMs - task.createdAt.getTime() >= openTimeoutMs
    ) {
      failureReason = "hitl_wait_deadline_exceeded";
    }
    if (
      !failureReason &&
      task.status === "resolving" &&
      nowMs - (task.resolutionRequestedAt?.getTime() ?? task.createdAt?.getTime() ?? nowMs) >=
        ackTimeoutMs
    ) {
      failureReason = "hitl_resume_ack_timeout";
    }
    if (failureReason) {
      if (failHumanTask(task, failureReason, nowMs)) {
        report.failed++;
        report.failedTaskIds.push(task.id);
        logger.warn?.(`[hitl-recovery] task ${task.id} failed: ${failureReason}`);
      }
      continue;
    }
    if (task.status !== "resolving") continue;

    const lastDispatch = task.resumeDispatchedAt?.getTime() ?? 0;
    const due =
      task.resumeState === "pending" ||
      task.resumeState === "dispatching" ||
      (task.resumeState === "dispatched" && nowMs - lastDispatch >= retryMs);
    if (!due) continue;
    const tenant = db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, task.tenantId))
      .all()[0];
    if (!tenant) {
      if (failHumanTask(task, "owning_tenant_missing", nowMs)) {
        report.failed++;
        report.failedTaskIds.push(task.id);
      }
      continue;
    }
    try {
      await dispatchStoredHumanResolution({
        taskId: task.id,
        tenantId: task.tenantId,
        tenantSlug: tenant.slug,
        send: opts.send,
        now,
      });
      report.retried++;
    } catch (error) {
      const after = db
        .select({ status: tasks.status })
        .from(tasks)
        .where(eq(tasks.id, task.id))
        .all()[0];
      if (after?.status === "failed") {
        report.failed++;
        report.failedTaskIds.push(task.id);
      } else {
        report.dispatchErrors++;
      }
      logger.warn?.(
        `[hitl-recovery] task ${task.id} resume retry failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (report.retried || report.failed || report.dispatchErrors) {
    logger.info?.(
      `[hitl-recovery] inspected=${report.inspected} retried=${report.retried} failed=${report.failed} dispatchErrors=${report.dispatchErrors}`,
    );
  }
  return report;
}
