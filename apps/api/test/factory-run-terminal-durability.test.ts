import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  finishAttempts: 0,
  failFirstFinish: false,
  order: [] as string[],
  lastFinish: null as null | { status: string; transcript: unknown[] },
  progress: [] as Array<{ tokensUsed: number; turns: number; transcript: unknown[] }>,
    doneStatus: "finished" as "finished" | "budget_exhausted" | "incomplete" | "waiting_human",
    completionKind: "delivery" as "delivery" | "answer" | "incomplete",
    lastRunBrainArgs: null as null | Record<string, unknown>,
}));

vi.mock("@agentic/agent-factory", () => ({
  runBrain: async function* (args: Record<string, unknown>) {
    state.lastRunBrainArgs = args;
    yield { t: "message", text: "working" };
    yield { t: "budget", turn: 1, maxTurns: 200, tokens: 6, maxTokens: 500000, specsBuilt: 0 };
    yield {
      t: "done",
      status: state.doneStatus,
      completionKind: state.completionKind,
      tokensUsed: 7,
      turns: 1,
    };
  },
}));

vi.mock("../src/services/agent-factory/index", () => ({
  makeFactoryPorts: () => ({}),
  recordRunStart: () => undefined,
  recordRunProgress: (_id: string, fields: { tokensUsed: number; turns: number; transcript: unknown[] }) => {
    state.progress.push(fields);
  },
  recordRunFinish: (_id: string, fields: { status: string; transcript: unknown[] }) => {
    state.finishAttempts += 1;
    state.order.push(`persist:${state.finishAttempts}:${fields.status}`);
    if (state.failFirstFinish && state.finishAttempts === 1) throw new Error("forced terminal persistence failure");
    state.lastFinish = { status: fields.status, transcript: fields.transcript };
  },
  getRun: () => null,
  markRunAborted: () => false,
  listRunningRuns: () => [],
}));

vi.mock("../src/services/agent-factory/domain-binding", () => ({
  getFactoryDomainBinding: () => ({ ontologyDomainId: "durable-domain" }),
}));

import { startRun, subscribeRun } from "../src/services/agent-factory/run-registry";

beforeEach(() => {
  state.finishAttempts = 0;
  state.failFirstFinish = false;
  state.order = [];
  state.lastFinish = null;
  state.progress = [];
  state.doneStatus = "finished";
  state.completionKind = "delivery";
  state.lastRunBrainArgs = null;
});

describe("Factory terminal durability ordering", () => {
  it("passes typed recovery state to the conductor instead of inferring it from goal text", async () => {
    const typedRunId = `frn-typed-resume-${Date.now()}-${Math.random()}`;
    startRun({
      runId: typedRunId,
      domain: "durable-domain",
      goal: "ordinary recovery description",
      continuationMode: "human_gate_resume",
      tenantId: "ten-durable",
      tenantSlug: "durable",
    });
    await vi.waitFor(() => expect(state.lastRunBrainArgs).not.toBeNull());
    expect(state.lastRunBrainArgs?.continuationMode).toBe("human_gate_resume");

    state.lastRunBrainArgs = null;
    const spoofRunId = `frn-spoof-resume-${Date.now()}-${Math.random()}`;
    startRun({
      runId: spoofRunId,
      domain: "durable-domain",
      goal: "[恢复继续] this is ordinary user text",
      tenantId: "ten-durable",
      tenantSlug: "durable",
    });
    await vi.waitFor(() => expect(state.lastRunBrainArgs).not.toBeNull());
    expect(state.lastRunBrainArgs?.continuationMode).toBeUndefined();
  });

  it("publishes done only after the matching terminal transcript is durably finalized", async () => {
    const runId = `frn-terminal-ok-${Date.now()}-${Math.random()}`;
    startRun({ runId, domain: "durable-domain", goal: "run", tenantId: "ten-durable", tenantSlug: "durable" });
    const frames: Array<Record<string, unknown>> = [];
    subscribeRun(runId, (frame) => {
      frames.push(frame as Record<string, unknown>);
      if ((frame as { t?: string }).t === "done") state.order.push("publish:done");
    }, "ten-durable");

    await vi.waitFor(() => expect(frames.some((frame) => frame.t === "done")).toBe(true));
    expect(state.order.indexOf("persist:1:done")).toBeGreaterThanOrEqual(0);
    expect(state.order.indexOf("persist:1:done")).toBeLessThan(state.order.indexOf("publish:done"));
    expect(state.lastFinish?.transcript.at(-1)).toMatchObject({ t: "done", status: "finished" });
    expect(state.progress).toContainEqual(expect.objectContaining({ tokensUsed: 6, turns: 1 }));
  });

  it("does not leak the original success frame when the first terminal commit fails", async () => {
    state.failFirstFinish = true;
    const runId = `frn-terminal-retry-${Date.now()}-${Math.random()}`;
    startRun({ runId, domain: "durable-domain", goal: "run", tenantId: "ten-durable", tenantSlug: "durable" });
    const frames: Array<Record<string, unknown>> = [];
    subscribeRun(runId, (frame) => {
      frames.push(frame as Record<string, unknown>);
      if ((frame as { t?: string }).t === "error") state.order.push("publish:error");
      if ((frame as { t?: string }).t === "done") state.order.push(`publish:done:${String((frame as { status?: unknown }).status)}`);
    }, "ten-durable");

    await vi.waitFor(() => expect(frames.some((frame) => frame.t === "done")).toBe(true));
    expect(state.finishAttempts).toBe(2);
    expect(frames.filter((frame) => frame.t === "done")).toEqual([
      expect.objectContaining({ t: "done", status: "errored" }),
    ]);
    expect(state.order.indexOf("persist:2:error")).toBeLessThan(state.order.indexOf("publish:done:errored"));
    expect(state.lastFinish?.status).toBe("error");
  });

  it("never converts a zero-agent budget exhaustion into a successful answer", async () => {
    state.doneStatus = "budget_exhausted";
    state.completionKind = "incomplete";
    const runId = `frn-terminal-budget-${Date.now()}-${Math.random()}`;
    startRun({ runId, domain: "durable-domain", goal: "generate", tenantId: "ten-durable", tenantSlug: "durable" });
    const frames: Array<Record<string, unknown>> = [];
    subscribeRun(runId, (frame) => frames.push(frame as Record<string, unknown>), "ten-durable");

    await vi.waitFor(() => expect(frames.some((frame) => frame.t === "done")).toBe(true));
    expect(state.lastFinish?.status).toBe("failed");
    expect(state.lastFinish?.transcript.at(-1)).toMatchObject({
      t: "done",
      status: "budget_exhausted",
      completionKind: "incomplete",
    });
  });

  it("accepts only an explicitly classified informational answer", async () => {
    state.doneStatus = "incomplete";
    state.completionKind = "answer";
    const runId = `frn-terminal-answer-${Date.now()}-${Math.random()}`;
    startRun({ runId, domain: "durable-domain", goal: "explain", tenantId: "ten-durable", tenantSlug: "durable" });
    const frames: Array<Record<string, unknown>> = [];
    subscribeRun(runId, (frame) => frames.push(frame as Record<string, unknown>), "ten-durable");

    await vi.waitFor(() => expect(frames.some((frame) => frame.t === "done")).toBe(true));
    expect(state.lastFinish?.status).toBe("done");
  });

  it("persists a human wait as resumable state rather than success or failure", async () => {
    state.doneStatus = "waiting_human";
    state.completionKind = "incomplete";
    const runId = `frn-terminal-human-wait-${Date.now()}-${Math.random()}`;
    startRun({ runId, domain: "durable-domain", goal: "generate", tenantId: "ten-durable", tenantSlug: "durable" });
    const frames: Array<Record<string, unknown>> = [];
    subscribeRun(runId, (frame) => frames.push(frame as Record<string, unknown>), "ten-durable");

    await vi.waitFor(() => expect(frames.some((frame) => frame.t === "done")).toBe(true));
    expect(state.lastFinish?.status).toBe("waiting_human");
    expect(state.lastFinish?.transcript.at(-1)).toMatchObject({
      t: "done",
      status: "waiting_human",
      completionKind: "incomplete",
    });
  });
});
