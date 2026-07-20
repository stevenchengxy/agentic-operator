import { afterEach, describe, expect, it, vi } from "vitest";

import { effectiveActionTimeoutMs, runWithActionTimeout } from "./action-plan";
import { actionErrorFacts } from "./error-policy";
import { ActionSchema } from "./manifest";
import { runAction } from "./step-engine";

const ctx = {
  agentName: "bounded",
  actionName: "slow",
  correlationId: "corr-timeout",
  tenantSlug: "tenant",
};

afterEach(() => {
  vi.useRealTimers();
});

describe("generic action timeout policy", () => {
  it("resolves the shorter of an action timeout and enclosing foreach deadline", () => {
    expect(effectiveActionTimeoutMs({ timeoutS: 10, now: 1_000 })).toBe(10_000);
    expect(effectiveActionTimeoutMs({ timeoutS: 10, deadlineAt: 4_000, now: 1_000 })).toBe(3_000);
    expect(effectiveActionTimeoutMs({ deadlineAt: 900, now: 1_000 })).toBe(0);
  });

  it("does not start work after an inherited deadline is already exhausted", async () => {
    let started = false;
    await expect(runWithActionTimeout(async () => {
      started = true;
      return "late";
    }, { timeoutMs: 0, label: "expired" })).rejects.toMatchObject({ code: "ACTION_TIMEOUT" });
    expect(started).toBe(false);
  });

  it("fails a tool action closed and aborts its cooperative handler", async () => {
    vi.useFakeTimers();
    let observedAbort = false;
    const pending = runAction({
      ctx,
      action: ActionSchema.parse({
        order: "1",
        name: "slow",
        type: "tool",
        timeout_s: 1,
      }),
      tenantRegistry: {
        tools: {
          slow: {
            kind: "tool" as const,
            name: "slow",
            async handler(toolCtx) {
              await new Promise<void>((resolve) => {
                toolCtx.signal?.addEventListener("abort", () => {
                  observedAbort = true;
                  resolve();
                }, { once: true });
              });
              return { data: { late: true } };
            },
          },
        },
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    const output = await pending;
    expect(observedAbort).toBe(true);
    expect(output).toMatchObject({
      ok: false,
      type: "tool",
      data: { __error: "action_timeout", code: "ACTION_TIMEOUT", timeout_ms: 1000 },
      meta: { error: "action_timeout", kind: "timeout", code: "ACTION_TIMEOUT" },
    });
    expect(actionErrorFacts({ output })).toMatchObject({
      kind: "action_timeout",
      code: "ACTION_TIMEOUT",
    });
  });

  it("bounds the entire direct foreach even when a child has no timeout", async () => {
    vi.useFakeTimers();
    const pending = runAction({
      ctx: {
        ...ctx,
        event: { name: "START", data: { items: [{ id: "a" }, { id: "b" }] } },
      },
      action: ActionSchema.parse({
        order: "1",
        name: "all",
        type: "foreach",
        timeout_s: 1,
        items_from: "input.items",
        item_as: "item",
        item_key_from: "item.id",
        foreach_actions: [{ order: "1", name: "slow", type: "tool" }],
      }),
      tenantRegistry: {
        tools: {
          slow: {
            kind: "tool" as const,
            name: "slow",
            async handler(toolCtx) {
              await new Promise<void>((resolve) => {
                toolCtx.signal?.addEventListener("abort", () => resolve(), { once: true });
              });
              return { data: { late: true } };
            },
          },
        },
      },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({
      ok: false,
      type: "foreach",
      meta: { error: "action_timeout", code: "ACTION_TIMEOUT" },
    });
  });

  it("tightens a 10s invoke to the enclosing nested foreach's 1s deadline", async () => {
    vi.useFakeTimers();
    let invokeTimeout: number | undefined;
    const output = await runAction({
      ctx: {
        ...ctx,
        event: {
          name: "START",
          data: {
            jobs: [{ id: "J-1", candidates: [{ id: "C-1" }] }],
          },
        },
      },
      action: ActionSchema.parse({
        order: "1",
        name: "jobs",
        type: "foreach",
        items_from: "input.jobs",
        item_as: "job",
        item_key_from: "job.id",
        foreach_actions: [{
          order: "1",
          name: "candidates",
          type: "foreach",
          timeout_s: 1,
          items_from: "locals.job.candidates",
          item_as: "candidate",
          item_key_from: "candidate.id",
          foreach_actions: [{
            order: "1",
            name: "check",
            type: "invoke",
            invoke: "candidate-checker",
            timeout_s: 10,
          }],
        }],
      }),
      durableActionRuntime: {
        async run(_stepId, operation) {
          return operation();
        },
        async invoke(request) {
          invokeTimeout = request.timeoutMs;
          return { accepted: true };
        },
      },
    });
    expect(output.ok).toBe(true);
    expect(invokeTimeout).toBe(1_000);
  });
});
