import type { TenantReasoningConfigLike } from "@agentic/agent-kit";

/**
 * Standalone production Reasoning policy for the recruitment tenant.
 * Kept outside Agent Factory and shared by the tenant registry + workflow tool.
 */
export const zhaopinReasoningConfig: TenantReasoningConfigLike = {
  ontology: {
    provider: "allmeta",
    // Signed tenant-adapter policy. The tool accepts only this exact domain.
    domainId: "Agents-generation",
  },
};
