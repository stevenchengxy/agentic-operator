# Kenny feature-survival audit checklist (run before commit)

Every feature from Kenny's 11 commits (a40aec3..origin/main) must be present and
wired in the merged tree. Check = file exists + registered/imported + boots.

## 1. LLM gateway spine (Kenny leads — D2/D3/D4)
- [ ] Adapters: moonshot.ts, zai.ts, openai-responses.ts in packages/llm-gateway/src (+ registered in providers/index.ts)
- [ ] pricing.ts (calculateCost/normalizeUsage/USD_NANOS_PER_CENT), capabilities.ts, usage-ledger.ts, usage-attribution.ts, usage-export.ts
- [ ] gateway.ts: per-attempt ledger (startAttempt/finishAttempt/failAttempt) + OUR setGatewayCallSink + OUR validate() integrity gate
- [ ] budget.ts = deduct-then-execute (assertBudgetAvailable), tenant_budgets.used_usd_nanos
- [ ] apps/api/src/services/llm.ts = TenantRoutingGateway base + our probeDefaultLLMProvider/assertRealLLMGateway + sink→llm_call_telemetry + sandbox proxy seam
- [ ] apps/api/src/services/{llm-settings-store,gateway-network-safety,provider-keys,provider-test,model-discovery,model-fleet}.ts
- [ ] routes/v1/llm.ts (settings/routing/keys API) registered in server.ts
- [ ] plugins/usage-attribution.ts registered (imports @agentic/agents NOT agent-runtime)
- [ ] DB: llm_calls ledger + usage_events + reasoning-control cols (migrations 0058-0061 applied)
- [ ] Contracts: llm.ts (reasoning/verbosity), llm-settings.ts, providers.ts (moonshot+zai; gpt-5.6 family intact)

## 2. Agent Studio (D8 adopted)
- [ ] routes/v1/agent-studio.ts + agent-authoring.ts registered
- [ ] services: agent-drafts, agent-archetypes, agent-authoring, studio-runner, studio-history, studio-observability
- [ ] DB: agent_drafts, agent_draft_revisions, agent_run_sessions, run_messages (0057)
- [ ] web: portal/components/agent-studio/* ; (views)/agents/[id] = Studio experience; useAgentStudio/useAgentAuthoring hooks on readApiData
- [ ] Contracts: agent-definition.ts (with our invoke/foreach/emit enum extension), agent-studio.ts

## 3. Workflow authoring (D9 adopted)
- [ ] routes/v1/workflow-authoring.ts registered
- [ ] services: workflow-authoring, workflow-documents, workflow-generator, workflow-research, workflow-secret-policy, workflow-templates, workflow-test-runner
- [ ] web: (views)/workflows page = Kenny authoring + our i18n/dirty glue; AgentEditor/draft/inspectors/layout; NewWorkflowModal restored
- [ ] Contracts: workflow-authoring.ts

## 4. API tokens (D14: on our RBAC)
- [ ] routes/v1/api-tokens.ts registered; bearer-token scopes/credentialId in plugins/auth.ts; requireWorkspaceWriter/requireTenantAdmin shims exist
- [ ] web: settings Tokens.tsx (real version) + useApiTokens

## 5. Integrations (+ GoHire, D12 gohire-canonical)
- [ ] routes/v1/integrations.ts + services/integration-store.ts (AES-GCM at rest); DB integrations table (0056)
- [ ] tools: gohire/* canonical, data.data.* depth + multipart 'file' quirks present; robohire legacy names alias to gohire; setIntegrationResolver wired at api boot; env-fallback creds
- [ ] web: settings Integrations.tsx (real) + useIntegrations

## 6. Operator checks
- [ ] routes/v1/operator-checks.ts + services/operator-checks.ts registered; web operator-check components + useOperatorChecks + nav entry

## 7. Runtime v2 deltas (on OUR runtime — D1)
- [ ] packages/runtime: agent-execution.ts + execution-trace.ts + system-cron.ts exported; artifacts.ts = his atomic version
- [ ] register.ts exports his helpers (eventTargetsAgent/resolveAgentConcurrency/resolveAgentTriggerNames/buildManualTask*/formatMissingPromptsError) + our factory contract intact
- [ ] step-engine: reasoning/verbosity/store threading + reasoningContent capture; our tool resolution/windowing/cassette intact
- [ ] generated-agent.ts: actionDescription + lastResult context + our bilingual line
- [ ] agents pkg: taskClass/defaultReasoning/defaultVerbosity/storeResponses + attribution stamped on run rows
- [ ] packages/agent-runtime GONE; zero imports of @agentic/agent-runtime anywhere
- [ ] DB: run_trace_events + run_emitted_events populated path exists

## 8. Config/toolchain
- [ ] Node 26 pin + ensure-node-version.mjs (major-match) + preinstall guard
- [ ] .env examples: MOONSHOT/ZAI/integration-encryption/usage vars; NO demo vars; ports 3540/3599/8488 everywhere
- [ ] tc-1/12/16/34/60/61/75/95 + llm-* + api-tokens + provider-keys + workflow-provider-credential-fallback tests pass

## Consciously dropped (agreed rulings — NOT losses)
- demo-mode everywhere (D11) · apps/web/lib/api-client.ts (D7) · packages/agent-runtime (D1) ·
  our llm_budget_reservations reserve-then-execute (D4) · Channels/Notifications stubs (D10) ·
  bedrock/vertex stub providers (ours' removal upheld; catalog keeps them as roadmap presets)
