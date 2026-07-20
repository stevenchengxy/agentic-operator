# 01 — Use Cases (AI Software Architect)

**Status:** Live · **Owner:** AI Software Architect · **For:** Production hardening sprint Phase 1.

## How to read this doc

Every use case (UC-1 through UC-16) follows the schema below. Use it to:

- **Test architect (`04-test-cases.md`)** — derive at least one test per main flow and one per alt/error flow.
- **FE+UI audit (`02-ui-audit.md`)** — confirm each "Frontend surface" entry exists, renders, and gates the right errors.
- **Logging audit (`03-logging-audit.md`)** — confirm every "API surface" entry has structured pino logs + an audit row when the data model changes.

Every file pointer is absolute. Symbols are quoted verbatim. **Status** is honest: where a route exists but the UI is missing, or vice versa, the UC is marked `partial` and the gap is named.

### Two surprises found while writing this

1. **Six route files are NOT registered in `apps/api/src/server.ts:53-71`** — `auditRoutes`, `budgetsRoutes`, `usageRoutes`, `workflowRoutes`, `tenantCodeRoutes`, `streamRoutes`. The handlers exist, the contracts are wired, the frontend hooks (`useUsage`, `useBudget`, `useStream`, `Audit.tsx`) call them — but the v1 register block stops at `tenantsRoutes`. Every UC that depends on those files (UC-8 stream, UC-10 LLM in fact works because llm.ts IS registered, UC-11 budgets/usage, UC-12 audit, UC-14 workflow editor save, UC-15 tenant-code deploy) is marked `partial — route handler not registered`. **This is the single biggest concrete production gap on Phase 1.**
2. **`POST /v1/agents` (manifest upload via `agentsRoutes`)** still exists and is wired (`apps/api/src/routes/v1/agents.ts:97`). It is the legacy thin path; the new wizard at `POST /v1/tenants/:slug/manifest-import` (UC-2) is the canonical surface but `useDeployManifest` in `apps/web/lib/hooks/useManifest.ts:71-76` STILL targets the legacy route. The Workflow editor's "Save" button therefore bypasses the wizard's lock + diff + audit. Documenting both as separate UCs (UC-2 and UC-14a).

## Use-case schema

```
## UC-N: <verb-phrase title>

**Actor:** operator | tenant admin | inngest-internal | webhook-external
**Trigger:** what initiates this flow (UI click, scheduled event, external POST, etc.)
**Preconditions:** auth state, prior data, env vars
**Main flow:** numbered steps. Reference the exact route handlers + frontend files.
**Alt / error flows:** ≥ 2 (overwrite-guard 409, 423 lock, validation 400, auth 401/403, not_found 404)
**Postconditions:** rows written, files renamed, audit row, events emitted
**API surface:** every `/v1/*` endpoint hit + envelope shape
**Data model touched:** every table (`packages/db/src/schema.ts` names)
**Frontend surface:** the App Router page(s) + hook(s)/modal(s) that drive it
**Out of scope:** what this UC explicitly does NOT cover
**Status:** implemented | partial | planned
**Open questions:** anything ambiguous
```

---

## UC-1: Create a tenant

**Actor:** operator (any authenticated caller in current milestone — `isPlatformAdmin` stub at `apps/api/src/routes/v1/tenants.ts:34` returns false).
**Trigger:** Sidebar "New tenant" button in `apps/web/app/portal/components/shell/tenant-switcher.tsx:282` opens `TenantCreateModal` (4-step wizard at `apps/web/app/portal/components/shell/TenantCreateModal.tsx:48`).
**Preconditions:**
- `AUTH_MODE=dev` or a valid bearer token in `api_tokens`.
- `AGENTIC_DEV_TENANT` resolvable; `AGENTIC_DATA_ROOT` writable (mkdir for log/artifact dirs).
- Slug satisfies `TENANT_SLUG_REGEX` (`/^[a-z][a-z0-9-]{1,31}$/`) and is not in `RESERVED_TENANT_SLUGS` (`packages/contracts/src/tenants.ts:24-49`).

**Main flow:**
1. Operator types slug + name; client-side preview enforces the same regex.
2. Modal POSTs `/v1/tenants` with `TenantCreateBody` (`packages/contracts/src/tenants.ts:96-146`). Optional `Idempotency-Key` header.
3. `tenantsRoutes` handler at `apps/api/src/routes/v1/tenants.ts:542-589` runs `requireAuth`, Zod-parses, reserved-check (line 548), consults the in-memory idempotency cache (line 561), then calls `performCreate` at `apps/api/src/routes/v1/tenants.ts:228`.
4. Single SQLite transaction (`apps/api/src/routes/v1/tenants.ts:274-438`) inserts:
   - `tenants` row.
   - `tenant_budgets` defaults (null caps).
   - `memberships(role='admin')` for the resolved operator user.
   - Starter event types for `starter='hello'` (the `HELLO_STARTER_EVENTS` constant, line 200-218) or clones from `copy-from:<slug>` (lines 330-403).
   - `api_tokens` bootstrap row when `mintToken: true`.
   - `audit_log` row with `action='tenant.create'`.
5. Outside the tx: `ensureTenantDirs` mkdirs `data/logs/<slug>/{runs,events}`, `data/artifacts/<slug>`, `data/tenants/<slug>` (line 175). `safeReregisterInngest` re-binds Inngest functions if the hook is exported.
6. Response 201 with `{ ok: true, data: { tenant, membership, token, starter, inngestFns } }` — `TenantCreateResponse` shape, plaintext token returned ONCE.

**Alt / error flows:**
- **409 `slug_taken`** — `tenantSlugExists(body.slug)` true. `performCreate` throws with `statusCode=409`; route maps to `reply.fail("slug_taken", …, 409)` (apps/api/src/routes/v1/tenants.ts:236-243).
- **400 `reserved_slug`** — Zod superRefine OR `isReservedSlug` post-check (line 548-554).
- **400 `copy_source_unknown`** — `starter='copy-from:bogus'` and source tenant row doesn't exist (line 254-261).
- **400 Zod validation** — bad regex, slug too short/long, color malformed; envelope plugin returns `{ ok: false, error: { code: 'validation_error', message, hint } }` from `apps/api/src/plugins/error.ts`.
- **401** — `requireAuth` throws when bearer missing in non-dev mode.

**Postconditions:**
- 5 new rows minimum (`tenants`, `tenant_budgets`, `memberships`, `api_tokens`, `audit_log`); +2 if `starter='hello'`.
- 4 new directories on disk.
- Inngest re-registered (or deferred with debug log).
- TanStack Query key `TENANTS_KEYS.all` should be invalidated by caller — `useTenants` at `apps/web/lib/hooks/useTenants.ts:74` then refetches.
- If `mintToken: true`, the plaintext token is shown in `TenantTokenRevealModal` and cannot be re-retrieved.

**API surface:** `POST /v1/tenants` → 201 wrapped envelope. Idempotency-Key header honored for 1 h (in-memory LRU at `apps/api/src/routes/v1/tenants.ts:115-134`).
**Data model touched:** `tenants`, `tenant_budgets`, `memberships`, `event_types`, `entity_types` (copy-from path), `workflows`, `workflow_versions` (copy-from path), `api_tokens`, `audit_log`.
**Frontend surface:**
- `apps/web/app/portal/components/shell/TenantCreateModal.tsx:48` — wizard.
- `apps/web/app/portal/components/shell/TenantTokenRevealModal.tsx` — one-time token display.
- `apps/web/lib/hooks/useTenants.ts:74` — list refetch.
- Cross-flow: after success, `tenant-switcher.tsx:62-90` auto-opens `ImportManifestModal` so the empty workspace can immediately receive a manifest.

**Out of scope:**
- Role assignment beyond auto-admin for caller — UC-12 placeholder.
- Tenant-level webhook secret rotation (UC-13).

**Status:** implemented.
**Actor identity:** the implemented route uses the authenticated
`req.auth.userId` for membership grants and audit attribution. There is no
hard-coded seed-account fallback.

---

## UC-2: Import a workflow manifest (validate + commit)

**Actor:** tenant admin (current milestone enforces `auth.tenantSlug === req.params.slug`, see `apps/api/src/routes/v1/manifest-import.ts:74-81`).
**Trigger:** "Import workflow manifest" in any of three places — `apps/web/app/portal/[tenant]/(views)/agents/page.tsx:198`, `agents/[id]/page.tsx:190`, `workflows/page.tsx:591`. Also auto-opened after tenant create (UC-1).
**Preconditions:**
- `AGENTIC_MODELS_DIR` set (absolute path) — boot-time fatal in `apps/api/src/routes/v1/workflow.ts:46` for the workflow editor and required by `services/manifest-import.ts` for staging file writes.
- `requireAuth` passes; tenant slug matches.

**Main flow (validate):**
1. User pastes / uploads JSON or hits "Fetch URL" (UC-2a). Wizard step "validate" POSTs to `/v1/tenants/:slug/manifest-import` with `body.mode='validate'` (`apps/api/src/routes/v1/manifest-import.ts:91`).
2. `services/manifest-import.ts#validate` parses + lints + builds diff in-memory; inserts a `deployments(status='pending', expires_at=now+1h)` row whose `id` is the import session token (per `docs/design/import-workflow-manifest.md:18-22`).
3. Response 200 with `ManifestImportPreview` (`packages/contracts/src/workflows.ts:121-146`): `{ parsed, issues, conflicts, diff, prior, deployment_id, elapsed_ms }`.
4. SPA renders diff + conflicts; user advances to "commit" step.
5. POST `/v1/tenants/:slug/manifest-import?confirm=1` with `body.mode='commit'`, `body.deployment_id=<from step 3>`.
6. `services/manifest-import.ts#commit` runs four atomic phases (see CLAUDE.md "Manifest import wizard"):
   - Preflight in-memory revalidate.
   - Write `data/imports/<deployment_id>/workflow.json` + fsync.
   - Synchronous SQLite tx demoting prior live + upserting `workflow_versions`/`deployments`/`agents`/`agent_versions`/`event_listeners` + audit row.
   - `fs.rename()` into `models/<slug>-vN/workflow_v<N+1>.json` + Inngest re-register.
7. Response 200 with `ManifestImportCommit` (`packages/contracts/src/workflows.ts:148-167`): `{ ok: true, workflow_version_id, deployment_id, file_written, inngest_fns_registered, prior_deployment_id, elapsed_ms }`.

**Alt / error flows:**
- **423 `pending_import`** — second concurrent validate while a `deployments(status='pending')` lock is unexpired. Response body is **flat (no envelope)**: `{ ok: false, error: { code, message, hint }, deployment_id, in_flight_session_id }` (`apps/api/src/routes/v1/manifest-import.ts:99-111`). The SPA's `unwrapEnvelope<T>()` helper in `apps/web/app/portal/components/import-manifest/ImportManifestModal.tsx` handles both shapes.
- **409 `requires_confirmation`** — commit without `?confirm=1` (or `confirm_overwrite: true`) and the diff removes agents or modifies thresholds. Response is **flat** `ManifestImportOverwriteRequired` (lines 122-124). SPA's `OverwriteConfirmModal` re-submits with the flag set.
- **400 `blocking_issues`** — `BlockingIssuesError` thrown when validate found `severity='error'` issues. Response includes `{ issues }` so the wizard can highlight paths (lines 125-138).
- **403 `forbidden`** — `auth.tenantSlug !== req.params.slug` (line 76).
- **400 Zod** — `ManifestImportBody.parse` rejects unknown fields, missing `mode`, etc.

**Postconditions on commit success:**
- New `workflow_versions` row + `deployments(status='live')`.
- Prior live `deployments` flipped to `superseded`/`rolled_back`.
- Agents + agent_versions + event_listeners reflect the new manifest.
- `models/<slug>-v<N+1>/workflow_v<N+1>.json` exists on disk.
- `data/imports/<deployment_id>/` may remain (cleaned by `reconcile-imports` on next boot if orphan).
- `audit_log` row with `action='manifest.import.commit'`.
- Inngest functions re-registered live; new events route to new manifest.

**API surface:**
- `POST /v1/tenants/:slug/manifest-import` (modes: `validate`, `commit`).
- `POST /v1/tenants/:slug/manifest-import/fetch-url` (UC-2a).
- `POST /v1/tenants/:slug/manifest-import/fetch-repo` (501 stub).
- `DELETE /v1/tenants/:slug/manifest-import/:deployment_id` — release pending lock.

**Data model touched:** `workflows`, `workflow_versions`, `deployments`, `agents`, `agent_versions`, `event_listeners`, `audit_log`.
**Frontend surface:**
- `apps/web/app/portal/components/import-manifest/ImportManifestModal.tsx:227` (6-step wizard: source → validate → diff → resolve → preview → deploy).
- `apps/web/app/portal/components/import-manifest/ImportPreviewGraph.tsx` (preview graph render).
- `apps/web/app/portal/components/import-manifest/OverwriteConfirm*` (409 re-confirm modal).

**Out of scope:**
- `fetch-repo` (git fetch) — returns 501 with `{ code: "not_implemented" }` (line 295-305).
- Rollback of the import — uses UC-3 (`/v1/deployments/:id/rollback`) instead.

**Status:** implemented.
**Open questions:**
- `data/imports/dpl-*` directories accumulate; `reconcile-imports` cleans them on boot only. Should they be gitignored? CLAUDE.md notes they are currently NOT (root `.gitignore` covers `data/*` at top level, not `apps/api/data/*`).

### UC-2a: Fetch manifest from URL (sub-flow)

**Trigger:** "Fetch URL" tab in the wizard's source step.
**Main flow:** POST `/v1/tenants/:slug/manifest-import/fetch-url` with `{ url }`. SSRF-guarded by `services/ssrf-guard.ts` (https-only except localhost in dev, IP-reject after DNS, re-check on every redirect, max 5 MB body, 5 s timeout).
**Alt / error flows:**
- **400** SSRF policy violation (private IP, http://, redirect to disallowed host). Audit row `action='manifest.import.fetch_url.blocked'` (line 218-229).
- **502 `fetch_failed`** — upstream non-2xx.
- **504** timeout.
- **415** content-type not in allowlist (`application/json`, `text/plain`, `application/octet-stream`).
- **400 `bad_json`** — upstream not JSON.

**Status:** implemented.

---

## UC-3: Roll back a deployment

**Actor:** tenant admin.
**Trigger:** "Roll back" button in `apps/web/app/portal/[tenant]/(views)/deployments/page.tsx`.
**Preconditions:** Target deployment exists in caller's tenant; a live deployment exists.

**Main flow:**
1. Frontend POSTs `/v1/deployments/:id/rollback` via `useRollbackDeployment` (`apps/web/lib/hooks/useDeployments.ts:88-100`).
2. `deploymentsRoutes` handler at `apps/api/src/routes/v1/deployments.ts:20-64` runs `requireAuth`, verifies the target row exists and `tenantId === auth.tenantId`.
3. Single transaction: flip current live → `rolled_back`; flip target id → `live` with fresh `deployed_at`.
4. `writeAudit` with `action='deployment.rollback'`.
5. Response: `{ deployment_id, status: 'live', note: "live pointer flipped. Restart api for runtime to pick up the new manifest." }`.
6. `useRollbackDeployment.onSettled` invalidates `DEPLOYMENT_KEYS.list` so the table re-fetches.

**Alt / error flows:**
- **404 `not_found`** — deployment id doesn't exist (line 30).
- **403 `forbidden`** — target's `tenantId !== auth.tenantId` (line 31-32).
- **401** — `requireAuth` fails.

**Postconditions:**
- Two `deployments` rows touched (old live → rolled_back, target → live).
- `audit_log` row written.
- Runtime change **requires api restart** (Inngest functions are bound at boot via `bootstrapRuntime` in `apps/api/src/server.ts:50`). The response `note` field surfaces this.

**API surface:**
- `GET /v1/deployments` → `{ list, live }` (line 10-17).
- `POST /v1/deployments/:id/rollback`.

**Data model touched:** `deployments`, `audit_log`.
**Frontend surface:** `apps/web/app/portal/[tenant]/(views)/deployments/page.tsx`; `apps/web/lib/hooks/useDeployments.ts:75,88`.

**Out of scope:**
- Hot Inngest swap on rollback (would need `reregisterInngest` call here; currently the manifest-import commit is the only path that hot-swaps).

**Status:** implemented (with the documented "restart for full effect" caveat).
**Open questions:**
- Should rollback chain emit a stream event so the `useStream` cache invalidator picks it up? Currently no `run.*`/`event.*` SSE frame; only the manual `invalidateQueries` in `useRollbackDeployment.onSettled` refreshes the table.

---

## UC-4: Invoke an agent synchronously (code agent)

**Actor:** operator.
**Trigger:** "Test run" button in `apps/web/app/portal/[tenant]/(views)/agents/[id]/page.tsx:263` (Agent detail page); also exposed in `agents/page.tsx`.
**Preconditions:**
- Agent registered with `agentRegistry` (code agent) OR present as manifest agent for the tenant.
- LLM provider key configured (UC-10) when the agent isn't `mock`-provider.

**Main flow:**
1. Frontend calls `useInvokeAgent` (`apps/web/lib/hooks/useAgents.ts:139-171`); POSTs `/v1/agents/:name/invoke?testRun=1` with body `{ input?: unknown, provider?, model? }` (`InvokeAgentBody` schema `packages/contracts/src/llm.ts:34-40`).
2. `agentInvokeRoutes` at `apps/api/src/routes/v1/agent-invoke.ts:42` Zod-parses body, validates `provider` against `PROVIDER_IDS` and `gateway.hasProvider(...)`.
3. **Code agent path:** `agentRegistry.get(agentName)` finds it (line 74). Check `agent.enabled` (line 167). Mint `correlationId` and `invocationId`, call `agent.run(input, { tenantSlug: "__system", correlationId, invocationId, provider, model })` (line 191).
4. `BaseAgent.run` writes the run row + step rows + per-line log file + emits `run.started`/`run.completed`/`run.failed` SSE events through the gateway dispatch.
5. Response 200 envelope: `{ ok: true, data: { runId, status: 'ok' | 'failed', output, provider, model, tokensIn, tokensOut, durationMs } }` (`InvokeAgentResponse`, llm.ts:42-53).

**Alt / error flows:**
- **404 `not_found`** — neither code nor manifest agent matches the name (lines 85-91 plus the manifest fallback).
- **409 `agent_disabled`** — `agent.enabled === false` (line 167-173).
- **400 `bad_request`** — unknown provider id (line 56) or provider not registered with gateway (line 58-65).
- **503 `not_configured`** — `LLMError` with `code='not_configured'` (gateway lacks credentials). Mapped at line 232-233.
- **429 `rate_limit`**, **504 `timeout`**, **400 `model_not_found`**, **502 `provider_error`** — see `mapErrorStatus` (line 221-239).
- **501 `not_implemented`** — `body.async: true` (async path reserved for v2, line 179-188).

**Postconditions:**
- `runs` row + `steps` rows for the invocation.
- `data/logs/<tenantSlug>/runs/<date>/<runId>.log` written.
- `useStream` SSE channel emits `run.started`/`run.step.*`/`run.completed|failed`; `RUN_KEYS.all` and `RUN_KEYS.detail(runId)` invalidated automatically (`apps/web/lib/hooks/useStream.ts:138-150`).
- Token totals fold into `tenant_budgets.used_tokens_month` / `used_usd_month` (gateway-side).

**API surface:** `POST /v1/agents/:name/invoke?testRun=1&async=0`.
**Data model touched:** `runs`, `steps`, plus `agent_memory_short` / `agent_memory_long` if the agent uses memory.
**Frontend surface:**
- `apps/web/app/portal/[tenant]/(views)/agents/[id]/page.tsx:263` — invoke button.
- `apps/web/lib/hooks/useAgents.ts:139` — mutation hook.
- `apps/web/app/portal/[tenant]/(views)/runs/[id]/page.tsx` — opens the resulting run.

**Out of scope:**
- Async dispatch via Inngest (501 in v1).
- Manifest agent dispatch — see UC-4a.

**Status:** implemented (sync path).
**Open questions:** `tenantSlug: "__system"` is hard-coded in the BaseAgent call (line 193) because the code-agent registry doesn't yet accept a tenant. Cross-tenant code-agent runs all attribute to `__system`.

### UC-4a: Invoke a manifest agent (queued via Inngest)

**Trigger:** Same "Test run" button when the named agent is NOT in the code registry.
**Main flow:** Route's manifest fallback (`apps/api/src/routes/v1/agent-invoke.ts:79-164`) looks up the first declared trigger via `findManifestAgentTrigger`, mints a synthetic `eventId` + `correlationId`, and `inngest.send({ name: "<slug>/<triggerEvent>", data: { ...input, subject, __triggerEventId, __correlationId, __invokedAgent }})`. Response is `202 { kind: 'manifest', status: 'queued', eventId, eventName, subject, correlationId }`.
**Alt / error flows:**
- **409 `no_auto_trigger`** — agent has no declared trigger event (line 99-105).
- **409 `agent_disabled`**.
- **500 `internal_error`** — `inngest.send` failed (line 142-148).

**Status:** implemented.

---

## UC-5: Publish (trigger) an event

**Actor:** operator (manual), inngest-internal (step-emitted), webhook-external (UC-13).
**Trigger:** "Publish event" in the Event Tester UI at `apps/web/app/portal/[tenant]/(views)/events/page.tsx`; programmatic via CLI / SDK.

**Preconditions:**
- `requireAuth` passes.
- Optional: an `event_types` catalog row for richer SSE categorization.

**Main flow:**
1. Frontend POSTs `/v1/events` via `useEmitEvent` (`apps/web/lib/hooks/useEvents.ts:80-98`).
2. `eventsRoutes` POST handler at `apps/api/src/routes/v1/events.ts:40-137` Zod-parses `IngestEventBody` (`packages/contracts/src/events.ts:14-21`).
3. `appendToLedger(tenantSlug, {...})` writes `data/logs/<tenant>/events/<date>.ndjson` and returns a `payload_ref` (`file#offset`).
4. Look up `event_types.category` via tenant + name (line 65-75) so the events row carries a non-null `category` for SSE colour-coding.
5. Insert `events` row (id, tenantId, name, category, subject, payloadRef).
6. `inngest.send({ name: "<slug>/<name>", data: { ...payload, subject, __triggerEventId } })`. When `body.test=true`, stamp `__test: true` so downstream runs surface a "TEST RUN" badge.
7. If `body.source !== "external"`, write `audit_log` with `action='event.publish'`, meta containing field **names only** (line 116-133). Source `'external'` keeps the historical webhook path quiet.
8. Response: `{ event_id, name: "<slug>/<name>" }`.

**Alt / error flows:**
- **400** — Zod validation (missing `name`).
- **401** — `requireAuth`.

**Postconditions:**
- `events` row.
- One line appended to `data/logs/<tenant>/events/<date>.ndjson`.
- One Inngest event dispatched.
- `useStream` SSE fires `event.emitted` → `EVENT_KEYS.all` + `COUNT_KEYS.tenant` invalidated.
- Audit row when `source !== 'external'`.

**API surface:**
- `POST /v1/events`.
- `GET /v1/events?name&limit` — list recent (UC-5b).
- `GET /v1/events/catalog` — tenant's event-type catalog (`apps/api/src/routes/v1/events.ts:210-214`).
- `GET /v1/events/recent?causality=1&seed=<id>` — DAG of events triggered by a seed (line 220-240).
- `GET /v1/events/stream?since&names` — SSE tail (line 245-316).

**Data model touched:** `events`, `event_types`, `audit_log`.
**Frontend surface:**
- `apps/web/app/portal/[tenant]/(views)/events/page.tsx` — Event Tester view.
- `apps/web/lib/hooks/useEvents.ts:66,80,103` — list / emit / replay hooks.

**Out of scope:**
- HMAC-verified external webhook intake (UC-13).
- Direct Inngest-internal `step.sendEvent` calls (these bypass `/v1/events` by design — `packages/runtime/src/register.ts` insists they only happen inside `step.run`).

**Status:** implemented.

---

## UC-6: Replay an event (or a run)

**Actor:** operator.
**Trigger:** "Replay" buttons — in `apps/web/app/portal/[tenant]/(views)/events/page.tsx` for events; in `apps/web/app/portal/[tenant]/(views)/runs/[id]/page.tsx:184` for runs.

**Preconditions:** Original event row exists; original payload still readable from the NDJSON ledger (line offset stored in `events.payloadRef`).

**Main flow (event replay):**
1. POST `/v1/events/:id/replay` via `useReplayEvent` (`apps/web/lib/hooks/useEvents.ts:102-113`).
2. `eventsRoutes` replay handler at `apps/api/src/routes/v1/events.ts:140-198`. Verify row exists + tenant match.
3. Read original payload from the NDJSON ledger (line 152-167); use `makeId("evt")` for the new event id so same-ms replays don't collide (line 171).
4. `inngest.send({ name: "<slug>/<original-name>", data: { ...payload, __triggerEventId: newId, __replayOf: origId }})`.
5. Audit row `action='event.replay'`.
6. Response: `{ replayed: <oldId>, new_event_id: <newId> }`.

**Main flow (run replay):**
1. POST `/v1/runs/:id/replay` via `useReplayRun` (`apps/web/lib/hooks/useRuns.ts:131-145`).
2. `runsRoutes` replay handler at `apps/api/src/routes/v1/runs.ts:38-87`. Verify run row, tenant match; load the trigger event row.
3. Read the original payload, `inngest.send` with `__replayOfRun: <oldRunId>` in the data envelope.
4. Response: `{ replayed_run, new_event_id }`.

**Alt / error flows:**
- **404 `not_found`** — event / run missing.
- **403 `forbidden`** — cross-tenant access attempt.
- **400 `no_trigger`** — run was started without a trigger event (synthetic invocation; line 47-48 of runs.ts).
- **410 `gone`** — original event row was hard-deleted (line 55 of runs.ts).

**Postconditions:**
- New `events` row only on event replay (run replay reuses the original `events` row but dispatches a new Inngest event id).
- Audit row on event replay; **no audit on run replay yet** (gap — open question).

**API surface:** `POST /v1/events/:id/replay`, `POST /v1/runs/:id/replay`.
**Data model touched:** `events` (event replay), `audit_log` (event replay only), `runs`/`steps` (downstream — the new run lands via Inngest).
**Frontend surface:** Event Tester view; run detail page button at runs/[id]/page.tsx:184.

**Out of scope:**
- Backfilling a stream of historical events.

**Status:** implemented.
**Open questions:**
- Run-replay path doesn't write an audit row; the only trace is the new event landing in NDJSON.

---

## UC-7: Resolve a HITL (Human-In-The-Loop) task

**Actor:** tenant admin (the assignee role on the task; current milestone allows any auth'd caller in the tenant).
**Trigger:** "Approve" / "Reject" buttons in `apps/web/app/portal/[tenant]/(views)/tasks/page.tsx`.

**Preconditions:**
- Task exists, `status='open'`, `tenant_id === auth.tenantId`.
- A run is `step.waitForEvent("task.resolved", { if: 'async.data.taskId == "<id>"' })` somewhere in the manifest (per `CLAUDE.md` "Inngest durability discipline").

**Main flow:**
1. Frontend uses `useResolveTask` (`apps/web/lib/hooks/useTasks.ts:69-91`) → POST `/v1/tasks/:id/resolve` with body `{ decision: 'approve' | 'reject', payload?: unknown }` (`ResolveTaskBody`, `packages/contracts/src/tasks.ts:21`).
2. `tasksRoutes` handler at `apps/api/src/routes/v1/tasks.ts:27-64` runs `requireAuth`, Zod parses, loads the row.
3. Validate `tenantId` match + `status === 'open'`.
4. `inngest.send({ name: "task.resolved", data: { taskId, tenantId: auth.tenantId, decision, payload } })`. The `tenantId` is required so the waiting agent's predicate can pin to the issuing tenant (line 42-52 — defense against leaked taskIds).
5. `writeAudit` with `action='task.resolve'`.
6. Response: `{ task_id, decision }`.

**Alt / error flows:**
- **404 `not_found`** — task missing.
- **403 `forbidden`** — `row.tenantId !== auth.tenantId`.
- **409 `already_resolved`** — `status !== 'open'`.
- **400** Zod validation — decision not in enum.

**Postconditions:**
- `inngest.send("task.resolved", ...)` — the waiting `step.waitForEvent` resumes; the manifest engine updates `tasks.status` and `runs.status` via its own `step.run` writes.
- `audit_log` row `task.resolve`.
- `useStream` `task.resolved` SSE frame → `TASK_KEYS.all` + `COUNT_KEYS.tenant` invalidated.

**API surface:**
- `GET /v1/tasks` — list (`useTasks`).
- `GET /v1/tasks/:id` — detail.
- `POST /v1/tasks/:id/resolve`.

**Data model touched:** `tasks` (updated by the resuming agent, not the route handler), `audit_log`.
**Frontend surface:**
- `apps/web/app/portal/[tenant]/(views)/tasks/page.tsx`.
- `apps/web/lib/hooks/useTasks.ts:52,60,69`.

**Out of scope:**
- "Snoozed" status — schema supports it (`TaskStatus` enum) but no UI / API surface yet.

**Status:** implemented.

---

## UC-8: View a live run + tail its logs

**Actor:** operator.
**Trigger:** Click a run in `apps/web/app/portal/[tenant]/(views)/runs/page.tsx` → `apps/web/app/portal/[tenant]/(views)/runs/[id]/page.tsx`.

**Preconditions:** Run exists; tenant scope matches OR the run is in `__system` (falls back at `apps/api/src/routes/v1/runs.ts:30-31`).

**Main flow:**
1. Run detail page calls `useRun(id)` → `GET /v1/runs/:id` (`apps/api/src/routes/v1/runs.ts:27-35`). Returns `{ run, steps }` (`GetRunResponse`).
2. Page mounts `useRunLogStream(id, { follow: true })` (`apps/web/lib/hooks/useRunLogStream.ts:45-148`) which opens `EventSource('/v1/runs/:id/logs?follow=1', { withCredentials: true })`.
3. `runsLogsRoute` at `apps/api/src/routes/v1/runs-logs.ts:29-121` writes SSE headers (`text/event-stream; charset=utf-8`, `X-Accel-Buffering: no`), tails the log file at `${AGENTIC_LOGS_DIR}/<tenant>/runs/<date>/<runId>.log` (line 45-51), and uses `fs.watch` to push new lines as `event: log` frames (line 91-103).
4. EventSource listeners on `'log' | 'info' | 'error' | 'end'` push lines into a rolling buffer capped at `maxLines=5000`.
5. Tenant-scoped `useStream()` (separate connection, `/v1/stream`) invalidates `RUN_KEYS.detail(id)` on every `run.step.*` and `run.completed|failed` event so the timeline at the top refreshes alongside the log tail.

**Alt / error flows:**
- **404 `not_found`** — run id doesn't exist in caller tenant or `__system`.
- **`event: info "(log file not yet present)"`** — run started but the writer hasn't flushed the file yet (line 78).
- **Transport drop** — `useRunLogStream` reconnects with `0.5 * 2^attempt` backoff (capped at 15 s); `useStream` does the same (capped at 30 s).
- **403** — `auth` only checks tenant match implicitly via the run row.

**Postconditions:** None (pure read).

**API surface:**
- `GET /v1/runs/:id` → `{ run, steps }`.
- `GET /v1/runs/:id/logs?follow=1` — SSE.
- `GET /v1/stream` — tenant-wide SSE — **route file exists at `apps/api/src/routes/v1/stream.ts:29` but NOT registered in `apps/api/src/server.ts`**. The frontend's `useStream` hook calls `/v1/stream`; the api returns 404. **Status: partial.**

**Data model touched:** `runs`, `steps`.
**Frontend surface:**
- `apps/web/app/portal/[tenant]/(views)/runs/[id]/page.tsx`.
- `apps/web/lib/hooks/useRuns.ts:122` (`useRun`), `apps/web/lib/hooks/useRunLogStream.ts:45`, `apps/web/lib/hooks/useStream.ts:44`.

**Out of scope:**
- Server-rendered run views (the page is `"use client"`).

**Status:** **partial** — run detail + log tail work; the tenant-wide `/v1/stream` cache invalidator is broken until `streamRoutes` is added to `server.ts:55-69`.
**Open questions:** Without `/v1/stream`, cache invalidation falls back to `staleTime` polling on each hook (`useRuns` 2 s, `useEvents` 2 s, `useTasks` 2 s). The UI works but is noticeably less live.

---

## UC-9: Browse the workflow DAG

**Actor:** operator.
**Trigger:** Navigate to `/portal/<slug>/workflows`.

**Preconditions:** Tenant has at least one live `deployments` row (otherwise the DAG is empty).

**Main flow:**
1. Page at `apps/web/app/portal/[tenant]/(views)/workflows/page.tsx:83` calls `useDag()` (`apps/web/lib/hooks/useAgents.ts:130-136`) → `GET /v1/workflows/dag` (`apps/api/src/routes/v1/reads.ts:18-21`).
2. `readsRoutes` calls `getDag(tenantSlug)` (`apps/api/src/queries/workflows.ts`) which:
   - Loads live `workflow_versions.manifestJson`.
   - Reads `agents` + `event_listeners` to derive `triggers[]` and `emits[]` per agent.
   - Counts recent run counts.
   - Returns `{ agents: DagAgent[], edges: DagEdge[], workflowVersion }` (`packages/contracts/src/workflows.ts:5-31`).
3. Page renders the hand-tuned stage/lane layout (the `apps/web/app/portal/components/workflows/inspectors.tsx` Side inspector tracks the selected node/event).

**Alt / error flows:**
- Empty payload — no live deployment → empty arrays → "No live deployment" empty state.
- **401** — `requireAuth`.

**Postconditions:** None.

**API surface:** `GET /v1/workflows/dag`.
**Data model touched:** `agents`, `workflow_versions`, `deployments`, `event_listeners`, `runs` (count).
**Frontend surface:**
- `apps/web/app/portal/[tenant]/(views)/workflows/page.tsx`.
- `apps/web/app/portal/components/workflows/inspectors.tsx`.

**Out of scope:**
- Editing nodes inline — that's UC-14 (workflow editor) / UC-2 (import wizard).

**Status:** implemented.

---

## UC-10: Configure LLM providers and the model fleet

**Actor:** tenant admin (workspace-scope keys require operator role; not gated in current milestone).
**Trigger:** Settings → "Models" section at `apps/web/app/portal/components/settings/sections/Models.tsx`.

**Preconditions:** Settings page accessible.

**Main flow (provider keys):**
1. UI lists masked metadata via `GET /v1/llm/providers/keys` (`apps/api/src/routes/v1/llm.ts:81-83`).
2. Per-provider detail / rotate via `GET /v1/llm/providers/:id/key` (line 85-90) and `POST /v1/llm/providers/:id/key` with `{ apiKey, scope: 'workspace' | 'tenant' }` (line 92-127). On save:
   - `setProviderKey` writes to the vault (`apps/api/src/services/provider-keys.ts`).
   - `resetLLMGateway()` so subsequent invocations pick up the new key.
   - `writeAudit` with `action='llm.key.rotate'`, meta `{ scope, keyMasked }`.
3. "Test connection" via `POST /v1/llm/providers/:id/test` with optional candidate `{ apiKey }` (line 132-156).

**Main flow (model fleet):**
1. `GET /v1/llm/fleet` (line 159-162) → list tenant's configured models.
2. `POST /v1/llm/fleet` with `{ provider, modelName, alias?, role?, dailyCapUsd?, maxOutTokens?, temperature? }` (line 164-207).
3. `PATCH /v1/llm/fleet/:id` (line 209-237).
4. `DELETE /v1/llm/fleet/:id` (line 239-250).
5. Catalog enumeration via `GET /v1/llm/catalog` (line 74-76) for the "Add model" picker — returns `PROVIDER_MODEL_CATALOG` from `@agentic/contracts/providers` (context, prices, capabilities).
6. Provider availability via `GET /v1/llm/providers` (line 47-50).

**Alt / error flows:**
- **400 `bad_request`** — unknown provider id, scope not in `{ workspace, tenant }`, `apiKey` < 8 chars, `FleetValidationError` from `model-fleet.ts`.
- **404 `not_found`** — fleet id missing on PATCH/DELETE.

**Postconditions:**
- Provider-keys persisted (scope `workspace` global, scope `tenant` per-tenant).
- `audit_log` entries `llm.key.rotate`, `llm.fleet.add|update|remove`.
- Gateway reset; next `agent.run` rebuilds clients lazily.

**API surface:** Eight endpoints under `/v1/llm/*` — see above.
**Data model touched:** Model fleet lives in `apps/api/src/services/model-fleet.ts` storage (not yet a SQLite table — sidecar JSON/state file). Provider-keys via `apps/api/src/services/provider-keys.ts`. `audit_log`.
**Frontend surface:**
- `apps/web/app/portal/components/settings/sections/Models.tsx`.
- Note: file does NOT currently call `/v1/llm/*` endpoints — the grep returned only inline constants. **Frontend wiring is partial** (the route handlers exist and the route file is registered in `server.ts:66` as `llmRoutes`, but the UI section reads from a static draft).

**Out of scope:**
- Per-tenant model role budgets (the schema has `tenant_budgets` aggregate caps; per-model caps live in fleet entries).

**Status:** **partial — backend complete, UI wiring incomplete**. Specifically: `apps/web/app/portal/components/settings/sections/Models.tsx` does not (yet) call any `/v1/llm/*` endpoint per `grep -n "fetch\|useQuery\|llm\|provider"`.

---

## UC-11: View / set tenant budget and usage

**Actor:** tenant admin.
**Trigger:** Settings → "Cost & usage" sub-route at `apps/web/app/portal/[tenant]/(views)/settings/usage/page.tsx`.

**Preconditions:** Tenant has at least one historic run for non-empty `byAgent/byModel/byDay` arrays.

**Main flow (read):**
1. Page mounts `useUsage({ since })` and `useBudget()` (`apps/web/lib/hooks/useUsage.ts:86,103`).
2. Calls `GET /v1/usage?since=<ms>` → `{ totals, byAgent, byModel, byDay, budget }` (`apps/api/src/routes/v1/usage.ts:81-156`). Aggregations join `runs` + `agents` and apply the `MODEL_PRICING` stub table.
3. Calls `GET /v1/budgets` → current `tenant_budgets` row (`apps/api/src/routes/v1/budgets.ts:74-78`).

**Main flow (write):**
1. PUT `/v1/budgets` with `{ monthlyTokenCap?, monthlyUsdCap?, reset? }` (`apps/api/src/routes/v1/budgets.ts:80-125`).
2. Optional `reset: true` zeros `used_tokens_month` / `used_usd_month` and sets `period_start = now`.
3. `writeAudit` with `action='budget.update'`, meta containing post-update caps and `reset` flag.

**Alt / error flows:**
- **400** — Zod (negative caps).
- **401** — `requireAuth`.

**Postconditions on PUT:**
- `tenant_budgets` row updated.
- `audit_log` `budget.update`.
- TanStack invalidates `BUDGET_KEYS.current` and `USAGE_KEYS.all`.

**API surface:**
- `GET /v1/usage?since&until&limit`.
- `GET /v1/budgets`.
- `PUT /v1/budgets`.

**Data model touched:** `tenant_budgets`, `runs` (read), `agents` (read), `audit_log`.
**Frontend surface:**
- `apps/web/app/portal/[tenant]/(views)/settings/usage/page.tsx`.
- `apps/web/lib/hooks/useUsage.ts`.

**Out of scope:**
- Real-time over-budget enforcement on `agent.run` — `MODEL_PRICING` is a stub at `apps/api/src/routes/v1/usage.ts:53-63`; the gateway-side budget hook is not wired.

**Status:** **partial — route handlers exist but `usageRoutes` and `budgetsRoutes` are NOT registered in `apps/api/src/server.ts:53-71`**. Frontend hooks return 404; the page renders the "live data unavailable" notice per `useUsage`'s comment block (`apps/web/lib/hooks/useUsage.ts:9-14`). **This is one of the six unregistered routes flagged at the top of this doc.**

---

## UC-12: View the audit log

**Actor:** tenant admin.
**Trigger:** Settings → "Audit" sub-route at `apps/web/app/portal/[tenant]/(views)/settings/audit/page.tsx`, OR Settings page inline section `apps/web/app/portal/components/settings/sections/Audit.tsx:139` (calls `fetch('/v1/audit?limit=100')`).

**Preconditions:** Tenant has at least one audit row.

**Main flow:**
1. UI fetches `GET /v1/audit?since&until&actor&action&limit&cursor` (`apps/api/src/routes/v1/audit.ts:39-100`).
2. Handler filters with `gte`/`lt` on `audit_log.at`, `eq` on `actorUserId` / `action`. Limit clamped [1, 500], default 100.
3. Cursor pagination — `nextCursor` is the `at`-ms of the last row; subsequent calls add `&cursor=<ms>` to apply `lt(audit_log.at, …)`.
4. Response: `{ items: AuditLogRow[], nextCursor, count }`.

**Alt / error flows:**
- **401** — `requireAuth`.
- Empty page when filters match nothing.

**Postconditions:** None (read-only).

**API surface:** `GET /v1/audit`.
**Data model touched:** `audit_log` (read).
**Frontend surface:**
- `apps/web/app/portal/[tenant]/(views)/settings/audit/page.tsx`.
- `apps/web/app/portal/components/settings/sections/Audit.tsx` — inline fetch (not via a TanStack hook).

**Out of scope:**
- Export to CSV.
- Cross-tenant view (platform admin).

**Status:** **partial — `auditRoutes` is NOT registered in `apps/api/src/server.ts:53-71`**. Same root cause as UC-11. The route file exists and is correct; missing one line in server.ts.

---

## UC-13: External webhook intake

**Actor:** webhook-external (Stripe, GitHub, custom integrations).
**Trigger:** External system POSTs to `https://<host>/v1/webhooks/<provider>` with body + HMAC signature header.

**Preconditions:**
- `WEBHOOK_HMAC_SECRET_<PROVIDER>` env var OR `WEBHOOK_HMAC_SECRET_DEFAULT` set.
- `AGENTIC_DEV_TENANT` resolves the receiving tenant (current milestone is single-tenant per webhook; multi-tenant routing is TBD).

**Main flow:**
1. `webhooksRoutes` at `apps/api/src/routes/v1/webhooks.ts:27-75` handler.
2. Pick signature header — tries `x-signature-256`, `x-hub-signature-256`, `stripe-signature`, `x-signature` (line 5-17).
3. Resolve secret: `WEBHOOK_HMAC_SECRET_${UPPER_PROVIDER}` then fall back to `WEBHOOK_HMAC_SECRET_DEFAULT` (line 33-43).
4. HMAC-SHA256 of the raw body; constant-time hex compare (line 19-25, 54).
5. Parse JSON (fall back to raw string if invalid).
6. `inngest.send({ name: "<tenantSlug>/WEBHOOK_<PROVIDER>", data: { provider, payload, receivedAt } })`.
7. Response: `{ provider, event: "WEBHOOK_<PROVIDER>" }`.

**Alt / error flows:**
- **500 `no_secret`** — no HMAC secret configured; hint includes the env-var name to set (line 36-43).
- **401 `no_signature`** — missing signature header (line 50-51).
- **401 `bad_signature`** — HMAC mismatch (line 54-56).

**Postconditions:**
- Inngest event dispatched, indistinguishable from `POST /v1/events` from this point on (no `events` row written; the manifest engine inserts one if any agent triggers on `WEBHOOK_*`).
- **No audit row** — webhook routes are unaudited by design (comment in `events.ts:110-114`).

**API surface:** `POST /v1/webhooks/:provider`.
**Data model touched:** none directly; downstream `runs` / `events` rows via the manifest agents.
**Frontend surface:** none — this is an external-API surface. (Webhook configuration UI is planned but not present.)

**Out of scope:**
- Multi-tenant routing — currently single tenant via `AGENTIC_DEV_TENANT`.
- Subscription management UI — `webhook_subscriptions` table exists in the schema (`packages/db/src/schema.ts:533`) but no CRUD route uses it.

**Status:** implemented (single-tenant, HMAC-verified intake).
**Open questions:** Tenant routing — should the URL be `/v1/tenants/:slug/webhooks/:provider`? Currently the path is global and the slug is inferred from env.

---

## UC-14: Tenant-wide live updates (SSE)

**Actor:** operator (any open browser tab).
**Trigger:** Mount of the portal shell at `apps/web/app/portal/[tenant]/layout.tsx` (or wherever `useStream()` is first called).

**Preconditions:** Auth context resolved.

**Main flow:**
1. `useStream()` (`apps/web/lib/hooks/useStream.ts:44-94`) opens `EventSource('/v1/stream', { withCredentials: true })`.
2. `streamRoutes` at `apps/api/src/routes/v1/stream.ts:29-97` hijacks the reply, writes SSE headers, subscribes to the in-process `subscribeStreamEvents(auth.tenantId, …)` (from `@agentic/runtime`).
3. For each event: `RunStreamEvent.safeParse` on the client; dispatch into `queryClient.invalidateQueries` keyed by event type (lines 133-163):
   - `run.started|completed|failed` → `RUN_KEYS.all` + `COUNT_KEYS.tenant` + `RUN_KEYS.detail(runId)`.
   - `run.step.started|completed` → `RUN_KEYS.detail(runId)` + `RUN_KEYS.all`.
   - `event.emitted` → `EVENT_KEYS.all` + `COUNT_KEYS.tenant`.
   - `task.created|resolved` → `TASK_KEYS.all` + `COUNT_KEYS.tenant`.
4. 15 s keepalive comment frames (line 27, 72-79) defeat idle proxies.

**Alt / error flows:**
- **Auto-reconnect** with exponential backoff (default true, capped at 30 s; line 42).
- **401** — `requireAuth` fails before stream opens.
- **Backpressure:** v1 logs + ignores `res.write` returns of false (per stream.ts:16-21).

**Postconditions:** None.

**API surface:** `GET /v1/stream` — SSE.
**Data model touched:** None (reads run/step/event tables transitively via the invalidated query keys).
**Frontend surface:** `apps/web/lib/hooks/useStream.ts:44`; mounted once at the portal root.

**Out of scope:**
- Cross-tenant streams (no `?tenant=` override, by design).
- Persistent message queue with high-water-mark drops (Phase 4 swap).

**Status:** **partial — `streamRoutes` is NOT registered in `apps/api/src/server.ts:53-71`**. Same root cause as UC-11/UC-12. **This is the third of the six unregistered routes and the most user-visible — the UI works but stale data lingers until `staleTime` expires.**

### UC-14a: Save a workflow manifest from the editor (legacy)

**Actor:** tenant admin.
**Trigger:** "Save" / "Save as new version" in `apps/web/app/portal/[tenant]/(views)/workflows/page.tsx:87` via `useDeployManifest` (`apps/web/lib/hooks/useManifest.ts:71-76`).
**Preconditions:** Editor has a Zod-valid manifest in memory.
**Main flow:**
1. POST `/v1/agents` — `agentsRoutes` legacy manifest upload at `apps/api/src/routes/v1/agents.ts:97-269`.
2. Hashes manifest, finds-or-creates `workflows` + `workflow_versions` row (with `version` stringified `upload-<8hex>`).
3. Computes diff vs current live; writes `agents` + `agent_versions` + `event_listeners` rows.
4. Single tx: flip prior live → `rolled_back`, insert new `deployments(status='live', target='workflow')`.
5. `writeAudit` with `action='manifest.deploy'`.
6. Response: `{ workflow_version_id, version, diff, note }`. **Note:** "Server restart picks up the new manifest in Inngest runtime" — this legacy path does NOT hot-swap.

**Alt path (modern):** `PUT /v1/tenants/:slug/workflow` (`apps/api/src/routes/v1/workflow.ts:227-343`) writes `models/<slug>-vN/workflow_v<N+1>.json` directly and DOES call `reregisterInngest`. **Route is NOT registered in `server.ts:53-71`**. The frontend's editor save button uses the legacy `POST /v1/agents` path, which means the proper hot-swap + on-disk versioning path is currently bypassed.

**Status:** **partial — legacy `POST /v1/agents` works (registered); modern `PUT /v1/tenants/:slug/workflow` doesn't (unregistered)**. The wizard at UC-2 is the only path that exercises the modern persistence behavior end-to-end.

---

## UC-15: Deploy tenant-specific code package

**Actor:** tenant admin (typically via CLI `agentic deploy <path>`).
**Trigger:** CLI command, or programmatic POST.

**Preconditions:**
- Tenant slug exists.
- `data/tenants/<slug>/<version>/` does NOT exist (refuses to overwrite).
- Tarball contains a root `agentic.json`.

**Main flow:**
1. POST `/v1/tenants/:slug/code` (`apps/api/src/routes/v1/tenant-code.ts:74-303`) with `{ version, tarballBase64, note? }`.
2. Verify `auth.tenantSlug === slug` (403 mismatch).
3. Base64-decode → optional gunzip → minimal POSIX-tar parser (`parseTarball`, line 353-396) — no external `tar` dep.
4. Extract to `data/tenants/<slug>/.tmp-<version>-<rand>/` (line 142-160).
5. Validate `agentic.json` exists at root (line 153-159).
6. `fs.rename(tmpDir → finalDir)` — atomic on same FS.
7. DB tx: find-or-create `workflows(slug='__tenant_code__')`, insert `workflow_versions(version=parsed.version, manifest='{ kind: "tenant_code", slug, version }')`, flip prior live → rolled_back, insert new `deployments(target='tenant_code', status='live')`.
8. `reregisterInngest({ tenantSlug })` — hot-swap.
9. `writeAudit` `action='tenant.code.upload'`, meta with `file_count` + `inngest_fns`.
10. Response 201: `{ deployment_id, slug, version, dir, inngest_fns, note }`.

**Alt / error flows:**
- **403 `forbidden`** — cross-tenant upload.
- **404 `slug_unknown`** — no tenant row.
- **409 `version_exists`** — `finalDir` already on disk.
- **400 `tarball_invalid`** — base64 decode fails / gunzip fails / no `agentic.json` / unsafe path (line 405-410 path traversal guard).

**Postconditions:**
- `data/tenants/<slug>/<version>/` directory.
- Two `deployments` rows touched, new `workflow_versions` + `workflows` row.
- `audit_log` row.
- Inngest functions re-bound to new code.

**API surface:** `POST /v1/tenants/:slug/code`.
**Data model touched:** `workflows`, `workflow_versions`, `deployments`, `audit_log`.
**Frontend surface:** None in the portal — CLI-only today. (`apps/cli/src/deploy.ts` is the documented driver.)

**Out of scope:**
- Multi-version rollback specifically for code (uses UC-3 `/v1/deployments/:id/rollback`).
- ZIP archives — tar only.

**Status:** **partial — `tenantCodeRoutes` is NOT registered in `apps/api/src/server.ts:53-71`**. The fourth of the six unregistered routes. CLI `agentic deploy` currently fails against this api build with 404 until the line is added.

---

## UC-16: Read artifacts (file download)

**Actor:** operator.
**Trigger:** Run detail page link to an artifact, or programmatic GET.

**Preconditions:** Artifact row exists; file still on disk.

**Main flow:**
1. `GET /v1/artifacts/:id` (`apps/api/src/routes/v1/artifacts.ts:9-29`).
2. Verify tenant match (line 17-18), `stat` the file (line 21).
3. Stream the file with `Content-Type` from `row.kind ?? 'application/octet-stream'` and `Content-Length` from `row.size`.

**Alt / error flows:**
- **404 `not_found`** — artifact id missing.
- **403 `forbidden`** — `row.tenantId !== auth.tenantId`.
- **410 `gone`** — row exists but file missing on disk.

**Postconditions:** None.

**API surface:** `GET /v1/artifacts/:id`.
**Data model touched:** `artifacts` (read).
**Frontend surface:** None registered — `apps/web/lib/hooks/useArtifacts*.ts` does not exist. The file-download links surface as bare anchor tags inside run detail / agent detail pages (search for `/v1/artifacts/` in `apps/web/app/portal/` came back empty in the grep above; the route exists but is currently unused by the App Router UI).

**Status:** **partial — backend complete, no frontend usage yet**.

---

## Coverage matrix — UC → tables → endpoints → frontend

| UC | Title | API | Tables | UI | Status |
|---|---|---|---|---|---|
| UC-1 | Create tenant | `POST /v1/tenants`, `GET /v1/tenants`, `GET /v1/tenants/:slug`, `PUT /v1/tenants/:slug`, `DELETE /v1/tenants/:slug`, `POST /v1/tenants/:slug/restore` | tenants, tenant_budgets, memberships, event_types, entity_types, workflows, workflow_versions, api_tokens, audit_log | TenantCreateModal | implemented |
| UC-2 | Import workflow manifest | `POST /v1/tenants/:slug/manifest-import` (validate, commit), `POST /.../fetch-url`, `DELETE /.../:dpl-id` | workflows, workflow_versions, deployments, agents, agent_versions, event_listeners, audit_log | ImportManifestModal | implemented |
| UC-3 | Roll back deployment | `GET /v1/deployments`, `POST /v1/deployments/:id/rollback` | deployments, audit_log | deployments/page.tsx | implemented |
| UC-4 | Invoke code agent | `POST /v1/agents/:name/invoke` (sync) | runs, steps, agent_memory_* | agents/[id]/page.tsx | implemented |
| UC-4a | Invoke manifest agent | same route (Inngest fallback path) | events (via Inngest), runs/steps (downstream) | agents pages | implemented |
| UC-5 | Publish event | `POST /v1/events`, `GET /v1/events*` | events, event_types, audit_log | events/page.tsx | implemented |
| UC-6 | Replay event / run | `POST /v1/events/:id/replay`, `POST /v1/runs/:id/replay` | events, audit_log | event tester, runs/[id] | implemented |
| UC-7 | Resolve HITL task | `GET /v1/tasks*`, `POST /v1/tasks/:id/resolve` | tasks, audit_log | tasks/page.tsx | implemented |
| UC-8 | View run + tail logs | `GET /v1/runs/:id`, `GET /v1/runs/:id/logs?follow=1`, `GET /v1/stream` | runs, steps | runs/[id]/page.tsx | partial (stream unregistered) |
| UC-9 | Browse workflow DAG | `GET /v1/workflows/dag` | agents, workflow_versions, deployments, event_listeners, runs | workflows/page.tsx | implemented |
| UC-10 | LLM providers / fleet | `GET/POST /v1/llm/providers*`, `GET/POST/PATCH/DELETE /v1/llm/fleet*`, `GET /v1/llm/catalog`, `GET /v1/llm/models` | provider-keys vault, model-fleet sidecar, audit_log | Settings → Models | partial (UI wiring incomplete) |
| UC-11 | Budget + usage | `GET /v1/usage`, `GET/PUT /v1/budgets` | tenant_budgets, runs, audit_log | settings/usage/page.tsx | partial (routes unregistered) |
| UC-12 | Audit log | `GET /v1/audit` | audit_log | settings/audit/page.tsx | partial (route unregistered) |
| UC-13 | Webhook intake | `POST /v1/webhooks/:provider` | none direct | (external) | implemented |
| UC-14 | Tenant live stream | `GET /v1/stream` | none direct | useStream() | partial (route unregistered) |
| UC-14a | Save workflow (editor) | `POST /v1/agents` (legacy) OR `PUT /v1/tenants/:slug/workflow` (modern) | workflows, workflow_versions, deployments, agents, agent_versions, event_listeners, audit_log | workflows editor | partial (modern path unregistered; legacy used) |
| UC-15 | Deploy tenant code | `POST /v1/tenants/:slug/code` | workflows, workflow_versions, deployments, audit_log | (CLI only) | partial (route unregistered) |
| UC-16 | Read artifact | `GET /v1/artifacts/:id` | artifacts | (no UI hook) | partial (no UI usage) |

**Implemented:** 9 (UC-1, UC-2, UC-3, UC-4, UC-4a, UC-5, UC-6, UC-7, UC-9, UC-13). Counting UC-4a separately: 10.
**Partial:** 7 (UC-8 stream gap, UC-10 UI gap, UC-11 route unregistered, UC-12 route unregistered, UC-14 route unregistered, UC-14a half-modern half-legacy, UC-15 route unregistered, UC-16 no UI). Counting UC-14a separately: 8.
**Planned:** 0 — every UC has at least a backend route file and at least one frontend caller.

## Single biggest production-readiness gap

**Six route files are not registered in `apps/api/src/server.ts:53-71`:**

```
auditRoutes        → apps/api/src/routes/v1/audit.ts
budgetsRoutes      → apps/api/src/routes/v1/budgets.ts
usageRoutes        → apps/api/src/routes/v1/usage.ts
workflowRoutes     → apps/api/src/routes/v1/workflow.ts
tenantCodeRoutes   → apps/api/src/routes/v1/tenant-code.ts
streamRoutes       → apps/api/src/routes/v1/stream.ts
```

All six handlers exist, are imported by `apps/web/lib/hooks/*`, and have test coverage in `apps/api/coverage/lcov.info`. They simply aren't wired into the v1 register block alongside `tenantsRoutes` and friends. **This breaks (at runtime, with 404) UC-8 partially, UC-11, UC-12, UC-14, UC-14a-modern, UC-15.**

Recommended action for Phase 3 triage (or even Phase 2 if Test Engineer hits it first): add six `await v1.register(...)` lines between line 68 and line 69 of `apps/api/src/server.ts`. No other code change required.

## Cross-cutting concerns (for the other Phase 1 docs)

- **Tenant scoping.** Every UC except UC-13 (webhook) and UC-16 (read-only with explicit tenant check) routes through `requireAuth` and either implicitly trusts the row's `tenant_id` (most reads) or explicitly enforces `auth.tenantId === row.tenantId` (every write).
- **Envelope shape.** Successful `reply.ok(data)` wraps as `{ ok: true, data: ... }` via `apps/api/src/plugins/error.ts`. **Three error shapes break this convention** — see UC-2's 423/409 (flat) and `apps/web/app/portal/components/import-manifest/ImportManifestModal.tsx`'s `unwrapEnvelope<T>()` helper.
- **Audit coverage.** UC-1, UC-2 (commit), UC-3, UC-5 (non-external), UC-6 (event), UC-7, UC-10 (keys + fleet), UC-11 (budget), UC-14a, UC-15 all write `audit_log` rows. **Gaps:** UC-6 run-replay, UC-13 webhook intake (intentional), UC-16 artifact reads. Log audit at the Test-Architect's discretion.
- **SSE channels.** Three SSE endpoints: `/v1/runs/:id/logs` (UC-8), `/v1/events/stream` (UC-5), `/v1/stream` (UC-14). All use `text/event-stream`, `X-Accel-Buffering: no`, 15 s keepalive, exponential-backoff reconnect on the client.
- **Idempotency.** Only UC-1 has explicit `Idempotency-Key` support today. UC-2 deduplicates by virtue of the `deployments(status='pending')` lock row; everything else expects the caller to retry-safely.
