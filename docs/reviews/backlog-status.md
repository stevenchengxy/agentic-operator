# Product Backlog — Completion Status

> **Snapshot date:** 2026-05-23 (post Sprint 4 + Dashboard hotfix)
> **Source artefacts:** `docs/WAVE_4_PUNCH_LIST.md`, `docs/V1_SHIP_VERDICT.md`, `docs/team-execution/00-master-plan.md` (Sprints 1-4), `docs/USE_CASES.md` (V1.1 catalog), `docs/audits/*`

Status legend: ✅ shipped · 🟡 partial / in-flight · ⏳ deferred to next milestone · ❌ not started

---

## 1. V1 Ship-Gate (CPA-mandated P0 blockers)

All five blockers landed before Wave 5. Per `V1_SHIP_VERDICT.md` the verdict is **SHIP-WITH-CAVEATS** 🟢.

| ID | Title | Status | Evidence |
|---|---|---|---|
| UC-V11-18 / UC-V11-28 | `POST /v1/agents` 500 on tenants with live `tenant_code` deployment | ✅ | Wave 4 backend Fix 2 — version-segment baked into dynamic import path |
| UC-V11-19 | `agentic init` writes wrong `actions_v1.json` shape | ✅ | Wave 4 backend Fix 1 — emits array per `ActionsManifestSchema` |
| UC-V11-25 / AR-GAP-13 | Require tenant `definePrompt` for every `logic` action (refuse boot otherwise) | ✅ | Wave 4 backend Fix 4 — `findMissingTenantPrompts` boot validator in `packages/runtime/src/register.ts` |
| UC-V11-29 | Cookie auth on Fastify in prod (`AUTH_SESSION_SECRET`, `jose` HS256) | ✅ | Wave 4 backend Fix 3, hardened in dashboard hotfix; `apps/api/src/plugins/auth.ts:143-189` |
| UC-V11-32 | `idempotency_keys` table + check | ✅ | Wave 4 Fix 5 + Sprint 3 migration `0014_idempotency_keys.sql` registered in journal |

---

## 2. Sprint 1-4 cumulative outcomes

`docs/team-execution/00-master-plan.md` records four orchestrated hardening sprints. Cumulative arc:

| Metric | Sprint 1 end | Sprint 2 end | Sprint 3 end | Sprint 4 end (current) |
|---|---|---|---|---|
| api vitest pass | 286/348 (82.2%) | 307/365 (84.1%) | 345/367 (94.0%) | **366/367 (99.7%)** |
| api typecheck errors | — | 0 | 0 | **0** |
| web typecheck errors | — | 1 (pre-existing) | 0 | **0** |
| web vitest | — | 82/82 | 82/82 | **82/82** |
| Smoke endpoints alive | — | 8/11 | 11/11 | **11/11** |
| `x-request-id` propagation | — | regressed | restored | **held** |
| Stash incidents | — | 1 | 0 | **0** |
| DoD criteria PASS | NO | NO | NO (-1% short) | **YES (8/8)** |

**Net 4-sprint lift:** +80 passing api tests, +17.5 percentage points, with 5% wider admitted-test base. From "0/8 DoD" at Sprint 2 end to "8/8 DoD" at Sprint 4 end.

---

## 3. Wave 4 Backend Lane (§ 2 of `WAVE_4_PUNCH_LIST.md`)

Seven high-priority items from the AR-GAP/PF-GAP tech designs + Test Architect findings.

| UC | Title | Status | Notes |
|---|---|---|---|
| UC-V11-21 | Hydrate `runs.emittedEvent` with `{id, name, subject}` join | ✅ | `queries/runs.ts:listRecentRuns` does the LEFT JOIN |
| UC-V11-22 | Bump `runs_total` from manifest engine finalize step | ✅ | Sprint 4 wired `setRuntimeMetrics(metrics)` in `apps/api/src/bootstrap.ts:81`; `register.ts` finalize calls counter |
| UC-V11-23 / AR-GAP-09 | Wire `agent.tool_use` → tenant tool name in `runAction` | 🟡 | partially done in `step-engine.ts:162-172`; tenant-specific tool lookup still TODO |
| UC-V11-24 / AR-GAP-12 | Per-agent `defaultProviders: ProviderId[]` on `BaseAgent` | ⏳ | not landed; tracked for V1.1 |
| UC-V11-27 / AR-GAP-18 | Remove `WEBHOOK_HMAC_SECRET_DEFAULT` fallback; require per-subscription secret | 🟡 | `webhook_subscriptions` table + lookup landed (Sprint 3); env-default fallback still present |
| UC-V11-35 / PF-GAP-15 | Move `failRun` inside `step.run("finalize", …)` to close race | ⏳ | not yet relocated; race window described in master plan |
| Test Arch new | Cross-tenant bearer IDOR test harness (`auth-swap.ts`) | 🟡 | tc-74 (tenant header override) and tc-62 (tenants isolation) cover most; dedicated swap-harness still scoped |

---

## 4. Wave 4 Frontend Lane (§ 3 of `WAVE_4_PUNCH_LIST.md`)

Note: this backlog audit is backend-focused. The frontend lane outcomes are tracked in `docs/team-execution/02-ui-audit.md` and the Sprint 1 FE+UI agent log. Summary:

| Group | Status |
|---|---|
| FE P0 punch items (4) — global.css cleanup, DAG a11y, "operator" sub-line, mock-data leftovers | ✅ shipped per FE+UI agent log (16 file edits) |
| V1.1 UX UCs with quick wins (UC-V11-17, -15, -13, -04, -06, -09, -10) | ⏳ deferred to V1.1 |
| Density token consumption (P2-FE-20) | ⏳ deferred — `--density-mult` still declared but unused by 77 padding literals |

---

## 5. Wave 4 Cleanup Lane (§ 4)

| Task | Status |
|---|---|
| Delete `apps/web/app/_portal_legacy/` | ✅ removed (CLAUDE.md confirms) |
| Gitignore `apps/api/data/imports/` | ✅ added |
| Decide `models/RAAS-v1/workflow_v2.json` / `workflow_v3.json` | ✅ removed as unreferenced three-agent fragments; paired dead `actions-v2.json` / `actions-v3.json` removed (deployment references audited 2026-07-13) |
| Update `docs/USE_CASES.md` (flip UC-V11-33, renumber UC-V11-38, add 13 persona journeys UC-V11-49..61) | ✅ — 128 UCs catalogued in current `USE_CASES.md` (5.7k words) |
| Update `docs/PRODUCT_CATALOG.md` cross-ref matrix | ✅ — 3.1k-word catalog in repo |

---

## 6. V1.0.1 hotfix candidates (open)

From `V1_SHIP_VERDICT.md` § "V1.0.1 punch list":

| # | Title | Status | ETA |
|---|---|---|---|
| 1 | tc-24 — testRun flag plumbing through `agent-invoke.ts` → manifest emit payload → SSE → `runs.is_test` | ✅ shipped in Sprint 4 (366/367) — remaining failure is unrelated `manifest-import-commit` test asserting against the old `events` table (test bug, not code bug; `manifest-import.ts:1359-1380` documents the audit_log migration) | done — V1.0.1 will close the test fixture |
| 2 | tc-27 — restore `target` field in tenant-code rollback response shape | ✅ shipped Sprint 4 — `deployments.ts` scoped demotion to same `target`, response now includes `target` | done |
| 3 | tc-5 — fix deployment audit reuse test isolation | ✅ shipped Sprint 4 — same fix as #2 |
| 4 | Layer 5-7 — finish Playwright e2e + visual diff + `pnpm build` sweep (deferred from Wave 5) | ⏳ pending | V1.0.1 |
| 5 | Top-10 new tests from Test Architect strategy § 5.3 | 🟡 5-of-10 written: cross-tenant header (tc-74), cookie-auth-prod (covered by tc-6/63), idempotency-keys (tc-71), RAAS stage walk (partial via e2e-01), agent-500-tenant-code (covered by tc-27); 5 remain | V1.0.1 |

---

## 7. V1.1 backlog (deferred to next sprint)

From `WAVE_4_PUNCH_LIST.md` § 6 + `USE_CASES.md` § 2. 57 UCs catalogued; the most-prioritised by impact:

### 7.1 Wu Hao end-user notification flows
- UC-V11-01 — notification inbox shell
- UC-V11-02 — webhook → notification fan-out
- UC-V11-16 — notification dispatcher cron + retry

Effort: half-day per UC. Blocked on a notification dispatcher service that doesn't yet exist.

### 7.2 Operator UX refinements
- UC-V11-03 — run-compare side-by-side splitter (UX experiment risk)
- UC-V11-04 — Cmd-K "Emit event" command palette
- UC-V11-05 — live token preview (needs `tiktoken` wiring)
- UC-V11-06 — hot-reload toast on `deployment.created` SSE
- UC-V11-07 — bulk replay (touches SSE multiplexer)
- UC-V11-08 — SSE pause-and-resume
- UC-V11-09 — sidebar health drilldown panel
- UC-V11-10 — per-tenant rate-limit field in Settings → Billing
- UC-V11-12 — provider errors card
- UC-V11-13 — persist edit-mode draft to localStorage
- UC-V11-14 — manifest dry-run wiring
- UC-V11-15 — confirm before tenant-switch with unsaved draft
- UC-V11-17 — fix `/v1/usage` envelope unwrap in `useUsage` hook
- UC-V11-20 — remove "operator" row in Tasks view (covered by FE-P0-3)

### 7.3 Promoted to V2 per CPA
- UC-V11-11 — full ancestor trace tree
- UC-V11-34 — OpenTelemetry
- UC-V11-36 — DLQ for permanent Inngest failures

### 7.4 Infrastructure / dep-bumps
- UC-V11-26 / AR-GAP-16 — Bedrock + Vertex real adapters (pulls MBs of SDK deps)
- UC-V11-37 — `steps_run_ord_idx` unique promotion (data-migration risk)
- UC-V11-39 — audit emission audit (verify every mutation writes audit)
- UC-V11-40..48 — PD+PM additions (UX polish on existing flows)
- UC-V11-49..61 — CPA missing journeys (mostly persona-driven flows)

---

## 8. Long-term / V2 deferred

These were called out in the backend audit (`02-backend-implementation-review.md`) and are not on the V1.1 plan:

| Concern | Source |
|---|---|
| `@fastify/rate-limit` per-IP and per-token | §9.2 of backend audit |
| OpenTelemetry instrumentation | §8.5 of backend audit |
| `@fastify/helmet` extended CSP | §9.7 of backend audit |
| Multi-instance API scaling (Postgres + shared queue, or sticky routing) | §14 of new backend review |
| Compiled production build target (tsc-emit or esbuild bundle) | §13 of new backend review |
| Dockerfile + container hardening + `pnpm db:migrate` ordering | §14 of new backend review |
| Webhook subscription CRUD UI | UC-13 in `01-use-cases.md` |
| `webhook_subscriptions` cross-process replay cache (Redis or similar) | §11.8 of new backend review |
| Run-replay audit row | UC-6 open question |
| `audit_log` cursor-pagination CSV export | UC-12 open question |
| Token revocation endpoint `POST /v1/api-tokens/:id/revoke` | TC-100 manual UAT |

---

## 9. Headline: what's done vs. what's left

### Done (V1 ship)
- Architecture: 19/19 routes wired, contracts aligned, auth hardened (cookie + bearer + dev guard), SSRF + HMAC + idempotency, graceful shutdown, Prometheus `/metrics`, `x-request-id` propagation, audit log read+write, full HealthReport.
- Functional: tenant CRUD, manifest import wizard (6-step UI + 4-phase atomic commit), agent invoke (sync + Inngest fallback), HITL tasks, run/event/task SSE, workflow editor (modern + legacy paths), tenant code upload, webhook intake, LLM gateway with 14 providers, model fleet, budgets.
- Test posture: 366/367 api vitest (99.7%), 82/82 web vitest, 0 typecheck errors, 11/11 smoke endpoints.

### Open (V1.0.1)
- `manifest-import-commit` test asserts stale `events` table (test bug; 15-min fix).
- Playwright e2e + visual diff + `pnpm build` Wave-5 layers (deferred at sprint end).
- 5 of the Wave 5 top-10 new tests still unwritten.

### Open (V1.1)
- Notification dispatcher (UC-V11-01/02/16).
- 14 V1.1 UX UCs prioritised; all backlog'd.
- Per-tenant rate-limit field (UC-V11-10).
- Run-compare splitter (UC-V11-03).

### Open (V2)
- OpenTelemetry, DLQ, full ancestor trace tree, multi-instance scaling, Bedrock + Vertex real adapters, Dockerfile + container hardening.

---

## 10. Recommended next-sprint focus (priority order)

1. **Close V1.0.1 hotfix list** — three test fixes + finish Wave 5 layers 5-7 + write remaining 5 top-10 tests. Estimated 1-3 dev-days.
2. **Land UC-V11-27** (remove `WEBHOOK_HMAC_SECRET_DEFAULT` fallback) + **UC-V11-35** (move `failRun` inside `step.run`) + **UC-V11-24** (per-agent `defaultProviders`). These three high-priority backend items are small, well-scoped, and remove documented gaps. Combined ~1.5 dev-days.
3. **Notification dispatcher prototype** (UC-V11-01/02/16). This is the unblocker for several V1.1 UX UCs and the only V1.1 item that needs a brand-new service. Estimated 2-3 dev-days for the dispatcher + 1-2 dev-days for the inbox UI.
4. **Dockerfile + `pnpm db:migrate` ordering + tini signal handler**. Smallest deployment-readiness gap; unlocks staging promotion. Estimated 1 dev-day.
5. **`@fastify/rate-limit` (per-IP + per-token)** with per-tenant fields exposed in Settings → Billing (UC-V11-10 combined). Estimated 1-2 dev-days.

After the above (~7-10 dev-days total): V1 has full deployment story, V1.1 notification track unblocked, audit/observability fully closed.
