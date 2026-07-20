import type { RunListRow } from "@/lib/hooks/useRuns";

export type AgentCallRelation = "parent" | "event";

export interface AgentCallEdge {
  id: string;
  callerRunId: string | null;
  callerAgent: string;
  calleeRunId: string;
  calleeAgent: string;
  viaEvent: string | null;
  correlationId: string | null;
  at: number;
  durationMs: number | null;
  status: string;
  tokens: number;
  relation: AgentCallRelation;
}

export interface AgentCallStats {
  agent: string;
  runs: number;
  incoming: number;
  outgoing: number;
  failures: number;
  tokens: number;
  callers: string[];
  callees: string[];
}

export function runStartedMs(run: RunListRow): number {
  if (!run.startedAt) return 0;
  const value = Date.parse(run.startedAt);
  return Number.isFinite(value) ? value : 0;
}

export function runTokens(run: RunListRow): number {
  return Math.max(0, run.tokensIn ?? 0) + Math.max(0, run.tokensOut ?? 0);
}

function agentLabel(run: RunListRow): string {
  return run.agentTitle || run.agentName || "unknown";
}

export function buildAgentCallStats(
  runs: RunListRow[],
  edges: AgentCallEdge[],
): AgentCallStats[] {
  const map = new Map<
    string,
    AgentCallStats & { callerSet: Set<string>; calleeSet: Set<string> }
  >();
  const get = (agent: string) => {
    const existing = map.get(agent);
    if (existing) return existing;
    const created = {
      agent,
      runs: 0,
      incoming: 0,
      outgoing: 0,
      failures: 0,
      tokens: 0,
      callers: [],
      callees: [],
      callerSet: new Set<string>(),
      calleeSet: new Set<string>(),
    };
    map.set(agent, created);
    return created;
  };

  for (const run of runs) {
    const stat = get(agentLabel(run));
    stat.runs += 1;
    stat.tokens += runTokens(run);
    if (run.status === "failed") stat.failures += 1;
  }
  for (const edge of edges) {
    const caller = get(edge.callerAgent);
    const callee = get(edge.calleeAgent);
    caller.outgoing += 1;
    caller.calleeSet.add(edge.calleeAgent);
    callee.incoming += 1;
    callee.callerSet.add(edge.callerAgent);
  }

  return Array.from(map.values())
    .map(({ callerSet, calleeSet, ...stat }) => ({
      ...stat,
      callers: Array.from(callerSet).sort(),
      callees: Array.from(calleeSet).sort(),
    }))
    .sort(
      (a, b) =>
        b.incoming + b.outgoing - (a.incoming + a.outgoing) ||
        b.runs - a.runs ||
        a.agent.localeCompare(b.agent),
    );
}
