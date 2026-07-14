# Agentic Operator — Handoff Package

This folder is the handoff packet for the **Agentic Operator** system: an
event-driven agentic workflow runtime ("Agentic OS") that deploys, runs,
observes, and manages AI agents.

The companion design prototype lives at the project root in `index.html` —
open it to see the admin portal that this codebase will eventually ship.

---

## What's in this packet

| File | What it is | Read when |
|---|---|---|
| **[PROMPTS.md](./PROMPTS.md)** | The original user prompt + a refined, implementation-ready brief | First — sets context |
| **[PRD.md](./PRD.md)** | Product Requirements Document — users, jobs-to-be-done, scope, success metrics | Second — what we're building |
| **[DESIGN.md](./DESIGN.md)** | System design — runtime architecture, data model, APIs, deploy model | Third — how we'll build it |
| **[USER_GUIDE.md](./USER_GUIDE.md)** | How operators use the portal day-to-day | When wiring the portal to the real runtime |

---

## How to vibe-code this with Claude Code

Recommended path:

1. **Skim PROMPTS.md** to internalize the goal in one paragraph.
2. **Read PRD.md** to understand who uses what and why.
3. **Read DESIGN.md** thoroughly** — it's the implementation contract.
4. **Open the prototype** (`index.html`) in a browser and play with every
   screen. The runtime exists so the portal can show what it shows.
5. **Build in this order** (each step is independently verifiable):
   1. Monorepo + tooling (Turborepo, TypeScript 6, Node 26.5.0, Next.js 16.2.10)
   2. SQLite schema + Drizzle ORM migrations
   3. Inngest client + a single end-to-end "hello" workflow
   4. Event ingestion API (`POST /api/events`)
   5. Agent runtime: load a manifest → register Inngest functions
   6. Port the RAAS manifest (`uploads/workflow_v1.json` + `actions_v1.json`)
   7. Port the portal views (the prototype is the spec)
   8. Human-task system (pause/resume runs via inbox)
   9. Deployments (versioning, rollback)
   10. Multi-tenant + auth + audit

Each milestone should leave the system runnable end-to-end with the existing
RAAS demo data.

---

## Source artifacts referenced

- `uploads/workflow_v1.json` — the RAAS workflow definition (22 agents,
  33 event types). Used as the canonical sample manifest.
- `uploads/actions_v1.json` — the RAAS action specifications with per-step
  rules, inputs, outputs.
- `index.html` (+ `app.jsx`, `components.jsx`, `views/*`, `data.js`) —
  hi-fi prototype of the admin portal. Treat the prototype as a visual spec
  and interaction reference; the runtime should drive the same surface from
  real data.

---

## Conventions

- All copy is **English**. RAAS source files are bilingual (CN/EN); when
  surfacing them in the UI, translate or default to the English title.
- All times are stored as **UTC** in the DB; rendered in the operator's
  local timezone in the UI.
- All IDs are **prefixed** for legibility: `run-`, `evt-`, `agt-`, `dpl-`,
  `tsk-`, `wf-`, `ten-`.
- All events use **SCREAMING_SNAKE_CASE** names (matches the RAAS source).
- All agents have a stable **kebab-id** that survives renames.
