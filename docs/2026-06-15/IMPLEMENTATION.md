# Agentic Operator — IMPLEMENTATION.md

> The master file-level, phase-by-phase build plan. Open this every morning to know what's next.

---

## 1. Document control

| Field | Value |
|---|---|
| Version | 1.0 |
| Date | 2026-05-19 |
| Status | **DRAFT — for review** |
| Authors | Tech Lead (synthesizing audits 01–04) |
| Reviewers | Engineering, Product, Design (sign-off required before code lands on `main`) |
| Companion docs | `docs/PRD.md` (product strategy), `docs/DESIGN.md` (primitives & contracts), `docs/audits/01..04` (source-of-truth findings) |
| Supersedes | n/a (first revision) |

Change log lives at the bottom of this file (§14). Every PR that lands a numbered task here must update its row in §13.

---

## 2. Plan summary

**TL;DR.** Five phases over nine weeks turn Agentic Operator from "working v1 prototype" into "v1, self-host edition Agent OS." Phase 0 fixes correctness bugs blocking everything else (manifest schema drift, hardcoded models, auth bypass, cross-tenant leaks). Phase 1 wires the real harness contract — tool-use loop, SSE streaming, real-data SPA bootstrap, cost caps. Phase 2 rebuilds the frontend in production TSX with byte-for-byte design fidelity against the v1_1 reference. Phase 3 lands the Agent-OS primitives (schedules, webhooks, memory, tenant code shipping, workflow + code-agent authoring in the portal). Phase 4 produces Dockerfiles, healthchecks, metrics, E2E suites, and a launch runbook. The label "Agent OS" sticks at the end of Phase 3.

### 2.1 Phase table

| Phase | Goal | Duration | Exit criteria (shortened — see body) |
|---|---|---|---|
| **0 — Stabilize** | Correctness bugs out; no new surface | Week 1 | Manifest schema round-trips 4 new fields; no auth bypass; no `__system` cross-tenant fallback; branch-emit + condition + per-action retries honored |
| **1 — Real harness** | End-to-end real-data path | Weeks 2–3 | Tool-use loop runs; `/v1/stream` SSE live; SPA reads `/v1/*` only; per-tenant cost cap enforced |
| **2 — Production FE** | Pixel-parity TSX portal | Weeks 4–5 | Babel-standalone removed; Monaco vendored; Playwright screenshot diff < 0.1% per view |
| **3 — Agent OS primitives** | Cross the OS threshold | Weeks 6–8 | Cron + webhook triggers shipping events; memory layer; tenants ship without monorepo edits; in-portal authoring |
| **4 — Productionize** | Ship-ready ops | Week 9 | Docker images green; SIGTERM clean; E2E suite gating CI; production runbook signed |

### 2.2 Critical path

```
Phase 0 ─┬─► Phase 1 ─┬─► Phase 3 ─► Phase 4
         └─► Phase 2 ─┘
```

- Phase 1 + Phase 2 can run in parallel after Phase 0 lands.
- Phase 3 *must* wait for Phase 1 (memory layer reuses SSE) and Phase 2 (workflow editor + code authoring live in the new TSX portal).
- Phase 4 begins as soon as Phase 3 is feature-complete; doc + ops work fans out earlier (cross-cutting workstream — §9).

**Hard blockers between phases:**
- P0-AUTH-01 (drop dev bypass) blocks every E2E test in Phase 4 — must land first.
- P0-MIG-01 (migrations on boot) blocks any Docker image being usable.
- P1-CONTRACT-01 (`@agentic/contracts` extended for `tools[]`/`tool_calls[]`) blocks the tool-use loop AND the SPA refactor.
- P2-MONACO-01 (vendor Monaco) blocks the code-authoring UI in Phase 3.

### 2.3 Out of scope for v1

These are deliberately deferred. See PRD §6.

- Public SaaS multi-tenant deployment (lack of sandbox; Phase 3 lands tenant code shipping but not isolation).
- Visual workflow *builder* with drag-drop create-from-scratch (Phase 3 ships an editor of existing manifests; from-scratch composition is v2).
- A/B routing of prompt versions, eval harness, prompt diff UI, dataset capture from runs.
- Vector / embedding retrieval (the memory layer in Phase 3 ships KV; vector is v2).
- OpenTelemetry tracing (basic Prometheus metrics only in Phase 4).

---

## 3. Conventions

### 3.1 Branch + PR strategy

- Long-lived: `main`. Tagged at end of each phase: `v1-phase-0`, `v1-phase-1`, etc.
- Working branches: `phase-N/<workstream>-<short-desc>`, e.g. `phase-0/runtime-manifest-passthrough`.
- One PR per task ID where possible. PRs > 600 lines get split unless atomicity demands otherwise.
- PR title format: `[P0-RT-04] manifest schema: add 4 new fields with .passthrough()`.
- Squash-merge to `main`. Working branches deleted on merge.
- Hot-fix lane: `hotfix/<sha-of-bug-pr>-<desc>` against `main`, fast-forward only.

### 3.2 Task numbering

`P{phase}-{workstream}-{ord}`. Workstreams:

| Code | Workstream |
|---|---|
| `RT` | Runtime (`packages/runtime/`, `packages/agents/`) |
| `LLM` | LLM gateway (`packages/llm-gateway/`) |
| `API` | Fastify backend (`apps/api/`) |
| `DB` | Schema + migrations (`packages/db/`) |
| `CON` | Contracts (`packages/contracts/`) |
| `FE` | Frontend (`apps/web/`) |
| `CLI` | CLI (`apps/cli/`, new in Phase 3) |
| `OPS` | Ops, Docker, CI, observability |
| `DOC` | Documentation (cross-cutting) |
| `TEST` | Test harness, fixtures, CI gates |
| `AUTH` | Auth, RBAC (in Phase 0, then ongoing) |

Examples: `P0-RT-04`, `P1-LLM-02`, `P2-FE-09`, `P4-OPS-03`.

### 3.3 Testing requirement per change

| Change type | Required artifacts |
|---|---|
| Schema (`packages/db`) | Migration file + up/down idempotency test |
| Contracts (`packages/contracts`) | Zod parse tests on both representative valid and invalid payloads |
| Runtime step type / register.ts | Unit test on the step-engine path + integration via `app.inject()` POSTing an event |
| API route | Unit on handler + integration via `app.inject()` for happy + at least 2 error paths |
| Frontend view | Vitest + React Testing Library for logic; Playwright screenshot diff for layout |
| Cross-tenant boundary | Two-tenant fixture test asserting 404 from tenant B for a tenant-A resource |
| LLM adapter | Mock adapter test on round-trip request/response shape |
| Cron / scheduled trigger | Inngest test using `step.sleep` fake + asserting run row written |

Every PR adds tests proportional to the change. PRs that touch security boundaries (auth, tenant scoping, webhooks, secrets) must include both positive AND negative tests.

### 3.4 Definition of done for each phase

A phase is **done** when **all** of:

1. Every numbered task in the phase is `merged` and rows in §13 reflect the change.
2. The phase's "Exit criteria" checklist (in §4–§8) passes.
3. `pnpm typecheck && pnpm lint && pnpm test` is green on the phase's terminal commit.
4. `docs/USER_GUIDE.md` reflects new operator-visible behavior.
5. The phase's risk register entries (§10) have either been retired or carry an explicit "accepted with mitigation" note.
6. A short demo (≤15 minutes) is recorded showing the phase's exit criteria, linked from this file.

### 3.5 Commit messages reference audit findings

When a commit closes an audit finding, the message body includes a line:

```
Closes audit 03-ai-runtime-review §3.1 (manifest schema drift).
```

This produces a backlink — readers can navigate from the audit to the commit that fixed it.

---

## 4. Phase 0 — Stabilize the foundation (Week 1)

**Goal.** Fix correctness bugs blocking everything downstream. No new surface; no new endpoint; no UI work.

**Audit cross-refs.** This phase consumes the critical entries from audits 02 §13 (#1–5, #7), 03 §15 (#1, #2, #3, #5, #6, #12), and 04 §16 Phase 0.

### 4.1 Runtime correctness

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P0-RT-01** | Manifest schema: add `input_data`, `ontology_instructions`, `tool_use`, `typescript_code` to `AgentSchema` with `.passthrough()` *and* explicit fields | `packages/runtime/src/manifest.ts:28-37` | S | Unit: parse a fixture with all 4 fields, assert preserved in `manifest_json`; parse without, assert default `undefined`. Integration: re-bootstrap `models/RAAS-v1/`, assert `agent_versions.manifest_json` round-trips. | All 23 RAAS agents retain their 4 new fields end-to-end. `pnpm db:studio` shows the JSON intact. |
| **P0-RT-02** | Branch-emit: agent output's `emit?: string` selects from `triggered_event[]`; fall back to `triggered_event[0]` | `packages/runtime/src/register.ts:368` | M | Unit: agent with 3 triggered events returns `{emit: "MATCH_FAILED"}` → that event emitted. Default behavior preserved. Integration: matchResume fixture with 3 branches asserts correct downstream event for each. | `matchResume` and any branching agent emits correct event. Contract: agent step-engine output may carry `__emit: string` discriminator. |
| **P0-RT-03** | `logic` step: real prompt assembly using `ontology_instructions` + structured system prompt + `lastResult` JSON marshalling | `packages/runtime/src/step-engine.ts:178-179` (auto-built path) and `:127-156` (tenant prompt path) | M | Unit: assert auto-built prompt contains: agent description, ontology_instructions block, `lastResult` JSON, action description. For tenant prompts, assert `PromptDescriptor.system` is included. | A real provider sees: ``System: <ontology>\n<rest of agent description>\n--\nUser: <action.description>\nContext (lastResult): <JSON>``. Mock provider still passes. |
| **P0-RT-04** | Hardcoded `"mock-model-v1"`: replace with `response.model` from gateway response | `packages/runtime/src/register.ts:409` | XS | Unit: invoke manifest agent with mock provider, assert `runs.model` in DB matches the mock's reported model string. | No row in `runs` says `mock-model-v1` unless the mock provider actually ran. |
| **P0-RT-05** | `action.condition` evaluation: ship a deterministic minimal evaluator (boolean expression over `lastResult` + `event.data`); skip step when false | `packages/runtime/src/step-engine.ts`, `packages/runtime/src/register.ts:283` | M | Unit: condition `lastResult.score > 0.5` skips when false. Condition `event.data.subject != null` includes when truthy. Malformed condition logs a warning and **runs** the step (fail-open). | Step rows for skipped actions have `status='skipped'` + reason. Run completes faster. |
| **P0-RT-06** | Per-action `retries` + `timeout_s`: read from `ActionSchema` and apply to `step.run(name, opts, body)` | `packages/runtime/src/register.ts:283-349`, `step-engine.ts` callers | S | Unit: action with `retries: 5` retries five times. `timeout_s: 60` cancels at 60s. | Step rows record actual retry count; Inngest event log shows the timeout-driven failure. |
| **P0-RT-07** | `bootstrapAll` idempotency: do NOT re-flip a `live` deployment when the manifest hash is unchanged. Add `AGENTIC_REBOOTSTRAP=force` env to bypass. | `packages/runtime/src/bootstrap.ts:174-194`, `packages/agents/src/bootstrap.ts:40-218` | S | Integration: boot twice in a row without code change; assert no new `deployments` row. Set `AGENTIC_REBOOTSTRAP=force`; assert new row inserted. | `pnpm dev` restart does NOT silently roll back operator-pinned versions. |
| **P0-RT-08** | Configurable `modelDir`: required env `AGENTIC_MODELS_DIR`, no hardcoded absolute path | `packages/runtime/src/bootstrap.ts:72` | XS | Unit: missing env throws clear error; relative path resolves from `process.cwd()`. | Repo runs on any machine. Path is no longer `/Users/kenny/CSI-AICOE/agentic-operator/models`. |
| **P0-RT-09** | Manifest engine writes step-input/output artifact sidecars (parity with code path) | `packages/runtime/src/step-engine.ts` (extend with `writeArtifact` helper from `packages/agents/src/run-engine.ts`) | S | Integration: a manifest run completes → `data/artifacts/<runId>/step-1-{input,output}.json` exists. | Manifest and code agents both leave the same artifact trail; replay UI can reload either kind. Closes Audit #3 §10.2, §11.2. |
| **P0-RT-10** | Manifest `task_timeout_s` honored: replace hardcoded `7d` waitForEvent timeout with action value | `packages/runtime/src/register.ts:209-215` | XS | Unit: manual step with `task_timeout_s: 60` times out at 60s, status=`failed`, reason=`task_timeout`. | Stale human tasks auto-fail at the manifest-declared deadline. Closes Audit #3 §4.6. |
| **P0-RT-11** | `PromptDescriptor.system` honored by step engine on tenant-prompt path (currently dropped) | `packages/runtime/src/step-engine.ts:127-156` | XS | Unit: tenant prompt with `system: "..."` is the first system message; auto-ontology prepended after. | Tenant prompt overrides actually reach the LLM. Closes Audit #3 §7.2. |
| **P0-RT-12** | Delete dead `verifyHmac` function | `apps/api/src/plugins/auth.ts:96-103` | XS | grep returns 0 references after deletion. | Closes Audit #2 §9.7. |
| **P0-API-01** | Fix `events.replay` id collision: use `makeId("evt")` instead of `${id}-replay-${Date.now()}` | `apps/api/src/routes/v1/events.ts:57` | XS | Unit: two replays of the same event in the same millisecond produce distinct ids. | Closes Audit #2 §3 events row. |
| **P0-DB-01** | Add `created_at` / `updated_at` to `agents`, `agent_versions`, `event_listeners`, `event_types`, `entity_types` (Drizzle migration) | `packages/db/src/schema.ts` + new `0002_temporal_columns.sql` | S | Unit: insert + update touch the columns. Audit-log view (`P1-API-03`) reads `updated_at` non-null. | Audit views have temporal context. Closes Audit #2 §4.4. |

### 4.2 Boot + migrations

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P0-MIG-01** | Run migrations on boot before any DB write | New step 0 in `apps/api/src/bootstrap.ts` (before `getLLMGateway`). Use `packages/db/src/migrate.ts` programmatically. | S | Integration: delete `data/agentic.db`, start API, assert schema applied + `bootstrapCodeAgents` succeeds. | Cold start on empty DB succeeds without a manual `pnpm db:migrate`. |
| **P0-MIG-02** | `INSERT … ON CONFLICT DO NOTHING` on every bootstrap idempotency path (workflow, agent, agent_version, deployment, event_listener) | `packages/runtime/src/bootstrap.ts`, `packages/agents/src/bootstrap.ts` | S | Integration: two API processes booting back-to-back; neither crashes. | Rolling deploy / blue-green safe at the DB layer. |

### 4.3 Auth + tenant isolation

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P0-AUTH-01** | Drop `NODE_ENV !== "production"` bypass. `AUTH_MODE=dev` becomes an explicit opt-in (CI + local dev only). | `apps/api/src/plugins/auth.ts:29` | S | Unit: `NODE_ENV=test` without `AUTH_MODE=dev` returns 401 on `/v1/runs`. With `AUTH_MODE=dev` and seeded tenant, returns 200. | Production deploy with `NODE_ENV=production` *cannot* fall back to dev tenant by accident. |
| **P0-AUTH-02** | Remove `__system` cross-tenant fallback on `/v1/runs/:id` and `/v1/runs/:id/logs`. Code-agent visibility moves behind explicit `?include_system=1` query param. | `apps/api/src/routes/v1/runs.ts:30-31`, `apps/api/src/routes/v1/runs-logs.ts:35-39` | S | Two-tenant test: tenant A fetches tenant B's code-agent run → 404. Same with `?include_system=1` → still 404 (membership check on `__system` not yet wired) unless caller is the platform admin. | No path leaks `__system` runs to a caller who didn't ask. |
| **P0-AUTH-03** | `?tenant=` query param on `/v1/agents`: drop or gate behind `memberships` lookup. v1 → drop entirely; superadmins use a separate `/v1/admin/...` surface (out of scope for Phase 0). | `apps/api/src/routes/v1/agents.ts:70` | XS | Unit: passing `?tenant=other` is now a no-op. | Caller cannot read another tenant's agent list. |
| **P0-AUTH-04** | `/v1/agents/:name/invoke` hardcodes `tenantSlug: "__system"`: replace with `auth.tenantSlug`, fall back to `__system` only for explicitly-system-scoped code agents (kind=`code` + scope=`system`). | `apps/api/src/routes/v1/agent-invoke.ts:91` | S | Unit: `raas` token invoking `testAgent` (system-scoped) → runs under `__system`; `raas` invoking a future raas-scoped code agent → runs under `raas`. | Code-agent runs no longer pool under `__system` indiscriminately. |
| **P0-AUTH-05** | Rotate **live** OpenRouter, OpenAI, Google keys observed in workstation `.env`. Update `.env.example` to clearly say "never commit real keys" with checked-in invariant. | env files only; no code changes | XS | Manual: confirm new keys work via `tc-1-llm-providers.test.ts`. | Old keys revoked, new ones present in 1Password (or chosen vault), referenced from `.env`. |

### 4.4 Phase 0 exit criteria

- [ ] All P0 task IDs above are merged.
- [ ] `pnpm test` green; all five `tc-*` test files green.
- [ ] New tests: `tc-6-multi-tenant-isolation.test.ts`, `tc-7-manifest-schema-fields.test.ts`, `tc-8-branch-emit.test.ts`, `tc-9-condition-eval.test.ts`.
- [ ] `AGENTIC_REBOOTSTRAP=force` documented in `.env.example`.
- [ ] No `manifest_json` row missing the 4 new fields after re-bootstrap.
- [ ] No `runs.model` row contains `mock-model-v1` unless mock provider was used.
- [ ] Live API keys rotated; old keys revoked at the provider.

### 4.5 Phase 0 dependencies

- None. P0 is the first work that happens.
- Within P0: `P0-MIG-01` precedes everything else (otherwise tests of fresh-DB scenarios fail).
- `P0-AUTH-01` must land with `P0-AUTH-02..04` in the same PR or commit train to avoid prod-bypass windows.

---

## 5. Phase 1 — Real harness (Weeks 2–3)

**Goal.** Wire the harness contract correctly. End-to-end real-data path from manifest → run → result. The SPA can stop synthesizing.

**Audit cross-refs.** Audit 03 §15 #4, #7, #8; audit 04 §13 #8 (tool-use loop), §13 #10 (memory KV deferred to Phase 3), §13 #11 (replay UI partial); audit 02 §13 #10 (data plane unification); audit 01 R-4 (window-global state).

### 5.1 Contracts first

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P1-CON-01** | Extend `ChatMessage.content` to `string \| ChatContentBlock[]`; `ChatContentBlock = TextBlock \| ToolUseBlock \| ToolResultBlock` | `packages/contracts/src/llm.ts`, `packages/llm-gateway/src/types.ts:14-17` | M | Unit: parse representative Anthropic-shape and OpenAI-shape tool-use messages. Snapshot test for type narrowing. | `ChatMessage` round-trips through all 14 providers without loss. |
| **P1-CON-02** | Add `tools?: ToolDef[]` to `ChatRequest`; `tool_calls?: ToolCall[]` to `ChatResponse`; `ToolDef = { name, description, input_schema: JSONSchema }`. | `packages/contracts/src/llm.ts`, `packages/llm-gateway/src/types.ts:39-49` | M | Unit: chat-request with `tools[]` passes through the OpenAI-compatible adapter; response with `tool_calls[]` parses. | All 14 provider adapters compile; mock provider can simulate a tool call. |
| **P1-CON-03** | Add `RunStreamEvent` union for SSE on `/v1/stream`: `run.started \| run.step.started \| run.step.completed \| run.completed \| run.failed \| event.emitted \| task.created \| task.resolved`. | `packages/contracts/src/runs.ts` (new types) | S | Unit: each variant parses and discriminates correctly. | Frontend `useStream()` hook can switch on `event.type` with full type inference. |
| **P1-CON-04** | Add `agent.emit?: string` to the optional output shape of a manifest step in `@agentic/contracts`. Document the contract in code comments. | `packages/contracts/src/agents.ts`, prose docs | XS | Type test. | P0-RT-02's `__emit` discriminator is now a typed field. |

### 5.2 Tool-use loop

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P1-LLM-01** | Anthropic adapter: emit/consume `tool_use` content blocks; preserve `tool_call_id` round-trip. | `packages/llm-gateway/src/adapters/anthropic.ts` | M | Unit: send chat with 1 tool, receive `tool_use` block, send `tool_result` back, get final assistant text. | Real Anthropic call with one tool round-trips correctly. |
| **P1-LLM-02** | OpenAI-compatible adapter: emit/consume `tool_calls` array; map to/from internal `ChatContentBlock` shape. Applies to openai, openrouter, groq, together, mistral, deepseek, qwen. | `packages/llm-gateway/src/adapters/openai-compatible.ts` | M | Unit: same as P1-LLM-01 but via openai-compat. | Real OpenAI call with 1 tool round-trips. |
| **P1-LLM-03** | Gemini adapter: function calling round-trip. | `packages/llm-gateway/src/adapters/gemini.ts` | M | Unit: same as above. | Real Gemini call with 1 tool round-trips. |
| **P1-LLM-04** | Mock provider: deterministic tool-call simulation — pattern-match on prompt to emit a tool_use block. | `packages/llm-gateway/src/adapters/mock.ts` | S | Unit: mock provider with a "test_tool" defined emits `tool_use { name: "test_tool", input: { … } }`. | Tests can exercise the loop without a network. |
| **P1-RT-01** | `BaseAgent.maxSteps` becomes live. Multi-turn loop in `run-engine.ts` reads `tool_calls`, dispatches to registered tools, appends results, re-calls LLM until `stop_reason !== 'tool_use'` OR `maxSteps` reached. | `packages/agents/src/run-engine.ts:101-272`, `packages/agents/src/base-agent.ts:42` | L | Unit: an agent with `maxSteps=3` and a tool that returns a value runs the LLM up to 3 turns. Token usage aggregated across turns. Steps row per turn. | A code agent can call a tool, see its result, call another tool, finish. `runs.tokens_in/out` are sums across turns. |
| **P1-RT-02** | `BaseAgent.getTools(ctx)` hook: returns the `ToolDef[]` for this agent. Default implementation returns empty. | `packages/agents/src/base-agent.ts` | S | Unit: agent overriding `getTools` returns its declared tools; default returns `[]`. | Code agents declare tools idiomatically. |

### 5.3 New step types

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P1-RT-03** | New step types `condition`, `delay`, `subflow` in `StepTypeEnum`. Wire dispatch in `step-engine.ts` and register hooks in `register.ts`. | `packages/runtime/src/manifest.ts:14`, `step-engine.ts:158-209`, `register.ts` | M | Unit: each step type executes its expected behavior. `delay: 3000` actually awaits via `step.sleep`. `subflow: <agentName>` invokes another agent and threads its output as `lastResult`. | Manifest authors can express `if/wait/composeOther`. |
| **P1-RT-04** | `runs.parentRunId` column (Drizzle migration). `subflow` step populates it on the child run. | `packages/db/src/schema.ts`, `packages/db/drizzle/0003_parent_run.sql`, `register.ts` | S | Unit: subflow run row has `parentRunId` set. | Trace tree in portal can be built. |

### 5.4 Real-time API

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P1-API-01** | SSE endpoint `GET /v1/stream?tenant=<slug>` pushes `RunStreamEvent` from a per-tenant broadcast channel (in-process EventEmitter for v1). | New `apps/api/src/routes/v1/stream.ts` | M | Integration: POST `/v1/events`, observe `run.started` + `run.step.*` + `run.completed` on the SSE stream within 1s. | Browser subscribers receive real-time updates. |
| **P1-RT-05** | Wire `step-engine.ts` + `register.ts` to publish lifecycle events to the broadcast channel. | `register.ts` (init, action, finalize step.runs), `step-engine.ts` | S | As above. | Every step start/end is observable externally. |
| **P1-API-02** | Audit log writes on every state mutation: rollback, task resolve, deployment create, code-agent register, agent enable/disable. | `apps/api/src/plugins/audit.ts`, callers across `routes/v1/*` | S | Unit: each route under test writes one `audit_log` row. | `SELECT COUNT(*) FROM audit_log` grows monotonically with operator actions. |
| **P1-API-03** | `GET /v1/audit?since=&until=&actor=` read endpoint (paginated). | new `apps/api/src/routes/v1/audit.ts` | S | Unit: list returns rows tenant-scoped + filters work. | Compliance can read the audit trail. |

### 5.5 SPA data plane unification

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P1-FE-01** | `/api/spa/bootstrap` rewritten to fetch ONLY from `/v1/*` (no JSON file reads, no synthesis). The new file calls `/v1/counts`, `/v1/runs`, `/v1/events`, `/v1/tasks`, `/v1/agents`, `/v1/workflows/dag`, `/v1/event-types`, `/v1/entity-types` and assembles the payload. | `apps/web/app/api/spa/bootstrap/route.ts`, `apps/web/lib/spa/derive.ts` (synthesizers deleted) | M | Unit: with the API stub returning fixtures, `bootstrap` returns the expected `SpaBootstrap` shape. | The portal shows real data; synthesis paths are gone. |
| **P1-FE-02** | Replace `useLiveData` window-event pattern with TanStack Query + SSE subscription (one hook per resource). | `apps/web/public/portal/views/*.jsx`, new `apps/web/lib/hooks/useStream.ts` and `useRuns.ts`/`useEvents.ts`/`useTasks.ts`/`useAgents.ts` | M | Component test: simulate a `run.started` SSE event, assert `useRuns()` data updates. | No more `window.dispatchEvent('raas-runs-updated', …)`. |
| **P1-FE-03** | Remove `window.RAAS_*` globals. Components consume hooks via props or a React context. (Babel-standalone still loads in this phase — see Phase 2 for replacement — but state moves to React.) | All `apps/web/public/portal/views/*.jsx` and `app.jsx` | L | Manual: page works after refresh; rendered runs/events match `/v1/*` output. | Window globals exist only for theme/density/tweaks debug shim. |

### 5.6 Cost control

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P1-DB-01** | New table `tenant_budgets`: `{ tenant_id, monthly_token_cap, monthly_usd_cap, used_tokens_month, used_usd_month, period_start }`. | `packages/db/src/schema.ts`, migration `0004_tenant_budgets.sql` | S | Migration up/down test. | Schema available. |
| **P1-LLM-05** | Gateway hook: before each `chat()` call, read tenant budget; deduct expected token cost; on over-budget throw `LLMError("cost_limit_exceeded")`. After call, deduct actual cost via `tokens_in/out × catalog price`. | `packages/llm-gateway/src/gateway.ts:71-124`, new `packages/llm-gateway/src/budget.ts` | M | Unit: tenant with cap=100, agent that costs 90 → first call ok, second → 429 `cost_limit_exceeded`. | Cost cap enforced. |
| **P1-API-04** | New `apps/api/src/routes/v1/budgets.ts`: `GET /v1/budgets`, `PUT /v1/budgets`. Operator UI later. | new file | S | Unit: GET returns the row; PUT updates it. | Operators can set caps via API. |

### 5.7 Code-agent harness, structured output, CLI

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P1-RT-06** | BaseAgent passes `req.providers` chain to gateway, restoring provider failover for code agents | `packages/agents/src/run-engine.ts:165` | S | Unit: code agent with `providers: ["anthropic", "mock"]` falls over to mock when anthropic throws. | Failover works for both code + manifest agents. Closes Audit #3 §5.6. |
| **P1-RT-07** | Structured-output validate + repair-retry loop. Reads `BaseAgent.outputSchema`; on parse-fail re-prompts once with the parse error inline. | `packages/agents/src/run-engine.ts` | M | Unit: agent with `outputSchema = z.object({ score: z.number() })`; LLM returns malformed JSON; engine retries once with repair prompt; second response parses; assert success. Two consecutive failures → run marked `failed` with `output_parse_error`. | Closes Audit #3 §15 #7. |
| **P1-RT-08** | Code agents register as Inngest functions (Path A — sync inline AND Inngest both available). `?async=1` on `/v1/agents/:name/invoke` enqueues the Inngest event; default remains sync inline. | `packages/agents/src/bootstrap.ts` (extract `registerCodeAgentFn`), `apps/api/src/routes/v1/agent-invoke.ts` | M | Integration: sync invoke returns 200 with `AgentResult`; async invoke returns 202 with `runId`; status reachable via `/v1/runs/:id`. | Both invocation styles work on the same code path. Closes Audit #3 §9.1 #6. |
| **P1-DB-02** | Schema-version `_meta` table + boot-time guard ("refuse to start if DB schema_version > supported"). | `packages/db/src/schema.ts` + new migration `0005_schema_meta.sql`; check in `apps/api/src/bootstrap.ts` | S | Integration: bump `_meta.schema_version` ahead of code; boot refuses with clear error. | Rollbacks safe. Closes Audit #2 §4.2 / DESIGN §13.3. |
| **P1-CLI-01** | New `apps/cli` package: `agentic init` scaffolds a tenant project (`data/tenants/<slug>/` with example agent + tool). | new `apps/cli/src/commands/init.ts` | M | Integration: `agentic init demo` creates the expected file tree; `pnpm dev` picks it up. | Audit #4 §13 #1 (P0 Must-Have) addressed. |
| **P1-CLI-02** | `agentic deploy [path]` — typecheck tenant code + POST to `/v1/agents` for atomic deploy. | `apps/cli/src/commands/deploy.ts` | M | Integration: deploy creates `deployments` row; rollback works via `agentic rollback`. | Atomic deploy from CLI. |
| **P1-CLI-03** | `agentic logs <run-id> [--tail]` — fetch run log via `/v1/runs/:id/logs`, optionally tail (SSE). | `apps/cli/src/commands/logs.tail.ts` | S | Manual: open a run in portal + `agentic logs` shows same content in real time. | CLI parity with portal log view. |
| **P1-CLI-04** | `agentic events tail` — SSE subscribe to `/v1/stream`; pretty-print run/event/task lifecycle. | `apps/cli/src/commands/events.tail.ts` | S | Manual: trigger a run; CLI prints the lifecycle. | CLI parity with portal event ticker. |
| **P1-API-04b** | Soft-delete + retention: `events.deleted_at`, `runs.deleted_at`, `tasks.deleted_at`; nightly Inngest cron sweeps `WHERE received_at < now() - retention`. | `packages/db/src/schema.ts`, `packages/runtime/src/retention.ts` (new Inngest scheduled function) | S | Integration: old rows are tombstoned not hard-deleted; sweep idempotent. | Closes Audit #2 §13 #9. |

### 5.8 Phase 1 exit criteria

- [ ] A real code agent with `maxSteps=3` can call a tool, see its result, call another, return.
- [ ] SSE stream emits all lifecycle events; verified with `curl -N`.
- [ ] `/api/spa/bootstrap` no longer reads disk JSON; no synthesis code remains.
- [ ] Audit log populated on every state-mutating route; readable via `/v1/audit`.
- [ ] Two new manifest step types (`condition`, `delay`, `subflow`) work end-to-end.
- [ ] Cost cap blocks a tenant that exceeds budget; UI shows the budget row.
- [ ] All 14 LLM provider adapters compile against the extended `ChatMessage` shape; the 3 most-used (Anthropic, OpenAI-compat, Gemini) round-trip a real tool call.

### 5.9 Phase 1 dependencies

- Blocks on: P0-RT-01..04 (manifest schema + branching) — the tool-use loop assumes the manifest fields are persisted.
- Blocks on: P0-AUTH-* — SSE endpoint requires real auth or all tenants can subscribe to all streams.
- Parallel to: Phase 2 (so long as the TSX rewrite consumes the same `@agentic/contracts`).

---

## 6. Phase 2 — Production frontend (Weeks 4–5)

**Goal.** Replace Babel-standalone with a real TSX build, **byte-for-byte design fidelity** with `agentic-operator_v1_1/`. Babel-SPA at `apps/web/public/portal/` is deleted at the end of this phase.

**Audit cross-refs.** Audit 01 §6 (deltas D-1..D-11), §7 (risks R-1..R-11), §9 (acceptance checklist).

### 6.1 Build pipeline

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P2-FE-01** | New TSX portal at `apps/web/app/portal/`. App Router routes per view: `/portal`, `/portal/workflows`, `/portal/agents/[kebab]`, `/portal/runs/[id]`, `/portal/events`, `/portal/tasks`, `/portal/logs`, `/portal/deployments`, `/portal/settings`. | `apps/web/app/portal/**` | L | Manual: each route renders without errors; Next.js builds with `next build` succeeds. | URLs deep-link to views. |
| **P2-FE-02** | Extract CSS variables from `apps/web/public/portal/index.html:12-60` into `apps/web/styles/tokens.css` (dark + light themes). Loaded via `apps/web/app/layout.tsx` global. | `apps/web/styles/tokens.css`, `apps/web/app/layout.tsx` | S | Visual: dark/light toggle works; tokens match exact hex values from audit 01 §2.1. | All `var(--*)` references resolve. |
| **P2-FE-03** | Inline styles: keep verbatim. No Tailwind / styled-components in this phase. (Risk mitigation R-1.) | All `.tsx` files | — | Screenshot diff per view against v1_1. | Pixel parity within 0.1%. |

### 6.2 Monaco

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P2-FE-04** | Vendor Monaco via `@monaco-editor/react` + `monaco-editor-webpack-plugin`. Drop unpkg CDN loader. Re-apply `agentic-dark` theme verbatim. | `apps/web/app/portal/components/MonacoEditor.tsx`, `apps/web/next.config.mjs` | M | Integration: Monaco loads with no network requests. Theme matches v1_1 cursor color (`#d0ff00`). | No third-party CDN, works offline, CSP-safe. |

### 6.3 Port views

Each ported as one task. Each PR includes Playwright screenshot diff vs. v1_1 baseline.

| ID | View | Source | Effort | Notes |
|---|---|---|---|---|
| **P2-FE-05** | Layout shell (Sidebar + TopBar) | `apps/web/public/portal/app.jsx:108-374` | M | Includes TenantSwitcher, navigation, live toggle, user chip. |
| **P2-FE-06** | Core primitives | `components.jsx` (Icon, Badge, ActorTag, StatusDot, Panel, Stat, Button, Sparkline, Kbd, ViewHeader, Empty, formatters) | M | All 14 primitives translated to TSX with named exports. |
| **P2-FE-07** | Dashboard | `views/dashboard.jsx` | M | 5 KPI cards, active runs, agent activity, event ticker, pending tasks, stage funnel. |
| **P2-FE-08** | Workflows | `views/workflows.jsx` (1000 lines) | L | Most complex. DAG canvas, edge SVG, edit-mode banner, NewWorkflowModal, ImportManifestModal. Preserve LAYOUT map (audit 01 §4.2). |
| **P2-FE-09** | Agents (list + detail) | `views/agents.jsx`, sub-`views/agent-code.jsx` | L | Includes 5 tabs (config/io/code/versions/runs) and EditConfigTab. Includes the agent splitter (D-5) and code-tab splitter + maximize (D-6). |
| **P2-FE-10** | Runs (list + detail) | `views/runs.jsx` | M | Includes the 5th "agent" tab (D-7) and the TEST badge (D-8). |
| **P2-FE-11** | Events | `views/events.jsx` | M | Histogram strip, filters, list, detail. |
| **P2-FE-12** | Tasks | `views/tasks.jsx` | M | Includes all 6 payload-type renderers (audit 01 §4.6). |
| **P2-FE-13** | Logs | `views/logs.jsx` | S | File tree + log body + SSE follow. |
| **P2-FE-14** | Deployments | `views/deployments.jsx` | M | Including the 3-method DeployWizard. |
| **P2-FE-15** | Settings | `views/settings.jsx` (2234 lines) | L | 9 sections. Reuse design tokens for Field / Toggle / RoleBadge. |
| **P2-FE-16** | Tweaks panel | `tweaks-panel.jsx` | M | Translate `postMessage` plumbing to `localStorage` (audit 01 R-7). |
| **P2-FE-17** | Import Manifest modal | `views/import-manifest.jsx` | M | 6-step wizard. |

### 6.4 Real state & deltas

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P2-FE-18** | Replace `window.testAgent` (D-4) with `POST /v1/agents/:name/invoke?testRun=1`. Backend marks the run `is_test=true` (new column). | `packages/db/src/schema.ts`, `apps/api/src/routes/v1/agent-invoke.ts`, `apps/web/app/portal/agents/[kebab]/page.tsx` | M | E2E: click "Test run" → 1 run row inserted with `is_test=true` → run completes → TEST badge appears. | No more client-side synthetic engine. |
| **P2-FE-19** | Authentication: cookie-session via Next route handlers. `/api/auth/login` issues a signed cookie; Fastify auth plugin reads cookie OR Bearer. Browser SPA fetches `/v1/*` carrying the cookie automatically (same-origin). | `apps/web/app/api/auth/*`, `apps/api/src/plugins/auth.ts` | L | E2E: visit `/portal` unauthenticated → redirect to `/login`. Sign in → portal loads. | Real auth from browser. |
| **P2-FE-20** | Wire up `--density` (audit 01 R-8): apply a scale factor to padding/font-size in the token CSS via custom property arithmetic. | `apps/web/styles/tokens.css` | S | Visual: compact/comfortable toggle resizes spacing. | Density toggle works end-to-end. |
| **P2-FE-21** | Delete `apps/web/public/portal/`. Update `next.config.mjs` rewrites: `/` → `/portal`, fallback SPA rewrite removed. | `apps/web/public/portal/`, `apps/web/next.config.mjs` | S | Manual: no 404s on any route. | Babel-standalone disabled; one source of truth. |
| **P2-FE-22** | Toast / snackbar system: globally available `useToast()` hook + `<ToastRegion>` mounted in app shell. Every failed mutation surfaces a toast. | new `apps/web/app/portal/components/Toast.tsx`, integration in every mutation hook | S | Unit: rejected mutation → toast appears. Visual: stacked toasts dismiss after 5s. | Closes Audit #1 §8 #4 (pre-port blocker). FR-PORT-11. |
| **P2-FE-23** | Cmd-K command palette: searches agents / runs / events / tasks / settings; opens with `⌘+K` (or remove the button if descoped — pick one). | new `apps/web/app/portal/components/CommandPalette.tsx` | M | E2E: `⌘+K` opens palette, typing "match" jumps to `matchResume` detail. | Closes Audit #1 §8 #5. The button shipped in v1_1 must either work or be removed. |
| **P2-FE-24** | Accessibility: `:focus-visible` styles globally, ARIA labels on all icon-only buttons, keyboard nav (Tab/Shift-Tab/Enter/Escape) between focusable controls in all 9 views. | `apps/web/app/portal/components/*.tsx`, `apps/web/styles/tokens.css` | M | Manual + axe-core scan: 0 critical violations on each view. | FR-PORT-13. Closes Audit #1 §3.1.1, §7 R-5. |
| **P2-FE-25** | Tenant in URL pathname: routes become `/portal/:tenant/...`. Tenant switcher pushes a new path; deep links retain tenant. | `apps/web/app/portal/[tenant]/...` (App Router restructure), `lib/hooks/useTenant.ts` | M | E2E: deep-link `/portal/raas/agents/match-resume` opens the right agent under the right tenant. Switch tenant → URL updates. | FR-PORT-12. Closes Audit #1 §8 #2. |
| **P2-FE-26** | Z-index ladder tokens in `tokens.css` (`--z-base: 0; --z-overlay: 100; --z-modal: 200; --z-toast: 300; --z-tooltip: 400;`). Audit existing inline `zIndex` usages; replace with the tokens. | `apps/web/styles/tokens.css`, all view files | S | Lint rule: ESLint custom rule fails on inline `z-index` numeric literal in `.tsx`. | FR-PORT-14. Closes Audit #1 §7 R-11. |
| **P2-FE-27** | Workspace timezone setting: Settings → Workspace gains a TZ picker; `fmtAgo`/`fmtTime`/log timestamps read from `useWorkspace()`. | `apps/web/lib/hooks/useWorkspace.ts`, `apps/web/lib/format.ts`, Settings panel | S | Unit: changing TZ reformats all visible times. | FR-PORT-15. Closes Audit #1 §7 R-10. |

### 6.5 Phase 2 exit criteria

- [ ] All 17 view-port tasks merged.
- [ ] Playwright screenshot diff ≤ 0.1% per view across dark + light themes.
- [ ] Monaco loads with no third-party network requests.
- [ ] `apps/web/public/portal/` deleted; `apps/web/app/portal/` is the single portal source.
- [ ] Cookie-session auth works end-to-end from browser.
- [ ] All 11 deltas (D-1..D-11) implemented (D-9 replaced with TanStack Query + SSE).
- [ ] `pnpm typecheck` + `pnpm lint` + `pnpm test` all green.

### 6.6 Phase 2 dependencies

- Blocks on: P0-AUTH-01 (no production deploy of dev-bypass auth), P1-CON-01..04 (shared contracts).
- Parallel to: Phase 1 backend work (the new TSX shells the same `/v1/*` API).
- Blocks: Phase 3 (in-portal authoring requires the TSX portal).

---

## 7. Phase 3 — Agent OS primitives (Weeks 6–8)

**Goal.** Cross the threshold from "workflow runtime" to "Agent OS." Add the missing primitives. After this phase, the platform earns the "Agent OS" label per audit 04 §16.

**Audit cross-refs.** Audit 04 §13 #1–11 + Refinements #1, #2, #7, #8, #9, #10; audit 03 §16 open question #5.

### 7.1 New triggers

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P3-RT-01** | Manifest schema: optional `schedule?: string` (cron expression) on agents. Validate cron via `cron-parser`. | `packages/runtime/src/manifest.ts`, schema migration if needed | S | Unit: invalid cron rejected; valid cron parsed. | Authors declare `schedule`. |
| **P3-RT-02** | `CronTrigger`: register via Inngest `step.sleepUntil` or scheduled-events. One Inngest fn per agent×schedule. | `packages/runtime/src/triggers/cron.ts`, `register.ts` | M | Integration: agent with `schedule: "*/5 * * * *"` fires within 5 minutes (test uses 1-second tick to accelerate). | Cron-driven agents run. |
| **P3-RT-03** | `WebhookTrigger`: per-provider HMAC verifier registry; `POST /v1/webhooks/:provider` looks up `{verifySignature, translateToEvent}` and dispatches. | `packages/runtime/src/triggers/webhook.ts`, `apps/api/src/routes/v1/webhooks.ts` | M | Integration: Stripe-shape POST with valid HMAC produces an `INVOICE_PAID` event row. | Real webhooks ingest. |
| **P3-RT-04** | Webhook anti-replay: require `X-Timestamp` within ±5 min; store `(provider, event_id)` in a small dedupe table; reject duplicates. | `apps/api/src/routes/v1/webhooks.ts`, new table `webhook_dedupe` | S | Unit: replay of a signed request → 409 `replay_rejected`. | Replay attacks blocked. |
| **P3-RT-05** | Per-tenant webhook subscriptions: route at `/v1/tenants/:slug/webhooks/:provider`; store `webhook_subscriptions` with per-tenant secret. | new schema rows + route | M | Integration: tenant A's webhook does not fire tenant B's listener. | Webhooks multi-tenant. |

### 7.2 Memory layer

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P3-DB-01** | New tables `agent_memory_short` (per-run KV) and `agent_memory_long` (per-(tenant, agent, subject) KV). | `packages/db/src/schema.ts`, migration `0005_memory.sql` | S | Migration up/down test. | Schema available. |
| **P3-RT-06** | SDK hooks `getMemory(ctx, key)`, `putMemory(ctx, key, value, scope: "run" \| "subject")`. Wire into both `BaseAgent` and the manifest step engine `ctx`. | `packages/agent-kit/src/memory.ts`, `packages/runtime/src/step-engine.ts`, `packages/agents/src/run-engine.ts` | M | Unit: an agent puts memory at run 1, run 2 (same subject) reads it back. | Memory works across runs. |
| **P3-RT-07** | Vector store contract (interface only — implementation deferred to v2): `MemoryDriver { search(query, k): Promise<MemoryHit[]> }`. Default driver is null; future plug-ins implement. | `packages/agent-kit/src/memory-driver.ts` (interface) | S | Type test. | Forward-compatible. |

### 7.3 Tenant code shipping

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P3-RT-08** | Dynamic tenant code load: read `data/tenants/<slug>/` at boot via `import()`. Manifest file `data/tenants/<slug>/agentic.json` declares package metadata. | new `packages/runtime/src/tenant-loader.ts` | M | Unit: create a fake tenant folder; boot picks it up without monorepo edits. | New tenants ship without editing `apps/api/package.json`. |
| **P3-RT-09** | File-watcher hot reload (dev only) for `data/tenants/*` and `models/*`. Re-register affected Inngest functions. | `packages/runtime/src/hot-reload.ts` | M | Manual: edit a tool handler; new event fires the updated handler within 2s. | DX win for tenant authors. |
| **P3-API-01** | `POST /v1/tenants/:slug/code` accepts a tarball, stores under `data/tenants/<slug>/<version>/`, returns deployment row. Atomic switch on success. | `apps/api/src/routes/v1/tenant-code.ts` | M | Integration: upload tarball → new version visible in `/v1/deployments`. | Tenant deploy via API. |
| **P3-API-02** | Rollback endpoint `POST /v1/deployments/:id/rollback` actually flips the live pointer + re-registers Inngest functions in one transaction. | `apps/api/src/routes/v1/deployments.ts` | S | Unit: rollback flips status; integration: next event uses prior version. | Rollback works without restart. |

### 7.4 Package refactor

These are mechanical renames done atomically across the monorepo.

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P3-RT-10** | Rename `packages/agents` → `packages/agent-runtime`. Update all `@agentic/agents` imports → `@agentic/agent-runtime`. | All files importing | S | `pnpm typecheck` green; `pnpm test` green. | Naming reflects platform-vs-user boundary. |
| **P3-RT-11** | Rename `packages/agent-kit` → `packages/agent-sdk`. Update all imports. | All files importing | S | As above. | SDK clearly user-facing. |
| **P3-RT-12** | Move `packages/agents/src/system/` → `data/system-agents/`. Loaded by the runtime, not the platform code. | files moved | M | Integration: `testAgent` still resolvable via `/v1/agents/test-agent/invoke`. | System agents no longer ship inside a platform package. |

### 7.5 In-portal authoring

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P3-FE-01** | Workflow editor: graph view of agents + events, save back to `models/<slug>/workflow_v1.json` via `POST /v1/agents`. Persists `workflow_versions`. | `apps/web/app/portal/workflows/page.tsx`, related modals | L | E2E: edit a node's `triggered_event`, save, observe new `workflow_version` in DB. | Operators edit workflows in portal. |
| **P3-FE-02** | Code-agent authoring panel (Monaco): write `data/tenants/<slug>/src/agents/<name>.ts`, run `tsc --noEmit` over the file, deploy via `POST /v1/tenants/:slug/code` with a 1-file tarball. | `apps/web/app/portal/agents/[kebab]/edit-code.tsx` | L | E2E: edit a code agent, save, deploy, see new version live within 5s. | Code agents authorable in portal. |
| **P3-FE-03** | Cost dashboard: per-tenant, per-agent, per-model line charts from `runs.tokens_in/out × catalog price`. | `apps/web/app/portal/settings/usage/page.tsx` | M | Visual: bar chart matches manual aggregation. | Cost visibility per tenant. |
| **P3-FE-04** | Trace tree view on run detail: nested LLM calls inside tool calls inside steps, using `runs.parentRunId` (P1-RT-04). | `apps/web/app/portal/runs/[id]/page.tsx` | M | Visual: a multi-turn run shows nested steps. | Operators debug agent chains. |
| **P3-FE-05** | Settings → Audit view reads `GET /v1/audit` (paginated). Shows actor, action, target, before/after, timestamp. | new `apps/web/app/portal/settings/audit/page.tsx` | S | E2E: rollback a deployment → audit view shows the row within 5s. | Closes Audit #2 §13 #9 + #4 §9. FR-OBS-6. |
| **P3-FE-06** | Replay button on run detail: posts to `POST /v1/runs/:id/replay`; new run row appears at top of Runs list with TEST badge `REPLAY`. | `apps/web/app/portal/runs/[id]/page.tsx` | S | E2E: replay a completed run; new run with `parentRunId` visible. | Closes Audit #4 §13 #11 partial; FR-OBS-4 UI completion. |
| **P3-API-03** | Atomic Inngest function re-registration on `POST /v1/agents` and `POST /v1/deployments/:id/rollback`. Extract `registerAgentFns` from bootstrap so it can be re-called without process restart. | `apps/api/src/bootstrap.ts`, `apps/api/src/routes/v1/agents.ts`, `apps/api/src/routes/v1/deployments.ts` | M | Integration: deploy → next event hits new code without API restart; rollback → same. | Closes Audit #4 §13 #2. Atomic deploy in v1. |

### 7.6 Phase 3 exit criteria

- [ ] Schedule-driven agent fires on cron in production runs.
- [ ] Webhook ingest end-to-end: Stripe-shape signed payload → event row → run.
- [ ] Memory KV works across runs for the same subject; vector driver interface present (impl null).
- [ ] A new tenant ships without monorepo edits: `POST /v1/tenants/:slug/code` works.
- [ ] Workflow editor in portal modifies + persists manifests.
- [ ] Code-agent authoring in portal end-to-end.
- [ ] Cost dashboard live with real numbers.
- [ ] Trace tree shows nested runs.
- [ ] Package renames merged; `pnpm test` green across new names.

### 7.7 Phase 3 dependencies

- Blocks on: Phase 1 (broadcast channel + audit log used by editor save flow).
- Blocks on: Phase 2 (portal UI host).
- Blocks: Phase 4 (production runbook depends on the deploy loop being mature).

---

## 8. Phase 4 — Productionize (Week 9)

**Goal.** Ship-ready ops. Docker images, healthchecks, metrics, E2E suites, runbook.

**Audit cross-refs.** Audit 02 §13 #4–9; audit 04 §13 #15 (worker isolation deferred to v2 SaaS, but PM2/process-per-service ships here).

### 8.1 Build and packaging

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P4-OPS-01** | Dockerfile for `apps/api`: Node 26-alpine, install with `--prod`, run `pnpm db:migrate` on container start, `CMD ["tsx", "src/server.ts"]`. Tini for signal forwarding. | new `apps/api/Dockerfile` | M | `docker build` succeeds; `docker run` boots and responds on `:3501/health`. | API ships as a container. |
| **P4-OPS-02** | Dockerfile for `apps/web`: `next build` + `next start`. | new `apps/web/Dockerfile` | S | As above for `:3599`. | Web ships as a container. |
| **P4-OPS-03** | Dockerfile for Inngest worker (separate process; runs `serve()` against the API or uses Inngest cloud). | new `apps/inngest-worker/Dockerfile` or compose worker against existing api image | M | Integration: events delivered. | Worker ships as a container. |
| **P4-OPS-04** | `docker-compose.yml` for local dev (api + web + inngest + optional Postgres replacement of SQLite). | `docker-compose.yml`, `docker-compose.override.yml` | S | `docker compose up` boots the stack. | One-command local stack. |

### 8.2 Reliability

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P4-API-01** | SIGTERM graceful shutdown: `app.close()` drains in-flight requests; `closeDb()`; 30s timeout then `process.exit(0)`. | `apps/api/src/server.ts` | S | Test: send SIGTERM during a long request; request completes; process exits cleanly. | No truncated responses on deploy. |
| **P4-API-02** | `genReqId` + log `req.id` on every line; redact `req.headers.authorization`; scrub `err.message` on 5xx (return generic message + req.id). | `apps/api/src/server.ts` | S | Unit: 500 response contains `req.id` and no SQL/stack content. | Logs/responses safe. |
| **P4-API-03** | `@fastify/rate-limit` (per-IP + per-token), `@fastify/helmet`, body-size caps per route. | `apps/api/src/server.ts` | S | Unit: 101 requests in 60s → 429. | Floods rejected. |
| **P4-API-04** | `/health` returns 503 if any subsystem (DB / Inngest reachable / LLM gateway init) is down. | `apps/api/src/routes/health.ts` | S | Test: kill DB → `/health` returns 503. | LBs route around unhealthy nodes. |
| **P4-API-05** | Orphaned-run sweep: Inngest scheduled function marks `runs.status='running' AND started_at < now() - 2h` as failed with `reason='orphaned'`. | new `packages/runtime/src/sweepers.ts` | S | Integration: insert orphan row; run sweep; assert flipped. | Crash-orphaned rows cleaned. |
| **P4-OPS-05** | `/metrics` endpoint (Prometheus text exposition): runs-by-status gauge, tokens-in/out counters, step-duration histogram, LLM-provider-error-rate counter. | new `apps/api/src/routes/metrics.ts`, in-process `prom-client` | M | `curl /metrics` returns valid prom text. | Prometheus can scrape. |
| **P4-OPS-06** | SQLite backup strategy: nightly `pnpm db:backup` script that runs `VACUUM INTO` to a dated file under `data/backups/`. Documented retention. | new `packages/db/src/backup.ts` + cron | S | Manual: run script; backup file exists; restore drill documented. | Recoverable from disk loss. |

### 8.3 Testing

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P4-TEST-01** | E2E suite (Playwright): sign-in → portal → invoke manifest agent → run completes → emit visible → task created → resolve → final emit. | new `tests/e2e/full-flow.spec.ts` | M | CI: passes on every PR. | Real end-to-end smoke. |
| **P4-TEST-02** | E2E: code agent invocation with tool use across 3 turns. | new `tests/e2e/code-agent-tool-use.spec.ts` | M | CI: passes. | Phase 1 path covered. |
| **P4-TEST-03** | E2E: workflow editor saves manifest; new version visible. | new `tests/e2e/workflow-editor.spec.ts` | S | CI: passes. | Phase 3 path covered. |
| **P4-TEST-04** | E2E: webhook ingest → run → emit. | new `tests/e2e/webhook-ingest.spec.ts` | S | CI: passes. | Phase 3 path covered. |
| **P4-TEST-05** | Coverage gate: 70% lines, 60% branches (per `vitest.config.ts`). Fails CI under threshold. | repo-wide config | S | CI: a contrived removal of coverage fails CI. | Gate enforced. |
| **P4-TEST-06** | Per-worker test DB isolation: `test/setup.ts` mints a temp DB per Vitest worker, runs `migrate()`. | `apps/api/test/setup.ts`, harness | S | Test: tests don't pollute `data/agentic.db`. | Tests hermetic. |

### 8.4 CI/CD

| ID | Title | File(s) | Effort | Test plan | Acceptance |
|---|---|---|---|---|---|
| **P4-OPS-07** | GitHub Actions: matrix of `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `docker build`. | `.github/workflows/ci.yml` | S | PR shows status checks. | Green CI required. |
| **P4-OPS-08** | Production checklist + runbook: env-var contract, secrets rotation, healthcheck URLs, rollback procedure, on-call. | `docs/RUNBOOK.md` | S | Walked through manually with one engineer simulating an incident. | Operationally documented. |

### 8.5 Phase 4 exit criteria

- [ ] `docker compose up` brings the stack online from a clean clone.
- [ ] SIGTERM drains in-flight requests within 30s.
- [ ] `/metrics` scrapes valid Prometheus text; demo Grafana board attached.
- [ ] All E2E tests green in CI; coverage gate enforced.
- [ ] Production checklist signed by 2 engineers.
- [ ] Backup + restore drill documented and exercised once.

### 8.6 Phase 4 dependencies

- Blocks on: Phase 0–3 feature work complete.
- Production runbook depends on the deploy loop landing in Phase 3.

---

## 9. Cross-cutting workstreams

These run alongside every phase and don't get a phase column of their own.

### 9.1 Contracts

- **Rule.** Any change to `/v1/*` updates `packages/contracts/src/*` **first**, in its own PR. The API route PR follows.
- Every contract change ships with: type definition + a parse-success and a parse-failure test.
- The frontend reads only via `packages/contracts` types — no inline `Record<string, unknown>` interfaces anywhere except for opaque payload blobs.

### 9.2 Observability

| Phase | Adds |
|---|---|
| 0 | Pino `genReqId` (lands early as part of P4-API-02 if needed sooner); audit logs on all mutations (P1-API-02). |
| 1 | SSE broadcast events with `correlationId`. Per-step logging of provider + model + tokens. |
| 2 | Frontend error boundary + telemetry hook (errors POSTed to `/v1/feedback/error`). |
| 3 | Cost charts + trace tree consume aggregated step data. |
| 4 | Prometheus `/metrics`, health endpoint health-state, structured 5xx, optional OTel exporter stub. |

### 9.3 Documentation

| Doc | Per-phase update |
|---|---|
| `docs/USER_GUIDE.md` | Updated each phase. Phase 0: env contract + auth note. Phase 1: tool-use docs, SSE protocol. Phase 2: portal screenshots. Phase 3: workflow editor + code-agent authoring guide. Phase 4: ops runbook. |
| `docs/PROMPTS.md` | Kept current as `ontology_instructions` + tenant prompts evolve. Owner: AI Architect. |
| `docs/DESIGN.md` | Authored in parallel — this IMPLEMENTATION cross-references it but doesn't duplicate primitive definitions. |
| `docs/PRD.md` | Product-strategy facing — referenced for "what" and "why"; this doc owns "how" and "when." |
| `CHANGELOG.md` | Created in Phase 4. Backfill from git log. |

### 9.4 Testing budget

| Phase | Target |
|---|---|
| 0 | 60% line coverage (baseline + new regression tests). |
| 1 | 65% line coverage. |
| 2 | 70% line coverage. Playwright screenshot diffs gate FE. |
| 3 | 70% line coverage maintained; new feature tests added. |
| 4 | Coverage gate enforced in CI. 70% lines minimum. |

---

## 10. Risk register (engineering-only)

Top 10 implementation risks. Product/market risks live in `docs/PRD.md`.

| # | Risk | P × I | Phase | Mitigation |
|---|---|---|---|---|
| **R-E-1** | **Monaco loader regression** when vendoring (P2-FE-04). The data-URL worker shim from `components.jsx:357-450` is unusual; replacing it via webpack plugin may subtly break the editor (themes, language services, syntax highlighting). | M × H | 2 | Land P2-FE-04 in its own branch with a 1-week soak. Keep a feature flag to switch back to CDN until parity confirmed. Audit 01 R-2. |
| **R-E-2** | **Schema migration data loss** during Phase 1 (`runs.parentRunId`) or Phase 3 (memory tables, webhook dedupe). | L × H | 1, 3 | Migrations are additive only (no column drops, no NOT NULL on backfilled rows without defaults). Each migration tested with `pnpm db:migrate` on a copy of prod. Backups before each phase rollout (P4-OPS-06 landed before Phase 3 deploys if possible). |
| **R-E-3** | **Inngest version coupling.** We pin to `inngest@4.4.0`; the SDK changes shape across majors. A forced upgrade (CVE, dep tree resolution) could rewrite our step-API consumption. | L × H | 1, 3 | Lock the version; PR-test any inngest bump in a branch with the full E2E suite. Document the version-compatibility matrix in RUNBOOK.md. |
| **R-E-4** | **Native-module ABI mismatch on Node upgrade.** `better-sqlite3` is compiled per Node major. Bumping past Node 26 invalidates the binding. | L × H | ongoing | `.nvmrc` pinned. CI runs on exactly the pinned Node version. Upgrade Node only in a dedicated PR with a rebuilt binding. `AGENTIC_SQLITE_BINDING` env exposes an override path. |
| **R-E-5** | **Vendor lock-in for SSE proxying.** Most hosts (Vercel, Cloudflare Pages free tier) cap long-running responses. The `/v1/stream` endpoint requires a host that supports unbuffered SSE. | M × M | 1 | Document the deployment-target compatibility matrix. Provide a long-poll fallback hook in `useStream()`. Consider WebSocket as alt-transport for Phase 4. |
| **R-E-6** | **Cross-tenant leak via `runs.parentRunId`.** A child run inherits a parent — if the parent is in tenant A and the subflow invokes a code agent under `__system`, the trace tree could leak metadata. | L × H | 1 | Tenant-scope checks on every join across `runs.parentRunId`. Test: tenant B GETing tenant A's parent → 404; GETing the child → 404. |
| **R-E-7** | **Auth migration window.** P0-AUTH-01 drops the dev bypass. If P2-FE-19 (cookie session) lands after Phase 0 (which it must), there is a window where the SPA can't authenticate. | H × M | 0–2 | Ship `AUTH_MODE=dev` env in P0-AUTH-01 as the opt-in for the SPA until cookie auth lands. Document that prod must NOT set this var. |
| **R-E-8** | **Tool-use loop infinite-step risk.** A misbehaving model that always returns `tool_use` will run `maxSteps` turns each time. Per-call token cost grows linearly. | M × M | 1 | Hard cap `maxSteps ≤ 10` for v1 agents. Cost cap (P1-LLM-05) is the secondary defense. Surface a warning when a run exhausts `maxSteps`. |
| **R-E-9** | **Workflow editor data loss.** Saving an edited manifest via the portal (P3-FE-01) hits `POST /v1/agents`, which writes a new `workflow_version`. If the operator's edit conflicts with a concurrent disk-bootstrap (P0-RT-07's `AGENTIC_REBOOTSTRAP=force` path), the disk version may overwrite the portal version. | L × H | 3 | After Phase 3, the **DB is authoritative**. The `bootstrapAll` disk read becomes a seed for first boot only — controlled by `AGENTIC_BOOTSTRAP_FROM_DISK=once` env. Document the policy clearly in RUNBOOK.md. |
| **R-E-10** | **Cost cap false positives.** A pricing-catalog drift (`PROVIDER_MODEL_CATALOG` rounding error) could over-charge a tenant and trigger a `cost_limit_exceeded` for a tenant that's actually under budget. | L × M | 1 | Reconcile actual spend monthly against provider invoices; if drift > 5%, audit the catalog. Surface "expected vs. observed" delta on the cost dashboard (P3-FE-03). |

---

## 11. Effort summary

Honest estimate. Assumes 2 backend engineers (BE), 1 frontend engineer (FE), 0.5 product designer (PD), 0.5 SRE/DevOps (OPS), and 0.5 tech lead (TL) for the duration.

| Phase | Weeks | BE | FE | OPS | PD | TL | Notes |
|---|---|---|---|---|---|---|---|
| 0 — Stabilize | 1 | 1.5 | — | 0.1 | — | 0.3 | All hands on correctness. |
| 1 — Real harness | 2 | 2.0 | 1.0 | 0.1 | — | 0.3 | Tool-use is the largest backend lift. FE refactors SPA bootstrap + state. |
| 2 — Production FE | 2 | 0.5 | 1.5 | 0.1 | 0.5 | 0.3 | Mostly FE. PD validates parity. BE supports auth + test-run endpoints. |
| 3 — OS primitives | 3 | 2.0 | 1.0 | 0.2 | — | 0.5 | Webhooks + memory + tenant code shipping are heavy. FE adds workflow + code-agent editors. |
| 4 — Productionize | 1 | 0.5 | 0.2 | 1.0 | — | 0.3 | OPS-led. BE on graceful shutdown + metrics. FE only error-boundary + telemetry. |
| **Total** | **9** | **6.5 wk-eng** | **3.7 wk-eng** | **1.5 wk-eng** | **0.5 wk-eng** | **1.7 wk-eng** | ≈ 14 engineer-weeks total. |

Buffer: add 20% (2 weeks) for unknown unknowns. Realistic ship: **11 weeks**.

---

## 12. Definition of "v1 done"

Bulleted launch checklist. Anything not on this list is post-v1. (See PRD.md §6 for the "out of scope" rationale.)

- [ ] All 5 phases' exit criteria satisfied.
- [ ] No dev-bypass auth path; cookie session works in browser.
- [ ] No cross-tenant data leak under any test scenario.
- [ ] Manifest agents with all 4 declared fields work end-to-end with branching, conditions, retries, timeouts honored.
- [ ] Code agents with `maxSteps > 1` and tool-use work end-to-end across Anthropic, OpenAI-compat, Gemini.
- [ ] SSE stream emits real-time run events; portal subscribes.
- [ ] Cost caps enforced per tenant; cost dashboard visible.
- [ ] Cron and webhook triggers work end-to-end with at least one production-shape example each (Stripe `INVOICE_PAID`, hourly cleanup cron).
- [ ] Memory KV works across runs.
- [ ] New tenant ships without monorepo edits (`POST /v1/tenants/:slug/code`).
- [ ] Workflow editor in portal saves manifests; rollback works without restart.
- [ ] Code-agent authoring in portal end-to-end.
- [ ] Pixel parity with v1_1 prototype (Playwright screenshot diff < 0.1%).
- [ ] Monaco vendored; no third-party CDN.
- [ ] Dockerfiles green; `docker compose up` boots the stack.
- [ ] SIGTERM drains; healthchecks 503-on-degrade.
- [ ] Prometheus `/metrics`; basic Grafana board attached.
- [ ] E2E suite green in CI; 70% line coverage gate enforced.
- [ ] `docs/USER_GUIDE.md`, `docs/RUNBOOK.md`, `docs/CHANGELOG.md` current.
- [ ] Backup + restore drill exercised.
- [ ] Production keys rotated; secrets vault chosen and documented.

---

## 13. Appendix A — file-change inventory

Source-of-truth list of every file expected to be touched, organized by phase. **Update this table when each task merges.**

### 13.1 Phase 0 — Stabilize

| File | Task | Status |
|---|---|---|
| `packages/runtime/src/manifest.ts` | P0-RT-01 | TODO |
| `packages/runtime/src/register.ts` | P0-RT-02, P0-RT-04, P0-RT-06 | TODO |
| `packages/runtime/src/step-engine.ts` | P0-RT-03, P0-RT-05, P0-RT-06 | TODO |
| `packages/runtime/src/bootstrap.ts` | P0-RT-07, P0-RT-08 | TODO |
| `packages/agents/src/bootstrap.ts` | P0-RT-07, P0-MIG-02 | TODO |
| `apps/api/src/bootstrap.ts` | P0-MIG-01 | TODO |
| `apps/api/src/plugins/auth.ts` | P0-AUTH-01 | TODO |
| `apps/api/src/routes/v1/runs.ts` | P0-AUTH-02 | TODO |
| `apps/api/src/routes/v1/runs-logs.ts` | P0-AUTH-02 | TODO |
| `apps/api/src/routes/v1/agents.ts` | P0-AUTH-03 | TODO |
| `apps/api/src/routes/v1/agent-invoke.ts` | P0-AUTH-04 | TODO |
| `.env.example`, `.env` | P0-AUTH-05, P0-RT-08 | TODO |
| `apps/api/test/tc-6-multi-tenant-isolation.test.ts` | new | TODO |
| `apps/api/test/tc-7-manifest-schema-fields.test.ts` | new | TODO |
| `apps/api/test/tc-8-branch-emit.test.ts` | new | TODO |
| `apps/api/test/tc-9-condition-eval.test.ts` | new | TODO |

### 13.2 Phase 1 — Real harness

| File | Task | Status |
|---|---|---|
| `packages/contracts/src/llm.ts` | P1-CON-01, P1-CON-02 | TODO |
| `packages/contracts/src/runs.ts` | P1-CON-03 | TODO |
| `packages/contracts/src/agents.ts` | P1-CON-04 | TODO |
| `packages/llm-gateway/src/types.ts` | P1-CON-01, P1-CON-02 | TODO |
| `packages/llm-gateway/src/adapters/anthropic.ts` | P1-LLM-01 | TODO |
| `packages/llm-gateway/src/adapters/openai-compatible.ts` | P1-LLM-02 | TODO |
| `packages/llm-gateway/src/adapters/gemini.ts` | P1-LLM-03 | TODO |
| `packages/llm-gateway/src/adapters/mock.ts` | P1-LLM-04 | TODO |
| `packages/llm-gateway/src/gateway.ts` | P1-LLM-05 | TODO |
| `packages/llm-gateway/src/budget.ts` | P1-LLM-05 (new file) | TODO |
| `packages/agents/src/base-agent.ts` | P1-RT-01, P1-RT-02 | TODO |
| `packages/agents/src/run-engine.ts` | P1-RT-01 | TODO |
| `packages/runtime/src/manifest.ts` | P1-RT-03 | TODO |
| `packages/runtime/src/register.ts` | P1-RT-03, P1-RT-04, P1-RT-05 | TODO |
| `packages/runtime/src/step-engine.ts` | P1-RT-03 | TODO |
| `packages/db/src/schema.ts` | P1-RT-04, P1-DB-01 | TODO |
| `packages/db/drizzle/0003_parent_run.sql` | new | TODO |
| `packages/db/drizzle/0004_tenant_budgets.sql` | new | TODO |
| `apps/api/src/routes/v1/stream.ts` | P1-API-01 (new file) | TODO |
| `apps/api/src/routes/v1/audit.ts` | P1-API-03 (new file) | TODO |
| `apps/api/src/routes/v1/budgets.ts` | P1-API-04 (new file) | TODO |
| `apps/api/src/plugins/audit.ts` | P1-API-02 | TODO |
| `apps/web/app/api/spa/bootstrap/route.ts` | P1-FE-01 | TODO |
| `apps/web/lib/spa/derive.ts` | P1-FE-01 (deleted) | TODO |
| `apps/web/lib/hooks/useStream.ts` | new | TODO |
| `apps/web/lib/hooks/useRuns.ts`, `useEvents.ts`, `useTasks.ts`, `useAgents.ts` | new | TODO |
| `apps/web/public/portal/views/*.jsx` | P1-FE-02, P1-FE-03 | TODO |

### 13.3 Phase 2 — Production frontend

| File | Task | Status |
|---|---|---|
| `apps/web/app/portal/**` | P2-FE-01, P2-FE-05..17 (new tree) | TODO |
| `apps/web/styles/tokens.css` | P2-FE-02 (new file) | TODO |
| `apps/web/app/layout.tsx` | P2-FE-02 | TODO |
| `apps/web/app/portal/components/MonacoEditor.tsx` | P2-FE-04 (new) | TODO |
| `apps/web/next.config.mjs` | P2-FE-04, P2-FE-21 | TODO |
| `apps/web/app/api/auth/**` | P2-FE-19 (new) | TODO |
| `apps/api/src/plugins/auth.ts` | P2-FE-19 | TODO |
| `packages/db/src/schema.ts` | P2-FE-18 (`runs.is_test` column) | TODO |
| `apps/api/src/routes/v1/agent-invoke.ts` | P2-FE-18 | TODO |
| `apps/web/public/portal/**` | P2-FE-21 (deleted) | TODO |
| `tests/e2e/**` (Playwright fixtures + screenshot baselines) | new | TODO |

### 13.4 Phase 3 — Agent OS primitives

| File | Task | Status |
|---|---|---|
| `packages/runtime/src/manifest.ts` | P3-RT-01 | TODO |
| `packages/runtime/src/triggers/cron.ts` | P3-RT-02 (new) | TODO |
| `packages/runtime/src/triggers/webhook.ts` | P3-RT-03 (new) | TODO |
| `apps/api/src/routes/v1/webhooks.ts` | P3-RT-03, P3-RT-04, P3-RT-05 | TODO |
| `packages/db/src/schema.ts` | P3-DB-01, P3-RT-04, P3-RT-05 | TODO |
| `packages/db/drizzle/0005_memory.sql` | new | TODO |
| `packages/db/drizzle/0006_webhook_dedupe.sql` | new | TODO |
| `packages/db/drizzle/0007_webhook_subscriptions.sql` | new | TODO |
| `packages/agent-kit/src/memory.ts` | P3-RT-06 (new) | TODO |
| `packages/agent-kit/src/memory-driver.ts` | P3-RT-07 (new interface) | TODO |
| `packages/runtime/src/tenant-loader.ts` | P3-RT-08 (new) | TODO |
| `packages/runtime/src/hot-reload.ts` | P3-RT-09 (new) | TODO |
| `apps/api/src/routes/v1/tenant-code.ts` | P3-API-01 (new) | TODO |
| `apps/api/src/routes/v1/deployments.ts` | P3-API-02 | TODO |
| `packages/agent-runtime/**` (renamed from `packages/agents/`) | P3-RT-10 | TODO |
| `packages/agent-sdk/**` (renamed from `packages/agent-kit/`) | P3-RT-11 | TODO |
| `data/system-agents/**` (moved from `packages/agents/src/system/`) | P3-RT-12 | TODO |
| `apps/web/app/portal/workflows/page.tsx` | P3-FE-01 | TODO |
| `apps/web/app/portal/agents/[kebab]/edit-code.tsx` | P3-FE-02 (new) | TODO |
| `apps/web/app/portal/settings/usage/page.tsx` | P3-FE-03 (new) | TODO |
| `apps/web/app/portal/runs/[id]/page.tsx` | P3-FE-04 | TODO |

### 13.5 Phase 4 — Productionize

| File | Task | Status |
|---|---|---|
| `apps/api/Dockerfile` | P4-OPS-01 (new) | TODO |
| `apps/web/Dockerfile` | P4-OPS-02 (new) | TODO |
| `apps/inngest-worker/Dockerfile` | P4-OPS-03 (new) | TODO |
| `docker-compose.yml`, `docker-compose.override.yml` | P4-OPS-04 (new) | TODO |
| `apps/api/src/server.ts` | P4-API-01, P4-API-02, P4-API-03 | TODO |
| `apps/api/src/routes/health.ts` | P4-API-04 | TODO |
| `packages/runtime/src/sweepers.ts` | P4-API-05 (new) | TODO |
| `apps/api/src/routes/metrics.ts` | P4-OPS-05 (new) | TODO |
| `packages/db/src/backup.ts` | P4-OPS-06 (new) | TODO |
| `tests/e2e/full-flow.spec.ts` | P4-TEST-01 (new) | TODO |
| `tests/e2e/code-agent-tool-use.spec.ts` | P4-TEST-02 (new) | TODO |
| `tests/e2e/workflow-editor.spec.ts` | P4-TEST-03 (new) | TODO |
| `tests/e2e/webhook-ingest.spec.ts` | P4-TEST-04 (new) | TODO |
| `vitest.config.ts` | P4-TEST-05 | TODO |
| `apps/api/test/setup.ts` | P4-TEST-06 | TODO |
| `.github/workflows/ci.yml` | P4-OPS-07 (new) | TODO |
| `docs/RUNBOOK.md` | P4-OPS-08 (new) | TODO |

---

## 14. Appendix B — contracts diff

Summarized changes to `@agentic/contracts` types per phase. See `packages/contracts/src/*` for current shapes.

### 14.1 Phase 0

```ts
// packages/contracts/src/agents.ts
export const AgentManifestSchema = z.object({
  id: z.string(),
  name: z.string(),
  // … existing fields …
  // NEW (P0-RT-01) — aligned with DESIGN §10.1 + Audit #3 §3.4 fix #1:
  input_data: z.record(z.string(), z.unknown()).optional(),
  ontology_instructions: z.string().optional(),
  tool_use: z.array(z.object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
  })).optional(),
  typescript_code: z.string().optional(),  // documentation slot in v1
}).passthrough();
```

```ts
// packages/contracts/src/agents.ts
// NEW (P0-RT-06): action retries + timeout now load-bearing
export const ActionSchema = z.object({
  // … existing fields …
  retries: z.number().int().min(0).max(10).optional(),
  timeout_s: z.number().int().min(1).max(7200).optional(),
  condition: z.string().optional(),  // P0-RT-05: now evaluated
});
```

### 14.2 Phase 1

```ts
// packages/contracts/src/llm.ts
// P1-CON-01:
export const ChatContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal("tool_result"), tool_use_id: z.string(), content: z.string() }),
]);

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(ChatContentBlockSchema)]),
});

// P1-CON-02:
export const ToolDefSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.unknown()), // JSON schema
});

export const ChatRequestSchema = z.object({
  // … existing …
  tools: z.array(ToolDefSchema).optional(),
});

export const ChatResponseSchema = z.object({
  // … existing …
  tool_calls: z.array(z.object({
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  })).optional(),
});
```

```ts
// packages/contracts/src/runs.ts
// P1-CON-03:
export const RunStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("run.started"), runId: z.string(), agentId: z.string(), at: z.coerce.date() }),
  z.object({ type: z.literal("run.step.started"), runId: z.string(), stepOrd: z.number(), name: z.string() }),
  z.object({ type: z.literal("run.step.completed"), runId: z.string(), stepOrd: z.number(), durationMs: z.number() }),
  z.object({ type: z.literal("run.completed"), runId: z.string(), at: z.coerce.date() }),
  z.object({ type: z.literal("run.failed"), runId: z.string(), error: z.string() }),
  z.object({ type: z.literal("event.emitted"), eventId: z.string(), name: z.string(), subject: z.string().nullable() }),
  z.object({ type: z.literal("task.created"), taskId: z.string(), runId: z.string() }),
  z.object({ type: z.literal("task.resolved"), taskId: z.string(), decision: z.string() }),
]);

// P1-CON-04:
export const AgentStepOutputSchema = z.object({
  emit: z.string().optional(),
  // … existing fields …
});
```

### 14.3 Phase 2

No new contract types — pure FE migration. `runs.is_test` added to `RunRow`:

```ts
// packages/contracts/src/runs.ts
export const RunRowSchema = z.object({
  // … existing …
  isTest: z.boolean().default(false),  // P2-FE-18
});
```

### 14.4 Phase 3

```ts
// packages/contracts/src/agents.ts
// P3-RT-01:
export const AgentManifestSchema = z.object({
  // … existing …
  schedule: z.string().optional(), // cron expression
});

// packages/contracts/src/runs.ts
// P1-RT-04 (landed in Phase 1, exposed in Phase 3 via trace tree):
export const RunRowSchema = z.object({
  // … existing …
  parentRunId: z.string().nullable(),
});

// packages/contracts/src/webhooks.ts (new)
export const WebhookSubscriptionSchema = z.object({
  tenantId: z.string(),
  provider: z.string(),
  signingSecret: z.string(), // returned only on creation
  enabled: z.boolean(),
});

// packages/contracts/src/memory.ts (new)
export const MemoryEntrySchema = z.object({
  scope: z.enum(["run", "subject"]),
  key: z.string(),
  value: z.unknown(),
  updatedAt: z.coerce.date(),
});
```

### 14.5 Phase 4

No contract changes — productionization only. `HealthReport` extended:

```ts
// packages/contracts/src/index.ts
export const HealthReportSchema = z.object({
  // … existing …
  db: z.enum(["ok", "degraded", "down"]),
  inngest: z.enum(["ok", "degraded", "down"]),
  llmGateway: z.enum(["ok", "degraded", "down"]),
  requestId: z.string(),
});
```

---

## Change log

| Date | Version | Author | Changes |
|---|---|---|---|
| 2026-05-19 | 1.0 (DRAFT) | Tech Lead | Initial synthesis of audits 01–04 into a 5-phase plan. |

---

*End of IMPLEMENTATION.md. Cross-reference `docs/PRD.md` for the product strategy and `docs/DESIGN.md` for primitive definitions. Update §13 row statuses as tasks merge.*
