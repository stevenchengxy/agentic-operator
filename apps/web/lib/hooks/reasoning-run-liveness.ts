import { ApiResponseError } from "@/lib/api-response";
import type { ReasoningRunResponse } from "./useReasoningAgentContext";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "waiting"]);

/**
 * The Reasoning pipeline has no human-wait stage. Five minutes without a
 * persisted run/step transition therefore means the browser must stop
 * presenting the run as healthy and must unlock the composer. The durable
 * run is not rewritten by the browser; the API/worker remains authoritative.
 */
export const REASONING_RUN_STALL_AFTER_MS = 5 * 60_000;

export const REASONING_RUN_ACTIVE_POLL_MS = 700;
export const REASONING_RUN_RECOVERY_POLL_MS = 15_000;

function timestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isActiveReasoningStatus(status: string | null): boolean {
  return status !== null && ACTIVE_RUN_STATUSES.has(status);
}

/** Latest server-persisted activity across the parent and verified child. */
export function reasoningRunLastActivityMs(
  response: ReasoningRunResponse | undefined,
): number | null {
  if (!response) return null;
  const candidates: Array<number | null> = [
    timestamp(response.run.startedAt),
    timestamp(response.run.endedAt),
  ];
  for (const step of response.steps) {
    candidates.push(timestamp(step.startedAt), timestamp(step.endedAt));
  }
  for (const child of response.children) {
    candidates.push(
      timestamp(child.run.startedAt),
      timestamp(child.run.endedAt),
    );
    for (const step of child.steps) {
      candidates.push(timestamp(step.startedAt), timestamp(step.endedAt));
    }
  }
  const valid = candidates.filter((value): value is number => value !== null);
  return valid.length > 0 ? Math.max(...valid) : null;
}

export function reasoningRunStallDeadlineMs(
  response: ReasoningRunResponse | undefined,
): number | null {
  if (!response || !isActiveReasoningStatus(response.run.status)) return null;
  const lastActivity = reasoningRunLastActivityMs(response);
  return lastActivity === null
    ? null
    : lastActivity + REASONING_RUN_STALL_AFTER_MS;
}

export function isReasoningRunStalled(
  response: ReasoningRunResponse | undefined,
  now = Date.now(),
): boolean {
  const deadline = reasoningRunStallDeadlineMs(response);
  return deadline !== null && now >= deadline;
}

/** Errors that cannot become successful by retrying the same audit request. */
export function isTerminalReasoningPollError(error: unknown): boolean {
  if (!(error instanceof ApiResponseError)) return false;
  return [
    "not_found",
    "reasoning_result_missing",
    "reasoning_audit_unavailable",
  ].includes(error.code);
}

export function reasoningRunPollInterval(
  response: ReasoningRunResponse | undefined,
  error: unknown,
  failureCount: number,
  now = Date.now(),
): number | false {
  if (isTerminalReasoningPollError(error)) return false;
  if (!response || !isActiveReasoningStatus(response.run.status)) return false;
  if (
    failureCount >= 3 ||
    isReasoningRunStalled(response, now)
  ) {
    // Keep a low-frequency recovery probe so a late worker completion is
    // reflected without requiring a page reload.
    return REASONING_RUN_RECOVERY_POLL_MS;
  }
  return REASONING_RUN_ACTIVE_POLL_MS;
}
