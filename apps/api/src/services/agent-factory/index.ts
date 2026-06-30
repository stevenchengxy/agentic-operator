// Composition root for the Agent Factory ports — wires the brain (@agentic/agent-factory)
// to the new arch's concrete infrastructure (models/ ontology, dry-run sandbox,
// Drizzle stores). The SSE route constructs these and hands them to runBrain.

import type { FactoryPorts, OntologySource, SandboxDeployer } from "@agentic/agent-factory";
import { ManifestOntologySource } from "./ontology-source";
import { AllmetaOntologySource } from "./allmeta-ontology-source";
import { CompositeOntologySource } from "./composite-ontology-source";
import { DryRunSandboxDeployer, ManifestSandboxDeployer, ProbingSandboxDeployer } from "./sandbox-deployer";
import { DrizzleConversationStore, DrizzleReflectionWriter, DrizzleSkillStore, DrizzleToolStore } from "./stores";
import { FsAgentDraftStore } from "./agent-draft-store";
import { UploadedOntologySource, UploadedFirstOntologySource } from "./uploaded-ontology-source";
import { listGlobalTools } from "@agentic/tools";

/** Deploy mode:
 *   FACTORY_REAL_DEPLOY=1 → always REAL (ManifestSandboxDeployer).
 *   FACTORY_REAL_DEPLOY=0 → always SIMULATE (DryRunSandboxDeployer).
 *   unset (DEFAULT)       → PROBE: real when the Inngest stack (pnpm dev) is reachable,
 *                            else the honest dry-run simulation (badged via result.simulated).
 *  So a finished run reflects a REAL deploy whenever the stack is up — no longer silently
 *  simulating by default — while still running standalone (simulated, clearly marked). */
function makeSandboxDeployer(): SandboxDeployer {
  const flag = process.env.FACTORY_REAL_DEPLOY;
  if (flag === "1") return new ManifestSandboxDeployer();
  if (flag === "0") return new DryRunSandboxDeployer();
  return new ProbingSandboxDeployer();
}

/** Local manifest domains + (when ALLMETA_BASE_URL is set) live AllmetaOntology
 *  domains. Without Allmeta configured this is exactly the old ManifestOntologySource,
 *  so nothing changes for repos that don't wire Allmeta. */
function makeOntologySource(tenantSlug?: string): OntologySource {
  const manifest = new ManifestOntologySource();
  const allmeta = new AllmetaOntologySource();
  const base = allmeta.configured ? new CompositeOntologySource(allmeta, manifest) : manifest;
  // UPLOADED ontology bundles (tenant-scoped) take priority — an uploaded domain, or an uploaded
  // override of an existing id, wins for THAT tenant; every other domain falls through to
  // manifest/Allmeta unchanged. Without a tenant the uploaded layer is empty (no cross-tenant leak).
  return new UploadedFirstOntologySource(new UploadedOntologySource(tenantSlug), base);
}

/** `tenantSlug` scopes the uploaded-ontology layer to the caller's tenant — pass it from the route
 *  (req.auth.tenantSlug) / the run (its tenant) so uploads stay tenant-private. */
export function makeFactoryPorts(tenantSlug?: string): FactoryPorts {
  return {
    ontology: makeOntologySource(tenantSlug),
    sandbox: makeSandboxDeployer(),
    conversation: new DrizzleConversationStore(),
    reflection: new DrizzleReflectionWriter(),
    skills: new DrizzleSkillStore(),
    tools: new DrizzleToolStore(),
    // #C: the REAL global tool registry → the brain can recommend real tools (parseResumeApi,
    // fs.*) by semantic rank + know what config to supply, even when the ontology declared none.
    toolRegistry: {
      list: async () =>
        listGlobalTools().map((t) => ({
          name: t.name,
          summary: t.summary,
          aliases: t.aliases,
          category: t.category,
          configKeys: t.configSchema ? Object.keys(t.configSchema) : [],
        })),
    },
    // Persist a finished run's agents as durable, reviewable drafts (OLD syncDomainDrafts).
    drafts: new FsAgentDraftStore(),
    // web search intentionally omitted (no provider configured) → web_search no-ops honestly
  };
}

/** List the durable agent drafts a domain's finished runs produced (for the API + UI). */
export function listAgentDrafts(domain: string) {
  return new FsAgentDraftStore().list(domain);
}

export { ManifestOntologySource, AllmetaOntologySource, CompositeOntologySource, DryRunSandboxDeployer, ManifestSandboxDeployer, ProbingSandboxDeployer, DrizzleConversationStore, DrizzleReflectionWriter, DrizzleSkillStore, DrizzleToolStore };
export { recordRunStart, recordRunFinish, listRuns, getRun, deleteRun, restoreRun, deleteRunsByDomain, markRunAborted, listRunningRuns, type RunRecord } from "./stores";
