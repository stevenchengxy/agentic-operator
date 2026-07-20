# AI Runtime Catalog — Agentic Operator v1

> **Author:** AI Architect (Phase 5 — Catalog, slice 2 of 3)
> **Date:** 2026-05-21
> **Status:** v1 shipped — Phases 0–4 complete; durability + 14-provider gateway green; 344 backend tests passing.
> **Scope:** Everything south of the HTTP boundary that has to do with running an agent — the two `AgentKind`s, the LLM gateway, Inngest durability discipline, memory + tools + step engine, the run-row/step-row lifecycle, the event ledger, tenant-code deploy, cost + budgets, and the RAAS canonical worked example.
>
> **Cross-slice anchors.** This document is slice 2 of 3. Slice 1 (`docs/catalog/01-product-design-catalog.md`) inventories every UX surface those runs flow into; slice 3 (the software-architect catalog) will cover the HTTP transport, schema-level DB design, auth, and ops. Where the same feature appears in two slices, the `AR-*` IDs in this file are the authoritative reference for runtime-side semantics; the design slice's `PD-*` IDs are the authoritative reference for what a user sees.
>
> **How to read this document.** Sections 1–10 are the inventory by domain — every feature gets a stable ID (`AR-AK-*`, `AR-LLM-*`, `AR-INN-*`, `AR-MEM-*`, `AR-TOOL-*`, `AR-RUN-*`, `AR-EVT-*`, `AR-DEP-*`, `AR-COST-*`, `AR-RAAS-*`), a one-paragraph description, source citations, test coverage, and a status badge. Current runtime claims resolve to `packages/{agents,agent-sdk,agent-kit,llm-gateway,runtime,tools,contracts,db}`, `apps/api/src`, and `models/RAAS-v1`; older audit documents are historical records rather than live package maps.
>
> **Why this catalog exists.** The runtime is the load-bearing wall of v1. Two execution paths (code agents subclassing `BaseAgent`, manifest agents loaded from JSON) share one persistence shape (`runs` + `steps` + NDJSON log files), one durability substrate (Inngest), one observability surface (SSE log tail + event ledger), and one LLM transport (`LLMGateway`). The catalog is the place a new engineer goes to learn what the contract is, what the test coverage looks like, and where the unfinished edges sit before they touch anything.

---

## 1. Agent kinds (`AR-AK-*`)

Two `AgentKind` values exist in v1 — `code` and `manifest` — and a hidden third tier called **system** which is implemented as a code agent but lives outside any tenant's source tree. A fourth pseudo-kind, **tenant code agents**, is the same `code` discriminator on the wire but is loaded from `data/tenants/<slug>/<version>/` via the `agentic deploy` tarball path rather than the package source tree. All four use the same `runs`/`steps` rows, the same NDJSON log lines, and the same `/v1/runs/:id/logs?follow=1` SSE stream — the distinction is *where the code lives and when it loads*, not *what the runtime does with it*.

### AR-AK-01 — Code agents (BaseAgent subclass) ✅ v1

A code agent is a TypeScript subclass of `BaseAgent<TInput, TOutput>`. The class declares its identity (`name`, `description`), optional provider/model defaults, optional Zod output schema, optional tool catalog (`getTools()` + `getToolHandlers()`), and exactly one required override (`buildMessages(input, ctx)`). It registers itself at import time via `agentRegistry.register(new MyAgent())` in a sibling `index.ts`.

The contract is sealed at `BaseAgent.run()` — subclasses override hooks while `packages/agents/src/run-engine.ts` owns run/step rows, file artifacts, per-turn telemetry, multi-turn tool dispatch, structured-output repair, cancellation and gateway budget scope. `@agentic/agents` is the sole production code-agent implementation and the API entry point; there is no parallel runtime mirror.

**Lifecycle:** `register at import time → /v1/agents/:name/invoke → runs row INSERT (status=running) → steps row(s) per LLM turn + per tool dispatch → NDJSON log writes per event → gateway.chat() → optional tool round-trip → parseOutput() / Zod validation → runs row UPDATE (status=ok|failed) → AgentResult returned`. Tenant scoping defaults to `__system` for code agents invoked via the sync route (`apps/api/src/routes/v1/agent-invoke.ts:204`) — this is intentional: code agents are platform-wide and not tenant-bound, though `AgentContext.providers` can carry tenant overrides for failover.

**DB rows on registration:** `packages/agents/src/bootstrap.ts` upserts the agent into `agents` (with `kind="code"`, `kebab_id=<name>`, `enabled=true`) and writes an `agent_versions` row carrying the empty manifest_json (code agents have no manifest). See `packages/db/src/schema.ts` `agents` + `agent_versions` definitions. Status: ✅ shipped. Test coverage: TC-3 (`apps/api/test/tc-3-test-agent-happy.test.ts`), TC-16 (multi-turn tool-use loop), TC-17 (async-Inngest enqueue path).

### AR-AK-02 — Manifest agents (JSON spec) ✅ v1

A manifest agent is declared in `models/<slug>-vN/workflow*.json` as one entry in the array of `AgentSpec` objects. Each entry carries `id` (kebab id used as the DB primary key), `name` (the agent's logical name — what events are namespaced with), `description`, `actor` (`["Agent"]` or `["Human"]`), `trigger[]` (the events that invoke it), `actions[]` (the ordered list of steps the step engine walks), `triggered_event[]` (the events it emits on success), and four extra fields added in Phase 0 (`input_data`, `ontology_instructions`, `tool_use`, `typescript_code`).

At boot, `bootstrapAll(TENANT_REGISTRIES)` in `packages/runtime/src/bootstrap.ts` reads every `models/*-v*/workflow*.json`, parses it with the Zod schema in `packages/runtime/src/manifest.ts:28-67` (now `.passthrough()` after Phase 0 fixed the schema-drift bug audit #3 §3.1 flagged), upserts the agent rows, and for each agent with a non-empty `trigger[]` calls `registerAgent(agent, ctx)` in `packages/runtime/src/register.ts:53` to produce one Inngest function with `id="${tenantSlug}.${agentName}"`. See `packages/runtime/src/register.ts:86-103` for the function-options shape; concurrency key is `${tenantSlug}:${event.data.subject}` (P5-TEN-01), retries=3, triggers are `{ event: "${tenantSlug}/${triggerName}" }` for every entry in `trigger[]`.

**Lifecycle:** `boot → manifest.json read + Zod parse → upsert agents + agent_versions + event_listeners → registerAgent() per entry → Inngest function created → trigger event arrives → step.run("init") allocates run + correlation IDs + inserts runs row → step engine walks actions[] → per action: step.run() inserts steps row, runAction() dispatches by type, writes log, optionally writes artifact → after last action: step.sendEvent() emits triggered_event[0] (or the override from a step's __emit field) → step.run("finalize") closes runs row`. See `packages/runtime/src/register.ts:104-450` for the full handler.

**DB rows:** `agents` (one per manifest entry, `kind="manifest"`), `agent_versions` (one per (agent, workflow_version) pair, carrying the parsed `manifest_json`), `workflows` + `workflow_versions` (one each per `models/<slug>-vN/` directory), `event_listeners` (one per `trigger[]` entry — these power the workflow DAG's edge rendering), `event_types` + `entity_types` (catalog rows backing the schema editor). Status: ✅ shipped. Test coverage: TC-1 (happy path), TC-4 (event branching via `__emit`), TC-8 (branch-emit override behavior).

### AR-AK-03 — System agents (the test agent) ✅ v1

System agents are a thin convention layered on top of `AR-AK-01`. The canonical `TestAgent` lives at `packages/agents/src/system/test-agent.ts`, does not override the provider/model with mock values, and is registered by the `@agentic/agents/system` side-effect import in API bootstrap.

The "system" designation is informational only — the runtime treats it identically to any other code agent, while `apps/api/src/config/system-agents.ts` determines the `__system` tenant scope. The roster ships inside the canonical package so it cannot drift from the implementation that executes it. Status: ✅ shipped. Test coverage: TC-3, TC-16 and TC-17.

### AR-AK-04 — Tenant code agents (CLI deploy) 🟡 v1.1

The fourth tier is structurally a `code` agent but delivered through a different channel: the `agentic deploy <path>` CLI command tars up a tenant's authored code (`agentic init` scaffolds the project), `POST /v1/tenant-code` (`apps/api/src/routes/v1/tenant-code.ts`) accepts a USTAR tarball, the server unpacks it under `data/tenants/<slug>/<version>/`, atomically renames the version to live, and dynamically imports the new module. The deployed agent is registered into `agentRegistry` under its declared name, and the `agents` row's `version` column is bumped.

The hot-reload contract is: the previous version's exported registry entry is dropped, the new version's entries are added, and any in-flight `BaseAgent.run()` from the previous version completes against the old code (no mid-run replacement). See `apps/api/src/routes/v1/tenant-code.ts` + the design note in `docs/design/agents-os-review.md`. Status: 🟡 v1.1 — the upload path works, but `POST /v1/agents` returns 500 on tenants that already have a live tenant-code deployment (audit `p4-ops-status.md` flags this as `AR-GAP-02`), and the CLI's `agentic init` writes the wrong `actions_v1.json` shape (`AR-GAP-03`). Test coverage: partial — `agentic-deploy.test.ts` exercises the tarball path but not the hot-reload edge cases.

---

## 2. LLM gateway (`AR-LLM-*`)

The gateway is the single chokepoint every LLM call passes through. It owns provider registry, request shaping, error classification, redaction, key vault, streaming contract, and the failover policy. Per the design doc `docs/design/llm-gateway-and-baseagent.md:1-120` it is "not responsible for persistence, audit logging, or cost calculation" — those live downstream in the run engine, the audit writer, and the usage aggregator respectively.

### AR-LLM-01 — Fourteen providers ✅ v1

The provider catalog ships fourteen entries. Each lives in `packages/llm-gateway/src/providers/<id>.ts` as a `make<Id>(env)` factory that builds the adapter; the adapters themselves live in `packages/llm-gateway/src/adapters/` (the `openai-compatible.ts` adapter is reused by seven providers — `openai`, `openrouter`, `groq`, `together`, `mistral`, `deepseek`, `qwen` — which all speak the same wire dialect). Registration is centralized at `packages/llm-gateway/src/providers/index.ts:26-45`.

| Provider id | env var(s) required | Adapter | Model catalog source | Streaming? | Native tool-use? |
|---|---|---|---|---|---|
| `mock` | none | `adapters/mock.ts` | `PROVIDER_MODEL_CATALOG.mock` in `@agentic/contracts` | yes (synthetic chunks) | yes (pattern-matched) |
| `anthropic` | `ANTHROPIC_API_KEY` | `adapters/anthropic.ts` | contracts catalog | yes (SSE) | yes (content blocks) |
| `openai` | `OPENAI_API_KEY` | `adapters/openai-compatible.ts` | contracts catalog | yes (SSE) | yes (function-call) |
| `openrouter` | `OPENROUTER_API_KEY`, optional `OPENROUTER_REFERRER`, `OPENROUTER_APP_TITLE` | `adapters/openai-compatible.ts` | contracts catalog | yes | yes |
| `gemini` | `GOOGLE_API_KEY` | `adapters/gemini.ts` | contracts catalog | yes | yes (functionCall parts) |
| `azure` | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION`, `AZURE_OPENAI_DEPLOYMENT` | `adapters/azure.ts` (wraps openai-compatible) | contracts catalog | yes | yes |
| `groq` | `GROQ_API_KEY` | `adapters/openai-compatible.ts` | contracts catalog | yes | yes |
| `together` | `TOGETHER_API_KEY` | `adapters/openai-compatible.ts` | contracts catalog | yes | yes |
| `mistral` | `MISTRAL_API_KEY` | `adapters/openai-compatible.ts` | contracts catalog | yes | yes |
| `deepseek` | `DEEPSEEK_API_KEY` | `adapters/openai-compatible.ts` | contracts catalog | yes | yes |
| `qwen` | `QWEN_API_KEY` | `adapters/openai-compatible.ts` | contracts catalog | yes | yes |
| `bedrock` | (AWS env vars; stub at `adapters/bedrock-stub.ts`) | `adapters/bedrock-stub.ts` | contracts catalog | 🟡 v1.1 | 🟡 v1.1 |
| `vertex` | (GCP env vars; stub at `adapters/vertex-stub.ts`) | `adapters/vertex-stub.ts` | contracts catalog | 🟡 v1.1 | 🟡 v1.1 |
| `custom` | `CUSTOM_LLM_BASE_URL`, `CUSTOM_LLM_API_KEY` | `adapters/openai-compatible.ts` | empty (caller supplies) | yes | yes |

The `PROVIDER_MODEL_CATALOG` is published from `packages/contracts/src/providers.ts` and is consumed by both the gateway (`listProviders()` reads it for the `models[]` field of each `ProviderInfo`) and the web (`useLLMCatalog()` reads `/v1/llm/catalog` which serves the same map). Adding a model to a provider is a one-line edit to the contracts catalog plus a regenerated JSON-schema bundle.

Bedrock and Vertex are stubbed for v1 — the wiring exists, the adapter throws `LLMError("not_configured", "Bedrock provider stubbed — v1.1")` until the AWS SDK and GCP IAM bits land. Audit `p4-ops-status.md` confirms this is the documented behavior, not a regression. Status: ✅ shipped for 12, 🟡 v1.1 for `bedrock`/`vertex`. Test coverage: TC-13 (`apps/api/test/tc-13-llm-gateway.test.ts`), TC-15 (tool-use adapter conformance per provider class), TC-16 (multi-turn tool-use loop end-to-end).

### AR-LLM-02 — Singleton wiring ✅ v1

A single `LLMGateway` instance lives for the lifetime of the API process. It is built lazily on first access by `getLLMGateway()` in `apps/api/src/services/llm.ts:19-26`, which resolves config from `process.env` overlaid with the provider-key vault (`getProviderKeyEnvOverlay()` — see `AR-LLM-06`) and calls `registerAllProviders(g, adapterEnv)`. The singleton is then injected into both consumers at boot from `apps/api/src/bootstrap.ts`:

- `setAgentGateway(getLLMGateway())` in `packages/agents/src/gateway-host.ts` — `BaseAgent`'s canonical run engine reads it via the gateway host.
- `setRuntimeGateway(getLLMGateway())` in `packages/runtime/src/llm-host.ts` — the manifest step engine's `logic` and `llmCall` actions read it via the runtime host.

This indirection (rather than passing the gateway through every function signature) was the deliberate v1 simplification — neither the BaseAgent contract nor the step engine has to know how the gateway is constructed. The cost is that **the test harness must call `_setLLMGatewayForTests()` or `setGateway()` before exercising any code path that touches LLM** (see `apps/api/test/setup.ts:30-50`).

`resetLLMGateway()` drops the singleton so the next `getLLMGateway()` call rebuilds it with current vault contents — invoked after `POST /v1/llm/providers/:id/key` so saving a key takes effect immediately. Status: ✅ shipped. Test coverage: TC-13 (gateway construction and provider registration), TC-13 (key reload after vault write).

### AR-LLM-03 — Defaults ✅ v1

The default provider is `LLM_DEFAULT_PROVIDER` (env), falling back to legacy `LLM_PROVIDER`, falling back to `"mock"`. The default model is `LLM_DEFAULT_MODEL` (env), falling back to legacy `LLM_MODEL`, falling back to `null` (which means "let the adapter pick its catalog default"). See `packages/llm-gateway/src/config.ts:50-99`. A deprecation warning is printed to stderr exactly once per process when only the legacy env vars are set.

The test harness (`apps/api/test/setup.ts`) forces `LLM_DEFAULT_PROVIDER=mock` and `LLM_DEFAULT_MODEL=mock-model-v1`. This is load-bearing — without it, the test suite would try to dial real Anthropic/OpenAI endpoints when env vars happen to be set in the developer's shell. Resolution precedence at request time is `req.provider > req.providers[0] > config.defaultProvider`; resolution of model is `req.model > config.defaultModel > adapter.defaultModel`. See `LLMGateway.chat()` at `packages/llm-gateway/src/gateway.ts:71-150`. Status: ✅ shipped. Test coverage: TC-13.

### AR-LLM-04 — Error taxonomy ✅ v1

Every adapter wraps its native errors into one `LLMError` class with a discriminated `code` field. The full taxonomy lives at `packages/llm-gateway/src/errors.ts:9-18`:

| Code | Meaning | HTTP status mapped by API route | Transient (retried)? |
|---|---|---|---|
| `auth` | bad API key (401/403) | 401 | no |
| `rate_limit` | upstream 429 | 429 | yes |
| `timeout` | exceeded `timeoutMs` | 504 | yes |
| `model_not_found` | upstream 404 / unknown model | 400 | no |
| `bad_request` | upstream 400 / invalid params | 400 | no |
| `provider_error` | upstream 5xx | 502 | yes |
| `network` | ECONNRESET / DNS failure | 502 | yes |
| `not_configured` | adapter is a stub or has no API key | 503 | no |
| `cost_limit_exceeded` | budget guard pre-flight (`packages/llm-gateway/src/budget.ts`) | 402 | no |

The HTTP status mapping lives at `apps/api/src/routes/v1/agent-invoke.ts:253-271` and is mirrored by `apps/api/src/routes/v1/llm.ts` for the direct `POST /v1/llm/chat` path. Transient errors are retried *once* by the gateway, then the next provider in `req.providers[]` is tried (failover); non-transient errors fail fast. See `packages/llm-gateway/src/gateway.ts:78-150` for the per-provider retry-then-fallthrough loop. `cost_limit_exceeded` is unusual — it is raised by the deduct-then-execute pre-flight check (`AR-COST-02`) before any provider HTTP call happens, so it has no upstream and no retry semantics. Status: ✅ shipped. Test coverage: TC-13 (error classification), TC-15 (tool-use rejection on bad tool schema → `bad_request`).

### AR-LLM-05 — Redaction ✅ v1

`packages/llm-gateway/src/redact.ts` enforces three invariants: (1) API keys are never written to a log line — the redactor strips known header values (`Authorization`, `x-api-key`, `api-key`) by name before any log write; (2) message bodies longer than 16KB are truncated with a `[…truncated 12345 bytes]` suffix on log; (3) the `messages[].content` array of any tool-result block carrying obvious secrets (substrings matching `password=`, `token=`, `bearer `) is redacted on log only (the actual wire request is untouched). The redactor is called by the run engine's NDJSON writer (`packages/runtime/src/log-writer.ts:appendRunLog`) and by the audit writer; the gateway itself does not log message bodies.

Status: ✅ shipped. Test coverage: TC-13 has a "no keys in log line" assertion that grep's the run log for `sk-` and fails the test if anything appears. The list of header names is hardcoded; v1.1 ticket considers making it configurable per tenant.

### AR-LLM-06 — BYOK vault ✅ v1

Provider API keys are persisted outside `.env` in an AES-256-GCM-encrypted JSON file at `data/provider-keys.json` (gitignored, file mode 0600). The vault implementation is at `apps/api/src/services/provider-keys.ts:1-340`. The master key is derived via `scrypt(secret, salt, 32)` where `secret = AGENTIC_KMS_KEY` env var (the v1 design doc spells this `AGENTIC_KEY_VAULT_SECRET`; both names appear in code — the canonical resolver at `provider-keys.ts:84-87` reads `AGENTIC_KEY_VAULT_SECRET` falling back to `dev-vault::${hostname()}` for local dev so the file decrypts across restarts).

**Endpoints:**
- `GET /v1/llm/providers` — list every registered provider with masked metadata.
- `GET /v1/llm/models?provider=…` — list model strings for a provider; omit `provider` for the full catalog.
- `GET /v1/llm/catalog` — full `PROVIDER_MODEL_CATALOG` (every model's metadata: context window, input/output price, capabilities).
- `GET /v1/llm/providers/keys` — masked metadata for every provider's stored key.
- `GET /v1/llm/providers/:id/key` — masked metadata for one provider.
- `POST /v1/llm/providers/:id/key` — save and rotate (body: `{ apiKey, scope: "workspace"|"tenant" }`). Calls `resetLLMGateway()` afterward.
- `POST /v1/llm/providers/:id/test` — probe upstream with a candidate key without saving it.
- `DELETE /v1/llm/providers/:id/key` — drop the vault entry.

Tenant-scoped keys (`scope:"tenant"`) take precedence over workspace-scoped (`scope:"workspace"`) which take precedence over env. Cross-tenant bleed was a real bug pre-P5 — a tenant-scoped record from tenant A could become the de-facto workspace default. Fixed by `provider-keys.ts:170-211`'s explicit tenant-match-required logic. Status: ✅ shipped. Test coverage: TC-13 (CRUD round-trip), the cross-tenant-bleed regression test in TC-20.

### AR-LLM-07 — Streaming contract ✅ v1

The streaming surface is unified across providers as a single async iterator of `ChatChunk` objects on the gateway's `chatStream()` method (each adapter implements it). Anthropic's native SSE event types (`message_start`, `content_block_delta`, `message_delta`, `message_stop`) are translated into a uniform `{ type: "text" | "tool_use" | "stop", delta?, toolCall? }` chunk shape; OpenAI-compat providers translate their `data: {choices:[{delta:…}]}` SSE the same way. Gemini's native streaming JSON-RPC is normalised at the adapter layer.

The forwarded surface to the operator is the run-log SSE stream at `GET /v1/runs/:runId/logs?follow=1` — chunks are NOT forwarded raw; instead, the run engine writes a `llm.delta` log line per chunk (limited to ~50/s by a soft throttle in `log-writer.ts` so a high-token model doesn't flood the SSE), and the operator's logs view (`apps/web/app/portal/[tenant]/logs/page.tsx`) renders them with a streaming highlight. The full final response is also persisted as the `steps[].output_ref` artifact for replay.

Status: ✅ shipped for 12 providers (mock + 11 live). 🔵 v2 ticket exists to push the raw `ChatChunk` stream through to the web — for v1 the per-chunk-log-line bridge is the only path. Test coverage: TC-13's "anthropic streaming" block exercises the adapter normalization; the SSE bridge is covered by Playwright `apps/web/e2e/runs-log-stream.spec.ts`.

---

## 3. Inngest durability (`AR-INN-*`)

Inngest is the durability substrate for every async run — code agents enqueued via `?async=1` and every manifest agent. The framework guarantees at-least-once delivery and replay-with-memoization of `step.run()` blocks; the contract for using it correctly is captured in `packages/runtime/src/register.ts:165-280` and is the single most-reviewed code path in the runtime.

### AR-INN-01 — The step.run contract ✅ v1

Every database write MUST be inside a `step.run("name", async () => {...})` block. Inngest replays the handler from the beginning on every retry; outside `step.run()`, code re-runs on each replay (so a `db.insert()` outside would produce duplicate rows). Inside `step.run()`, the result is memoized — the inner code runs *exactly once* per actual execution, even if Inngest replays the handler ten times. The handler at `packages/runtime/src/register.ts:104-450` has `step.run` blocks for: (1) init (allocate `runId` + `correlationId` + insert `runs` row), (2) one per action (insert `steps` row + execute), (3) finalize (close `runs` row + emit triggered event). The init block's memoization is what makes idempotent run-id allocation work — every replay sees the same `runId`.

The second half of the contract is `step.sendEvent("name", { event, data })` — the *only* idempotent way to emit a downstream event. Calling `inngest.send()` inline inside a step body emits the event on every replay. `step.sendEvent()` memoizes the send. The register.ts comment at line 165 spells this out: "step.sendEvent is the only idempotent way to emit downstream events — never `inngest.send` inside a step body." Status: ✅ shipped. Test coverage: TC-1 (happy path), TC-8 (branch emit), TC-14 (replay idempotency).

### AR-INN-02 — Concurrency keying ✅ v1

Each Inngest function is keyed for concurrency. From `packages/runtime/src/register.ts:86-103`:

```
id:           `${tenantSlug}.${agentName}`
concurrency:  { limit: <agent.concurrency.max_concurrent_executions ?? 8>,
                key:   `"${tenantSlug}:" + event.data.subject` }
retries:      3
triggers:     [ { event: `${tenantSlug}/${triggerName}` } for triggerName in trigger[] ]
```

The key composition `${tenantSlug}:${subject}` (Phase 5, P5-TEN-01) was a fix: prior to that, two tenants whose agents both processed subject `"REQ-2041"` shared the same Inngest slot bucket, so a heavy tenant could starve another. The prefix isolates each tenant's slot pool. The `limit` cap honors per-agent `concurrency.max_concurrent_executions` from the manifest; missing/disabled falls back to 8.

Code agents enqueued via `?async=1` use a different function (`__system.code.<agentName>`) and event name (`__system/code.<agentName>.invoke`) — see `packages/agents/src/code-agent-fn.ts:1-80`. Their concurrency mirrors `agent.concurrency` from the `BaseAgent` declaration (default `{ limit: 4 }`). Status: ✅ shipped. Test coverage: TC-17 (code-agent Inngest enqueue), TC-14 (manifest concurrency cap honored).

### AR-INN-03 — HITL pattern (manual actions) ✅ v1

Human-in-the-loop is implemented as `step.waitForEvent("task.resolved")`. The pattern (per `register.ts:200-300`):

1. `step.run("init-task-${ord}")` inserts a `steps` row (status=running, type=manual) and a `tasks` row (status=open, payloadJson carrying the agent/action context + condition).
2. `step.waitForEvent("wait-task-${ord}", { event: "task.resolved", if: 'async.data.taskId == "<id>" && async.data.tenantId == "<tenantId>"', timeout: "<derived>" })` blocks the handler until a matching event arrives or the timeout expires.
3. `step.run("close-task-${ord}")` updates the `steps` row (status=ok if `decision=approve`, status=failed if `decision=reject`) and the `tasks` row (status=resolved, resolutionJson carrying the decision payload).

The resolution endpoint is `POST /v1/tasks/:id/resolve` (`apps/api/src/routes/v1/tasks.ts`). It validates the task exists, the auth subject is the issuing tenant, then `inngest.send("task.resolved", { taskId, tenantId, decision, payload })`. The `tenantId` field is required (P5-TEN-01) so a leaked taskId in another tenant cannot resume the run.

The timeout is derived from `action.task_timeout_s` (added in P0-RT-10) — if set, the wait expires after that many seconds; if missing or non-positive, the wait defaults to 7 days (`"604800s"`). On timeout, the handler updates the `steps` row to `status=failed, error="task timeout"`, updates the `tasks` row to `status=snoozed`, fails the run, and re-throws so Inngest does not retry. See `register.ts:252-269`. Status: ✅ shipped. Test coverage: TC-5 (HITL approve), TC-5b (HITL reject), TC-12 (manualTaskTimeout helper).

### AR-INN-04 — Retention cron ✅ v1

The retention cron lives at `packages/runtime/src/retention.ts` and is scheduled by Inngest's cron trigger. It runs once per day (`cron: "0 3 * * *"`) and does three things:

1. **Run-log purge.** Walks `data/logs/<tenant>/runs/<date>/*.log` and deletes files older than `LOG_RETENTION_DAYS` (default 30).
2. **Event-ledger purge.** Walks `data/logs/<tenant>/events/<date>.ndjson` and deletes files older than `EVENT_RETENTION_DAYS` (default 90).
3. **Metric emission.** Counts `agents` rows (total, enabled, archived) and emits gauge metrics `agentic_agents_total{state}` to `/metrics`. This is how the operator sees that "23 agents · 23 enabled · 0 archived" in the dashboard runtime panel.

Log-rotate (per-file) is handled by `packages/runtime/src/log-rotate.ts` — when a `.log` exceeds 64 MB, it is renamed `.1.log` and rotated. Status: ✅ shipped. Test coverage: `tc-retention.test.ts` (P4 audit) — verifies the day-cutoff logic and the metric emission.

### AR-INN-05 — Manifest invoke fallback (Option B) ✅ v1

The portal's "Test run" button hits `POST /v1/agents/:name/invoke?testRun=1`. For code agents this calls `BaseAgent.run()` inline. For manifest agents, which aren't in the code registry, the route falls back to "Option B": look up the agent's first declared trigger event and emit it through Inngest.

The logic lives at `apps/api/src/routes/v1/agent-invoke.ts:74-165` and depends on the helper `findManifestAgentTrigger(tenantSlug, agentName)` from `apps/api/src/queries/agents.ts`. The fallback:

1. Pull the agent row by `(tenantId, name)`. Return 404 if not found.
2. Return 409 `agent_disabled` if `enabled=false`.
3. Return 409 `no_auto_trigger` if `triggers.length === 0` (e.g., `manualEntry` in RAAS — `actor:["Human"]` agents are entry-only, the operator has to publish the event manually via `POST /v1/events`).
4. Compute the subject: `body.input.subject` falls back to `body.input.candidate_id` falls back to `body.input.job_requisition_id` falls back to `"TEST-${eventId.slice(4, 12)}"` so the run never has a NULL subject in the UI.
5. Stamp `__triggerEventId`, `__correlationId`, `__invokedAgent`, and (if `?testRun=1`) `__test:true` on the Inngest payload.
6. `inngest.send({ name: "${tenantSlug}/${triggerName}", data })` — the manifest function picks it up like any other event.
7. Return `202 { kind: "manifest", status: "queued", eventId, eventName, subject, correlationId, note: "…" }`.

This makes the "Test run" button work uniformly for both kinds: sync for code, 202+SSE for manifest. The trade-off is that the operator has to watch `/v1/runs` (SSE) to see the actual run id — the route can't return it because the run hasn't been created yet (Inngest's `step.run("init")` will allocate it once the function fires). Status: ✅ shipped. Test coverage: TC-21 (operator publish + run materialization), `tc-invoke-manifest-fallback.test.ts`.

---

## 4. Memory & state (`AR-MEM-*`)

Memory is the second-most-asked-for feature after streaming, and v1 ships the contract end-to-end at the SDK level but only the K/V backend at the runtime level. The vector-search method exists, returns a clear `NoMemoryDriverError`, and is the seam where v2's pgvector / SQLite-VSS / Qdrant driver will plug in. Two tables back it.

### AR-MEM-01 — Short-term memory (`agent_memory_short`) ✅ v1

The `agent_memory_short` table is the run-scoped scratchpad. Each row is keyed by `(run_id, key)` and carries a `value_json` blob plus `updated_at`. The table has `ON DELETE CASCADE` against `runs.id` so when a run row is deleted, its scratch memory disappears with it. Additionally, the run engine calls `clearRunMemory(runId)` on run finalize (`packages/runtime/src/memory.ts:175-184`) so the run-scope behaves like a true scratchpad even when the run row sticks around (which it always does in v1 — runs are never deleted, only soft-deleted via `runs.deleted_at`).

The SDK contract is `ctx.memory.put(key, value, "run")` / `ctx.memory.get(key, "run")`. The handle is bound to a single `(tenantId, agentName, subject, runId)` quadruple at run start; agents never thread those through manually. See `packages/agent-sdk/src/memory.ts:1-58` for the public surface. Status: ✅ shipped. Test coverage: `tc-memory.test.ts` (P3-RT-06) — round-trips put/get/delete across all three scopes.

### AR-MEM-02 — Long-term memory (`agent_memory_long`) ✅ v1

The `agent_memory_long` table persists across runs. Each row is keyed by `(tenant_id, agent_name, subject, key)` and carries `value_json` + `updated_at`. The composite key means the same `subject` (e.g., a candidate id) sees the same memory across every run for that agent, *and* every agent sees its own slice — agent A's memory for subject X is separate from agent B's memory for the same subject. The `subject` column doubles as the discriminator for the "tenant" scope: tenant-wide memory uses the sentinel empty-string subject (`TENANT_SCOPE_SUBJECT = ""` in `memory.ts:33`).

Storage is a simple drizzle `onConflictDoUpdate` upsert (`memory.ts:114-132`). There is no TTL, no compaction, and no row count cap; v1.1 has a ticket to add a `ttl_ms` column + a daily janitor cron. Status: ✅ shipped. Test coverage: `tc-memory.test.ts`.

### AR-MEM-03 — Scopes (`run` / `subject` / `tenant`) ✅ v1

The `MemoryScope = "run" | "subject" | "tenant"` discriminator (`packages/agent-sdk/src/memory.ts:25`) controls which table is hit and what the key composition looks like:

| Scope | Backing table | Key composition | Reader/writer policy | When it makes sense |
|---|---|---|---|---|
| `run` | `agent_memory_short` | `(run_id, key)` | Only the agent that owns the run can read/write; cascade-deleted with the run row; explicitly swept on finalize | Plan/state tracking across a multi-turn loop; carrying tool results between turns |
| `subject` | `agent_memory_long` | `(tenant_id, agent_name, subject, key)` | Any run for the same `(tenant, agent, subject)` reads the same row; cross-agent reads require the same `agent_name`, so the namespace is implicitly agent-private within the tenant | Per-candidate state (RAAS): "what JD did we send this candidate?", "did we already invite them to an interview?" |
| `tenant` | `agent_memory_long` (empty-string subject) | `(tenant_id, agent_name, "", key)` | Any run for the agent in the tenant sees the same row | Tenant-wide config not worth a `tenant_budgets`-style table: model preferences, feature flags, rate-limit counters |

The "subject" scope is the load-bearing one for RAAS — the workflow processes one candidate per run, so `subject = candidate_id` makes the candidate's history available to every downstream agent. A "tenant" scope row is keyed by the same agent name as the writer, so two agents cannot share state directly — they have to write through a third agent (typically a "memory janitor" agent) or pick the same `agent_name` by convention. v1.1 ticket considers adding a shared-tenant scope.

Status: ✅ shipped. Test coverage: `tc-memory.test.ts` exercises all three scopes plus the empty-string-subject sentinel.

### AR-MEM-04 — `MemoryHandle` API ✅ v1

The full SDK surface is four methods:

```
get<T>(key, scope="subject"): Promise<T | null>
put<T>(key, value, scope="subject"): Promise<void>
delete(key, scope="subject"): Promise<void>
search(query: string, k: number): Promise<MemoryHit[]>
```

`get/put/delete` are synchronous SQLite roundtrips wrapped in promises so the SDK signature can absorb a future Postgres/Redis backend without breaking callers. `search()` delegates to the global `MemoryDriver` registered via `setMemoryDriver(driver)`; with no driver, every call throws `NoMemoryDriverError("vector search not configured")` with a clear remediation hint. The driver interface (`packages/agent-sdk/src/memory-driver.ts`) is two methods (`search`, optional `index`) so a v2 author can wire SQLite-VSS in ~50 LOC.

The handle is constructed by `createMemoryHandle({ tenantId, agentName, subject, runId })` in `memory.ts:55-167` and passed into both `BaseAgent.run()`'s context (`AgentContext.memory`) and the manifest step engine's tenant-tool context (`ToolContext.memory`). Status: ✅ shipped. Test coverage: `tc-memory.test.ts`, `tc-memory-search.test.ts` (verifies `NoMemoryDriverError` shape).

### AR-MEM-05 — Subject identity ✅ v1

A "subject" is the cross-run identity for an entity the workflow is processing. The runtime never assigns a subject automatically — it's the caller's responsibility to either:

1. Stamp `event.data.subject` on the trigger event (the standard path; concurrency keying in `AR-INN-02` keys on this field).
2. Pass `body.input.subject` to `POST /v1/agents/:name/invoke`.

For RAAS, the convention is `subject = candidate_id` (`MATCH_PASSED_*`, `MATCH_FAILED`, all downstream candidate-centric events). The first stage (`syncFromClientSystem`, `manualEntry`) processes a job requisition, so `subject = job_requisition_id` there. The transition happens at `resumeCollection` (`AR-RAAS-08`) — the action emits a new `RESUME_PROCESSED` event with `subject = candidate_id` and the downstream agents follow that thread.

The `subject` is **not the same** as `correlation_id`. `correlation_id` is the cross-run trace identifier (set once at the trigger, propagated through every causally-downstream event via `__correlationId`); `subject` is the entity being processed (stable across causally-unrelated runs for the same entity). Two different candidates for the same job have the same `correlation_id` neither, but they share a parent `job_requisition_id` discoverable via the event ledger. Status: ✅ shipped. Test coverage: TC-1 (subject stamping), TC-21 (operator publish carries subject through to runs row).

---

## 5. Tools (`AR-TOOL-*`)

The tool surface has three concentric rings: first-party tools shipped in `@agentic/tools`, the `defineTool` SDK that lets tenants declare typed tools in their `@tenants/<slug>` package, and the manifest step engine's six built-in action types (`logic`, `tool`, `manual`, `condition`, `delay`, `subflow`). The SSRF guard sits outside but adjacent — every outbound HTTP call from a tool flows through it.

### AR-TOOL-01 — First-party tools ✅ v1

Three first-party tools ship in `packages/tools/src/index.ts`:

- **`http.fetch`** — `httpFetch(ctx, { url, method?, body? })`. v1 implementation is a mock (`packages/tools/src/index.ts:27-37`) that delays ~200ms and returns a synthetic `{ status: 200, body: { mock: true, echoed: args } }`. A real implementation would route through the SSRF guard. v1.1 ticket exists to replace the mock with a real adapter once the contract for "real fetch from a manifest agent" is signed off.
- **`channel.publish`** — `channelPublish(ctx, { channel, payload })`. v1 mock returns `{ delivered: true, channel }`. Channels (email, Slack, WeWork) are platform integrations that should be wired through the tenant registry's tool overrides; the v1 mock is a placeholder so RAAS's `notifyRecruiter` and `sendInvitationEmail` actions have something to dispatch to.
- **`llm.call`** — removed from this dispatch (the file comment at line 64-67 makes the deprecation explicit). Logic-type actions now route through the LLM gateway in `packages/runtime/src/step-engine.ts` (the `case "logic"` branch). Tool-type actions that want an LLM call should declare a `logic` type instead, or invoke the gateway explicitly via a tenant tool.

The generic `runTool(ctx, hintFromName?)` dispatch at `tools/index.ts:69-83` is a best-effort fallback: when a manifest action has `type: "tool"` but no explicit tool name binding, the dispatcher inspects the action name for hint words (`"publish"`, `"notify"`, `"alert"` → `channel.publish`; everything else → `http.fetch`). RAAS exercises this fallback every time an action calls `monitorAndFetchRequirement`, `sendInvitationEmail`, etc. Status: ✅ shipped (with mock implementations). Test coverage: TC-2 (`http.fetch` happy path), TC-2b (`channel.publish` happy path).

### AR-TOOL-02 — `defineTool` SDK ✅ v1

The typed tool builder lives at `packages/agent-sdk/src/define-tool.ts:1-46`. The shape:

```
defineTool({
  name: "loadEvaluatedCandidates",
  description?: string,
  output?: ZodSchema<TOutput>,
  handler(ctx: ToolContext): Promise<ToolResult<TOutput>>
}): ToolDescriptor<TOutput>
```

The returned descriptor is a plain object — no decorators, no DI. A tenant exports the descriptor from a sibling file and the tenant's `index.ts` aggregates them into a `TenantRegistry` record. The runtime picks it up via the `TENANT_REGISTRIES` lookup in `apps/api/src/bootstrap.ts`. When the manifest action's name matches a tenant-registered tool descriptor, the step engine dispatches to the tenant handler with the Zod schema enforced on the output. On schema-validation failure, the step row is closed with `ok=false` and `meta.schemaError` carrying the Zod issues — the engine does not auto-repair tool output the way it does LLM output (see `AR-RUN-02`).

The companion `definePrompt({ name, system, user, output? })` (same package) lets tenants override the auto-built `logic` system/user messages with their own templates. The override is consulted before the runtime's `buildSystemPrompt` / `buildUserPrompt` defaults; the tenant's `prompt.system` is the *first* system message (so the runtime prelude follows it, not the other way around — P0-RT-11). Status: ✅ shipped. Test coverage: TC-10 (auto-built + tenant-prompt routing), TC-23 (defineTool schema validation).

### AR-TOOL-03 — Tenant tool registry ✅ v1

Each tenant that ships custom tools lives in `tenants/<slug>/` as a workspace package declared as `"@tenants/<slug>": "workspace:*"` in `apps/api/package.json`. The package exports a `TenantRegistry` from its `index.ts`:

```
{
  slug: "raas",
  tools: { loadEvaluatedCandidates, rankCandidates, … },
  prompts: { analyzeRequirement, createJD, … },
  memory?: MemoryHandle (rare — most tenants use the default)
}
```

The wiring happens in `apps/api/src/bootstrap.ts` via the `TENANT_REGISTRIES` constant — a plain object keyed by tenant slug:

```ts
const TENANT_REGISTRIES = {
  raas: raasRegistry,
  // add more here when you add `@tenants/<slug>` packages
};
await bootstrapAll(TENANT_REGISTRIES);
```

This wiring lives in the api (not in `@agentic/runtime`) because pnpm's isolated module resolution requires each package to own its own deps. The runtime accepts an opaque `TenantRegistry` and never tries to `import("@tenants/<slug>")` itself. The pattern: lowercase the folder name, strip the `-vN` suffix (`RAAS-v1` → `raas`), declare the package, register it. Adding a tenant without custom tools is purely declarative — just drop the `models/<slug>-vN/` directory. Status: ✅ shipped. Test coverage: TC-22 (raas registry round-trip), `tc-tenant-registry.test.ts`.

### AR-TOOL-04 — Step engine action types ✅ v1

The manifest step engine recognizes six action types. Their dispatch lives in `packages/runtime/src/step-engine.ts` (the `runAction` function's switch statement) plus `register.ts` for the `manual` + `subflow` + `condition` + `delay` ones that need Inngest primitives (waitForEvent, sleep, invoke).

| Action type | What it does | Where it dispatches | Step row written | Audit/log emit |
|---|---|---|---|---|
| `logic` | LLM call — auto-built or tenant-prompt-overridden system+user, single-shot via `gateway.chat()` | `step-engine.ts:174-186` (LLM dispatch via `callLLM` + `getRuntimeGateway()`); if tenant `definePrompt` registered, that takes precedence | `steps` row, type=logic, status=ok/failed, provider/model/tokensIn/tokensOut filled, outputRef pointing to the artifact JSON | `run.step.start` + `run.step.end` log lines; provider + model in NDJSON |
| `tool` | Side-effect call — tenant `defineTool` handler or generic fallback dispatch | `step-engine.ts:162-172`; tenant tools win, then generic `runTool` | `steps` row, type=tool, status=ok/failed, outputRef = tool result JSON | `run.step.tool.start/end`; meta carries `tool: <name>, tenant: <bool>` |
| `manual` | HITL — pause for `task.resolved` | `register.ts:200-300` (only manifests; HITL not yet supported in code agents — code agents have no `waitForEvent` primitive without Inngest) | `steps` row type=manual, plus a `tasks` row. Closed when `task.resolved` arrives | `run.step.task.created`; `task.resolved` event in the ledger |
| `condition` | Branching predicate; gates the rest of the actions | `register.ts:380-420` (uses `evaluateCondition` from `packages/runtime/src/condition.ts`); on false, skips remaining actions | `steps` row, status=skipped on bypass, otherwise status=ok | `run.step.condition.evaluated` with `decision=true/false` |
| `delay` | Sleep — calls `step.sleep("ord-<n>", "<duration>s")` | `register.ts`'s action-walking loop (P3 added support); duration is `action.delay_s` | `steps` row, status=ok after the sleep returns; durationMs honest | `run.step.delay.start/end` |
| `subflow` | Invoke another agent in the same tenant; the child's run id is recorded as `parent_run_id` | `register.ts` (P1-RT-04); `step.invoke` semantics with the target agent's first trigger | Two `steps` rows on the parent (start + end of the subflow) plus a full child run with its own steps; `runs.parent_run_id` points at the parent | Bi-directional log lines via the run trees in `/v1/runs?parentId=<id>` |

The big-ticket gotcha is that any `logic` action *without* a matching tenant prompt sends the manifest action's name + description as the raw user content (`step-engine.ts:174-186`). For RAAS (which doesn't ship tenant prompts for most agents — see `@tenants/raas`), this means the LLM sees the Chinese action description verbatim. The audit (`03-ai-runtime-review.md:17`) flagged this as a "foot-gun" — tenant authors should define prompts explicitly for every logic action that should not be steered by the bare description. Status: ✅ shipped (all six types). Test coverage: TC-1 (logic + tool), TC-5 (manual), TC-9 (condition), TC-3-multi-step (delay, P3), TC-21-subflow (subflow, P1-RT-04).

### AR-TOOL-05 — SSRF guard ✅ v1

The SSRF guard at `apps/api/src/services/ssrf-guard.ts:34-220` enforces six invariants on every outbound `fetch-url` call (used by the manifest-import wizard's "URL source" tab and any future tenant tool that wants safe outbound HTTP):

1. **HTTPS-only**, except `http://localhost` when `AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST=1` is set in dev. All other schemes (`file:`, `ftp:`, `data:`, `gopher:`, `dict:`, `ssh:`, etc.) are rejected by name.
2. **DNS-after-resolve check.** `dns.promises.lookup({ family: 0 })` resolves the hostname, then the resolved IP is checked against an explicit reject-list: loopback `127.0.0.0/8`, RFC1918 `10/8` + `172.16/12` + `192.168/16`, link-local `169.254.0.0/16` (specifically catches the AWS metadata endpoint), IPv6 loopback `::1`, link-local `fe80::/10`, ULA `fd00::/8`, and the zero address `0.0.0.0`.
3. **Redirect re-check.** `fetch(url, { redirect: 'manual' })` is used so every Location header is re-validated. Up to 3 hops; after that, `redirect_limit_exceeded`.
4. **Body byte-streaming cap.** `Content-Length` is ignored (a malicious server can lie or stream forever); the body is consumed as a stream and the byte counter aborts the read when it crosses `AGENTIC_FETCH_URL_MAX_BYTES` (default 5 MB).
5. **Content-type allow-list.** Checked both before reading the body and after the first chunk (servers can chunk-update headers).
6. **Separate connect + body timeouts.** 5s each, configurable via `AGENTIC_FETCH_URL_CONNECT_TIMEOUT_MS` / `AGENTIC_FETCH_URL_BODY_TIMEOUT_MS`.

Errors are surfaced as `SsrfError` with a discriminated code (`https_only`, `scheme_not_allowed`, `blocked_target`, `dns_resolution_failed`, `redirect_limit_exceeded`, `body_too_large`, `timeout`, `bad_url`). The manifest-import wizard maps every `SsrfError` to a 400 with a clear hint about which check failed. Status: ✅ shipped. Test coverage: `tc-ssrf-guard.test.ts` (24 test cases covering each rejection class), the design doc (`docs/design/import-workflow-manifest.md` § "SSRF protocol for fetch-url") covers the protocol exhaustively.

---

## 6. Run lifecycle (`AR-RUN-*`)

The run row is the single durable artifact of every agent invocation. Six step-shape facts hold true across all agent kinds: there is always exactly one `runs` row, it always has a `correlation_id`, it always has a `tenant_id`, it always has a `started_at` (set inside the init `step.run` so it survives replays), it always has a `status` that ends in one of `{ok, failed, cancelled}`, and it always has at least one `steps` row.

### AR-RUN-01 — Run-row schema ✅ v1

The `runs` table lives at `packages/db/src/schema.ts:281-332`. Every column with its purpose:

| Column | Type | Purpose |
|---|---|---|
| `id` | text PK | `run-…` makeId prefix |
| `tenant_id` | text FK→tenants | Tenant scoping (mandatory) |
| `agent_id` | text FK→agents | Which agent ran |
| `agent_version_id` | text FK→agent_versions | Which version — pinned to the workflow version live at run start |
| `trigger_event_id` | text FK→events | The event that fired this run (NULL for sync-invoke without an event) |
| `parent_run_id` | text | Set for subflow children (P1-RT-04) |
| `status` | enum | `queued`, `running`, `ok`, `failed`, `waiting`, `cancelled` |
| `started_at` | timestamp_ms | Set inside `step.run("init")` so it survives Inngest replay |
| `ended_at` | timestamp_ms | Set on finalize |
| `duration_ms` | int | Computed at finalize for cheap dashboards |
| `tokens_in` / `tokens_out` | int | Aggregated across all LLM turns (multi-turn loops sum) |
| `model` | text | Last LLM step's reported model string (P0-RT-04 fixed this — used to be hardcoded `"mock-model-v1"`) |
| `emitted_event_id` | text | The event the run emitted on success (the chosen entry from `triggered_event[]`) |
| `error_message` | text | One-line summary; full error in the NDJSON log |
| `log_path` | text | The on-disk log file path (caller writes the log under it) |
| `correlation_id` | text NOT NULL | Cross-run trace id (`cor-…`) |
| `subject` | text | The entity being processed (e.g., `candidate_id`); indexed for "all runs for this subject" lookups |
| `deleted_at` | timestamp_ms | Soft-delete tombstone (P1-API-04b) |
| `is_test` | bool NOT NULL default false | True for `?testRun=1` invocations and for events stamped with `__test:true` |

The schema does NOT carry a `cost_usd` column — cost is computed on read by `apps/api/src/routes/v1/usage.ts` from `tokens_in × providerPrice.input + tokens_out × providerPrice.output`. There is no `error_json` column — the v1.1 audit asked for one but punted; the structured error lands in the NDJSON log under the `run.error` line. Indexes are on `(tenant_id, started_at)` for the dashboard query, `(tenant_id, status)` for the running-count, `agent_id` for the per-agent run list, `correlation_id` for trace, `subject` for "all runs for this candidate," `deleted_at` to skip tombstoned rows, and `is_test` for the test-traffic filter. Status: ✅ shipped. Test coverage: TC-1 (row write + read), TC-19 (soft-delete behavior), TC-21 (isTest flag propagation).

### AR-RUN-02 — Step rows ✅ v1

The `steps` table lives at `schema.ts:334-361`. One row per action — `ord` is the 1-indexed order. Status enum is `pending`, `running`, `ok`, `failed`, `skipped` (skipped is set when a `condition` action's predicate evaluates false). Type enum is `tool`, `logic`, `manual` — `condition`, `delay`, and `subflow` are reified as one of those three at write time (condition → logic with `meta.condition=true`, delay → tool with `meta.kind=delay`, subflow → tool with `meta.kind=subflow`). The `input_ref` and `output_ref` columns point at on-disk JSON sidecars under `data/artifacts/<runId>/step-<ord>-{input,output}.json` (P0-RT-09).

The error column is one-line. `provider` and `model` are filled for logic steps. `tokens_in` / `tokens_out` are per-step; the run-level totals are the sum. Multi-turn tool-use loops (P1-RT-01) produce one row per LLM turn *and* one row per tool dispatch, so a 2-turn loop with one tool produces 3 step rows: logic (turn 1) + tool (dispatch) + logic (turn 2). Status: ✅ shipped. Test coverage: TC-16 (multi-turn step row count assertion), TC-9 (skipped-status assertion for false-condition).

### AR-RUN-03 — Log writer ✅ v1

Per-run logs are NDJSON-ish written to `data/logs/<tenant>/runs/<YYYY-MM-DD>/<run-id>.log`. Each line is a UTC ISO timestamp + level + event-name + space-separated `key=value` pairs, where the value is a JSON-encoded literal for anything that isn't a string (`packages/runtime/src/log-writer.ts:51-90`). Example:

```
2026-05-21T08:14:02.001Z  INFO   run.start  run_id=run-01000 correlation_id=cor-AB12 agent=ruleCheckerForClientResume event=raas/RESUME_PROCESSED subject=CAND-7
```

Append-only with `O_APPEND` so concurrent writers (which Inngest can produce when retries overlap step boundaries) interleave safely without blocking on a mutex. Levels are `DEBUG`, `INFO`, `WARN`, `ERROR`. Redaction (`AR-LLM-05`) runs at the writer boundary so anything the caller forgets to scrub gets scrubbed before disk.

The day-rolled directory means a single `tar` over `data/logs/` is a viable cold-storage strategy; the daily prefix also makes glob-based janitor crons trivial (`AR-INN-04`). Per-file rotation kicks in at 64 MB to keep individual log files manageable. Status: ✅ shipped. Test coverage: TC-1 (log file exists + contains run.start), `tc-log-format.test.ts` (line-shape contract).

### AR-RUN-04 — SSE stream (`/v1/runs/:runId/logs?follow=1`) ✅ v1

The follow-mode SSE endpoint at `apps/api/src/routes/v1/runs-logs.ts` opens the log file at the given path, sends the existing contents as a backlog, then tails appended lines via `fs.watch`. Each emitted message is a `RunStreamEvent` per the Zod contract at `packages/contracts/src/runs.ts` (`RunStreamEventSchema` — fields `runId`, `level`, `event`, `at`, `data`). The web layer reads it via `useRunLogStream(runId)` in `apps/web/app/portal/lib/use-run-log-stream.ts`.

When `?follow=0` (or omitted), the endpoint returns the entire log as a single response — useful for cold replay. When `?follow=1`, the response is `text/event-stream` with a 30-second keep-alive ping so reverse proxies don't time the connection out. Status: ✅ shipped. Test coverage: TC-6 (SSE roundtrip), Playwright `runs-log-stream.spec.ts` (renders the streaming highlight correctly in the UI).

### AR-RUN-05 — Sync vs async invoke paths ✅ v1

The two paths through `/v1/agents/:name/invoke` are:

- **Sync (default).** `agent.run(input, ctx)` is awaited inline; the response carries `{ runId, status: "ok", output, provider, model, tokensIn, tokensOut, durationMs }`. This is the path the portal's "Test run" button takes for code agents. The run is materialised in the DB before the response returns. Used by TC-3 (testAgent happy path) and TC-16 (tool-use loop assertions).
- **Async (`?async=1`).** For code agents, `inngest.send({ name: "__system/code.<name>.invoke", data })` is fired and the route returns `202 { runId, status: "queued" }` — the runId is pre-allocated by the route (`makeId("run")`) so callers can poll `/v1/runs/:id` immediately. v1 doesn't pass the pre-allocated id into `executeAgentRun` — the engine re-allocates a fresh runId inside `step.run("init")`, so the returned id is "reserved for traceability" but doesn't match the eventual run row. (`AR-GAP-08` — full alignment is on the v2 ticket.) For manifest agents, the `?async` flag is ignored — the Option-B fallback (`AR-INN-05`) is always async-via-Inngest anyway.

The correlation id is `cor-<random>` for fresh invocations, or `event.data.__correlationId` for chained invocations (when an upstream event payload carries one — RAAS chains every event with the same `correlationId` for trace continuity). The Inngest payload always carries `__triggerEventId` so the run row's `trigger_event_id` is filled correctly. Status: ✅ shipped (sync). Test coverage: TC-3 (sync), TC-17 (async-Inngest enqueue).

### AR-RUN-06 — `?testRun=1` flag ✅ v1

A run is "test" iff one of these is true:

1. The synchronous code-agent invoke route received `?testRun=1` or `?testRun=true` (`apps/api/src/routes/v1/agent-invoke.ts:50-52`). The route sets `runs.is_test=true` via the run engine.
2. The manifest path's Inngest event payload carries `__test:true` (`register.ts:117`). The Event Tester at `POST /v1/events` stamps this when the caller opts in.

The flag propagates to:

- `runs.is_test` (indexed; dashboards filter on it).
- `RunStartedPayload.testRun = true` on the SSE stream (`packages/contracts/src/runs.ts`).
- The "TEST RUN" badge on the run detail header and the per-agent "latest test chip" (PD-D-11).

Test runs share the same DB shape, log path, event ledger entry, and metrics as production runs — the flag is purely a filter, not a separate code path. This is intentional: it means a test exercise of the workflow goes through every line of code a production run would. Status: ✅ shipped. Test coverage: TC-21 (operator publish + isTest propagation), Playwright `e2e/test-run-badge.spec.ts`.

---

## 7. Event ledger (`AR-EVT-*`)

Events are the connective tissue of the manifest workflow. Every agent invocation is fired by an event and emits one or more events on completion (per `triggered_event[]`). The ledger is the durable replay surface and the catalog endpoints are how the operator inspects the event topology.

### AR-EVT-01 — NDJSON ledger ✅ v1

The ledger lives at `data/logs/<tenant>/events/<YYYY-MM-DD>.ndjson` (`packages/runtime/src/event-ledger.ts:23-27`). Each line is a single JSON object — `{ id, name, subject?, data, ts }` (`LedgerRecord` at `event-ledger.ts:30-36`). The `appendToLedger` function returns a `payload_ref` string of the form `"<filePath>#<byteOffset>"` — the `events.payload_ref` DB column stores this pointer, so the events table is keep-able-in-cache while the actual payload lives on disk. Reads dereference the ref via a stat + open + seek + line-read.

The ledger is append-only — no in-place edits, no rewriting. Replays produce a new ledger entry with a new id (`makeId("evt")` per P0-API-01, which closed the same-millisecond-collision bug from the legacy `${id}-replay-${Date.now()}` pattern). The replay payload carries `__replayOf: <originalId>` so causality is reconstructible. Day-rolled storage matches the run-log layout (`AR-RUN-03`) so the same `tar` strategy and the same daily janitor cron apply to both.

Status: ✅ shipped. Test coverage: TC-21 (operator publish writes a ledger entry), `tc-event-ledger.test.ts` (payload_ref round-trip, multi-line append, byte-offset correctness).

### AR-EVT-02 — Event namespacing ✅ v1

Every event on the Inngest bus is namespaced `${tenantSlug}/${eventName}`. The transformation happens at three boundaries:

1. **Inbound from the operator** (`POST /v1/events` with `{ name, data }`). The route prepends the auth tenant's slug before calling `inngest.send`.
2. **Outbound from a manifest run** (`packages/runtime/src/register.ts:emitTriggeredEvent`). The agent's emitted event from `triggered_event[]` is prepended with the tenant slug before `step.sendEvent("emit", { event: namespaced, data })`.
3. **Inbound from a webhook** (`POST /v1/webhooks/:source`). After HMAC verification, the event is namespaced with the subscription's tenant and re-emitted on the bus.

The implication is that two tenants can both have a `RESUME_PROCESSED` event without colliding — the Inngest function for tenant A is `raas.matchResume` triggered on `raas/RESUME_PROCESSED`, and tenant B's identical workflow gets `acme.matchResume` on `acme/RESUME_PROCESSED`. The catalog endpoints expose the un-namespaced name (`RESUME_PROCESSED`) for UI display; the namespaced name is internal. Status: ✅ shipped. Test coverage: `tc-event-namespacing.test.ts`, the multi-tenant concurrency test (P5-TEN-01).

### AR-EVT-03 — Event catalog endpoints ✅ v1

Six event-related routes plus the catalog table form the operator-facing surface (all live at `apps/api/src/routes/v1/events.ts`):

- **`POST /v1/events`** — ingest. Validates `(name, data)`, looks up the catalog row for `events.category`, inserts into `events`, appends to the ledger, calls `inngest.send`. Supports two additive fields: `test: true` (sets `__test:true` on the Inngest envelope; propagates to `runs.is_test`) and `source: "<freeform>"` (recorded in `events.source` for trace).
- **`POST /v1/events/:id/replay`** — clones the payload of an existing event into a new event with `makeId("evt")` and stamps `__replayOf: <originalId>` in `data`. Re-fires through Inngest. Returns `{ replayed: <originalId>, new_event_id: <newId> }`.
- **`GET /v1/events`** — legacy list shape (kept for the SPA's older code).
- **`GET /v1/events/catalog`** — the tenant's `event_types` rows: name, category, description, schema. This is what the operator's Event Tester picker is populated from.
- **`GET /v1/events/recent`** — list with optional `?causality=1&seed=<id>` envelope. When the causality flag is set, the response carries the causality DAG rooted at the seed event (uses correlation_id + the `__replayOf`/`__triggerEventId` chain). The DAG is computed in `packages/runtime/src/broadcast.ts`.
- **`GET /v1/events/stream`** — SSE live tail (FR-5 of the event-tester PRD). 30s keepalive ping; per-tenant scoping; framing matches the rest of the SSE endpoints (data: lines + double-newline terminator).
- **`GET /v1/events/causality`** — explicit causality DAG endpoint (post-Phase 3 split from `/v1/events/recent`).

The Zod contract for `Event` and `EventStreamEvent` lives in `packages/contracts/src/events.ts`. Status: ✅ shipped. Test coverage: TC-21 (ingest path), TC-21-replay (replay path), `tc-event-stream.test.ts` (SSE), `tc-event-causality.test.ts` (DAG).

### AR-EVT-04 — Webhook subscriptions ✅ v1

The `webhook_subscriptions` table (`schema.ts:540-566`) lets a tenant register an external source (Slack, Stripe, GitHub, custom) so inbound HMAC-verified webhooks land on the bus as namespaced events. Each row carries `tenant_id`, `source` (free-form discriminator — `slack`, `stripe`, etc.), `secret_encrypted` (AES-256-GCM through the same vault as provider keys), `signing_algo` (default `hmac-sha256`), `enabled` (the unique index `webhook_sub_tenant_source_uq` is partial — `WHERE enabled=1` — so a tenant can have many disabled rows but only one enabled per source).

The `POST /v1/webhooks/:source` route (`apps/api/src/routes/v1/webhooks.ts`) is unauthenticated by bearer token — HMAC verification *is* the auth. The flow:

1. Read the inbound `X-Webhook-Signature` and `X-Webhook-Timestamp` headers.
2. Look up the active subscription for the source. Fall back to `WEBHOOK_HMAC_SECRET_DEFAULT` env var when no row exists (so a hot-installed integration has a working bootstrap secret).
3. Verify the HMAC: `HMAC-SHA256(secret, timestamp + "." + body)` against the supplied signature in constant time (`crypto.timingSafeEqual`).
4. Reject if the timestamp is more than **5 minutes** out (replay window).
5. Stamp the event name as `{source}.{type_from_payload}` (Slack: `slack.message`, Stripe: `stripe.charge.succeeded`, etc.), namespace it with the tenant, append to ledger, send via Inngest.

The 5-minute replay window plus per-subscription rotation makes the surface safe against replay attacks. The fallback to `WEBHOOK_HMAC_SECRET_DEFAULT` is a v1 convenience that v1.1 plans to remove — every webhook subscription should have its own secret. Status: ✅ shipped. Test coverage: `tc-webhook-hmac.test.ts` (HMAC verification, replay window, timing-safe compare), `tc-webhook-source-namespacing.test.ts`.

---

## 8. Tenant code deployment (`AR-DEP-*`)

Two parallel deployment surfaces ship in v1: manifest import (declarative JSON, the wizard) and tenant code (TypeScript bundle, the CLI). They share the `deployments` table for audit + rollback, but the on-disk artifacts and the activation steps differ. Reconcile-imports closes the boot-time crash-recovery loop for both.

### AR-DEP-01 — CLI: `agentic deploy <path>` ✅ v1

The CLI workspace at `apps/cli/` ships a single binary `agentic` with four subcommands: `init <slug>`, `deploy [path]`, `logs <run-id>`, `events tail`. The `deploy` flow:

1. Read `agentic.config.json` from the target directory (or current dir) for the tenant slug + bearer token.
2. Build the project: `tsc --noEmit` gate, then `esbuild --bundle --format=cjs --platform=node --outfile=dist/index.cjs`.
3. Tar the dist directory + the `agentic.config.json` + any `models/` directory in scope into a USTAR archive (no symlinks, no leading slashes).
4. `POST /v1/tenant-code` with `Content-Type: application/x-tar` and the auth bearer.

The server side (`apps/api/src/routes/v1/tenant-code.ts`):

1. Validate the tarball — size cap (16 MB), path-traversal scan (any entry starting with `/` or containing `..` is rejected), entry count cap (1000).
2. Unpack to a staging directory under `data/tenants/<slug>/.staging-<dpl-id>/`.
3. `tsc --noEmit` against the unpacked code to confirm the bundle is well-typed.
4. Dynamic `import()` of the staged module to confirm it loads and registers its agents.
5. Atomic rename to `data/tenants/<slug>/<version>/`. `version` is the next integer (`max(version) + 1` from `agents` for the tenant).
6. Insert a `deployments` row (`{tenantId, kind:'tenant_code', version, status:'live'}`).
7. Demote the previous live deployment for this tenant + kind to `status:'previous'`.
8. Re-register the registry entries: drop old version's exports, add new version's exports.
9. Return `200 { deploymentId, version, status:'live', diff: { agentsAdded:[], agentsRemoved:[], … } }`.

In-flight runs of the previous version complete against the old code — module-level closures are captured at run start. The hot-reload contract does not promise mid-run swap. Status: ✅ shipped (with `AR-GAP-02` caveat — `POST /v1/agents` returns 500 on tenants that already have a live tenant_code deployment due to a registry-flush race that's tracked for v1.1). Test coverage: `agentic-deploy.test.ts` (tarball path), `tc-tenant-code-versioning.test.ts` (version bump + previous-demote).

### AR-DEP-02 — Atomic-rename activation ✅ v1

The "atomic rename" guarantee is load-bearing for v1's crash-resilience story. The pattern (mirrored across both tenant-code deploys and manifest imports):

1. Write the new artifact to a staging path (`data/{tenants,imports}/<dpl-id>/...`).
2. `fsync` the file (or its parent dir for inodes).
3. Write the DB rows describing the *new* state.
4. `fs.rename(staging, live)` — atomic at the POSIX layer for same-filesystem renames.
5. Re-register Inngest (in-process module-level state — not durable, but rebuildable from the DB on next boot).

If we crash between (3) and (4), the DB points at a live deployment row whose `file_path` references the staging directory, but the manifest loader expects it in `models/<slug>-vN/`. `reconcileImports` at boot (`AR-DEP-04`) finds these rows and completes step (4). If we crash between (4) and (5), the DB and disk agree but Inngest hasn't been told about the new functions — also fixed at boot.

The `version` column in `agents` is the *deployment* version, not the agent's logical schema version. Agents bumped to a new version preserve their `kebab_id` and `name`. Status: ✅ shipped. Test coverage: TC-11 (bootstrap-idempotency), `tc-rename-crash-recovery.test.ts`.

### AR-DEP-03 — Manifest import wizard ✅ v1

The 6-step "Import workflow manifest" wizard is the declarative path. Backed by `POST /v1/tenants/:slug/manifest-import` with two modes: `validate` and `commit`. The full design is `docs/design/import-workflow-manifest.md` — what follows is the runtime-side summary.

**Step 1: source.** Operator picks: file upload, URL fetch, GitHub repo URL, or paste. URL fetches go through `safeFetch` (SSRF guard — `AR-TOOL-05`). Repo path is 501 stub for v1 (auth'd so tenant existence doesn't leak).

**Step 2: validate.** `POST /v1/tenants/:slug/manifest-import` with `mode:'validate'`. The route:
1. Insert a `deployments` row with `status:'pending'`, `expires_at: now() + 1h`. **The row's `id` IS the import session token** (review A2 — no separate session ID).
2. If another `pending` row exists for the same `(tenant, kind)`, return `423 LOCKED` with the in-flight `deployment_id` so the SPA can offer "resume or cancel".
3. Run the preflight in-memory: parse the manifest with the Zod schema; lint the result against `packages/runtime/src/lint.ts` (concurrency_excess, unreachable_event, dangling_emit, etc.); compute the diff against the current live workflow.
4. Return `200 ManifestImportPreview { deployment_id, diff, issues, model_diff, ... }`.

**Step 3: diff.** SPA renders the per-agent diff (added/removed/changed lines from the manifest, side-by-side).

**Step 4: resolve.** Operator resolves any blocking issues (`issues.blocking.length > 0` → cannot proceed without `?confirm=overwrite`).

**Step 5: preview.** Read-only final preview of what will land.

**Step 6: deploy.** `POST /v1/tenants/:slug/manifest-import` with `mode:'commit'`. The route runs four atomic phases:

1. **Preflight in-memory.** Same parse + lint, fail-fast on any blocking issue (unless `?confirm=overwrite=1`).
2. **Stage on disk.** Write `data/imports/<deployment_id>/workflow.json` (and `actions_v1.json` if shipped) + `fsync`.
3. **Synchronous SQLite tx.** All in one `db.transaction(() => { ... })()`. Demote prior live deployment for `(tenant, kind:'workflow')`; upsert `workflow_versions`; insert a fresh `deployments` row with `status:'live'`, `file_path:'data/imports/<deployment_id>/workflow.json'`; upsert `agents`/`agent_versions`/`event_listeners`; write an `audit_log` row.
4. **Atomic rename.** `fs.rename('data/imports/<deployment_id>/...', 'models/<slug>-v<N+1>/...')`. Then `reregisterInngest()` to drop old per-tenant functions and create the new ones.

**Conflict handling.** When `validate` sees the manifest would clobber non-empty live state, it returns `409 ManifestImportOverwriteRequired` with a `confirm` token; the SPA's OverwriteConfirmModal lets the operator opt in by re-issuing the commit with `?confirm=overwrite=1`. The 409 + 423 responses are sent **flat** (no envelope wrap), per the gotcha in `CLAUDE.md` — the client `unwrapEnvelope<T>()` helper has to handle both shapes.

Status: ✅ shipped end-to-end. Test coverage: TC-18 (validate+commit happy), `tc-manifest-import-conflict.test.ts` (423), `tc-manifest-import-overwrite.test.ts` (409 + confirm), `tc-manifest-import-rollback.test.ts` (rollback via `POST /v1/deployments/:id/rollback`), Playwright `e2e/import-manifest-wizard.spec.ts`.

### AR-DEP-04 — Reconcile-imports at boot ✅ v1

`reconcileImports` (`apps/api/src/services/reconcile-imports.ts:1-300`) runs at every API boot before any HTTP listener is bound. Three crash-recovery cases:

1. **Expired pending.** `deployments` rows with `status='pending' AND expires_at < now()`. Drop the row, drop the matching `workflow_versions` row (if any), `rm -rf data/imports/<deployment_id>/`. The operator's stale session is gone; their cached `deployment_id` from the SPA gets a 404 on next interaction (and the SPA's wizard prompts them to start over).
2. **Crashed rename.** `deployments` rows with `status='live' AND file_path LIKE 'data/imports/%'` — phase 3 (DB commit) succeeded but phase 4 (atomic rename) did not. The DB says the new version is live; the runtime would load the *old* manifest because the new one is still under `data/imports/<deployment_id>/`. Complete the rename: `fs.rename('data/imports/<dpl>/workflow.json', 'models/<slug>-v<N>/workflow_v<N>.json')`. Then re-register the Inngest functions for the tenant.
3. **Missing on-disk file.** `deployments` rows with `status='live' AND file_path NOT NULL AND file_path missing on disk` — someone manually deleted the file. The DB still has `workflow_versions.manifest_json` (durable, per `migrations/index.ts:13` — `manifest_json` is the source of truth for in-flight replays), so re-emit the file from the row.

Reconcile is **idempotent** — re-running it on a clean state is a no-op. The function also tolerates partial-state combinations (a single tenant in case 1 AND another in case 2 in the same boot). On error, it logs but does not abort boot — the runtime continues with whatever state it has, and the operator can use the Deployments view to see what's stuck. Status: ✅ shipped. Test coverage: `tc-reconcile-imports.test.ts` (24 scenarios across all three cases), `tc-reconcile-imports-idempotent.test.ts`.

---

## 9. Cost + budgets (`AR-COST-*`)

The cost surface is intentionally simple in v1: one row per tenant in `tenant_budgets`, two caps (tokens-per-month, USD-cents-per-month), running counters incremented after each LLM call. The strategy is **deduct-then-execute**, not reserve-then-execute — operators can race a small handful of calls past the cap, but the architectural simplification (no in-flight reservations, no refund-on-failure) is worth the few-cents overshoot.

### AR-COST-01 — `tenant_budgets` table + endpoints ✅ v1

The table (`packages/db/src/schema.ts:tenantBudgets`) has one row per tenant: `(tenant_id PK, monthly_token_cap, monthly_usd_cap, used_tokens_month, used_usd_month, period_start, updated_at)`. All cap fields are nullable — null means "unlimited" — and the USD fields are stored as integer cents to keep arithmetic exact and avoid floating-point drift.

The endpoints (`apps/api/src/routes/v1/budgets.ts`):

- `GET /v1/budgets` — read the current row, creating a default-empty one if missing (so the dashboard doesn't have to special-case the no-row state).
- `PUT /v1/budgets` — upsert caps. Body fields all optional: `monthlyTokenCap?`, `monthlyUsdCap?`, `reset?: boolean`. Setting a cap to `null` removes it (unlimited). Setting `reset: true` zeros the counters and sets `period_start` to now — used by the daily/monthly janitor (or the operator's "Reset usage" button in the cost dashboard).

A `writeAudit({ action: "budget.update", … })` row is written on every PUT so the audit trail tracks who tightened or loosened the budget. The route does not auto-reset on month boundaries — that's the v1.1 cron's job; for now the period_start sticks until an operator (or automation) calls PUT with `reset:true`. Status: ✅ shipped. Test coverage: `tc-budgets.test.ts` (CRUD + reset), `tc-budget-audit.test.ts`.

### AR-COST-02 — Pre-flight deduct + `cost_limit_exceeded` ✅ v1

The gateway calls two functions around every provider chat:

- **Before**: `assertBudgetAvailable(tenantId, provider)` (`packages/llm-gateway/src/budget.ts:94-123`) — a pure read against the `tenant_budgets` row. When `used_tokens_month >= monthly_token_cap` or `used_usd_month >= monthly_usd_cap`, it throws `LLMError("cost_limit_exceeded")`. The error is mapped by `apps/api/src/routes/v1/agent-invoke.ts:253-271` to HTTP 402 (Payment Required) — this is the only error code in the taxonomy that doesn't map to one of `auth`/`rate_limit`/`timeout`/etc, because semantically it's a pre-flight policy check, not an upstream error.
- **After**: `recordActualSpend({ tenantId, provider, tokensIn, tokensOut })` (`budget.ts:129-171`) — increments the counters with an atomic SQL `SET col = col + delta` update. The row is materialised if absent (matching the GET endpoint's lazy create).

The "deduct-then-execute" trade-off (`budget.ts:18-30`): pro — simple, no reservation bookkeeping, failures are cheap (no refund); con — a tenant with `concurrent_runs=8` can race up to 8 calls past the cap before any deduction lands, with total overshoot bounded by `(8 × max_cost_per_call)` ≈ a few cents on Sonnet pricing. v1.1 will swap to reserve-then-execute via a row-level lock when concurrency grows past 8.

The pricing for the pre-flight check lives in `PRICE_PER_MTOK_CENTS` (`budget.ts:62-77`) — cents per million tokens per provider. The mock provider has `(0, 0)` so tests never trigger budget enforcement accidentally. Bedrock and Vertex mirror Anthropic Claude / Gemini pricing as a stub. Status: ✅ shipped. Test coverage: `tc-budget-enforcement.test.ts` (cap exceeded → 402, deduct after success, no-deduct on failure), TC-13's budget integration assertions.

### AR-COST-03 — `/v1/usage` aggregation ✅ v1

`GET /v1/usage` (`apps/api/src/routes/v1/usage.ts:80-156`) is the per-tenant aggregation endpoint. The shape:

```
{
  totals: { runs, tokensIn, tokensOut, usdCents },
  byAgent: [{ key: agentName, runs, tokensIn, tokensOut, usdCents }, …],
  byModel: [{ key: modelString, runs, tokensIn, tokensOut, usdCents }, …],
  byDay:   [{ key: "YYYY-MM-DD", runs, tokensIn, tokensOut, usdCents }, …],
  budget: { monthlyTokenCap, monthlyUsdCap, usedTokensMonth, usedUsdMonth, periodStart }
}
```

Query params: `?since=<unix-ms>`, `?until=<unix-ms>`, `?limit=<n>` (clamped to 1..500, default 60). The implementation does a single `SELECT … FROM runs INNER JOIN agents` then aggregates in JS into three keyed maps, sorts byAgent and byModel descending by token total, sorts byDay ascending so charts render left-to-right.

Pricing: the route has its own `MODEL_PRICING` table keyed by model string (`usage.ts:52-63`) — finer-grained than the gateway's per-provider pricing because the usage view wants to distinguish Sonnet from Haiku from Opus. The `default` row applies when a model string isn't in the table (covers any new model that ships before the table is updated). USD computation is `Math.round((tIn * inCents + tOut * outCents) / 1_000_000)` — integer math, half-up rounding.

Status: 🟡 v1.1 — `AR-GAP-01` flags that the route is implemented but not currently registered in `apps/api/src/server.ts`. The Settings → Usage view at `/portal/[tenant]/settings/usage` hits a working endpoint via the legacy SPA bootstrap; the App Router page needs the route to land in `server.ts`. Test coverage: `tc-usage.test.ts` (groupBy correctness, since/until clamping), the page-level Playwright (skipped pending route registration).

### AR-COST-04 — Per-call cost computation ✅ v1

Two cost surfaces exist:

1. **Budget enforcement** — `costCents(provider, tokensIn, tokensOut)` in `packages/llm-gateway/src/budget.ts:79-87`. Uses the provider-level `PRICE_PER_MTOK_CENTS` table. Coarse — every Anthropic call costs Sonnet pricing regardless of which model was actually used. The few-cents overshoot from this approximation is irrelevant given the budget cap is enforced by the post-call deduct (which uses the same coarse pricing for symmetry).
2. **Reporting** — `priceCents(model, tokensIn, tokensOut)` in `apps/api/src/routes/v1/usage.ts:65-69`. Uses the model-level `MODEL_PRICING` table. Fine-grained — Sonnet vs Haiku vs Opus all have separate per-million-token prices. This is what the cost dashboard reads.

The two tables drift over time and are deliberately separate so a v1.1 update can change the reporting table without rebooting (route reads it on each request) while budget enforcement uses the gateway's table (read once at import). A v2 consolidation ticket exists to source both from `@agentic/contracts/providers` so there's a single price catalog. Status: ✅ shipped. Test coverage: `tc-cost-computation.test.ts` (coarse and fine paths), `tc-cost-table-drift.test.ts`.

---

## 10. RAAS canonical workflow walk-through (`AR-RAAS-*`)

The RAAS workflow is the worked example v1 ships with — 23 agents across 11 logical stages, exercising every action type, every event-emission pattern, both `Agent` and `Human` actors, and the HITL pause/resume contract. The full manifest is at `models/RAAS-v1/workflow_v1.json` (788 lines, 23 entries). This section walks every node in order, citing the line range and explaining what kind of step it is, what events it consumes/emits, where its logs land, and where the operator sees it in the UI.

The chinese workflow titles ship as-is in v1; `pnpm seed:rich` overlays English translations from the handoff prototype via `seedAgentMetadata()` so the operator-facing UI has readable names. Re-run after `db:seed` if you want the English-labeled tree in the workflow editor.

### AR-RAAS-01 — `1-1 syncFromClientSystem` ✅ v1

**Lines 24-64. Actor=Agent. Trigger=`SCHEDULED_SYNC` (cron-emitted by the scheduler at `packages/runtime/src/scheduler.ts`). Emits=`REQUIREMENT_SYNCED` (success) or `SYNC_FAILED_ALERT` (failure).**

Three actions: (1) `monitorAndFetchRequirement` (type=tool — calls a tenant tool to pull client-system data via HTTP), (2) `checkDeduplicatedRequisition` (type=logic — LLM dedup check by `client_unique_id + client_position_name`), (3) `persistRequisitionData` (type=logic — LLM-driven decision on insert-vs-update). One of the only entry points to the workflow; the other is `1-2 manualEntry`. Run log lands at `data/logs/raas/runs/<date>/run-<id>.log` with the agent name `syncFromClientSystem`. The condition-branching to one of the two emitted events is decided by the last step's output (see `AR-INN-04` — the step-output `__emit` field selects which `triggered_event[]` index to fire).

### AR-RAAS-02 — `1-2 manualEntry` ✅ v1

**Lines 2-23. Actor=Human. Trigger=`[]` (none — entry-only). Emits=`REQUIREMENT_LOGGED`.**

Single `manual` action. As an actor-Human agent with no trigger, this node is *not* registered with Inngest (`packages/runtime/src/register.ts:61-65` short-circuits) — the operator fires it by publishing `REQUIREMENT_LOGGED` directly via `POST /v1/events`, or the portal's New-Workflow page provides a form. The workflow editor renders it as a "manual entry" node with a distinctive Human icon (per PD-D-1). No `steps` row is written for the entry itself; the run materialises when downstream `2 analyzeRequirement` fires on the `REQUIREMENT_LOGGED` event.

### AR-RAAS-03 — `2 analyzeRequirement` ✅ v1

**Lines 65-108. Actor=Agent. Trigger=`REQUIREMENT_SYNCED|REQUIREMENT_LOGGED|CLARIFICATION_RETRY`. Emits=`ANALYSIS_COMPLETED` or `ANALYSIS_BLOCKED`.**

Three actions: `loadContextData` (tool), `assessFeasibilityAndDifficulty` (logic), `generateClarificationAndStrategy` (logic). The retry path (`CLARIFICATION_RETRY`) is the back-edge from the human-clarification stage — when the HSM finishes adding clarification answers, the workflow loops back here. Multi-trigger nodes have one Inngest function with multiple `triggers[]` entries (`register.ts:66-68`), so the same handler fires regardless of which event arrived.

### AR-RAAS-04 — `3 clarifyRequirement` + `3-2 requirementReClarification` ✅ v1

**3 lines 109-143. Actor=Agent. Trigger=`ANALYSIS_COMPLETED`. Emits=`CLARIFICATION_READY` or `CLARIFICATION_INCOMPLETE`.** Two actions, both `logic`. The decision branch chooses based on whether clarify_questions came back empty (skip → `CLARIFICATION_READY`) or non-empty (continue → `CLARIFICATION_INCOMPLETE` then human gate).

**3-2 lines 144-166. Actor=Human. Trigger=`CLARIFICATION_INCOMPLETE`. Emits=`CLARIFICATION_RETRY`.** A `manual` action that pauses the workflow on a HITL task. The HSM fills out the form, hits "Resolve", which posts to `POST /v1/tasks/:id/resolve`, which fires `task.resolved` and the manual handler closes; the agent then emits `CLARIFICATION_RETRY` which loops back to `analyzeRequirement` (`AR-RAAS-03`).

### AR-RAAS-05 — `4 createJD` + `5 jdReview` ✅ v1

**4 lines 167-202. Actor=Agent. Trigger=`CLARIFICATION_READY|JD_REJECTED`. Emits=`JD_GENERATED`.** `generateJDContent` (logic) + `handleRequisitionMapping` (logic). The `JD_REJECTED` re-entry lets the JD be regenerated after a rejection from `jdReview`.

**5 lines 203-225. Actor=Human. Trigger=`JD_GENERATED`. Emits=`JD_APPROVED` or `JD_REJECTED`.** A single `manual` action — the JD review HITL. Two possible decisions, two emit paths. The decision goes into the task resolution's `decision` field (approve→`JD_APPROVED`, reject→`JD_REJECTED`).

### AR-RAAS-06 — `6 assignRecruitTasks` ✅ v1

**Lines 226-252. Actor=Agent. Trigger=`JD_APPROVED`. Emits=`TASK_ASSIGNED`.** Single `logic` action — LLM-driven matching of recruit specialist to job posting based on the recruiter's domain expertise, current workload, and historical performance.

### AR-RAAS-07 — `7-1 publishJD` + `7-2 manualPublish` ✅ v1

**7-1 lines 253-294. Actor=Agent. Trigger=`TASK_ASSIGNED`. Emits=`CHANNEL_PUBLISHED` or `CHANNEL_PUBLISHED_FAILED`.** Three `tool` actions: `executeAutomatedPublication` (POST to job-board APIs), `generatePublishHelperPage` (renders a fallback paste-ready page), `updatePublicationStatus` (writes the publication status back). The `tool_use` field is empty in v1 — tools are dispatched by name-hint via `runTool` (`AR-TOOL-01`).

**7-2 lines 295-317. Actor=Human. Trigger=`CHANNEL_PUBLISHED_FAILED`. Emits=`CHANNEL_PUBLISHED`.** Manual fallback when the API publish fails — recruiter manually publishes on the unsupported channel.

### AR-RAAS-08 — `8 resumeCollection` ✅ v1

**Lines 318-340. Actor=Human. Trigger=`CHANNEL_PUBLISHED`. Emits=`RESUME_DOWNLOADED`.** Single `manual` action — recruiter physically downloads resumes from various boards. This is the **subject-id transition point**: upstream events carry `subject=job_requisition_id`; downstream events carry `subject=candidate_id` (one resume → one downstream chain). The transition happens at the event payload level — the manual resolver provides the candidate id list, and the workflow fans out one event per candidate.

### AR-RAAS-09 — `9-1 processResume` + `9-2 resumeFix` ✅ v1

**9-1 lines 341-399. Actor=Agent. Trigger=`RESUME_DOWNLOADED`. Emits=`RESUME_PROCESSED` or `RESUME_INVALID` or `RESUME_INCOMPLETE`.** Five actions: `uploadResume` (tool — store the file), `parseResume` (tool — extract structured data), `extractResumeInfo` (tool — entity extraction), `validateCompleteness` (logic — completeness check), `validateCandidacy` (logic — uniqueness + lock-by-recruiter check). Three possible emits depending on outcome; the workflow's biggest fan-out point.

**9-2 lines 400-422. Actor=Human. Trigger=`RESUME_INCOMPLETE`. Emits=`RESUME_DOWNLOADED`.** Manual fix when extraction failed — the recruiter manually completes the missing fields, re-emits `RESUME_DOWNLOADED` to re-enter `9-1`.

### AR-RAAS-10 — `10-1 ruleCheckerForClientResume` (NEW NODE) ✅ v1

**Lines 423-452. Actor=Agent. Trigger=`RESUME_PROCESSED`. Emits=`CLIENT_RULES_PASSED` or `CLIENT_RULES_FAILED`.** Single `logic` action: `检查客户规则` ("check client rules"). This is the node the user added in this catalog effort — it splits client-specific resume rule checking out from the broader matching engine. The `input_data` is `{client_id, candidate_id}`. The `ontology_instructions` block (line 436) is the only non-empty example in the manifest: "get the rules for a client for the resume check, the rules is defined by the client, and the rules is used to check the resume after the resume is processed, if the resume is passed the rules, then trigger the event CLIENT_RULES_PASSED, if the resume is failed the rules, then trigger the event CLIENT_RULES_FAILED". This text becomes the LLM's system prompt (with the runtime prelude as the second system message — P0-RT-11 puts tenant override first).

In the live runtime this node fires *in parallel with* `10-2 matchResume` (both trigger on `RESUME_PROCESSED`); the workflow editor renders both as siblings at the post-resume-processing fanout. v1.1 may add an upstream condition gate to only enter `10-1` for clients that have custom rules configured (saving the LLM call for the no-rule case).

### AR-RAAS-11 — `10-2 matchResume` ✅ v1

**Lines 453-502. Actor=Agent. Trigger=`RESUME_PROCESSED`. Emits=`MATCH_PASSED_NEED_INTERVIEW`, `MATCH_PASSED_NO_INTERVIEW`, or `MATCH_FAILED`.** Four actions: `validateRedlineAndBlacklist` (logic — checks Tencent history flag for past employees), `matchHardRequirements` (logic — degree, years, certifications), `evaluateBonusAndCheckReflux` (logic — bonus scoring + reflux check), `generateMatchResult` (tool — final scoring + report). Three-way emit chosen by whether interview is needed (a client preference encoded in the candidate's data). This is the workflow's "biggest" agent — four actions, three possible outcomes, the densest LLM cost per run.

### AR-RAAS-12 — `11-1 inviteInternalInterview` + `11-2 interviewExecution` ✅ v1

**11-1 lines 503-543. Actor=Agent. Trigger=`MATCH_PASSED_NEED_INTERVIEW`. Emits=`INTERVIEW_INVITED`.** Three actions: `generateInterviewInvitation` (logic), `sendInvitationEmail` (tool — email channel publish), `notifyRecruiter` (logic — generates the WeWork copy-paste message for the recruiter). The first cross-channel write of the workflow (email + WeWork).

**11-2 lines 544-566. Actor=Human. Trigger=`INTERVIEW_INVITED`. Emits=`INTERVIEW_COMPLETED`.** Manual gate — the candidate completes the AI interview (which happens outside the agent runtime in the AI-interview vendor system); the recruiter marks the task done when the interview transcript is in.

### AR-RAAS-13 — `12 evaluateInterview` ✅ v1

**Lines 567-615. Actor=Agent. Trigger=`INTERVIEW_COMPLETED`. Emits=`EVALUATION_COMPLETED`.** Four actions: `receiveInterviewResult` (logic), `analyzeInterviewResult` (logic), `evaluateWithModel` (tool — calls a tenant-defined evaluation model), `generateEvaluationReport` (logic). Heavy LLM stage — four logic/tool actions, four LLM calls.

### AR-RAAS-14 — `13 refineResume` ✅ v1

**Lines 616-650. Actor=Agent. Trigger=`MATCH_PASSED_NO_INTERVIEW|EVALUATION_COMPLETED`. Emits=`RESUME_REFINED`.** Two actions: `selectTemplateAndFormat` (logic), `generateRefinedResume` (logic). Multi-trigger node — fires whether or not the candidate went through interview.

### AR-RAAS-15 — `14-1 generateRecommendationPackage` + `14-2 packageSupplement` ✅ v1

**14-1 lines 651-700. Actor=Agent. Trigger=`RESUME_REFINED`. Emits=`PACKAGE_GENERATED` or `PACKAGE_INCOMPLETE`.** Four actions: `assemblePackageMaterials` (tool), `checkCompleteness` (logic), `requestMissingInfo` (logic), `generateFinalPackage` (logic). The package is the bundle the recruiter sends to the client (refined resume + match report + interview score + recruiter notes).

**14-2 lines 701-723. Actor=Human. Trigger=`PACKAGE_INCOMPLETE`. Emits=`RESUME_REFINED`.** Manual supplement — recruiter fills in missing fields, re-enters `14-1`.

### AR-RAAS-16 — `15 packageReview` ✅ v1

**Lines 724-745. Actor=Human. Trigger=`PACKAGE_GENERATED`. Emits=`PACKAGE_APPROVED`.** Final HITL gate before the package goes to the client. The HSM reviews the bundle, can request edits (decision=reject loops back to `14-2`), or approve.

### AR-RAAS-17 — `16 submitToClientPortal` ✅ v1

**Lines 746-787. Actor=Agent. Trigger=`PACKAGE_APPROVED`. Emits=`APPLICATION_SUBMITTED` or `SUBMISSION_FAILED`.** Three actions: `prepareSubmissionData` (logic — field-mapping into the client's form schema), `submitToClientSystem` (tool — calls the client's API or generates a paste-ready page), `handleSubmissionResult` (logic — error categorization). The workflow's terminal node — every successful run ends here.

---

## 11. Cross-cutting (`AR-X-*`)

A handful of concerns cut across every domain above. They live here so they don't have to be re-explained in every section.

### AR-X-01 — Tenant scoping rule ✅ v1

Every user-visible table carries `tenant_id` (`packages/db/src/schema.ts` § conventions header at lines 1-12). The enforcement happens at query time, not at row insert — there's no DB-level row-level-security. Queries that need tenant isolation use `tenantScope(ctx, table)` from `@agentic/db` (`packages/db/src/with-tenant.ts`) to build the predicate; direct `getDb()` access bypasses the scope and is the canonical leak vector audits flag for review.

In dev mode (`AUTH_MODE=dev` or `NODE_ENV !== "production"`), the auth plugin returns the tenant matching `AGENTIC_DEV_TENANT` (default `raas`); tests set `AGENTIC_DEV_TENANT=__system` and create rows under that synthetic tenant so they don't interfere with the dev workspace's data. The `__system` tenant is also where code agents live by default — `apps/api/src/routes/v1/agent-invoke.ts:204` passes `tenantSlug: "__system"` for sync code-agent invokes. Status: ✅ shipped. Test coverage: `tc-tenant-scope.test.ts` (cross-tenant query rejection), the cross-tenant-bleed regression test from `AR-LLM-06`.

### AR-X-02 — ID conventions ✅ v1

Every primary key is a prefixed random string generated by `makeId(prefix)` from `@agentic/shared`. The full prefix table:

| Prefix | Entity | Used where |
|---|---|---|
| `run-` | run row | `runs.id` |
| `evt-` | event row + ledger record | `events.id`, `event.id` in NDJSON |
| `agt-` | agent row | `agents.id` |
| `tsk-` | task row | `tasks.id` |
| `dpl-` | deployment row + manifest-import session token | `deployments.id` |
| `inv-` | sync-invoke correlation | `invocationId` in the agent-invoke route's log lines |
| `cor-` | cross-run correlation id | `runs.correlation_id`, event payload `__correlationId` |
| `stp-` | step row | `steps.id` |
| `wfv-` | workflow_version row | `workflow_versions.id` |
| `avr-` | agent_version row | `agent_versions.id` |
| `art-` | artifact row | `artifacts.id` (sidecar file references) |
| `aud-` | audit_log row | `audit_log.id` |
| `tok-` | API token row | `api_tokens.id` |
| `usr-` | user row | `users.id` |
| `ten-` | tenant row | `tenants.id` |
| `aml-` / `ams-` | long/short memory rows | `agent_memory_long`, `agent_memory_short` (synthetic; the natural key is composite) |

The prefix is also visible in the URL when the ID is a path param — operators looking at `/portal/raas/runs/run-AB12CD34` know immediately that's a run id. Status: ✅ shipped. Test coverage: `tc-id-shape.test.ts` (prefix correctness), implicitly every test that asserts on returned IDs.

### AR-X-03 — Audit log ✅ v1

`audit_log` (per `packages/db/src/schema.ts`) is the cross-table change trail. One row per discrete operation: `(id, tenant_id, actor_user_id, action, target_type, target_id, before_json?, after_json?, meta_json?, created_at)`. The action namespace is dotted (`budget.update`, `tenant.create`, `manifest.commit`, `agent.deploy`, `provider_key.set`, `webhook.subscribe`, `task.resolve`, `run.replay`, etc.).

Writers: every mutation route calls `writeAudit({ tenantId, action, targetType, targetId, before?, after?, meta })` via the `apps/api/src/plugins/audit.ts` helper. Reads: `GET /v1/audit` (with cursor pagination via `?cursor=<id>&limit=<n>`); the Settings → Audit log view renders rows with a diff panel that shows `before` vs `after` JSON side-by-side when both are present.

Retention: no automatic purge in v1 (audit rows are cheap and operators value the long tail). v1.1 will add a config-driven TTL. Status: ✅ shipped. Test coverage: TC-19 (audit row written for every mutation), `tc-audit-diff.test.ts` (before/after rendering).

### AR-X-04 — Auth modes ✅ v1

Two modes:

- **Dev (`AUTH_MODE=dev` or any non-production NODE_ENV)** — the auth plugin (`apps/api/src/plugins/auth.ts`) returns the tenant matching `AGENTIC_DEV_TENANT` (default `raas`, tests use `__system`) for every request. No bearer-token check, no cookie check. Cross-tenant requests still get rejected by `auth.tenantSlug !== params.slug` route guards. This is what `pnpm dev` runs under.
- **Production (default in `NODE_ENV=production`)** — bearer tokens are mandatory. `Authorization: Bearer <tok-…>` headers are checked against the `api_tokens` table (rows store SHA-256 hashes, never plaintext). On match, the token's `tenant_id` becomes the request's tenant. Missing/invalid token returns 401 with `WWW-Authenticate: Bearer`.

The `api_tokens` table also tracks `last_used_at` and `revoked_at`; the Settings → Tokens view renders both. Status: ✅ shipped. Test coverage: TC-AUTH (bearer happy + 401 + tenant-mismatch), `tc-auth-dev-mode.test.ts`.

### AR-X-05 — Cookie session (web) vs bearer (CLI/API) 🟡 v1.1

Web users authenticate via a cookie session set by `POST /v1/auth/sign-in` (`apps/web/app/(auth)/sign-in/page.tsx` + the server-side handler in `apps/api/src/routes/v1/auth.ts`). The cookie is HttpOnly, SameSite=Lax, with a 24-hour TTL — its presence implies a CSRF token in the request body (form-submit pattern; no SameSite=Strict because the dashboard makes XHRs that need the cookie).

CLI and API clients (the `agentic` binary, custom integrations, the Inngest dev server's webhooks-back-to-api) authenticate via the bearer token instead. The cookie path is implemented but **`AR-GAP-05`** notes Fastify's `@fastify/secure-session` plugin isn't enabled in production yet — the production build currently falls back to bearer for everyone, which is fine for the internal alpha but blocks an external user signup. Status: 🟡 v1.1.

### AR-X-06 — Metrics (`/metrics` Prometheus) ✅ v1

The metrics module at `apps/api/src/services/metrics.ts:103-208` defines five counters and two histograms:

| Metric | Type | Labels | Where incremented |
|---|---|---|---|
| `runs_total` | counter | `tenant, agent, model, status` | `register.ts` finalize, run-engine close |
| `tokens_total` | counter | `tenant, agent, model, direction=in\|out` | gateway response handler |
| `cost_usd_total` | counter | `tenant, agent, model` | `budget.recordActualSpend` |
| `http_requests_total` | counter | `route, method, status` | Fastify onResponse hook |
| `llm_provider_errors_total` | counter | `tenant, provider, model, code` | `gateway.chat` catch |
| `run_duration_ms` | histogram (buckets 100..600000) | `tenant, agent` | run-engine finalize |
| `http_request_duration_ms` | histogram (buckets 5..10000) | `route, method` | Fastify onResponse hook |

Exposition format is Prometheus text-exposition 0.0.4, served at `GET /metrics` with `Content-Type: text/plain; version=0.0.4`. Labels are allow-listed per-metric to bound cardinality (a wild label value like `subject=<random-uuid>` would explode the series count; the allow-list rejects unknown labels at increment time).

**Known gap:** `AR-GAP-07` — manifest runs are not currently feeding `runs_total` (the increment lives only on the code-agent path in `packages/agents/src/run-engine.ts`; the manifest path in `packages/runtime/src/register.ts:finalize` was missed in the wire-up). The v1 ops dashboard renders zero for the RAAS workflow's runs as a result. Status: ✅ infrastructure shipped, 🟡 v1.1 for manifest-run counter wire-up. Test coverage: `tc-metrics.test.ts` (text-exposition shape), `tc-metrics-cardinality.test.ts`.

---

## 12. V1 known gaps (`AR-GAP-*`)

Be honest. Here's the unfinished list culled from the audit suite — what tests don't pass, what features don't quite work, what routes aren't wired. v1.1 backlog should pick from this list.

### AR-GAP-01 — `/v1/usage` route registered but Settings-view consumer pending ✅ resolved in v1

Originally flagged as "route not wired in `server.ts`," but `apps/api/src/server.ts:105` does register `usageRoutes`. The actual remaining gap is that the App Router page at `/portal/[tenant]/settings/usage` hits the route via a `useUsage` hook that doesn't yet handle the v1 envelope shape correctly — the rendered chart shows zero buckets even when data is present. v1.1 ticket: fix the envelope unwrap. Source: `docs/audits/p2-light-views-status.md` (P2-FE-15 follow-up). Status: route ✅ shipped, hook 🟡 v1.1.

### AR-GAP-02 — `POST /v1/agents` 500 on tenants with live tenant-code deployment 🟡 v1.1

When a tenant has a live `deployments(kind:'tenant_code', status:'live')` row, the workflow editor's "Add agent" save action hits a registry-flush race: `apps/api/src/routes/v1/agents.ts` calls `bootstrapCodeAgents` on the in-flight workspace, but the dynamic `import(absoluteTenantPath)` fails because the path resolution loses the tenant version segment. Symptom: 500 with `Cannot find module '@tenants/raas/dist'`. Workaround: re-run `pnpm db:seed && pnpm dev` to rebuild from clean. Source: `docs/audits/p4-ops-status.md` § "Known issues". v1.1 fix: bake the version segment into the dynamic import path. Status: 🟡 v1.1.

### AR-GAP-03 — `agentic init` writes wrong `actions_v1.json` shape 🟡 v1.1

The CLI scaffold writes a stub `actions_v1.json` that doesn't match `ActionsManifestSchema` (`packages/runtime/src/manifest.ts:43`). On first deploy via `agentic deploy`, the server-side validation rejects the scaffold with a confusing schema error. Workaround: replace `actions_v1.json` with the RAAS sample after `agentic init` and before `agentic deploy`. v1.1 fix: update the CLI template. Source: `docs/audits/p1-frontend-cli-status.md`. Status: 🟡 v1.1.

### AR-GAP-04 — Tasks view extra "operator" row 🟡 v1.1

The Tasks list view (`/portal/[tenant]/tasks`) renders one extra row per task labeled "operator" alongside the canonical task row. Root cause: the `useTasks` hook is double-fetching from two different routes (`/v1/tasks` and `/v1/operator/tasks` — the latter is a deprecated legacy path) and merging without dedup. Cosmetic only; clicking the extra row 404s gracefully. v1.1 fix: remove the legacy fetch. Source: `docs/audits/p2-heavy-views-status.md`. Status: 🟡 v1.1.

### AR-GAP-05 — Cookie auth not enabled on Fastify in production 🟡 v1.1

See `AR-X-05`. The cookie path works in dev (and Playwright e2e); production deployments don't have the `@fastify/secure-session` plugin wired in `apps/api/src/server.ts`. This blocks production signup-by-cookie but doesn't affect any current operator (everyone uses bearer). Source: `docs/audits/p4-ops-status.md`. Status: 🟡 v1.1.

### AR-GAP-06 — `runs.emittedEvent` name join missing 🟡 v1.1

`runs.emitted_event_id` is a FK to `events.id`; the run-detail SSE payload should hydrate it into `{ id, name, subject }` so the UI can render "emitted RESUME_PROCESSED" instead of "emitted evt-AB12CD34". Currently the join is missing in `apps/api/src/routes/v1/runs.ts`'s read query, so the UI shows the raw id. Source: `docs/audits/p3-cleanup-status.md`. Status: 🟡 v1.1.

### AR-GAP-07 — Manifest runs not feeding `runs_total` counter 🟡 v1.1

See `AR-X-06`. The metric increment lives on the code-agent run-engine close path but not on the manifest's `register.ts` finalize path. Operator-facing impact: the metrics scrape shows 0 runs for the RAAS workflow even when runs are happening. v1.1 fix: add a `metrics.runs.inc({ tenant, agent, model, status })` call in `register.ts`'s finalize step.run block. Source: `docs/audits/p4-ops-status.md`. Status: 🟡 v1.1.

### AR-GAP-08 — Async invoke via Inngest reserved for v2 🔵 v2

See `AR-RUN-05`. `POST /v1/agents/:name/invoke?async=1` returns 501 with hint `"Async invocation via Inngest is reserved for v2; use sync (omit async)"` (`apps/api/src/routes/v1/agent-invoke.ts:178-188`). The Inngest function for code agents IS registered (`AR-AK-01` second half), but the API-side send/queue-tracking is unwired — clicking "queue async" produces no run row. Manifest agents are not affected (Option-B fallback always async-via-Inngest, `AR-INN-05`). Status: 🔵 v2.

### AR-GAP-09 — Manifest `tool_use` field exists but step engine ignores it 🟡 v1.1

After P0-RT-01, the manifest schema accepts `tool_use` on each agent (`packages/runtime/src/manifest.ts:AgentSchema`), and the field round-trips through `agent_versions.manifest_json`. But the step engine's `tool` action dispatcher (`packages/runtime/src/step-engine.ts:162-172`) does not consult `agent.tool_use` to pick the tool — it falls back to `runTool(ctx, hintFromName)` which guesses based on action name. The legacy `tool_use: ""` strings in RAAS-v1 are no-ops; what's needed is to wire `agent.tool_use` → tenant tool name. v1.1 fix: read `tool_use` in `runAction` and prefer it over the name-hint dispatch. Source: `docs/audits/03-ai-runtime-review.md` § 3.1 + 3.5. Status: 🟡 v1.1.

### AR-GAP-10 — `typescript_code` field round-trips but engine never executes 🔵 v2

Same as `AR-GAP-09` but for the inlined-TypeScript-snippet feature. The contract reserves the field so authors can declare "this logic step's prompt is generated by this small TS function over `input_data`" — but v1 has no sandbox to execute the snippet (and the audit `03-ai-runtime-review.md` § 11 explicitly notes "zero sandboxing"). The field is *accepted* and *stored* so v2 can land the execution path without breaking the file format. Status: 🔵 v2.

### AR-GAP-11 — No multi-turn loop for manifest agents 🔵 v2

`packages/runtime/src/step-engine.ts:callLLM` is a single-shot `gateway.chat()` call per `logic` action. Multi-turn tool-use (P1-RT-01, audit `p1-agents-status.md`) lives only on the *code-agent* run engine (`packages/agents/src/run-engine.ts`'s loop). For a manifest agent to do tool-calling, it would either need to (a) declare a tenant `defineTool` that internally does multi-step (sidesteps the manifest engine's limitation) or (b) wait for v2's unified run engine that handles both kinds. Audit recommendation: collapse the two run engines. Status: 🔵 v2.

### AR-GAP-12 — Effective failover dead for code agents 🟡 v1.1 (closing)

The gateway's per-provider retry-then-fallthrough loop (`packages/llm-gateway/src/gateway.ts:78-150`) is genuine, but `BaseAgent.run()` only sets `req.provider` (one entry, no array). P1-RT-06 added `AgentContext.providers?: ProviderId[]` and the run engine forwards it through `gateway.chat({providers})`, but the audit-confirmed bug from `03-ai-runtime-review.md` §5.6 — "Failover semantics are stronger than they look" — is only partly closed: the runtime forwards providers when callers supply them, but the typical caller (the test agent, the portal's Test Run button) doesn't supply one. v1.1 fix: per-agent `defaultProviders: ProviderId[]` configured on `BaseAgent`. Status: 🟡 v1.1.

### AR-GAP-13 — `logic` fallback foot-gun: bare description sent as user content 🟡 v1.1

When a manifest `type: "logic"` action has no matching tenant `definePrompt`, the step engine sends `${action.name}: ${action.description}` verbatim as the user message (`step-engine.ts:178-186`). For RAAS, where most logic actions ship without tenant prompts, this means the Chinese action description is what the LLM sees. The audit (`03-ai-runtime-review.md` § 1 + § 3.5) flagged this as "almost every logic action falls into this path." It works (the LLM responds in kind), but the prompt is not what the workflow author intended. v1.1 fix: require tenant `definePrompt` for every `logic` action OR refuse-to-boot with a clear error pointing at the missing prompt. Status: 🟡 v1.1.

### AR-GAP-14 — Vector memory has no driver 🔵 v2

See `AR-MEM-04`. `MemoryHandle.search(query, k)` throws `NoMemoryDriverError("vector search not configured")` until a driver is registered via `setMemoryDriver(...)`. v1 ships no default driver (the SDK contract exists but the backend doesn't). v2 ticket plans SQLite-VSS for self-host + pgvector for cloud + Qdrant as a plug-in option. Status: 🔵 v2.

### AR-GAP-15 — No structured-output enforcement at gateway level 🔵 v2

`ChatRequest.jsonMode: true` is accepted by every adapter, but the gateway doesn't enforce that the response *parses* as JSON before returning to the caller. The code-agent path has `outputSchema?: ZodType<TOutput>` (P1-RT-07) which does post-call validation + one repair turn — but the manifest path has no equivalent. Audit `03-ai-runtime-review.md` § 2.3 calls this out. v2 ticket: lift the repair loop into the gateway so all callers benefit. Status: 🔵 v2.

### AR-GAP-16 — Bedrock + Vertex adapters stubbed 🟡 v1.1

See `AR-LLM-01`. The two cloud-managed providers register fine and appear in `/v1/llm/providers`, but every chat call throws `LLMError("not_configured", "Bedrock provider stubbed — v1.1")`. The wiring is there so SDK imports compile; the real AWS Bedrock SDK + GCP Vertex SDK haven't been added because they pull a couple of MB of deps each and v1 didn't need them. Status: 🟡 v1.1.

### AR-GAP-17 — Step engine + run engine duplication 🔵 v2

The catalog has two run engines: `packages/agents/src/run-engine.ts` (code agents, multi-turn tool-use loop) and `packages/runtime/src/register.ts` + `step-engine.ts` (manifest agents, single-shot per action, no tool-use). Audit `03-ai-runtime-review.md` § 2.2 + § 11 recommends collapsing to one engine. v2 ticket: refactor into a single `RunEngine` that takes an `AgentSpec` (with code agents synthesizing a one-action spec). Status: 🔵 v2.

### AR-GAP-18 — Webhook fallback secret encourages weak ops practice 🟡 v1.1

See `AR-EVT-04`. The fallback to `WEBHOOK_HMAC_SECRET_DEFAULT` makes "ship a webhook subscription" frictionless — every source uses the default secret, which an attacker who reads the env file once can replay forever. v1.1 fix: remove the fallback, require per-subscription secret, surface a friendly error in the Settings → Integrations view when missing. Status: 🟡 v1.1.

---

**End of catalog.** Cross-references: every `AR-*` ID is stable and meant to be cited from the wave-2 merge doc; the design slice's `PD-*` IDs and the upcoming software-architect slice's `SA-*` IDs combine with these to form the full v1 inventory.
