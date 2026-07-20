import { describe, expect, it } from "vitest";
import type { RunListRow } from "@/lib/hooks/useRuns";
import {
  buildAgentCallStats,
  runStartedMs,
  runTokens,
  type AgentCallEdge,
} from "./observability";

function run(
  overrides: Partial<RunListRow> & Pick<RunListRow, "id" | "agentName">,
): RunListRow {
  const { id, agentName, ...rest } = overrides;
  return {
    agentTitle: null,
    status: "ok",
    subject: null,
    triggerEvent: null,
    emittedEvent: null,
    startedAt: "2026-07-10T00:00:00.000Z",
    endedAt: "2026-07-10T00:00:01.000Z",
    durationMs: 1_000,
    tokensIn: 100,
    tokensOut: 50,
    model: "model-a",
    currentStepName: null,
    currentStepOrd: null,
    stepCount: 1,
    correlationId: "corr-1",
    ...rest,
    id,
    agentName,
  };
}

describe("observability presentation selectors", () => {
  it("aggregates only invocation edges supplied by the authoritative API", () => {
    const runs = [
      run({ id: "a", agentName: "source" }),
      run({
        id: "b",
        agentName: "consumer",
        status: "failed",
        tokensIn: 25,
        tokensOut: 5,
      }),
    ];
    const edge: AgentCallEdge = {
      id: "invoke:b",
      callerRunId: "a",
      callerAgent: "source",
      calleeRunId: "b",
      calleeAgent: "consumer",
      viaEvent: "READY",
      correlationId: "corr-1",
      at: Date.parse("2026-07-10T00:00:00.000Z"),
      durationMs: 1_000,
      status: "failed",
      tokens: 30,
      relation: "event",
    };

    const stats = buildAgentCallStats(runs, [edge]);
    expect(stats.find((item) => item.agent === "source")).toMatchObject({
      outgoing: 1,
      callees: ["consumer"],
      tokens: 150,
    });
    expect(stats.find((item) => item.agent === "consumer")).toMatchObject({
      incoming: 1,
      callers: ["source"],
      failures: 1,
      tokens: 30,
    });
  });

  it("does not invent relationships when the API returned no edges", () => {
    const runs = [
      run({ id: "source", agentName: "source", emittedEvent: "READY" }),
      run({ id: "target", agentName: "target", triggerEvent: "READY" }),
    ];
    const stats = buildAgentCallStats(runs, []);
    expect(
      stats.every((item) => item.incoming === 0 && item.outgoing === 0),
    ).toBe(true);
  });

  it("keeps absent timestamps and tokens honest", () => {
    const row = run({
      id: "pending",
      agentName: "pending",
      startedAt: null,
      tokensIn: null,
      tokensOut: null,
    });
    expect(runStartedMs(row)).toBe(0);
    expect(runTokens(row)).toBe(0);
  });
});
