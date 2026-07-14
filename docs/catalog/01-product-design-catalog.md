# Product Design Catalog — Agentic Operator v1

> **Author:** Product Design (Phase 5 — Catalog)
> **Date:** 2026-05-21
> **Status:** v1 shipped (Phases 0-4 complete, 344 tests green)
> **Scope:** The complete UX surface as it exists today, the persona journeys it serves, the interaction patterns that hold it together, and the use-case backlog that should drive v1.1 + v2.
>
> **How to read this document.** Section 1 is an inventory — every URL, every primitive, every token. Section 2 walks each persona through their canonical sessions. Section 3 catalogs the cross-cutting patterns that show up in multiple views. Section 4 is the backlog, partitioned by maturity so the team knows what to commit to next. Sections 5 and 6 are forward-looking — the things the audit and launch report still flag as needing attention, and the acceptance bar the team should hold itself to.
>
> All references resolve back to the artifacts that built this: `docs/audits/01-product-design-fidelity.md` (the design specification), `docs/PRD.md` (the persona and functional contracts), `docs/USER_GUIDE.md` (the canonical happy path), and the `apps/web/app/portal/**` source tree.

---

## 1. UX surfaces inventory

This section enumerates every clickable, focusable, or addressable surface a user can touch in the v1 build. Coverage check: 9 top-level views + 4 detail/sub-routes + 24 shared primitives + 6 cross-cutting components.

### 1.1 Top-level navigation (9 views)

The sidebar groups views into three labels — **Run**, **Observe**, **Manage** — matching the operator mental model: "what's happening", "what should I look at", "what should I change". Every URL is tenant-scoped via `/portal/[tenant]/<view>` (P2-FE-25). All 9 views ship.

| # | View | URL pattern | Primary purpose | Data hooks consumed | Key interactions | State |
|---|---|---|---|---|---|---|
| 1 | **Dashboard** | `/portal/[tenant]/dashboard` | Single-pane home: live KPI strip, active runs table, event ticker, pending tasks, runtime status, RAAS stage funnel | `useRaasData`, `useRuns({limit:200})`, indirectly invalidated by `useStream` | Click KPI → no-op (static); click run row → run detail; click agent activity tile → agent detail; click task → task detail; LIVE toggle drives the ticker auto-advance | ✅ shipped (P2-FE-07) |
| 2 | **Workflows** | `/portal/[tenant]/workflows` | Read-only + editable DAG canvas of agents wired by events; in-portal manifest editor | `useRaasData` (stages/events fallback), `useDag` (live aggregates: `recentRunCount`, `isLive`, edge `active`), `useDeployManifest` | Click node → select; click edge → select event; "Edit workflow" → enters edit mode (draft state, banner, toolbar); "Import manifest" → 6-step wizard; "New workflow" → template chooser; save → `POST /v1/agents` | ✅ shipped (P2-FE-08, P3-FE-01) |
| 3 | **Agents** | `/portal/[tenant]/agents` and `/[id]` | List or grid of all agents; detail surface with 5 tabs; the home of "Test run" | `useRaasData`, `useInvokeAgent`, `useTenantCode` (deploy code edit) | List → grid card click → `/agents/[id]`; SearchInput + actor FilterChip filter; "Test run" → `POST /v1/agents/:name/invoke?testRun=1`; "Deploy agent" → 5-step wizard; "Import manifest"; splitter resize | ✅ shipped (P2-FE-09) |
| 4 | **Runs** | `/portal/[tenant]/runs` and `/[id]` | Per-run timeline + logs + IO + events + agent context; replay; failed-run error panel | `useRuns({limit:200})`, `useRun(id)`, `useReplayRun()`, `useRaasData` (agent + sampleLog), SSE invalidation | Row click → `/runs/[id]`; status FilterChip; "Replay" → `POST /v1/runs/:id/replay`; "Open agent" → `/agents/[id]`; tab switch (timeline/trace/logs/io/events/agent) | ✅ shipped (P2-FE-10, P3-FE-04, P3-FE-06) |
| 5 | **Events** | `/portal/[tenant]/events` | Live event ledger with 60-bucket histogram, type-filtered list, EventDetail (source / listeners / payload), replay | `useEvents`, `useRaasData` (event-type metadata) | Filter chips (category) + type list toggle; row click selects; "Replay event" wired but UI-only; click source agent → `/agents/[id]` | ✅ shipped (P2-FE-11) |
| 6 | **Human tasks** | `/portal/[tenant]/tasks` | Inbox of pending HITL tasks with 6 payload renderers; approve/reject decision panel | `useTasks`, `useRaasData` (agents lookup); resolve via `POST /v1/tasks/:id/resolve` | Priority FilterChip (All/HIGH/MED/LOW); row click selects; primary/secondary action; Snooze; type-specific UI (JD review, package, resume fix, clarification, supplement, manual publish) | ✅ shipped (P2-FE-12) |
| 7 | **Logs** | `/portal/[tenant]/logs` | File-tree browser + grep + level filter + live SSE tail | `useRaasData` (sampleLog fallback), `useRuns` (overlaid runs subtree), `useRunLogStream` (SSE `/v1/runs/:id/logs?follow=1`) | FileTree chevron toggles; tree node click selects + opens stream; grep input; level select; "tail" indicator | ✅ shipped (P2-FE-13) |
| 8 | **Deployments** | `/portal/[tenant]/deployments` | Live versions card (Workflow / Runtime / Inngest worker) + history table + 3-method deploy wizard | `useDeployments`, `useRollbackDeployment` | History row "Restore" → `POST /v1/deployments/:id/rollback`; "Deploy new version" → wizard (Manifest / Code package / Visual builder) | ✅ shipped (P2-FE-14) |
| 9 | **Settings** | `/portal/[tenant]/settings` and `/usage`, `/audit` | Workspace configuration across 9 sub-sections plus 2 deep-linked sub-routes | `useWorkspace` (prefs), `useUsage`, `useAudit` (via `Audit.tsx`) | Section nav (left rail); per-section CRUD; "Export config"; deep-link to `/usage` + `/audit` | ✅ shipped (P2-FE-15, P3-FE-03, P3-FE-05) |

**Notes**
- The sidebar's "Run" group also shows Agents nav count + Runs nav live-pulse pill (`runningCount`), Tasks nav amber-highlighted count.
- Every view has its own `ViewHeader` with title in Instrument Serif 22px italic-capable, subtitle, optional badge, and `action` slot (array of buttons accepted).

### 1.2 Detail / sub-routes

| Surface | Route | Tabs / sections | Notes |
|---|---|---|---|
| **Agent detail** | `/portal/[tenant]/agents/[id]` | 5 tabs: `config` · `io` · `code` · `versions` · `runs` | `code` tab embeds `AgentCodeTab` with splitter + maximize (D-6); `versions` reads `RAAS_DEPLOYMENTS` filtered by agent name; `runs` shows last 10 with TEST badge (D-8) and latest-test chip (D-11). EditConfigTab is the in-portal form editor. |
| **Run detail** | `/portal/[tenant]/runs/[id]` | 6 tabs: `timeline` · `trace` · `logs` · `io` · `events` · `agent` | `trace` was added in P3-FE-04 (TraceTree); `agent` was added as D-7. `timeline` shows step bars with shimmer for running steps. Header carries TEST RUN badge, REPLAY badge (P3-FE-06), trigger event chip, and Open Agent / Replay buttons. |
| **Settings (in-page)** | `/portal/[tenant]/settings` | 8 sections via nav switch: `workspace` · `people` · `models` · `channels` · `integrations` · `notifications` · `tokens` · `billing` | Rendered inline through `<SettingsSectionId>` switch; `data.ts` declares the 10 entries. |
| **Settings → Usage & cost** | `/portal/[tenant]/settings/usage` | Sub-route deep-linked from the nav (`ROUTED_SECTIONS`) | Inline SVG charts (`HorizontalBarChart`, `LineChart`); budget gauge; `useUsage` hits `GET /v1/usage`. |
| **Settings → Audit log** | `/portal/[tenant]/settings/audit` | Sub-route with pagination + diff renderer | `AuditDiffPanel` shows `before` / `after` on rows that carry it. Cursor-based pagination via `nextCursor`. |
| **Workflow editor mode** | `/portal/[tenant]/workflows` with `editing` flag | DraftBanner + EditToolbar + DraftPalette; per-node `AgentEditor` form | All deltas non-destructive (draft state); save via `useDeployManifest` → `POST /v1/agents`. |

### 1.3 Shared primitives (component library)

Every primitive that views can compose lives in `apps/web/app/portal/components/index.ts` (the public barrel). Naming + prop signatures intentionally mirror v1_1's `components.jsx` so view code can be ported with minimal modification (per the audit's R-1 mitigation).

| Primitive | Props (TypeScript) | Used by | Notes |
|---|---|---|---|
| `Icon` | `{ name: IconName; size?: number; color?: string; style? }` | Every view; default 14px | 27 named inline-SVG icons; missing icon → `null`. Add `aria-hidden` when icon is decorative beside text. |
| `Badge` | `{ children; tone?: "default"\|"signal"\|"green"\|"blue"\|"amber"\|"red"\|"violet"\|"muted"\|"solid"; style? }` | Run statuses, TEST/REPLAY chips, event categories, task priority, KPI sub-labels | All-caps mono 10.5px; `letter-spacing: 0.04em`. |
| `ActorTag` | `{ actor: "Agent" \| "Human"; compact?: boolean }` | Agent cards, run detail, task detail | `compact` accepted but **unused** (latent — flagged in audit §3.1). |
| `StatusDot` | `{ status: "running"\|"ok"\|"failed"\|"waiting"\|"paused"\|"idle"; size?: number }` | Sidebar footer, sidebar nav, run rows, run detail header, agent list | Pulses on `running` and `waiting`. |
| `Panel` | `{ title?; subtitle?; action?; children; style?; padded?: boolean; scroll?: boolean }` | Almost every panel-shaped surface | Header is conditional on `title`. No polymorphic `as` prop. |
| `Stat` | `{ label; value; sub?; tone?: "up"\|"down"; accent?; mono?: boolean; big?: boolean }` | Dashboard KPI strip, run detail stats, agent stats strip | `big` → 28px value. `tone` colors the sub-label. |
| `Button` | `{ children; tone?: "default"\|"primary"\|"ghost"\|"danger"; icon?: IconName; onClick?; small?: boolean; disabled?: boolean; title?; style? }` | All write actions, all toolbar actions | `disabled` ships in TSX (was latent in v1_1). Hover state via local React state. |
| `Sparkline` | `{ values: number[]; width?: number; height?: number; color?: string; filled?: boolean }` | KPI cards in dashboard, runtime panel | Returns `null` when empty. Pure path math factored out + unit-tested. |
| `Kbd` | `{ children }` | Cmd-K placeholder, task decision panel, tweaks panel hint | Two-stroke "keycap" via `border-bottom: 2px solid`. |
| `ViewHeader` | `{ title; subtitle?; badge?; action? }` | Every view top | `action` accepts a node or an array (key-bearing). Fixed `padding: 18px 24px 16px 24px`. |
| `Empty` | `{ title; hint? }` | Empty lists, "no agent found", missing run | Center-aligned, 60px top padding. |
| `MonacoEditor` | `{ value; onChange?; language?: string; height?: number; readOnly?: boolean; minHeight?: number }` | Agent code tab, EditConfigTab, NewWorkflowModal manifest preview, ImportManifestModal manifest preview, AgentCodeEdit (in-portal authoring) | Loaded from `monaco-editor@0.55.1` npm (not unpkg — P2-FE-04). Theme `agentic-dark` matches the v1_1 token map verbatim. |
| `Splitter` | `{ axis: "x"\|"y"; getValue; setValue; min?: number; max?: number }` | Agents list/detail (260-720px), AgentCodeTab sidebar (300-900px), AgentCodeTab per-block heights | Drag handle 4px thick; cursor changes on hover. |
| `ToastRegion` + `useToast` | `useToast() → ({tone, title, description, durationMs?}) => void` | Every mutation that can fail (replay, deploy, code save, manifest commit, task resolve, tenant create) | Module-scoped subscription store so toasts fire outside React. Bottom-right column, max 4 stacked, 4s auto-dismiss. |
| `CommandPalette` + `useCommandPalette` | Open via ⌘+K / Ctrl+K | Mounted in chrome | 5 command groups: Jump (9 views), Agents (DataContext), Runs (TanStack Query), Events, Tasks. ↑/↓/Enter navigation; Escape closes. |
| `SearchInput` | `{ value: string; onChange: (s: string) => void; placeholder? }` | Agents list, Runs list, Events filter, Logs filter | Embedded search icon + 11.5px mono input. |
| `FilterChip` | `{ active: boolean; onClick; children }` | Agents (actor filter), Runs (status filter), Events (category), Tasks (priority), Workflows toolbar | Active state: bordered + `background: var(--panel-2)`; idle: `--text-3`. |
| `CodeBlock` | `{ children }` | Run detail IO tab, Event detail payload, ImportManifestModal preview | Mono 11.5px on `--bg-2` with 4px radius. |
| `Th` / `Td` | `{ children; style? }` | Dashboard active runs table, Deployments history, Events table | Cells: `padding: 8px 12px`; `Th` is mono 10px uppercase. |
| `KV` | `{ rows: [string, ReactNode][] }` | Task detail workflow context, run detail IO header | `grid-template-columns: 120px 1fr; gap: 8; font-size: 12.5`. |
| `ModalOverlay` | Generic modal scaffold | DeployAgentModal, NewWorkflowModal, ImportManifestModal, ProviderKeyModal, NewTenantWizard, OverwriteConfirmModal, TenantCreateModal, TenantTokenRevealModal | Backdrop `rgba(0,0,0,0.5)` + `backdrop-filter: blur(2px)` + `fadein 0.14s`. Closes on backdrop click. |
| `eventTone(color)` | helper | Dashboard event ticker, Events list, EventDetail | Maps `data.js` color string ("green"/"blue"/"amber"/...) to a `BadgeTone`. |

**A11y notes on primitives** (carried forward from audit §3.1.1)
- `Button` uses JS-driven hover; `:focus-visible` styling now ships in `tokens.css`.
- `Icon` SVGs accept `aria-hidden` via the caller (decorative icons next to text).
- `StatusDot` should always carry an aria-label upstream.
- `Panel` headers are styled `<span>`, not `<h>` — heading outline is built by the page (`ViewHeader` does an `<h1>`).
- Skip-link in chrome lets keyboard users jump past sidebar to `#portal-view-content`.

### 1.4 Cross-cutting components

| Component | Where mounted | Purpose | State / behavior |
|---|---|---|---|
| **Sidebar** | `chrome.tsx` left column (232px) | Tenant identity + nav | `TenantSwitcher` (live tenants via `useTenants` + fixture fallback), `NavGroup` × 3 (Run/Observe/Manage), `NavItem` × 9 with badges, FooterRow × 2 (Inngest, SQLite). |
| **TenantSwitcher** | Sidebar | Active tenant + dropdown | Click opens panel with tenant list (live `agentCount` + `runs24h`); selecting routes to the same view under the new tenant slug (`useTenantNavigate`). "New tenant" footer opens `TenantCreateModal`. |
| **TopBar** | `chrome.tsx` row (44px) | Breadcrumb + Cmd-K + LIVE toggle + user chip | Breadcrumb computed from `usePathname()` (URL is source of truth); IDs styled mono. Cmd-K button mirrors `useCommandPalette().setOpen(true)`. LIVE/PAUSED reads `tweaks.liveStream`. User chip is decorative (no menu yet). |
| **TweaksPanel** | `chrome.tsx` floating bottom-right | Runtime preferences | Open via `⌘⇧T` (or cog FAB). 7 controls: theme · density · accent · liveStream · showDebug · tenant · dataSource (debug-gated). Persists via `localStorage` (replacing the v1_1 postMessage protocol). |
| **ToastRegion** | `chrome.tsx` mount + `<ToastRegion />` | Snackbar host | Module-scoped queue; bottom-right column; max 4 stacked. Fires from anywhere (in or out of React). |
| **CommandPalette** | `chrome.tsx` mount | Jump-to UX | Keyboard ⌘/Ctrl+K opens, Escape closes, ↑/↓/Enter navigate. Indexes views + agents (snapshot) + runs (query) + tasks (query). |
| **DeployAgentModal** | Agents view header | 5-step new-agent wizard | (1) identity, (2) trigger, (3) ontology, (4) code/tool_use, (5) preview + deploy. Step indicator with lime active stroke; numbered → checkmark on done. |
| **ImportManifestModal** | Workflows + Agents headers | 6-step manifest import wizard | source → validate → diff → resolve → preview → deploy. Wired end-to-end against `POST /v1/tenants/:slug/manifest-import` (modes: validate / commit), `/fetch-url` (SSRF-guarded), `/:dpl-id` DELETE for pending locks. |
| **NewTenantWizard** | TenantSwitcher footer | 4-step new-tenant flow | name → slug → seed workflow → confirm. Surface created via P3-FE-03. |
| **NewWorkflowModal** | Workflows view "New workflow" | Template chooser → editor | 6 template cards (blank, RAAS-lite, JD-only, etc.); jumps into edit mode with seeded draft. |
| **OverwriteConfirmModal** | Inside ImportManifestModal | Confirms destructive imports | Renders when API returns `overwrite_required` envelope. |

### 1.5 Design tokens

All tokens live in `apps/web/styles/tokens.css` (P2-FE-02). The token contract was the v1_1 baseline; v1 added named z-index, density multiplier, and ladder lint rule.

#### Color palette (CSS custom properties)

| Token | Dark | Light | Use |
|---|---|---|---|
| `--bg` | `#0a0a0b` | `#f6f6f4` | App background |
| `--bg-2` | `#0f0f11` | `#efefec` | Sidebar, code-block, log-view |
| `--panel` | `#131317` | `#ffffff` | Panel / card surface |
| `--panel-2` | `#18181d` | `#f8f8f6` | Hover state, input bg, segmented |
| `--panel-3` | `#1d1d23` | `#f1f1ee` | Active tab segment |
| `--border` | `#232329` | `#e3e3df` | Standard 1px divider |
| `--border-2` | `#2c2c34` | `#d4d4cf` | Stronger divider, button border |
| `--border-3` | `#393942` | `#b8b8b2` | Drag-handle, dashed edge |
| `--text` | `#ebebef` | `#1a1a1d` | Primary text |
| `--text-2` | `#a8aab1` | `#5a5b62` | Secondary text |
| `--text-3` | `#6f7178` | `#8c8d94` | Tertiary, meta |
| `--text-4` | `#46474d` | `#b8b9be` | Disabled, line numbers |
| `--signal` | `#d0ff00` | `#4d5e00` | Live / active / primary brand |
| `--signal-dim` | `#5a6e00` | `#c8d985` | Dim signal |
| `--blue` | `#84a9ff` | (inherit) | Data / trigger semantics |
| `--green` | `#65e0a3` | (inherit) | Success / ok / emit |
| `--amber` | `#ffb547` | (inherit) | Warn / human-pending / draft |
| `--red` | `#ff6470` | (inherit) | Error / failed |
| `--violet` | `#b594ff` | (inherit) | Human actor / non-agent |

**Accent override.** The Tweaks panel swaps `--signal` + `--signal-dim` at runtime among 4 palette options (lime, cyan, amber, violet). All view code reads `var(--signal)` rather than the literal `#d0ff00`, so swapping the accent re-themes every CTA / live-edge / active-tab indicator at once.

#### Typography

| Family | CSS var | Weights | Where |
|---|---|---|---|
| IBM Plex Sans | `--sans` | 400, 500, 600, 700 | Body, UI chrome, button labels |
| IBM Plex Mono | `--mono` | 400, 500, 600 | IDs, badges, KPIs, code, kbd |
| Instrument Serif | `--display` | 400 | View titles, big modal numbers |

Body baseline: `13px / 1.45` on `--sans`. Viewport: `1440` (fixed; no responsive design).

#### Spacing scale

No formal token map yet. Recurring values: `1, 2, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20, 24` px. View body padding standardizes on `20` or `24`; Panel body `14`; nav item `6×10`; table cell `8×12`; ViewHeader `18×24×16×24`.

#### Border radii

| Token | Value | Use |
|---|---|---|
| `--r-sm` | 4px | Inputs, code blocks, secondary panels |
| `--r-md` | 6px | Stat cards, modals, KPI cards |
| `--r-lg` | 10px | (declared but unused) |
| Literal `3` | — | Badges, kbd, small chips |
| Literal `5` | — | Buttons, dropdowns, top-bar pills |
| Literal `8` | — | Panel root |
| `50%` | — | Avatars, status dots |

#### Z-index ladder (P2-FE-26)

| Token | Value | Use |
|---|---|---|
| `--z-base` | 0 | Default page content |
| `--z-overlay` | 10 | Dropdowns, popovers, tweaks button |
| `--z-modal` | 100 | Modal backdrops + content |
| `--z-toast` | 200 | Toast region |
| `--z-tooltip` | 300 | Reserved for tooltips |

Enforced by an ESLint rule (`no-restricted-syntax` on `Property[key.name='zIndex'][value.type='Literal']`) — direct numeric `z-index` is a build error.

#### Density multiplier (P2-FE-20)

`html[data-density="compact"]` → `--density-mult: 0.85`; `comfortable` → `1.18`; default `1`. Components opt in via `calc()` strings or the `useDensity()` hook (`densityScalar(base, mult)`).

#### Animation keyframes

Defined globally in `tokens.css`. `pulse` (1.4s infinite — live dots), `tick` (0.4s one-shot — first row of ticker), `dot-flow` (workflow edge dots travelling via `<animateMotion>`), `spin` (0.9s infinite — Monaco loader), `shimmer` (1.5s infinite — running step bar), `fadein` (0.14s — modal entry).

---

## 2. Persona flow catalog

Drawn from PRD §4. Each persona walks 3-5 canonical journeys with the exact click path through the v1 portal.

### 2.1 Workflow Designer — "Liu Wei" (delivery manager, reads JSON, doesn't write TS)

**Goal.** Ship a new manifest agent or workflow tweak end-to-end in under 30 minutes without an engineering ticket.

**Surfaces owned by this persona.** Dashboard (monitor), Workflows (canvas + JSON), Agents (view+test), Runs (verify), Tasks (resolve), Deployments (promote).

#### Journey 2.1.1 — "Add a node between two existing agents"

| Step | View / control | Outcome |
|---|---|---|
| 1 | `/portal/raas/workflows` | Canvas loads with 23 nodes; live edges where traffic is hot. |
| 2 | Click "Edit workflow" (header button) | Draft state entered; DraftBanner shows "Unsaved · auto-saved 2s ago"; DraftPalette appears in right aside; node 4-corner handles render. |
| 3 | Drag a Palette card onto canvas | New node placed in approx position; selected by default; NodeEditor (form) opens in the aside. |
| 4 | Fill `name`, `description`, `trigger[]`, `triggered_event[]`, `tool_use[]` placeholder; pick a model from the dropdown (live from Settings → Models) | Draft state updates; canvas reflects new wires (edges materialize from triggers). |
| 5 | "Test run" on the new node | `POST /v1/agents/:name/invoke?testRun=1` returns 202 (manifest path) or 200 (code path); navigate to `/runs/[id]`; TEST RUN badge in header. |
| 6 | Run completes in ~3s; timeline shows steps OK | Decide to keep. |
| 7 | Back to Workflows → "Save" | Manifest committed via `POST /v1/agents`; new `workflow_version` row; deployment flips atomically; banner clears; canvas exits edit mode. |
| 8 | New row in Deployments history | Live; rollback available. |

**Backstops.** Save with invalid manifest → Zod parse error → red toast with `bad_request.message`. 409 on conflicting workflow_version → operator sees overwrite confirm path (re-uses ImportManifestModal logic). Save failures don't dirty live deployment (the route flips state in one transaction).

#### Journey 2.1.2 — "Approve a Tencent JD"

| Step | Surface | Outcome |
|---|---|---|
| 1 | Sidebar Tasks (amber pill `(3)`) | `/tasks`; inbox shows 3 open. |
| 2 | Click row "JD review: Tencent / Backend SDE" | Detail right pane shows JD on left + agent reasoning on right (jdReview payload renderer). |
| 3 | Quick-skim agent reasoning, edit JD inline (if needed) | Local state changes; no save yet. |
| 4 | "Approve" button | `POST /v1/tasks/:id/resolve {decision:"approve", overrides}`; task disappears from inbox; downstream cascade fires; green toast. |

**Backstops.** Resolve while task already resolved → 409 → toast "Task already closed." Snooze → `decision:"snooze"`; reappears in 1h.

#### Journey 2.1.3 — "Promote a draft to production"

| Step | Surface | Outcome |
|---|---|---|
| 1 | `/deployments` | LiveCards: Workflow `raas@2026.05.16` · Runtime `node-26.5.0` · Inngest `3w · 0 lag`. |
| 2 | History row "2026.05.16-a · draft" | Click "Promote" → `POST /v1/deployments/:id/rollback` (forward direction same endpoint) → status flips to `live`. |
| 3 | Toast confirms | Bootstrap reflows; new agents/edges live within ~5s. |

#### Journey 2.1.4 — "Investigate a stuck run"

| Step | Surface | Outcome |
|---|---|---|
| 1 | Dashboard | KPI strip shows `Errors: 12` (red sub-label). |
| 2 | Click into Active runs table | `/runs` filtered to running. |
| 3 | Pick `run-…` row → run detail | timeline tab: step 3 amber, step 4 not started. |
| 4 | Open `agent` tab | AgentCodeTab embedded; review ontology + tool_use definitions in context. |
| 5 | "Open agent" header button → `/agents/[id]` | Edit ontology in EditConfigTab; Save. |
| 6 | Back to original run → "Replay" header button | `POST /v1/runs/:id/replay` → new `run_id`; REPLAY badge on the new row; old run remains as-is. |

### 2.2 AI Engineer — "Chen Mengjie" (code agents, prompt iteration)

**Goal.** Tighten cycle time on prompt + tool iteration. Write code agents when the manifest model isn't expressive enough.

**Surfaces owned by this persona.** Agents (Code tab + EditConfigTab), Runs (logs + io + agent), Settings → Models.

#### Journey 2.2.1 — "Iterate on the matchResume prompt"

| Step | Surface | Outcome |
|---|---|---|
| 1 | `/portal/raas/agents/agt-matchResume` | Detail loads, code tab is active by default if URL deep-links to it. |
| 2 | Click Code tab → maximize | Sidebar (ontology / input_data / tool_use / runtime) hides; Monaco fills width. |
| 3 | Click "Edit" header button → EditConfigTab | Form-based editor; ontology textarea + input_data schema editor + tool_use card list. |
| 4 | Edit `ontology_instructions`; add a new tool_use entry | Local draft state. |
| 5 | "Save" | `POST /v1/agents` (re-uses manifest upload); idempotent if no diff. |
| 6 | "Test run" | New run started; navigate to `/runs/[id]`. |
| 7 | logs tab: stream from `/v1/runs/:id/logs?follow=1` | See prompt prelude + ontology + LLM response. |
| 8 | Loop 5-10x | Each iteration ~30s; commit when satisfied. |

#### Journey 2.2.2 — "Ship a new code agent"

| Step | Surface | Outcome |
|---|---|---|
| 1 | CLI: `agentic init raas processResume` | Scaffolds `data/tenants/raas/src/agents/processResume.ts`. |
| 2 | Author the TS class in the local IDE | `BaseAgent` subclass, `buildMessages`, `parseOutput`. |
| 3 | CLI: `agentic deploy` | Tarball uploaded via `POST /v1/tenants/raas/code` with version `0.0.<sha>`; Inngest reregisters; SSE invalidates `useTenants` and `useDeployments`. |
| 4 | Portal: `/agents/agt-processResume` appears | Code tab shows the new source; tool_use rendered from the BaseAgent introspection. |
| 5 | "Test run" → `/runs/[id]` | Synchronous code-agent path runs inline; status `ok`; output visible in io tab. |

**Alt path (in-portal authoring).** P3-FE-02 lets Chen edit the code in the portal: Agents → Code tab → "Edit" → MonacoEditor; "Save" builds a 2-file tarball client-side (`tar.ts` USTAR + `CompressionStream("gzip")`) and POSTs to `/v1/tenants/:slug/code` — same endpoint as the CLI path. Best for hotfixes; multi-file packages still go through CLI.

#### Journey 2.2.3 — "Pin a fallback model"

| Step | Surface | Outcome |
|---|---|---|
| 1 | Settings → Models | Three configured models default-listed (claude-sonnet-4-5 primary, claude-haiku-4-5 fallback, gpt-4.1-mini experiment). |
| 2 | Click row → ConfigureModelDrawer (right side) | Edit role, concurrency cap, cost knobs. |
| 3 | "Add model" (header button) | AddModelModal — provider + name + context window. |
| 4 | Save | `prefs.models` updated; downstream agent + deploy dropdowns reflect immediately (D-11 model fleet wiring). |

#### Journey 2.2.4 — "Compare two test runs"

| Step | Surface | Outcome |
|---|---|---|
| 1 | Agents → agent detail → Runs tab | Last 10 runs listed; TEST badge on synthetic, X test counter in subtitle (D-8). |
| 2 | Latest-test chip in header (`TEST · 2m ago`) | Click → jumps to `/runs/[id]` (D-11). |
| 3 | io tab shows input + output side-by-side | Read JSON diff manually (no built-in diff yet — flagged as v1.1). |

### 2.3 Platform Operator — "Ops" (multi-tenant admin, budgets, audit)

**Goal.** One pane of glass. Catch incidents fast. Hard cost caps. Defensible audit trail.

**Surfaces owned by this persona.** Dashboard, Runs (filter=failed), Events (replay), Settings → Billing/Usage/Audit/People/Tokens, Deployments.

#### Journey 2.3.1 — "Acknowledge a rate-limit page"

| Step | Surface | Outcome |
|---|---|---|
| 1 | Pager: "LLM rate-limited (429) spike on raas." | Open portal. |
| 2 | `/portal/raas/runs?status=failed` | 12 failed runs on `evaluateInterview`. |
| 3 | Click run → io tab → see `LLM_RATE_LIMITED` in payload | Confirm cause. |
| 4 | Settings → Models → Anthropic row → concurrency cap "8 → 4" | Cap lowered; runtime picks up next call. |
| 5 | Back to `/runs` → "Replay selection" | Bulk-replay the failed 12 (one new event per). |
| 6 | Dashboard → KPI strip recovers within 5 min | All-clear. |

#### Journey 2.3.2 — "Investigate a settings change"

| Step | Surface | Outcome |
|---|---|---|
| 1 | Settings → Audit log (deep-route `/settings/audit`) | Last 100 actions; load older via cursor. |
| 2 | Find row `settings.update target=models.fallback_chain` | Expand inline diff (`AuditDiffPanel`): before-left / after-right with changed keys highlighted. |
| 3 | Confirm operator + IP | `Liu Wei · 10.42.7.18`. |

#### Journey 2.3.3 — "Set per-tenant cost cap"

| Step | Surface | Outcome |
|---|---|---|
| 1 | Settings → Billing & cost caps | Per-tenant budget form: monthly USD cap, daily USD cap, per-agent override table. |
| 2 | Set monthly cap `$2,500` | `POST /v1/budgets` writes `tenant_budgets`; gateway pre-flight enforces. |
| 3 | Settings → Usage & cost (`/settings/usage`) | Live spend gauge; per-agent + per-model + per-day breakdown via inline SVG charts. |

#### Journey 2.3.4 — "Rotate an API token"

| Step | Surface | Outcome |
|---|---|---|
| 1 | Settings → API tokens | 4 keys listed with prefix + scopes + last-used. |
| 2 | Row "raas-prod / runtime" → "Rotate" | New key minted; TenantTokenRevealModal shows full secret once with copy button. |
| 3 | Audit log row appended | `key.rotate target=sk_live_a7f2`. |

#### Journey 2.3.5 — "Provision a new tenant"

| Step | Surface | Outcome |
|---|---|---|
| 1 | Sidebar TenantSwitcher → "New tenant" | TenantCreateModal opens. |
| 2 | NewTenantWizard 4 steps: name + slug + seed workflow + confirm | `POST /v1/tenants`; runs the discovery loop. |
| 3 | Auto-routed to `/portal/<new-slug>/dashboard` | Fresh tenant; ImportManifestModal can be pre-launched for the post-create flow. |

### 2.4 End User — "Wu Hao" (recruiter; not on portal)

**Goal.** Resolve a task assigned to them without needing portal access.

**Surfaces.** Email / WeChat notification + a signed task-resolution URL (FR-PORT-16). Out of scope for the portal proper, but the platform exposes these endpoints.

#### Journey 2.4.1 — "Re-upload a resume"

| Step | Surface | Outcome |
|---|---|---|
| 1 | WeChat bot DM: "Resume re-upload requested for candidate CAN-2031." | Tap the signed link. |
| 2 | Signed URL → minimal one-page form (read-only summary + file upload) | One-time-token (FR-PORT-16). |
| 3 | Submit | `POST /v1/tasks/<id>/resolve` server-side (token-authenticated); confirmation page. |

**v1 reality.** The signed-URL surface + notification dispatcher are tracked in FR-PORT-16; the dispatcher backbone (WeChat, email) is *stubbed* in v1 — the route is present but never invoked. See §4.2 v1.1 backlog.

---

## 3. Interaction patterns

These are the cross-view patterns the v1 build uses consistently. Every view can be read as a composition of these.

| Pattern | Where | Implementation | Notes / task ID |
|---|---|---|---|
| **Test run button** | AgentDetail header (agents view + runs detail "agent" tab cross-link) | Calls `POST /v1/agents/:name/invoke?testRun=1` via `useInvokeAgent`. Sync return for code agents; 202 + queued for manifest agents. | D-4 / P2-FE-18. Synthetic `subject` if none provided. |
| **Splitter resize** | Agents list↔detail (260-720px); AgentCodeTab sidebar (300-900px); AgentCodeTab per-block heights | `Splitter` primitive — axis="x" or "y", `getValue`/`setValue` callbacks. | D-5 / D-6. State lives in the view, not URL — refresh resets. |
| **Maximize toggle** | AgentCodeTab → hides sidebar, fills viewport | `useState<boolean>(false)` in the tab; toggle button in panel header. | D-6. |
| **REPLAY badge** | Run rows + run detail header when `parentRunId != null` | Amber tone Badge. | D-8 / P3-FE-06. |
| **TEST badge + filter** | Run rows, run detail header, AgentsGrid card, AgentDetail Runs tab subtitle ("X test"), AgentDetail header chip ("TEST · 2m ago") | Signal-tone Badge wired to `run.testRun: true`. | D-8 + D-11 / P2-FE-18. Latest-test chip jumps to the most recent test run for the agent. |
| **Real-time SSE invalidation** | All list views (runs, events, tasks, agents counts) | `useStream()` (mounted once in `chrome.tsx`) subscribes to `/v1/stream` and calls `queryClient.invalidateQueries({queryKey})` per event type (`run.*` → RUN_KEYS + COUNT_KEYS; `event.*` → EVENT_KEYS; `task.*` → TASK_KEYS). | P1-FE-02. Replaces v1_1 window-event mutation. |
| **Optimistic toasts** | Every mutation (replay, deploy, rollback, code save, manifest commit, task resolve, tenant create, token mint) | `toast({ tone, title, description })` on `mutate.onSuccess` (signal-tone) and `mutate.onError` (red-tone). | P2-FE-22. No silent failures. |
| **⌘+K palette** | Top bar button + global keydown | `useCommandPalette`; module-scoped subscription store; ↑/↓/Enter navigation; Escape closes. | P2-FE-23. |
| **Density toggle** | Tweaks panel (⌘⇧T) | `html[data-density="compact|default|comfortable"]` → `--density-mult` CSS var; views can `calc(base * var(--density-mult))` or use `useDensity()`. | P2-FE-20. |
| **Tenant in URL** | All view routes | `/portal/[tenant]/<view>...`; `useTenant()` reads from `useParams()`; `useTenantNavigate()` rewrites path while preserving the sub-segment. | P2-FE-25. Deep links + browser back/forward survive. |
| **Skip link** | Chrome | `<a href="#portal-view-content" className="skip-link">` first focusable element; CSS hidden until `:focus`. | P2-FE-24 (a11y). |
| **Deep-link sub-routes for heavy sections** | Settings → Usage; Settings → Audit | `ROUTED_SECTIONS` table redirects clicks on those nav entries; refresh + back/forward work. | P3-FE-03 / P3-FE-05. |
| **Inline SVG charts (no chart lib)** | Settings → Usage; Dashboard sparklines | `HorizontalBarChart`, `LineChart` in `usage/charts.tsx`; `Sparkline` in `sparkline.tsx`. Math helpers (`bucketBars`, `lineChartPoints`) unit-tested. | P3-FE-03. |
| **Pixel-fidelity inline styling** | Every primitive + view | No CSS-in-JS lib; all `style={{}}` inline. Tokens via `var(--*)`. ESLint forbids literal z-index. | P2-FE-03. |
| **Soft-gate on missing data** | Run detail "agent" tab, log-view, EventDetail | Renders `<Empty>` rather than throwing. | Carry-over from v1_1; some panels still missing — see audit §7 R-3. |
| **Tweaks-driven theming** | All views via CSS vars | Theme + density + accent live in `localStorage` (P2-FE-16); changes are instantaneous (no rerender of any view tree). | P2-FE-16. |

---

## 4. Use-case backlog — UX angle

Use cases are organized by maturity. Each entry is concrete enough to spec from. The goal is for the team to be able to scan a row and either commit to it (v1.1) or shelve it explicitly (v2).

### 4.1 ✅ v1 shipped — works today, citable

| # | Persona | Use case | Click path | FR/task |
|---|---|---|---|---|
| U1.1 | Liu Wei | View live KPI strip of running runs / events-per-hr / errors / pending tasks / token spend | Dashboard | FR-PORT-1 / P2-FE-07 |
| U1.2 | Liu Wei | See the RAAS funnel collapse across 8 stages | Dashboard → Stage funnel | FR-PORT-1 |
| U1.3 | Liu Wei | Click an active run → arrive at run detail | Dashboard → Active runs table row | FR-PORT-1 / P2-FE-07 |
| U1.4 | Liu Wei | Open the DAG canvas of the deployed workflow | `/workflows` | FR-PORT-3 / P2-FE-08 |
| U1.5 | Liu Wei | Select a node → see its in/out edges highlighted | Workflows → click node | P2-FE-08 |
| U1.6 | Liu Wei | Toggle Edit mode → see DraftBanner + EditToolbar | Workflows → "Edit workflow" | P3-FE-01 |
| U1.7 | Liu Wei | Add a new agent via the manifest upload wizard | Workflows → "Import manifest" → 6 steps | P2-FE-17 |
| U1.8 | Liu Wei | Save a workflow edit → manifest commits + new version row | Workflows → Edit → "Save" | P3-FE-01 / FR-OS-12 |
| U1.9 | Liu Wei | List all agents in a tenant + filter by actor (Agent/Human) | `/agents` → SearchInput + FilterChip | P2-FE-09 |
| U1.10 | Liu Wei | Click an agent → see config / io / code / versions / runs in 5 tabs | `/agents/[id]` | P2-FE-09 |
| U1.11 | Liu Wei | Test-run any code or manifest agent and watch it complete | Agent detail → "Test run" | D-4 / P2-FE-18 |
| U1.12 | Liu Wei | See the synthetic-vs-real distinction on every test run | TEST badge in 4 places (D-8) | P2-FE-18 |
| U1.13 | Liu Wei | Jump from a run back to the agent that produced it | Run detail → "Open agent" header button | D-7 |
| U1.14 | Liu Wei | Re-emit a run's trigger event to recreate a scenario | Run detail → "Replay" | P3-FE-06 |
| U1.15 | Liu Wei | Resolve a JD-review human task | `/tasks` → row → primary action | P2-FE-12 |
| U1.16 | Liu Wei | Snooze a task for 1h | `/tasks` → row → "Snooze" | P2-FE-12 |
| U1.17 | Chen Mengjie | Edit ontology in-portal and save back to manifest | Agent detail → "Edit" → EditConfigTab → Save | P3-FE-01 (re-uses agents POST) |
| U1.18 | Chen Mengjie | Edit code-agent TS source in Monaco and deploy | Agent detail → Code tab → "Edit" → tar+POST | P3-FE-02 |
| U1.19 | Chen Mengjie | Read run logs via SSE tail (live follow) | Run detail → logs tab | FR-OBS-2 / P2-FE-10 |
| U1.20 | Chen Mengjie | Inspect run input + output side-by-side | Run detail → io tab | P2-FE-10 |
| U1.21 | Chen Mengjie | See the agent's code in the context of one of its runs | Run detail → agent tab | D-7 / P2-FE-10 |
| U1.22 | Ops | Filter runs by failed status across all agents | `/runs` → status FilterChip "Failed" | P2-FE-10 |
| U1.23 | Ops | View per-day cost breakdown by agent + model | `/settings/usage` | P3-FE-03 / FR-OBS-5 |
| U1.24 | Ops | Inspect audit log entry with before/after diff | `/settings/audit` → expand row | P3-FE-05 / FR-OS-8 |
| U1.25 | Ops | Provision a new tenant via the 4-step wizard | TenantSwitcher → "New tenant" | P3-FE-tenant |
| U1.26 | Ops | Promote a draft deployment to live | `/deployments` → row → "Promote" | FR-OS-7 / P2-FE-14 |
| U1.27 | Ops | Rotate an API token (revealed once) | `/settings/tokens` → "Rotate" | NFR-SEC-2 / P2-FE-15 |
| U1.28 | Liu Wei | Switch active tenant from the sidebar | TenantSwitcher → tenant row | P2-FE-25 |
| U1.29 | Any | Jump to any agent / run / event / task via ⌘+K | Global keydown | P2-FE-23 |
| U1.30 | Any | Toggle theme / density / accent at runtime | Tweaks panel (⌘⇧T) | P2-FE-16 / P2-FE-20 |

### 4.2 🚧 v1.1 ready-to-build — clear path, small effort

These are use cases the platform almost-supports today. Each has a concrete gap and a defensible suggested fix.

| # | Persona | Use case | Gap today | Suggested fix |
|---|---|---|---|---|
| U2.1 | Wu Hao | Receive a WeChat / email notification with a signed task-resolution link | Notification dispatcher is *stubbed*; signed-URL route exists but is unwired. FR-PORT-16 partially landed. | Wire a dispatcher adapter (`@agentic/notifications`) with WeChat Work + AWS SES (already in Settings → Integrations as enabled). Compose the signed URL via the existing JWT + scope `task:resolve:<id>`. |
| U2.2 | Wu Hao | Submit a corrected resume from a signed URL | Server-side route + form scaffold needed; the resume-fix payload renderer for the portal already exists. | New `app/(public)/task/[token]/page.tsx` rendering the same `ResumeFixPayload` from `tasks/page.tsx` with a `POST /v1/public/tasks/:token` action. |
| U2.3 | Liu Wei | Diff two test runs side-by-side | io tab shows one run only; no diff. | Add a "Compare" button on the runs list that takes two checkboxes → opens a 50/50 diff view (`react-diff-viewer` or own SVG). |
| U2.4 | Liu Wei | Cmd-K command "Emit event" | Cmd-K only navigates; doesn't write. | Add a write-action group ("Emit event", "Replay run"). For "Emit event", a 2-step UI (event name autocomplete from `useRaasData().events` → JSON payload → POST `/v1/events`). |
| U2.5 | Chen Mengjie | Real-time prompt-token + cost preview while editing ontology | EditConfigTab is static. | Wire `tiktoken` (or the platform's gateway count-tokens helper) for a live "~340 tokens · ~$0.002 / call" chip beneath the ontology field. |
| U2.6 | Chen Mengjie | Hot-reload feedback when CLI deploys land | `useTenantCode` polls; SSE invalidates but operator has no toast. | Listen for `deployment.created` SSE → toast "tenant code v0.0.123 active." |
| U2.7 | Ops | Bulk-replay failed runs | "Replay selection" header button in `/runs` is wired UI-only. | Wire row checkboxes + bulk POST. Per-run replay endpoint exists; new `POST /v1/runs/replay-bulk {ids}` for atomic batch. |
| U2.8 | Ops | Pause LIVE stream subscription server-side, not just freeze UI | LIVE toggle in TopBar freezes nothing on the server. | Send `pause` over SSE; server holds events for that session. (Decision in audit §8 #3 — pick SSE + UI-freeze for now.) |
| U2.9 | Ops | See contextually-aware health drilldowns | Sidebar footer shows "Inngest 3w · 0 lag" + "SQLite 8.4 MB" as static labels. | Wire to `/health` (already returns Inngest/SQLite subsystem details); click footer row → opens `Panel` overlay with last 5 min health timeline. |
| U2.10 | Ops | Per-tenant rate-limit override from Settings | Backend supports it (`apps/api/src/plugins/security.ts`); Settings has no field. | Add to Billing section: "Rate limit (req/min)" field. |
| U2.11 | Liu Wei | Visualize the trace tree of a multi-step workflow run | P3-FE-04 ships `trace` tab with `TraceTree`; works on parent/child runs only. | Expand to render *full ancestor chain* (find root via repeated `parentRunId` walks) + lateral siblings. Already half-built. |
| U2.12 | Ops | See provider-error budget drilldown | `llm_provider_errors_total` metric ships; portal doesn't surface it. | Add a "Provider errors" card to `/settings/usage` reading from `/metrics`. |
| U2.13 | Liu Wei | Permanent display of edit-mode "what changed" beyond the draft session | `DraftPalette` shows diff but it's per-session. | Persist draft to `localStorage` keyed by tenant+workflow; restore on next visit; "Discard draft" button. |
| U2.14 | Chen Mengjie | Validate manifest schema without deploying | "Validate" button in NewWorkflowModal is a no-op (P3-FE-01 known caveat). | Wire to `POST /v1/agents?dry-run=1` (already supported by the route shape; just needs the UI). |
| U2.15 | Liu Wei | Confirm before switching tenant with unsaved workflow draft | Switch loses unsaved work. | Hook into `useTenantNavigate`; if `draft` state non-empty, show `confirm()` modal. |
| U2.16 | Wu Hao (end-user) | View read-only summary of a closed task | No surface today (task disappears after resolve). | Same signed-URL form but with `?mode=read-only` — useful for audit recipients. |

### 4.3 🌅 v2 vision — bigger lifts

These are intentionally bigger than v1.1. Each has a reason that bumps it.

| # | Persona | Use case | Why not v1.1 |
|---|---|---|---|
| U3.1 | Ops | A/B test two prompt variants and the dashboard shows the winner with a confidence interval | New "experiment" primitive: `runs.experiment_id` column, `agent_versions.experiment_arm`, traffic-splitter in the gateway. Design RFC needed. |
| U3.2 | Liu Wei | Drag-and-drop *create-from-scratch* visual workflow builder | Edit mode today expects the canonical LAYOUT map; net-new visual composition (auto-pack, snap-to-grid, route-finding) is the explicit v1 non-goal (PRD §5.2 #3). |
| U3.3 | Chen Mengjie | In-browser step-through debugger with breakpoints | Requires the runtime to expose a debug protocol (DAP-like) and Inngest replay-by-step. PRD §5.2 #2 non-goal. |
| U3.4 | Liu Wei | Marketplace of pre-built agents (install with one click) | PRD §5.2 #6 non-goal. New service: discovery + signing + provenance. |
| U3.5 | Chen Mengjie | Python runtime for code agents | PRD §5.2 #1 non-goal. Adds a process boundary, IPC contract, and Python tooling. |
| U3.6 | Ops | Multi-region deployment with active-active SQLite (or Postgres) | PRD §5.2 #5 non-goal. Schema is portable; replication + leader-election is the lift. |
| U3.7 | Wu Hao | Native mobile portal | 1440 viewport pin (audit §2.2). Responsive design is a full design pass + token retro. |
| U3.8 | Any | Streaming LLM output to the portal (token-by-token) | PRD §5.2 #8 non-goal. Requires SSE multiplexing per-run + new IO tab streaming widget. |
| U3.9 | Ops | SAML / SSO + per-tenant identity providers | PRD §11 #10 non-goal. New auth path; ties into a major Settings → People rework. |
| U3.10 | Liu Wei | Right-click context menus on runs / events / agents | Out-of-scope per audit §8 #10. Touches every list view + needs a `Menu` primitive. |

---

## 5. UX gaps + risks (forward-looking)

Pulled from `docs/audits/01-product-design-fidelity.md §8` (12 open design questions), the launch-status v1.1 follow-ups in `docs/audits/p2-cleanup-status.md §v1.1`, and live-code observation. For each: why it matters, blast radius, recommended owner.

| # | Gap | Why it matters | Blast radius | Owner |
|---|---|---|---|---|
| G1 | **Cookie auth on Fastify side** — API still requires `Authorization: Bearer …`; the Next session cookie isn't read by the API directly. Dev is fine; prod needs the join. | A real prod deploy currently requires Bearer tokens for every direct API call from any non-portal client. Portal works because Next forwards the cookie via the rewrite. | Medium — affects CLI, webhooks (already HMAC), 3rd-party tooling | Backend Eng |
| G2 | **Tasks view extra `operator` line** — TaskRow shows a sub-line v1_1 didn't have | Pixel-diff regression flagged in P2 cleanup | Low — visual only | UX Eng |
| G3 | **WCAG AA contrast on signal lime** — `#d0ff00` over dark dips below AA for small text. 9 axe-serious violations all root-cause here | Accessibility commitment in PRD §FR-PORT-13 (WCAG 2.1 AA target) | High — every "active state" pill, every badge, every CTA | Design + Eng |
| G4 | **`runs.emittedEvent` not populated** — contract field returns `null` because the query doesn't join `events` on `runs.emittedEventId` | Visible empty fields in run detail header + IO tab | Low — but cheap to fix | Backend Eng |
| G5 | **Notification dispatcher stubbed** — FR-PORT-16 partial; signed-URL route present but no actual email/WeChat fanout | End-user persona (Wu Hao) is effectively unsupported in production today | High — blocks v1.1 end-user launch | Backend Eng |
| G6 | **Auth flow with logout** — no logout surface in TopBar; user chip is decorative | Mobile / shared-machine usage shows the last operator forever | Medium — Settings → People + TopBar | UX Eng |
| G7 | **Density-aware spacing not wired view-by-view** — token + hook ship (P2-FE-20) but most inline `padding` literals don't `calc(…)` | Compact mode is a no-op in most views; comfortable mode is too | Medium — every view needs a sweep | UX Eng |
| G8 | **Right-click context menus** — out of scope for v1 but every operator I've shadowed reaches for one | Operator efficiency on runs/events/tasks; the platform is otherwise dense + keyboard-friendly | Design call — high effort, high payoff | Product |
| G9 | **Manifest-agent runs don't feed metrics yet** — `runs_total` increments on code-agent path only | Cost dashboard understates spend on manifest agents (~95% of RAAS load) | High — directly affects cost transparency | Backend Eng |
| G10 | **Drag-and-drop in workflow canvas latent** — edit mode renders handles + DraftPalette `draggable` cards, no drop handler | Audit §8 #7 — block on the "in-portal workflow authoring" promise | High — but tracked for v2 | Design + Eng |
| G11 | **Empty states missing in 3 places** — Workflows canvas (assumes ≥1 node), Events list (no events match filter), EventDetail (nothing selected) | Looks like a crash on a freshly-provisioned tenant | Low — drop-in `<Empty />` | UX Eng |
| G12 | **Workspace timezone honored everywhere** — wired through `useWorkspace` (P2-FE-27) but several `fmtTime`/`fmtAgo` calls still in local TZ | Cross-tz operator confusion (audit §7 R-10) | Medium — one-line fix per caller; sweep needed | UX Eng |
| G13 | **`/v1/usage` route registration** — implemented but per `p4-test-ci-status.md` "never registered in server.ts" caveat (already addressed in P3 ship, but spawn-task filed for safety) | Cost dashboard 404s in clean builds | Low — verified shipped, monitor | Backend Eng |
| G14 | **Latent props/tokens** — `ActorTag.compact`, `--r-lg`, deck-stage rail in TweaksPanel, `--density` consumption | Tech debt; small | Low | UX Eng |
| G15 | **Streaming LLM output to portal** — PRD §5.2 #8 non-goal; v1 returns full response | Visible "thinking…" lag on big prompts; key v2 ask | Medium — touches gateway + portal SSE | Product / Backend |

---

## 6. Acceptance criteria — what "good UX" means for this platform

The bar the team holds itself to. Each criterion is testable; most map to a CI gate that exists or should.

### Visual

- Every view renders ≤ 0.1% Playwright pixel-diff against the v1_1 frozen reference (`agentic-operator_v1_1/`). Threshold enforced in `apps/web/playwright.e2e.config.ts`.
- All colors come through CSS variables. Literal hex codes in TSX outside `tokens.css` is a code-review block.
- All z-index values come through the named ladder (`--z-base/overlay/modal/toast/tooltip`). Direct numeric literals are an ESLint error (P2-FE-26).
- Theme + density + accent toggles produce *instant* repaint with no view re-mount.

### Accessibility

- axe-core scan returns 0 critical violations on every view. WCAG 2.1 AA target for contrast (gap G3 tracked).
- Every interactive control reachable by Tab. `:focus-visible` ring renders in signal accent at all times.
- Skip-link is the first focusable element on every page.
- `Icon` accepts `aria-hidden`; icon-only buttons must carry `aria-label` (`title=` is not sufficient).
- StatusDot, Badge, FilterChip — each carries an upstream label or `aria-label`.

### Data integrity

- Every failed mutation surfaces a `toast({tone:"red"})` with the API's `error.message` and `error.hint`. No silent failures.
- Every list view reflects an SSE-pushed change within 1s of the underlying DB write (NFR-PERF-5).
- TanStack Query caches are invalidated by `useStream` for all `run.*`, `event.*`, `task.*`, `deployment.*` event categories.

### Performance

- Portal initial render TTI ≤ 1.5s on a 10 Mbps connection (NFR-PERF-3).
- View transitions feel ≤ 200ms even when the data is loading (skeleton or in-flight indicator).
- Monaco editor lazy-loads on first surface that needs it; cold-start ≤ 500ms.

### Coverage

- Lines ≥ 70%, branches ≥ 60% on `@agentic/web` (currently 90.42% / 89.65%).
- E2E suite covers the canonical happy-path (manifest agent run, code agent run, HITL resolve, auth, workflow editor save, CLI roundtrip).

### Pixel discipline

- All styling stays inline (`style={{}}`) per the v1_1 fidelity contract. Migration to Tailwind / CSS-in-JS is out-of-scope without explicit Foundation Eng sign-off (audit §7 R-1 mitigation).
- Inline-style policy documented in `apps/web/app/portal/STYLE-GUIDE.md` (P2-FE-03).

### Persona acceptance

- **Liu Wei**: TTFR for a manifest-agent change ≤ 30 min (PRD §6.1). Canonical journey 2.1.1 completes in the portal alone.
- **Chen Mengjie**: TTFR for a code-agent change ≤ 2 hr (PRD §6.1). Edit cycle (ontology tweak → test run → result) ≤ 60s.
- **Ops**: Detect a stuck run in < 5 min via portal (PRD §6.2). Audit log diff is one-click-expand for any settings change.
- **Wu Hao**: 1-tap link in WeChat → signed URL renders correctly → resolve action persists. (v1.1 gate.)

---

## Cross-reference index

For quick navigation between this catalog and the source artifacts:

| Reference | Lives in |
|---|---|
| Component primitive specs | `docs/audits/01-product-design-fidelity.md §3` |
| Per-view design fidelity | `docs/audits/01-product-design-fidelity.md §4` |
| 11 deltas (D-1..D-11) | `docs/audits/01-product-design-fidelity.md §6` |
| 12 open design questions | `docs/audits/01-product-design-fidelity.md §8` |
| Acceptance checklist (parity) | `docs/audits/01-product-design-fidelity.md §9` |
| PRD personas | `docs/PRD.md §4` |
| Functional requirements (FR-PORT-*) | `docs/PRD.md §7.1` |
| UX requirements per view (PRD level) | `docs/PRD.md §9` |
| Canonical happy-path | `docs/USER_GUIDE.md §5` |
| Phase 2 foundation task table | `docs/audits/p2-foundation-status.md` |
| Phase 2 heavy views task table | `docs/audits/p2-heavy-views-status.md` |
| Phase 2 light views task table | `docs/audits/p2-light-views-status.md` |
| Phase 3 portal authoring task table | `docs/audits/p3-portal-authoring-status.md` |
| Phase 4 ops + test/CI task tables | `docs/audits/p4-ops-status.md`, `docs/audits/p4-test-ci-status.md` |
| Style guide (inline-style policy) | `apps/web/app/portal/STYLE-GUIDE.md` |
| Token contract | `apps/web/styles/tokens.css` |
| Public primitive barrel | `apps/web/app/portal/components/index.ts` |

*End of catalog. Compiled 2026-05-21 from a complete read of the running portal source, the v1 audit suite, and the PRD. References are precise to file + section; if an entry looks wrong, file a follow-up rather than guessing.*
