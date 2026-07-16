# System Design — Agentic Operator

> **Companion to:** [PRD.md](./PRD.md), [USER_GUIDE.md](./USER_GUIDE.md)
> **Scope:** Implementation contract for the v1 runtime + portal.

---

## 1 · High-level architecture

```
                   ┌───────────────────────────────────────────────┐
                   │                External callers                │
                   │   (RMS systems, ATS, channels, recruiter app)  │
                   └─────────┬──────────────┬──────────────┬────────┘
                             │              │              │
                       POST  ▼     webhook  ▼      CLI/SDK ▼
              ┌────────────────────────────────────────────────────┐
              │              Next.js 16.2.10 — apps/portal          │
              │  ┌──────────────────┐    ┌─────────────────────┐    │
              │  │  Route handlers  │    │   Admin UI (React)  │    │
              │  │  /api/events     │    │   /portal/*         │    │
              │  │  /api/agents     │    │   (matches index.html) │ │
              │  │  /api/runs       │    └─────────────────────┘    │
              │  │  /api/tasks      │                                │
              │  │  /api/inngest    │◀─────── Inngest worker(s) ─────┐
              │  └─────────┬────────┘                                ││
              │            │                                          ││
              │            ▼                                          ││
              │     packages/runtime  (TypeScript)                    ││
              │     · manifest loader                                 ││
              │     · Inngest function registry                       ││
              │     · step engine (tool / logic / manual)             ││
              │     · context loader (DB + files)                     ││
              │     · log writer                                      ││
              │     · event ledger writer                             ││
              │     · task gating                                     ││
              └──────┬──────────────────┬──────────────────┬──────────┘│
                     │                  │                  │           │
                     ▼                  ▼                  ▼           │
              ┌──────────────┐  ┌──────────────┐   ┌───────────────┐   │
              │   SQLite     │  │  Filesystem   │  │   Inngest      │──┘
              │ (better-sql) │  │  logs/        │  │   (event bus,  │
              │  metadata    │  │  artifacts/   │  │    durable)    │
              └──────────────┘  └──────────────┘   └────────────────┘
```

- **Next.js 16.2.10** hosts the portal (React 19); application data APIs live in Fastify.
- **Inngest** is the durable event bus + step-function engine. Every agent
  becomes one Inngest function. Inngest handles retries, dead-letter,
  cancellation, fan-out, concurrency keys.
- **SQLite** (better-sqlite3, WAL mode) stores metadata. Drizzle ORM
  provides typed queries + migrations.
- **Files** store the things that are large and append-mostly: run logs,
  event payloads, artifacts.

---

## 2 · Repository layout

```
agentic-operator/
├── apps/
│   ├── portal/                 # Next.js 16.2.10 — UI
│   │   ├── app/
│   │   │   ├── api/
│   │   │   │   ├── events/route.ts
│   │   │   │   ├── agents/[id]/route.ts
│   │   │   │   ├── runs/[id]/route.ts
│   │   │   │   ├── tasks/[id]/resolve/route.ts
│   │   │   │   ├── webhooks/[provider]/route.ts
│   │   │   │   └── inngest/route.ts
│   │   │   └── portal/
│   │   │       ├── (dashboard)/page.tsx
│   │   │       ├── workflows/page.tsx
│   │   │       ├── agents/[id]/page.tsx
│   │   │       ├── runs/[id]/page.tsx
│   │   │       ├── events/page.tsx
│   │   │       ├── tasks/[id]/page.tsx
│   │   │       ├── logs/page.tsx
│   │   │       └── deployments/page.tsx
│   │   └── components/         # UI primitives matching prototype
│   └── cli/                    # `agentic` CLI
├── packages/
│   ├── runtime/                # Manifest loader, step engine, Inngest wiring
│   ├── db/                     # Drizzle schema + migrations
│   ├── shared/                 # Types shared between runtime + portal
│   └── tools/                  # First-party tool implementations
├── workflows/                  # Per-tenant workflow source
│   └── raas/
│       ├── manifest.json       # = uploads/workflow_v1.json
│       ├── actions.json        # = uploads/actions_v1.json
│       └── tools/              # Custom tools for RAAS
├── logs/                       # Runtime-written (gitignored)
├── artifacts/                  # Runtime-written (gitignored)
└── docs/                       # This folder
```

Monorepo manager: **Turborepo**. Package manager: **pnpm**.

---

## 3 · Data model (SQLite via Drizzle)

```ts
// packages/db/schema.ts (abridged)

tenants:               { id, slug, name, created_at }
users:                 { id, email, name, created_at }
memberships:           { user_id, tenant_id, role }     // role: admin|operator|viewer

workflows:             { id, tenant_id, slug, name, created_at }
workflow_versions:     { id, workflow_id, version, manifest_json, created_at, created_by }
deployments:           { id, tenant_id, target, version_id, status, deployed_by, deployed_at, note }
                        // target: 'workflow'|'agent'|'runtime'; status: 'live'|'rolled_back'|'pending'

agents:                { id, workflow_id, kebab_id, name, actor }  // actor: 'Agent'|'Human'
agent_versions:        { id, agent_id, workflow_version_id, manifest_json }

events:                { id, tenant_id, name, category, source_agent_id, subject,
                         received_at, payload_ref }              // payload_ref = "logs/events/2026-05-16.ndjson#0x2af1"
event_listeners:       { event_name, agent_id }                  // denormalized index

runs:                  { id, tenant_id, agent_id, agent_version_id, trigger_event_id,
                         status, started_at, ended_at, duration_ms,
                         tokens_in, tokens_out, model,
                         emitted_event_id, error_message, log_path, correlation_id, subject }

steps:                 { id, run_id, ord, name, type, status,
                         started_at, ended_at, duration_ms, input_ref, output_ref, error }

tasks:                 { id, tenant_id, run_id, type, title, awaiting_role, awaiting_user_id,
                         priority, status, created_at, resolved_at, resolved_by, payload_json,
                         resolution_json }                       // status: 'open'|'resolved'|'snoozed'

artifacts:             { id, tenant_id, run_id, kind, path, size, created_at }

audit_log:             { id, tenant_id, actor_user_id, action, target_type, target_id, at, meta_json }
api_tokens:            { id, tenant_id, hash, name, scopes, created_at, last_used_at }
```

Notes:
- `payload_ref` and `input_ref` / `output_ref` are pointers into NDJSON
  files (`path#offset`). This keeps SQLite small while letting the portal
  fetch any payload on demand.
- Every table that has user-visible data has a `tenant_id`. Drizzle
  helpers enforce tenant scoping on every query (`withTenant(ctx)`).

---

## 4 · Manifest schema

The RAAS files in `uploads/workflow_v1.json` and `uploads/actions_v1.json`
are the canonical reference. A **workflow manifest** is:

```jsonc
// workflow.json
[
  {
    "id": "10",                          // kebab-id (stable across renames)
    "name": "matchResume",               // function name (camelCase)
    "title": "Match Resume",             // human label
    "description": "...",
    "actor": ["Agent"],                  // or ["Human"]
    "trigger": ["RESUME_PROCESSED"],     // event names this agent listens for
    "actions": [                         // ordered steps
      {
        "order": "1",
        "name": "validateRedlineAndBlacklist",
        "type": "logic",                 // tool | logic | manual
        "description": "...",
        "condition": "..."
      }
    ],
    "triggered_event": [                 // events this agent can emit
      "MATCH_PASSED_NEED_INTERVIEW",
      "MATCH_PASSED_NO_INTERVIEW",
      "MATCH_FAILED"
    ]
  }
]
```

An **actions manifest** (one entry per step) adds:
- `submission_criteria` — pre-conditions
- `target_objects` — DB tables/objects touched
- `inputs[]`, `outputs[]` — typed I/O with `source_object` references
- `rules[]` — business rules attached to a step

The runtime loads both files together, validates with Zod, and registers
one Inngest function per agent.

### Schema validation

`packages/runtime/manifest.ts` exposes:

```ts
import { z } from "zod";

export const ManifestSchema = z.array(AgentSchema);
export const AgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string(),
  actor: z.array(z.enum(["Agent", "Human"])),
  trigger: z.array(z.string()),
  actions: z.array(ActionSchema),
  triggered_event: z.array(z.string()),
});
// ...
```

---

## 5 · Runtime — agent execution model

For every agent in the manifest, we register an Inngest function:

```ts
// packages/runtime/register.ts (abridged)
import { inngest } from "./client";

export function registerAgent(agent: Agent, tenant: Tenant) {
  const fnId = `${tenant.slug}.${agent.kebab_id}`;
  return inngest.createFunction(
    {
      id: fnId,
      name: agent.title,
      concurrency: { limit: 8, key: `event.data.subject` },
      retries: 3,
    },
    agent.trigger.map((name) => ({ event: `${tenant.slug}/${name}` })),
    async ({ event, step, logger }) => {
      const run = await runs.create({ tenantId: tenant.id, agentId: agent.id, triggerEventId: event.data.event_id });
      logger.info("run.start", { run_id: run.id });

      const ctx = await loadContext(agent, event);
      let result;

      for (const action of agent.actions) {
        result = await step.run(action.name, async () => {
          if (action.type === "tool")   return runTool(action, ctx);
          if (action.type === "logic")  return runLLMOrLogic(action, ctx);
          if (action.type === "manual") return waitForTask(action, ctx);
        });
        await steps.recordOk(run.id, action.name, result);
      }

      const emitted = decideEmittedEvent(agent, result);
      if (emitted) await inngest.send({ name: `${tenant.slug}/${emitted}`, data: { ... } });
      await runs.complete(run.id, emitted);
      logger.info("run.end", { run_id: run.id, status: "ok" });
    }
  );
}
```

### Step types

- **`tool`** — calls a function from `packages/tools/*` (HTTP, DB, OCR,
  LLM, channel adapter, etc.). Strongly typed inputs/outputs.
- **`logic`** — typically an LLM call with structured output (Zod
  schema). Used for analysis, generation, scoring.
- **`manual`** — pauses the run and creates a row in `tasks`. The
  function does `await step.waitForEvent(`task.${taskId}.resolved`, …)`.
  When the operator resolves the task in the portal, the API route emits
  that event, and the function resumes.

### Concurrency keys

To prevent two simultaneous runs of the same agent on the same subject
(e.g., two `matchResume` runs for the same candidate), every agent
declares a `concurrencyKey` template. Default: `event.data.subject`.

### Retries & backoff

Default 3 retries, exponential backoff (Inngest defaults). Per-step
overrides allowed in the manifest:

```jsonc
{ "name": "publishToBoss", "type": "tool", "retries": 5, "timeout_s": 30 }
```

---

## 6 · Event flow

```
external system               Agentic Operator                     Inngest
─────────────────             ───────────────────                  ─────────
POST /api/events  ──┐
                    ├──▶ validate token & schema
                    ├──▶ insert events row (SQLite)
                    ├──▶ append payload to logs/events/<date>.ndjson
                    └──▶ inngest.send({ name: "raas/REQUIREMENT_LOGGED", data })
                                                                         │
                                                              fans out to listeners
                                                                         │
                                                                         ▼
                                              run analyzeRequirement step function
                                                                         │
                                                              emits ANALYSIS_COMPLETED
                                                                         │
                                                                         ▼
                                                run clarifyRequirement step function
                                                                         ...
```

**Event names are namespaced by tenant**: `raas/REQUIREMENT_LOGGED`
inside Inngest. The portal strips the namespace for display.

**Payloads** are stored once in the NDJSON ledger; SQLite stores a
pointer. When the portal asks for an event detail, the API streams the
JSON from the file via the pointer.

---

## 7 · APIs

### Public (tenant-scoped, token auth)

| Method | Path | Body | Returns |
|---|---|---|---|
| `POST` | `/api/events` | `{name, subject, payload}` | `{event_id}` |
| `POST` | `/api/webhooks/:provider` | provider-specific | `{ok}` |
| `GET`  | `/api/runs/:id` | — | `Run` |
| `GET`  | `/api/runs/:id/logs?from=&follow=` | — | `text/event-stream` |
| `POST` | `/api/tasks/:id/resolve` | `{decision, payload}` | `{ok}` |
| `GET`  | `/api/artifacts/:id` | — | file stream |

### Portal (session auth, role-checked)

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/agents` | list, filter by tenant |
| `POST` | `/api/agents` | upload manifest (mode 1 deploy) |
| `GET`  | `/api/agents/:id/versions` | version history |
| `POST` | `/api/deployments` | promote a version to live |
| `POST` | `/api/deployments/:id/rollback` | flip live pointer |
| `POST` | `/api/runs/:id/replay` | re-trigger from the run's input event |
| `POST` | `/api/events/:id/replay` | re-emit one event |

### Internal

| Method | Path | Notes |
|---|---|---|
| any    | `/api/inngest` | Inngest's webhook endpoint |

All endpoints return `{ok: true, data}` on success or
`{ok: false, error: { code, message, hint? } }` on failure. Standard
HTTP status codes apply.

---

## 8 · Files on disk

```
/var/agentic/
├── logs/
│   ├── runs/
│   │   ├── 2026-05-16/
│   │   │   ├── run-01000.log         # text, one line per event
│   │   │   └── run-01001.log
│   │   └── 2026-05-15/...
│   ├── events/
│   │   └── 2026-05-16.ndjson         # one JSON event per line
│   └── system/
│       ├── inngest.log
│       ├── scheduler.log
│       └── errors.log
├── artifacts/
│   └── <tenant>/<run-id>/<artifact-id>.pdf
└── deploys/
    └── <tenant>/<workflow-version>/  # snapshot of the deployed manifest + code
```

### Log line format

```
2026-05-16T08:14:02.001Z  INFO   run.start  run_id=run-01000 agent=matchResume subject=CAN-88412 trigger=RESUME_PROCESSED
2026-05-16T08:14:02.094Z  DEBUG  tool       blacklist.lookup status=ok hits=0
2026-05-16T08:14:02.301Z  INFO   step.ok    name=validateRedlineAndBlacklist duration=283ms
```

Logical fields (`run_id`, `agent`, `subject`, `step`, `tool`) are
extracted to JSONL sidecars when log volume grows enough to justify a
search index.

---

## 9 · Deployment model

Three deploy modes share the same primitive: a `WorkflowVersion` record
with the full manifest JSON. The differences are how the JSON is produced.

### Mode 1 — Manifest upload (portal)

1. Operator drops `workflow.json` + `actions.json` in the Deployments page
2. Server validates with Zod, diffs against the live version, shows
   `+added / ~modified / −removed` agents and event types
3. On confirm, server inserts new `WorkflowVersion` + `Deployment` rows
4. Inngest functions for changed agents are re-registered atomically
5. In-flight runs continue on their original version (each run is pinned
   to its `agent_version_id`)

### Mode 2 — Code package (CLI)

```bash
$ npx agentic deploy raas --version 2026.05.16-b --target prod

✓ Bundled 22 agents (4 changed)
✓ Compiled handlers (TypeScript 6, Node 26.5.0)
✓ Validated manifest
✓ Uploaded to /var/agentic/deploys/raas/2026.05.16-b/
✓ Registered with Inngest worker · 1842 active runs migrated
→ Live in 3.4s
```

The CLI compiles a TypeScript workflow package (which contains both the
manifest *and* tool implementations), uploads via the API, and triggers
the same path as Mode 1.

### Mode 3 — Visual builder (portal)

A canvas UI lets operators drag agents from a palette and wire them with
events. "Save" produces the same JSON manifest, then enters Mode 1.

### Rollback

`POST /api/deployments/:id/rollback` flips the `live` pointer back to a
prior version. New events route to the prior agent definitions; in-flight
runs are unaffected (they finish on their pinned version).

---

## 10 · Human-in-the-loop

```
agent run ─▶ step.run("packageReview", () => waitForTask(...))
              │
              ▼
         tasks INSERT
              │
              ▼   (UI poll / SSE)
       Operator clicks "Approve" in Tasks inbox
              │
              ▼
   POST /api/tasks/:id/resolve  { decision: "approve" }
              │
              ▼
   inngest.send("task.resolved.<task-id>", {payload, decision})
              │
              ▼
   waitForTask returns inside the function
              │
              ▼
   agent emits PACKAGE_APPROVED or PACKAGE_REJECTED based on decision
```

Tasks have a `type` (e.g. `jdReview`, `packageReview`, `resumeFix`) that
the portal uses to render a type-specific review surface. New task types
are added by:

1. Declaring the `manual` step in the manifest with a `task_type` field
2. Registering a React component for that `task_type` in the portal
3. (Optional) Providing a schema for the resolution payload

---

## 11 · Multi-tenancy

- Every Inngest function ID is namespaced: `raas.matchResume` vs.
  `supportflow.triageTicket`
- Every event name is namespaced inside Inngest: `raas/JD_APPROVED`
- Every DB row carries `tenant_id`; every query goes through a Drizzle
  helper that injects the tenant filter
- Log directories are per-tenant: `logs/<tenant>/runs/<date>/...`
- API tokens are tenant-scoped
- Portal users may have memberships in multiple tenants; the sidebar
  switcher changes the active context

---

## 12 · Observability of the platform itself

- `/var/agentic/logs/system/*.log` for runtime logs
- Health endpoint: `GET /api/health` returns Inngest/SQLite/disk status
- The portal Dashboard surfaces these in the "Runtime" panel
- Optional: ship to OpenTelemetry; structure already supports it

---

## 13 · Security & auth

- Sign-in: magic link via Resend (or your provider)
- Portal sessions: HTTP-only cookies, 30-day rolling
- API tokens: SHA-256 hashed, never stored plaintext, scoped to a tenant
- Webhook signatures verified per provider
- All credentials stored as env vars or, for v2, encrypted in SQLite via
  libsodium with a master key from KMS
- Audit log: every deploy, rollback, task resolution, manifest change,
  token issuance writes an `audit_log` row

---

## 14 · Versions & dependencies (latest stable, May 2026)

| Dep | Version |
|---|---|
| Node | 26.5.0 Current |
| TypeScript | 5.6+ |
| Next.js | 15.x |
| React | 19.x |
| Inngest SDK | 3.x |
| better-sqlite3 | 11.x |
| Drizzle ORM | 0.34+ |
| Zod | 3.23+ |
| Tailwind CSS | 4.x |
| Turborepo | 2.x |
| pnpm | 9.x |

---

## 15 · Scaling path (when SQLite hurts)

- **First sign of pressure**: WAL contention on `events` table.
  Mitigation: shard the events index by day (`events_2026_05`).
- **Second sign**: portal queries get slow. Mitigation: add indices on
  `(tenant_id, started_at)` for runs and `(tenant_id, name, received_at)`
  for events.
- **Real migration**: swap Drizzle adapter from `better-sqlite3` to
  `postgres-js`. Schema is the same; rewrite is a 1-day job.
- **Inngest scale**: bump worker count; concurrency keys keep
  per-subject ordering even at high parallelism.

---

## 16 · Testing strategy

- **Unit**: Zod manifest validation, step engine, tool I/O contracts
- **Integration**: spin up Inngest dev server + a temp SQLite, run RAAS
  manifest end-to-end with mock external systems
- **E2E**: Playwright tests against the portal hitting the real runtime
  with the seed RAAS workload
- **Replayable fixtures**: store representative event payloads in
  `tests/fixtures/<tenant>/<event-name>.json` so every agent has at
  least one canned input

---

## 17 · Where the prototype maps to code

The prototype in `index.html` is the visual spec. Each view there should
map to one Next.js page:

| Prototype view (`views/*.jsx`) | Next.js page |
|---|---|
| `dashboard.jsx` | `app/portal/(dashboard)/page.tsx` |
| `workflows.jsx` | `app/portal/workflows/page.tsx` |
| `agents.jsx` | `app/portal/agents/page.tsx` + `[id]/page.tsx` |
| `runs.jsx` | `app/portal/runs/page.tsx` + `[id]/page.tsx` |
| `events.jsx` | `app/portal/events/page.tsx` |
| `tasks.jsx` | `app/portal/tasks/page.tsx` + `[id]/page.tsx` |
| `logs.jsx` | `app/portal/logs/page.tsx` |
| `deployments.jsx` | `app/portal/deployments/page.tsx` |

Color tokens, type ramp, badges, status dots, panel chrome — all defined
in `index.html` `<style>`. Lift them into Tailwind 4 design tokens and
shadcn components.
