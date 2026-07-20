import {
  listReasoningActions,
  type ReasoningActionSummary,
} from "@agentic/agents/system";
import { getTenantReasoningConfig } from "./tenant-config";

export interface TenantReasoningContext {
  domainId: string;
  provider: "allmeta";
  actions: ReasoningActionSummary[];
}

export interface ReasoningOntologyClient {
  listActions(domainId: string): Promise<ReasoningActionSummary[]>;
}

const defaultClient: ReasoningOntologyClient = {
  listActions: (domainId) => listReasoningActions(domainId),
};

let client: ReasoningOntologyClient = defaultClient;

/** Dependency seam for isolated API tests; production always uses Allmeta. */
export function setReasoningOntologyClient(
  next: ReasoningOntologyClient | null,
): void {
  client = next ?? defaultClient;
}

export async function loadTenantReasoningContext(
  tenantSlug: string,
): Promise<TenantReasoningContext> {
  const config = getTenantReasoningConfig(tenantSlug);
  if (!config) {
    throw new Error(
      `reasoning_not_configured: tenant '${tenantSlug}' has no standalone Reasoning configuration`,
    );
  }
  const listed = await client.listActions(config.ontology.domainId);
  const allowed = config.allowedActions
    ? new Set(config.allowedActions)
    : null;
  const actions = allowed
    ? listed.filter((action) => allowed.has(action.name))
    : listed;
  if (!actions.length) {
    throw new Error(
      `reasoning_ontology_empty: Allmeta domain '${config.ontology.domainId}' returned no permitted Actions`,
    );
  }
  return {
    domainId: config.ontology.domainId,
    provider: "allmeta",
    actions,
  };
}
