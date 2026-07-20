import type { TenantReasoningConfigLike } from "@agentic/agent-kit";

/**
 * Standalone Reasoning policy for the RAAS operator workspace.
 *
 * This intentionally lives in the tenant runtime and does not reuse an
 * Agent Factory ontology binding. Both RAAS and zhaopin may evaluate the
 * same stage-independent rules-test graph while keeping their execution
 * configuration isolated.
 */
export const raasReasoningConfig: TenantReasoningConfigLike = {
  ontology: {
    provider: "allmeta",
    domainId: "rules-test",
  },
};
