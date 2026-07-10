# PRD — Agentic Operator

## 1. Document control

| Field | Value |
|---|---|
| Version | 1.0-DRAFT |
| Date | 2026-05-19 |
| Status | DRAFT for review |
| Supersedes | [agentic-operator_v1_1/docs/PRD.md](../agentic-operator_v1_1/docs/PRD.md) |
| Authors | Synthesized from specialist audits 01–04 |
| Companion docs | [DESIGN.md](DESIGN.md) (how), [IMPLEMENTATION.md](IMPLEMENTATION.md) (when/where) |

### Change log
- 1.0-DRAFT (2026-05-19) — Initial post-audit synthesis.

### Conventions
- Requirement IDs: `FR-{SURFACE}-{ord}` for functional, `NFR-{CATEGORY}-{ord}` for non-functional.
- Surfaces: `PORT` (portal), `API`, `RT` (runtime), `OS` (Agent OS primitives), `OBS` (observability).
- Every requirement cites its source audit (#1 product design, #2 backend, #3 AI runtime, #4 Agent OS readiness).
- "v1" means the production launch covered by [IMPLEMENTATION.md](IMPLEMENTATION.md) Phases 0–4.

---

## 2. Vision & elevator pitch

### Vision
Agentic Operator is the **operating system for LLM agents and workflows**: one place where a domain expert composes agents from declarative JSON, an AI engineer drops in TypeScript when the prompt is not enough, and a platform operator runs both safely against the same durable, observable, multi-tenant runtime. The platform owns the boring-but-hard parts — retries, replay, ledgering, multi-tenant isolation, LLM gateway, cost attribution, observability — so users only write the parts that are unique to their domain.

### Elevator pitch
**Agentic Operator turns a JSON manifest or a TypeScript class into a durable, observable, multi-tenant LLM workflow without writing a single line of orchestration code.**

---

## 3. Problem statement

Building production agentic workflows today forces teams to choose between three unhappy paths:

1. **Hand-rolled glue on Inngest/Temporal.** Durable, but the team rebuilds the LLM gateway, prompt assembly, tool dispatch, tenant isolation, and observability for every project. Six months to first runnable agent.
2. **LangGraph / AutoGen / Crew.** Fast to a demo, but no durable execution, no multi-tenant story, no real audit trail, no deployment surface. Production-ready means rebuilding the platform layer.
3. **A SaaS provider (Vellum, Restack, etc.).** Production-ready, but vendor-locked, opaque, and forces the team's domain logic into someone else's editor and DSL.

Agentic Operator is **self-host-first, code+config dual-authored, durable-by-default**. It sits between Inngest (durable runtime) and LangGraph (agent abstraction), giving teams the platform plumbing for free while keeping the agents in their own repo, on their own infra, expressible in either JSON or TypeScript.

**Differentiation thesis** (per [Audit #4 §12](audits/04-agent-os-readiness.md)): the dual-authoring story (`manifest` JSON ↔ `code` TypeScript with a shared runtime contract) is the wedge. Workflow designers compose graphs in JSON without engineering. AI engineers add code-defined agents and custom tools in the same workspace without leaving for a different platform. The portal observes both as one.

---

## 4. Target users & personas

### 4.1 Workflow Designer — "Liu Wei", delivery manager

**Background**: Leads delivery on a recruitment-as-a-service contract. Knows the business process cold. Reads JSON; does not write TypeScript.

**Goals**: Author and maintain the 20–30 workflow nodes that codify the team's standard delivery process. Ship a new client variant in an afternoon.

**Pain today**: The "workflow" is a tribal Notion page; engineers translate it into one-off code monthly.

**Day in the life with Agentic Operator**:
> Liu opens the **Workflows** view, drags a new node into the graph between `analyzeRequirement` and `createJD`, fills in `name`, `description`, `trigger`, `triggered_event`, and a placeholder `tool_use` referring to a generic LLM call. He runs **Test run** on a real REQ; the run completes in 3.2s; he approves and clicks **Deploy**. The node is live for the tenant in <5 minutes, end-to-end, without an engineering ticket.

### 4.2 AI Engineer — "Chen Mengjie"

**Background**: Hired to make the agents actually work — better prompts, custom tools, eval harnesses.

**Goals**: Iterate on agent prompts and tools in <60 seconds per cycle. Write code agents when the manifest model isn't expressive enough.

**Pain today**: Switching between LangGraph local scripts (no durability, no audit) and ad-hoc production patches.

**Day in the life**:
> Chen opens the **Agents** detail for `matchResume`, edits the `ontology_instructions` and adds a new tool definition. Hits **Test run**; the run streams in the side panel. Iterates 8 times on the prompt. Opens the **Code** tab on `processResume` and edits the TypeScript class for a multi-step tool-use loop. Commits the change to the tenant's `data/tenants/raas/src/agents/` directory; the platform hot-reloads; he keeps iterating. All runs are durable, traceable, and replayable.

### 4.3 Platform Operator — "Ops"

**Background**: Runs the cluster, owns the SLOs, attends the page when something breaks.

**Goals**: One pane of glass. Per-tenant cost caps. Clear runbook for incidents.

**Pain today**: Inngest dashboard + Grafana + SQL queries to reconstruct an incident.

**Day in the life**:
> Ops gets paged: `LLM rate-limited (429)` spike on tenant `raas`. Opens the **Runs** view filtered by status=failed; sees 12 retries on `evaluateInterview`. Clicks **Replay window**, drains the queue. Opens **Settings → Models** to lower the concurrency cap on the affected provider. Acknowledges the page in 8 minutes.

### 4.4 End User — "Wu Hao", recruiter

**Background**: Field user. Receives human tasks (resume re-upload, manual JD publish). Does not see the portal.

**Out of scope for v1 portal**, but the platform must serve them via:
- Email / WeChat task notifications
- A signed task-resolution URL (read-only summary + accept/reject action)
- A simple form for resume re-upload + structured field correction

---

## 5. Goals & non-goals

### 5.1 Goals (v1)
1. **Run real agents against real LLMs** with full durability, retry, and replay (Inngest under the hood).
2. **Dual authoring**: a workflow designer can ship a manifest agent in <30 min; an AI engineer can ship a code agent in <2 hr.
3. **Production multi-tenancy**: zero cross-tenant data leakage, per-tenant cost caps. (Per-tenant API keys / BYOK deferred to v1.1; v1 uses platform-managed keys.)
4. **Observability**: every run, every event, every step, every token attributable to a tenant + agent + model — viewable in the portal.
5. **Self-host first**: Dockerfile + one-command bootstrap on a single VPS; horizontal-scale-ready architecture.
6. **Pixel-fidelity portal** ported from the v1_1 prototype to a production TSX build, no design drift.

### 5.2 Non-goals (v1)
1. **No general-purpose Python runtime**. TypeScript only for code agents in v1.
2. **No in-browser agent debugger** (step-through breakpoints). Replay + logs only.
3. **No visual workflow builder for create-from-scratch composition**. v1 ships a workflow editor for **existing** manifests (graph + JSON view, save back to `workflow_v1.json` — see `FR-OS-12`); drag-drop creation of brand-new workflows is v2.
4. **No vector store / retrieval primitive built-in**. External services (Pinecone, etc.) integrate as tools.
5. **No multi-region deployment**. Single region, single Postgres/SQLite.
6. **No marketplace** of pre-built agents. Templates only.
7. **No sandbox isolation for tenant code** (deferred to v1.1; trust model = self-host operator vets tenants).
8. **No streaming LLM output to portal** (deferred to v1.1; full responses only in v1).

---

## 6. Success metrics

### 6.1 North-star metric
**TTFR (time-to-first-run)**: from "I have an idea for an agent" to "it's running in production"
- Manifest agent: ≤ 30 min (target), ≤ 60 min (must)
- Code agent: ≤ 2 hr (target), ≤ 4 hr (must)

### 6.2 Reliability
- ≥ 99% durable workflow completion under the default retry policy (3 retries, exponential backoff)
- < 1% of runs require manual intervention to unstick
- Mean time to detect a stuck run: < 5 min via portal

### 6.3 Cost transparency
- 100% of LLM spend attributable to `(tenant, agent, model, run_id)` quadruple
- Per-tenant daily/monthly cost cap enforced at gateway level (no spend beyond cap)
- Portal shows running tally to within 5 min lag

### 6.4 Activation / retention
- New tenant: first successful run within 1 hour of onboarding
- Active tenant: ≥ 1 run per business hour during business hours

### 6.5 Error budget
- 0.5% of v1 surface area can be "known broken" at launch (tracked as open bugs); rest is green

---

## 7. Functional requirements

### 7.1 Portal (FR-PORT-*) — covered in [IMPLEMENTATION Phase 2](IMPLEMENTATION.md#6-phase-2--production-frontend-weeks-45)

| ID | Requirement | Source |
|---|---|---|
| FR-PORT-1 | Portal compiled to TSX and bundled (no in-browser Babel-standalone); `agentic-dark` Monaco theme ported verbatim. | #1 §7 risk register |
| FR-PORT-2 | Design tokens (colors, fonts, spacing, radii) extracted to a single `tokens.css`; inline-style usage preserved in v1 (no Tailwind migration). | #1 §2 |
| FR-PORT-3 | All 9 nav views + 2 sub-views render at byte/pixel parity with v1_1 (Playwright screenshot diffs, ≤ 0.1% tolerance per IMPL §6.5). | #1 §9 acceptance checklist |
| FR-PORT-4 | Monaco editor served from npm package, not unpkg CDN. | #1 §7 (highest risk) |
| FR-PORT-5 | All 11 deltas (D-1..D-11) from the SPA preserved in the TSX port, except D-9 (`useLiveData` window-event hook) replaced by TanStack Query + SSE subscription. | #1 §6 |
| FR-PORT-6 | Tweaks panel `--density` control either wired to actual density tokens or removed. | #1 flag |
| FR-PORT-7 | All write actions (Approve task, Deploy agent, Save code, Test run) call real `/v1/*` endpoints and reflect server-confirmed state. | #4 §3 harness contract |
| FR-PORT-8 | Live data via SSE subscription (replaces synthesized data in `/api/spa/bootstrap`). | #2 critical #7 |
| FR-PORT-9 | Auth flow: cookie-based session, redirect to `/sign-in` if missing, propagated to API. | #2 critical #1 |
| FR-PORT-10 | Type-safety: all view code uses `@agentic/contracts` types. | #2 §11 |
| FR-PORT-11 | Toast/snackbar surface globally available; every failed mutation surfaces a user-visible toast (no silent failures). | #1 §8 #4 |
| FR-PORT-12 | Tenant in URL pathname: `/portal/:tenant/...` so deep links carry tenant context; switching tenant changes the URL. | #1 §8 #2 |
| FR-PORT-13 | A11y: `:focus-visible` styling, ARIA labels on icon-only buttons, keyboard navigation between focusable controls (WCAG 2.1 AA target). | #1 §3.1.1, §7 R-5 |
| FR-PORT-14 | Z-index ladder defined as named tokens (`--z-base`, `--z-overlay`, `--z-modal`, `--z-toast`, `--z-tooltip`) in `tokens.css`; no inline `z-index` outside the ladder. | #1 §7 R-11 |
| FR-PORT-15 | Workspace timezone setting honored by `fmtAgo` / `fmtTime` / log timestamps. | #1 §7 R-10 |
| FR-PORT-16 | Signed task-resolution URLs for end users (Wu Hao persona): one-time-token-secured GET + POST endpoints; email/WeChat notification dispatcher dispatches on task open. | #4 §3 (HITL row) |

### 7.2 API (FR-API-*) — covered in [IMPLEMENTATION Phase 0/1](IMPLEMENTATION.md#4-phase-0--stabilize-the-foundation-week-1)

| ID | Requirement | Source |
|---|---|---|
| FR-API-1 | Auth required on all `/v1/*` endpoints in every environment; `NODE_ENV` bypass removed. Transition flag `AUTH_MODE=dev` permitted only during P0–P2. | #2 critical #1 |
| FR-API-2 | Tenant isolation: `/v1/runs/:id`, `/v1/runs/:id/logs`, `/v1/agents`, `/v1/agents/:name/invoke` enforce membership; no `__system` fallback. | #2 critical #2 |
| FR-API-3 | All endpoints return the standard error envelope `{ ok: false, error: { code, message, hint? } }`. | #2 §6 |
| FR-API-4 | Pagination on all list endpoints (`limit`, `cursor`); responses always carry `nextCursor`. | #2 §3 |
| FR-API-5 | Idempotency keys honored on POST endpoints (`Idempotency-Key` header → dedupe within 24h window). | #2 §3 |
| FR-API-6 | Real-time stream endpoint `GET /v1/stream` (SSE) emits `run.*`, `event.*`, `task.*`, `deployment.*` events for the authenticated tenant. | #4 MUST-HAVE |
| FR-API-7 | All write endpoints emit audit-log rows. | #2 §13 |
| FR-API-8 | `@agentic/contracts` types are the single source of truth; API impl + portal both consume them. Drift fails CI. | #2 §3 |
| FR-API-9 | Rate limiting on POST endpoints (per-tenant, configurable, default 100 req/min). | #2 §9 |
| FR-API-10 | Webhook ingestion endpoint `POST /v1/webhooks/:source` validates HMAC signature, dispatches as Inngest event. | #4 MUST-HAVE |

### 7.3 Runtime (FR-RT-*) — covered in [IMPLEMENTATION Phase 0/1](IMPLEMENTATION.md#4-phase-0--stabilize-the-foundation-week-1)

| ID | Requirement | Source |
|---|---|---|
| FR-RT-1 | Manifest schema includes `input_data`, `ontology_instructions`, `tool_use`, `typescript_code`; transitional `.passthrough()` (locked strict by v1.1 with migration script). | #3 critical #1 |
| FR-RT-2 | Branching emit: agent run produces an `emit?: string` field; runtime selects the matching entry from `triggered_event[]`. Default: first entry only when agent returns no `emit`. | #3 critical #2 |
| FR-RT-3 | `logic` step assembles the LLM prompt as `system = <runtime prelude> + ontology_instructions; user = <input + action context>`. | #3 critical #3 |
| FR-RT-4 | `action.condition` field parsed and evaluated; matching actions execute, others skip with a `skipped` step row. | #3 critical #6 |
| FR-RT-5 | `run.model` records the actual model used by the gateway, not a hardcoded `mock-model-v1`. | #3 critical #5 |
| FR-RT-6 | Tool-use loop: `ChatMessage.content` accepts content-blocks; requests carry `tools[]`; responses carry `tool_calls[]`; runtime invokes tool, appends result, calls LLM again, up to `BaseAgent.maxSteps`. | #3 critical #4 |
| FR-RT-7 | Step engine new types: `condition`, `delay`, `subflow`. | #4 §10 |
| FR-RT-8 | Drizzle migrations run on API boot before any other initialization. | #2 critical #3 |
| FR-RT-9 | `bootstrapAll` is idempotent for deployments: only writes a new deployment row when manifest SHA differs; `AGENTIC_REBOOTSTRAP=force` env override. | #2 critical #3 |
| FR-RT-10 | `modelDir` configurable via `AGENTIC_MODELS_DIR` env var; no hardcoded absolute path. | #2 critical #4 |
| FR-RT-11 | Manifest agents and code agents both produce `runs` + `steps` + `events` ledger rows in the same shape. | #3 §11 |
| FR-RT-12 | Code agents register through `bootstrapCodeAgents` and execute via Inngest (no special inline path); a `?async=false` flag is available for sync request/response style on the same code path. | DESIGN §3.4 |

### 7.4 Agent OS primitives (FR-OS-*) — covered in [IMPLEMENTATION Phase 3](IMPLEMENTATION.md#7-phase-3--agent-os-primitives-weeks-68)

| ID | Requirement | Source |
|---|---|---|
| FR-OS-1 | Scheduled trigger: CRON expressions resolve to Inngest scheduled events; per-tenant time-zone. | #4 MUST-HAVE #1 |
| FR-OS-2 | Webhook trigger: per-workflow signed HTTP endpoint that dispatches an Inngest event. | #4 MUST-HAVE #2 |
| FR-OS-3 | Manual trigger via `POST /v1/agents/:name/invoke` (already exists; hardening). | #3 §3 |
| FR-OS-4 | Sub-agent invocation: an agent can `emit` an event that another agent in the same tenant consumes; correlation IDs propagate. | #4 §10 |
| FR-OS-5 | Platform-provided KV memory: `ctx.memory.get/set/delete(key, scope)` where scope ∈ `run` \| `subject` \| `tenant`. SQLite-backed in v1; pluggable in vNext. | #4 MUST-HAVE #5 |
| FR-OS-6 | Tenant code shipping: tenant code lives under `data/tenants/<slug>/src/`, hot-reloaded on file change in dev, dynamic-imported at boot in prod. | #4 §15 architectural refinement |
| FR-OS-7 | Versioning: agent + workflow versions referenced from a `deployments` row; rollback supported via `POST /v1/deployments/:id/rollback`. | #2 §13 |
| FR-OS-8 | Audit log: every deploy, every config change, every secret rotation appended to `audit_log` table with actor, IP, before/after. | #2 §13 |
| FR-OS-9 | Per-tenant cost cap: gateway pre-flight check fails LLM call with `cost_cap_exceeded` once daily/monthly threshold reached. | #4 MUST-HAVE #8 |
| FR-OS-10 | Per-tenant BYOK: encrypted-at-rest API keys per provider per tenant; gateway resolves at call time. (Deferred to v1.1 per IMPLEMENTATION P1 trade-off; v1 uses platform keys with cost cap.) | #2 §9 |
| FR-OS-11 | Package renames: `packages/agents` → `packages/agent-runtime`, `packages/agent-kit` → `packages/agent-sdk`. System agents move to `data/system-agents/`. | #4 §15 |
| FR-OS-12 | In-portal authoring: Workflow editor saves back to `models/<workflow>/workflow_v1.json`; Agent code editor saves to `data/tenants/<slug>/src/agents/<name>.ts`; both trigger typecheck + auto-deploy. | #1 §6, #4 §4 |
| FR-OS-13 | New trigger sources, new tool kinds, new step types are added by registering an adapter (no fork required). | DESIGN §18 |

### 7.5 Observability (FR-OBS-*) — covered in [IMPLEMENTATION Phase 4](IMPLEMENTATION.md#8-phase-4--productionize-week-9)

| ID | Requirement | Source |
|---|---|---|
| FR-OBS-1 | Structured logs (Pino) with `correlation_id`, `tenant_slug`, `agent_name`, `run_id` on every line. | #2 §8 |
| FR-OBS-2 | Per-run logs written to `data/logs/<run_id>.log` and exposed via `GET /v1/runs/:id/logs` with cursor-based tail. | #3 §10 |
| FR-OBS-3 | Prometheus-compatible metrics endpoint `GET /metrics`: `runs_total`, `run_duration_ms`, `tokens_total`, `cost_usd_total`, all labeled by `(tenant, agent, model, status)`. | #2 §8 |
| FR-OBS-4 | Run replay: `POST /v1/runs/:id/replay` reconstructs the run from the ledger and re-emits the trigger event (under a fresh `run_id`). | #4 MUST-HAVE |
| FR-OBS-5 | Cost view: portal Settings → Costs shows daily spend per tenant per agent per model, with cap line. | #4 §8 |
| FR-OBS-6 | Audit log view: portal Settings → Audit shows recent admin actions. | #2 §13 |

---

## 8. Non-functional requirements

### 8.1 Performance (NFR-PERF-*)

| ID | Requirement |
|---|---|
| NFR-PERF-1 | Run start latency p95 ≤ 300 ms (event arrived → first step row inserted). |
| NFR-PERF-2 | API `/v1/*` GET p95 ≤ 200 ms at 100 RPS per tenant. |
| NFR-PERF-3 | Portal initial render TTI ≤ 1.5 s on a 10 Mbps connection (cold). |
| NFR-PERF-4 | LLM gateway timeout default 60 s, configurable per provider. |
| NFR-PERF-5 | SSE stream latency: `run.update` event delivered to portal ≤ 1 s after DB write. |

### 8.2 Security (NFR-SEC-*)

| ID | Requirement |
|---|---|
| NFR-SEC-1 | Every API request authenticated; tenant scoping enforced at the query layer (no application-level fallback). |
| NFR-SEC-2 | Secrets at rest: BYOK API keys (v1.1) encrypted with libsodium `crypto_secretbox` using a master key from `AGENTIC_KMS_KEY` env (or KMS in prod); rotated every 90 days. Platform-managed keys in v1 stored in `AGENTIC_LLM_*_API_KEY` env vars only. |
| NFR-SEC-3 | Input validation: zod schema on every API boundary; reject on parse error with `bad_request`. |
| NFR-SEC-4 | No directory traversal: artifacts and logs accessed only via run_id-scoped paths. |
| NFR-SEC-5 | Webhook signatures: HMAC-SHA256, replay window 5 min, body required for verification. |
| NFR-SEC-6 | Portal auth: cookie-based session, httpOnly, sameSite=strict, secure in prod. |
| NFR-SEC-7 | No live keys in repo `.env`; rotate the ones currently committed at the workstation. (Audit #2 critical #5.) |

### 8.3 Reliability (NFR-REL-*)

| ID | Requirement |
|---|---|
| NFR-REL-1 | Workflow durability: Inngest dead-letter after N retries (configurable, default 5); dead-lettered runs visible in portal. |
| NFR-REL-2 | DB writes for run lifecycle (start, step, end) are transactional; partial failures roll back. |
| NFR-REL-3 | Graceful shutdown on SIGTERM: drain in-flight Fastify requests within 30 s, then exit. |
| NFR-REL-4 | Idempotency: re-running `bootstrapCodeAgents` or re-loading manifests does not create duplicate rows. |
| NFR-REL-5 | Backup: `data/agentic.db` snapshotted daily via `VACUUM INTO`; retention 30 days. |

### 8.4 Deployability (NFR-DEP-*)

| ID | Requirement |
|---|---|
| NFR-DEP-1 | Docker images for `apps/api`, `apps/web`, Inngest worker (or co-located worker). |
| NFR-DEP-2 | `docker-compose up` runs the full stack locally. |
| NFR-DEP-3 | Env-var contract documented in `.env.example`; no hardcoded paths or keys. |
| NFR-DEP-4 | Healthcheck endpoints: `GET /health` for API, `GET /api/health` for web. Both return `{ ok, version, dbReady, inngestReady }`. |
| NFR-DEP-5 | Migrations versioned, run on boot before serving traffic. |
| NFR-DEP-6 | Production target: Node 26 LTS, ESM-only packages, native modules pinned by ABI. |

---

## 9. UX requirements per view

Reference: [Audit #1 §4](audits/01-product-design-fidelity.md) for pixel-precise specs. PRD-level capabilities below.

### 9.1 Dashboard
- Live KPI strip: active runs, events/hr, errors/hr, pending tasks, tokens/hr (cost in $)
- Active runs table with TEST badge for test runs, click → run detail
- Live event ticker (SSE)
- Per-agent activity grid + RAAS funnel stages

### 9.2 Workflows
- Graph view: nodes = agents, edges = events
- Stage swimlanes (Intake → Submit)
- Click node → opens Agent detail
- "Import manifest" button (modal, paste JSON)
- "View live" toggle: nodes pulse on active runs (SSE)

### 9.3 Agents
- List/grid of agents with TEST count badges per agent
- Detail tabs: config, io, code, versions, runs
- **Test run** button (real backend invoke, not synthesized)
- Code tab: fullscreen Monaco; ontology, input_data, tool_use, runtime resizable splitter panes (audit #1 D-3/D-5/D-7/D-8 preserved)
- "View in graph" jumps to Workflows view

### 9.4 Runs
- List with status filter, agent filter, query, TEST badge
- Run detail tabs: timeline, logs, io, events, **agent** (full AgentCodeTab — audit #1 D-10)
- "Open agent" jump button
- Failed-run error panel with retry + replay

### 9.5 Events
- Event-type catalog with subscriber counts
- Live event stream (SSE)
- Drill-in: events of one type, recent payloads

### 9.6 Human tasks
- Inbox with priority sort
- Detail: task payload + accept/reject buttons (write to backend)
- Notification dispatcher (email/wechat) for end users

### 9.7 Logs
- File-backed log viewer with tail mode
- Syntax-colored levels (DEBUG/INFO/WARN/ERROR)

### 9.8 Deployments
- Per-agent version history
- Promote / rollback buttons
- Diff view between versions

### 9.9 Settings
- Theme/density/accent/tenant/data-source toggles (Tweaks panel)
- Model fleet management (CRUD on configured providers/models)
- Per-tenant cost caps
- Audit log view
- BYOK key management (post-v1.1)

---

## 10. Architectural constraints

These constraints flow into [DESIGN.md](DESIGN.md):

1. **Inngest as the durable runtime.** Not negotiable for v1.
2. **TypeScript + Node 26 + ESM-only.** No CJS in new code.
3. **SQLite + Drizzle for v1**, with a Postgres migration path (schema portable; no SQLite-specific functions).
4. **Two `AgentKind`s preserved**: `manifest` and `code`. Their runtime contract is unified ([DESIGN §6.3](DESIGN.md#63-unified-runtime-contract)).
5. **Monorepo via pnpm + Turborepo**; packages are workspace-aware.
6. **`@agentic/contracts` is the source of truth** for shapes shared between portal and API.
7. **Tenant code lives under `data/tenants/<slug>/`** (not under `packages/` or `tenants/`); discovered dynamically.
8. **System agents live under `data/system-agents/`** (not inside platform packages).
9. **Self-host first**, single-region in v1.

---

## 11. Out of scope for v1

Carried forward to v1.1 or later:

1. Multi-region replication
2. Hard sandbox isolation for tenant code (workers, vm2, etc.)
3. Streaming LLM output to portal
4. Vector store / retrieval primitive (use external tool integrations)
5. Marketplace of pre-built agents
6. Python runtime for code agents
7. In-browser step-through debugger
8. Drag-drop create-from-scratch workflow builder (the Phase 3 editor covers existing manifests only; net-new visual composition is v2)
9. Mobile portal
10. SAML/SSO (basic auth + JWT only in v1; SSO is post-launch)

---

## 12. Open questions / decisions needed before build

The cross-review pass (audits/05-cross-review-critique.md) resolved most of the questions originally raised during synthesis. The table below records the final state — DECIDED items are locked in DESIGN/IMPL and listed here for reader traceability; OPEN items still need an owner+deadline before Phase 0 lockdown.

### 12.1 Decided (linked to DESIGN/IMPL)

| # | Question | Decision | Reference |
|---|---|---|---|
| Q1 | Memory primitive shape | Platform-provided SQLite-backed KV in v1; external integration (vector store, Letta) wired as a tool in v2 | DESIGN §21 #3; PRD `FR-OS-5`; IMPL P3-DB-01..P3-RT-07 |
| Q3 | `__system` tenancy | Keep `__system` as a tenant row (no `agents.scope='system'` field in v1) | DESIGN §21 #1; IMPL P0-AUTH-04 |
| Q4 | Code-agent runtime path | **Path A**: sync inline AND Inngest registration both ship in v1; `?async=1` flag picks Inngest path | DESIGN §6.1/§6.3 (after fix #7); IMPL P1-RT-08 (NEW) |
| Q5 | Per-tenant BYOK timing | **v1.1**, not v1. v1 uses platform-managed `AGENTIC_LLM_*_API_KEY` env vars + per-tenant cost cap | PRD §5.1 #3, `FR-OS-10`; DESIGN §9.5 (now marked v1.1); IMPL has no BYOK task |
| Q6 | Real-time transport | SSE, not WebSocket | DESIGN §15.1; IMPL P1-API-01 |
| Q7 | Auth provider | In-house: cookie session via magic link (Resend email), bearer tokens for CLI; OIDC/SAML is v1.1 | DESIGN §17.1, §21 #6; IMPL P2-FE-19 |
| Q8 | Workflow editor scope in v1 | Graph + JSON editor for **existing** manifests; from-scratch composition is v2 | PRD §5.2 #3 (after fix #6); IMPL P3-FE-01 |
| Q12 | Production DB | SQLite + Drizzle for v1; Postgres-portable schema; Postgres migration in v1.1+ if needed | DESIGN §21 #2; IMPL §2.3 |
| Q13 | Tool-use loop iteration cap | `maxSteps ≤ 10` enforced platform-side; configurable per-agent (`BaseAgent.maxSteps`) | IMPL R-E-8; DESIGN §4.3 |
| Q14 | Rate limit defaults | 100 req/min per tenant default; per-route override via env | PRD `FR-API-9`; DESIGN §17.5 |

### 12.2 Still open

| # | Question | Owner | Deadline | Notes |
|---|---|---|---|---|
| Q2 | Manifest `.passthrough()` strict-mode cutover date | Tech Lead | Pre-v1.1 release | Field expected: 2026-08-01. Block: needs migration script for any 3rd-party manifest. |
| Q9 | Tenant onboarding flow | Product | Pre-Phase-3 | Self-serve sign-up vs operator-invitation only; affects landing page + sign-in UX. |
| Q10 | Logo / branding refresh | Product Designer | Pre-launch | Decide whether to keep prototype lime accent or commission new branding. |
| Q11 | Pricing & licensing | Product / Legal | Pre-launch | Apache 2.0 vs source-available vs SaaS-only; affects repo visibility + GTM. |
| Q15 | Error catalog standardization | Tech Lead | Pre-Phase-1 end | Centralized `ErrorCodes` enum in `@agentic/contracts` vs per-package catalogs. |

---

## 13. Release criteria

v1 launches when **all** of the following are green:

### 13.1 Correctness (from Phase 0)
- [ ] All audit-flagged correctness bugs fixed (FR-RT-1..5, FR-API-1..2, FR-RT-8..10)
- [ ] No `__system` fallback for tenant-scoped data
- [ ] Manifest agents round-trip all 4 enriched fields through DB

### 13.2 Real harness (Phase 1)
- [ ] Tool-use loop works end-to-end on a multi-turn agent (FR-RT-6)
- [ ] Real-time SSE stream delivers `run.update` events to the portal (FR-API-6)
- [ ] Portal `/api/spa/bootstrap` removed; all data flows through `/v1/*` (FR-PORT-8)
- [ ] Per-tenant cost cap enforced (FR-OS-9)

### 13.3 Production frontend (Phase 2)
- [ ] TSX build replaces Babel-standalone (FR-PORT-1)
- [ ] Monaco served from npm (FR-PORT-4)
- [ ] Playwright pixel-diff suite passes against v1_1 reference (FR-PORT-3)
- [ ] Auth flow E2E green (FR-PORT-9)

### 13.4 Agent OS primitives (Phase 3)
- [ ] Scheduled triggers work for `__system` smoke test (FR-OS-1)
- [ ] Webhook triggers work for at least one example workflow (FR-OS-2)
- [ ] Memory KV API usable from a manifest agent (FR-OS-5)
- [ ] Tenant code hot-reload demonstrated end-to-end (FR-OS-6)

### 13.5 Productionize (Phase 4)
- [ ] Docker images build and run via `docker-compose up` (NFR-DEP-1, NFR-DEP-2)
- [ ] Healthchecks return `{ok:true}` on a clean boot (NFR-DEP-4)
- [ ] SIGTERM drains within 30 s (NFR-REL-3)
- [ ] Migrations versioned and run on boot (FR-RT-8)
- [ ] Live OpenRouter/OpenAI/Google keys rotated, replaced with placeholder + per-tenant BYOK or platform key (NFR-SEC-7)
- [ ] Documentation: USER_GUIDE.md, PROMPTS.md, runbook current (Phase 4 cross-cutting)

### 13.6 Quality gates (continuous)
- [ ] `@agentic/contracts` is source of truth; drift fails CI
- [ ] Unit + integration test line coverage ≥ 70%
- [ ] E2E suite: manifest agent run, code agent run, human task resolve all green
- [ ] No `TODO` / `FIXME` in production code paths without an issue link

---

## 14. Risks & mitigations

| # | Risk | Severity | Mitigation | Owner |
|---|---|---|---|---|
| R-1 | Frontend pixel drift during TSX port | High | Playwright screenshot diffs against v1_1 reference; port view-by-view with QA gate | Product Designer + Frontend |
| R-2 | Monaco breaks under strict CSP or offline | High | Move to npm package in Phase 2; fall back to plain textarea if Monaco fails to load | Frontend |
| R-3 | Manifest schema migration breaks live runs | High | `.passthrough()` transitional period; migration script before strict; staged rollout | AI Architect + Tech Lead |
| R-4 | Auth changes lock out current dev workflow | Med | `AUTH_MODE=dev` opt-in for Phases 0–2; mandatory in Phase 3 | Fullstack |
| R-5 | Inngest API churn between dev/prod versions | Med | Pin Inngest CLI + SDK versions; track breaking changes in CI | Tech Lead |
| R-6 | Native module ABI mismatch on Node upgrade | Med | Pin `better-sqlite3` per Node version; CI matrix | Tech Lead |
| R-7 | Tenant code crashes the API process | High | **v1 trust model: self-host single-org or trusted-tenant SaaS only** — document explicitly in `docs/SECURITY.md` (new). Wrap dynamic-imported code in try/catch + Inngest function boundary; Inngest function boundary catches process-level errors and marks the run failed. **Not deployable to adversarial multi-tenant SaaS until worker isolation lands in v1.1 (Audit #4 §13 #15).** | AI Software Architect |
| R-8 | Live LLM keys committed at workstation | High | Rotate immediately; add `.env` to `.gitignore` if absent; pre-commit secret scanner | Ops |
| R-9 | Cross-tenant data leakage via `?tenant=` param | Critical | Membership check in middleware; integration tests covering every endpoint | Fullstack |
| R-10 | Tool-use loop runs away (cost explosion) | Med | Per-agent `maxSteps` enforced; per-tenant cost cap; alert at 80% of cap | AI Architect |

---

## 15. Appendix: glossary

| Term | Definition |
|---|---|
| **Agent** | A named unit of LLM-backed work. Two kinds: `manifest` (JSON-declared) and `code` (TypeScript class). Both produce runs against the same ledger. |
| **AgentKind** | `manifest` \| `code`. Determines how the platform discovers and dispatches the agent; runtime contract is unified. |
| **Manifest** | JSON spec of a workflow + its agents under `models/<workflow-slug>/workflow_v1.json`. Authoritative for the workflow graph. |
| **Workflow** | A named graph of agents + events. Versioned. Currently 1:1 with a manifest folder. |
| **Run** | One invocation of one agent in response to a trigger. Has `status`, `steps`, `tokensIn/Out`, `durationMs`, `subject`. |
| **Step** | One durable unit of work inside a run. Types: `logic` (LLM call), `tool` (named function), `manual` (human task). Future: `condition`, `delay`, `subflow`. |
| **Tool** | A named callable function exposed to the LLM. Defined via `defineTool({name, input_schema, impl})`. Lives in `tenants/<slug>/src/tools/` or the platform tool library. |
| **Ontology instructions** | Per-agent system prompt prelude. Defines vocabulary, business rules, hard guardrails. Prepended to every LLM call from that agent. |
| **Trigger** | What starts a run: `event` (Inngest), `schedule` (CRON), `webhook` (HTTP), `manual` (API call), `subAgent` (emit-and-await). |
| **Event** | Typed payload moving through the runtime. Ledger entry per emit. |
| **Task** | A human-gated work item produced by a `manual` step. Resolved via portal → API call → continues the workflow. |
| **Deployment** | A specific version of an agent/workflow currently live for a tenant. Has `version_id`, `actor`, `at`, `note`. |
| **Tenant** | Isolation boundary. Owns workflows, agents, runs, tasks, deployments, API keys, cost cap, audit log. `__system` is the platform's own tenant. |
| **Harness** | The platform-provided runtime, ledger, gateway, observability, scheduler, tool registry, IDE — everything the user does not have to write. |
| **Primitive** | A named platform abstraction (Agent, Run, Step, Tool, Trigger, …). The full list is the platform vocabulary. |
| **AgentOS** | Operating system for LLM agents: the platform provides authoring, deployment, runtime, observability, multi-tenancy as first-class capabilities. |
| **BYOK** | Bring Your Own Key. Per-tenant LLM provider API keys, encrypted at rest. |
| **Correlation ID** | Propagated across runs/events/tasks to trace one user-visible action through the system. |

---

**Companion docs:**
- [DESIGN.md](DESIGN.md) — system architecture, primitive schemas, package boundaries
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — phased plan, file-level tasks, acceptance gates
- [audits/01-product-design-fidelity.md](audits/01-product-design-fidelity.md) — design system + UI spec
- [audits/02-backend-implementation-review.md](audits/02-backend-implementation-review.md) — backend production-readiness
- [audits/03-ai-runtime-review.md](audits/03-ai-runtime-review.md) — runtime + LLM gateway review
- [audits/04-agent-os-readiness.md](audits/04-agent-os-readiness.md) — Agent OS readiness, MUST-haves, roadmap
