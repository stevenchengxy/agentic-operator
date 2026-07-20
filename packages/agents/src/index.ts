/**
 * @agentic/agents — public surface.
 *
 * Consumers (apps/api):
 *   import { BaseAgent, agentRegistry, bootstrapCodeAgents, setGateway } from "@agentic/agents";
 *   import "@agentic/agents/system"; // registers production system agents
 *
 * `testAgent` is registered only when NODE_ENV=test.
 */

export { BaseAgent } from "./base-agent";
export { agentRegistry } from "./registry";
export { setGateway, getGateway, hasGateway } from "./gateway-host";
export { bootstrapCodeAgents, resolveCodeRevision } from "./bootstrap";
export {
  ensureCodeAgentBinding,
  type CodeAgentBinding,
} from "./tenant-binding";
export { RunCancelledError } from "./run-engine";
export {
  registerCodeAgentFn,
  buildCodeAgentFns,
  codeAgentEventName,
  codeAgentFnId,
  type CodeAgentEventData,
} from "./code-agent-fn";
export type {
  AgentContext,
  AgentResult,
  AgentKind,
  AgentRunScope,
  AgentScope,
  ToolHandler,
  ToolHandlerMap,
  ToolHandlerResult,
} from "./types";
