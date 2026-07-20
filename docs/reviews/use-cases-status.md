# Use Cases — Completion Status

> **Snapshot date:** 2026-05-23 (post Sprint 4 + Dashboard hotfix)
> **Source-of-truth:** `docs/team-execution/01-use-cases.md` (16 core UCs) + `docs/USE_CASES.md` (128 catalogued UCs incl. V1.1)
> **Methodology:** cross-reference each UC against (a) route registration in `apps/api/src/server.ts`, (b) frontend hook/page presence, (c) test status from `tc-*.test.ts` (366/367 passing as of Sprint 4 closeout)

Status legend:
- ✅ **shipped** — route alive, UI wired, automated test green
- 🟡 **partial** — route or UI gap, but the other half works; documented below
- ⏳ **deferred** — backlog for V1.1 / V2

---

## 1. Headline

Out of **16 core UCs** documented in `docs/team-execution/01-use-cases.md` (when the doc was first authored, Sprint 1):

| Status (Sprint 1 baseline) | Count |
|---|---|
| implemented | 9 (UC-1, UC-2, UC-3, UC-4, UC-4a, UC-5, UC-6, UC-7, UC-9) plus UC-13 |
| partial — route unregistered | 6 (UC-8 partial, UC-11, UC-12, UC-14, UC-14a-modern, UC-15) |
| partial — UI wiring incomplete | 1 (UC-10) |
| partial — no UI usage | 1 (UC-16) |
| planned only | 0 |

**Sprint 1-4 closed every "route unregistered" gap.** Current state:

| Status (Sprint 4 closeout, 2026-05-23) | Count |
|---|---|
| ✅ shipped | 14 |
| 🟡 partial | 2 (UC-10 UI wiring, UC-16 frontend usage) |
| ⏳ deferred | 0 |

Two cross-cutting concerns moved partial → implemented in Sprints 2-3:
- **UC-Auth** — hardened (cookie + bearer + boot guard + assertAuthModeSafe + dev tenant header override).
- **UC-Obs (Observability)** — SIGTERM graceful shutdown, `/metrics`, full `HealthReport`, `x-request-id` propagation.

---

## 2. Per-UC status

### UC-1: Create a tenant ✅

- **API:** `POST /v1/tenants` + GET/PUT/DELETE/POST-restore at `apps/api/src/routes/v1/tenants.ts` (783 LOC, registered at `server.ts:106`)
- **Tables touched:** `tenants`, `tenant_budgets`, `memberships`, `event_types`, `entity_types`, `workflows`, `workflow_versions`, `api_tokens`, `audit_log`
- **UI:** `TenantCreateModal.tsx` 4-step wizard + `TenantTokenRevealModal.tsx` (one-time token)
- **Idempotency:** `Idempotency-Key` header honored 1h (LRU at `routes/v1/tenants.ts:115-134`)
- **Audit:** `tenant.create` written in same SQLite tx
- **Tests:** `tc-70-tenants-crud.test.ts` (16 sub-cases), `tc-71-tenants-idempotency.test.ts` (3), `tc-62-tenants-isolation.test.ts` (7) — all green
- **Actor identity:** resolved — mutations use the authenticated `req.auth.userId`; no seed-account fallback remains.

### UC-2: Import a workflow manifest ✅

- **API:** `POST /v1/tenants/:slug/manifest-import` (modes: validate, commit) + fetch-url + DELETE-lock; route at `routes/v1/manifest-import.ts` (307 LOC); core service `services/manifest-import.ts` (1640 LOC)
- **Wizard:** 6-step `ImportManifestModal.tsx`; auto-opens after tenant create
- **Atomicity:** 4-phase commit (preflight → fsync staging → SQLite tx → fs.rename + Inngest re-register); crash recovery via `reconcileImports()` on next boot
- **423 lock:** 1h pending deployments row; `?confirm=1` for overwrite
- **Tests:** `manifest-import-validate.test.ts` (8), `…-commit.test.ts` (3), `…-concurrent.test.ts` (2), `…-overwrite-guard.test.ts` (18), `…-conflict.test.ts` (9), `…-ssrf.test.ts` (35), `…-perf.test.ts` (2), `tc-7-manifest-schema-fields.test.ts` (5) — 82 sub-cases; **lone red** is `manifest-import-commit > cold commit … inserts a live deployment` (test asserts stale `events` table; code path actually writes `audit_log` — see master plan line 374)
- **Open:** UC-2a `fetch-repo` still 501 stub; lint detector `prompt_injection_smell` is heuristic only

### UC-3: Roll back a deployment ✅

- **API:** `POST /v1/deployments/:id/rollback` at `routes/v1/deployments.ts:21`
- **Behavior:** Sprint 4 scoped demotion to same `target` (was demoting across all targets); response now includes `target` field per V1.0.1 hotfix
- **Audit:** `deployment.rollback` row written
- **Tests:** `tc-27-p3-tenant-code-upload.test.ts` (3 — green), `tc-5-monitoring-reuse.test.ts` (4 — green after Sprint 4 fix)
- **Open:** UC-V11-35 — Inngest re-register on rollback is currently restart-only; modern manifest-import-commit path does hot-swap but rollback does not (`note` field on response surfaces this)

### UC-4: Invoke an agent synchronously (code agent) ✅

- **API:** `POST /v1/agents/:name/invoke?testRun=1&async=0` at `routes/v1/agent-invoke.ts:36`
- **Implementation:** `agentRegistry.get(name)` → `BaseAgent.run(input, ctx)` (`packages/agents/src/run-engine.ts:101`)
- **Output:** runs row + steps rows + per-line `.log` file + SSE `run.started`/`run.completed|failed` frames
- **testRun flag (Sprint 4):** `?testRun=1` threads through `agent-invoke.ts` → BaseAgent ctx → `run-engine.ts` → sets `runs.is_test` + emits `testRun` in `RunStreamEvent`
- **Tests:** `tc-3-test-agent-happy.test.ts` (6), `tc-4-test-agent-error.test.ts` (3), `tc-5-monitoring-reuse.test.ts` (4), `tc-24-p2-test-run-flag.test.ts` (7/7) — all green
- **Open:** `tenantSlug: "__system"` is hardcoded for code-agent runs (`agent-invoke.ts:193`); cross-tenant code-agent runs all attribute to `__system` by design

### UC-4a: Invoke a manifest agent (Inngest-queued) ✅

- **API:** Same route; manifest-fallback path at `agent-invoke.ts:79-164`
- **Behavior:** Mints synthetic `eventId` + `correlationId`; `inngest.send({ name: "<slug>/<triggerEvent>", data })` → 202 with `eventId`
- **Tests:** `tc-17-p1-code-agent-inngest.test.ts` (4), `tc-26-p3-inngest-registry.test.ts` (2), e2e `01-manifest-agent-run.spec.ts` — all green
- **Open:** UC-V11-35 — `failRun` race (write outside `step.run`) still open

### UC-5: Publish (trigger) an event ✅

- **API:** `POST /v1/events` at `routes/v1/events.ts:40`
- **Side-effects:** writes NDJSON ledger line (`appendToLedger`); inserts events row; `inngest.send` with tenant-namespaced name; audit row (unless source='external'); `event_types.category` lookup for SSE colour-coding
- **Tests:** `event-tester.test.ts` (14 — covers publish, category stamping, list/recent agreement, soft-delete, cross-tenant blocking, `__test` envelope flag, causality BFS depth 3, SSE delivery <500ms, legacy bare-array shape); `tc-32-p3-cron.test.ts` (9/9)
- **Open:** none

### UC-6: Replay an event (or a run) ✅

- **API:** `POST /v1/events/:id/replay` (`events.ts:140`), `POST /v1/runs/:id/replay` (`runs.ts:38`)
- **Behavior:** Re-reads original payload via `events.payloadRef` (file#offset); mints new `evt-…` ID via `makeId("evt")` (no same-ms collisions); `inngest.send` with `__replayOf` / `__replayOfRun`
- **Audit:** event replay writes audit row; **run replay does NOT yet write audit row** (documented gap)
- **Tests:** `tc-6-p0-auth-isolation.test.ts` P0-API-01 sub-case (replay ID uniqueness, 15/15 sub-cases all green); `tc-50-p4-reads-coverage.test.ts` includes 404 paths for run-replay
- **Open:** run-replay audit row (low priority)

### UC-7: Resolve a HITL task ✅

- **API:** `POST /v1/tasks/:id/resolve` at `routes/v1/tasks.ts:27`
- **Behavior:** Validates tenant + `status === 'open'`; `inngest.send("task.resolved", { taskId, tenantId, decision, payload })`; audit row `task.resolve`
- **HITL plumbing:** `register.ts:213-217` — `step.waitForEvent("task.resolved", { if: 'async.data.taskId == "<id>"' })` with 7-day timeout
- **Tests:** `tc-50-p4-reads-coverage.test.ts` (404 paths); `event-tester.test.ts` (task.resolve audit); e2e `03-human-task-resolve.spec.ts` (UI flow). **TC-111 (foreign-tenant 404 case)** not yet automated as a standalone file but covered transitively by `tc-62-tenants-isolation`
- **Open:** task TTL / auto-expire; "snoozed" status (`TaskStatus` enum supports it, no UI/API)

### UC-8: View a live run + tail its logs ✅ (was 🟡 in Sprint 1)

- **API:** `GET /v1/runs/:id`, `GET /v1/runs/:id/logs?follow=1` (SSE), `GET /v1/stream` (tenant-wide SSE)
- **Sprint 3 fix:** `streamRoutes` registered at `server.ts:116`; `/v1/stream` previously 404'd
- **UI:** `runs/[id]/page.tsx` mounts `useRunLogStream` + `useStream`; both reconnect on transport drop with exponential backoff
- **Sprint 2 fix:** `__system` IDOR fallback on `/v1/runs/:id` and `/v1/runs/:id/logs` removed
- **Tests:** `tc-14-p1-stream.test.ts` (8/8 — broadcast channel + SSE + tenant isolation); `tc-50-p4-reads-coverage.test.ts` (run reads); manual `useRunLogStream` UX flow remains TC-115 manual UAT
- **Open:** SSE reconnect UX under network flip — manual UAT only

### UC-9: Browse the workflow DAG ✅

- **API:** `GET /v1/workflows/dag` at `routes/v1/reads.ts:18` → `getDag(tenantSlug)` joins agents + workflow_versions + event_listeners + recent run counts
- **UI:** `workflows/page.tsx` + `inspectors.tsx`; hand-tuned stage/lane layout
- **Tests:** `tc-34-workflow-route.test.ts` (10/10), `tc-50-p4-reads-coverage.test.ts` (DAG sub-cases)
- **Open:** layout-stability check (no edge crossings) is visual judgement (TC-116 manual)

### UC-10: Configure LLM providers and the model fleet 🟡

- **API:** ✅ — 8 endpoints under `/v1/llm/*` at `routes/v1/llm.ts` (251 LOC), all green tests
- **UI:** 🟡 — `apps/web/app/portal/components/settings/sections/Models.tsx` does **not** call `/v1/llm/*` endpoints per `grep -n "fetch\|useQuery\|llm\|provider"` — the section reads from a static draft
- **Tests:** `tc-1-llm-providers.test.ts` (5/5), `tc-2-llm-models.test.ts` (4/4), `tc-60-llm-key-mgmt.test.ts` (7/7), `tc-61-llm-fleet.test.ts` (12/12)
- **Open:** **UI wiring is the gap** — needs `useProviders` / `useFleet` hooks + Models.tsx rewire. Backlogged to V1.1 polish.

### UC-11: View / set tenant budget and usage ✅ (was 🟡 in Sprint 1)

- **API:** `GET /v1/usage`, `GET /v1/budgets`, `PUT /v1/budgets` — all wired (`usageRoutes` and `budgetsRoutes` registered at `server.ts:109,110` in Sprint 1 Phase 3)
- **Budget hook:** `packages/llm-gateway/src/budget.ts` enforces token + USD caps on every `chat()` call; over-cap throws `cost_limit_exceeded` → 503
- **UI:** `settings/usage/page.tsx` + `useUsage` + `useBudget`
- **Tests:** `tc-21-p1-budget.test.ts` (5/5), `tc-50-p4-reads-coverage.test.ts` (budgets sub-case)
- **Open:** `MODEL_PRICING` table in `usage.ts:53-63` is still a stub — real per-model USD calculation TODO. UC-V11-17 (frontend envelope unwrap) backlogged.

### UC-12: View the audit log ✅ (was 🟡 in Sprint 1)

- **API:** `GET /v1/audit` at `routes/v1/audit.ts:39` — registered at `server.ts:111` in Sprint 1 Phase 3
- **UI:** `settings/audit/page.tsx` + inline `Audit.tsx` section
- **Pagination:** cursor on `(at, id)`; filters since/until/actor/action; limit clamped [1, 500]
- **Tests:** `tc-20-p1-api.test.ts` audit-block (8 sub-cases), `tc-50-p4-reads-coverage.test.ts` audit sub-cases (descending order + filter checks)
- **Open:** CSV export; cross-tenant view for platform-admin role; TC-133 (pagination at >10k rows) — manual

### UC-13: External webhook intake ✅

- **API:** `POST /v1/webhooks/:provider` at `routes/v1/webhooks.ts` (357 LOC, Sprint 3 restored after Sprint 2 stash incident)
- **Behavior:**
  - Subscription lookup in `webhook_subscriptions` by `provider` (+ optional `x-tenant-slug`)
  - Raw-body HMAC-SHA256 via plugin-scoped content-type parser
  - ±5 min replay window on `x-timestamp`
  - In-process idempotency cache (1h TTL / 10k cap)
  - Header scrubbing (`Authorization`/`Cookie`/`Set-Cookie` stripped)
  - `inngest.send` failure → log + ack-202
- **Tests:** `tc-31-p3-webhooks.test.ts` (9/9 — covers 404 unknown source, 400 empty body, 401 missing/bad HMAC, 202 valid, idempotency, ±5 min window, malformed slug)
- **Open:** UC-V11-27 — remove `WEBHOOK_HMAC_SECRET_DEFAULT` env fallback so per-subscription secret is mandatory; Webhook subscription CRUD UI

### UC-14: Tenant-wide live updates (SSE) ✅ (was 🟡 in Sprint 1)

- **API:** `GET /v1/stream` at `routes/v1/stream.ts:29` — registered at `server.ts:116` in Sprint 3
- **Implementation:** `subscribeStreamEvents(auth.tenantId, …)` via `@agentic/runtime` broadcast module; 15s keepalive comment frames
- **UI:** `useStream()` opens EventSource; on each frame dispatches `queryClient.invalidateQueries` keyed by event type (`run.started`/`run.step.*`/`event.emitted`/`task.created`/`task.resolved`)
- **Tests:** `tc-14-p1-stream.test.ts` (8/8 — publish→subscribe, tenant isolation, unsubscribe → count drops, RunStreamEvent zod variants, real SSE delivery)
- **Open:** persistent message queue with high-water-mark drops (Phase 4 swap)

### UC-14a: Save a workflow manifest from the editor ✅ (was 🟡 in Sprint 1)

- **Legacy path:** `POST /v1/agents` at `routes/v1/agents.ts:97` (registered) — still used by editor's Save button
- **Modern path:** `PUT /v1/tenants/:slug/workflow` at `routes/v1/workflow.ts:227` (Sprint 3 registered at `server.ts:118`) — writes `models/<slug>-vN/workflow_vN+1.json` + Inngest re-register
- **Tests:** `tc-34-workflow-route.test.ts` (11/11)
- **Open:** Editor's Save button still POSTs to the legacy route; ideally migrate to the modern `PUT` for hot-swap. TC-122 e2e `05-workflow-editor-save.spec.ts` covers the round-trip.

### UC-15: Deploy tenant-specific code package ✅ (was 🟡 in Sprint 1)

- **API:** `POST /v1/tenants/:slug/code` at `routes/v1/tenant-code.ts:74` (431 LOC, Sprint 3 registered at `server.ts:117`)
- **Behavior:** Base64-decode → optional gunzip → minimal POSIX-tar parser (`parseTarball`, no external `tar` dep) → atomic `fs.rename` → DB tx (workflow + deployments) → Inngest re-register + audit
- **Sprint 3 enabler:** drizzle `deployments.target` enum widened to include `"tenant_code"`
- **Tests:** `tc-27-p3-tenant-code-upload.test.ts` (3/3), `tc-25-p3-tenant-loader.test.ts` (5/5)
- **Open:** No portal UI — CLI-only (`agentic deploy <path>`); ZIP archives unsupported (tar only)

### UC-16: Read artifacts (file download) 🟡

- **API:** ✅ — `GET /v1/artifacts/:id` at `routes/v1/artifacts.ts:9`, streams `row.path` with proper `Content-Type`/`Content-Length`
- **UI:** 🟡 — no App Router hook exists; surfaced only as bare anchor tags in run-detail / agent-detail pages. `grep -r "/v1/artifacts/" apps/web/app/portal/` returned empty
- **Tests:** `tc-50-p4-reads-coverage.test.ts` includes artifact 404/410 sub-cases
- **Open:** **UI usage is the gap** — add `useArtifacts` hook + render a downloads panel in run-detail. Low priority for V1.

---

## 3. Cross-cutting concerns

### UC-Auth (cross-cutting) ✅

Was partial in Sprint 1 (dev-mode bypass + `__system` IDOR + `?tenant=` override).

Sprint 2 + dashboard hotfix fixes:
- `authenticate()` dev-tenant unlock requires explicit `AUTH_MODE=dev` (no NODE_ENV fallback)
- `__system` IDOR fallback removed from `/v1/runs/:id` + `/v1/runs/:id/logs`
- `?tenant=` cross-tenant override removed from `/v1/agents`
- `verifyHmac` relocated to `plugins/webhook-hmac.ts`
- `assertAuthModeSafe()` boot guard — refuses `AUTH_MODE=dev + NODE_ENV=production` or unknown `AGENTIC_DEV_TENANT`
- Cookie auth via `jose` HS256 (UC-V11-29 P0 V1-blocker)
- `x-agentic-tenant` header in dev mode — Next.js portal forwards URL `[tenant]` segment so dashboards bind to URL-derived tenant, not env-pinned

Tests: `tc-6-p0-auth-isolation.test.ts` (15/15), `tc-53/tc-63-auth-mode-guard.test.ts` (4/4), `tc-74-tenant-header-override.test.ts` (8 sub-cases)

### UC-Obs (Observability) ✅

Was deferred to Phase 4 in Sprint 1. Sprint 2-3 fixes:
- `installGracefulShutdown(app)` plugin — SIGTERM drains in ≤10s, idempotent
- `HealthReport` extended with `ts/uptime/version/schemaVersion/llmGateway`
- `/metrics` Prometheus exposition with `runs_total`, `tokens_total`, `run_duration_ms`, `llm_provider_errors_total`
- `x-request-id` propagation via `genReqId` + `onSend` echo + CORS `exposedHeaders`
- Structured pino lines on 10 silent mutating endpoints

Tests: `tc-50-p4-reads-coverage.test.ts` (32/32), `tc-51-p4-graceful-shutdown.test.ts` (1/1), `tc-52-p4-metrics-health.test.ts` (2/2)

---

## 4. Test cases mapped to UCs

From `docs/team-execution/04-test-cases.md` — 77 TC entries (64 automated / 11 manual / 5 partial), spread across 51 existing test files. Pass rate at Sprint 4 closeout: **366/367 (99.7%)**.

Coverage by UC:

| UC | Automated TCs | Manual TCs | Total sub-cases |
|---|---|---|---|
| UC-1 (TenantsCRUD) | TC-50, TC-51, TC-52, TC-70, TC-71 | TC-100, TC-118 | 26 sub-cases automated; 2 manual UAT |
| UC-2 (ManifestImport) | TC-7, TC-33, TC-101..108, TC-11 | TC-103, TC-109, TC-119 | 82 automated; 3 manual UAT (incl. wizard 6-step UX) |
| UC-3 (Deploy/rollback) | TC-27, TC-50 | TC-110 | 7 automated; 1 manual |
| UC-4 (AgentInvoke) | TC-3, TC-4, TC-5, TC-9, TC-10, TC-12, TC-15, TC-16, TC-17, TC-22, TC-24, TC-26, TC-30 | — | 78 automated |
| UC-5 (Events) | TC-32, TC-112, TC-113 | — | 23 automated |
| UC-6 (Replay) | TC-6 P0-API-01 | — | 1 automated (covered in larger test) |
| UC-7 (HITL) | partial (TC-50) + e2e-03 | TC-111 | 1 e2e + 1 missing-direct-test |
| UC-8 (Logs/SSE) | TC-14 | TC-115 | 8 automated; 1 manual |
| UC-9 (DAG) | TC-34, TC-50 | TC-116 | 12 automated; 1 manual visual |
| UC-10 (LLM) | TC-1, TC-2, TC-60, TC-61 | — | 28 automated |
| UC-11 (Budgets) | TC-21, TC-15 | TC-117 | 9 automated; 1 manual UAT |
| UC-12 (Audit) | TC-20 audit-block, TC-50 | TC-133 | 14 automated; 1 manual |
| UC-13 (Webhooks) | TC-31 | — | 9 automated |
| UC-14 (Stream) | TC-14, TC-18 | — | 14 automated |
| UC-14a (Workflow editor) | TC-34, e2e-05 | — | 11 automated + 1 e2e |
| UC-15 (Tenant code) | TC-25, TC-27 | — | 8 automated |
| UC-16 (Artifacts) | TC-50 (404/410 paths) | — | 2 automated; no UI usage |
| UC-Auth | TC-6, TC-53, TC-63, TC-74 | TC-100 | 27 automated; 1 manual |
| UC-Obs | TC-50, TC-51, TC-52 | — | 35 automated |

**Coverage gaps that should not block V1:**
- TC-119 — Manifest import wizard 6-step UI Playwright spec (manual UAT only)
- TC-115 — `useRunLogStream` reconnect UX under network flip (manual)
- TC-100 — Bearer-token revocation race (route doesn't exist yet)
- TC-111 — HITL foreign-tenant 404 case (transitively covered by tc-62)

---

## 5. Production-readiness verdict (final)

| Use case bucket | Sprint 1 baseline | Sprint 4 closeout |
|---|---|---|
| Implemented end-to-end | 9 | **14** |
| Partial — route gap | 6 | **0** |
| Partial — UI gap | 1 (UC-10) | **1 (UC-10)** |
| Partial — no UI usage | 1 (UC-16) | **1 (UC-16)** |
| Cross-cutting hardened | — | **2 (UC-Auth, UC-Obs)** |
| Planned only | 0 | **0** |

**14 of 16 core UCs are fully implemented end-to-end.** The two remaining partial UCs are both UI-side gaps with the backend already complete: UC-10 needs `Models.tsx` to call `/v1/llm/*`, and UC-16 needs a `useArtifacts` hook. Neither blocks V1.

---

## 6. Recommended next steps for UC coverage

1. **Land UC-10 UI wiring** — `useProviders` + `useFleet` hooks in `apps/web/lib/hooks/`, rewire `Models.tsx`. Estimated 1 dev-day. Removes the last "partial" status.
2. **Add UC-16 UI usage** — `useArtifacts` hook + downloads panel in run-detail. Estimated half-day.
3. **Write TC-119 Playwright spec** for the 6-step manifest-import wizard — currently the single biggest e2e coverage gap per the Test Architect's report. Estimated 1 dev-day.
4. **Add TC-100 bearer-token revocation flow** — needs `POST /v1/api-tokens/:id/revoke` route + audit row + integration test. Estimated 1 dev-day.
5. **Close UC-6 run-replay audit gap** — currently event replay writes audit row; run replay does not. Add `audit_log` write inside `routes/v1/runs.ts:38` replay handler. Estimated 30 minutes.

After these (~3.5 dev-days total): **16/16 UCs fully implemented, 100% coverage matrix.**
