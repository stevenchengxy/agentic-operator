# Agentic Operator — Frontend + Backend Monorepo

Event-driven agentic workflow runtime + admin console.

- **`apps/web`** — Next.js 16 + React 19 control plane (UI only)
- **`apps/api`** — Fastify 5 backend (REST + Inngest webhook + SSE log tail + HMAC webhooks)
- **`packages/runtime`** — Inngest agent registry, manifest loader, step engine
- **`packages/db`** — Drizzle ORM + better-sqlite3 (WAL mode)
- **`packages/contracts`** — Shared Zod schemas (single source of truth for the API)
- **`packages/tools`** — Mock first-party tool implementations
- **`packages/shared`** — IDs, SSE helper, types
- **`models/<tenant>-v<n>/`** — Per-tenant ontology (workflow + actions + events + objects + rules)
- **`data/`** — Runtime state (SQLite DB, logs, artifacts) — gitignored

## Stack

| | Version | Notes |
|---|---|---|
| Node | 26.5.0 | Exact version pinned in `.nvmrc`, CI, and Docker |
| TypeScript | 5.7+ | strict |
| Next.js | 16.2.10 | App Router and Turbopack |
| React | 19 | RSC + inline CSS-in-JS (no Tailwind / shadcn — design fidelity) |
| Fastify | 5 | api server |
| Inngest | 3.x | durable event bus, step engine |
| better-sqlite3 | 11.x | native module — Node runtime only |
| Drizzle ORM | 0.36 | + drizzle-kit migrations |
| Zod | 3.23+ | request/response validation |
| Turborepo | 2.x | pipeline |
| pnpm | 10.x | workspaces |

## Quick start

```bash
nvm use                       # selects Node 26.5.0 from .nvmrc
pnpm install                  # ~10s, builds native modules
pnpm db:migrate               # creates data/agentic.db (18 tables)
pnpm db:seed                  # 3 tenants + 1 admin user
pnpm seed:rich                # (RF-1.7) loads RAAS historical fixtures + ontology
pnpm dev                      # boots web + api + inngest concurrently
```

Open <http://localhost:3599>.

- **web** on :3599 — Next.js. All `/v1/*` calls proxy to api.
- **api** on :3501 — Fastify. Hosts `/v1/*` REST + `/inngest` webhook + `/health`.
- **inngest** on :8288 — Inngest dev UI; auto-discovers `http://localhost:3501/inngest`.

### Demo mode vs production mode (locked 2026-05-26)

The api has two clean states — no in-between. Toggle with the single env flag `AGENTIC_DEMO_MODE`:

```bash
# Clean slate — drop accumulated traffic + start over
pnpm db:wipe-runtime

# Production: ZERO mock/seed data. Dashboard reflects only real events.
AGENTIC_DEMO_MODE=false pnpm dev

# Demo: seed:rich runs once at boot + an in-process loop fires plausible
# tenant events every 30s. Sidebar shows a lime "DEMO" pill.
AGENTIC_DEMO_MODE=true  pnpm dev
```

See `CLAUDE.md` § Demo mode for the runner cadence and safety gates.

## Verifying end-to-end

```bash
# Fire a RAAS event (subject is the candidate / requirement being processed)
curl -X POST http://localhost:3501/v1/events \
  -H "Content-Type: application/json" \
  -d '{"name":"REQUIREMENT_LOGGED","subject":"REQ-1001","payload":{"client":"Acme"}}'

# Watch the chain: ~14 agents run in sequence
# Inngest UI:    http://localhost:8288
# Web dashboard: http://localhost:3599

# Chain pauses at jdReview (a manual step) → task appears in the inbox
curl -X POST http://localhost:3501/v1/tasks/<task-id>/resolve \
  -H "Content-Type: application/json" \
  -d '{"decision":"approve"}'

# SSE log tail
curl -N http://localhost:3501/v1/runs/<run-id>/logs?follow=1

# Health
curl http://localhost:3501/health
```

## Adding a new tenant / agent

1. Drop a model folder at `/Users/kenny/CSI-AICOE/agentic-operator/models/<slug>-v1/`
   with five JSON files:
     - `workflow.json` (or `workflow_v1.json`) — array of `AgentSpec` per DESIGN.md §4
     - `actions.json` — per-agent I/O contracts
     - `events.json` — event catalog (feeds the Events view)
     - `objects.json` — entity definitions (populates `entity_types` table)
     - `rules.json` — business rules
2. Add the tenant row in `packages/db/src/seed.ts`, run `pnpm db:seed`.
3. Restart `apps/api`. Bootstrap auto-discovers the folder, registers
   Inngest functions, upserts ontology tables, and the new tenant shows
   in the sidebar switcher.

Folder name convention: `<tenant-slug>-v<n>`; slug is derived (lowercase,
strip `-vN` suffix). Example: `RAAS-v1` → tenant `raas`.

## Repository layout

```
portal/                              ← monorepo root
├── apps/
│   ├── web/                         Next.js 16.2.10 (UI only)
│   │   ├── app/
│   │   │   ├── layout.tsx           root HTML
│   │   │   ├── (portal)/            sidebar+topbar route group
│   │   │   │   ├── page.tsx         /  (dashboard)
│   │   │   │   ├── workflows/page.tsx
│   │   │   │   ├── agents/page.tsx + [kebab]/page.tsx
│   │   │   │   ├── runs/page.tsx + [runId]/page.tsx
│   │   │   │   ├── events/page.tsx
│   │   │   │   ├── tasks/page.tsx + [id]/page.tsx
│   │   │   │   ├── logs/page.tsx
│   │   │   │   ├── deployments/page.tsx
│   │   │   │   └── _components/{Sidebar,TopBar,Logo,…}.tsx
│   │   │   ├── (auth)/sign-in/page.tsx
│   │   │   ├── api/prefs/route.ts   only API route in web (cookie-only)
│   │   │   └── global.css
│   │   ├── components/              UI primitives (Icon, Badge, Panel, …)
│   │   ├── lib/
│   │   │   ├── api-client.ts        typed fetch wrappers (Zod-validated)
│   │   │   ├── format.ts
│   │   │   ├── prefs.ts
│   │   │   └── tenants.ts
│   │   └── next.config.ts           rewrites /v1/* → http://localhost:3501/v1/*
│   └── api/                         Fastify backend
│       ├── src/
│       │   ├── server.ts            entry — registers all routes + Inngest
│       │   ├── plugins/             auth, audit, error envelope
│       │   ├── routes/
│       │   │   ├── health.ts
│       │   │   ├── inngest.ts
│       │   │   └── v1/
│       │   │       ├── events.ts    POST/GET + POST replay
│       │   │       ├── runs.ts      list + detail + replay
│       │   │       ├── runs-logs.ts SSE
│       │   │       ├── tasks.ts     list + detail + resolve
│       │   │       ├── agents.ts    list + detail + POST manifest upload
│       │   │       ├── deployments.ts list + rollback
│       │   │       ├── webhooks.ts  POST /:provider (HMAC)
│       │   │       ├── artifacts.ts GET stream
│       │   │       └── reads.ts     /counts, /workflows/dag
│       │   ├── queries/             Drizzle helpers per resource
│       │   ├── bootstrap.ts
│       │   └── scripts/seed-rich.ts (RF-1.7) loads handoff data.js + ontology
│       └── .env.local
├── packages/
│   ├── contracts/                   shared Zod schemas for /v1/*
│   ├── db/                          schema (18 tables), client (WAL), migrations
│   ├── runtime/                     manifest loader, register, step engine
│   ├── shared/                      ids, SSE helper, types
│   └── tools/                       mock http.fetch, llm.call, channel.publish
├── data/                            runtime state — gitignored
│   ├── agentic.db
│   ├── logs/<tenant>/runs/<date>/<run-id>.log
│   ├── logs/<tenant>/events/<date>.ndjson
│   └── artifacts/
├── tests/
├── turbo.json
├── pnpm-workspace.yaml
└── package.json
```

## Environment variables

Each app has its own `.env.local`:

**apps/api/.env.local** (backend)
```sh
PORT=3501
HOST=0.0.0.0
WEB_ORIGIN=http://localhost:3599        # CORS allow-list
DATABASE_URL=file:../../data/agentic.db
AGENTIC_LOGS_DIR=../../data/logs
AGENTIC_ARTIFACTS_DIR=../../data/artifacts
AGENTIC_MODELS_DIR=/Users/kenny/CSI-AICOE/agentic-operator/models
AUTH_MODE=dev                           # bypasses bearer auth
AGENTIC_DEV_TENANT=raas
INNGEST_DEV=1
WEBHOOK_HMAC_SECRET_DEFAULT=local-dev-hmac
```

**apps/web/.env.local** (frontend)
```sh
AGENTIC_API_URL=http://localhost:3501   # server-component fetches
AGENTIC_API_TOKEN=                      # empty in dev
```

## Design decisions

- **Frontend/backend split.** UI is Next.js; backend is Fastify. Web has no
  DB access — every read goes through `/v1/*` to api. Single source of truth
  for the API contract is `@agentic/contracts` Zod schemas, imported by both
  sides.
- **Inline CSS-in-JS, not Tailwind.** Matches the prototype 1:1. Pseudo-selectors
  + media queries + @keyframes live in `global.css`; everything else inline.
- **Models dir is the source of truth for workflows.** Bootstrap auto-discovers
  every `models/<slug>-v<n>/` folder.
- **Idempotent runtime.** Inngest replays handlers per step; all DB writes are
  wrapped in `step.run(...)` so exactly one `runs` / `steps` row is produced
  per actual execution.
- **HITL via `step.waitForEvent`.** Manual steps create a `tasks` row, then
  `step.waitForEvent('task.resolved', { if: 'async.data.taskId == "<id>"' })`.

## Deferred

- Full `apps/cli` (only Mode 1 manifest upload reachable today via `curl`)
- Mode 3 visual workflow builder
- Sandboxed tool execution
- OpenTelemetry export
- Tailwind 4 / shadcn migration
- Runtime validation of agent manifests against `objects.json` ontology
  (RF-2 — `entity_types` table is populated for display only)
