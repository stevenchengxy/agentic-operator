# Agentic Operator — Use Cases Backlog (V1)

> Unified backlog merging UX use cases (slice 01 § 4) + AR-GAP items (slice 02 § 12) + PF-GAP items (slice 03 § 15). Every use case has a stable ID, a persona, a click path or trigger, source IDs, and a status.

**Companion:** `docs/PRODUCT_CATALOG.md` (master index of every feature by category).

## Legend

| Glyph | Status | Meaning |
|---|---|---|
| ✅ | V1 shipped | Works today; tests pass; citable file:line; persona journey reproducible |
| 🟡 | V1.1 ready | Clear path; small effort (hours to days); listed in AR-GAP or PF-GAP |
| 🔵 | V2 vision | Requires design RFC, schema migration, or new sub-system |

**ID scheme:**
- `UC-V1-NN` — V1 shipped
- `UC-V11-NN` — V1.1 ready-to-build
- `UC-V2-NN` — V2 vision

---

## 1. ✅ V1 shipped — works today

### 1.1 Workflow Designer (Liu Wei) — 14 use cases

| ID | UX | Use case | Click path | Source IDs |
|---|---|---|---|---|
| UC-V1-01 | U1.1 | View live KPI strip (runs / events / errors / pending / spend) | `/dashboard` | FR-PORT-1, P2-FE-07 |
| UC-V1-02 | U1.2 | See RAAS funnel collapse across 8 stages | Dashboard → Stage funnel | FR-PORT-1 |
| UC-V1-03 | U1.3 | Click active run → arrive at run detail | Dashboard → Active runs table | FR-PORT-1, P2-FE-07 |
| UC-V1-04 | U1.4 | Open DAG canvas of deployed workflow | `/workflows` | FR-PORT-3, P2-FE-08 |
| UC-V1-05 | U1.5 | Select node → see in/out edges highlighted | Workflows → click node | P2-FE-08 |
| UC-V1-06 | U1.6 | Toggle Edit mode (DraftBanner + EditToolbar) | Workflows → "Edit workflow" | P3-FE-01 |
| UC-V1-07 | U1.7 | Add a new agent via manifest upload wizard | Workflows → "Import manifest" (6 steps) | P2-FE-17, AR-DEP-03, PF-IMP-01..08 |
| UC-V1-08 | U1.8 | Save workflow edit → manifest commits + new version row | Workflows → Edit → "Save" | P3-FE-01, FR-OS-12 |
| UC-V1-09 | U1.9 | List agents in tenant + filter by actor (Agent/Human) | `/agents` → SearchInput + FilterChip | P2-FE-09 |
| UC-V1-10 | U1.10 | Click agent → see config/io/code/versions/runs in 5 tabs | `/agents/[id]` | P2-FE-09 |
| UC-V1-11 | U1.11 | Test-run any code or manifest agent and watch it complete | Agent detail → "Test run" | D-4, P2-FE-18, AR-RUN-06 |
| UC-V1-12 | U1.12 | See synthetic-vs-real distinction (TEST badge in 4 places) | Dashboard / Runs / Agents / Run detail | D-8, P2-FE-18, AR-RUN-06 |
| UC-V1-13 | U1.13 | Jump from run back to agent that produced it | Run detail → "Open agent" header button | D-7 |
| UC-V1-14 | U1.14 | Re-emit a run's trigger event to recreate scenario | Run detail → "Replay" | P3-FE-06, AR-EVT-03 |

### 1.2 AI Engineer (Chen Mengjie) — 5 use cases

| ID | UX | Use case | Click path | Source IDs |
|---|---|---|---|---|
| UC-V1-15 | U1.17 | Edit ontology in-portal and save back to manifest | Agent detail → "Edit" → EditConfigTab → Save | P3-FE-01 |
| UC-V1-16 | U1.18 | Edit code-agent TS source in Monaco and deploy | Agent detail → Code tab → "Edit" → tar+POST | P3-FE-02, AR-DEP-01 |
| UC-V1-17 | U1.19 | Read run logs via SSE tail (live follow) | Run detail → logs tab | FR-OBS-2, P2-FE-10, AR-RUN-04 |
| UC-V1-18 | U1.20 | Inspect run input + output side-by-side | Run detail → io tab | P2-FE-10 |
| UC-V1-19 | U1.21 | See agent's code in context of one of its runs | Run detail → agent tab | D-7, P2-FE-10 |

### 1.3 Platform Operator (Ops) — 7 use cases

| ID | UX | Use case | Click path | Source IDs |
|---|---|---|---|---|
| UC-V1-20 | U1.15 | Resolve a JD-review human task | `/tasks` → row → primary action | P2-FE-12, AR-INN-03 |
| UC-V1-21 | U1.16 | Snooze a task for 1h | `/tasks` → row → "Snooze" | P2-FE-12 |
| UC-V1-22 | U1.22 | Filter runs by failed status across all agents | `/runs` → status FilterChip "Failed" | P2-FE-10 |
| ~~UC-V1-23~~ | U1.23 | _Demoted to 🟡 V1.1 — see UC-V11-17 / AR-GAP-01. Chart shows zero buckets because hook envelope unwrap is broken._ | _moved to § 2.2_ | _moved_ |
| UC-V1-24 | U1.24 | Inspect audit log entry with before/after diff | `/settings/audit` → expand row | P3-FE-05, FR-OS-8, AR-X-03, PF-OBS-03 |
| UC-V1-25 | U1.25 | Provision a new tenant via 4-step wizard | TenantSwitcher → "New tenant" | P3-FE-tenant, PF-API-TEN |
| UC-V1-26 | U1.26 | Promote a draft deployment to live | `/deployments` → row → "Promote" | FR-OS-7, P2-FE-14, AR-DEP-02 |
| UC-V1-27 | U1.27 | Rotate an API token (revealed once) | `/settings/tokens` → "Rotate" | NFR-SEC-2, P2-FE-15, PF-AUTH-02 |

### 1.4 Cross-persona — 3 use cases

| ID | UX | Use case | Click path | Source IDs |
|---|---|---|---|---|
| UC-V1-28 | U1.28 | Switch active tenant from the sidebar | TenantSwitcher → tenant row | P2-FE-25, PF-WEB-02 |
| UC-V1-29 | U1.29 | Jump to any agent/run/event/task via ⌘+K | Global keydown | P2-FE-23 |
| UC-V1-30 | U1.30 | Toggle theme / density / accent at runtime | Tweaks panel (⌘⇧T) | P2-FE-16, P2-FE-20 |

### 1.5 End User (Wu Hao) — 1 use case (today; expanded in V1.1)

| ID | UX | Use case | Trigger | Source IDs |
|---|---|---|---|---|
| ~~UC-V1-31~~ | (implicit) | _Demoted to 🟡 V1.1 — channel.publish tool returns `{delivered:true}` synthetically; notification dispatcher is stubbed (FR-PORT-16 partial)._ | _moved to § 2.2_ | _moved_ |

### 1.6 RAAS workflow stages — 17 use cases (one per node)

Each node is a runnable production use case the platform must execute end-to-end. IDs map 1:1 to `AR-RAAS-01..17` in slice 02.

| ID | RAAS node | Step type | Triggers / emits | Source IDs |
|---|---|---|---|---|
| UC-V1-32 | 1-1 syncFromClientSystem | logic (Agent) | Trigger: incoming client sync | AR-RAAS-01 |
| UC-V1-33 | 1-2 manualEntry | manual (Human) | Operator inputs requisition | AR-RAAS-02 |
| UC-V1-34 | 2 analyzeRequirement | logic (Agent) | Emits: REQUIREMENT_PARSED | AR-RAAS-03 |
| UC-V1-35 | 3 clarifyRequirement + 3-2 requirementReClarification | logic + condition | Branches on clarity gate | AR-RAAS-04 |
| UC-V1-36 | 4 createJD + 5 jdReview | logic + manual | HITL: JD review | AR-RAAS-05, AR-INN-03 |
| UC-V1-37 | 6 assignRecruitTasks | logic (Agent) | Fan-out to recruiters | AR-RAAS-06 |
| UC-V1-38 | 7-1 publishJD + 7-2 manualPublish | tool + manual | Publishes to job boards | AR-RAAS-07 |
| UC-V1-39 | 8 resumeCollection | tool (channel) | Watches inbox/portal for resumes | AR-RAAS-08 |
| UC-V1-40 | 9-1 processResume + 9-2 resumeFix | logic + manual | HITL: resume cleanup | AR-RAAS-09, AR-INN-03 |
| UC-V1-41 | 10-1 ruleCheckerForClientResume | logic (Agent) | Emits: CLIENT_RULES_PASSED / CLIENT_RULES_FAILED (new in v1) | AR-RAAS-10 |
| UC-V1-42 | 10-2 matchResume | logic (Agent) | Was "10" pre-edit; renamed | AR-RAAS-11 |
| UC-V1-43 | 11-1 inviteInternalInterview + 11-2 interviewExecution | logic + manual | HITL: interview | AR-RAAS-12 |
| UC-V1-44 | 12 evaluateInterview | logic (Agent) | Emits: INTERVIEW_EVALUATED | AR-RAAS-13 |
| UC-V1-45 | 13 refineResume | logic (Agent) | Per-client formatting | AR-RAAS-14 |
| UC-V1-46 | 14-1 generateRecommendationPackage + 14-2 packageSupplement | logic + manual | Optional supplement step | AR-RAAS-15 |
| UC-V1-47 | 15 packageReview | manual (Human) | HITL: final review | AR-RAAS-16, AR-INN-03 |
| UC-V1-48 | 16 submitToClientPortal | tool (channel) | Terminal node | AR-RAAS-17 |

### 1.7 Platform operations — 3 use cases (implicit, no UX touch but tested)

| ID | Use case | Surface | Source IDs |
|---|---|---|---|
| ~~UC-V1-49~~ | _Demoted to 🟡 V1.1 — see UC-V11-19. Writes wrong `actions_v1.json` shape (object instead of array); every CLI-scaffolded tenant fails first deploy._ | _moved to § 2.3_ | _moved_ |
| UC-V1-50 | `agentic deploy [path]` ships tenant code as USTAR tarball | CLI → `/v1/tenant-code` | PF-CLI-02, AR-DEP-01 |
| UC-V1-51 | `agentic logs <run-id> --tail` follows SSE | CLI → `/v1/runs/:id/logs` | PF-CLI-03, AR-RUN-04 |
| UC-V1-52 | `/v1/stream`, `/v1/tenant-code`, `/v1/workflow` route modules registered in server.ts (was UC-V11-33; verified registered at `apps/api/src/server.ts:112-114`) | API mount | PF-GAP-11 (closed), PF-API-STR-01, PF-API-WF-03 |

**V1 shipped total: 49 use cases** (51 originally minus 3 demoted — UC-V1-23, UC-V1-31, UC-V1-49 — plus 1 promoted from V1.1 — UC-V11-33 → UC-V1-52).

---

## 2. 🟡 V1.1 ready-to-build

These have a defined path and small effort. Each is owned by a Wave-4 implementer.

### 2.1 UX additions (16 from `01 § 4.2`)

| ID | UX | Use case | Gap today | Suggested fix | Owner |
|---|---|---|---|---|---|
| UC-V11-01 | U2.1 | Wu Hao gets WeChat/email ping with signed task-resolution link | Notification dispatcher stubbed; signed-URL route exists but unwired (FR-PORT-16 partial) | Wire `@agentic/notifications` adapter (WeChat Work + AWS SES). Signed URL via JWT scope `task:resolve:<id>`. | Senior Full-stack |
| UC-V11-02 | U2.2 | Wu Hao submits corrected resume from signed URL | Server route + form scaffold needed; payload renderer exists | New `app/(public)/task/[token]/page.tsx` + `POST /v1/public/tasks/:token` | Senior Frontend |
| UC-V11-03 | U2.3 | Liu Wei diffs two test runs side-by-side | io tab shows one run only | "Compare" button on runs list with 2 checkboxes → 50/50 diff view | Senior Frontend |
| UC-V11-04 | U2.4 | Cmd-K "Emit event" command | Cmd-K only navigates | Write-action group: event-name autocomplete + JSON payload → `POST /v1/events` | Senior Frontend |
| UC-V11-05 | U2.5 | Real-time prompt-token + cost preview while editing ontology | EditConfigTab is static | Wire `tiktoken` for live "~340 tokens · ~$0.002 / call" chip | Senior Full-stack |
| UC-V11-06 | U2.6 | Hot-reload toast when CLI deploys land | `useTenantCode` polls; no toast | Listen for `deployment.created` SSE → toast "tenant code v0.0.123 active" | Senior Frontend |
| UC-V11-07 | U2.7 | Bulk-replay failed runs | Header button is UI-only | New `POST /v1/runs/replay-bulk {ids}` + row checkboxes | Senior Full-stack |
| UC-V11-08 | U2.8 | Pause LIVE stream subscription server-side | LIVE toggle freezes UI only | Send `pause` over SSE; server holds events per-session | Senior Full-stack |
| UC-V11-09 | U2.9 | Contextual health drilldowns from sidebar | Static labels in footer | Wire to `/health`; click → Panel overlay with 5-min timeline | Senior Frontend |
| UC-V11-10 | U2.10 | Per-tenant rate-limit override from Settings | Backend supports it; UI has no field | Add Billing → "Rate limit (req/min)" | Senior Frontend |
| ~~UC-V11-11~~ | U2.11 | _Promoted to 🔵 V2 — walking full ancestor chain + lateral siblings requires recursive CTE / O(n²) graph walk + frontend tree-renderer rebuild. See UC-V2-20._ | _moved to § 3.1_ | _moved_ |
| UC-V11-12 | U2.12 | Provider-error budget drilldown | `llm_provider_errors_total` ships; UI doesn't surface | Add "Provider errors" card to `/settings/usage` reading `/metrics` | Senior Frontend |
| UC-V11-13 | U2.13 | Persist edit-mode draft beyond session | `DraftPalette` is per-session | LocalStorage keyed by tenant+workflow; "Discard draft" button | Senior Frontend |
| UC-V11-14 | U2.14 | Validate manifest schema without deploying | Validate button is a no-op | Wire to `POST /v1/agents?dry-run=1` (route already supports) | Senior Full-stack |
| UC-V11-15 | U2.15 | Confirm before switching tenant with unsaved draft | Switch loses unsaved work | Hook `useTenantNavigate` → confirm modal if draft non-empty | Senior Frontend |
| UC-V11-16 | U2.16 | View read-only summary of closed task (Wu Hao) | Task disappears after resolve | Same signed-URL form with `?mode=read-only` | Senior Full-stack |

### 2.2 AI runtime fixes (8 from `02 § 12`)

| ID | Source | Use case | Owner |
|---|---|---|---|
| UC-V11-17 | AR-GAP-01 | Fix `/v1/usage` envelope unwrap in `useUsage` hook (chart shows zero buckets when data is present) | Senior Frontend |
| UC-V11-18 | AR-GAP-02 | Fix `POST /v1/agents` 500 on tenants with live `tenant_code` deployment (path resolution loses version segment) | Senior Full-stack |
| UC-V11-19 | AR-GAP-03 | Fix `agentic init` to write correct `actions_v1.json` shape (matches `ActionsManifestSchema`) | Senior Full-stack |
| UC-V11-20 | AR-GAP-04 | Remove extra "operator" row in `/tasks` view (dedupe between `/v1/tasks` and legacy `/v1/operator/tasks`) | Senior Frontend |
| UC-V11-21 | AR-GAP-06 | Hydrate `runs.emittedEvent` with `{id, name, subject}` join (UI currently shows raw `evt-` id) | Senior Full-stack |
| UC-V11-22 | AR-GAP-07 | Bump `runs_total` counter from manifest engine's `register.ts` finalize step | Senior Full-stack |
| UC-V11-23 | AR-GAP-09 | Wire `agent.tool_use` → tenant tool name in step engine `runAction` (instead of name-hint dispatch) | Senior Full-stack |
| UC-V11-24 | AR-GAP-12 | Per-agent `defaultProviders: ProviderId[]` on `BaseAgent` so failover loop is reachable from default caller path | Senior Full-stack |
| UC-V11-25 | AR-GAP-13 | Require tenant `definePrompt` for every `logic` action (or refuse-to-boot with clear error pointing at the missing prompt) | Senior Full-stack |
| UC-V11-26 | AR-GAP-16 | Wire real AWS Bedrock + GCP Vertex SDK adapters (currently `not_configured` stubs) | Senior Full-stack |
| UC-V11-27 | AR-GAP-18 | Remove `WEBHOOK_HMAC_SECRET_DEFAULT` fallback; require per-subscription secret; surface friendly error in Settings → Integrations | Senior Full-stack |

### 2.3 Platform fixes (12 from `03 § 15`)

| ID | Source | Use case | Owner |
|---|---|---|---|
| UC-V11-28 | PF-GAP-02 | Fix `POST /v1/agents` 500 (same as UC-V11-18, captured from platform angle) | Senior Full-stack |
| UC-V11-29 | PF-GAP-05 | Wire cookie auth on Fastify in prod (read same JWT, verify with `AUTH_SESSION_SECRET`, set `req.auth` before bearer parse) | Senior Full-stack |
| ~~UC-V11-30~~ | PF-GAP-07 | _Done in Wave 4 cleanup lane — `apps/web/app/_portal_legacy/` directory deleted (only reference was `vitest.config.ts` ignore pattern, harmless)._ | _shipped_ |
| ~~UC-V11-31~~ | PF-GAP-09 | _Done in Wave 4 cleanup lane — `apps/api/data/imports/` added to `.gitignore`; the 25 untracked `dpl-*` staging dirs are now ignored. Also added `data/test-artifacts/` and `data/test-logs/`._ | _shipped_ |
| UC-V11-32 | PF-GAP-10 | Implement `Idempotency-Key` enforcement (`idempotency_keys` table + check before insert in `/v1/events` + `/v1/agents/:name/invoke`) | Senior Full-stack |
| ~~UC-V11-33~~ | PF-GAP-11 | _Promoted to ✅ V1 — already registered at `apps/api/src/server.ts:112-114`. See UC-V1-52._ | _shipped_ |
| ~~UC-V11-34~~ | PF-GAP-14 | _Promoted to 🔵 V2 — full OTel requires operator-supplied collector, sampling strategy, W3C trace-context propagation across the Inngest boundary. See UC-V2-21._ | _moved to § 3.3_ |
| UC-V11-35 | PF-GAP-15 | Move `failRun` write inside a final `step.run("finalize", ...)` block (close the race window) | Senior Full-stack |
| ~~UC-V11-36~~ | PF-GAP-16 | _Promoted to 🔵 V2 — new sub-system: `dead_letter_runs` table + `GET /v1/dlq` route + "Retry / Drop" UI + retry semantics design. See UC-V2-22._ | _moved to § 3.3_ |
| UC-V11-37 | PF-GAP-17 | Promote `steps_run_ord_idx` to `uniqueIndex` (catch step engine bugs that double-insert) | Senior Full-stack |
| ~~UC-V11-38~~ | PF-GAP-01 + AR-GAP-01 | _Duplicate of UC-V11-17 (route already registered at server.ts:105; only the frontend `useUsage` hook envelope-unwrap remains). Track frontend half under UC-V11-17._ | _renumbered_ |
| UC-V11-39 | (cleanup) | Per-route audit-log emission audit — confirm every mutation route writes one `audit_log` row | Test architect + Senior Full-stack |

### 2.4 Demoted from V1 (CPA review)

| ID | Source | Use case | Owner |
|---|---|---|---|
| UC-V11-39a | UC-V1-23 demote | View per-day cost breakdown by agent + model. Today shows zero buckets because `useUsage` hook doesn't unwrap the v1 envelope shape. Fix path: see UC-V11-17. Source: AR-GAP-01. | Senior Frontend |
| UC-V11-39b | UC-V1-31 demote | Wu Hao internal-channel ping. Backbone (WeChat, email) is stubbed; `channel.publish` tool returns `{delivered:true}` synthetically. Path: notification dispatcher build per FR-PORT-16. Subsumed by UC-V11-01. | Senior Full-stack |
| UC-V11-39c | UC-V1-49 demote | `agentic init <slug>` writes wrong `actions_v1.json` shape (object instead of array per `ActionsManifestSchema`). Every CLI-scaffolded tenant fails first deploy. Subsumed by UC-V11-19. | Senior Full-stack |

### 2.5 New UCs from PD+PM use-case audit (Wave 3)

Source: `docs/wave-3-reviews/02-pd-pm-use-case-audit.md` § 2. Persona-journey gaps + UX-vs-backlog consistency defects.

| ID | UX | Use case | Gap today | Suggested fix | Owner | Source |
|---|---|---|---|---|---|---|
| UC-V11-40 | (new) | Drag a palette card onto the canvas while in edit mode | `DraftPalette` cards have `draggable` but the canvas `<div>` at `workflows/page.tsx:284-296` has no `onDragOver` / `onDrop`. Journey 2.1.1 "add a node between agents" doesn't complete. | Wire HTML5 drag-and-drop on the SVG canvas — `onDragOver` to allow, `onDrop` to snap to nearest column/lane in `LAYOUT`. | Senior Frontend | PD+PM § 2, DESIGN-G10 |
| UC-V11-41 | (new) | Chen Mengjie configures default + fallback model for an agent in Settings → Models | Settings → Models exists as a nav entry; no UC covers ConfigureModelDrawer / AddModelModal interactions from journey 2.2.3. | Wire `prefs.models` to `/v1/llm/keys` + agent config; surface "default provider" + "fallback chain" dropdowns. | Senior Full-stack | PD+PM § 2, journey 2.2.3 |
| UC-V11-42 | (new) | Ops dials a per-provider concurrency cap from Settings → Models | Backend `apps/api/src/services/llm.ts` accepts per-provider caps; Settings → Models has no field. Journey 2.3.1 calls for "Anthropic row → concurrency cap '8 → 4'". | Add numeric "Concurrency cap" input next to each provider row; POST `/v1/llm/providers/:id`; toast on confirmation. | Senior Full-stack | PD+PM § 2, AR-LLM-01 |
| UC-V11-43 | (new) | Ops sets a per-tenant monthly + daily cost cap from Settings → Billing | `tenant_budgets` table exists (FR-COST-2); no UI input form. UC-V1-23 covers viewing usage but not setting the cap. | Add Settings → Billing form: monthly USD cap, daily USD cap, optional per-agent override. POST `/v1/budgets`. Gateway `enforceBudget()` already reads the row. | Senior Frontend | PD+PM § 2, journey 2.3.3 |
| UC-V11-44 | (new) | TopBar LIVE/PAUSED toggle propagates through Dashboard, Events, Workflows | `tweaks.liveStream` is read in `TopBar` but shadowed by `useState(true)` in `dashboard/page.tsx:159` and hard-coded in `workflows/page.tsx:98`. Settings panel ↔ Dashboard ticker desync. | Wire `useTweaks().liveStream` through Dashboard/Events/Workflows so the chrome toggle actually freezes/resumes the relevant tickers. | Senior Frontend | PD+PM § 2, U1.30 |
| UC-V11-45 | (new) | TopBar user chip exposes "Sign out" + active session info | `topbar.tsx:25` user chip has no `onClick`, no menu. Mobile/shared-machine session leak. Maps to G6 in 01 § 5. | Add a simple anchor → `/sign-in?action=sign-out` (the auth route exists at `apps/web/app/(auth)/sign-in/page.tsx`). Display email + active tenant. | Senior Frontend | PD+PM § 2, G6 |
| UC-V11-46 | (new) | Dashboard "Deploy" + "Replay window" header buttons do something | `dashboard/page.tsx:284-289` renders both buttons with **no `onClick`**. Silent no-op = UX dishonesty. | Either wire or remove. Likely `Deploy` → `/portal/[tenant]/deployments`; `Replay window` → 1-hour bulk-replay scope chooser (ties to UC-V11-07). | Senior Frontend | PD+PM § 3.2 |
| UC-V11-47 | (new) | Migrate Event Tester view from legacy SPA to App Router | `apps/web/public/portal/views/event-tester.jsx` (~1500 LOC) is the operator UI for publishing tenant events + live SSE tail + causality DAG. Production App Router has `/events` but no equivalent publish surface — only UC-V11-04 (Cmd-K) emits. | Port `event-tester.jsx` → `apps/web/app/portal/[tenant]/(views)/event-tester/page.tsx` reusing `/v1/events/catalog` endpoint. | Senior Frontend | PD+PM § 2, memory `project_event_tester.md` |
| UC-V11-48 | (new) | Migrate Schema Editor view from legacy SPA to App Router | `apps/web/public/portal/views/schema-editor.jsx` (~700 LOC) is the manifest-issue tree + auto-fix surface. Production has the editor concepts baked into ImportManifestModal step 4 but no standalone editor. | Port to App Router OR explicitly defer to V2 + delete the SPA file (PF-GAP-07 cleanup pairing). The auto-fix logic in `schema-editor.jsx:153-225` is non-trivial. | Senior Frontend or Cleanup | PD+PM § 2, memory `project_schema_editor.md` |

### 2.6 New persona-journey UCs from CPA review (Wave 3)

Source: `docs/wave-3-reviews/01-product-architect-review.md` § 5. Persona-journey gaps the original 109 UCs missed.

| ID | Persona | Use case | Gap today | Suggested fix | Owner | Source |
|---|---|---|---|---|---|---|
| UC-V11-49 | Liu Wei | Roll back a live deployment within 30s after detecting failure | `POST /v1/deployments/:id/rollback` exists (PF-API-DPL-02); journey 2.1.3 covers promote but not rollback-recovery. | Surface an explicit "Rollback to previous" button on the live row in `/deployments`. Confirm dialog + toast on success. | Senior Frontend | CPA § 5.1 |
| UC-V11-50 | Liu Wei | Diff two workflow versions side-by-side | Slice 01 §1.1 row 8 mentions "Diff view between versions" (PRD §9.8) but the deployment history table doesn't surface a diff. | Pull both `workflow_versions.manifest_json` rows, render side-by-side JSON diff with line highlights. | Senior Frontend | CPA § 5.1 |
| UC-V11-51 | Liu Wei | Resume or cancel an in-flight manifest-import session | PF-IMP-06 documents the 423 LOCKED response with in-flight `deployment_id`; UI shows the error but no resume/cancel options. | Surface 423 in the modal with explicit "Resume" / "Cancel" buttons; `DELETE /v1/tenants/:slug/manifest-import/:dpl-id` already exists. | Senior Frontend | CPA § 5.1 |
| UC-V11-52 | Chen Mengjie | Tag an agent version as known-good (with name) | Versions are auto-created on save; no "tag this as a known-good version" affordance. Chen iterates 10 times, can't find last-good version. | Add optional `tag` column to `agent_versions`; UI: versions tab → "Pin / name this version." | Senior Full-stack | CPA § 5.2 |
| UC-V11-53 | Chen Mengjie | Test run with model override | Test-run uses agent default. No "Test with model X" override to compare claude-sonnet-4-5 vs claude-haiku-4-5 on the same input. | Accept `?model=<id>` on `POST /v1/agents/:name/invoke?testRun=1`; UI: dropdown in test-run modal. | Senior Full-stack | CPA § 5.2 |
| UC-V11-54 | Chen Mengjie | Roll back tenant code to a previous version | `PF-API-TC-01` keeps previous versions on disk at `data/tenants/<slug>/<version>/`; no UI to roll back. | Deployments view → tenant_code rows → "Make live" action; backend wiring partial. | Senior Full-stack | CPA § 5.2 |
| UC-V11-55 | Ops | Per-token usage audit ("which token used X tokens?") | `api_tokens.last_used_at` exists; no per-token usage counter or per-token metric. Ops greps audit logs to chase leaks. | Add `tokens_total{token_id=…}` metric or counter column; Settings → Tokens → click row → "Recent usage." | Senior Full-stack | CPA § 5.3 (security-relevant) |
| UC-V11-56 | Ops | Revoke all tokens for a tenant (bulk) | UC-V1-27 rotates one token; no "scorched-earth" option for suspected leaks. | `POST /v1/tenants/:slug/tokens/revoke-all`; confirm dialog requires typing tenant slug. | Senior Full-stack | CPA § 5.3 |
| UC-V11-57 | Ops | Pause a misbehaving tenant (no new runs accepted) | If a tenant causes runaway cost, only `tenant.archive` exists (too aggressive). | Add `paused` flag on `tenants`; auth plugin rejects with 503 until unpaused; sidebar shows orange badge. | Senior Full-stack | CPA § 5.3 |
| UC-V11-58 | Ops | View per-tenant rate-limit hits over time | `AGENTIC_RATE_LIMIT_PER_MIN` enforces 429s; no dashboard surface. | Pull `http_requests_total{status=429,tenant=…}` Prometheus series; render in Settings → Usage. | Senior Frontend | CPA § 5.3 |
| UC-V11-59 | Wu Hao | Opt out of receiving signed-URL pings | Once notifications ship (UC-V11-01), there's no opt-out; WeChat-only or off-completely should be possible. | Needs `user_notification_preferences` table or per-user config; UI in signed-URL page. | Senior Full-stack | CPA § 5.4 |
| UC-V11-60 | Wu Hao | See a list of tasks they've resolved historically | Wu Hao sees only the open task. No history view. | Read-only list at signed URL; signed link valid 24h. | Senior Full-stack | CPA § 5.4 |
| UC-V11-61 | Wu Hao | Delegate / reassign a HITL task to another user | `tasks.awaiting_user_id` is nullable; no reassignment surface. | Reassign action on signed-URL page; surfaces in operator inbox. | Senior Full-stack | CPA § 5.4 |

**V1.1 ready total: 57 use cases** (39 originally − 3 promoted to V2 [UC-V11-11/-34/-36] − 2 completed in Wave 4 cleanup [UC-V11-30/-31] − 1 promoted to V1 [UC-V11-33] − 1 collapsed dup [UC-V11-38 → UC-V11-17] + 3 demoted-from-V1 rows [UC-V11-39a/b/c] + 9 new from PD+PM [UC-V11-40..48] + 13 new from CPA personas [UC-V11-49..61] = 57).

---

## 3. 🔵 V2 vision

These need a design RFC, a schema migration, or a new sub-system. Each is parked for V2 with a documented reason.

### 3.1 UX vision (10 from `01 § 4.3`)

| ID | UX | Use case | Why not V1.1 |
|---|---|---|---|
| UC-V2-01 | U3.1 | A/B test two prompt variants; dashboard shows winner with confidence interval | New `runs.experiment_id` + `agent_versions.experiment_arm` + traffic-splitter in gateway. RFC needed. |
| UC-V2-02 | U3.2 | Drag-and-drop create-from-scratch workflow builder | Net-new visual composition (auto-pack, snap-to-grid, route-finding). V1 explicit non-goal (PRD §5.2 #3). |
| UC-V2-03 | U3.3 | In-browser step-through debugger with breakpoints | Runtime needs DAP-like debug protocol + Inngest replay-by-step. PRD §5.2 #2 non-goal. |
| UC-V2-04 | U3.4 | Marketplace of pre-built agents (one-click install) | PRD §5.2 #6 non-goal. New discovery + signing + provenance service. |
| UC-V2-05 | U3.5 | Python runtime for code agents | PRD §5.2 #1 non-goal. Process boundary + IPC contract + Python tooling. |
| UC-V2-06 | U3.6 | Multi-region deployment with active-active SQLite/Postgres | PRD §5.2 #5 non-goal. Schema portable, but replication + leader-election is the lift. |
| UC-V2-07 | U3.7 | Native mobile portal | 1440 viewport pin. Responsive design = full design pass + token retro. |
| UC-V2-08 | U3.8 | Streaming LLM output token-by-token to the portal | PRD §5.2 #8 non-goal. SSE multiplexing per-run + new IO tab streaming widget. |
| UC-V2-09 | U3.9 | SAML/SSO + per-tenant identity providers | PRD §11 #10 non-goal. New auth path + major Settings → People rework. |
| UC-V2-10 | U3.10 | Right-click context menus on lists | Touches every list view + needs `Menu` primitive. Audit §8 #10 out-of-scope. |

### 3.2 AI runtime vision (4 from `02 § 12`)

| ID | Source | Use case | Why not V1.1 |
|---|---|---|---|
| UC-V2-11 | AR-GAP-08 | Wire async invoke via Inngest for `POST /v1/agents/:name/invoke?async=1` (today returns 501) | Need API-side send/queue-tracking and run-row pre-creation; the Inngest function for code agents IS registered but the queue path is unwired. |
| UC-V2-12 | AR-GAP-10 | Execute `typescript_code` snippets via sandbox | Zero sandboxing today (audit §11). Needs vm2/isolated-vm/wasm runtime + security model. |
| UC-V2-13 | AR-GAP-11 | Multi-turn loop for manifest agents (currently single-shot) | Today only code agents have the tool-use loop. V2 collapse into unified run engine. |
| UC-V2-14 | AR-GAP-14 | Vector memory driver registered (SQLite-VSS self-host, pgvector cloud, Qdrant plug-in) | `MemoryHandle.search` throws `NoMemoryDriverError`. Driver contract exists; backend needs build. |
| UC-V2-15 | AR-GAP-15 | Gateway-level JSON-output enforcement + repair loop | Code agents have `outputSchema` repair; manifest path has none. Lift the repair into the gateway. |
| UC-V2-16 | AR-GAP-17 | Collapse the two run engines (`packages/agents/run-engine.ts` + `packages/runtime/register.ts`) into one | Audit §11 recommends. Refactor into a single `RunEngine` taking `AgentSpec`. |

### 3.3 Platform vision (3 from `03 § 15`)

| ID | Source | Use case | Why not V1.1 |
|---|---|---|---|
| UC-V2-17 | PF-GAP-12 | Eval harness — `data/evals/<tenant>/<agent>/*.jsonl` set + `pnpm eval` runner that scores via gateway | New sub-system. PRD §13.6 mentions but no implementation. |
| UC-V2-18 | PF-GAP-13 | Worker isolation for tenant code (worker-thread or subprocess sandbox per tenant) | PRD §11 explicit V1 non-goal but R-7 HIGH risk. RFC + IPC contract needed. |
| UC-V2-19 | (cross-cutting) | Postgres path as alternative to SQLite (single binary, but for cloud deployments) | Schema is portable; pgvector tie-in with UC-V2-14; design lift around connection pooling + migration story. |

### 3.4 Promotions from V1.1 (CPA review — lift larger than slice claimed)

| ID | Source | Use case | Why not V1.1 |
|---|---|---|---|
| UC-V2-20 | UC-V11-11 promote | Visualize full ancestor + lateral-sibling trace tree of multi-step workflow run | `runs.parent_run_id` only captures parent/child. Full ancestor walk needs either (a) recursive CTE (SQLite supports; codebase doesn't use) or (b) JS graph-walk O(n²) on long chains; plus frontend tree renderer rebuild. RFC + schema additions needed. |
| UC-V2-21 | UC-V11-34 promote (PF-GAP-14) | OpenTelemetry instrumentation across Fastify + gateway + Inngest | Real OTel requires operator-supplied collector, sampling strategy, and W3C trace-context propagation across the Inngest boundary (no native support). Multi-day effort + RFC + Docker compose changes. |
| UC-V2-22 | UC-V11-36 promote (PF-GAP-16) | DLQ for orphaned runs — `dead_letter_runs` table + `GET /v1/dlq` + "Retry / Drop" UI | Fresh sub-system with its own state machine: new table, new endpoint, new view, retry semantics design (idempotency, max-retries, partial-step replay). Not a V1.1 1-day fix. |

**V2 vision total: 22 use cases** (19 originally + 3 promoted from V1.1).

---

## 4. Backlog totals

(Revised post-Wave 3 reviews + Wave 4 cleanup. See `docs/wave-3-reviews/01-product-architect-review.md` § 2 + `02-pd-pm-use-case-audit.md` § 2 for the source of truth.)

| Status | Count | Δ from original 109 |
|---|---|---|
| ✅ V1 shipped | 49 | −3 demoted (UC-V1-23, UC-V1-31, UC-V1-49) +1 promoted (UC-V11-33 → UC-V1-52) |
| 🟡 V1.1 ready | 57 | −3 promoted-to-V2 (UC-V11-11/-34/-36) −2 done in Wave 4 (UC-V11-30/-31) −1 promoted-to-V1 (UC-V11-33) −1 collapsed-dup (UC-V11-38 → UC-V11-17) +3 demoted-from-V1 (UC-V11-39a/b/c) +9 new from PD+PM (UC-V11-40..48) +13 new from CPA personas (UC-V11-49..61) |
| 🔵 V2 vision | 22 | +3 promoted (UC-V11-11 → UC-V2-20, UC-V11-34 → UC-V2-21, UC-V11-36 → UC-V2-22) |
| **Total** | **128** | +19 from new persona/journey gaps surfaced in Wave 3 |

---

## 5. Wave 3 + Wave 4 punch list

Wave 3 reviewers triage; Wave 4 engineers execute. The mapping:

### 5.1 By owner

**Senior Full-stack (backend-heavy):**
UC-V11-01, UC-V11-05, UC-V11-07, UC-V11-08, UC-V11-14, UC-V11-16, UC-V11-18, UC-V11-19, UC-V11-21, UC-V11-22, UC-V11-23, UC-V11-24, UC-V11-25, UC-V11-26, UC-V11-27, UC-V11-28, UC-V11-29, UC-V11-32, UC-V11-33, UC-V11-34, UC-V11-35, UC-V11-36, UC-V11-37, UC-V11-38

**Senior Frontend (web-heavy):**
UC-V11-02, UC-V11-03, UC-V11-04, UC-V11-06, UC-V11-09, UC-V11-10, UC-V11-11, UC-V11-12, UC-V11-13, UC-V11-15, UC-V11-17, UC-V11-20

**Cleanup engineer:**
UC-V11-30, UC-V11-31

**Test Architect:**
UC-V11-39 (audit emission)

### 5.2 By priority (suggested)

**P1 — production blockers (must be in V1.1):**
UC-V11-29 cookie auth in Fastify, UC-V11-33 register `/v1/stream` + `/v1/workflow` + `/v1/tenant-code` (CLI `agentic events tail` currently 404s), UC-V11-18 = UC-V11-28 fix `POST /v1/agents` 500, UC-V11-19 fix `agentic init` scaffold (every new tenant fails first deploy without manual edit).

**P2 — credibility (operator embarrassment if shipped without):**
UC-V11-17 + UC-V11-38 fix `/v1/usage` end-to-end (Settings → Usage shows zero buckets), UC-V11-20 remove extra "operator" row in Tasks, UC-V11-21 hydrate `emittedEvent` name (UI shows `evt-` id today), UC-V11-22 bump `runs_total` from manifest engine (dashboards underreport), UC-V11-27 remove webhook default-secret fallback.

**P3 — operator power-tools (high-leverage):**
UC-V11-03 diff runs, UC-V11-04 Cmd-K emit event, UC-V11-07 bulk replay, UC-V11-13 persist drafts, UC-V11-12 provider errors card.

**P4 — polish + observability:**
Everything else in V1.1.

---

## 6. Acceptance test coverage map

Cross-reference to `apps/api/test/tc-*.test.ts` + `apps/web/e2e/*.spec.ts`. Use this for the Wave 5 test sweep.

| Use case | Existing test | Status |
|---|---|---|
| UC-V1-01..03 (Dashboard) | `apps/web/test/visual/dashboard.spec.ts` | ✅ |
| UC-V1-04..06 (Workflows) | `apps/web/test/visual/workflows.spec.ts` + `apps/api/test/tc-workflow-save.test.ts` | ✅ |
| UC-V1-07 (Manifest import) | `apps/api/test/tc-manifest-import.test.ts` (validate + commit + reconcile) | ✅ |
| UC-V1-09..13 (Agents) | `apps/web/test/visual/agents.spec.ts` + `apps/api/test/tc-agent-invoke.test.ts` | ✅ |
| UC-V1-11 (Test run) | `apps/api/test/tc-test-run.test.ts` + manifest fallback test | ✅ |
| UC-V1-14 (Replay) | `apps/api/test/tc-event-replay.test.ts` | ✅ |
| UC-V1-15..16 (Edit + deploy) | `apps/api/test/tc-tenant-code-deploy.test.ts` | 🟡 (covers happy path; UC-V11-18 needed for full coverage) |
| UC-V1-17 (SSE logs) | `apps/api/test/tc-runs-logs-sse.test.ts` | ✅ |
| UC-V1-20..21 (Tasks) | `apps/api/test/tc-tasks.test.ts` | ✅ |
| UC-V1-23 (Usage) | (none — see UC-V11-17 + UC-V11-38) | ❌ blocked |
| UC-V1-24 (Audit) | `apps/api/test/tc-audit.test.ts` | ✅ |
| UC-V1-25 (Tenant wizard) | `apps/api/test/tc-tenants.test.ts` | ✅ |
| UC-V1-26 (Deployment promote) | `apps/api/test/tc-deployments.test.ts` | ✅ |
| UC-V1-27 (Token rotate) | `apps/api/test/tc-api-tokens.test.ts` | ✅ |
| UC-V1-29 (Cmd-K) | (none — UC-V11-04 will add) | 🟡 |
| UC-V1-32..48 (RAAS stages) | `apps/api/test/tc-raas-workflow.test.ts` (single happy-path) | ✅ partial |
| UC-V11-01..16 (V1.1 UX) | (mostly none) | ❌ to write in Wave 5 |
| UC-V11-17..39 (V1.1 fixes) | (each gap has an audit cite but not all have tests) | ❌ to write in Wave 5 |

**Wave 5 mandate:** Every UC-V1-* must have a passing test. Every UC-V11-* must have a failing-then-passing test (TDD on the gap fix). Coverage gates in CI catch any regression.

---

## 7. Source mapping

| Use-case prefix | Source slice | Source section |
|---|---|---|
| U1.* (referenced) | `docs/catalog/01-product-design-catalog.md` | § 4.1 — v1 shipped |
| U2.* (referenced) | `docs/catalog/01-product-design-catalog.md` | § 4.2 — v1.1 ready |
| U3.* (referenced) | `docs/catalog/01-product-design-catalog.md` | § 4.3 — v2 vision |
| AR-AK / AR-LLM / AR-INN / AR-MEM / AR-TOOL / AR-RUN / AR-EVT / AR-DEP / AR-COST / AR-RAAS / AR-X | `docs/catalog/02-ai-runtime-catalog.md` | §§ 1-11 |
| AR-GAP-* | `docs/catalog/02-ai-runtime-catalog.md` | § 12 |
| PF-TOP / PF-MR / PF-API / PF-DB / PF-MIG / PF-AUTH / PF-STO / PF-IMP / PF-CLI / PF-WEB / PF-BUILD / PF-CI / PF-OBS / PF-ENV | `docs/catalog/03-platform-catalog.md` | §§ 1-14 |
| PF-GAP-* | `docs/catalog/03-platform-catalog.md` | § 15 |
| FR-* / NFR-* / P*-* | `docs/PRD.md` + `docs/IMPLEMENTATION.md` + `docs/audits/p*-status.md` | various |
| D-* | `docs/DESIGN.md` | various |

---

## 8. How to add a new use case

1. Choose the right status bucket (✅ shipped / 🟡 v1.1 / 🔵 v2).
2. Pick the next free ID (e.g. UC-V11-40 if you're adding a new V1.1 item).
3. Cite at least one source ID from `PRODUCT_CATALOG.md` (AR-*, PF-*, U1/U2/U3.*, FR-*, NFR-*).
4. State persona, click path / trigger, and (for 🟡) a one-line fix suggestion.
5. Add an owner (Senior Frontend / Senior Full-stack / Test Architect / Cleanup engineer / RFC needed).
6. For 🟡 items, register the matching tech-design doc in `docs/tech-design/<module>.md`.

---

*This backlog is the contract between Product, Architecture, Engineering, and QA for V1.1. Every change to it must be reflected in `PRODUCT_CATALOG.md` if a new feature group emerges, and every commit citing one of these IDs gets traceability into the source slice.*
