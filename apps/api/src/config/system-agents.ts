/**
 * P0-AUTH-04 — allowlist of code-defined agents that run under the
 * synthetic `__system` tenant rather than the caller's own tenant.
 *
 * These are platform-owned utilities that need the synthetic `__system`
 * tenant. Any code agent NOT on this list runs
 * under the invoking tenant — so per-tenant code agents do not silently
 * pool under `__system`.
 *
 * To add a new system-scoped agent: register it under
 * `packages/agents/src/system/*` (which already calls
 * `agentRegistry.register(new XAgent())`) and append the agent's `name`
 * here. The class-level `BaseAgent.scope` marker is authoritative for
 * binding; this allowlist remains for API compatibility and legacy callers.
 */

const SYSTEM_SCOPED_AGENT_NAMES: ReadonlySet<string> = new Set([
  "reasoningAgent",
  "reportGenerator",
]);

const TEST_ONLY_SYSTEM_SCOPED_AGENT_NAMES: ReadonlySet<string> = new Set([
  "testAgent",
]);

/** Return true iff the agent is scoped to the synthetic `__system` tenant. */
export function isSystemScopedAgent(
  agentName: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    SYSTEM_SCOPED_AGENT_NAMES.has(agentName) ||
    (env.NODE_ENV === "test" &&
      TEST_ONLY_SYSTEM_SCOPED_AGENT_NAMES.has(agentName))
  );
}
