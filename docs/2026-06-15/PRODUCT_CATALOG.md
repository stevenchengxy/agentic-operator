# Agentic Operator — Master Product Catalog (V1)

> Single source of truth for **what's in the box** at V1. Cross-references every feature ID from the three specialist slices into one index. Use this to plan, sign off, audit, and orient.

**Synthesized from:**
- `docs/catalog/01-product-design-catalog.md` (~8.4k words, Product Designer) — UX surfaces, personas, journeys, design tokens, interaction patterns, UX backlog, acceptance criteria.
- `docs/catalog/02-ai-runtime-catalog.md` (~14.5k words, AI Architect) — agent kinds, LLM gateway, Inngest durability, memory, tools, run lifecycle, events, deployment, cost, RAAS walkthrough, AR-GAP backlog.
- `docs/catalog/03-platform-catalog.md` (~11.2k words, Software Architect) — system topology, monorepo, `/v1/*` API surface, DB schema, migrations, auth, storage, manifest import, CLI, web architecture, build, CI, observability, env vars, PF-GAP backlog.

Companion: `docs/USE_CASES.md` (unified backlog with status legends, persona ownership, source citations).

---

## 1. What Agentic Operator is

A **multi-tenant agent operating system** that gives Workflow Designers, AI Engineers, and Platform Operators a single harness for declaring (manifest), authoring (TypeScript), invoking (sync + async), observing (SSE + logs + traces), and governing (audit + budget + tenancy) LLM-based workflows. The harness is opinionated about durability (Inngest replay + `step.run` discipline), provider portability (14-provider gateway), tenancy (every row carries `tenant_id`; `tenantScope()` enforced), and observability (NDJSON ledgers + Prometheus + structured audit).

The canonical end-to-end use case is **RAAS** — a 17-node recruiting workflow that walks a resume from client intake through interview to client-portal submission, with both AI agents and human-in-the-loop tasks. RAAS is documented node-by-node in `02 § 10` (`AR-RAAS-01..17`).

---

## 2. The product at a glance

| Dimension | V1 count | Slice |
|---|---|---|
| Top-level UX views | 9 (Dashboard, Workflows, Agents, Runs, Events, Tasks, Logs, Deployments, Settings) | 01 § 1.1 |
| Personas | 4 (Liu Wei, Chen Mengjie, Ops, Wu Hao) | 01 § 2 |
| Persona journeys | 13 mapped end-to-end | 01 § 2.1–2.4 |
| Agent kinds | 4 (code, manifest, system, tenant) | 02 AR-AK |
| LLM providers | 14 (mock, anthropic, openai, openrouter, gemini, azure, groq, together, mistral, deepseek, qwen, bedrock, vertex, custom) | 02 AR-LLM-01 |
| Step engine action types | 6 (`logic`, `tool`, `manual`, `condition`, `delay`, `subflow`) | 02 AR-TOOL-04 |
| `/v1/*` endpoints | ~50 across 22 route files | 03 § 3 |
| Database tables | 23 (12 user + 11 internal) | 03 § 4 |
| Migrations | 14 (drizzle `0000`..`0013`) | 03 § 5 |
| Workspaces | 14 (4 apps + 9 packages + 1 tenant + `data/system-agents`) | 03 § 2 |
| Env vars (catalogued) | 23 | 03 § 14 |
| RAAS workflow nodes | 17 (14 Agent actors + 3 Human/system) | 02 AR-RAAS-* |
| Use cases ✅ v1 shipped | 30 UX + 17 RAAS-stage + ~4 cross-persona = **~51** | 01 § 4.1 + 02 § 10 |
| Use cases 🟡 v1.1 ready | 16 UX + 8 AR-GAP + 12 PF-GAP = **~36** | 01 § 4.2 + 02 § 12 + 03 § 15 |
| Use cases 🔵 v2 vision | 10 UX + 4 AR-GAP + 3 PF-GAP = **~17** | 01 § 4.3 + 02 § 12 + 03 § 15 |
| Known gaps total | 36 (18 AR-GAP + 18 PF-GAP) | 02 § 12 + 03 § 15 |

---

## 3. Feature directory by category

### 3.1 UX surfaces — slice 01

| Section | Content |
|---|---|
| 1.1 Top-level navigation | 9 views (`/dashboard`, `/workflows`, `/agents`, `/runs`, `/events`, `/tasks`, `/logs`, `/deployments`, `/settings`) |
| 1.2 Detail / sub-routes | Per-view detail pages (`/runs/[id]`, `/agents/[id]/...tabs`, `/settings/{usage,audit,tokens,integrations}`) |
| 1.3 Shared primitives | Badge, Button, Icon, ModalOverlay, MonacoEditor, Panel, Stat, useToast — barrelled at `apps/web/app/portal/components/index.ts` |
| 1.4 Cross-cutting components | TopBar, Sidebar, TenantSwitcher, DraftBanner, EditToolbar, TraceTree, DraftPalette, FilterChip, SearchInput, KBar (⌘+K), Tweaks panel (⌘⇧T) |
| 1.5 Design tokens | Color palette (CSS vars), typography (Sans/Mono/Serif), spacing scale, border radii, z-index ladder (`--z-overlay/--z-modal/--z-toast/--z-tooltip`), density multiplier (`--density-mult`), 6 animation keyframes |
| 2 Personas + 13 journeys | Liu Wei (4), Chen Mengjie (4), Ops (5), Wu Hao (1) |
| 3 Interaction patterns | Test runs, edit-mode drafts, signed-URL HITL, replay, bulk action affordances |
| 6 Acceptance criteria | Visual fidelity, accessibility, data integrity, performance, coverage, pixel discipline (1440×900 ref), persona acceptance |

### 3.2 AI Runtime — slice 02 (`AR-*` IDs)

| Group | Count | Coverage |
|---|---|---|
| AR-AK (Agent kinds) | 4 | Code, manifest, system, tenant |
| AR-LLM (LLM gateway) | 7 | 14 providers, singleton wiring, defaults, error taxonomy, redaction, BYOK vault, streaming |
| AR-INN (Inngest durability) | 5 | `step.run` contract, concurrency keying, HITL, retention cron, manifest invoke fallback (Option B) |
| AR-MEM (Memory) | 5 | Short-term, long-term, scopes, `MemoryHandle` API, subject identity |
| AR-TOOL (Tools) | 5 | First-party (http.fetch/llm.call/channel.publish), `defineTool`, tenant registry, step action types, SSRF guard |
| AR-RUN (Run lifecycle) | 6 | Run-row schema, step rows, log writer, SSE, sync vs async, `?testRun=1` |
| AR-EVT (Events) | 4 | NDJSON ledger, namespacing, catalog endpoints, webhook subscriptions |
| AR-DEP (Deployment) | 4 | CLI deploy, atomic-rename, manifest import wizard, reconcile-imports |
| AR-COST (Cost/budgets) | 4 | `tenant_budgets`, pre-flight deduct, `/v1/usage`, per-call cost |
| AR-RAAS (RAAS workflow) | 17 | Every workflow node (`1-1`..`16`) with step type, event emit, log lands |
| AR-X (Cross-cutting) | 6 | Tenant scoping, ID conventions, audit log, auth modes, cookie vs bearer, Prometheus metrics |
| AR-GAP (V1 gaps) | 18 | Honest list of unfinished v1; 8 🟡 v1.1, 4 🔵 v2, mixed |

### 3.3 Platform — slice 03 (`PF-*` IDs)

| Group | Count | Coverage |
|---|---|---|
| PF-TOP (Topology) | 4 | Dev process map, prod process map, port map, boot order |
| PF-MR (Monorepo) | 14 | 4 apps (`api`, `web`, `cli`, `inngest-worker`) + 9 packages (`agent-runtime`, `agent-sdk`, `contracts`, `db`, `llm-gateway`, `runtime`, `shared`, `tools`) + `tenants/raas` + `data/system-agents` |
| PF-API (API surface) | ~50 endpoints | Across 22 route files: events, runs, agents, agent-invoke, tasks, deployments, webhooks, workflow, manifest-import, reads, audit, budgets, usage, tenants, tenant-code, llm, artifacts, stream, inngest, health, metrics |
| PF-DB (DB schema) | 23 | Every table cited with col list, indexes, FKs, tenant-scoping |
| PF-MIG (Migrations) | 15 | Every drizzle migration `0000..0013` + `_journal.json` + tests |
| PF-AUTH (Auth + tenancy) | 7 | Dev mode, bearer, cookie, memberships, `tenantScope`, JWT secret, token issuance |
| PF-STO (Storage) | 7 | SQLite WAL, run logs NDJSON, event ledger, artifacts, manifest staging, system agents, tenant code |
| PF-IMP (Manifest import) | 8 | 4-phase commit, crash recovery, in-flight lock, SSRF, 6-step UI wizard |
| PF-CLI (CLI) | 4 | `init`, `deploy`, `logs`, `events tail` |
| PF-WEB (Web architecture) | 10 | App Router, `useTenant()`, shell, primitives, inline-style policy, `api-client.ts`, rewrites, legacy SPA, TanStack Query, Monaco |
| PF-BUILD (Build/dev/test) | 12 | `pnpm dev/build/lint/typecheck/test/db:*/seed:rich`, Playwright, web vitest gate |
| PF-CI (CI/CD) | 7 | `ci.yml`, `release.yml`, drift gate, coverage, migration smoke |
| PF-OBS (Observability) | 7 | Prometheus metrics, structured logging, audit log, log retention, correlation IDs |
| PF-ENV (Env vars) | 23 | All env vars catalogued with location, default, type, security note |
| PF-GAP (V1 gaps) | 18 | Honest list of unfinished v1; 12 🟡 v1.1, 3 🔵 v2, mixed |

---

## 4. The canonical use case — RAAS

RAAS is the worked example. It ships at `models/RAAS-v1/workflow_v1.json` with 17 nodes, 14 of which are Agent actors (Chen Mengjie's prompt + ontology + tool surface), 2 Human actors (JD review + JD publish), and a terminal client-portal submission. The workflow exercises every harness contract:

| Concern | Where RAAS exercises it |
|---|---|
| Manifest agents (AR-AK-02) | All 14 Agent-actor nodes |
| Inngest durability (AR-INN-01) | Every `step.run` wraps the run+step+log writes |
| Concurrency keying (AR-INN-02) | `subject = candidate_id` ensures one in-flight per candidate |
| HITL pattern (AR-INN-03) | `5 jdReview`, `7-2 manualPublish`, `9-2 resumeFix`, `11-2 interviewExecution`, `15 packageReview` |
| Event namespacing (AR-EVT-02) | All triggers emit `${tenant}/${event}` (e.g. `raas/RESUME_PROCESSED`) |
| Memory scopes (AR-MEM-03) | `candidate_id` is the long-term subject identity across runs |
| Branching (AR-TOOL-04 `condition`) | `CLIENT_RULES_PASSED` / `CLIENT_RULES_FAILED` after `10-1 ruleCheckerForClientResume` |
| Cost rollup (AR-COST-03) | RAAS shows per-day token + dollar cost in Settings → Usage |
| Test runs (AR-RUN-06) | "Test run" button at `/agents/[id]` flips `runs.is_test=true` end-to-end |

**Surprise finding (from AI architect):** `10-1 ruleCheckerForClientResume` is the only RAAS node that actually populates `ontology_instructions`. Every other agent ships an empty string. That node is the de facto canary for whether the P0-RT-01 manifest-schema widening survives the round-trip through `agent_versions.manifest_json` end-to-end.

---

## 5. Acceptance criteria — what "good V1" means

Rolled up from `01 § 6`. Every Wave 3 review and Wave 5 test pass must verify these:

| Dimension | Bar |
|---|---|
| **Visual** | Pixel-diff against `apps/web/test/visual/v1_1-reference/` (1440×900); all 9 views match |
| **Accessibility** | Keyboard nav across every interactive element; focus rings visible on dark + light; aria-labels on icon buttons |
| **Data integrity** | Every UI table reads through `lib/api-client.ts` → `/v1/*` → typed envelope; no hard-coded mock data |
| **Performance** | Dashboard FCP < 1.5s on local dev; run-detail SSE first-event < 500ms; no list view loads > 200 rows synchronously |
| **Coverage** | api workspace vitest pass rate 100%; web Playwright pass rate 100%; type-check passes across every workspace |
| **Pixel discipline** | Inline `style={{}}` only under `app/portal/**`; ESLint zIndex-token rule passes; `app/_portal_legacy/` ignored or removed |
| **Persona acceptance** | All 13 journeys from `01 § 2` reproducible end-to-end without dev workarounds |

---

## 6. Status legend — used across all 3 slices

| Glyph | Meaning |
|---|---|
| ✅ | Shipped in V1. Citable file:line in slices 02/03. UX path in slice 01. Tests pass. |
| 🟡 | Ready for V1.1. Path is defined; effort is small (hours-to-days, not weeks). Listed in AR-GAP or PF-GAP. |
| 🔵 | V2 vision. Requires design RFC, schema migration, or new sub-system. Out of scope for v1. |

---

## 7. Cross-reference matrix — where the same feature is described from different angles

The three slices intentionally describe overlapping concerns from different lenses. This matrix is the lookup when a Wave 3 reviewer asks "where is X documented?":

| Feature | UX angle (01) | Runtime angle (02) | Platform angle (03) |
|---|---|---|---|
| 10-1 ruleCheckerForClientResume | journey 2.1.4 (investigate) | AR-RAAS-10 | (manifest-schema widened via PF-MIG flag) |
| Artifact streaming (download links) | Run detail → io tab | AR-RUN-02 | PF-API-ART-01 |
| Audit log entry diff | U1.24 | AR-X-03 | PF-API-AUD + PF-OBS-03 |
| BYOK vault | (Settings → Integrations) | AR-LLM-06 | PF-API-LLM-keys + PF-ENV-09 (canonical env: `AGENTIC_KEY_VAULT_SECRET`) |
| Cmd-K palette | U1.29 + U2.4 | (none) | PF-WEB-* |
| Condition action (DAG branching) | Workflows DAG branch labels | AR-TOOL-04 + FR-RT-4 | (none) |
| Cookie session | (none) | AR-X-05 + AR-GAP-05 | PF-AUTH-03 + PF-GAP-05 |
| Dashboard data feeds (reads endpoints) | Dashboard KPI strip + Workflows view | (none) | PF-API-RDS-01..04 (`/v1/counts`, `/v1/workflows/dag`, `/v1/event-types`, `/v1/entity-types`) |
| Edit-mode draft | U1.6 + U1.8 + U2.13 | (none) | PF-WEB-* + PF-API-WF |
| Event replay (button in Events view) | (UI-only today; UC-V11-04 + 🟡 V1.1) | AR-EVT-03 | PF-API-EVT-02 |
| HITL task resolve | U1.15 + U1.16 + journey 2.1.2 | AR-INN-03 | PF-API-TSK |
| LLM fleet CRUD (model management) | Settings → Models (journey 2.2.3) | AR-LLM-* | PF-API-LLM-08 |
| LLM provider catalog | (none) | AR-LLM-01 | PF-API-LLM-* |
| Manifest import wizard | U1.7 + journey 2.1.3 | AR-DEP-03 | PF-IMP-01..08 |
| Memory primitives (agent KV) | (none — invisible to portal in V1) | AR-MEM-01..05 | PF-DB-22 (short) + PF-DB-23 (long) |
| Pagination contract (`cursor` + `nextCursor`) | Every list view | (none directly) | FR-API-4 + PF-API-* (audit-log only today; 🟡 V1.1 per UC-V11-32a / new PF-GAP-19) |
| Replay run | U1.14 + U2.7 | AR-EVT-03 (replay endpoint) | PF-API-EVT-replay |
| Run logs SSE | U1.19 + U2.6 | AR-RUN-03 + AR-RUN-04 | PF-API-RUN-logs + PF-STO-02 |
| Scheduled trigger (CRON) | (Settings → schedule — not yet built) | AR-INN-* missing + FR-OS-1 + `packages/runtime/src/scheduler.ts` | PF-API-SCH-* missing (🟡 V1.1) |
| Tenant provision wizard | U1.25 + journey 2.3.5 | (none directly) | PF-API-TEN-* + PF-AUTH-04 |
| Test-run badge end-to-end | U1.11 + U1.12 + journey 2.2.4 | AR-RUN-06 | PF-API-AGT-invoke |
| `/v1/usage` route | U1.23 + Settings → Usage | AR-COST-03 + AR-GAP-01 | PF-API-USE (✅ registered server.ts:105) |
| Webhook subscription CRUD | (Settings → Integrations — UI missing) | AR-EVT-04 | PF-API-WHK-CRUD missing (🟡 V1.1) |
| Webhook subscriptions (ingest) | (Settings → Integrations) | AR-EVT-04 + AR-GAP-18 | PF-API-WHK + PF-GAP-18 |
| Workflow schema export (drift gate) | (new "Schema" sub-view — UI missing) | (none) | PF-API-WF-01 + memory `project_schema_editor.md` (🟡 V1.1) |
| Workspace timezone (`fmtAgo` / `fmtTime`) | Settings → Profile + every time display | (none) | FR-PORT-15 + PF-WEB-* partial (🟡 V1.1) |
| ⌘+K (jump-to) | U1.29 + journey | (none) | PF-WEB-* |

---

## 8. How to use this catalog

| Role | What to do with it |
|---|---|
| **Chief Product Architect** | Review every ✅ to confirm V1 scope is delivered. Sign off on every 🟡 to commit V1.1. Defer every 🔵 to V2 RFC queue. |
| **AI Software Architect** | Write a `docs/tech-design/<module>.md` for every grouping (AR-AK, AR-LLM, AR-INN, AR-MEM, AR-TOOL, AR-RUN, AR-EVT, AR-DEP, AR-COST, PF-IMP, PF-AUTH, PF-OBS) describing the *next* iteration of that module. |
| **PD + PM** | Use `docs/USE_CASES.md` as the unified backlog. Each row has a persona, a click path, and a source ID. Add use cases here if a journey doesn't have one. |
| **Senior Frontend + UI Designer** | Walk the 9 views against `apps/web/test/visual/v1_1-reference/` and the criteria in section 5. Fix every PF-WEB pixel-diff. |
| **Senior Full-stack Engineers** | Implement 🟡 items from `docs/USE_CASES.md` § 2 in priority order. Each ticket cites a feature ID (AR-GAP-* or PF-GAP-*) for traceability. |
| **Test Architect** | Generate test cases for every ✅ (regression net) and every 🟡 (acceptance suite). Use TC-* prefix matching the existing test naming (`apps/api/test/tc-*.test.ts`, `apps/web/e2e/*.spec.ts`). |

---

## 9. Pointer index — find the detail fast

| If you want to know… | Read |
|---|---|
| What a view looks like | `01 § 1` |
| Who uses it and when | `01 § 2` |
| Which interaction pattern applies | `01 § 3` |
| What's on the backlog (UX angle) | `01 § 4` |
| What "good" looks like (acceptance) | `01 § 6` |
| How agents are kinded / instantiated | `02 § 1` (AR-AK) |
| Provider list + error taxonomy | `02 § 2` (AR-LLM) |
| Why your `step.run` discipline matters | `02 § 3` (AR-INN) |
| How memory survives across runs | `02 § 4` (AR-MEM) |
| Which action types the engine supports | `02 § 5` (AR-TOOL) |
| What a run row contains | `02 § 6` (AR-RUN) |
| How events flow + webhooks fire | `02 § 7` (AR-EVT) |
| How tenant code lands hot | `02 § 8` (AR-DEP) |
| How budgets gate calls | `02 § 9` (AR-COST) |
| RAAS workflow node-by-node | `02 § 10` (AR-RAAS) |
| What's unfinished on the agent runtime | `02 § 12` (AR-GAP) |
| Which port is which | `03 § 1` (PF-TOP) |
| Which workspace owns what code | `03 § 2` (PF-MR) |
| Every `/v1/*` route + contract | `03 § 3` (PF-API) |
| Every DB table | `03 § 4` (PF-DB) |
| What each migration adds | `03 § 5` (PF-MIG) |
| How auth resolves a request | `03 § 6` (PF-AUTH) |
| Where data lives on disk | `03 § 7` (PF-STO) |
| Why manifest import is 4-phase | `03 § 8` (PF-IMP) |
| What `agentic` CLI does | `03 § 9` (PF-CLI) |
| Web architecture conventions | `03 § 10` (PF-WEB) |
| Build / dev / test commands | `03 § 11` (PF-BUILD) |
| CI/CD workflows | `03 § 12` (PF-CI) |
| Prometheus + logging | `03 § 13` (PF-OBS) |
| Every env var | `03 § 14` (PF-ENV) |
| What's unfinished on the platform | `03 § 15` (PF-GAP) |

---

## 10. Source manifest

| File | Slice author | Word count | Sections | Lead IDs |
|---|---|---|---|---|
| `docs/catalog/01-product-design-catalog.md` | Product Designer | 8,368 | 6 | UX views, personas, journeys, U1/U2/U3 use cases |
| `docs/catalog/02-ai-runtime-catalog.md` | AI Architect | 12,057 | 12 | `AR-AK-*`, `AR-LLM-*`, `AR-INN-*`, `AR-MEM-*`, `AR-TOOL-*`, `AR-RUN-*`, `AR-EVT-*`, `AR-DEP-*`, `AR-COST-*`, `AR-RAAS-*`, `AR-X-*`, `AR-GAP-*` |
| `docs/catalog/03-platform-catalog.md` | Software Architect | 11,182 | 15 | `PF-TOP-*`, `PF-MR-*`, `PF-API-*`, `PF-DB-*`, `PF-MIG-*`, `PF-AUTH-*`, `PF-STO-*`, `PF-IMP-*`, `PF-CLI-*`, `PF-WEB-*`, `PF-BUILD-*`, `PF-CI-*`, `PF-OBS-*`, `PF-ENV-*`, `PF-GAP-*` |
| **Total** | — | **31,607** | **33** | ~85 top-level groups, ~190 sub-features |

---

## 11. Open questions for Wave 3 reviewers

These are the conscious deferrals where reviewers should explicitly confirm V1 scope:

1. **Async invoke (AR-GAP-08)** — `POST /v1/agents/:name/invoke?async=1` returns 501 today. Is this acceptable for V1, or is Wave 4 expected to wire it?
2. **Worker isolation (PF-GAP-13)** — Tenant code runs in-process. PRD §11 + DESIGN §11.4 explicitly out-of-scope for V1, but R-7 marks it HIGH risk. Confirm V2.
3. **Eval harness (PF-GAP-12)** — No per-agent eval suite. PRD §13.6 mentions quality gates but no implementation. Confirm V2.
4. **Vector memory (AR-GAP-14)** — `MemoryHandle.search` throws `NoMemoryDriverError`. V1 ships no driver. Confirm V2.
5. **Cookie auth in prod (PF-GAP-05)** — Web sends cookies; Fastify doesn't read them in prod. V1 falls back to bearer (which works). Confirm 🟡 V1.1 or escalate.
6. **TypeScript snippets (AR-GAP-10)** — `typescript_code` field round-trips but engine never executes. Field shape preserved for V2 sandbox. Confirm V2.
7. **Run-engine unification (AR-GAP-17)** — Two run engines (code vs manifest). Audit recommends collapse. Confirm V2.

---

*This catalog is the single artifact that should be read end-to-end at the start of every V1.1 planning meeting. Detail lives in slices 01/02/03. Backlog lives in `docs/USE_CASES.md`. Designs land in `docs/tech-design/<module>.md`.*
