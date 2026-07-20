/**
 * System agents — importing this module registers every system agent into
 * the singleton registry as a side effect of import.
 *
 * apps/api/src/bootstrap.ts imports this once at boot.
 */

import "./report-agent";
import "./reasoning-agent";
import { agentRegistry } from "../registry";
import { TestAgent } from "./test-agent";
import { registerTestAgentForEnvironment } from "./test-agent-policy";

// This smoke agent exists solely for the isolated unit/E2E harness. Merely
// importing @agentic/agents/system in a real process must never advertise or
// persist it as an operator-callable production agent.
registerTestAgentForEnvironment({
  create: () => new TestAgent(),
  register: (agent) => agentRegistry.register(agent),
});

export {
  ReportAgent,
  buildReportMessages,
  extractHtmlDocument,
  substituteCharts,
  type ReportInput,
  type ReportOutput,
  type ReportChart,
} from "./report-agent";

export {
  ReasoningAgent,
  finalizeReasoningOutput,
  foldRuleDecision,
  type ReasoningAgentInput,
  type ReasoningAgentOutput,
  type RuleAssessment,
  type RuleBundle,
  type RuleDecision,
} from "./reasoning-agent";

export {
  listReasoningActions,
  reasoningAllmetaConfigFromEnv,
  reasoningAllmetaJson,
  type ReasoningActionSummary,
  type ReasoningAllmetaConfig,
} from "./reasoning-allmeta";
