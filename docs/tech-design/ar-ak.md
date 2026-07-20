# Tech Design — Agent Kinds

**Module ID:** AR-AK
**Owner:** AI Software Architect
**Status:** V1.1 design
**Source catalog:** `docs/catalog/02-ai-runtime-catalog.md` § 1 (AR-AK-01..04)

## 1. Purpose

The Agent Kinds module is the **typology layer** of the runtime: it defines what counts as an "agent" in Agentic Operator, where its code lives, when it loads, and how it presents to the rest of the system. Two `AgentKind` discriminators (`code`, `manifest`) plus two informal sub-tiers (system, tenant code) cover every executable surface in V1. All four share one persistence shape (`runs` + `steps`), one log surface (`/v1/runs/:id/logs?follow=1`), one event ledger, and one LLM transport — the kind affects only *where the source lives and when it loads*, never *what the runtime does at execution*.

## 2. V1 state (citable)

- **Code agents** (AR-AK-01) — `packages/agents` is the single production implementation. `BaseAgent<TInput, TOutput>` exposes `buildMessages()`, optional `parseOutput()`, `getTools()` / `getToolHandlers()`, `outputSchema`, and `maxOutputTokens`. Its sealed `run()` delegates to `executeAgentRun()` in `packages/agents/src/run-engine.ts`, which owns multi-turn tool dispatch, structured-output repair, budget-scoped provider calls, persistence, cancellation, and streaming. Registration happens at module load through `packages/agents/src/registry.ts`.
- **Manifest agents** (AR-AK-02) — `AgentSpec` parsed from `models/<slug>-vN/workflow*.json` at boot. The Zod schema (`packages/runtime/src/manifest.ts:28-67`) is `.passthrough()` after Phase 0 fixed the schema-drift bug, accepting the four new Phase-0 fields: `input_data`, `ontology_instructions`, `tool_use`, `typescript_code`. Registration: `bootstrapAll()` in `packages/runtime/src/bootstrap.ts` walks `models/*-v*/workflow*.json`, upserts the agent rows, and calls `registerAgent()` (`packages/runtime/src/register.ts:53-499`) per entry with non-empty `trigger[]`. Each entry becomes one Inngest function with `id = "${tenantSlug}.${agentName}"`, `concurrency = { limit: <cap>, key: "${tenantSlug}:" + event.data.subject }`, retries=3 (`register.ts:86-103`).
- **System agents** (AR-AK-03) — informal tier; the canonical example is `TestAgent` in `packages/agents/src/system/test-agent.ts`. It has no mock/provider override: production uses the configured real gateway provider, with a 512-token output ceiling. `apps/api/src/bootstrap.ts` imports `@agentic/agents/system` once to register the roster.
- **Tenant code agents** (AR-AK-04) — code agents delivered through the `agentic deploy` CLI path. The CLI tars up a project; `POST /v1/tenant-code` (`apps/api/src/routes/v1/tenant-code.ts`) unpacks, validates, dynamic-imports, atomic-renames into `data/tenants/<slug>/<version>/`, and updates the registry. The hot-reload contract is *capture at run start* — in-flight runs complete against the old code.

## 3. V1.1 changes

### UC-V11-18 / AR-GAP-02 — `POST /v1/agents` 500 on tenants with live tenant_code deployment
**Site:** `apps/api/src/routes/v1/agents.ts` (the "Add agent" save route) and `apps/api/src/services/tenant-code.ts` (the dynamic-import resolver).
**Bug:** When a tenant has a live `deployments(kind:'tenant_code', status:'live')` row, the `dynamic import(absoluteTenantPath)` call loses the version segment. Symptom: `Cannot find module '@tenants/raas/dist'`.
**Fix:** Bake the version segment into the resolved path. Change the resolver to read the live deployment version row (`SELECT version FROM deployments WHERE tenant_id=? AND kind='tenant_code' AND status='live' LIMIT 1`) and construct `data/tenants/<slug>/v<version>/dist/index.cjs` before passing to `import()`. Treat absence as "no tenant code deployed → fall through to workspace import."
**New type:** Add `resolveTenantCodePath(tenantId): Promise<string | null>` exported from `apps/api/src/services/tenant-code.ts` (file to be created — service does not exist today; logic currently inlined in route).
**Migration:** None — purely a code change.
**Tests:** `apps/api/test/tc-agents-add-with-live-tenantcode.test.ts` (new) — seed tenant + live `tenant_code` deployment row, POST `/v1/agents`, assert 200 + registry contains the new agent. Existing `tc-tenant-code-versioning.test.ts` covers the deploy path; extend to assert "POST /v1/agents after deploy still works."

### UC-V11-23 / AR-GAP-09 — `agent.tool_use` field dispatch
**Site:** `packages/runtime/src/step-engine.ts:158-208` (the `runAction` switch).
**Bug:** Manifest schema accepts and stores `tool_use: string` on each agent (`packages/runtime/src/manifest.ts` AgentSchema), but `step-engine.ts:166` falls back to `runTool(genericCtx(ctx), action.name)` — the name-hint dispatcher — even when `action.tool_use` is set. Result: the legacy `tool_use: ""` strings in RAAS are no-ops.
**Fix:** In the `case "tool"` branch, consult `action.tool_use` (the action-level field — the schema actually carries the binding per-action, not per-agent) **before** the registry/name-hint chain. When `action.tool_use` is a non-empty string, that string IS the tenant tool name. Order: (1) `tenantRegistry.tools[action.tool_use]`, (2) `tenantRegistry.tools[action.name]` (backward compat), (3) generic `runTool` fallback.
**New types:** Add `tool_use?: string` to `ActionSpec` in `packages/runtime/src/manifest.ts` (and the matching `ToolActionSchema` in `packages/contracts/src/workflow.ts`).
**Migration:** None — existing `tool_use: ""` strings remain no-ops because empty falls through; only non-empty strings change dispatch.
**Tests:** `tc-tool-use-dispatch.test.ts` (new) — manifest with `tool_use:"customTool"`, assert tenant `customTool` handler is called, not the name-hint fallback. Add an assertion to TC-1 that bare-named actions still resolve via the registry.

### UC-V11-24 / AR-GAP-12 — Per-agent `defaultProviders` for failover
**Site:** `packages/agents/src/base-agent.ts` (the `defaultProvider` / `defaultModel` singletons).
**Bug:** Gateway failover (`packages/llm-gateway/src/gateway.ts:71-130`) iterates `req.providers[]`, but `BaseAgent.run()` only forwards `defaultProvider` (one entry, no array). P1-RT-06 added `AgentContext.providers?: ProviderId[]` forwarding, but the typical caller (the portal "Test run" button, the test agent) doesn't supply one.
**Fix:** Add `readonly defaultProviders?: ProviderId[]` next to `defaultProvider` on the BaseAgent class. The run engine's `dispatch()` step reads it: `req.providers = ctx.providers ?? this.defaultProviders ?? (this.defaultProvider ? [this.defaultProvider] : undefined)`. The single-provider `defaultProvider` remains as a one-element convenience.
**New types:** `defaultProviders?: ProviderId[]` on `BaseAgent`. Update `AgentContext` doc-string in `packages/agents/src/types.ts` to clarify precedence.
**Migration:** None — single-provider agents keep the same behavior.
**Tests:** `tc-failover-default-providers.test.ts` — agent with `defaultProviders=["anthropic","openai"]`, stub anthropic to throw `rate_limit` twice → openai → success; assert run completes ok and the steps row records `provider="openai"`.

### UC-V11-25 / AR-GAP-13 — Require `definePrompt` for every `logic` action
**Site:** `packages/runtime/src/bootstrap.ts` (boot-time validation) + `packages/runtime/src/step-engine.ts:174-191` (the `logic` fallback).
**Bug:** When a manifest `type:"logic"` action has no matching tenant `definePrompt`, the engine sends `${action.name}: ${action.description}` verbatim (`step-engine.ts:178`). For RAAS-v1, this means most agents' Chinese descriptions are what the LLM sees as the user prompt.
**Fix (two-phase):**
- **Phase A (V1.1):** At boot, after `bootstrapAll` resolves tenant registries, iterate every manifest agent's `actions[type=logic]` and check `tenantRegistry?.prompts?.[action.name]` exists. If any missing, **refuse to boot** with a clear error listing the (tenant, agent, action) triples and a remediation pointing at `tenants/<slug>/prompts/`.
- **Phase A-fallback:** Provide an opt-out env `AGENTIC_REQUIRE_TENANT_PROMPTS=0` for dev to keep the old behavior — defaults to `1` in production. The opt-out logs a `WARN` line per missing prompt at boot.
**New types:** `validateTenantPromptCoverage(registries, manifests): { missing: Array<{tenant,agent,action}> }` exported from `packages/runtime/src/lint.ts`.
**Migration:** None at the DB level. The RAAS tenant package will need 14 new `definePrompt` entries (one per logic action that ships without a prompt today) — tracked as a sub-task.
**Tests:** `tc-require-tenant-prompts.test.ts` — boot with a manifest that has a `logic` action but no matching prompt, assert boot fails with the listed-missing error.

## 4. Interfaces (the contract)

**Code-agent surface (public):**
```ts
abstract class BaseAgent<TInput=unknown, TOutput=string> {
  abstract readonly name: string;
  abstract readonly description: string;
  readonly kind: AgentKind = "code";
  readonly enabled: boolean = true;
  readonly defaultProvider?: ProviderId;
  readonly defaultProviders?: ProviderId[];     // NEW in V1.1
  readonly defaultModel?: string;
  readonly maxSteps: number = 1;
  readonly concurrency: { limit: number; key?: string } = { limit: 4 };
  readonly outputSchema?: z.ZodType<unknown>;

  protected abstract buildMessages(input, ctx): ChatMessage[] | Promise<ChatMessage[]>;
  protected parseOutput(text, ctx): TOutput | Promise<TOutput>;
  getTools(ctx): ToolDef[];
  getToolHandlers(ctx): ToolHandlerMap;

  run(input, ctx): Promise<AgentResult<TOutput>>;  // sealed
}
```

**Manifest-agent surface (declarative JSON):** `packages/runtime/src/manifest.ts:28-67` — `AgentSpec` Zod schema with `id`, `name`, `title?`, `description`, `actor[]`, `trigger[]`, `actions[]`, `triggered_event[]`, plus Phase-0 fields. `ActionSpec` discriminated union on `type` ∈ `{tool, logic, manual}` (with `condition`/`delay`/`subflow` reified as one of those three at write-time). `ToolActionSchema` gains `tool_use?: string` in V1.1.

**Registry:** `packages/agents/src/registry.ts` exports the canonical `agentRegistry: { register, get, list, has }` consumed by the API and system roster.

**Zod request bodies:** `InvokeAgentBody` in `packages/contracts/src/agents.ts` — `{ input?: unknown, provider?: ProviderId, model?: string, async?: boolean }`.

## 5. Data flow

```
                              boot
                                |
        +-------------------------+---------------------------+
        |                                                     |
  code agents:                                      manifest agents:
  module-load                                       bootstrapAll() reads
  side-effect import                                models/<slug>-vN/workflow*.json
        |                                                     |
  agentRegistry.register(new MyAgent())             upsert agents + agent_versions
        |                                           call registerAgent(spec, ctx)
        |                                                     |
   POST /v1/agents/:name/invoke               Inngest function registered with
        |                                     id = "${tenantSlug}.${agentName}"
        |                                                     |
   sync: BaseAgent.run() inline               event arrives on Inngest bus
        |                                                     |
   executeAgentRun(this, input, ctx)          step.run("init") allocates runId
        |                                     for each action: step.run + runAction()
        |                                                     |
        +---------------------- writes runs + steps + log + event ---------+
                                                              |
                                                       SSE follow at
                                                /v1/runs/:runId/logs?follow=1
```

## 6. Failure modes

| Failure | Detection | Recovery |
|---|---|---|
| Code agent throws in `buildMessages()` | run engine catches; writes `steps.error`, `runs.status='failed'` | None — caller sees 500 with error payload; rerun |
| Agent not registered | `agentRegistry.get()` returns undefined | API route falls back to Option B (`AR-INN-05`) — emits the first trigger event of any matching manifest agent. 404 if neither found |
| Manifest schema invalid | Zod parse fails in `bootstrapAll()` | Boot fails fast with the offending file:line; operator fixes the file and restarts |
| Two tenants with same agent name | Tenant slug prefix in `fnId` makes them distinct | None needed; concurrency key `${tenantSlug}:${subject}` isolates pools |
| `POST /v1/agents` on live tenant_code (current bug) | 500 with `Cannot find module` | **V1.1 fix above.** Workaround today: `pnpm db:seed && pnpm dev` |
| `logic` action with no tenant prompt (V1.1) | Boot-time `validateTenantPromptCoverage()` check | Refuse to boot — operator adds the missing `definePrompt` |

## 7. V2 roadmap

- **UC-V2-12 / AR-GAP-10** — Execute `typescript_code` snippets via a sandbox (vm2 / isolated-vm / wasm). V1 stores the field but never executes it.
- **UC-V2-13 / AR-GAP-11** — Multi-turn tool-use loop for manifest agents. Today only code agents loop; manifest is single-shot.
- **UC-V2-16 / AR-GAP-17** — Collapse the two run engines (`packages/agents/src/run-engine.ts` + `packages/runtime/src/register.ts`) into one. Audit `03-ai-runtime-review.md` § 11 recommends.

## 8. Acceptance tests

- `tc-agents-add-with-live-tenantcode.test.ts` — UC-V11-18 fix passes.
- `tc-tool-use-dispatch.test.ts` — UC-V11-23 dispatch via `action.tool_use`.
- `tc-failover-default-providers.test.ts` — UC-V11-24 multi-provider failover from BaseAgent default.
- `tc-require-tenant-prompts.test.ts` — UC-V11-25 boot fails on missing prompts.
- `tc-3-test-agent-happy.test.ts` (existing) — code-agent happy path still passes.
- `tc-1-manifest-happy.test.ts` (existing) — manifest happy path still passes.
- `tc-16-tool-use-loop.test.ts` (existing) — multi-turn tool-use loop on code agents.

Coverage gates: every UC-V11-* listed above has a paired failing-then-passing test per the TDD mandate in `docs/USE_CASES.md` § 6.
