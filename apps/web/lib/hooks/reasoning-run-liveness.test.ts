import { describe, expect, it } from "vitest";
import { ApiResponseError } from "@/lib/api-response";
import type { ReasoningRunResponse } from "./useReasoningAgentContext";
import {
  isReasoningRunStalled,
  REASONING_RUN_ACTIVE_POLL_MS,
  REASONING_RUN_RECOVERY_POLL_MS,
  REASONING_RUN_STALL_AFTER_MS,
  reasoningRunLastActivityMs,
  reasoningRunPollInterval,
} from "./reasoning-run-liveness";

function response(
  status = "running",
  parentStartedAt = "2026-07-14T08:00:00.000Z",
  childStepStartedAt: string | null = null,
): ReasoningRunResponse {
  return {
    run: {
      id: "run-parent",
      status,
      agentName: "reasoningAgent",
      startedAt: parentStartedAt,
      endedAt: null,
      durationMs: null,
      tokensIn: null,
      tokensOut: null,
      model: null,
      error: null,
      currentStepName: "compile_qualified_prompt",
      currentStepOrd: 4,
      stepCount: 4,
    },
    steps: [],
    children: childStepStartedAt
      ? [
          {
            role: "qualified",
            runtimeRole: "qualified",
            run: {
              id: "run-child",
              parentRunId: "run-parent",
              status: "running",
              agentName: "reasoningAgent",
              startedAt: childStepStartedAt,
              endedAt: null,
              durationMs: null,
              tokensIn: null,
              tokensOut: null,
              model: null,
              error: null,
              currentStepName: "llm.call",
              currentStepOrd: 1,
              stepCount: 1,
            },
            steps: [
              {
                id: "step-child",
                ord: 1,
                name: "llm.call",
                type: "logic",
                status: "running",
                startedAt: childStepStartedAt,
                endedAt: null,
                durationMs: null,
                error: null,
                provider: "google",
                model: "gemini",
                tokensIn: null,
                tokensOut: null,
                input: null,
                output: null,
              },
            ],
          },
        ]
      : [],
    result: null,
    resultSchemaVersion: null,
  };
}

describe("Reasoning run liveness", () => {
  it("uses verified child activity instead of declaring an active child stale", () => {
    const value = response(
      "running",
      "2026-07-14T08:00:00.000Z",
      "2026-07-14T08:04:00.000Z",
    );
    expect(reasoningRunLastActivityMs(value)).toBe(
      Date.parse("2026-07-14T08:04:00.000Z"),
    );
    expect(
      isReasoningRunStalled(value, Date.parse("2026-07-14T08:05:01.000Z")),
    ).toBe(false);
  });

  it("unlocks a run after five minutes without persisted activity", () => {
    const value = response();
    const now =
      Date.parse("2026-07-14T08:00:00.000Z") +
      REASONING_RUN_STALL_AFTER_MS;
    expect(isReasoningRunStalled(value, now)).toBe(true);
    expect(reasoningRunPollInterval(value, null, 0, now)).toBe(
      REASONING_RUN_RECOVERY_POLL_MS,
    );
  });

  it("polls healthy active runs rapidly and never polls terminal runs", () => {
    const active = response();
    expect(
      reasoningRunPollInterval(
        active,
        null,
        0,
        Date.parse("2026-07-14T08:00:01.000Z"),
      ),
    ).toBe(REASONING_RUN_ACTIVE_POLL_MS);
    expect(reasoningRunPollInterval(response("ok"), null, 0)).toBe(false);
  });

  it("stops retrying non-recoverable missing-artifact responses", () => {
    const error = new ApiResponseError(
      "/v1/reasoning-agent/runs/run-parent",
      409,
      "reasoning_result_missing",
      "missing result",
    );
    expect(reasoningRunPollInterval(response(), error, 1)).toBe(false);
  });

  it("backs off repeated transient failures without hiding late recovery", () => {
    expect(reasoningRunPollInterval(response(), new TypeError("offline"), 3)).toBe(
      REASONING_RUN_RECOVERY_POLL_MS,
    );
  });
});
