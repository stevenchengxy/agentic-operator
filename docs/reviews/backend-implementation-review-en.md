# Backend Implementation Review (English)

> **Scope:** `apps/api/**`, `packages/{runtime,agents,llm-gateway,db,contracts,shared,tools}/**`
> **Date:** 2026-05-23
> **Source-of-truth as of:** branch `main` after Sprint 4 closeout + dashboard hotfix
> **Companion document:** `backend-implementation-review-zh.md` (Chinese)

---

## 1. Executive Summary

Agentic Operator's backend is a **two-process Node 26 + pnpm 11 monorepo**: a Next.js web tier that owns no data, and a Fastify 5 API that owns *all* persistence. The two communicate only via a typed Zod contract package (`@agentic/contracts`) over HTTP. Behind the API live a SQLite WAL store, a layered agent runtime (manifest-driven Inngest functions *and* code-defined `BaseAgent` subclasses), an LLM Gateway fronting 14 providers, and an NDJSON event ledger.

After four orchestrated hardening sprints (Sprint 1→4, all summarised in `docs/team-execution/00-master-plan.md`), the platform sits at **366/367 api vitest pass (99.7 %)**, **0 typecheck errors**, **0 web typecheck errors**, **82/82 web vitest**, and **11/11 smoke endpoints** alive. The Wave 5 verdict is **SHIPPABLE** with three test-fixture regressions flagged for V1.0.1.

The architecture's strengths — typed contracts end-to-end, durable Inngest step-engine, WAL-mode SQLite with composite indexes on every hot read path, an LLM gateway with provider-chain failover, and a uniform `{ok, data}` envelope — are intact. The auth pathway has been hardened from "permanent dev bypass" to **cookie + bearer + boot-time guard**, the previously-leaky `__system` and `?tenant=` IDOR vectors are closed, six routes that lived in disk-orphan state are now registered, and observability (graceful shutdown, Prometheus `/metrics`, `x-request-id`, full `HealthReport`) is in place.

### High-level scoreboard

| Dimension | State | Evidence |
|---|---|---|
| Architecture coherence | strong | typed contracts, layered runtime, single envelope |
| API surface registered | 19/19 routes wired | `apps/api/src/server.ts:94-118` |
| Auth posture | hardened | dev-mode requires explicit `AUTH_MODE=dev`; cookie + bearer in prod |
| Cross-tenant isolation | closed | `__system` fallback removed; `?tenant=` override dropped |
| Schema migrations | versioned + journalled | `packages/db/drizzle/0000…0014` |
| Tests | 99.7 % api green | 366/367 vitest, 0 typecheck |
| Observability | wired | `x-request-id`, `/metrics`, `installGracefulShutdown` |
| Audit log | read+write surface complete | `auditRoutes` registered; `writeAudit` from 11 sites |
| Production-readiness verdict | SHIP-WITH-CAVEATS | `docs/V1_SHIP_VERDICT.md` |

---

## 2. Architecture overview

### 2.1 Component map

```
Browser ── HTTPS ──▶ Next.js 16 (apps/web, :3599)
                       │
                       │  rewrites:  /v1/*  → API_URL
                       │             /health → API_URL
                       ▼
                     Fastify 5 (apps/api, :3501)
                       │
   ┌───────────────────┼──────────────────────────────────┐
   │                   │                                  │
   ▼                   ▼                                  ▼
 SQLite WAL    Inngest Dev CLI (:8288)            data/{logs,artifacts}
 data/agentic.db   manifest agents                NDJSON ledger
 19 tables         + helloFn                      per-run .log files
                   + code-agent fns
```

Process roster (dev):

| Port  | Process                       | Started by               |
|------:|-------------------------------|--------------------------|
| 3530  | Next.js dev server            | `pnpm dev` → `next dev`  |
| 3501  | Fastify API                   | `pnpm dev` → `tsx watch` |
| 8288  | Inngest Dev CLI (UI)          | `pnpm dev` → `npx inngest-cli@latest dev` |
| 50052/3 | Inngest gRPC                | spawned by inngest-cli   |

`predev` (`package.json:11`) hard-kills these ports before each `dev` run. Production target is `tsx --env-file=… src/server.ts` plus the new `installGracefulShutdown(app)` block in `server.ts:134`.

### 2.2 Request flow (read path)

```
browser ──▶ GET /v1/runs?limit=50
           │
           ▼
   Next rewrite (next.config.mjs:24)
           │
           ▼
   Fastify :3501 — onRequest hook
   ├── x-request-id (genReqId in server.ts:44)
   ├── auth plugin: cookie → bearer → dev-tenant (auth.ts:143)
   └── security plugin (security.ts)
           │
           ▼
   v1.runs.GET handler (routes/v1/runs.ts:13)
           │
           ▼
   ListRunsQuery.parse(req.query)
           │
           ▼
   queries/runs.ts:listRecentRuns(tenantSlug, opts)
           │
           ▼
   drizzle SELECT FROM runs JOIN agents JOIN events
   + hydrateStepInfo() (current step name/ord/count)
           │
           ▼
   reply.ok(rows) → { ok: true, data: RunRow[] }
   ┊            ┊
   └── onSend ──┴── header x-request-id echoed back
```

### 2.3 Process model — two parallel agent execution paths

The platform ships **two ways to run an agent**, both writing into the same `runs`/`steps`/per-run-`.log` substrate:

1. **Manifest agents** (`packages/runtime`) — declarative JSON in `models/<slug>-v<n>/workflow*.json`. Each agent becomes one Inngest function whose `id = "${tenantSlug}.${agentName}"` and concurrency is keyed on `event.data.subject`. Retries=3, full step-engine, durable `step.run` writes, `step.waitForEvent` for HITL pause/resume. See `packages/runtime/src/register.ts` (610 LOC) and `step-engine.ts` (388 LOC).
2. **Code agents** (`packages/agents`) — TypeScript subclasses of `BaseAgent` registered at import time via `agentRegistry.register(...)`. `BaseAgent.run()` is sealed; subclasses override `buildMessages()` (prompt assembly) and optionally `parseOutput()`. Invoked synchronously through `POST /v1/agents/:name/invoke`; async via Inngest is reserved for v2. See `packages/agents/src/run-engine.ts` (301 LOC).

Both paths share the LLM Gateway singleton wired in `apps/api/src/bootstrap.ts:74-81` via `setAgentGateway()` (for `BaseAgent`) and `setRuntimeGateway()` (for the manifest engine's `logic`/`llmCall` action).

### 2.4 Strengths to preserve

1. **Uniform envelope** — `registerEnvelope` decorates `reply.ok`/`reply.fail`; every route is consistent and the typed client (`apps/web/lib/api-client.ts`) mirrors it.
2. **`@agentic/contracts`** — Zod is the single source of truth between API and UI. Both sides import the same schemas; `z.coerce.date()` handles JSON round-trips.
3. **Drizzle schema** with explicit composite indexes on `(tenant_id, …)` for the hot read paths (`runs_tenant_started_idx`, `evt_tenant_name_received_idx`, etc.). Every user-visible table carries `tenant_id` with `ON DELETE CASCADE`.
4. **Step engine inside `step.run()`** — every DB write inside an Inngest handler is memoised by Inngest; retries are durable and idempotent. HITL uses `step.waitForEvent("task.resolved", { if: 'async.data.taskId == "<id>"' })`.
5. **Append-only NDJSON event ledger** with `payload_ref` pointers — sane separation of metadata from blob.
6. **LLM Gateway** with provider-chain failover, retry-once-on-transient, and a clean `LLMError` taxonomy mapped to HTTP status in `agent-invoke.ts:221-239`.
7. **Provider catalog** — 14 providers (`mock`, `anthropic`, `openai`, `openrouter`, `gemini`, `azure`, `groq`, `together`, `mistral`, `deepseek`, `qwen`, `bedrock`, `vertex`, `custom`) with masked-key persistence (SHA-256 at rest) and `POST /v1/llm/providers/:id/test` connection probe.

---

## 3. API surface

All routes are mounted under `/v1/` except `/health`, `/metrics`, and `/inngest`. As of Sprint 3 closeout every previously-orphan route is registered.

### 3.1 Route inventory

| File:line | Method | Endpoint | Auth | Notes |
|---|---|---|---|---|
| `routes/health.ts:12` | GET | `/health` | none | `HealthReport` shape: `ok, ts, uptime, version, schemaVersion, inngest, sqlite, disk, llmGateway` |
| `routes/metrics.ts` | GET | `/metrics` | none | Prometheus exposition — counters `runs_total`, `tokens_total`, `run_duration_ms`, `llm_provider_errors_total` |
| `routes/inngest.ts:13` | * | `/inngest` | inngest-signed | adapter exposes registered functions |
| **v1/events** | | | | |
| `events.ts:40` | POST | `/v1/events` | requireAuth | publish + write ledger + `inngest.send` + audit |
| `events.ts:140` | POST | `/v1/events/:id/replay` | requireAuth | new `makeId("evt")` to avoid same-ms collisions |
| `events.ts:200` | GET  | `/v1/events` | requireAuth | list (limit, name, since) |
| `events.ts:210` | GET  | `/v1/events/catalog` | requireAuth | per-tenant event-type catalog |
| `events.ts:220` | GET  | `/v1/events/recent` | requireAuth | causality BFS depth 3 from seed |
| `events.ts:245` | GET  | `/v1/events/stream` | requireAuth | SSE tail with category filter |
| **v1/runs** | | | | |
| `runs.ts:13` | GET | `/v1/runs` | requireAuth | filter status/agent/q |
| `runs.ts:27` | GET | `/v1/runs/:id` | requireAuth | tenant-scoped (`__system` IDOR fallback removed in Sprint 2) |
| `runs.ts:38` | POST | `/v1/runs/:id/replay` | requireAuth | re-emits trigger event with `__replayOfRun` |
| `runs-logs.ts:29` | GET | `/v1/runs/:id/logs?follow=1` | requireAuth | SSE tail of per-run `.log` file via `fs.watch` |
| **v1/tasks** | | | | |
| `tasks.ts:12` | GET | `/v1/tasks` | requireAuth | tenant-scoped list |
| `tasks.ts:19` | GET | `/v1/tasks/:id` | requireAuth | |
| `tasks.ts:27` | POST | `/v1/tasks/:id/resolve` | requireAuth | emits `task.resolved` Inngest event with `tenantId` |
| **v1/agents** | | | | |
| `agents.ts:61` | GET | `/v1/agents` | requireAuth | `?tenant=` override dropped (Sprint 2) |
| `agents.ts:86` | GET | `/v1/agents/:kebab` | requireAuth | |
| `agents.ts:97` | POST | `/v1/agents` | requireAuth | legacy manifest upload (still used by the workflow editor's Save button) |
| `agent-invoke.ts:36` | POST | `/v1/agents/:name/invoke?testRun=1` | requireAuth | sync code-agent or queued manifest-agent fallback |
| **v1/deployments** | | | | |
| `deployments.ts:10` | GET | `/v1/deployments` | requireAuth | `{list, live}` envelope |
| `deployments.ts:21` | POST | `/v1/deployments/:id/rollback` | requireAuth | demote scoped to same `target`; audit row |
| **v1/manifest-import** | | | | |
| `manifest-import.ts:91` | POST | `/v1/tenants/:slug/manifest-import` | requireAuth | modes: `validate` (pending lock 1h, 423 on contention), `commit` (4-phase atomic with `fs.rename` + Inngest re-register) |
| `manifest-import.ts:200` | POST | `/v1/tenants/:slug/manifest-import/fetch-url` | requireAuth | SSRF-guarded fetch with audit on block |
| `manifest-import.ts:280` | POST | `/v1/tenants/:slug/manifest-import/fetch-repo` | requireAuth | 501 stub |
| `manifest-import.ts:300` | DELETE | `/v1/tenants/:slug/manifest-import/:deployment_id` | requireAuth | release pending lock |
| **v1/tenants** | | | | |
| `tenants.ts:30..783` | GET/POST/PUT/DELETE/POST | `/v1/tenants[/:slug[/restore]]` | requireAuth | CRUD + archive + restore + 4-step wizard support + `Idempotency-Key` on create |
| **v1/webhooks** | | | | |
| `webhooks.ts:27` | POST | `/v1/webhooks/:provider` | HMAC | raw-body HMAC-SHA256 verify, ±5 min replay window, in-process idempotency cache (1 h TTL / 10 k cap), header scrubbing |
| **v1/artifacts** | | | | |
| `artifacts.ts:9` | GET | `/v1/artifacts/:id` | requireAuth | streams `row.path`, 410 on missing file |
| **v1/reads** | | | | |
| `reads.ts:13` | GET | `/v1/counts` `/workflows/dag` `/event-types` `/entity-types` | requireAuth | dashboard rollups |
| **v1/llm** | | | | |
| `llm.ts:47..250` | GET/POST/PATCH/DELETE | `/v1/llm/providers` `/.../keys` `/.../test` `/llm/models` `/llm/catalog` `/llm/fleet[/:id]` | requireAuth | 14-provider catalog, masked-key vault, model fleet CRUD |
| **v1/audit** | | | | |
| `audit.ts:39` | GET | `/v1/audit` | requireAuth | cursor pagination (`(at, id)`), filters since/until/actor/action |
| **v1/usage** | | | | |
| `usage.ts:81` | GET | `/v1/usage?since&until` | requireAuth | totals + byAgent + byModel + byDay + budget rollup |
| **v1/budgets** | | | | |
| `budgets.ts:74` | GET | `/v1/budgets` | requireAuth | auto-create row when absent |
| `budgets.ts:80` | PUT | `/v1/budgets` | requireAuth | monthly cap update + optional `reset` |
| **v1/stream** | | | | |
| `stream.ts:29` | GET | `/v1/stream` | requireAuth | tenant-scoped SSE multiplexer over `subscribeStreamEvents()` |
| **v1/workflow** | | | | |
| `workflow.ts:60..343` | GET/PUT | `/v1/tenants/:slug/workflow` | requireAuth | modern editor save: writes `models/<slug>-vN/workflow_vN+1.json` + Inngest hot-reregister |
| **v1/tenant-code** | | | | |
| `tenant-code.ts:74..431` | GET/POST/PUT/DELETE | `/v1/tenants/:slug/code[/:version]` | requireAuth | tarball extract → atomic `fs.rename` → Inngest re-register + audit |

### 3.2 Drift between contracts and routes

| Contract symbol | Route uses | State |
|---|---|---|
| `ApiError { code, message, hint? }` | `reply.fail(code, message, status, hint?)` | aligned |
| `RunRow` (33 fields incl. `currentStepName`, `currentStepOrd`, `stepCount`, `testRun`, `error`) | `queries/runs.ts:listRecentRuns` hydrates them | aligned (Sprint 4 added `testRun` + `error`) |
| `IngestEventBody.payload` is `z.record(string, unknown)` | route lifts whole `req.body` through Zod | aligned |
| `ManifestUploadBody.actions` is array-of-record | inserted as `text json`; not re-validated at SQLite layer | acceptable |
| `HealthReport` extended in Sprint 2 with `ts/uptime/version/schemaVersion/llmGateway` | route emits the extended shape | aligned |

No structural drift today — the upside of having both client and server import the same `@agentic/contracts` package.

### 3.3 Error envelope + status code map

`apps/api/src/plugins/error.ts` exposes `reply.ok(data, status?)` → `{ok:true, data}` and `reply.fail(code, message, status?, hint?)` → `{ok:false, error:{code, message, hint}}`. `setErrorHandler` catches `ZodError` → 400 `invalid_input` with concatenated issue paths in `hint`. Other thrown errors use `err.statusCode || 500` and `err.code || 'internal_error'`.

| Code | Status | Example use |
|---|---|---|
| `invalid_input` | 400 | Zod failure (envelope plugin) |
| `bad_request` | 400 | unknown provider in agent-invoke |
| `unauthorized` | 401 | requireAuth, webhooks (signature) |
| `forbidden` | 403 | cross-tenant write, foreign-tenant resolve |
| `not_found` | 404 | row missing across all read routes |
| `requires_confirmation` | 409 | manifest commit needs `?confirm=1` |
| `slug_taken` | 409 | tenant create with existing slug |
| `agent_disabled` | 409 | invoke against disabled agent |
| `already_resolved` | 409 | task already non-`open` |
| `gone` | 410 | replay against hard-deleted event, artifact file missing |
| `pending_import` | 423 | concurrent manifest validate |
| `provider_error` / `rate_limit` / `timeout` / `model_not_found` / `not_configured` / `network` | 502 / 429 / 504 / 400 / 503 / 502 | LLMError taxonomy mapped via `mapErrorStatus()` |
| `not_implemented` | 501 | async invoke; `manifest-import/fetch-repo` |

---

## 4. Database schema

19 tables, defined in `packages/db/src/schema.ts` (766 LOC). All migrations are versioned + journalled under `packages/db/drizzle/0000…0014_*.sql`; the runner is `packages/db/src/migrate.ts`.

### 4.1 Table inventory (grouped)

**Identity:** `tenants`, `users`, `memberships`, `api_tokens`.
**Workflow defs:** `workflows`, `workflow_versions`, `agents`, `agent_versions`, `event_listeners`.
**Lifecycle:** `deployments` (target ∈ `'workflow' | 'code_agent' | 'tenant_code'`), `audit_log`.
**Runtime state:** `events`, `runs` (with `is_test`, `correlation_id`, `subject`), `steps`, `tasks`, `artifacts`.
**Memory + budget:** `agent_memory_short`, `agent_memory_long`, `tenant_budgets`.
**Ontology overlay:** `event_types`, `entity_types`.
**Webhook intake:** `webhook_subscriptions`, `idempotency_keys` (migration `0014`).

### 4.2 Indexing for hot reads

Every tenant-scoped table has at least one composite index starting with `tenant_id`:

| Table | Indexes |
|---|---|
| `runs` | `(tenant_id, started_at)`, `(tenant_id, status)`, `(agent_id)`, `(correlation_id)`, `(subject)` |
| `events` | `(tenant_id, name, received_at)`, `(tenant_id, subject)` |
| `steps` | `(run_id, ord)` |
| `tasks` | `(tenant_id, status)`, `(run_id)` |
| `audit_log` | `(tenant_id, at)`, `(target_type, target_id)` |
| `artifacts` | `(run_id)` |
| `agent_memory_*` | `(tenant_id, agent_id, key)` |

### 4.3 Pragmas

`packages/db/src/client.ts:118-121`:

```
journal_mode = WAL          ✅
foreign_keys = ON           ✅
synchronous = NORMAL        ✅
busy_timeout = 5000         ✅
```

The client also resolves the `better-sqlite3` native binding via a custom path walker (`resolveNativeBinding`) so the same code works under hoisted layouts (`node_modules/better-sqlite3/...`) and `.pnpm/...` layouts in production. The env override `AGENTIC_SQLITE_BINDING` lets ops drop a binding at a known path.

### 4.4 Multi-tenant discipline

- Every tenant-scoped table has `tenant_id` with `ON DELETE CASCADE`.
- `with-tenant.ts` exposes `tenantScope(ctx, table)` but most query files reach for `getDb()` directly and inline `eq(table.tenantId, tenantId)`. Convention is uniform; the type system doesn't enforce it.
- The previous explicit `__system` IDOR fallback on `/v1/runs/:id` and `/v1/runs/:id/logs` was removed in Sprint 2; code-agent runs are now tenant-scoped to the caller (system-agent invocations store under `__system`'s tenantId regardless).
- The `?tenant=` query param on `/v1/agents` was also dropped — tenant is exclusively auth-derived.

---

## 5. Boot lifecycle

`apps/api/src/server.ts` builds the Fastify app and runs `bootstrapRuntime()` from `apps/api/src/bootstrap.ts`. Initialization order:

```
1. getLLMGateway()             builds adapters, registers 14 providers
2. setAgentGateway(gateway)    assigns to module-global in @agentic/agents
3. setRuntimeGateway(gateway)  assigns to module-global in @agentic/runtime
4. setRuntimeMetrics(metrics)  wires the prom-client registry into the manifest engine
5. bootstrapCodeAgents()       writes __system tenant / workflow / version / code-agent rows
6. bootstrapAll(TENANT_REGISTRIES)
     - readdir(models/)
     - per tenant folder: loadModelsFromDisk(), upsert workflows + workflow_versions,
       flip deployments to 'live' (transactionally demoting prior), upsert agents +
       agent_versions + event_listeners, registerAgent() → Inngest function, upsert
       event_types + entity_types
     - return [...inngestFns]
7. reconcileImports()          a) prune expired pending imports; b) finish crashed renames;
                               c) re-emit on-disk manifests from workflow_versions.manifest_json
8. inngestRoute(app, {client, functions})
9. registerSecurity(app)
10. installGracefulShutdown(app)   listens for SIGTERM, drains in ≤10s, then exit(0)
11. app.listen({port, host})
```

### 5.1 Strengths

- Idempotent at every step (existing rows skipped).
- Order — gateway → metrics → agents → runtime → reconcile — guarantees the step engine has a callable LLM by the time the first Inngest event lands.
- Deployment flipping uses `db.transaction(() => {…})`.
- `reconcileImports` is the crash-recovery safety net for the manifest-import 4-phase commit.
- `assertAuthModeSafe()` runs inside `registerAuth()` and *throws* if `AUTH_MODE=dev + NODE_ENV=production` or if `AGENTIC_DEV_TENANT` doesn't resolve — a silent prod auth bypass is worse than downtime.
- `installGracefulShutdown` is registered **before** `app.listen()` so SIGTERM during a slow boot still drains.

### 5.2 Known failure modes

| Failure | Behaviour today |
|---|---|
| DB locked > 5 s | `busy_timeout` returns; bootstrap throws if it can't write |
| Malformed manifest | `bootstrapTenant` throws → outer `bootstrapAll` catches → API still starts; that tenant is skipped |
| Native binding missing | `resolveNativeBinding` throws a clear `[db/client] could not locate better_sqlite3.node` |
| Port in use | `app.listen` rejects → `process.exit(1)` |
| Two API instances booting | UQ collisions throw on the loser; not yet `ON CONFLICT DO NOTHING` |
| Inngest CLI unreachable | API still starts; first event dispatches go nowhere — `/health` surfaces `inngest: degraded` |

---

## 6. Manifest agents — packages/runtime

`packages/runtime` is the heart of the declarative path. Lines of code by file:

| File | LOC | Role |
|---|---|---|
| `register.ts` | 610 | builds the Inngest function for each AgentSpec; the durability contract |
| `lint.ts` | 583 | manifest linter — 11 conflict detectors (dangling triggers, orphan emitters, kebab collisions, cron sanity, model-not-configured, prompt-injection smell, …) |
| `step-engine.ts` | 388 | dispatch for `logic` / `llmCall` / `condition` / `delay` / `subflow` / `manualTask` actions |
| `tenant-loader.ts` | 339 | discover + load tenant-code packages from `data/tenants/<slug>/<version>/` |
| `manifest.ts` | 287 | `AgentSchema` / `WorkflowSchema` Zod + `findMissingTenantPrompts` boot-time validator |
| `memory.ts` | 229 | short + long memory drivers (subject / tenant / run scopes) |
| `bootstrap.ts` | 215 | tenant-side bootstrap loop |
| `scheduler.ts` | 157 | cron triggers via `registerCronTriggers` |
| `hot-reload.ts` | 172 | re-emit Inngest registrations after manifest import |
| `retention.ts` | 168 | sweep-and-tombstone for old `events` / `runs` |
| `broadcast.ts` | (in index) | tenant-scoped publish/subscribe used by `/v1/stream` |

### 6.1 The durability contract

Inngest replays every step on retry. Every DB write must therefore live inside a `step.run("name", …)` so exactly one row is produced per real execution. The rules in `register.ts`:

- `step.sendEvent` is the only idempotent way to emit a downstream event — never call `inngest.send` inside a step body.
- HITL: create a `tasks` row inside `step.run("createTask", …)`, then `step.waitForEvent("task.resolved", { if: 'async.data.taskId == "<id>"' })` with a 7-day timeout.
- `failRun` (`register.ts:446`) writes the final `runs.status = 'failed'`. Sprint 4 punch list (UC-V11-35) flags it should live inside a `step.run("finalize", …)` to close a race where a retry after `failRun` could see `status='failed'` and skip writing a new run row.

### 6.2 Step-engine action types (Sprint 1 P1-RT-03)

```ts
type Action =
  | { type: 'logic'; prompt?: string; model?: string }
  | { type: 'llmCall'; messages: ChatMessage[]; tools?: ToolDef[] }
  | { type: 'condition'; expr: string }
  | { type: 'delay'; ms: number }
  | { type: 'subflow'; trigger: string }
  | { type: 'manualTask'; assigneeRole: string; payload?: unknown };
```

`evaluateCondition` (`condition.ts:122`) is the **fail-open** AST walker — malformed conditions don't block branches. `tc-9` covers 11 sub-cases (empty, numeric, equality, logical chains, negation, forbidden syntax, identifier whitelist, deep-chain undefined).

### 6.3 Manifest-import wizard (UC-2, `services/manifest-import.ts`, 1640 LOC)

Two modes:

- **validate** — parses + lints + builds diff in memory, inserts a `deployments(status='pending', expires_at=now+1h)` row whose `id` becomes the import session token (returns 423 to a second concurrent caller until the lock expires or is released).
- **commit** — atomic 4-phase commit:
  1. Preflight revalidate.
  2. Write `data/imports/<deployment_id>/workflow.json` + `fsync`.
  3. Synchronous SQLite tx: demote prior live → upsert `workflow_versions` / `deployments` / `agents` / `agent_versions` / `event_listeners` + audit row.
  4. `fs.rename()` into `models/<slug>-vN/workflow_v<N+1>.json` + Inngest re-register (`reregisterInngest`).

Crash anywhere between phases is recovered by `reconcileImports()` on next boot. Tests: `manifest-import-{validate,commit,concurrent,overwrite-guard,conflict,ssrf,perf}.test.ts` (combined 75 sub-cases, all green).

### 6.4 Lint detectors (11)

`lint.ts` runs every detector against the in-memory manifest. Severities are `error` (blocking) / `warn`:

```
dangling_trigger          orphan_actor              prompt_injection_smell
concurrency_excess        kebab_id_collision        model_not_configured
invalid_cron              dangling_emitter          broken_subflow
required_field_missing    duplicate_event_listener
```

Each detector returns an optional `auto_fix` payload; the wizard's "apply all fixes" path round-trips through this.

---

## 7. Code agents — packages/agents

The code-agent path lives in `packages/agents` (~700 LOC) and is the synchronous counterpart to manifest agents:

- `base-agent.ts` (78 LOC) — sealed `BaseAgent` class; subclasses override `buildMessages()` and optionally `parseOutput()`.
- `run-engine.ts` (301 LOC) — orchestrates the run row, step rows, gateway call, log writer, and SSE publish.
- `registry.ts` (42 LOC) — `agentRegistry.register(name, factory)` import-time.
- `bootstrap.ts` (221 LOC) — `bootstrapCodeAgents()` writes the `__system` tenant + workflow + version + agent rows for every registered code agent.
- `system/` — built-in code agents; `testAgent` is registered only by the explicit test harness.
- `gateway-host.ts` (29 LOC) — module-global `setGateway` / `getGateway` for LLM dispatch.

`agent.run(input, ctx)` writes a per-line `.log` file via `log-writer.ts` and emits `run.started`/`run.step.*`/`run.completed|failed` through the broadcast channel so `/v1/stream` subscribers (and the `useStream` hook) invalidate React-Query keys live.

System-agent invocations store rows under `__system`'s tenantId regardless of the caller's tenant (`agent-invoke.ts:91`). The previous IDOR allowing cross-tenant `__system` read on `/v1/runs/:id` was removed in Sprint 2 — code-agent runs are visible to the calling tenant via the normal tenant-scoped lookup since they're stored under `__system` for everyone (i.e. the visibility is a shared-tenant model, not a per-caller leak).

---

## 8. LLM Gateway — packages/llm-gateway

`packages/llm-gateway/src/gateway.ts` (179 LOC) is the singleton fronting 14 providers. Adapter files under `adapters/` implement the per-provider HTTP shape; the gateway adds:

- **Provider-chain failover** — `chat({ providers: ['anthropic', 'openai'] })` tries in order; transient errors retry once.
- **Block-based content protocol** — `ChatMessage.content` is `string | ChatContentBlock[]` where blocks are `text` / `tool_use` / `tool_result`. `flattenContentToText()` keeps adapters that don't speak blocks (most OpenAI-compatible providers) callable.
- **Tool-use loop** — when `ChatRequest.tools` is set, the gateway emits `tool_use` blocks; callers parse, run the tool, and post back a `tool_result` block. The mock adapter simulates the loop deterministically via `_resetMockIdSeq()` (`tc-15`, `tc-16`).
- **Budget hook** — `packages/llm-gateway/src/budget.ts:174` enforces per-tenant `tenant_budgets.monthly_token_cap` / `monthly_usd_cap`; over-cap throws `cost_limit_exceeded` which the route maps to 503.
- **Error taxonomy** — `LLMError { code: 'auth' | 'rate_limit' | 'timeout' | 'model_not_found' | 'not_configured' | 'network' | 'provider_error' | 'cost_limit_exceeded' }` mapped to HTTP via `agent-invoke.ts:221-239`.

Adapters: `mock`, `anthropic`, `openai`, `openrouter`, `gemini`, `azure`, `groq`, `together`, `mistral`, `deepseek`, `qwen`, `bedrock`, `vertex`, `custom`. Bedrock and Vertex are partial stubs (Wave 4 UC-V11-26 deferred to V1.1).

Provider key persistence: `apps/api/src/services/provider-keys.ts` (339 LOC). Keys are stored as opaque blobs in a sidecar JSON state file with scope ∈ `'workspace' | 'tenant'`. `POST /v1/llm/providers/:id/key` triggers `resetLLMGateway()` so the next invocation picks up the rotated credential. The masked view returned by `GET …/key` shows only the last 4 chars + prefix.

Model fleet (`services/model-fleet.ts`, 238 LOC) is the per-tenant pinning surface — alias, role (`'default' | 'cheap' | 'long-context' | 'reasoning'`), `dailyCapUsd`, `maxOutTokens`, `temperature`.

---

## 9. Auth + multi-tenancy

### 9.1 The auth flow (Sprint 2 + dashboard hotfix)

`apps/api/src/plugins/auth.ts:143` — `authenticate(req)` flowchart:

```
if AUTH_MODE=dev:
  return devTenant(req)
    ├── reads x-agentic-tenant header (dev-only override; slug validated /^[a-z0-9_-]{1,32}$/)
    └── falls back to AGENTIC_DEV_TENANT (default 'raas')

else (prod / staging):
  cookie 'agentic_session' present?
    yes → jwtVerify(jwt, AUTH_SESSION_SECRET, HS256)
          → resolve tenant via payload.tenant
          → if valid: return { via: 'cookie' }
  fallback to Authorization: Bearer <token>
    → SHA-256 hash → match api_tokens.hash
    → update api_tokens.last_used_at
    → return { via: 'token' }
  no match → null → requireAuth() throws 401
```

The cookie flow uses `jose@5` HS256. The shared secret is read from `AUTH_SESSION_SECRET` (canonical) or `SESSION_SECRET` (what the web tier sets) so the Next.js sign-in route and the Fastify verifier agree on signing material.

### 9.2 Boot-time guard

`assertAuthModeSafe()` (auth.ts:205) refuses to return when:
1. `AUTH_MODE=dev` + `NODE_ENV=production` — would bypass bearer auth and authenticate every request as the explicitly configured real development user; this combination is rejected.
2. `AUTH_MODE=dev` + `AGENTIC_DEV_TENANT` references a non-existent slug — silent every-request-null.

The guard runs inside `registerAuth()` so an unsafe env crashes boot rather than going to production.

### 9.3 Tenant isolation guarantees

| Resource | Cross-tenant readable? |
|---|---|
| runs (regular tenant) | No (tenantId filter) |
| runs (code-agent under `__system`) | No — caller must be `__system` (Sprint 2 closed the previous IDOR) |
| run logs (code-agent) | Same as above |
| events / tasks / artifacts | No (route checks `row.tenantId !== auth.tenantId`) |
| agents | No (`?tenant=` override removed) |
| deployments | No (route checks tenant) |

### 9.4 Webhook intake (UC-13, Sprint 3 restore)

`/v1/webhooks/:provider`:
1. Subscription lookup in `webhook_subscriptions` by `provider` (+ optional `x-tenant-slug` disambiguator).
2. Plugin-scoped JSON content-type parser captures `rawBody` for HMAC.
3. HMAC-SHA256 over raw bytes; constant-time compare via `timingSafeEqual`.
4. ±5 min replay window on `x-timestamp` header.
5. In-process idempotency cache (1 h TTL / 10 k cap) keyed on `x-idempotency-key` / signature-digest.
6. `Authorization`/`Cookie`/`Set-Cookie` stripped from forwarded headers.
7. `inngest.send({ name: '<slug>/WEBHOOK_<PROVIDER>', data })`. On Inngest failure: log + ack-202 (avoid retry storms from the provider).

Wave 4 UC-V11-27 flags removing `WEBHOOK_HMAC_SECRET_DEFAULT` fallback so per-subscription secret is mandatory — currently still falls back to the env default.

---

## 10. Observability

### 10.1 Logger

Pino via Fastify built-in. `genReqId: () => randomUUID()` + `requestIdHeader: 'x-request-id'` + `requestIdLogLabel: 'reqId'`. The `onSend` hook in `server.ts:62-65` echoes `x-request-id` back on every response (skipped for SSE streams that flushed headers via `raw.writeHead`).

CORS exposes the header so browsers can read it (`server.ts:74`).

### 10.2 Per-run file logs

`packages/runtime/src/log-writer.ts` writes `2026-05-23T08:14:02.001Z INFO run.start run_id=... …` lines to `data/logs/<tenant>/runs/<YYYY-MM-DD>/<run-id>.log`. The SSE tail in `runs-logs.ts:91` uses `fs.watch` to push new lines as `event: log` frames. Sufficient for v1; doesn't scale beyond one box without shared filesystem.

### 10.3 Audit log

11 sites write `audit_log` rows (via `apps/api/src/plugins/audit.ts:writeAudit`):

```
tenant.create / tenant.update / tenant.archive / tenant.restore
manifest.import.commit / manifest.import.fetch_url.blocked
deployment.rollback   /  manifest.deploy   (legacy)
event.publish    /    event.replay
task.resolve
llm.key.rotate / llm.fleet.{add,update,remove}
budget.update
tenant.code.upload
```

`GET /v1/audit` returns cursor-paginated rows scoped to caller tenant; filters since/until/actor/action; default limit 100, clamped [1, 500].

### 10.4 Metrics

`/metrics` exposes Prometheus exposition:

- `runs_total{tenant, agent, status}` (counter)
- `tokens_total{tenant, provider, direction}` (counter)
- `run_duration_ms{tenant, agent}` (histogram)
- `llm_provider_errors_total{provider, code}` (counter)

Counters are bumped from `agent-invoke.ts` for the sync code-agent path and from `register.ts` finalize hook for the manifest path (Sprint 4 wired `setRuntimeMetrics(metrics)`).

### 10.5 Health

`HealthReport` schema:

```ts
{
  ok, ts, uptime, version, schemaVersion,
  inngest: { ok, status },
  sqlite: { ok, journalMode },
  disk:   { ok, freeBytes },
  llmGateway: { ok, defaultProvider, defaultModel, providers }
}
```

503 when any subsystem unhealthy.

### 10.6 Tracing

Correlation IDs propagate through events and runs (`correlation.ts`); no OpenTelemetry yet (UC-V11-34 deferred to V2).

---

## 11. Security posture

### 11.1 Input validation

All POST bodies Zod-parsed. Query strings on `runs`/`events`/`audit`/`usage` are Zod-parsed. Path params are not yet Zod-regex-validated end-to-end (low risk since they hit the DB and 404 on miss).

### 11.2 Rate limiting

**Not implemented at API layer.** `@fastify/rate-limit` not registered. Wave 4 deferred per-tenant rate-limit to V1.1 (UC-V11-10).

### 11.3 CORS + Helmet

CORS pinned to `WEB_ORIGIN`, `credentials: true`, `exposedHeaders: ['x-request-id']`. `apps/api/src/plugins/security.ts` (183 LOC) installs `@fastify/helmet`-style headers (CSP, HSTS, X-Frame-Options, etc.) — registered at `server.ts:79`.

### 11.4 SSRF guard

`apps/api/src/services/ssrf-guard.ts` (330 LOC). Policy:

- Blocks `file://`, `ftp://`, `data:`, all RFC1918 (10/8, 172.16/12, 192.168/16), loopback, link-local (169.254/16, including AWS metadata 169.254.169.254).
- HTTPS-only by default; `http://localhost` allowed only when `AGENTIC_FETCH_ALLOW_HTTP_LOCALHOST=1`.
- Re-checks on every redirect (max 5 hops, ≤5 MB body, 5 s timeout).
- DNS resolution snapshot prevents TOCTOU swap between resolve and connect.
- Audit row `manifest.import.fetch_url.blocked` on policy violation.
- Test coverage: `manifest-import-ssrf.test.ts` — 35 sub-cases.

### 11.5 Path traversal

`artifacts.ts:28` streams `row.path` from DB. Writers populate it via `path.join(artifactsRoot, runId, name)` so the field is never user-controlled. Defense-in-depth assertion that the resolved path is under `AGENTIC_ARTIFACTS_DIR` is a TODO.

`tenant-code.ts:405-410` rejects any tar entry whose path doesn't normalize cleanly under the extraction dir.

### 11.6 SQL injection

All queries via Drizzle's parameterised builder. Two raw `sql\`\`` templates exist (`queries/runs.ts:34, 56`) for `IN (...)` lists; they interpolate via `sql\`${id}\`` placeholders which Drizzle escapes.

### 11.7 Secrets

- `.env` / `.env.local` gitignored.
- API tokens SHA-256 hashed at rest in `api_tokens.hash`.
- `AUTH_SESSION_SECRET` (or `SESSION_SECRET`) read at boot; cookie auth refuses to authenticate when absent in prod.
- Provider keys persisted in a sidecar JSON state file; only the last 4 chars are returned via the API.

### 11.8 Webhook anti-replay

Per §9.4 — ±5 min window + 1 h idempotency cache. Cross-process replay (multiple API instances) isn't covered yet; the cache is in-process. Sufficient for single-instance v1.

---

## 12. Testing posture

### 12.1 Harness

- Vitest + `pool: 'forks'` (better-sqlite3 is single-threaded). `sequence.concurrent: false`.
- `app.inject()` test harness boots the **real Fastify app** — no network roundtrip, full handler chain executes against a real SQLite file.
- Setup file (`apps/api/test/setup.ts`) forces `AUTH_MODE=dev`, `AGENTIC_DEV_TENANT=__system`, `LLM_DEFAULT_PROVIDER=mock`, redirects logs/artifacts under `data/test-{logs,artifacts}/`.

### 12.2 Coverage at Sprint 4 closeout

| Metric | Result |
|---|---|
| api vitest | **366 / 367 (99.7 %)** |
| api typecheck | 0 errors |
| web typecheck | 0 errors |
| web vitest | 82 / 82 |
| smoke endpoints | 11 / 11 alive |
| `x-request-id` echoed | every response |

### 12.3 Test inventory

51 api vitest files exist (`apps/api/test/`), covering: every `/v1/*` route, the manifest-import wizard (7 files / 75 sub-cases), the LLM gateway, the broadcast channel + SSE, the budget hook, the step engine, condition evaluator, branch-emit resolution, register helpers, tenant CRUD + isolation + idempotency, webhook ingest, cron triggers, tenant-loader, tenant-code upload, schema drift, run logs, graceful shutdown, metrics + health, auth mode guard, tenant header override (post-Sprint-4 hotfix), and the event tester causality graph.

### 12.4 Open coverage gaps

- The 6-step manifest-import **UI wizard** has zero Playwright coverage (TC-119 manual UAT only).
- Run-replay audit row is not yet written (UC-6 open question).
- Cross-tenant bearer IDOR e2e test (Wave 4 top-10 list, written but only partial).
- Top-10 Wave 5 new tests (RAAS stage walk, cookie-auth-prod, agents-500-tenant-code, failRun race) are scoped but not all written.

---

## 13. Build, packaging, deployment

### 13.1 Dev runner

`package.json:11-13`:

```
predev: lsof -ti:3599,3501,8288,8289,50052,50053 | xargs kill -9
dev:    concurrently web :3599 + api :3501 + inngest :8288
```

API: `tsx watch --env-file=../../.env --env-file=.env.local src/server.ts`.

### 13.2 Production target

`apps/api/package.json:start = tsx --env-file=… src/server.ts`. No `tsc --emit` per package; turbo's `build` task is configured but only `apps/web` has a real build (`next build`). For prod containerisation, Docker would: install Node 26 → `pnpm install --frozen-lockfile` → `pnpm db:migrate` → `tsx apps/api/src/server.ts` under `tini` for signal handling. No Dockerfile in-repo yet.

### 13.3 ESM + native binding

- All workspace packages are `"type": "module"`.
- `better-sqlite3@12.10.0` is CJS native; loaded via `resolveNativeBinding` walking up `node_modules` (hoisted + `.pnpm/`). Env override `AGENTIC_SQLITE_BINDING` covers exotic install layouts.
- Node 26 (MODULE_VERSION 147) is mandatory — `.nvmrc` pins it. Mixing Node 25 binaries with Node 26 runtime crashes with `ERR_DLOPEN_FAILED`. Sprint 4 spent a half-day diagnosing exactly this (a stale `pnpm rebuild` cycle).

### 13.4 Required env vars

```
DATABASE_URL              (defaults to <repo>/data/agentic.db)
AGENTIC_LOGS_DIR          (default ./data/logs)
AGENTIC_ARTIFACTS_DIR     (default ./data/artifacts)
AGENTIC_MODELS_DIR        (no longer hardcoded; resolved via env-or-./models)
AGENTIC_TENANTS_DIR       (default ./data/tenants)
INNGEST_*                 (dev mode bypass exists)
LLM_DEFAULT_PROVIDER      (mock is safe default)
ANTHROPIC_API_KEY / OPENAI_API_KEY / ...   (per-provider)
WEB_ORIGIN                (CORS pin)
AUTH_MODE                 (set 'dev' to unlock dev-tenant; never set in prod)
AGENTIC_DEV_TENANT        (default 'raas')
AUTH_SESSION_SECRET       (cookie JWT; can also use SESSION_SECRET)
WEBHOOK_HMAC_SECRET_<PROVIDER>  (per-provider, plus optional DEFAULT)
AGENTIC_MAX_BODY_BYTES    (default 10 MB)
AGENTIC_SHUTDOWN_TIMEOUT_MS (default 10 s)
LOG_LEVEL                 (pino, default 'info')
PORT / HOST               (default 3501 / 0.0.0.0)
```

---

## 14. Remaining issues + recommendations

Bucketed by risk × cost-of-inaction. Effort: S=≤1d, M=2-5d, L=1w+.

### 14.1 Open V1.0.1 hotfix candidates (per `docs/V1_SHIP_VERDICT.md`)

| ID | Title | Effort | Status |
|---|---|---|---|
| tc-24 | testRun flag — `runs.is_test` + SSE payload | S | wired in Sprint 4; lone fail is a test querying stale `events` table (test bug, not code bug — see master plan line 374) |
| tc-27 | tenant-code rollback response shape — restore `target` field | S | landed in Sprint 4 engine+budget pass |
| tc-5  | test-isolation: `deployments.status='live'` flipped by tc-27 | S | mitigated by deployment scoping fix |

### 14.2 Open Wave 4 backend items

| ID | Title | Effort |
|---|---|---|
| UC-V11-22 | Bump `runs_total` from manifest engine finalize | S (probably already done via `setRuntimeMetrics`) |
| UC-V11-23 | Wire `agent.tool_use` → tenant tool name in `runAction` | M |
| UC-V11-24 | Per-agent `defaultProviders` on `BaseAgent` | S |
| UC-V11-27 | Remove `WEBHOOK_HMAC_SECRET_DEFAULT` fallback | S |
| UC-V11-35 | Move `failRun` inside `step.run("finalize", …)` | S |

### 14.3 Deferred to V1.1 / V2

- `@fastify/rate-limit` per-tenant + per-IP (UC-V11-10).
- OpenTelemetry tracing (UC-V11-34 → V2).
- DLQ for permanent Inngest failures (UC-V11-36 → V2).
- Bedrock + Vertex real adapters (UC-V11-26).
- Webhook subscription CRUD UI (`webhook_subscriptions` table exists).
- Multi-instance scaling (Postgres + shared queue, or sticky routing) — currently single-box.
- Run-replay audit row.
- Compiled production build (tsc-emit or esbuild bundle) — currently `tsx` in prod is acceptable but a Dockerfile + `pnpm db:migrate` ordering need to be authored.

### 14.4 Permanent strengths to preserve

1. The Zod-contracts-everywhere pattern; new routes should not invent shapes.
2. Idempotent boot — every step should remain re-runnable.
3. Inngest step.run discipline — every DB write inside an Inngest handler must stay inside a `step.run`.
4. The 4-phase manifest commit (DB tx → fsync → rename → re-register) — preserves the crash-recovery property.
5. `assertAuthModeSafe()` — the spirit of "loud boot failure beats silent prod auth bypass" should govern every future env-var-driven branch.

---

## 15. Quick file index

| Concern | File |
|---|---|
| Boot orchestration | `apps/api/src/server.ts:38`, `apps/api/src/bootstrap.ts:71` |
| Auth | `apps/api/src/plugins/auth.ts:143`, `auth.ts:205` |
| Envelope + error map | `apps/api/src/plugins/error.ts:39` |
| Graceful shutdown | `apps/api/src/plugins/shutdown.ts` |
| Security headers | `apps/api/src/plugins/security.ts` |
| Manifest import (1640 LOC) | `apps/api/src/services/manifest-import.ts` |
| Crash recovery | `apps/api/src/services/reconcile-imports.ts` |
| SSRF | `apps/api/src/services/ssrf-guard.ts` |
| Provider keys | `apps/api/src/services/provider-keys.ts` |
| Model fleet | `apps/api/src/services/model-fleet.ts` |
| Idempotency cache | `apps/api/src/services/idempotency.ts` |
| Step engine | `packages/runtime/src/register.ts:53`, `step-engine.ts:158` |
| Manifest linter | `packages/runtime/src/lint.ts` |
| Schema | `packages/db/src/schema.ts`, migrations under `packages/db/drizzle/` |
| Native binding resolver | `packages/db/src/client.ts:25` |
| LLM Gateway | `packages/llm-gateway/src/gateway.ts:71` |
| BaseAgent + run engine | `packages/agents/src/{base-agent,run-engine}.ts` |
| Contracts | `packages/contracts/src/index.ts` |
| Web typed client | `apps/web/lib/api-client.ts:40` |
| Tests | `apps/api/test/tc-*.test.ts`, `setup.ts`, `harness.ts` |

---

*This document is the English half of the bilingual review pair. The Chinese counterpart is at `backend-implementation-review-zh.md`.*
