# FINAL RULINGS (user, 2026-07-20)

- D1 agents canonical (drop agent-runtime, port Kenny deltas) · D2 Kenny TenantRoutingGateway + re-port our telemetry sink + readiness guards
- D3 drop our telemetry llm_calls (VERIFY no /reasoning metric lost first) · D4 **take Kenny budget (deduct-then-execute), accept bounded overshoot, retire our reservation store**
- D5 renumber Kenny migrations 0055-0060 · D6 superset AgentSpec/ActionSpec · D7 honor api-client.ts deletion (port schemas into hooks)
- D8 **adopt Agent Studio, retire our AgentTabs/AgentCodeTab, re-add DeployAgentModal/samples** · D9 adopt Kenny workflow authoring + re-port our i18n/dirty
- D10 our i18n settings registry + Kenny real Tokens/Integrations/AI · D11 demo-mode stays deleted
- D12 **GOHIRE canonical** (port our robohire data.data.*/multipart quirks into gohire, alias robohire names onto it) · D13 Kenny SSRF + our fail-closed throw
- D14 our RBAC base + shim requireWorkspaceWriter/TenantAdmin + Kenny bearer scopes · D15 Kenny usage ledger base + our coverage cards

---

# Kenny origin/main → local main merge playbook (2026-07-20)

Merging **Kenny origin/main** (11 commits: LLM-gateway overhaul, runtime v2, tool-registry refactor, Agent Studio, workflow authoring, API tokens, GoHire) into **local main** (our Agent Factory, 24 commits + committed WIP).

**Philosophy:** Kenny's features LEAD; our structure is ground truth; port Kenny's net-new onto our structure; adapt glue.


Conflicts: 148 (121 content / 23 modify-delete / 4 add-add). Confident clusters: 3. Ambiguous files: 41.


## Ordered resolution plan

### 1. packages/llm-gateway (the spine — everything else depends on it)
TAKE-THEIRS as a bundle (cherry-picking half won't typecheck): pricing.ts, usage-attribution.ts, usage-ledger.ts, usage-export.ts, budget.ts, capabilities.ts, adapters/openai-responses.ts, providers/moonshot.ts + zai.ts, rewritten adapters/{anthropic,gemini,openai-compatible}.ts, package.json dep bumps (anthropic 0.111, openai 6, @google/genai, drizzle-orm re-added). ADAPT-GLUE gateway.ts: take Kenny's per-attempt ledger/retry/attribution base, then PORT our two net-new features back on — (a) setGatewayCallSink→writeLlmCall telemetry hook (feeds Factory observability spine, commit d330f84), (b) #NOMOCK allowMock gating. HAND-MERGE types.ts (Kenny superset + re-add GatewayConfig.allowMock), config.ts (our #NOMOCK block + Kenny's MOONSHOT/ZAI env + requireUsageAttribution; add moonshot/zai to IMPLEMENTED_PROVIDER_IDS), providers/index.ts (adopt makeMoonshot/makeZai, keep mock-gating, honor our bedrock/vertex stub deletion), azure.ts (Kenny's usage block + our tool-use mapping), errors.ts (accounting_error). Blocked-on note: pricing/gateway import findCatalogModel/CatalogPricing/ReasoningConfig from contracts and budget/ledger need db schema — those land in steps 2-3.

### 2. packages/contracts (schemas — unblocks gateway, runtime, api, web)
TAKE-THEIRS the LLM-gateway lead: providers.ts (2109-line catalog with reasoning/tier/lifecycle/CatalogPricing + moonshot/zai) as base, PORT our gpt-5.6/gpt-4o-mini rows onto Kenny's extended CatalogModel shape and re-verify our installed flips against his 'adapter ships' semantics. TAKE-THEIRS net-new modules: llm-settings.ts, agent-definition.ts, agent-studio.ts, workflow-authoring.ts, integrations.ts, operator-checks.ts, api-tokens.ts, plus llm.ts reasoning/verbosity schemas. HAND-MERGE index.ts (union our permissions/access/agent-factory-draft-sandbox with Kenny's new modules). HAND-MERGE agents.ts — the AgentSpec/ActionSpec fork (see decision D6): superset schema keeping our .passthrough() + tool_use/typescript_code/ontology_instructions + expanded action enum AND Kenny's inputs/outputs ports + reasoning/model/stage/cron + authoring schemas. HAND-MERGE tasks.ts (our resume/status fields + Kenny's 'supplement' decision).

### 3. packages/db (schema + migration renumber — the hard mechanical gate)
HAND-MERGE _journal.json + renumber Kenny's 0016-0021 → 0055-0060 (append after our 0054), moving each .sql + meta/00NN_snapshot.json and regenerating snapshots by hand (db:generate is unsafe per memory). HAND-MERGE schema.ts: union disjoint new tables (his agentDrafts/agentRunSessions/usageEvents/runMessages/runTraceEvents/runEmittedEvents/integrations + our factory family); union additive columns on shared runs/agents/tenant_budgets; RESOLVE the llm_calls collision (D3) — adopt Kenny's ~70-col billing ledger, drop/rename our lightweight telemetry llm_calls (raw turns already in llm_turns), repoint our step-engine capture + /reasoning page + run_summaries. RESOLVE budget model (D4). HAND-MERGE wipe-runtime.ts (union table list ∩ merged schema, keep our demo-free docs + wipeRuntimeFiles, port Kenny's tenant_budgets projection reset). Verify a fresh pnpm db:migrate applies 0003-0060 in order.

### 4. packages/runtime + packages/agents (runtime execution spine)
DROP-FILE all 4 packages/agent-runtime/* (honor our consolidation, decision D1) and repoint Kenny's apps/api importers (usage-attribution plugin, agent-invoke, inngest-registry, tc-16/17) onto @agentic/agents. BRING-IN from origin/main the two net-new files packages/runtime/src/agent-execution.ts + execution-trace.ts (referenced by register/step-engine/index/package.json). TAKE-OURS-PORT-THEIR-FEATURE on register.ts, step-engine.ts, manifest.ts, bootstrap.ts, artifacts.ts (Kenny's is atomic-write superset — take-theirs there), packages/agents base-agent.ts/run-engine.ts/types.ts: thread reasoning/verbosity/store + routing{taskType} into gateway.chat, wrap invocation in usage-attribution context, capture reasoningContent, add taskClass/defaultReasoning/defaultVerbosity/storeResponses. HAND-MERGE generated-agent.ts (our bilingual body + Kenny's actionDescription/lastResult context; reconcile 2-arg signature at register.ts call site). Barrel index.ts/package.json: union exports + adopt ajv deps but keep our vitest test script.

### 5. packages/tools
TAKE-OURS-PORT-THEIR-FEATURE index.ts: keep our removal of the legacy runTool mock dispatcher (fail-closed), port Kenny's net-new exports (gohire, search, getGlobalToolCatalogEntry, integrations DI seam setIntegrationResolver/resolveIntegrationCreds). HAND-MERGE registry.ts (union REGISTRATIONS; annotate Kenny's gohire*/search.web/ontology.query with our ToolExecutionPolicy side-effect metadata so they don't bypass the gate) and ontology/index.ts (union exports, bring Kenny's query.ts). ADAPT-GLUE http/fetch.ts (D13): Kenny's SSRF-hardened body as base, re-apply our fail-closed throw-on-non-2xx. TAKE-OURS robohire/rest-helper.ts (env-ref-only is strictly stronger). RESOLVE gohire vs robohire duplication (D12). BRING-IN gohire/* + integrations/host.ts; call setIntegrationResolver at api boot.

### 6. apps/api glue (bootstrap/server/routes/services)
TAKE-OURS-PORT-THEIR-FEATURE on the boot spine (bootstrap.ts, server.ts, inngest-registry.ts, agent-invoke.ts, events.ts, agents.ts, workflow.ts, manifest-import.ts, tenants.ts, tools.ts, runs.ts, tasks.ts, reads.ts) — our structure is a superset; HAND-MERGE server.ts import+register lists (neither side is a superset), add Kenny's new routes (agent-studio, workflow-authoring, integrations, api-tokens, operator-checks, agent-authoring) + registerUsageAttribution plugin, do NOT re-add demo. MUST-PORT two security fixes: cross-tenant event-namespace guard (events.ts) and artifact path-traversal guards (artifacts.ts hand-merge with our CSP/nosniff/rbac). TAKE-THEIRS-ADAPT-GLUE the gateway/billing core: services/llm.ts (per-tenant TenantRoutingGateway base + re-port our setGatewayCallSink + probeDefaultLLMProvider + sandbox-model-proxy seam — D2), provider-keys.ts, provider-test.ts, model-discovery.ts, model-fleet.ts, usage.ts, budgets.ts, routes/v1/llm.ts. TAKE-THEIRS net-new services: llm-settings-store.ts, gateway-network-safety.ts, workflow-secret-policy.ts, studio-runner.ts, studio-observability.ts, integration-store.ts. DROP-FILE demo trio. RESOLVE auth model (D14) and billing spine (D3/D4) in one pass, normalizing Kenny's requireWorkspaceWriter/requireTenantAdmin onto our rbac.ts. Dockerfile/package.json: take-ours + port Node 26.5.0 pin + @types/node ^26.1.1.

### 7. apps/web (portal frontend)
Keep OUR readApiData plumbing everywhere; PORT Kenny's tenant-scoped query keys (tenantFromPathname) as a genuine cache-isolation win. DROP-FILE (honor deletions): api-client.ts (D7 — port ReplayRunPayload union into useRuns/useEvents), all _portal_legacy/*, all public/demo/*, Channels/Notifications stubs, samples.ts. TAKE-OURS-PORT-THEIR-FEATURE on our-led surfaces (dashboard, deployments, events, runs/[id], tasks, shell/chrome/nav/sidebar keeping inline CSS + porting a11y + system-check nav, useAgents/useTenants/useRuns). TAKE-THEIRS-ADAPT-GLUE Kenny-led surfaces gated on decisions: Agent Studio (D8), workflow authoring page/AgentEditor/draft/inspectors/layout + NewWorkflowModal (D9), Workspace.tsx (useUpdateTenant), re-added Tokens/Integrations/AI settings sections (D10). HAND-MERGE the gateway hooks/dashboards against the merged /v1/llm + contracts (D15): useModelFleet, useUsage, Models.tsx, Billing.tsx, settings/usage page, settings/page + data.ts registry, global.css (Kenny base layer + our factory/help-tip blocks), ImportManifestModal (dual rewrite — deliberate line-level reconcile). package.json: our deps + Kenny's next 16.2.10 / @types/node bump.

### 8. apps/api tests (downstream mirrors — resolve after the routes they test)
These follow step-6/2/3/4 decisions. HAND-MERGE additive-only: tc-12 (union both describe blocks + imports), tc-60 (Kenny's PROVIDER_IDS.length + our DELETE-key tests), tc-95 (merge both suites, renumber one). TAKE-THEIRS: tc-34 (Kenny's version-latest computation is more rigorous). DROP-FILE tc-80-demo-mode (honor deletion). TAKE-OURS-PORT-THEIR-FEATURE tc-16 (keep @agentic/agents imports + fail-closed maxSteps, port Kenny's routing/taskClass test — D1). TAKE-THEIRS-ADAPT-GLUE gated on route forks: tc-1 (providers listing — D-catalog), tc-61 + tc-75 (fleet/available-models availability model — Kenny's status/selectable base + port our safety tests), event-tester (Kenny's usage-attribution/ingest-safety base + port our fail-closed audit-persist test).

### 9. config/root (finalize toolchain + regenerate lock)
TAKE-OURS-PORT-THEIR-FEATURE: keep our ports (3540/8488) and dev launcher — never let Kenny's stale :3501/:8288 strings regress into .env/README/CLAUDE.md/package.json. Adopt Kenny's Node 26.5.0 exact pin atomically across .nvmrc, package.json#engines, ci.yml, release.yml, CLAUDE.md, README, @types/node ^26.1.1 (root + tenants/robohire) + port his ensure-node-version.mjs guard/preinstall. HAND-MERGE package.json (our script block base + Kenny's ensure:node + inngest-cli 1.37.0), .env.example/.env.production.example (our base + Kenny's usage-attribution/LLM-settings/search/Neo4j/MOONSHOT/ZAI blocks; OMIT AGENTIC_DEMO_MODE per D11). models/workflow.schema.json: hand-merge Kenny's typed step reasoning fields into our expanded schema. DROP-FILE data/provider-keys.json (delete; it's a gitignored runtime secret). LAST: after ALL package.json land, run pnpm install to REGENERATE pnpm-lock.yaml (never text-merge) — verify it carries anthropic 0.111/openai 6/inngest-cli 1.37.0/@types/node 26.1.1 and drops the agent-runtime entries.


## Decisions (D1–D15)

### [D1-agent-runtime-vs-agents] packages/agent-runtime (Kenny keeps + extends) vs packages/agents (we consolidated into it and deleted agent-runtime)

- **Evidence:** Both packages existed at merge-base a40aec3 (orthogonal divergence, not a rename). Kenny's live api path already imports @agentic/agents; agent-runtime is only imported by tc-16/17 + data/system-agents on his side. Nothing unique lives only in agent-runtime except artifactSafeMessages.

- Option 1: Honor our deletion: drop all 4 agent-runtime files, port Kenny's usage-attribution/reasoning deltas into packages/agents, repoint his apps/api importers onto @agentic/agents

- Option 2: Restore packages/agent-runtime and run both packages (reverts our deliberate consolidation + CLAUDE.md)

- Option 3: Adopt agent-runtime as the go-forward runtime and retire packages/agents (throws away our scope/binding/cancellation/budget/system-agents work)

- **Recommendation:** Option 1 — honor deletion, hunk-port Kenny's gateway deltas into packages/agents. Our package is a structural superset (scope/runScope/inngestEnabled, tenant-binding, RunCancelledError, budget reservation, system reasoning/report/policy agents); a file-level take-theirs would destroy it. This is exactly the Kenny-modifies-what-we-deleted collision to surface.

### [D2-dual-llm-gateway] getLLMGateway contract: Kenny's per-tenant TenantRoutingGateway (credential isolation + LlmSettings routing) vs our process-singleton with setGatewayCallSink telemetry + probeDefaultLLMProvider/assertRealLLMGateway readiness guards

- **Evidence:** Injection seam is identical on both sides (getLLMGateway→setAgentGateway+setRuntimeGateway); only the returned object differs. Our services/llm.ts hangs the sink + readiness probe; Kenny's has neither.

- Option 1: Take Kenny's TenantRoutingGateway as base; re-port our setGatewayCallSink→writeLlmCall telemetry sink + probeDefaultLLMProvider/assertRealLLMGateway fail-closed guards + createSandboxModelProxyGateway seam onto it; update bootstrap injection + /health

- Option 2: Keep our singleton and forgo per-tenant credential isolation

- Option 3: Run both gateways side by side (double dispatch / double accounting risk)

- **Recommendation:** Option 1. Kenny's per-tenant credential isolation is a real security/billing win and is the declared lead, but taking his file wholesale silently deletes our telemetry-table population, our anti-mock readiness guard (bootstrap.ts:444 depends on it), and our sandbox-model-proxy runtime seam. Port all three onto his base.

### [D3-llm-calls-table-collision] The table name llm_calls is claimed by two different systems: our lightweight brain-telemetry table (migration 0024, ~15 cols) vs Kenny's ~70-col billing/usage/cost ledger

- **Evidence:** Naive apply of Kenny's CREATE TABLE llm_calls collides with our existing table + our 0024 migration. Our raw-turn capture already lives in llm_turns.

- Option 1: Adopt Kenny's billing ledger as llm_calls; drop our telemetry llm_calls (raw turns already captured in our separate llm_turns table); repoint step-engine capture + /reasoning audit page + run_summaries

- Option 2: Rename our telemetry table to llm_call_telemetry and keep both

- Option 3: Reconcile both into one wide table (high risk, mixes billing and telemetry concerns)

- **Recommendation:** Option 1. Kenny's usage ledger is his flagship and the declared lead; our telemetry role is redundant with llm_turns. Confirm before dropping that no /reasoning or run_summaries metric is lost.

### [D4-budget-accounting-model] Budget spine: our reserve-then-execute (durable llm_budget_reservations, BEGIN IMMEDIATE, 618 lines) vs Kenny's deduct-then-execute (used_usd_nanos exact accounting integrated with pricing/ledger, 136 lines)

- **Evidence:** Our budget.ts needs llm_budget_reservations (schema.ts:781) which Kenny lacks; his budget consumes USD_NANOS_PER_CENT/CostBreakdown/TokenUsage.

- Option 1: Take Kenny's deduct-then-execute; orphan/delete our llm_budget_reservations table + tc-budget-reservations.test.ts; consciously accept a bounded concurrency-overshoot window (N concurrent calls can race past the cap); rewire apps/api budgets.ts/usage.ts + retire services/usage-accounting.ts

- Option 2: Keep our reservation store (contradicts the stated Kenny-leads philosophy; forces porting it onto his nanodollar/pricing model)

- **Recommendation:** Option 1, with eyes open: the philosophy explicitly names usage-ledger+pricing as Kenny-leads and his budget is coherent with them. Track re-adding a row-lock reservation on his base later if the overshoot regression matters.

### [D5-migration-renumber] Drizzle journal idx 16-21 collide: ours = 0016_access_control…0054_factory (idx 16-54, already applied on our live DB), Kenny's = 0016_integrations/0017_agent_studio/0018-0021_llm_usage (idx 16-21)

- **Evidence:** Drizzle is append-only and idx-ordered; two idx=16 cannot coexist. Meta snapshots are unreliable (memory: hand-write migrations).

- Option 1: Renumber Kenny's six migrations to 0055-0060 appended after our 0054, moving .sql + regenerating meta snapshots, hand-reconciling his agents/runs/artifacts/tenant_budgets ALTERs against our already-mutated tables

- Option 2: Renumber ours after Kenny's (rejected — ours is 39 applied migrations and ground truth)

- Option 3: Collapse Kenny's new tables into one hand-authored consolidated migration

- **Recommendation:** Option 1 (mechanical but needs human sign-off because it rewrites migration filenames). Keep our idx 3-54 verbatim; append Kenny's as forward-only 0055-0060; verify a clean pnpm db:migrate applies both histories in order.

### [D6-agentspec-actionspec-schema] contracts/agents.ts redefines ActionSpec/AgentSpec on both sides, each consumed by a different runtime (our factory manifest vs Kenny's Agent Studio)

- **Evidence:** Ours expands the type enum + passthrough for factory manifests; Kenny aliases ActionSpec→AgentActionV2Schema and rebuilds AgentSpec V2 with ports + reasoning.

- Option 1: Hand-merge into one superset: our .passthrough() + expanded action enum (condition/delay/subflow/invoke/foreach/emit) + tool_use/typescript_code/ontology_instructions AND Kenny's inputs/outputs ports + reasoning/model/temperature/stage/cron + authoring schemas

- Option 2: Take Kenny's V2 and re-add our factory fields

- Option 3: Take ours and re-add Kenny's ports/reasoning

- **Recommendation:** Option 1 — genuine fork, both runtimes read these symbols. Verify both packages/runtime (register/step-engine) and Kenny's Agent Studio parse the merged schema.

### [D7-api-client-readd] apps/web/lib/api-client.ts — we deleted it (hooks moved to readApiData); Kenny still edits it and 5 new hooks import it

- **Evidence:** Owner-listed ground-truth refactor; every current hook uses readApiData.

- Option 1: Honor deletion: drop api-client.ts, port Kenny's new payload schemas (ReplayRunPayload union etc.) into useRuns/useEvents, and rewrite his new hooks (useAgentStudio/useApiTokens/useIntegrations/useOperatorChecks/useAgentAuthoring) onto our api-response.ts pattern

- Option 2: Restore a minimal api-client.ts shim re-exporting over api-response.ts (keeps his hooks buildable with less rework, but reintroduces the file we removed)

- **Recommendation:** Option 1 — honors our refactor and matches how useAgents/useRuns already work. In Kenny's tree the only importers of api-client.ts are the deleted _portal_legacy pages + deleted useWebhooks, so nothing live is lost; the real signal is his new response schemas, which belong in the hooks.

### [D8-agent-detail-studio-vs-tabs] Agent detail page: Kenny's net-new guided Agent Studio (gutted [id]/page.tsx to a wrapper around StepsEditor/ToolsEditor/PortsEditor/TestLab) vs our enhanced 5-tab detail (AgentTabs + AgentCodeTab)

- **Evidence:** AgentTabs is dead in Kenny's tree, alive in ours; DeployAgentModal/samples alive in his, deleted in ours.

- Option 1: Adopt Agent Studio, rewire it onto our readApiData hooks + i18n; AgentTabs becomes dead and is dropped; DeployAgentModal + samples.ts return with it

- Option 2: Keep our tabbed detail; drop Agent Studio + its net-new files

- Option 3: Ship both (Studio as an /edit mode over our detail) — highest effort

- **Recommendation:** Option 1 (lean adopt Kenny's headline authoring feature) — but this cascades: it decides AgentTabs/AgentCodeTab-rework, DeployAgentModal deletion, samples.ts, and the agents list wizard. Confirm before we make those dependent calls.

### [D9-workflow-authoring] (views)/workflows: Kenny's enterprise workflow authoring (page +1938, AgentEditor +2170, draft +650, inspectors +622, +WorkflowRunConsole/canvas-interactions/workflow-runner, re-added NewWorkflowModal) vs our lighter i18n/dirty-context view (page +241, NewWorkflowModal deleted)

- **Evidence:** Shared (views)/workflows path; his is the 'enterprise workflow authoring and runtime' commit.

- Option 1: Take Kenny's authoring as base and re-port our useI18n/useDirty/preferences glue on top; tolerate his CSS Modules inside the adopted subtree

- Option 2: Keep our lighter view and cherry-pick fragments (loses most of his headline feature)

- **Recommendation:** Option 1 — Kenny clearly leads and his diff vastly exceeds ours. Re-wire our i18n keys, dirty-context, and preferences-context onto his files. Separately note the CSS-Modules-vs-inline convention drift in CLAUDE.md rather than restyling.

### [D10-settings-section-set] Settings registry: our trimmed i18n-driven data.ts (added Appearance; deleted Channels/Integrations/Notifications/Tokens) vs Kenny's expanded set (net-new AI section + real Tokens +530 + real Integrations +264, Channels/Notifications as stubs)

- **Evidence:** Ours is icon-only + i18n labels; Kenny's Tokens/Integrations are backed by net-new useApiTokens/useIntegrations hooks.

- Option 1: Keep our i18n registry and re-add only Kenny's REAL sections (ai, tokens, integrations) wired to i18n; keep Channels/Notifications deleted; keep our Appearance

- Option 2: Take Kenny's registry wholesale (reintroduces hardcoded labels + stub sections, contradicts our i18n refactor + drops Appearance)

- **Recommendation:** Option 1 — Tokens/Integrations/AI are real Kenny features aligned with the gateway lead and should survive; Channels/Notifications are stubs on both sides and stay removed.

### [D11-demo-mode] demo-mode: we deleted it entirely (config/demo-mode.ts, routes/v1/demo.ts, services/demo-runner.ts, tc-80, public/demo/*, CLAUDE.md section, env gate); Kenny re-touches/re-adds all of it

- **Evidence:** Our server.ts no longer imports demoRoutes/startDemoRunner; next.config.mjs removed the /demo rewrite.

- Option 1: Honor our deletion across api + web + tests + docs + env; drop every Kenny demo hunk (verified our server/bootstrap carry zero demo refs)

- Option 2: Restore Kenny's demo-mode subsystem behind a flag

- **Recommendation:** Option 1 — explicitly listed as a deliberate structural removal. Do not let his hunks (demo.ts +33, demo-runner +23, tc-80 extension, .env.production AGENTIC_DEMO_MODE, CLAUDE.md demo section) resurrect it.

### [D12-gohire-vs-robohire] Duplicate resume/match/invite tooling both targeting gohire.top: Kenny's packages/tools/src/gohire/* vs our packages/tools/src/robohire/*

- **Evidence:** Both call gohire.top; CLAUDE.md records the data.data.* nesting and multipart 'file' field requirements.

- Option 1: Pick one canonical impl and alias the other's names for back-compat, folding in our documented data.data.* envelope + multipart /parse-resume gotchas into the survivor

- Option 2: Register both (risks duplicate/ambiguous tool names and losing our documented quirks)

- **Recommendation:** Option 1 — keep one implementation. Our tenants (zhaopin/raas) reference robohire names and our CLAUDE.md documents the real envelope + multipart quirks, so bias toward keeping robohire's logic and aliasing gohire's names onto it (or vice-versa with the quirks ported).

### [D13-http-fetch-error-contract] http.fetch: Kenny's far-stronger SSRF hardening returns ok:false on non-2xx vs our deliberate fail-closed throw on 4xx/5xx (so declarative type:"tool" steps don't mark a run successful on an error response)

- **Evidence:** Kenny's fetch.ts +801 (comprehensive) vs ours +54 reusing declarative/ssrf and throwing on non-2xx.

- Option 1: Take Kenny's SSRF-hardened body as base and re-apply our throw-on-non-2xx; converge our declarative/ssrf.ts onto his inline guards (one SSRF path)

- Option 2: Keep ours (loses Kenny's DNS-rebind/IP-block/metadata protections)

- Option 3: Take Kenny's unmodified (regresses the fail-closed success contract)

- **Recommendation:** Option 1 — his DNS-rebind/IP-range/metadata blocking is a real security upgrade; our fail-closed semantics are a correctness contract. Both must survive. Prefer a single shared SSRF implementation.

### [D14-auth-rbac-model] Authz vocabulary: our RBAC (plugins/rbac.ts + requirePermission, platformRole-based, used pervasively) vs Kenny's inline role/scopes + requireWorkspaceWriter/requireTenantAdmin helpers (called by many of his route diffs) + api-tokens bearer scopes

- **Evidence:** Our routes call requirePermission(...); Kenny's tasks/workflow/agents/tenants/manifest-import/budgets diffs call requireWorkspaceWriter/requireTenantAdmin.

- Option 1: Keep our auth.ts+rbac.ts as base; add requireWorkspaceWriter/requireTenantAdmin as thin requirePermission shims; port Kenny's bearer-token scopes/credentialId as a new capability; normalize adopted route diffs to requirePermission

- Option 2: Take Kenny's auth.ts, drop rbac.ts, rewrite all our requirePermission calls

- Option 3: Hand-merge into one hybrid vocabulary

- **Recommendation:** Option 1 — reconcile in a single pass across all cluster routes; neither helper set exists in the other base, so the API won't compile until unified. Our RBAC is richer and structural.

### [D15-usage-billing-dashboard] Usage/cost dashboard + hooks: Kenny's attempt-metric ledger (AttemptMetricRow, byGateway/byRoute/byRoutingProfile, usdNanos exact) vs our budget-reservation/coverage/unpriced fields — both diverged from base on useUsage/settings-usage-page

- **Evidence:** Both built usage UI on divergent contract shapes; the merged /v1/usage + /v1/budgets adjudicate field names.

- Option 1: Kenny's ledger as base + our coverage/reservation cards ported on top, reconciled jointly with the merged apps/api /v1/usage routes + @agentic/contracts

- Option 2: Keep our usage UI (drops Kenny's routing/attempt-metric richness)

- **Recommendation:** Option 1, but do NOT finalize these hooks before the apps/api usage/budgets contract is settled (D3/D4) — field truth is owned there. Confirm every metric our llmCalls-based dashboard exposed is preserved before retiring usage-accounting.ts.


## Global risks

- MIGRATION JOURNAL COLLISION blocks pnpm db:migrate: both branches independently reused drizzle idx 16-21 for different migrations. Kenny's 0016-0021 must be renumbered to 0055-0060 with hand-written meta snapshots (db:generate is unsafe per project memory) before the DB is buildable.

- CROSS-CLUSTER TYPECHECK COUPLING: runtime/agents/api/web ports are unbuildable until llm-gateway (currentUsageAttribution/reasoning params) + contracts (ReasoningConfig/TextVerbosity/TaskClassId/CatalogPricing/findCatalogModel/AgentRunRecord + Kenny's new modules) + db (usage_events + runs attribution columns) land Kenny's side FIRST. Web gateway hooks + AI.tsx also fail unless the same contracts land in the same merge. Sequence the spine strictly.

- FILE-LEVEL 'TAKE-THEIRS' ON SHARED SPINE FILES SILENTLY DROPS OUR FACTORY: server.ts (Kenny dropped our factory/reasoning/observability/members/admin routes), register.ts/step-engine.ts (our durability+sandbox contract), schema.ts (our factory tables + runs/artifacts columns), and packages/agents run-engine/base-agent/types must be hunk-merged, never replaced. Neither server.ts is a superset.

- LOCKFILE MUST BE REGENERATED, NOT TEXT-MERGED: run pnpm install only after every package.json is resolved; verify the regenerated lock carries anthropic 0.111/openai 6/@google/genai/inngest-cli 1.37.0/@types/node 26.1.1 and drops the deleted agent-runtime entries.

- TWO REAL SECURITY FIXES buried in overlapping files must survive whichever base wins: the cross-tenant event-namespace guard (routes/v1/events.ts) and artifact path-traversal guards (routes/v1/artifacts.ts, hand-merged with our CSP/nosniff/rbac).

- PORT-SCHEME REGRESSION: our tree is ground truth on ports (api :3540, inngest :8488); Kenny's config/docs still reference stale :3501/:8288. Take his feature facts (Node pin, deps, reasoning schema, restart.sh) not his port strings.

- NODE 26.5.0 EXACT PIN MUST LAND ATOMICALLY across .nvmrc, engines, ci.yml, release.yml, CLAUDE.md, README, @types/node — Kenny's ensure-node-version guard with engine-strict fails install closed if any file is left at floating '26'.

- DEMO-MODE MUST STAY DELETED EVERYWHERE (api routes/service/config, web public/demo + _portal_legacy, tc-80, docs, env). Kenny re-touches all of them; his hunks are dead-on-arrival and must be dropped.

- DOUBLE-COUNTING / ORPHANED CONSUMERS: adopting Kenny's budget+ledger orphans our llm_budget_reservations table, usage-accounting.ts, tc-budget-reservations, and the G6 telemetry sink unless consciously rewired; leaving both budget writers active double-decrements tenant_budgets.

- BILLING NDJSON LEAK: usage-export writes under a pnpm-workspace walk-up (same path-stranding class CLAUDE.md warns about); gitignore data/usage and pin the export root explicitly.

- CASCADING FRONTEND FORKS: Agent Studio (D8) and workflow-authoring (D9) each cascade to many dependent files (AgentTabs/DeployAgentModal/samples/NewWorkflowModal, CSS-Modules-vs-inline). Resolve the structural decision before touching dependents or rework thrashes.

- ENUM EXHAUSTIVENESS + TENANT-PARAM DRIFT: PROVIDER_IDS gains moonshot+zai (non-exhaustive switches/Records break); provider-keys API became tenant-parameterized (getProviderKeyEnvOverlay(tenantId)/listProviderKeyMeta(tenantId)) so our call sites must add tenantId or lose tenant scoping.


## Verification plan
"Verify per-workspace in dependency order after each spine step, then a full gate at the end. (1) After steps 1-3: pnpm --filter @agentic/contracts run typecheck, then @agentic/llm-gateway typecheck + pnpm --filter @agentic/llm-gateway exec vitest run (pricing/normalizeUsage/attribution), then @agentic/db typecheck and a fresh DB migrate on a scratch copy — cp data/agentic.db to a temp path (or use a throwaway DATABASE_URL) and run pnpm db:migrate, confirming idx 3-60 apply in order with no duplicate-idx error; also run db:generate diff to confirm schema.ts matches the renumbered journal. (2) After step 4: pnpm --filter @agentic/runtime run typecheck + @agentic/agents typecheck; run their vitest suites; confirm packages/agent-runtime is gone and no import references it (grep @agentic/agent-runtime returns only the repointed-to-@agentic/agents call sites). (3) After step 5: @agentic/tools typecheck + vitest; confirm globalToolRegistry lists gohire/search and the ToolExecutionPolicy metadata is attached. (4) After step 6: pnpm --filter @agentic/api run typecheck (this is the tightest gate — catches auth-vocabulary, ChatRequest, provider-keys(tenantId), and getExpandedTenantRegistry glue), then boot the api and hit /health readiness (probeDefaultLLMProvider must pass, not silently mock). (5) After step 7: pnpm --filter @agentic/web run typecheck + pnpm --filter @agentic/web run lint (Next ESLint) + pnpm --filter @agentic/web run build (App Router; catches missing contract exports consumed by AI.tsx/hooks and undefined CSS var fallbacks). (6) After step 8: run the full api vitest (pool:forks, sequence.concurrent:false, shared data/agentic.db) — pnpm --filter @agentic/api exec vitest run — paying attention to tc-1/tc-16/tc-60/tc-61/tc-75/tc-95/event-tester which mirror the route forks; the known-flaky tc-34 disk-drift should now pass via Kenny's version-latest computation. (7) Final full gate from repo root in this order: pnpm install (regenerate + verify lock), pnpm ensure:native (ABI guard against the Node 26.5.0 pin), pnpm typecheck (turbo, every package tsc --noEmit), pnpm lint, pnpm build (turbo), pnpm test (turbo → api vitest). (8) One live smoke: pnpm dev (web :3599 + api :3540 + inngest :8488), drive one manifest agent end-to-end and confirm an llm_calls ledger row + usage_event are written and the Factory observability spine still sees a telemetry record, verifying the dual-gateway port (D2). Stop and escalate on the first red gate rather than proceeding down the spine."
