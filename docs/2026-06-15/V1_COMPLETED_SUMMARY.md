# Agentic Operator V1 — Completed Use Cases & Features

**Date:** 2026-05-21
**Status:** V1 ship-ready (SHIP-WITH-CAVEATS, see `V1_SHIP_VERDICT.md`)

A scannable summary of every use case and feature that landed in V1, organized by feature area. For the full taxonomy see `PRODUCT_CATALOG.md`; for the backlog see `USE_CASES.md`; for the why-now hotfix list see `V1_SHIP_VERDICT.md`.

---

## At a glance

| Metric | V1 count |
|---|---|
| **Use cases shipped** | 49 ✅ |
| **Use cases V1.1 ready** | 57 🟡 |
| **Use cases V2 vision** | 22 🔵 |
| **Total backlog** | 128 |
| **V1-blocker fixes landed in this push** | 5 |
| **Additional engineering fixes landed** | 19 |
| **Tests passing** | 360 / 367 (98.1%) |
| **TypeScript workspaces clean** | 15 / 15 |
| **API boot — Inngest functions registered** | 28 |
| **Documentation produced** | ~75,000 words across 18 files |

---

## 1. Use cases shipped ✅

### 1.1 Workflow Designer (Liu Wei) — 14 UCs

| ID | Use case | Surface |
|---|---|---|
| UC-V1-01 | Live KPI strip (runs / events / errors / pending / spend) | Dashboard |
| UC-V1-02 | RAAS funnel across 8 stages | Dashboard → Stage funnel |
| UC-V1-03 | Click active run → run detail | Dashboard → Active runs table |
| UC-V1-04 | DAG canvas of deployed workflow | `/workflows` |
| UC-V1-05 | Select node → highlight in/out edges | Workflows → click node |
| UC-V1-06 | Toggle Edit mode (DraftBanner + EditToolbar) | Workflows → "Edit workflow" |
| UC-V1-07 | Add agent via 6-step manifest upload wizard | Workflows → "Import manifest" |
| UC-V1-08 | Save workflow → manifest commits + version row | Workflows → Edit → "Save" |
| UC-V1-09 | List agents + filter by actor (Agent / Human) | `/agents` → SearchInput + FilterChip |
| UC-V1-10 | Agent detail with 5 tabs (config / io / code / versions / runs) | `/agents/[id]` |
| UC-V1-11 | Test-run any agent and watch it complete | Agent detail → "Test run" |
| UC-V1-12 | Synthetic-vs-real distinction (TEST badge in 4 places) | Dashboard / Runs / Agents / Run detail |
| UC-V1-13 | Jump from run back to producing agent | Run detail → "Open agent" |
| UC-V1-14 | Re-emit a run's trigger event | Run detail → "Replay" |

### 1.2 AI Engineer (Chen Mengjie) — 5 UCs

| ID | Use case | Surface |
|---|---|---|
| UC-V1-15 | Edit ontology in-portal and save | Agent detail → Edit → EditConfigTab |
| UC-V1-16 | Edit code-agent TS source in Monaco and deploy | Agent detail → Code tab → tar+POST |
| UC-V1-17 | Live SSE tail of run logs | Run detail → logs tab |
| UC-V1-18 | Run input + output side-by-side | Run detail → io tab |
| UC-V1-19 | Agent's code in context of a run | Run detail → agent tab |

### 1.3 Platform Operator (Ops) — 6 UCs

| ID | Use case | Surface |
|---|---|---|
| UC-V1-20 | Resolve a human task | `/tasks` → row → primary action |
| UC-V1-21 | Snooze a task for 1h | `/tasks` → row → "Snooze" |
| UC-V1-22 | Filter runs by failed status | `/runs` → FilterChip "Failed" |
| UC-V1-24 | Audit log entry with before/after diff | `/settings/audit` → expand row |
| UC-V1-25 | Provision new tenant via 4-step wizard | TenantSwitcher → "New tenant" |
| UC-V1-26 | Promote a draft deployment to live | `/deployments` → row → "Promote" |
| UC-V1-27 | Rotate API token (revealed once) | `/settings/tokens` → "Rotate" |

### 1.4 Cross-persona — 3 UCs

| ID | Use case | Surface |
|---|---|---|
| UC-V1-28 | Switch active tenant | TenantSwitcher → tenant row |
| UC-V1-29 | Jump to any entity via ⌘+K | Global keydown |
| UC-V1-30 | Toggle theme / density / accent | Tweaks panel (⌘⇧T) |

### 1.5 RAAS canonical workflow — 17 UCs (one per node)

| ID | RAAS node | Step type |
|---|---|---|
| UC-V1-32 | `1-1 syncFromClientSystem` | logic (Agent) |
| UC-V1-33 | `1-2 manualEntry` | manual (Human) |
| UC-V1-34 | `2 analyzeRequirement` | logic (Agent) |
| UC-V1-35 | `3 clarifyRequirement + 3-2 requirementReClarification` | logic + condition |
| UC-V1-36 | `4 createJD + 5 jdReview` | logic + manual (HITL) |
| UC-V1-37 | `6 assignRecruitTasks` | logic (Agent) |
| UC-V1-38 | `7-1 publishJD + 7-2 manualPublish` | tool + manual |
| UC-V1-39 | `8 resumeCollection` | tool (channel) |
| UC-V1-40 | `9-1 processResume + 9-2 resumeFix` | logic + manual (HITL) |
| UC-V1-41 | `10-1 ruleCheckerForClientResume` (NEW in v1) | logic — emits `CLIENT_RULES_PASSED` / `CLIENT_RULES_FAILED` |
| UC-V1-42 | `10-2 matchResume` (renamed from `10`) | logic (Agent) |
| UC-V1-43 | `11-1 inviteInternalInterview + 11-2 interviewExecution` | logic + manual (HITL) |
| UC-V1-44 | `12 evaluateInterview` | logic (Agent) |
| UC-V1-45 | `13 refineResume` | logic (Agent) |
| UC-V1-46 | `14-1 generateRecommendationPackage + 14-2 packageSupplement` | logic + manual |
| UC-V1-47 | `15 packageReview` | manual (HITL) |
| UC-V1-48 | `16 submitToClientPortal` | tool (channel) — terminal |

### 1.6 Platform operations — 3 UCs

| ID | Use case | Surface |
|---|---|---|
| UC-V1-50 | `agentic deploy [path]` — USTAR tarball ship | CLI → `/v1/tenant-code` |
| UC-V1-51 | `agentic logs <run-id> --tail` — SSE follow | CLI → `/v1/runs/:id/logs` |
| UC-V1-52 | `agentic events tail` — generic SSE multiplexer | CLI → `/v1/stream` (newly verified registered) |

**V1 shipped total: 49 use cases.**

---

## 2. V1-blocker engineering fixes shipped in this push

The 5 CPA-mandated must-land-before-customer items:

| UC | Fix | Files touched | Wave |
|---|---|---|---|
| **UC-V11-18** | `POST /v1/agents` 500 on tenants with live `tenant_code` deployment — version segment now resolved through `resolveTenantCodePath()` service | `apps/api/src/services/tenant-code.ts`, `apps/api/src/routes/v1/agents.ts` | Wave 4 Backend Fix 2 |
| **UC-V11-19** | `agentic init` now writes `actions_v1.json` as an array matching `ActionsManifestSchema` | `apps/cli/src/commands/init.ts` | Wave 4 Backend Fix 1 |
| **UC-V11-25** | `definePrompt` required at boot for every `logic` action; per-tenant fail-loud error listing missing names; other tenants continue | `packages/runtime/src/register.ts`, `bootstrap.ts`, `step-engine.ts` | Wave 4 Backend Fix 4 |
| **UC-V11-29** | Cookie auth on Fastify in production — `jose` JWT verify before bearer fallback; accepts both `AUTH_SESSION_SECRET` + `SESSION_SECRET` for transition | `apps/api/src/plugins/auth.ts`, `apps/api/package.json` | Wave 4 Backend Fix 3 |
| **UC-V11-32** | `idempotency_keys` table + service; `Idempotency-Key` header now actually de-duplicates on `/v1/events` and `/v1/agents/:name/invoke`; 24h TTL purged by retention cron | new migration `0014_idempotency_keys.sql`, `packages/db/src/schema.ts`, `apps/api/src/services/idempotency.ts`, `apps/api/src/routes/v1/{events,agent-invoke}.ts`, `packages/runtime/src/retention.ts` | Wave 4 Backend Fix 5 |

---

## 3. Additional engineering fixes shipped in this push

### 3.1 Backend (Wave 4 + 4.5)

| UC | Fix |
|---|---|
| UC-V11-21 | `runs.emittedEvent` hydration via `LEFT JOIN events`; UI now shows event name instead of raw `evt-` id |
| UC-V11-22 | `runs_total` metric now bumped from manifest engine finalize step (`setRuntimeMetrics()` mirror of `setRuntimeGateway`) |
| UC-V11-35 | `failRun` wrapped in `step.run("finalize-fail-${rid}", ...)` — closes Inngest race window |
| Pre-flight | `cost_limit_exceeded` added to `LLMErrorCode` union (was thrown but un-typed) |
| Pre-flight | `deployment.created` SSE event emitted from 3 sites (`tenant-code.ts:283`, `manifest-import.ts:1491`, `reconcile-imports.ts:263`) |

### 3.2 Frontend (Wave 4)

| UC / Punch | Fix |
|---|---|
| FE-P0-1 | Token system drift purged — `app/global.css` no longer duplicates `tokens.css` (was missing z-index ladder + density multiplier — drift bomb) |
| FE-P0-2 | DAG canvas accessibility — every `<g>` node gets `role="button"`, `tabIndex={0}`, `aria-label`, `onKeyDown`; wrapping `<svg>` gets `role="img"` |
| FE-P0-3 / UC-V11-20 | `?? "operator"` sub-line pixel regression removed from Tasks + Dashboard |
| FE-P0-4 | 3 hardcoded mock-data leftovers wired (dashboard funnel, SystemHealth → `useHealth()`, Settings subtitle → `useTenant() + useSession() + env`) |
| UC-V11-15 | `DirtyContext` + tenant-switch confirm when workflow draft is unsaved |
| UC-V11-13 | Workflow draft auto-persists to localStorage; restore banner with Discard on mount |
| UC-V11-06 | `deployment.created` SSE → toast "Tenant code v{version} active" (fires now that backend emits) |
| UC-V11-17 | `/v1/usage` envelope unwrap verified correct (was already shipping) |

### 3.3 Cleanup (Wave 4 + 4.5)

| Task | Outcome |
|---|---|
| `apps/web/app/_portal_legacy/` deleted | 49 dead files removed |
| `.gitignore` extended | `apps/api/data/imports/`, `data/test-artifacts/`, `data/test-logs/`, `data/*.db.bak-*` |
| `workflow_v2.json` + `workflow_v3.json` deleted | Both were 109-line truncated stubs that would have silently corrupted RAAS at next boot (loader picks highest-numbered file) |
| 8 `models/mi*-v1/` orphan dirs deleted | Stale e2e wizard runs — were cascading boot errors under the new `definePrompt` validator |
| `models/workflow.schema.json` regenerated | Was stale; now byte-identical to current Zod (`buildWorkflowJsonSchema`) |
| 27 RAAS `definePrompt` calls added | `tenants/raas/src/prompts/index.ts` (new file) — makes RAAS bootable under Option B |
| `@tenants/__system` package created | Stub prompts for vitest fixtures pinned to `AGENTIC_DEV_TENANT=__system` |
| Typecheck cleared | 6 pre-existing errors → 0 across 15 workspaces |

### 3.4 Documentation refactors

| Task | Outcome |
|---|---|
| `USE_CASES.md` Wave-3 corrections | 22 new UCs added, 3 V1→V1.1 demotions (UC-V1-23, -31, -49), 3 V1.1→V2 promotions (UC-V11-11, -34, -36), UC-V11-33 promoted to V1 (now UC-V1-52) |
| `PRODUCT_CATALOG.md` § 7 matrix | 11 cross-reference rows added |

---

## 4. Documentation produced (75k words across 18 files)

| File | Author | Words |
|---|---|---|
| `docs/catalog/01-product-design-catalog.md` | Product Designer | 8.4k |
| `docs/catalog/02-ai-runtime-catalog.md` | AI Architect | 14.5k |
| `docs/catalog/03-platform-catalog.md` | Software Architect | 11.2k |
| `docs/PRODUCT_CATALOG.md` | Synthesized | 3.1k |
| `docs/USE_CASES.md` | Synthesized + Wave-3 corrections | 5.7k |
| `docs/wave-3-reviews/01-product-architect-review.md` | CPA | 5.2k |
| `docs/wave-3-reviews/02-pd-pm-use-case-audit.md` | PD + PM | 3.3k |
| `docs/wave-3-reviews/04-frontend-ui-audit.md` | FE + UI Designer | 4.7k |
| `docs/wave-3-reviews/05-test-strategy.md` | Test Architect | 6.6k |
| `docs/tech-design/ar-ak.md` | AI Software Architect | 1.6k |
| `docs/tech-design/ar-llm.md` | AI Software Architect | 1.5k |
| `docs/tech-design/ar-inn.md` | AI Software Architect | 1.8k |
| `docs/tech-design/ar-mem.md` | AI Software Architect | 1.9k |
| `docs/tech-design/ar-tool.md` | AI Software Architect | 2.1k |
| `docs/tech-design/ar-evt.md` | AI Software Architect | 2.0k |
| `docs/tech-design/ar-dep.md` | AI Software Architect | 2.2k |
| `docs/WAVE_4_PUNCH_LIST.md` | Chief Software Engineer | ~1.5k |
| `docs/V1_SHIP_VERDICT.md` | Chief Software Engineer | ~1.5k |

---

## 5. Latent bugs caught (the "save" column)

The orchestration prevented 3 dormant production hazards:

1. **`workflow_v2/v3.json` stubs** — 109-line truncated RAAS subsets sitting in `models/RAAS-v1/`. The runtime's manifest loader picks the highest-numbered file, so leaving them would have silently replaced the canonical 788-line manifest at next boot. Caught by Wave 4 Cleanup engineer; both deleted.

2. **`cost_limit_exceeded` thrown but not typed** — Wave 4 backend's budget enforcement was throwing this error code, but the `LLMErrorCode` union never included it. Code shipping in a "works at runtime, fails at TypeScript" state. Caught + fixed in Wave 4.5.

3. **8 stale `models/mi*-v1/` orphan dirs** from past manifest-import wizard e2e runs. Under the new Wave-4 `definePrompt` validator (Option B), each one was crashing per-tenant boot and cascading into 23 of the original 31 vitest failures. Caught + deleted this session; vitest pass rate jumped from 91.5% to 98.1%.

---

## 6. What's deferred

### 6.1 V1.0.1 hotfix queue (≤1 week)
- **tc-24 (5 fails)** — `?testRun=1` flag plumbing through `agent-invoke.ts` → SSE → `runs.is_test`
- **tc-27 (1 fail)** — restore `target` field in tenant-code rollback response shape
- **tc-5 (1 fail)** — deployment audit reuse test isolation
- **Layers 5-7** — Playwright e2e + visual diff + `pnpm build` (Wave 5 agent crashed before reaching these)
- **Top-10 new tests** from Test Architect strategy § 5.3 (cross-tenant IDOR, RAAS-17-stage walk, cookie auth, etc.) — 0/10 written

### 6.2 V1.1 backlog (≤1 month)
57 V1.1 UCs catalogued in `docs/USE_CASES.md` § 2, including: signed-URL Wu Hao flows (UC-V11-01, -02, -16), run-compare splitter (UC-V11-03), Cmd-K emit event (UC-V11-04), live token preview (UC-V11-05), bulk replay (UC-V11-07), SSE pause (UC-V11-08), webhook fallback-secret removal (UC-V11-27), Bedrock + Vertex real adapters (UC-V11-26), and 49 others.

### 6.3 V2 vision (RFC-gated)
22 V2 UCs: A/B prompt testing (UC-V2-01), drag-drop workflow builder (UC-V2-02), in-browser step-through debugger (UC-V2-03), agent marketplace (UC-V2-04), Python runtime (UC-V2-05), multi-region active-active (UC-V2-06), mobile portal (UC-V2-07), streaming LLM output to portal (UC-V2-08), SAML/SSO (UC-V2-09), right-click context menus (UC-V2-10), async invoke via Inngest (UC-V2-11), TypeScript snippet sandbox (UC-V2-12), unified run engine (UC-V2-13, UC-V2-16), vector memory driver (UC-V2-14), gateway-level JSON enforcement (UC-V2-15), eval harness (UC-V2-17), worker isolation (UC-V2-18), Postgres path (UC-V2-19), full ancestor trace tree (UC-V11-11 promoted), OpenTelemetry (UC-V11-34 promoted), DLQ + Retry UI (UC-V11-36 promoted).

---

## 7. Boot artifacts (the proof V1 is real)

```
[bootstrap] raas (RAAS-v1): 22/23 agents · 3 event types · 44 entities · tenant pkg: 1 tools, 27 prompts
[bootstrap] __system (__system-v1): 5/5 agents · 0 event types · 0 entities · tenant pkg: 0 tools, 2 prompts
[bootstrap] api serving 28 Inngest function(s) (27 from tenant manifests)
api listening on port 3501
```

```
pnpm typecheck → Tasks: 15 successful, 15 total · 986ms
pnpm lint → Tasks: 1 successful, 1 total · 1.55s
pnpm test → 360/367 (98.1%); cli 28/28
```

---

*Generated 2026-05-21 after 5 orchestrated waves + 1 pre-flight + 1 final verification. 14 background agents. 0 manual user intervention required during waves. Full audit trail in `docs/wave-3-reviews/`, `docs/tech-design/`, and the task list (#1–#46).*
