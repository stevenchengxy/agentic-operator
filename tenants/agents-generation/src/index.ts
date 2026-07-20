import type {
  TenantReasoningConfigLike,
  TenantRegistry,
} from "@agentic/agent-kit";
import { createRecruitmentOntologyCapabilityPack } from "@agentic/recruitment-capabilities";

/**
 * Signed execution policy for functions generated from the
 * Agents-generation ontology. Descriptions may suggest capabilities, but only
 * this registry composition grants executable handlers.
 */
export const agentsGenerationReasoningConfig: TenantReasoningConfigLike = {
  ontology: {
    provider: "allmeta",
    domainId: "Agents-generation",
  },
};

const registry: TenantRegistry = {
  // This is intentionally not the legacy RAAS compatibility pack. Generated
  // functions may load raw facts, then must obtain rules and evaluate an
  // ontology/decision table. Candidate precedence, owner locks, thresholds
  // and emitted verdicts are not executable tenant tools here. Generic writes
  // are separately granted through the global, probed persistence catalog.
  tools: createRecruitmentOntologyCapabilityPack({
    tenantSlug: "agents-generation",
    reasoning: agentsGenerationReasoningConfig,
    // Fail closed: generated functions receive config only from a reviewed,
    // environment-specific integration profile. No endpoint/credential/tenant
    // defaults are inferred from Action prose.
    requireExplicitProfile: true,
  }),
  reasoning: agentsGenerationReasoningConfig,
  factory: {
    source: {
      kind: "workspace_package",
      id: "@tenants/agents-generation",
      version: "0.1.0",
    },
  },
};

export default registry;
