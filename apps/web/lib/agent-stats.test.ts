import { describe, expect, it } from "vitest";
import type { AgentListRow } from "./hooks/useAgents";
import type { RunListRow } from "./hooks/useRuns";
import { buildAgentStats } from "./agent-stats";

const agent: AgentListRow = {
  id: "agt-db-1",
  kebabId: "report-generator",
  name: "reportGenerator",
  title: "Report generator",
  description: null,
  actor: "Agent",
  kind: "code",
  enabled: true,
  runCount: 948,
  errorCount: 17,
  lastRunAt: "2026-07-13T10:00:00.000Z",
};

function run(overrides: Partial<RunListRow>): RunListRow {
  return {
    id: "run-1",
    status: "ok",
    agentName: "reportGenerator",
    agentTitle: "Report generator",
    subject: null,
    triggerEvent: null,
    startedAt: "2026-07-13T09:00:00.000Z",
    endedAt: "2026-07-13T09:00:01.000Z",
    durationMs: 1_000,
    tokensIn: 10,
    tokensOut: 20,
    model: "provider/model",
    currentStepName: null,
    currentStepOrd: null,
    stepCount: 1,
    ...overrides,
  };
}

describe("buildAgentStats", () => {
  it("keeps authoritative SQL totals instead of recounting a bounded run sample", () => {
    const stats = buildAgentStats(
      [agent],
      [run({ status: "failed" }), run({ id: "run-2" })],
    ).get(agent.kebabId);

    expect(stats).toMatchObject({
      runs: 948,
      errors: 17,
      lastRun: Date.parse(agent.lastRunAt!),
    });
  });

  it("uses recent rows only for explicitly sampled test-run facts", () => {
    const stats = buildAgentStats(
      [agent],
      [
        run({ id: "run-old", testRun: true, startedAt: "2026-07-13T08:00:00.000Z" }),
        run({ id: "run-live", testRun: false, startedAt: "2026-07-13T10:30:00.000Z" }),
        run({ id: "run-new", testRun: true, startedAt: "2026-07-13T09:30:00.000Z" }),
      ],
    ).get(agent.name);

    expect(stats).toMatchObject({
      sampledTests: 2,
      lastSampledTestRunId: "run-new",
      lastSampledTestAt: Date.parse("2026-07-13T09:30:00.000Z"),
    });
  });
});
