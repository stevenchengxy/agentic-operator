import {
  SANDBOX_BROKER_REGISTRATION_SCHEMA,
  type AgentDraftRegressionEvidence,
} from "@agentic/agent-factory";

/** Exact registration fixture for tests that exercise later immutable
 * regression/promotion gates. This is a real-shaped dev_graphql receipt, not a
 * production-visible bypass. */
export function makePromotableSandboxRegistrationEvidence(
  appId: string,
  functionIds: string[],
): Pick<
  AgentDraftRegressionEvidence,
  "sandboxAppId" | "committedManifestFunctionIds" | "brokerRegistration"
> {
  return {
    sandboxAppId: appId,
    committedManifestFunctionIds: functionIds,
    brokerRegistration: {
      schema: SANDBOX_BROKER_REGISTRATION_SCHEMA,
      appId,
      expectedFunctionCount: functionIds.length,
      observedFunctionCount: functionIds.length,
      connected: true,
      verified: true,
      evidence: "dev_graphql",
      checkedAt: new Date(0).toISOString(),
    },
  };
}
