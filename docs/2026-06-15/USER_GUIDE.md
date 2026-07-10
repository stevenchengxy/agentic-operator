# Agentic Operator — User Guide

> **Audience:** developers and operators running Agentic Operator locally or self-hosted. Not a marketing doc — assumes you have a terminal open and want to ship.
>
> **Companion docs:** [PRD.md](PRD.md) (what + why), [DESIGN.md](DESIGN.md) (how), [IMPLEMENTATION.md](IMPLEMENTATION.md) (when + where), [RUNBOOK.md](RUNBOOK.md) (ops + incident response).

---

## 1. What is Agentic Operator?

Agentic Operator is a multi-tenant **operating system for LLM agents and workflows**. It gives you the platform plumbing — durable execution, ledger, LLM gateway, tool registry, observability, multi-tenancy, deployment — so you only write the parts that are unique to your domain.

Two ways to author an agent:

- **Manifest agent** (JSON spec, declarative): a `workflow_v1.json` node with `name`, `trigger`, `actions`, `triggered_event`. No code required. Ideal for orchestrating LLM calls + tools through standard step types.
- **Code agent** (TypeScript class extending `BaseAgent`): full programmatic control. Multi-step tool-use loops, custom output schemas, custom tools.

Both run under the same runtime, write to the same ledger, and surface in the same portal.

---

## 2. Five-minute tour

```bash
# 1. Clone + install
git clone <your-fork> agentic-operator && cd agentic-operator
nvm use                                 # picks Node 26 from .nvmrc
pnpm install

# 2. Configure (one-time)
cp .env.production.example .env         # then fill in at least one LLM provider key
export AGENTIC_MODELS_DIR="$(pwd)/models"

# 3. Boot the stack — concurrent web + api + Inngest dev server
pnpm dev
# → portal:    http://localhost:3599
# → api:       http://localhost:3501
# → inngest:   http://localhost:8288

# 4. Open the portal
open http://localhost:3599/portal/raas/dashboard
```

You should land on the dashboard with the seeded RAAS workflow (23 manifest agents + 1 code agent loaded from `models/RAAS-v1/`). Click around — every view has live data.

---

## 3. Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node | **26 LTS** (`.nvmrc`) | Hard requirement; `better-sqlite3` is pinned to the matching ABI. `nvm use` after every shell switch. |
| pnpm | **11+** | Workspaces + Turbo. |
| Docker | optional | Only needed for `pnpm dev:docker` or production builds. |
| Disk | ~2 GB | Node modules, `data/` (SQLite + artifacts + tenant code). |
| LLM provider key | at least 1 | Any of: OpenAI, Anthropic, OpenRouter, Google Gemini, Groq, Together, Mistral, DeepSeek, Qwen, Azure, Bedrock, Vertex, or your own. |

### Required environment variables

Set these in `.env` at the repo root (gitignored). The minimum:

```bash
NODE_ENV=development                                    # production for prod
AGENTIC_MODELS_DIR=/abs/path/to/agentic-operator/models  # where workflow_v1.json lives
AGENTIC_DATA_DIR=/abs/path/to/agentic-operator/data      # SQLite, logs, artifacts
AUTH_MODE=dev                                            # bypass auth in dev (DO NOT set in prod)

# Pick at least one:
OPENROUTER_API_KEY=sk-or-…
# or
ANTHROPIC_API_KEY=sk-ant-…
# or
OPENAI_API_KEY=sk-…
```

Full env contract in [.env.production.example](../.env.production.example).

---

## 4. The portal at a glance

The portal lives at `http://localhost:3599/portal/<tenant>/<view>`. Every URL is shareable + deep-linkable.

| View | URL | What you can do |
|---|---|---|
| **Dashboard** | `/portal/raas/dashboard` | Live KPIs, active runs, event ticker, pending human tasks, RAAS funnel |
| **Workflows** | `/portal/raas/workflows` | DAG canvas; edit mode saves back to `workflow_v1.json` |
| **Agents** | `/portal/raas/agents` | List + detail; 5 tabs (config / io / code / versions / runs); **Test run** button |
| **Runs** | `/portal/raas/runs` | List + detail; tabs: timeline / logs / io / events / agent. **REPLAY** badge on replayed runs |
| **Events** | `/portal/raas/events` | Histogram + filters + EventDetail |
| **Human tasks** | `/portal/raas/tasks` | Inbox; 6 payload renderers; approve / reject |
| **Logs** | `/portal/raas/logs` | File-tree + grep + SSE tail |
| **Deployments** | `/portal/raas/deployments` | Per-agent version history; promote / rollback |
| **Settings** | `/portal/raas/settings` | 9 sections: workspace, people, models, channels, integrations, notifications, tokens, billing, audit, usage |

### Keyboard

- **⌘+K** — command palette: jump to any agent / run / event / task / settings page
- **⌘+\\** — toggle the Tweaks panel (theme / density / accent / live-stream toggle)

### Density + theme

Settings → Workspace lets you swap dark/light theme, compact/comfortable density, accent color (lime is the default). All persisted via `POST /api/prefs`.

---

## 5. The canonical use case — workflow JSON → canvas → runtime

This is the path everything else builds on. Five steps end-to-end:

### 5.1 Load a workflow from JSON

Place a workflow manifest at `models/<workflow-slug>/workflow_v1.json`. Each entry is one node:

```json
{
  "id": "2",
  "name": "analyzeRequirement",
  "description": "Assess feasibility, generate clarification questions, draft sourcing strategy.",
  "actor": ["Agent"],
  "trigger": ["REQUIREMENT_SYNCED", "REQUIREMENT_LOGGED"],
  "input_data": {
    "job_requisition_id": "客户岗位唯一编号",
    "client_id": "客户唯一编号"
  },
  "ontology_instructions": "# Vocabulary\n- 红线 (redline): hard-fail criteria…",
  "actions": [
    { "order": "1", "name": "loadContextData", "type": "tool", "condition": "client_id != null" },
    { "order": "2", "name": "assessFeasibility", "type": "logic" },
    { "order": "3", "name": "generateClarification", "type": "logic" }
  ],
  "tool_use": [
    { "name": "loadContextData", "description": "Fetch contract + history for a client", "input_schema": { /* JSON Schema */ } }
  ],
  "typescript_code": "",
  "triggered_event": ["ANALYSIS_COMPLETED", "ANALYSIS_BLOCKED"]
}
```

Reference the full RAAS-v1 spec at [models/RAAS-v1/workflow_v1.json](../models/RAAS-v1/workflow_v1.json) for 23 production-grade examples.

On every `pnpm dev` boot, the runtime reads this file and:
- Inserts/updates `agents`, `agent_versions`, `workflows`, `workflow_versions`, `event_listeners`, `deployments` rows
- Registers one Inngest function per Agent-actor node
- Logs `[bootstrap] raas (RAAS-v1): 22/23 agents · …`

The "22/23" message means 22 valid agents loaded; the 1 skipped is a Human-actor with no auto-trigger (correctly excluded from runtime registration).

### 5.2 See it on the canvas

Open http://localhost:3599/portal/raas/workflows.

The view fetches `GET /v1/workflows/dag`, which returns `{agents, edges, workflowVersion}`. The canvas:
- **Stage lanes**: agents grouped by their stage prefix (1, 2, 3-2, …) into 8 swimlanes
- **Edges**: rendered as SVG with the event name on the arrow
- **Hand-tuned LAYOUT map** preserves the v1_1 spatial arrangement; auto-pack is intentionally not applied

Click any node → agent detail at `/portal/raas/agents/<id>`.

### 5.3 Fire a workflow

Two browser-only ways:

**(a) Click "Test run" on any agent's detail page** (the recommended path)

- For a code agent (`testAgent`): runs inline, returns 200 + real LLM output
- For a manifest agent (any RAAS agent): emits the agent's first trigger event into Inngest, returns 202 + queued status, and the cascade fires

The button calls `POST /v1/agents/<name>/invoke?testRun=1`. The route looks up the code registry first, then falls back to a DB lookup for manifest agents and emits `<tenant>/<first-trigger-event>` into Inngest.

**(b) Subject auto-derivation**

When you pass `{input: {job_requisition_id: "REQ-2041"}}` (or `candidate_id`, or `subject`), the route binds that as the event subject. If you pass nothing, you get a synthetic `TEST-<random>` subject so the run is still trackable.

**(c) Cannot test a Human-actor agent**

Human-actor agents (e.g. `manualEntry`, `jdReview`) have no auto-trigger. The route returns 409 with hint to `POST /v1/events` directly. From the portal, navigate to **Tasks** to resolve them.

### 5.4 Watch the cascade

Open http://localhost:3599/portal/raas/runs in another tab while you fire. The new run row appears at the top within ~1s via SSE (`/v1/stream`).

For an event like `REQUIREMENT_SYNCED` that has multiple downstream subscribers, you'll see several rows populate as Inngest dispatches each:

```
run-… analyzeRequirement              status=running   trig=REQUIREMENT_SYNCED
run-… anotherAgentListeningSameEvent  status=running   trig=REQUIREMENT_SYNCED
```

Click any run → detail tabs:
- **timeline** — per-step bar chart; the running step pulses
- **logs** — file-tail of `data/logs/<run-id>.log` via SSE
- **io** — input event + output result side-by-side
- **events** — events emitted by this run
- **agent** — the **full agent context**: code, ontology, input_data schema, tool_use definitions, runtime. Same widget as the agent detail's Code tab, so debugging a run lets you see exactly what the agent saw.

### 5.5 Trigger by event name (when you don't want to invoke a specific agent)

`POST /v1/events` with `{name, subject, payload}` emits any event into Inngest. Every subscribed agent fires. This is the "kick off the whole workflow from the top" path:

```bash
curl -X POST -H "X-Tenant-Slug: raas" -H "Content-Type: application/json" \
  -d '{"name":"REQUIREMENT_LOGGED","subject":"REQ-2041","payload":{"job_requisition_id":"REQ-2041","client_id":"Tencent"}}' \
  http://localhost:3501/v1/events
```

Future: the **Cmd-K palette** will gain an "Emit event" command. For now, the curl above (or the `agentic events emit` CLI when v1.1 lands) is the path.

---

## 6. Authoring a new agent

### 6.1 Manifest agent (the 90% case)

Edit `models/<tenant>/workflow_v1.json`. Either:

- **In the portal**: open Workflows view → click **Edit** in the toolbar → mutate a node → **Save**. The portal POSTs the new manifest to `/v1/agents`, the backend persists a new `workflow_version`, and the live deployment flips atomically.
- **In your editor**: edit the file directly. Restart the API (or trigger a hot reload — the dev watcher picks up `models/*` changes). Bootstrap idempotency means an unchanged manifest is a no-op.

A manifest agent must have:
- `name` (camelCase, unique within the workflow)
- `actor` — `["Agent"]` or `["Human"]`
- `trigger` — array of event names that activate it (empty for Human-actor entry-points)
- `actions[]` — ordered list of step definitions, each `{order, name, type, ...}`. Types: `tool`, `logic`, `manual`, `condition`, `delay`, `subflow`
- `triggered_event[]` — events the agent can emit on completion

Optional but recommended:
- `description`, `input_data` (schema for what the agent expects), `ontology_instructions` (prepended to every LLM call), `tool_use[]` (tool definitions exposed to the LLM)

### 6.2 Code agent (when manifests aren't enough)

Tenants ship code at `data/tenants/<slug>/<version>/src/agents/<name>.ts`. Subclass `BaseAgent`:

```ts
import { BaseAgent, defineTool } from "@agentic/agent-sdk";
import type { ChatMessage } from "@agentic/llm-gateway";

interface MatchInput {
  candidate_id: string;
  requisition_id: string;
}
interface MatchOutput {
  score: number;
  recommendation: "interview" | "skip" | "reject";
}

export class MatchResumeAgent extends BaseAgent<MatchInput, MatchOutput> {
  readonly name = "matchResume";
  readonly description = "Score a candidate resume against a job requisition.";
  readonly maxSteps = 5;
  readonly outputSchema = MatchOutput;

  protected buildMessages(input: MatchInput): ChatMessage[] {
    return [
      { role: "system", content: this.ontologyInstructions },
      { role: "user", content: `Score CAN-${input.candidate_id} against REQ-${input.requisition_id}.` },
    ];
  }

  protected override getTools() {
    return [blacklistLookup, scoringMatch];
  }
}

const blacklistLookup = defineTool({
  name: "blacklist_lookup",
  description: "Check if a candidate is on a client blacklist.",
  input_schema: { type: "object", properties: { candidate_id: { type: "string" } }, required: ["candidate_id"] },
  async impl({ candidate_id }) { /* ... */ },
});
```

Then add to `data/tenants/<slug>/<version>/agentic.json`:

```json
{
  "name": "raas",
  "version": "0.2.0",
  "agents": [{ "name": "matchResume", "file": "src/agents/matchResume.ts" }],
  "tools": [{ "name": "blacklist_lookup", "file": "src/agents/matchResume.ts" }]
}
```

Deploy via portal (Agents → Edit → Save) or CLI:

```bash
agentic deploy data/tenants/raas/0.2.0
```

The backend typechecks, builds a tarball-equivalent atomic switch, and re-registers Inngest functions without restart.

### 6.3 Tools

Tools come from three places, resolved in this order at run time:
1. **Tenant tools** — `data/tenants/<slug>/<version>/src/tools/<name>.ts` (highest priority)
2. **Platform tools** — `packages/tools/` (shared across tenants)
3. **Generic LLM fallback** — for manifest `logic` steps with no matching tool, the engine auto-builds a chat prompt from the action `name + description`

Define a tool with `defineTool({name, description, input_schema, impl})` from `@agentic/agent-sdk`. The `input_schema` is a JSON Schema; the LLM sees it for tool-calling.

---

## 7. The CLI

`apps/cli` ships four subcommands. After `pnpm install`, link it globally:

```bash
pnpm --filter @agentic/cli build
pnpm link --global ./apps/cli
agentic --help
```

| Command | Purpose |
|---|---|
| `agentic init <slug>` | Scaffold a new tenant project at `data/tenants/<slug>/0.1.0/` with example agent + tool + `agentic.json` |
| `agentic deploy [path]` | Typecheck + POST tarball to `/v1/tenants/<slug>/code`. Atomic deploy with rollback safety |
| `agentic logs <run-id> [--tail]` | Stream `/v1/runs/:id/logs` to stdout. `--tail` follows via SSE |
| `agentic events tail` | Subscribe to `/v1/stream`; pretty-print run / event / task lifecycle in real time |

Common workflows:

```bash
# Author a new tenant
agentic init customer-x
$EDITOR data/tenants/customer-x/0.1.0/src/agents/example.ts
agentic deploy data/tenants/customer-x/0.1.0

# Debug a misbehaving run
agentic events tail &
curl -X POST -H "X-Tenant-Slug: raas" -d '{"name":"REQUIREMENT_LOGGED",...}' http://localhost:3501/v1/events
# (watch the cascade in the terminal)
agentic logs run-abc123 --tail
```

The CLI reads `AGENTIC_API_URL` (default `http://localhost:3501`) and `AGENTIC_API_TOKEN`. Override on the command line with `--api` / `--token`.

---

## 8. Common operations

### 8.1 Deploy + rollback

Every successful save creates a new `agent_version` + `workflow_version` + `deployment` row. The previous live deployment is marked `rolled_back`. To roll back manually:

- **Portal**: Deployments view → click the desired version → **Promote**
- **API**: `POST /v1/deployments/:id/rollback`

Rollback is atomic — Inngest functions are re-registered in one step without API restart.

### 8.2 Human-in-the-loop

When a manifest step has `type: "manual"`, the run pauses and creates a row in `tasks`. The Tasks view shows:
- Priority badge (low / med / high)
- Payload (rendered per task type — 6 renderers ship)
- **Approve** / **Reject** buttons → calls `POST /v1/tasks/:id/resolve` → workflow continues

End users (recruiters, not operators) typically don't have portal access; they receive notifications (email / WeChat) with a signed task-resolution URL. This is the **FR-PORT-16** end-user notification path.

### 8.3 Cost control

Settings → Billing lets operators set per-tenant caps:
- **Monthly token cap** — gateway aborts a chat() before the adapter runs if expected tokens push over the cap
- **Monthly USD cap** — same but priced via the model catalog

The gateway throws `LLMError("cost_limit_exceeded")` and the run fails fast. The dashboard shows a running tally with 5-min lag.

### 8.4 Replay

Any run can be replayed: open it → **Replay** button → posts to `/v1/runs/:id/replay`. The new run appears at the top of the list with a `REPLAY` badge. It uses the same input event, the same agent version, the same model.

### 8.5 Memory across runs

Use `ctx.memory.{get, put, delete}(key, scope)` in code agents or manifest `tool_use` invocations. Scopes:

| Scope | Lifetime | Key form |
|---|---|---|
| `"run"` | Single run only | Cleared on run end |
| `"subject"` | Per (tenant, agent, subject) | Survives across runs |
| `"tenant"` | Per (tenant, key) | Cross-agent shared |

SQLite-backed in v1. Vector retrieval is a v2 plug-in via the `MemoryDriver` interface.

### 8.6 Triggers beyond events

- **Schedule (CRON)**: add `cron: "0 9 * * *"` + `cron_timezone: "Asia/Shanghai"` to a manifest agent. Runs daily at 9am tenant-local.
- **Webhook**: configure a subscription via Settings → Integrations, get a signed URL + secret. POST to `/v1/webhooks/<source>` with `X-Signature: hmac-sha256=…` and the agent fires.
- **Manual**: `POST /v1/agents/<name>/invoke` from anywhere (curl, CLI, portal Test run, SDK).

---

## 9. Multi-tenancy

Every URL, every API call, every DB query is scoped by tenant. The active tenant is in the URL pathname (`/portal/<tenant>/...`) and in the `X-Tenant-Slug` header (or JWT claim) on API calls.

To create a new tenant:

```bash
# (operator only — Settings → People → Add tenant from the portal, or CLI:)
agentic init my-tenant
agentic deploy data/tenants/my-tenant/0.1.0
```

The bootstrap creates rows in `tenants`, `workflows`, `workflow_versions`. The portal's tenant switcher (top-left in the sidebar) lists every tenant the current user is a member of.

**Isolation guarantees:**
- No `__system` fallback on tenant-scoped routes (P0-AUTH-02)
- `?tenant=` query param is ignored — tenant comes from auth (P0-AUTH-03)
- Every DB query joins on `tenant_id`; cross-tenant reads fail-closed

**The `__system` tenant** holds platform agents like `testAgent`. Reserved for platform internals; not addressable from tenant routes.

---

## 10. Observability

### 10.1 Logs

- **Structured (Pino)** to stdout with `requestId`, `tenantSlug`, `agentName`, `runId` on every line
- **Per-run files** at `data/logs/<run-id>.log` — tailable via `GET /v1/runs/:id/logs?follow=1` (SSE)
- **Portal Logs view** is a file-tree of these, with grep + level select + SSE follow

### 10.2 Metrics

`GET /metrics` returns Prometheus exposition format. Counters and histograms ship labeled by `(tenant, agent, model, status)`:

- `runs_total{...}`
- `run_duration_ms{...}` (histogram)
- `tokens_total{tenant, agent, model, direction}` (`direction` is `in` or `out`)
- `cost_usd_total{tenant, agent, model}`
- `http_requests_total{route, method, status}`
- `http_request_duration_ms{...}` (histogram)

Scrape from your Prometheus / Grafana Agent / Vector pipeline.

### 10.3 Audit log

Every state-mutating API call writes a row to `audit_log`:

| Action | Logged from |
|---|---|
| `event.publish` | `POST /v1/events` |
| `task.resolve` | `POST /v1/tasks/:id/resolve` |
| `deployment.create` | `POST /v1/agents` (manifest deploy) |
| `deployment.rollback` | `POST /v1/deployments/:id/rollback` |
| `tenant.code.deploy` | `POST /v1/tenants/:slug/code` |
| `agent.enable` / `agent.disable` | Settings → Agents |
| `budget.set` | `PUT /v1/budgets` |
| `api_token.create` / `revoke` | Settings → Tokens |

Read with `GET /v1/audit?since=&until=&actor=` (cursor-paginated), or browse in the portal at Settings → Audit.

### 10.4 Traces

Multi-step runs (tool-use loops, sub-flows) appear as a **trace tree** in the run detail. Each child has `parentRunId` set; the UI lazy-loads each subtree level on expansion.

---

## 11. Troubleshooting

### Boot

| Symptom | Cause | Fix |
|---|---|---|
| `ERR_DLOPEN_FAILED` | Wrong Node major | `nvm use` (picks up `.nvmrc` → Node 26) |
| Bootstrap reports `0/N agents` | `AGENTIC_MODELS_DIR` not set or wrong | `export AGENTIC_MODELS_DIR="$(pwd)/models"` |
| `api: SyntaxError: ... 'hostname'` | Stale build | `rm -rf node_modules .turbo && pnpm install` |
| `pnpm dev` hangs on port `:3599` | Stale dev process | `lsof -ti:3599,3501,8288,50052,50053 \| xargs kill -9` |
| Migrations fail on boot | Schema version mismatch | Check `_meta.schema_version` matches `SUPPORTED_SCHEMA_VERSION` in `apps/api/src/bootstrap.ts` |

### Auth

| Symptom | Cause | Fix |
|---|---|---|
| Every `/v1/*` returns 401 | `AUTH_MODE=dev` not set in development | Add `AUTH_MODE=dev` to `.env` (DO NOT use in production) |
| Portal lands on `/sign-in` redirect loop | Cookie signing key changed | Clear browser cookies + restart |
| Cross-tenant 404 when expected 200 | Tenant isolation is working as designed | Check `X-Tenant-Slug` header / URL path |

### Runtime

| Symptom | Cause | Fix |
|---|---|---|
| Manifest agent invoke returns 404 | Agent name typo or wrong tenant | `curl http://localhost:3501/v1/agents?include_system=1` to enumerate |
| Manifest invoke returns 409 `no_auto_trigger` | Human-actor agent with empty `trigger[]` | Use Tasks view to resolve, or `POST /v1/events` directly |
| Run starts but never completes | Step is awaiting human task | Tasks view → approve/reject |
| Step fails with `cost_limit_exceeded` | Tenant hit budget cap | Settings → Billing → raise cap or reset |
| Step fails with `not_configured` | LLM provider lacks credentials | Set the appropriate `*_API_KEY` env var |
| SSE stream disconnects every 30 min | Hard timeout on long-lived connections | Client must reconnect; this is by design (`SSE_TIMEOUT_MS`) |

### Frontend

| Symptom | Cause | Fix |
|---|---|---|
| Tests pass but portal pages render blank | TanStack Query waiting on API | Check `/v1/counts` returns 200 in DevTools network tab |
| Monaco editor doesn't load | CSP blocks worker-blob: scheme | Adjust your reverse-proxy CSP to allow `worker-src 'self' blob:` |
| Tenant switcher shows only one tenant | User isn't a member of others | Settings → People → invite (operator-only) |
| `--density` toggle does nothing | Component doesn't read the CSS var | Filed in v1.1 backlog as P5-FE-1 |

---

## 12. Production

For a real deploy, read [RUNBOOK.md](RUNBOOK.md). The short version:

```bash
# 1. Configure
cp .env.production.example .env
$EDITOR .env  # set NODE_ENV=production, JWT_SECRET, AGENTIC_KMS_KEY, LLM keys, AGENTIC_API_URL

# 2. Bring up
docker compose up -d

# 3. Verify
curl http://localhost:3599/health     # web
curl http://localhost:3501/health     # api
curl http://localhost:3501/metrics    # prometheus

# 4. First operator login (magic link)
# Visit /sign-in, enter your email, click the link in your inbox.

# 5. Backup
crontab -e
# 0 2 * * * /opt/agentic-operator/scripts/db-backup.sh
```

**Must-do before public traffic:**
1. **Rotate any keys left in `.env`** (the dev `.env.example` ships placeholders, but if you've reused the dev env, rotate at the provider dashboards).
2. **Set `JWT_SECRET` to 32+ random bytes** (`openssl rand -hex 32`).
3. **Set `AGENTIC_KMS_KEY`** for the BYOK vault if you'll use Settings → Models per-tenant keys.
4. **Restrict `NODE_ENV=production`** — never set `AUTH_MODE=dev` in production. The auth plugin enforces this hard.
5. **Configure a log shipper** to grab `data/logs/*.log` and Pino stdout — point at Loki, Vector, Datadog, etc.
6. **Set up an upstream reverse proxy** with CSP, TLS, and rate-limit-burst protection in front of the api+web containers.

---

## 13. Glossary

See [PRD.md §15](PRD.md#15-appendix-glossary) for the canonical glossary. Key terms used in this guide:

| Term | Meaning |
|---|---|
| **Agent** | Named LLM-backed worker; either a `manifest` (JSON) or `code` (TS class) |
| **Workflow** | Named graph of agents connected by events |
| **Run** | One invocation of one agent in response to one event |
| **Step** | One durable unit of work inside a run (logic / tool / manual / condition / delay / subflow) |
| **Trigger** | What starts a run: event, schedule (cron), webhook, manual invoke, sub-agent emit |
| **Subject** | The entity a run operates on (e.g. `REQ-2041`, `CAN-88412`) |
| **Tenant** | Isolation boundary; owns workflows, agents, runs, deployments, keys, budgets |
| **`__system`** | Platform's own reserved tenant; holds smoke-test agents |
| **Test run** | A run marked `is_test=true`; surfaces with a TEST badge; ideal for dry-runs that don't count against KPI |
| **Replay** | A new run derived from a prior event; new `runId`, marked with REPLAY badge |
| **BYOK** | Bring Your Own Key — per-tenant LLM provider API key, encrypted at rest (v1.1) |
| **Harness** | Everything the platform provides so you don't have to write it: runtime, ledger, gateway, scheduler, observability |

---

## 14. Getting help

| Surface | When |
|---|---|
| [DESIGN.md](DESIGN.md) | "How does X work under the hood?" |
| [IMPLEMENTATION.md](IMPLEMENTATION.md) | "Which task ID landed feature X?" |
| [RUNBOOK.md](RUNBOOK.md) | "I'm paged at 2am, what now?" |
| `docs/audits/` | The 14 wave-status notes — granular file:line diffs for every shipped change |
| `pnpm test` | Failing? Read the test name; it cites the FR/task ID; cross-reference back to IMPL.md |
| `git log --oneline docs/` | What changed in the design docs recently |

For unrouted questions, open an issue with the tag `question`.

---

*Last updated: 2026-05-20 · v1.0*
