# Prompts

This document captures the **original** brief that started the project and
the **refined** brief we'd hand to an engineering agent (Claude Code) today.

---

## Original prompt

> **Agentic Operator**
>
> **Goal:**
> - design and build an event-driven agentic workflow runtime, Agentic Operator
>   system which is a Agentic Operating System that runs AI agents in workflows
>   that are event-driven.
>
> **Expectations:**
> - user can deploy agents.
> - user can monitor and manage agents.
> - user can manage and monitor all events
>
> **Systems:**
> 1. use Inngest as the event system
> 2. Use files to store logs
> 3. Do we need a light weight sql? Which one?
> 4. Can we use Typescript, Next.js, node.js, and React? All use latest version.
>
> **Questions:**
> - how does user deploy agents?
> - How is the runtime environment like?
> - The frontend/portal is where admin manage the agents.
> - Will it have APIs?
>
> Attached is the events, agents, objects, and workflow for RAAS, one of the
> applications that will use Agentic Operator system.

---

## Refined prompt (implementation-ready)

> Build **Agentic Operator** — a multi-tenant, event-driven runtime + admin
> portal for AI agent workflows.
>
> **The runtime** executes workflows defined as DAGs of agents wired by named
> events. Each agent has a trigger event (or set of them), runs an ordered
> sequence of steps (`tool` / `logic` / `manual`), and emits one of several
> typed outcome events. Manual steps pause the run and surface as tasks in a
> human-in-the-loop inbox until an operator acts; resumption replays the next
> step automatically.
>
> **The portal** is the operator's control plane: a Dashboard for live state,
> a Workflow canvas (DAG of agents with animated event edges), an Agents
> explorer, a Runs view with per-run timeline + logs + I/O, an Events stream
> with replay, a Tasks inbox, a file-backed Logs explorer, and a Deployments
> page with version history + rollback.
>
> **The proof workload** is **RAAS** (Recruitment-as-a-Service): 22 agents
> wired by 33 event types spanning intake → analyze → JD → publish → resume
> → match → AI interview → evaluate → package → submit. Its workflow is
> provided as a manifest (`workflow_v1.json` + `actions_v1.json`) — the
> runtime must load it without code changes.
>
> **Stack** (all latest stable as of May 2026):
> - **Next.js 16.2.10** App Router · **React 19** · **TypeScript 6** · **Node 26.5.0**
> - **Inngest** as the durable event bus / step-function engine
> - **SQLite** via `better-sqlite3` for metadata; **Drizzle ORM** for schema
> - **Files** on disk for logs (`logs/runs/<date>/<run-id>.log`), event
>   payloads (`logs/events/<date>.ndjson`), and artifacts (`artifacts/...`)
> - **Tailwind 4** + **shadcn/ui** for the portal; IBM Plex Sans/Mono +
>   Instrument Serif for type
>
> **Agent deployment** supports three modes:
> 1. **Manifest upload** — drop a `workflow.json` + `actions.json` matching
>    the RAAS schema
> 2. **Code package** — TypeScript module deployed via `npx agentic deploy`
>    or `git push agentic main:<tenant>/prod`
> 3. **Visual builder** — drag-and-drop canvas that compiles to a manifest
>
> Every deploy creates an immutable **AgentVersion** + a **Deployment**
> pointer (so rollback is one click).
>
> **APIs** (REST/RPC via Next.js route handlers):
> - `POST /api/events` — ingest external events
> - `POST /api/agents`, `GET /api/agents`, `GET /api/agents/:id`
> - `GET /api/runs`, `GET /api/runs/:id`, `GET /api/runs/:id/logs`
> - `GET /api/artifacts/:id`
> - `POST /api/webhooks/:provider` — provider callbacks (channels, ATS)
> - `POST /api/tasks/:id/resolve` — human-task resolution
> - `/api/inngest` — Inngest's own endpoint
>
> **First-class human-in-the-loop**: tasks have type-specific review surfaces
> (JD review, package approval, resume fix, clarification, supplement,
> manual publish). Approving emits the agent's success event; rejecting
> emits its failure event.
>
> **Multi-tenant**: RAAS is the first tenant; the system runs ≥1 tenant
> from day one with hard data isolation (tenant_id on every row + per-tenant
> log directories + per-tenant Inngest function names).
>
> **Deliverables**:
> - Working monorepo (`apps/portal`, `apps/runtime`, `packages/*`)
> - Migrations + seed scripts (seeds RAAS as a tenant)
> - The portal at `/portal/*` matching the prototype
> - CLI: `agentic deploy`, `agentic logs`, `agentic events tail`
> - Docs: deployment guide, manifest schema reference, API reference

---

## Why the refined prompt looks this way

- **Goal restated as one paragraph at the top** so an engineering agent has
  the whole picture before any specifics.
- **The proof workload (RAAS) is explicit** — without a concrete workload,
  the abstractions tend to drift. Building to RAAS first keeps the design
  honest.
- **Three deploy modes** are listed because they each require different
  scaffolding (file parser, CLI + bundler, canvas → manifest compiler).
- **APIs are enumerated** so the route handlers can be stubbed in a single
  pass.
- **Storage choices are decided** (Inngest, SQLite, files) — no open
  technical questions left in the brief.
- **The portal is described by referencing the prototype**, which is
  authoritative for visual + interaction design.
