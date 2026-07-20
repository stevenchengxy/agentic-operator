import type { AgentListRow } from "./hooks/useAgents";
import type { RunListRow } from "./hooks/useRuns";

/**
 * Agent list rows already contain authoritative all-time aggregates from SQL.
 * The recent-runs endpoint is deliberately bounded, so it may only be used for
 * sample-only facts (for example, the latest visible test run).
 */
export interface AgentStatsSnapshot {
  runs: number;
  errors: number;
  lastRun: number;
  sampledTests: number;
  lastSampledTestRunId: string | null;
  lastSampledTestAt: number;
}

function parseTimestamp(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function buildAgentStats(
  agents: readonly AgentListRow[],
  recentRunSample: readonly RunListRow[],
): Map<string, AgentStatsSnapshot> {
  const byIdentity = new Map<string, AgentStatsSnapshot>();

  for (const agent of agents) {
    const snapshot: AgentStatsSnapshot = {
      runs: Math.max(0, agent.runCount),
      errors: Math.max(0, agent.errorCount),
      lastRun: parseTimestamp(agent.lastRunAt),
      sampledTests: 0,
      lastSampledTestRunId: null,
      lastSampledTestAt: 0,
    };
    byIdentity.set(agent.id, snapshot);
    byIdentity.set(agent.kebabId, snapshot);
    if (agent.name) byIdentity.set(agent.name, snapshot);
  }

  for (const run of recentRunSample) {
    if (!run.testRun) continue;
    const snapshot = byIdentity.get(run.agentName ?? "");
    if (!snapshot) continue;
    snapshot.sampledTests += 1;
    const startedAt = parseTimestamp(run.startedAt);
    if (startedAt > snapshot.lastSampledTestAt) {
      snapshot.lastSampledTestAt = startedAt;
      snapshot.lastSampledTestRunId = run.id;
    }
  }

  return byIdentity;
}
