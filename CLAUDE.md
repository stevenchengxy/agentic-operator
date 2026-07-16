# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Toolchain

- **Node 26.5.0** (`.nvmrc` = 26.5.0). `better-sqlite3` (native module) is compiled against Node 26's MODULE_VERSION (ABI 147); running on a different major crashes with `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch. Run `nvm use` after switching shells.
  - **Exact-version guard:** `scripts/ensure-node-version.mjs` rejects any runtime other than 26.5.0 and verifies `.nvmrc` matches `package.json#engines.node`. `.npmrc#engine-strict=true` and the root lifecycle pre-scripts enforce it for install, dev, build, lint, typecheck, test, clean, format, database, and seed commands.
  - **Self-heal:** `scripts/ensure-native-modules.mjs` detects an ABI mismatch (via `process.dlopen` on the resolved `.node`) and rebuilds in-place. It's wired into `postinstall` + every runtime-sensitive pre-script (`predev`, `prebuild`, `pretest`, `predb:*`, `preseed:rich`), so a stale binary auto-rebuilds before the next command instead of crashing. Note: `pnpm rebuild <pkg>` is a silent no-op under pnpm 11 — the guard runs the package's own `prebuild-install || node-gyp` chain inside the package dir, then re-verifies in a child process (dlopen caches per-process).
- **pnpm 11** workspaces — `pnpm install`. Build approval for native deps lives in `pnpm-workspace.yaml` under `allowBuilds:` (the old `pnpm.onlyBuiltDependencies` field in `package.json` is no longer read by pnpm 11 and was removed — `pnpm-workspace.yaml` is the single source of truth).
- Node is pinned consistently in README, `.nvmrc`, CI, Docker, and `package.json#engines`.

## Common commands

```bash
pnpm dev                  # web :3599 + api :3501 + inngest dev :8288 (predev runs ensure:native, then frees those ports + 8289/50052/50053)
./restart.sh              # gracefully stop the current local stack, then run pnpm dev under the pinned Node version
./restart.sh --check      # validate the restart harness without changing running processes
pnpm build                # turbo run build across all workspaces
pnpm lint                 # turbo run lint (Next.js ESLint on web only)
pnpm typecheck            # turbo run typecheck (every package has its own tsc --noEmit)
pnpm test                 # turbo run test → vitest in apps/api
pnpm db:migrate           # apply drizzle migrations to data/agentic.db
pnpm db:seed              # 3 tenants + 1 admin
pnpm db:wipe-runtime      # truncate runtime traffic only (runs/steps/events/tasks/audit/artifacts); keeps tenants/users/workflows/agents/deployments/event_types/etc.
pnpm db:prune-deployments # GC superseded deployment rows + their import tmp dirs
pnpm seed:rich            # RAAS historical fixtures + English ontology overlay (idempotent)
pnpm db:generate          # drizzle-kit generate after editing packages/db/src/schema.ts
pnpm db:studio            # drizzle-kit studio
pnpm ensure:native        # manually run the native-module ABI guard
```

Single test (api workspace): `pnpm --filter @agentic/api exec vitest run test/tc-3-test-agent-happy.test.ts`. Vitest config uses `pool: "forks"` and `sequence.concurrent: false` because the SQLite handle isn't worker-thread safe and tests share `data/agentic.db`.

A single workspace's dev server: `pnpm --filter @agentic/api run dev` (or `@agentic/web`). The api `dev` script loads both `../../.env` and `apps/api/.env.local` via `tsx --env-file`. **`pnpm --filter @agentic/api run dev` alone does NOT start Inngest** — `inngest.send` (used by `POST /v1/events` and manifest-agent invocation) then fails with `fetch failed`. Use the full `pnpm dev` (or run the `inngest-cli` line separately) whenever events must actually dispatch.

## Architecture

**Two-process split with a shared Zod contract package.** `apps/web` (Next.js 16, React 19) is UI-only — it has zero database access. Every read goes through `/v1/*` to `apps/api` (Fastify 5). `next.config.mjs` rewrites `/v1/*` and `/health` to `http://localhost:3501`. `@agentic/contracts` Zod schemas are the single source of truth: api validates requests with them; web parses responses with them via `apps/web/lib/api-client.ts`.

**Two parallel agent execution paths share the same `runs`/`steps` schema and SSE log tail.**
1. **Declarative manifest agents** (`packages/runtime`). `models/<slug>-v<n>/workflow*.json` is loaded at boot; each `AgentSpec` becomes one Inngest function with `id = "${tenantSlug}.${agentName}"`, concurrency keyed on `event.data.subject`, retries=3. Events are namespaced `${tenantSlug}/${name}`. See `packages/runtime/src/register.ts` for the durability contract; the LLM tool-use loop + tool dispatch live in `packages/runtime/src/step-engine.ts`.
2. **Code-defined agents** (`packages/agents`). Subclass `BaseAgent`, register at import time via `agentRegistry.register(...)`. `BaseAgent.run()` is sealed; subclasses override `buildMessages()` and optionally `parseOutput()`. The run engine handles run-row + step-row + file-log + gateway dispatch. Invoked synchronously at `POST /v1/agents/:name/invoke`; async via Inngest is reserved for v2.

**Inngest durability discipline.** Inngest replays handlers; every DB write must be inside a `step.run("name", ...)` so exactly one row is produced per actual execution. `step.sendEvent` is the only idempotent way to emit downstream events — never `inngest.send` inside a step body. HITL: create a `tasks` row inside `step.run`, then `step.waitForEvent("task.resolved", { if: 'async.data.taskId == "<id>"' })`. See `packages/runtime/src/register.ts:165-280`. Inngest dev mode is **not crash-safe** — if the api restarts mid-run (e.g. tsx watch reloading on a file edit) the in-flight handler can be dropped; re-fire under a fresh subject.

**LLM Gateway** (`packages/llm-gateway`) fronts 14 providers (`mock`, `anthropic`, `openai`, `openrouter`, `gemini`, `azure`, `groq`, `together`, `mistral`, `deepseek`, `qwen`, `bedrock`, `vertex`, `custom`). A single gateway singleton is constructed in `apps/api/src/services/llm.ts` and injected into both consumers at boot (`setAgentGateway` for BaseAgent, `setRuntimeGateway` for the manifest step engine's `logic`/`llmCall` action) — see `apps/api/src/bootstrap.ts`. Provider catalog metadata lives in `@agentic/contracts/providers`. Background design: `docs/design/llm-gateway-and-baseagent.md`.

**Tenant scoping.** Every user-visible table carries `tenant_id`. Use `tenantScope(ctx, table)` from `@agentic/db` to build the predicate — direct `getDb()` access leaks across tenants. In dev (`AUTH_MODE=dev` or `NODE_ENV !== "production"`) the auth plugin returns the tenant matching `AGENTIC_DEV_TENANT` (default `raas`). Tests set `AGENTIC_DEV_TENANT=__system`. The dev-only `x-agentic-tenant: <slug>` request header overrides the tenant per-request (advisory — never a 401; only consulted under `AUTH_MODE=dev`) — handy for hitting `/v1/*` for a non-default tenant via curl.

**Storage layout.** SQLite WAL at `data/agentic.db` (25 tables, see `packages/db/src/schema.ts`). Run logs are NDJSON-ish per-line at `data/logs/<tenant>/runs/<date>/<run-id>.log` and stream over SSE at `GET /v1/runs/:runId/logs?follow=1`. Event ledger NDJSON at `data/logs/<tenant>/events/<date>.ndjson`. Everything under `data/` is gitignored.

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

**Back-compat aliases.** A tool can answer to multiple names (e.g. `fs.writeHtmlToArchive` ← `writeReportToDisk`, `writeBriefToDisk`; `fs.readFromInbox` ← `readResumeFromDisk`; `meta.ping` ← `monitorAndFetchRequirement`, `pingProbe`). Aliases are declared in the catalog entry and all resolve to the same descriptor, so older manifests keep working. The matching `tenants/*/src/tools/*.ts` files are now ~3-line re-export shims — new tool work goes in `packages/tools/`, not the tenant packages.

**`fs.*` data root.** Filesystem tools write under `data/<subdir>/<tenant>/…`. The root resolves via `AGENTIC_DATA_ROOT` (pinned: `.env` = `./data`, `apps/api/.env.local` = `../../data`) → else a `pnpm-workspace.yaml` walk-up → else `<cwd>/data` (`packages/tools/src/fs/_shared.ts`). **Keep `AGENTIC_DATA_ROOT` pinned** — relying on the walk-up means file locations silently move when a tool changes packages (this bit us during the global-tools migration; legacy artifacts stranded under `apps/api/data/`).

## Frontend layout note

**Two UIs coexist.** Since P5-TEN-01b (2026-05-21) the production UI is the Next.js App Router portal at `apps/web/app/portal/[tenant]/(views)/*` — TypeScript, react-query, the canonical implementation. The Babel/React SPA prototype now lives at **`/demo`** (files under `apps/web/public/demo/`) and serves as a design reference only — never edit it expecting production behavior.

Routing:
- `/`                  → App Router redirect (`apps/web/app/page.tsx`) → `/portal`.
- `/portal`            → `apps/web/app/portal/page.tsx` redirects to `/portal/<tenant>/dashboard`.
- `/portal/<tenant>/*` → real production UI.
- `/demo`              → SPA prototype (`/public/demo/index.html` via `next.config.mjs` rewrite).
- `/v1/*`, `/health`   → proxied to apps/api on :3501.

**CSS tokens.** `apps/web` uses inline CSS-in-JS with CSS custom properties from `apps/web/styles/tokens.css` (+ `apps/web/app/global.css` for pseudo-selectors / media queries / `@keyframes`). The real token names are `--bg`, `--panel`, `--panel-2`, `--panel-3`, `--border`, `--border-2`, `--text`, `--text-2`, `--text-3`, `--signal`, `--red`, etc. There is **no** `--surface-1`/`--border-1`/`--text-1`/`--danger` — referencing an undefined `var()` makes the browser fall back to `transparent`/inherited, which surfaces as a "see-through modal" bug. Match an existing component's tokens when styling new UI.

**SPA prototype gotcha (only relevant if editing `/demo`).** All `<script type="text/babel">` view files share one global scope. A top-level `function Foo()` in one view file shadows the same name in any other view loaded earlier — last load wins (e.g. `views/logs.jsx` and `views/schema-editor.jsx` both declaring `function TreeNode`). Convention: **prefix internal components with the view name** (`SchemaTreeNode`, `LogsTreeNode`). Only the top-level view component (`SchemaEditor`, `Workflows`, …) uses a bare name. Cross-view shared components live in `components.jsx` and attach to `window.*` once at the bottom of that file.

## Demo mode

**Architectural rule (locked 2026-05-26):** production mode = **ZERO** mock/seed/synthetic data. Demo mode = seed + loop. Two clean states only — no "looks like demo, actually mock fallback" ambiguity.

Switch via the single env flag `AGENTIC_DEMO_MODE` (default `false`; enabled only by the explicit value `true`):

- `AGENTIC_DEMO_MODE=false` (production): bootstrap skips `seed:rich` and never starts the demo-runner. Dashboard reflects only real events fired through `POST /v1/events`. When `/v1/tenants` is unreachable the portal renders an inline "api unreachable" banner — it does NOT fall back to the deleted `SAMPLE_TENANTS` fixture.
- `AGENTIC_DEMO_MODE=true` (demo): bootstrap runs `runSeedRich()` programmatically (idempotent — every helper skips rows that already exist by primary key) and starts `apps/api/src/services/demo-runner.ts`. The sidebar renders a lime "DEMO" pill near the logo. `/health` exposes `demoMode: true`.

**Demo-runner cadence** (all env-overridable):

| Env var | Default | Behavior |
|---|---|---|
| `AGENTIC_DEMO_TICK_MS` | 30 000 | Publish one random event on a random tenant w/ a live workflow + declared event types. |
| `AGENTIC_DEMO_TASK_RESOLVE_MS` | 90 000 | Resolve one open HITL task with a random approve/reject + emit `task.resolved`. |
| `AGENTIC_DEMO_HEARTBEAT_MS` | 300 000 | Log `[demo-runner] tick — N events fired, K tasks resolved`. |
| `AGENTIC_DEMO_RUN_BACKPRESSURE` | 25 | Skip a tick when the picked tenant already has ≥ N runs in flight. |

**Auto-applied demo env overrides** (in-process only — the on-disk `.env` is never touched). When `AGENTIC_DEMO_MODE=true`, `apps/api/src/config/demo-mode.ts → applyDemoModeOverrides()` runs BEFORE the LLM gateway is constructed and swaps `LLM_DEFAULT_PROVIDER`→`mock` + `LLM_DEFAULT_MODEL`→`mock-model-v1` (so the 30s event loop doesn't bleed real $ through your normal provider — mock returns canned deterministic responses so workflows still complete + the dashboard animates). Escape hatches keep a real provider under demo mode: `AGENTIC_DEMO_LLM_PROVIDER` / `AGENTIC_DEMO_LLM_MODEL`. Restore is automatic — flip the flag off + restart (the override only mutated `process.env` in-process). Boot log surfaces the swap exactly: `[bootstrap] demo overrides — LLM_DEFAULT_PROVIDER=mock (was openrouter), …`.

**Safety gates** (`apps/api/src/services/demo-runner.ts`): hard no-op when `NODE_ENV === "test"` (regardless of the flag — vitest never sees background traffic) and when `AGENTIC_DEMO_MODE !== true`. Every tick is try/caught; interval timers `.unref()` so Ctrl-C exits cleanly; SIGTERM/SIGINT route through `installGracefulShutdown` → Fastify `onClose` → `stopDemoRunner()`.

**Clean-slate primitive:** `pnpm db:wipe-runtime` truncates runtime-traffic tables (`runs`, `steps`, `events`, `tasks`, `audit_log`, `artifacts`, `event_listeners`, `agent_memory_*`) and keeps identity + workflow + agent-config rows. Run it once before flipping between modes.

## Adding a tenant

Pure-declarative (manifest-only): drop `models/<slug>-v<n>/` with the five JSON files, add a row to `packages/db/src/seed.ts`, `pnpm db:seed`, restart api. Bootstrap auto-discovers and registers Inngest functions; the new tenant appears in the sidebar switcher. With only global tools in `tool_use[]`, **no tenant TypeScript package is needed at all.**

With custom tools/prompts: also create `tenants/<slug>/` (copy `tenants/raas/`), declare `"@tenants/<slug>": "workspace:*"` in `apps/api/package.json`, and register it in `TENANT_REGISTRIES` in `apps/api/src/bootstrap.ts`. This wiring lives in the api (not in `@agentic/runtime`) because pnpm's isolated module resolution requires each package to own its own deps. Slug derivation: lowercase the folder, strip `-vN` suffix (`RAAS-v1` → `raas`). Prefer adding reusable tools to `packages/tools/` over a tenant package.

## Conventions worth knowing

- IDs are prefixed strings (`run-…`, `evt-…`, `agt-…`, `tsk-…`) generated by `makeId(prefix)` from `@agentic/shared`. Timestamps are unix-ms.
- The RAAS canonical workflow ships with Chinese titles. `pnpm seed:rich` overlays English from the handoff prototype via `seedAgentMetadata()`; rerun it after `db:seed` if you want English-labeled agents in the UI.
- Workflow DAG layout is hand-tuned (stage + lane per kebab id) in the legacy workflows page — do not replace with auto-packing if you ever revive it.
- **Cancelling a run:** `POST /v1/runs/:id/cancel` — manifest agents stop via Inngest `cancelOn` keyed on `${tenantSlug}/run.cancel` matching subject; code agents poll `runs.status` between checkpoints in `packages/agents/src/run-engine.ts` and throw `RunCancelledError`. Idempotent — re-cancelling a terminal run returns 200 with `cancelled:false`.
- **Wrapping a third-party API as a tool:** verify the real response envelope before trusting a nested-field read. RoboHire's `match-resume` wraps its analysis under `data.data.*`; the normalizer initially read one level too shallow and silently returned `matchScore: null` for every candidate (the rubric then marked everyone `ERROR`). Probe the live API with curl when a tool's output looks empty/null but the call "succeeded".
- **`/parse-resume` is multipart-only.** RoboHire's resume parser rejects JSON bodies (`400 "PDF file is required"`); the field must be named `file`. `parseResumeApi` sends `FormData` + `Blob`. General lesson: don't assume a vendor endpoint is JSON.
