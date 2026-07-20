# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Toolchain

- **Node 26** (26.5.0 target; `.nvmrc` and `package.json#engines` pin 26.5.0). `better-sqlite3` (native module) is compiled against Node 26's MODULE_VERSION (ABI 147); running on a different major crashes with `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch. Run `nvm use` after switching shells.
  - **Version guard:** `scripts/ensure-node-version.mjs` (wired into the root lifecycle pre-scripts) accepts any Node 26.x — major-version match, not exact — and verifies `.nvmrc` matches `package.json#engines.node`. 26.5.0 is the documented target used by CI and Docker.
  - **Self-heal:** `scripts/ensure-native-modules.mjs` detects an ABI mismatch (via `process.dlopen` on the resolved `.node`) and rebuilds in-place. It's wired into `postinstall` + every native-dependent `pre*` script, so a stale binary auto-rebuilds before the next command instead of crashing. Note: `pnpm rebuild <pkg>` is a silent no-op under pnpm 11 — the guard runs the package's own `prebuild-install || node-gyp` chain inside the package dir, then re-verifies in a child process (dlopen caches per-process).
- **pnpm 11** workspaces — `pnpm install`. Build approval for native deps lives in `pnpm-workspace.yaml` under `allowBuilds:` (the old `pnpm.onlyBuiltDependencies` field in `package.json` is no longer read by pnpm 11 and was removed — `pnpm-workspace.yaml` is the single source of truth).
- The Node and pnpm requirements in README, `.nvmrc`, Dockerfiles and CI must
  remain aligned with `package.json`.

## Common commands

```bash
pnpm dev                  # web :3599 + api :3540 + inngest dev :8488 (predev also removes stale processes owned by this workspace)
pnpm restart              # (alias dev:restart) scripts/restart-dev.sh — stop this workspace's stale dev processes, then boot the full stack
pnpm build                # turbo run build across all workspaces
pnpm lint                 # turbo run lint (Next.js ESLint on web only)
pnpm typecheck            # turbo run typecheck (every package has its own tsc --noEmit)
pnpm test                 # turbo run test → vitest in apps/api
pnpm db:migrate           # apply drizzle migrations to data/agentic.db
pnpm db:seed              # requires explicit AGENTIC_BOOTSTRAP_ADMIN_{EMAIL,NAME,PASSWORD}; creates one real admin
pnpm db:wipe-runtime      # truncate runtime traffic only (runs/steps/events/tasks/audit/artifacts); keeps tenants/users/workflows/agents/deployments/event_types/etc.
pnpm db:prune-deployments # GC superseded deployment rows + their import tmp dirs
pnpm db:generate          # drizzle-kit generate after editing packages/db/src/schema.ts
pnpm db:studio            # drizzle-kit studio
pnpm ensure:native        # manually run the native-module ABI guard
```

Single test (api workspace): `pnpm --filter @agentic/api exec vitest run test/tc-3-test-agent-happy.test.ts`. Vitest config uses `pool: "forks"` and `sequence.concurrent: false` because the SQLite handle isn't worker-thread safe and tests share `data/agentic.db`.

A single workspace's dev server: `pnpm --filter @agentic/api run dev` (or `@agentic/web`). The api `dev` script loads both `../../.env` and `apps/api/.env.local` via `tsx --env-file`. **Precedence gotcha: the file order is `--env-file=.env.local --env-file=../../.env`, and with multiple `--env-file` flags the LATER file wins on duplicate keys — so root `.env` overrides `apps/api/.env.local`** (verified live 2026-07-15: `AUTH_MODE`/`INNGEST_BASE_URL` came from root `.env` while `.env.local` still carried stale LAN values). Keys that must differ per-process (LAN demos etc.) belong ONLY in `.env.local`, with no root duplicate. **`pnpm --filter @agentic/api run dev` alone does NOT start Inngest** — `inngest.send` (used by `POST /v1/events` and manifest-agent invocation) then fails with `fetch failed`. Use the full `pnpm dev` (or run the `inngest-cli` line separately) whenever events must actually dispatch.

## Architecture

**Two-process split with a shared Zod contract package.** `apps/web` (Next.js 16, React 19) is UI-only — it has zero database access. Every read goes through `/v1/*` to `apps/api` (Fastify 5). `next.config.mjs` rewrites `/v1/*` and `/health` to `AGENTIC_API_URL` (local default `http://localhost:3540`). `@agentic/contracts` Zod schemas are the single source of truth: api validates requests with them; web parses responses with them via `apps/web/lib/api-client.ts`.

**Two parallel agent execution paths share the same `runs`/`steps` schema and SSE log tail.**
1. **Declarative manifest agents** (`packages/runtime`). `models/<slug>-v<n>/workflow*.json` is loaded at boot; each `AgentSpec` becomes one Inngest function with `id = "${tenantSlug}.${agentName}"`, concurrency keyed on `event.data.subject`, retries=3. Events are namespaced `${tenantSlug}/${name}`. See `packages/runtime/src/register.ts` for the durability contract; the LLM tool-use loop + tool dispatch live in `packages/runtime/src/step-engine.ts`.
2. **Code-defined agents** (`packages/agents`). Subclass `BaseAgent`, register at import time via `agentRegistry.register(...)`. `BaseAgent.run()` is sealed; subclasses override `buildMessages()` and optionally `parseOutput()`. The run engine handles run-row + step-row + file-log + gateway dispatch. Synchronous invokes execute directly; asynchronous invokes persist a queued run and dispatch that same `runId` through Inngest.

**Inngest durability discipline.** Inngest replays handlers; every DB write must be inside a `step.run("name", ...)` so exactly one row is produced per actual execution. `step.sendEvent` is the only idempotent way to emit downstream events — never `inngest.send` inside a step body. HITL: create a `tasks` row inside `step.run`, then `step.waitForEvent("task.resolved", { if: 'async.data.taskId == "<id>"' })`. See `packages/runtime/src/register.ts:165-280`. Inngest dev mode is **not crash-safe** — if the api restarts mid-run (e.g. tsx watch reloading on a file edit) the in-flight handler can be dropped; re-fire under a fresh subject.

**LLM Gateway** (`packages/llm-gateway`) fronts the credentialed provider adapters exposed by the live provider catalog (now including `moonshot` and `zai`). The deterministic mock adapter is test-only; incomplete adapters are not advertised by a non-test API. `apps/api/src/services/llm.ts` is a **tenant-routing gateway host**: adapters capture credentials at construction, so it keeps one concrete gateway per tenant credential scope and exposes a single stable routing gateway that is injected into both consumers at boot (`setAgentGateway` for BaseAgent, `setRuntimeGateway` for the manifest step engine's `logic`/`llmCall` action) — see `apps/api/src/bootstrap.ts`. Provider credentials come from Settings → stored encrypted server-side (`AGENTIC_KEY_VAULT_SECRET`; required in production before keys can be stored/read) with env vars as fallback; non-secret workspace AI policy persists to `data/llm-settings.json` and mirrors into a managed block in `apps/api/.env.local`. Every provider call is attributed and accounted in the **usage ledger** (`llm_calls` table + `usage-ledger.ts`/`usage-attribution.ts`; `LLM_REQUIRE_USAGE_ATTRIBUTION=true` rejects unattributable calls), surfaced at `/v1/usage`. Provider catalog metadata lives in `@agentic/contracts/providers`. Background design: `docs/design/llm-gateway-and-baseagent.md`.

**Enterprise workflow-authoring surfaces** (merged 2026-07): **Agent Studio** — per-agent V2 definitions (`packages/contracts/src/agent-definition.ts`, `AgentDefinitionV2`) authored via `apps/api/src/routes/v1/agent-studio.ts` + `agent-authoring.ts` and the portal Workflows view; **workflow authoring** — draft/publish workflow manifests through `apps/api/src/routes/v1/workflow-authoring.ts` instead of hand-editing `models/*/workflow*.json`; **API tokens** — tenant-scoped bearer tokens minted/revoked at `apps/api/src/routes/v1/api-tokens.ts` (Settings → Tokens); **integrations** — third-party credentials (e.g. GoHire) stored encrypted per tenant via `apps/api/src/routes/v1/integrations.ts` + `services/integration-store.ts` (Settings → Integrations) and resolved by tools at call time.

**Tenant scoping.** Every user-visible table carries `tenant_id`. Use `tenantScope(ctx, table)` from `@agentic/db` to build the predicate — direct `getDb()` access leaks across tenants. `AUTH_MODE=production` authenticates real session cookies or API tokens. The explicit sandbox-only `AUTH_MODE=dev` requires `AGENTIC_DEV_TENANT` and resolves a real active DB user; it has no hard-coded user or tenant fallback and is rejected with `NODE_ENV=production`. The portal's `x-agentic-tenant: <slug>` header chooses an active tenant, but the server always re-derives membership/role before authorizing it.

**Storage layout.** SQLite WAL at `data/agentic.db` (58 tables, see `packages/db/src/schema.ts`). Run logs are NDJSON-ish per-line at `data/logs/<tenant>/runs/<date>/<run-id>.log` and stream over SSE at `GET /v1/runs/:runId/logs?follow=1`. Event ledger NDJSON at `data/logs/<tenant>/events/<date>.ndjson`. Everything under `data/` is gitignored.

## Global tool registry (`packages/tools`)

**The canonical, configuration-driven way agents get tools.** Any tool exported into `globalToolRegistry` (`packages/tools/src/registry.ts`) is callable by **any agent in any tenant** — the workflow manifest just lists the tool name in an agent's `tool_use[]`. No per-tenant TypeScript required. Treat `packages/tools/` as the home for any new tool that more than one tenant could plausibly want.

**Resolution order** (in `step-engine.ts`, both the LLM tool-use loop and `type:"tool"` action dispatch):
```
tenantRegistry.tools[name]         // tenant-specific override wins
  ?? globalToolRegistry.get(name)  // global core registry
  ?? MCP server tools              // folded into tenantRegistry under "<server>.<tool>"
```
A tenant can ship a custom impl that shadows a global tool; everyone else gets the global default. The manifest's `tool_use[]` allow-list is the trust boundary — a tool isn't callable just because it's registered.

**Per-tenant configuration (no code).** A `tool_use[].config` object in the manifest is lifted into `ctx.config` (`ToolContext.config`, see `packages/agent-kit/src/types.ts`) on every handler call — how the same global tool gets per-tenant credentials/paths:
```json
"tool_use": [
  { "name": "parseResumeApi", "config": { "api_key_env": "TENANT_X_RH_KEY" } },
  { "name": "fs.readFromInbox", "config": { "subdir": "resumes" } },
  { "name": "writeJdToDisk",    "config": { "subdir": "jd-archive", "id_prefix": "jd" } }
]
```
Each tool reads `ctx.config?.<key> ?? <env default>`. The runtime never inspects this blob — each tool documents the keys it honours.

**Tool authoring.** `defineTool({ name, description, output?, handler })` from `@agentic/agent-kit` returns a plain descriptor (no DI, no decorators). Handlers read LLM-supplied args from `ctx.event.data` (the runtime overrides `event` with the tool-call `input` at dispatch — single read site whether invoked by the LLM or a `type:"tool"` manifest action). `throw` to fail — the runtime converts it to `tool_result: is_error` so the LLM can self-correct. `ctx.lastResult` carries the previous tool's output forward server-side; this is how `fs.readFromInbox` → `parseResumeApi` passes a multi-KB base64 PDF without the LLM re-quoting (and corrupting) it. To add a global tool: create it under `packages/tools/src/<category>/`, export from that category's `index.ts`, and add a `REGISTRATIONS` entry in `registry.ts` (name + category + summary + optional argsSchema/configSchema/returnsSchema/examples/aliases).

**Catalog surface.** `listGlobalTools()` returns full metadata; `GET /v1/tools` (`apps/api/src/routes/v1/tools.ts`) serves it; the **"Agentic Tools"** portal page at `/portal/<tenant>/tools` (`apps/web/app/portal/[tenant]/(views)/tools/page.tsx`, hook `apps/web/lib/hooks/useTools.ts`) renders it as API docs with copy-paste manifest snippets. Browse there before writing a new tool.

**Back-compat aliases.** A tool can answer to multiple semantically equivalent names (e.g. `fs.writeHtmlToArchive` ← `writeReportToDisk`, `writeBriefToDisk`; `fs.readFromInbox` ← `readResumeFromDisk`; `meta.ping` ← `pingProbe`). Aliases are declared in the catalog entry and all resolve to the same descriptor, so older manifests keep working. Never alias a real business operation to a diagnostic probe: a missing integration must fail closed. The matching `tenants/*/src/tools/*.ts` files are now ~3-line re-export shims — new tool work goes in `packages/tools/`, not the tenant packages.

**`fs.*` data root.** Filesystem tools write under `data/<subdir>/<tenant>/…`. The root resolves via `AGENTIC_DATA_ROOT` → else a `pnpm-workspace.yaml` walk-up → else `<cwd>/data` (`packages/tools/src/fs/_shared.ts`). As of 2026-07-15 `AGENTIC_DATA_ROOT` is deliberately UNPINNED in both env files and the walk-up is the live mechanism (repo-root `data/`): a root-`.env` pin of `./data` would win the env-file layering (later file wins) and resolve against the api's cwd to `apps/api/data/` — the exact stranding bug it was meant to prevent. Artifacts are pinned instead via `AGENTIC_ARTIFACTS_DIR=../../data/artifacts` in both files (identical value, cwd-relative to `apps/api`). If you re-pin the data root, use a value that is correct from the api's cwd and keep both files consistent.

## Frontend layout note

The Next.js App Router portal at `apps/web/app/portal/[tenant]/(views)/*` is the
only application UI. Historical static/Babel portal implementations are not
runtime surfaces and must not be restored as a fallback.

Routing:
- `/`                  → App Router redirect (`apps/web/app/page.tsx`) → `/portal`.
- `/portal`            → `apps/web/app/portal/page.tsx` redirects to `/portal/<tenant>/dashboard`.
- `/portal/<tenant>/*` → real production UI.
- `/v1/*`, `/health`   → proxied to `AGENTIC_API_URL` (local default :3540).

**CSS tokens.** `apps/web` uses inline CSS-in-JS with CSS custom properties from `apps/web/styles/tokens.css` (+ `apps/web/app/global.css` for pseudo-selectors / media queries / `@keyframes`). The real token names are `--bg`, `--panel`, `--panel-2`, `--panel-3`, `--border`, `--border-2`, `--text`, `--text-2`, `--text-3`, `--signal`, `--red`, etc. There is **no** `--surface-1`/`--border-1`/`--text-1`/`--danger` — referencing an undefined `var()` makes the browser fall back to `transparent`/inherited, which surfaces as a "see-through modal" bug. Match an existing component's tokens when styling new UI.

## Adding a tenant

Pure-declarative (manifest-only): drop `models/<slug>-v<n>/` with the five JSON files, add a row to `packages/db/src/seed.ts`, `pnpm db:seed`, restart api. Bootstrap auto-discovers and registers Inngest functions; the new tenant appears in the sidebar switcher. With only global tools in `tool_use[]`, **no tenant TypeScript package is needed at all.**

With custom tools/prompts: also create `tenants/<slug>/` (copy `tenants/raas/`), declare `"@tenants/<slug>": "workspace:*"` in `apps/api/package.json`, and register it in `TENANT_REGISTRIES` in `apps/api/src/bootstrap.ts`. This wiring lives in the api (not in `@agentic/runtime`) because pnpm's isolated module resolution requires each package to own its own deps. Slug derivation: lowercase the folder, strip `-vN` suffix (`RAAS-v1` → `raas`). Prefer adding reusable tools to `packages/tools/` over a tenant package.

## Conventions worth knowing

- IDs are prefixed strings (`run-…`, `evt-…`, `agt-…`, `tsk-…`) generated by `makeId(prefix)` from `@agentic/shared`. Timestamps are unix-ms.
- **Migrations 0055–0061** are the enterprise-workflow batch (integrations, Agent Studio foundation, usage ledger, reasoning controls, attribution events, routing observability), renumbered to follow our `0054_factory_domain_insights`. `0055_rename_llm_call_telemetry` renames the old factory telemetry table `llm_calls` → `llm_call_telemetry`; the usage ledger now owns the `llm_calls` name. Don't confuse the two when querying.
- **GoHire is the canonical ATS tool family** (`packages/tools/src/gohire/`: `gohireHealthApi`/`gohireParseResumeApi`/`gohireParseJdApi`/`gohireMatchResumeApi`/`gohireInviteCandidateApi`). Credentials resolve manifest `tool_use[].config` → Settings → Integrations DB store (provider=`gohire`) → `GOHIRE_API_KEY` env. The legacy `robohire` names stay registered as back-compat aliases/mirrors (`ROBOHIRE_*` env mirrors `GOHIRE_*`); new manifests should use the gohire names.
- Workflow DAG layout is derived from each live manifest's trigger/emit graph; do not introduce tenant-specific hard-coded coordinates.
- **Cancelling a run:** `POST /v1/runs/:id/cancel` — manifest agents stop via Inngest `cancelOn` keyed on `${tenantSlug}/run.cancel` matching subject; code agents poll `runs.status` between checkpoints in `packages/agents/src/run-engine.ts` and throw `RunCancelledError`. Idempotent — re-cancelling a terminal run returns 200 with `cancelled:false`.
- **Wrapping a third-party API as a tool:** verify the real response envelope before trusting a nested-field read. RoboHire's `match-resume` wraps its analysis under `data.data.*`; the normalizer initially read one level too shallow and silently returned `matchScore: null` for every candidate (the rubric then marked everyone `ERROR`). Probe the live API with curl when a tool's output looks empty/null but the call "succeeded".
- **`/parse-resume` is multipart-only.** RoboHire's resume parser rejects JSON bodies (`400 "PDF file is required"`); the field must be named `file`. `parseResumeApi` sends `FormData` + `Blob`. General lesson: don't assume a vendor endpoint is JSON.
