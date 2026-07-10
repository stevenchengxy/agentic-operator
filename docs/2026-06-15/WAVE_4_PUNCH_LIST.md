# Wave 4 Punch List — V1 Ship Gate

**Composed by:** Chief Software Engineer (orchestrator) after Wave 3 consolidation
**Date:** 2026-05-21
**Inputs:** 4 Wave 3 reviews + 7 tech designs + verified file system

This punch list is the contract for Wave 4 engineers. Three parallel lanes (Cleanup / Backend / Frontend) plus Wave 5 test sweep.

---

## 0. Wave 3 verified corrections (catalogs are stale in places)

CPA review caught these stale claims. Verified via `grep`:
- `apps/api/src/server.ts:20` imports `usageRoutes`
- `apps/api/src/server.ts:28,29,30` import `streamRoutes`, `tenantCodeRoutes`, `workflowRoutes`
- `apps/api/src/server.ts:105,112,114` register them

**Catalog corrections required (Cleanup engineer):**

| ID | Current claim | Reality | Fix |
|---|---|---|---|
| PF-GAP-01 | `/v1/usage` not wired in server.ts | Wired at server.ts:105 | Flip to ✅; remaining gap is `useUsage` envelope unwrap → renumber AR-GAP-01 only |
| PF-GAP-11 | `/v1/stream`, `/v1/tenant-code`, `/v1/workflow` not registered | All registered at server.ts:112,113,114 | Flip to ✅; delete the gap |
| UC-V11-33 | "Register route modules in server.ts" | Already registered | Flip 🟡 → ✅ |
| UC-V11-38 (route half) | Combined PF-GAP-01 + AR-GAP-01 | Route shipped; only frontend hook is broken | Renumber: UC-V11-38 = AR-GAP-01 only |

---

## 1. CRITICAL V1-blockers (must land before V1 ship)

Per CPA verdict: V1 is CONDITIONAL on these four shipping. If any slip, V1 cannot go to a paying customer.

| Priority | UC | Title | Owner | Effort | Files |
|---|---|---|---|---|---|
| P0 | UC-V11-29 | Cookie auth on Fastify in prod | Backend | 2h | `apps/api/src/plugins/auth.ts:33`, reuse `AUTH_SESSION_SECRET` |
| P0 | UC-V11-18 / UC-V11-28 | `POST /v1/agents` 500 on tenants with live `tenant_code` deployment | Backend | 3h | `apps/api/src/routes/v1/agents.ts:97` — bake version segment into dynamic import path |
| P0 | UC-V11-19 | `agentic init` writes wrong `actions_v1.json` shape | Backend | 1h | `apps/cli/src/commands/init.ts` — emit array per `ActionsManifestSchema` |
| P0 | UC-V11-25 / AR-GAP-13 | Require tenant `definePrompt` for every `logic` action (or refuse-to-boot with clear error) | Backend | 4h | `packages/runtime/src/step-engine.ts:178-186`, `packages/runtime/src/register.ts` boot validation |

**Also elevated to P0 by Test Architect:**
| P0 | UC-V11-32 | Implement `idempotency_keys` table + check (today's `Idempotency-Key` header is a stub, `tc-71` tests a non-existent contract) | Backend | 4h | `packages/db/src/schema.ts` + new migration `0014_idempotency_keys.sql` + `apps/api/src/routes/v1/{events,agent-invoke}.ts` |

---

## 2. HIGH-PRIORITY backend fixes (Wave 4 backend lane)

From AR-GAP / PF-GAP tech designs + Test Architect IDOR finding:

| UC | Title | File:line | Effort |
|---|---|---|---|
| UC-V11-21 | Hydrate `runs.emittedEvent` with `{id, name, subject}` join | `apps/api/src/queries/runs.ts` LEFT JOIN | 1h |
| UC-V11-22 | Bump `runs_total` from manifest engine finalize step | `packages/runtime/src/register.ts` + `setRuntimeMetrics()` mirror of `setRuntimeGateway` | 2h |
| UC-V11-23 / AR-GAP-09 | Wire `agent.tool_use` → tenant tool name in `runAction` | `packages/runtime/src/step-engine.ts:162-172` | 2h |
| UC-V11-24 / AR-GAP-12 | Per-agent `defaultProviders: ProviderId[]` on `BaseAgent` | `packages/agent-runtime/src/base-agent.ts` | 2h |
| UC-V11-27 / AR-GAP-18 | Remove `WEBHOOK_HMAC_SECRET_DEFAULT` fallback; require per-subscription secret | `apps/api/src/routes/v1/webhooks.ts` + UI error in Settings → Integrations | 2h |
| UC-V11-35 / PF-GAP-15 | Move `failRun` inside `step.run("finalize", ...)` to close race | `packages/runtime/src/register.ts` | 1h |
| (Test Arch new) | Cross-tenant bearer IDOR test setup (auth swap harness) | `apps/api/test/helpers/auth-swap.ts` (new) | 2h |

---

## 3. FRONTEND production polish (Wave 4 frontend lane)

From FE+UI audit P0 + P1 punch items + UC-V11-* with UX impact:

### 3.1 P0 punch items (4)
| # | Issue | File:line | Fix |
|---|---|---|---|
| FE-P0-1 | `global.css:15-46` duplicates `tokens.css` missing z-index ladder + density | `apps/web/app/global.css` | Delete the duplicated `:root` block; only `tokens.css` defines tokens |
| FE-P0-2 | DAG canvas inaccessible (no aria-label, no role, no keyboard focus on 23 `<g>` nodes) | `apps/web/app/portal/[tenant]/(views)/workflows/page.tsx` SVG | Add `aria-label={node.title}`, `role="button"`, `tabIndex={0}`, focus ring CSS |
| FE-P0-3 | `?? "operator"` sub-line in tasks + dashboard (pixel regression) | `apps/web/app/portal/[tenant]/(views)/tasks/page.tsx:254`, `dashboard/page.tsx:947` | Delete the `?? "operator"` literal |
| FE-P0-4 | 3 hardcoded mock-data leftovers | `dashboard/page.tsx:1015-1017` (funnel), `dashboard/page.tsx:957-973` (SystemHealth), `settings/page.tsx:76-79` (subtitle) | Wire to `useRaasData()` / `/health` / `useTenant()` |

### 3.2 V1.1 UX UCs with quick wins
| UC | Title | Effort |
|---|---|---|
| UC-V11-20 (= FE-P0-3) | Remove "operator" row in Tasks view | (covered by FE-P0-3) |
| UC-V11-17 (+ UC-V11-38 UI) | Fix `/v1/usage` envelope unwrap in `useUsage` hook | 2h |
| UC-V11-15 | Confirm before tenant-switch with unsaved draft | 2h |
| UC-V11-13 | Persist edit-mode draft to localStorage | 3h |
| UC-V11-04 | Cmd-K "Emit event" command | 4h |
| UC-V11-06 | Hot-reload toast on `deployment.created` SSE | 2h |
| UC-V11-09 | Sidebar health drilldown panel | 3h |
| UC-V11-10 | Per-tenant rate-limit field in Settings → Billing | 2h |

### 3.3 Density token consumption (the no-op fix)
`--density-mult` declared but 0 of 77 padding literals use it. P2-FE-20 is effectively dead. Convert key padding/gap literals to `calc(... * var(--density-mult))` so the Tweaks panel density toggle actually does something.

---

## 4. CLEANUP lane

| Task | Files | Effort |
|---|---|---|
| Delete `apps/web/app/_portal_legacy/` (CLAUDE.md confirms obsolete; PF-GAP-07) | `apps/web/app/_portal_legacy/` | 30min |
| Gitignore `apps/api/data/imports/` (PF-GAP-09; staging dir `dpl-e98006b51cd4/` currently uncommitted) | `.gitignore` | 5min |
| Decide on `models/RAAS-v1/workflow_v2.json` (uncommitted; Test Arch flagged) | `git status` shows untracked | Decision: delete or commit |
| Update `docs/USE_CASES.md`: flip UC-V11-33 ✅, renumber UC-V11-38, add UC-V11-40..48 from PD+PM, add 13 new persona journeys UC-V11-49..61, demote UC-V1-23/-31/-49 to V1.1, promote UC-V11-11/-34/-36 to V2 | `docs/USE_CASES.md` | 1h |
| Update `docs/PRODUCT_CATALOG.md`: refresh § 7 cross-ref matrix with 11 missing rows from CPA review | `docs/PRODUCT_CATALOG.md` | 30min |

---

## 5. Wave 5 — Test sweep (gated on Wave 4)

Per Test Architect strategy:

### 5.1 Execution order
1. `pnpm typecheck` (≤90s)
2. `pnpm lint` (≤30s)
3. `pnpm --filter @agentic/api exec vitest run test/smoke.test.ts` (≤30s, new smoke file)
4. `pnpm test` (full api vitest, ≤180s)
5. `pnpm --filter @agentic/web exec playwright test` (≤300s; dev server on :3599 required)
6. `pnpm --filter @agentic/web exec playwright test test/visual/` (≤120s)
7. `pnpm build` (≤180s, full turbo)

### 5.2 Bail-out
If any layer fails: STOP. Triage. Don't proceed to next layer.
If >3 individual tests fail in any layer: STOP. Report root cause.

### 5.3 New tests to write (61 proposed)
Top 10 must-have for V1 ship:
1. `tc-126-cross-tenant-bearer-idor.test.ts` (security regression)
2. `tc-86-raas-stage-walk.test.ts` (all 17 RAAS nodes E2E)
3. `tc-tenants-cookie-auth-prod.test.ts` (UC-V11-29)
4. `tc-agents-500-tenant-code.test.ts` (UC-V11-18)
5. `tc-cli-init-actions-shape.test.ts` (UC-V11-19)
6. `tc-defineprompt-required.test.ts` (UC-V11-25)
7. `tc-idempotency-keys.test.ts` (UC-V11-32)
8. `tc-failrun-race.test.ts` (UC-V11-35)
9. `tc-emitted-event-hydration.test.ts` (UC-V11-21)
10. `tc-runs-total-manifest.test.ts` (UC-V11-22)

Remaining 51 follow per Test Architect file register.

---

## 6. Deferred to V1.1 actual implementation cycle

These are V1.1 ready but won't fit in Wave 4 scope:

- UC-V11-01, UC-V11-02, UC-V11-16 (Wu Hao end-user flows — needs notification dispatcher build, half-day effort)
- UC-V11-03 (run-compare splitter — UX experiment risk)
- UC-V11-05 (live token preview — needs tiktoken wiring)
- UC-V11-07, UC-V11-08 (bulk replay, SSE pause — both touch SSE multiplexer)
- UC-V11-11 (full ancestor trace tree — promoted to V2 per CPA)
- UC-V11-12 (Provider errors card)
- UC-V11-14 (manifest dry-run wiring)
- UC-V11-26 / AR-GAP-16 (Bedrock + Vertex real adapters — pull MBs of deps)
- UC-V11-34 (OTel — promoted to V2 per CPA)
- UC-V11-36 (DLQ — promoted to V2 per CPA)
- UC-V11-37 (steps_run_ord_idx unique promotion)
- UC-V11-39 (audit emission audit)
- UC-V11-40..48 (PD+PM additions)
- UC-V11-49..61 (CPA missing journeys)

---

## 7. Definition of done for V1 ship

V1 ship gate is satisfied iff:

- [ ] All 5 P0 V1-blockers landed (§ 1)
- [ ] All 4 FE P0 punch items landed (§ 3.1)
- [ ] All 7 high-priority backend fixes landed (§ 2)
- [ ] Cleanup lane complete (§ 4)
- [ ] Top-10 new tests written + passing (§ 5.3)
- [ ] Wave 5 full sweep passes layer 1-7 without bail-out
- [ ] `git status` clean (no uncommitted staging dirs, no `workflow_v2.json` orphan)

---

## 8. Wave 4 agent assignments

| Lane | Agent | Tasks |
|---|---|---|
| Backend | Senior Full-stack engineer | § 1 (5 P0 backend) + § 2 (7 high-priority backend) |
| Frontend | Senior Frontend engineer | § 3.1 (4 P0) + § 3.2 (8 V1.1 UX) + § 3.3 (density consumption) |
| Cleanup | Cleanup engineer | § 4 (5 cleanup tasks including docs update) |

All 3 run in parallel — no file overlap.

---

*Composed in-conversation as Chief Software Engineer after consolidating: 01-product-architect-review.md, 02-pd-pm-use-case-audit.md, 04-frontend-ui-audit.md, 05-test-strategy.md, and 7 tech designs.*
