# Technical Design — LLM Gateway, BaseAgent & Code-Defined Agents

**Status:** v1 (2026-05-19)
**Authors:** AI architect / technical PM personas
**Scope:** `packages/llm-gateway/`, `packages/agents/`, schema deltas, API surface, frontend catalog move

> July 2026 accounting/provider addendum: see
> [llm-gateway-usage-and-pricing.md](./llm-gateway-usage-and-pricing.md). It
> supersedes the original provider count, response usage shape, persistence,
> and cost-accounting assumptions in this v1 design.
> Frontier-model controls and the dated catalog are documented in
> [llm-model-controls-and-catalog.md](./llm-model-controls-and-catalog.md).

---

## 1. Motivation

The Agentic Operator (`/Users/kenny/CSI-AICOE/agentic-operator`) is feature-complete at the UI layer and at the declarative event-driven manifest runtime layer (M1–M10 + RF-1 done). It is **not yet operational** because:

- `packages/tools/src/index.ts:llmCall()` returns synthetic strings — no real LLM is ever called.
- The frontend Settings UI lists 12 LLM providers (Anthropic, OpenAI, Gemini, Mistral, Groq, Together, Bedrock, Vertex, Azure, DeepSeek, Qwen, Custom). None are wired.
- Engineers cannot author code-level LLM agents — only declarative JSON manifests are supported.

To close that gap with minimum scope creep, this design adds:
- A real **LLM Gateway** package that fronts 15 external providers + a mock.
- A **`BaseAgent`** abstract class for code-defined agents, coexisting with the manifest runtime.
- A first concrete agent — **`testAgent`** — as an end-to-end smoke signal.
- **Deployment + monitoring** plumbing that reuses the existing `runs` + `steps` tables and the existing SSE log tail.

---

## 2. Architecture

```
┌───────────────────────────────────────────────────────────────────────┐
│  apps/web  (Next.js :3599 — UI only, no DB)                            │
│   • Settings → reads /v1/llm/providers + /v1/llm/models                │
│   • Agents → list filtered by ?kind=code (reuses /v1/agents)           │
│   • Runs → invoke history + SSE log tail (reuses /v1/runs)             │
└───────────────────────────────────────────────────────────────────────┘
                                  │ HTTP (typed contracts)
                                  ▼
┌───────────────────────────────────────────────────────────────────────┐
│  apps/api  (Fastify :3501)                                             │
│   • services/llm.ts          ← singleton gateway, env-configured       │
│   • routes/v1/llm.ts         ← /v1/llm/* (NEW)                         │
│   • routes/v1/agent-invoke.ts← POST /v1/agents/:name/invoke (NEW)      │
│   • routes/v1/agents.ts      ← extended with ?kind filter              │
│   • inngest/code-agent.ts    ← Inngest wrapper for async invokes (NEW) │
└───────────────────────────────────────────────────────────────────────┘
       │                              │                        │
       ▼                              ▼                        ▼
┌────────────────────┐  ┌──────────────────────────┐  ┌─────────────────────┐
│ packages/agents/   │  │ packages/llm-gateway/    │  │ packages/runtime/   │
│  • BaseAgent       │──┤  • LLMGateway            │  │ • step-engine       │
│  • RunEngine       │  │  • 16 provider adapters  │←─┤   uses gateway      │
│  • AgentRegistry   │  │  • LLMError              │  │   instead of mock   │
│  • TestAgent       │  │                          │  │                     │
└────────────────────┘  └──────────────────────────┘  └─────────────────────┘
       │                              │
       └──────────────┬───────────────┘
                      ▼
        ┌──────────────────────────────────┐
        │ packages/db (SQLite + Drizzle)   │
        │  • agents (+kind, +enabled)      │
        │  • steps (+provider, +model,     │
        │     +tokens_in, +tokens_out)     │
        │  • deployments.target enum:      │
        │     +code_agent                  │
        │  • tenants (+__system row)       │
        └──────────────────────────────────┘
```

---

## 3. LLM Gateway

### 3.1 Provider catalog (16)

| ID | Adapter | Native SDK | Notes |
|---|---|---|---|
| `mock` | mock adapter | — | Always registered. Deterministic. Default fallback. |
| `anthropic` | `@anthropic-ai/sdk` | yes | System/user/assistant alternation enforced. |
| `openai` | `openai` (Responses API) | yes | Preserves reasoning mode/effort/context/summary, text verbosity, storage, and tool calls. |
| `openrouter` | `openai` SDK + baseURL override | shared | Chat Completions for broad effort-only routing; Responses for richer controls. Adds `HTTP-Referer` + `X-Title`. |
| `gemini` | `@google/genai` | yes | System messages go into `systemInstruction`; normalized effort maps to `thinkingLevel`. |
| `groq` | `openai` SDK + baseURL | shared | `https://api.groq.com/openai/v1`. |
| `together` | `openai` SDK + baseURL | shared | `https://api.together.xyz/v1`. |
| `mistral` | `openai` SDK + baseURL | shared | `https://api.mistral.ai/v1`. |
| `deepseek` | `openai` SDK + baseURL | shared | `https://api.deepseek.com`; normalized thinking effort and exact `reasoning_content` replay. |
| `moonshot` | `openai` SDK + baseURL | shared | `https://api.moonshot.ai/v1`. |
| `zai` | `openai` SDK + baseURL | shared | `https://api.z.ai/api/paas/v4`. |
| `qwen` | `openai` SDK + baseURL | shared | `https://dashscope.aliyuncs.com/compatible-mode/v1`. |
| `azure` | `openai` SDK + custom URL pattern | own | URL = `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=...`. Auth via `api-key` header. |
| `custom` | `openai` SDK + caller-provided baseURL | shared | For self-hosted OpenAI-compatible endpoints. |
| `bedrock` | stub | — | Throws `not_configured`. AWS Sigv4 + SDK wiring deferred. |
| `vertex` | stub | — | Throws `not_configured`. Google ADC wiring deferred. |

### 3.2 Public types

```typescript
// packages/llm-gateway/src/types.ts

export type ProviderId =
  | "anthropic" | "openai" | "openrouter" | "gemini"
  | "mistral" | "groq" | "together" | "deepseek" | "moonshot"
  | "zai" | "qwen"
  | "azure" | "bedrock" | "vertex" | "custom" | "mock";

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentBlock[];
  reasoningContent?: string; // opaque replay state; never logged
}

export interface ChatRequest {
  messages: ChatMessage[];
  model?: string;
  provider?: ProviderId;
  providers?: ProviderId[];
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  timeoutMs?: number;
  signal?: AbortSignal;
  jsonMode?: boolean;
  reasoning?: {
    mode?: "standard" | "pro";
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    summary?: "none" | "auto" | "concise" | "detailed";
    context?: "auto" | "current_turn" | "all_turns";
  };
  verbosity?: "low" | "medium" | "high";
  store?: boolean;
}

export interface ChatResponse {
  text: string;
  provider: ProviderId;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  finishReason: "stop" | "length" | "tool_calls" | "error" | "unknown";
  latencyMs: number;
  raw?: unknown;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  hasKey: boolean;
  defaultModel: string | null;
  models: string[];
}
```

### 3.3 `LLMGateway` class

```typescript
export class LLMGateway {
  constructor(private readonly config: GatewayConfig);
  registerProvider(id: ProviderId, adapter: ProviderAdapter): void;
  hasProvider(id: ProviderId): boolean;
  listProviders(): ProviderInfo[];
  async chat(req: ChatRequest): Promise<ChatResponse>;
}
```

`chat()` algorithm:
1. **Resolve provider list:** `req.providers ?? [req.provider] ?? [config.defaultProvider] ?? ["mock"]`.
2. **Resolve model:** `req.model ?? config.defaultModel ?? adapter.defaultModel ?? <provider's default>`.
3. **Timeout:** `req.timeoutMs ?? config.timeoutMs ?? 60000` — combined with optional caller `signal` via `AbortSignal.any()`.
4. **For each provider** in the list:
   - Try `adapter.chat({...})`.
   - On success → normalize tokens, measure `latencyMs`, return.
   - On `LLMError` with code `auth | bad_request | model_not_found | not_configured` → fail fast (no retry, no failover).
   - On `rate_limit | timeout | network | provider_error` → retry once after 250ms; if still fails, fall through to next provider.
5. If all providers exhausted → throw the last `LLMError`.

### 3.4 Error model

```typescript
export type LLMErrorCode =
  | "auth"
  | "rate_limit"
  | "timeout"
  | "model_not_found"
  | "bad_request"
  | "provider_error"
  | "network"
  | "not_configured";

export class LLMError extends Error {
  constructor(
    message: string,
    readonly code: LLMErrorCode,
    readonly provider: ProviderId,
    readonly cause?: unknown,
  );
  toJSON(): { code: LLMErrorCode; provider: ProviderId; message: string };
}
```

Each adapter wraps its native errors into `LLMError` with the right code. The gateway layer never re-classifies.

### 3.5 Configuration

Env vars consumed by `packages/llm-gateway/src/config.ts` at gateway construction:

```sh
# Defaults
LLM_DEFAULT_PROVIDER=mock           # mock | anthropic | openai | openrouter | ...
LLM_DEFAULT_MODEL=                  # provider-native model string
LLM_REQUEST_TIMEOUT_MS=60000

# Per-provider keys
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
OPENROUTER_API_KEY=
GOOGLE_API_KEY=                     # Gemini
GROQ_API_KEY=
TOGETHER_API_KEY=
MISTRAL_API_KEY=
DEEPSEEK_API_KEY=
MOONSHOT_API_KEY=
ZAI_API_KEY=
QWEN_API_KEY=

# Azure (needs three values to function)
AZURE_OPENAI_API_KEY=
AZURE_OPENAI_ENDPOINT=              # https://<resource>.openai.azure.com
AZURE_OPENAI_API_VERSION=2024-08-01-preview
AZURE_OPENAI_DEPLOYMENT=

# Custom (self-hosted OpenAI-compatible)
CUSTOM_LLM_BASE_URL=
CUSTOM_LLM_API_KEY=

# OpenRouter analytics headers (optional)
OPENROUTER_REFERRER=https://agentic-operator.local
OPENROUTER_APP_TITLE=Agentic Operator
```

**Backward compat:** If `LLM_PROVIDER` / `LLM_MODEL` are set but `LLM_DEFAULT_*` are not, the loader reads the legacy names and prints a single deprecation warning at boot.

### 3.6 Secret handling

- API keys are read once at gateway construction and stored in each adapter instance.
- Keys never appear in `ChatRequest`, `ChatResponse`, `LLMError`, or any log line.
- A `redact()` helper strips known key-like substrings before any error or audit log entry.
- The `audit_log` writes `{provider, model, status, tokensIn, tokensOut, latencyMs}` per call — **no prompt content, no response content**.

---

## 4. BaseAgent

### 4.1 Class shape

```typescript
// packages/agents/src/base-agent.ts

export abstract class BaseAgent<TInput = unknown, TOutput = string> {
  abstract readonly name: string;
  abstract readonly description: string;

  readonly kind: AgentKind = "code";
  readonly enabled: boolean = true;
  readonly defaultProvider?: ProviderId;
  readonly defaultModel?: string;
  readonly defaultReasoning?: ReasoningConfig;
  readonly defaultVerbosity?: TextVerbosity;
  readonly storeResponses?: boolean;
  readonly maxSteps: number = 1;       // v1 = single-step; >1 for future tool-use
  readonly concurrency: { limit: number; key?: string } = { limit: 4 };

  // Required override
  protected abstract buildMessages(
    input: TInput,
    ctx: AgentContext,
  ): ChatMessage[] | Promise<ChatMessage[]>;

  // Default = trim. Override for JSON parsing, schema validation, etc.
  protected parseOutput(
    text: string,
    _ctx: AgentContext,
  ): TOutput | Promise<TOutput> {
    return text.trim() as unknown as TOutput;
  }

  // Sealed — implemented in run-engine.ts
  async run(input: TInput, ctx: AgentContext): Promise<AgentResult<TOutput>>;
}
```

### 4.2 Run lifecycle

`BaseAgent.run()` delegates to `runEngine.execute(agent, input, ctx)`:

1. Resolve `tenantId` (from `ctx.tenantSlug` or fall back to `__system`).
2. Resolve `agentRow` (must exist — bootstrap creates it).
3. Allocate `runId`, `correlationId`. `INSERT INTO runs` with `status='running'`, `started_at=now`, `log_path=<computed>`.
4. Write `run.start` line via `writeRunLog()`.
5. Allocate `stepId`, `INSERT INTO steps` with `status='running'`, `type='logic'`, `name='llm.call'`, `ord=0`.
6. Persist prompt to `data/artifacts/<runId>/step-0-input.json`; set `steps.input_ref`.
7. `messages = await agent.buildMessages(input, ctx)`.
8. `response = await gateway.chat({ messages, provider: agent.defaultProvider, model: agent.defaultModel })`.
9. Persist response to `data/artifacts/<runId>/step-0-output.json`; set `steps.output_ref`.
10. `UPDATE steps SET status='ok', provider, model, tokens_in, tokens_out, ended_at, duration_ms`.
11. `output = await agent.parseOutput(response.text, ctx)`.
12. `UPDATE runs SET status='ok', tokens_in, tokens_out, model, ended_at, duration_ms`.
13. Write `run.ok` line.
14. Return `AgentResult<TOutput>`.

Failure paths set `runs.status='failed'`, `runs.error_message`, `steps.status='failed'`, write `run.fail` line, and re-throw the `LLMError`.

### 4.3 `AgentRegistry`

```typescript
// packages/agents/src/registry.ts

class AgentRegistry {
  private map = new Map<string, BaseAgent<any, any>>();
  register(agent: BaseAgent): void;
  get(name: string): BaseAgent | undefined;
  list(): BaseAgent[];
}
export const agentRegistry = new AgentRegistry();
```

Registration happens at import time inside each agent file:
```typescript
// packages/agents/src/system/test-agent.ts
import { agentRegistry } from "../registry";
import { BaseAgent } from "../base-agent";

export class TestAgent extends BaseAgent<void, string> { /* ... */ }

agentRegistry.register(new TestAgent());
```

### 4.4 Bootstrap (`packages/agents/src/bootstrap.ts`)

```typescript
export async function bootstrapCodeAgents(db: DB): Promise<void> {
  // 1. Upsert __system tenant
  // 2. Upsert __system workflow + workflow_version
  // 3. For each agent in registry:
  //    - Upsert agents row (kind='code', enabled=agent.enabled)
  //    - Upsert agent_versions row (manifestJson = {type:'code', sha})
  //    - If no live deployment for this agent_version: insert deployments row (target='code_agent', status='live')
}
```

Called from `apps/api/src/bootstrap.ts` after the manifest bootstrap completes.

---

## 5. Schema deltas (`packages/db/src/schema.ts`)

```diff
 export const agents = sqliteTable("agents", {
   id: text("id").primaryKey(),
   workflowId: text("workflow_id").notNull().references(...),
   kebabId: text("kebab_id").notNull(),
   name: text("name").notNull(),
   title: text("title"),
   actor: text("actor", { enum: ["Agent", "Human"] }).notNull(),
+  kind: text("kind", { enum: ["manifest", "code"] }).notNull().default("manifest"),
+  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
 });

 export const steps = sqliteTable("steps", {
   ... existing columns ...
+  provider: text("provider"),
+  model: text("model"),
+  tokensIn: integer("tokens_in"),
+  tokensOut: integer("tokens_out"),
 });

 export const deployments = sqliteTable("deployments", {
   ...
-  target: text("target", { enum: ["workflow", "agent", "runtime"] }),
+  target: text("target", { enum: ["workflow", "agent", "runtime", "code_agent"] }),
 });
```

Auto-generated via `pnpm db:generate` → `packages/db/drizzle/0002_<name>.sql`. All changes are additive (no breaking change to existing rows).

The seed script adds the `__system` tenant:
```typescript
{ slug: "__system", name: "System", subtitle: "Code agents (cross-tenant)", color: "#6f7178" }
```

---

## 6. API endpoints

### `GET /v1/llm/providers`

Returns `{ ok: true, data: ProviderInfo[] }` where each entry is `{ id, name, hasKey, defaultModel, models }`. All configured providers are always listed. `hasKey` is true when the env vars required by that adapter are present.

### `GET /v1/llm/models?provider=:id`

If `provider` query is set: returns `{ ok: true, data: string[] }` — that provider's known models. If `provider` is unknown → 400 with `LLMError` envelope.

If `provider` is omitted: returns `{ ok: true, data: Record<ProviderId, string[]> }` — full catalog.

### `POST /v1/agents/:name/invoke`

Request body (zod-validated):
```typescript
{
  input?: unknown;
  provider?: ProviderId;
  model?: string;
  async?: boolean;
}
```

**Sync mode (`async=false` or omitted):**
- Look up agent in registry. If not found → 404.
- If `provider` is set but unknown → 400.
- Call `agent.run(input, { tenantSlug: '__system', ... })`.
- Return `{ ok: true, data: { runId, status, output, provider, model, tokensIn, tokensOut, durationMs } }`.
- On failure → `{ ok: false, error: { code, message, runId? } }`.

**Async mode (`async=true`):**
- Generate `runId` (the eventual run row's id).
- `inngest.send({ name: "agent.invoke", data: { agentName, input, provider, model, runId } })`.
- Return `{ ok: true, data: { runId, status: "queued" } }`.
- The Inngest function `runCodeAgentFn` (in `apps/api/src/inngest/code-agent.ts`) wraps the invocation with durable retries.

### `GET /v1/agents` (extended)

New optional query param `kind=code | manifest | all` (default `all`). Filter joins `WHERE agents.kind = ?`.

---

## 7. Frontend changes

### 7.1 Catalog move

`packages/contracts/src/providers.ts` (new) becomes the source of truth for `PROVIDER_PRESETS` and `PROVIDER_MODEL_CATALOG`. The frontend Settings page re-exports from there:

```typescript
// apps/web/app/_portal_legacy/settings/_components/data.ts
export { PROVIDER_PRESETS, PROVIDER_MODEL_CATALOG } from "@agentic/contracts";
```

The 12 existing providers carry through unchanged. **OpenRouter** is added as the 13th:

```typescript
{
  id: "openrouter",
  name: "OpenRouter",
  endpoint: "https://openrouter.ai/api/v1",
  keyPrefix: "sk-or-",
  header: "Authorization: Bearer",
  docs: "https://openrouter.ai/keys",
  installed: true,
  color: "#6366f1",
}
```

OpenRouter catalog seeded with a small set of prefixed model names (`anthropic/claude-sonnet-4-5`, `openai/gpt-4.1`, `google/gemini-2.5-flash`, etc.).

---

## 8. Runtime cleanup

### 8.1 Remove mock `llmCall()` from `packages/tools/`

`packages/tools/src/index.ts` keeps `httpFetch` + `channelPublish` + `runTool` + `ToolContext` + `ToolResult`. The `llmCall()` export is **deleted**.

### 8.2 Update `packages/runtime/src/step-engine.ts`

Replace each `llmCall(genericCtx(ctx), { prompt: rendered })` call with:

```typescript
const response = await gateway.chat({
  messages: [
    { role: "system", content: "You are an LLM-driven workflow step." },
    { role: "user", content: rendered },
  ],
  model: prompt.model ?? undefined,
});

return {
  ok: true,
  type: "logic",
  data: response.text,
  tokensIn: response.tokensIn ?? 0,
  tokensOut: response.tokensOut ?? 0,
  meta: {
    prompt: prompt.name,
    provider: response.provider,
    model: response.model,
    tenant: true,
  },
};
```

The gateway singleton is obtained via a small accessor (`packages/runtime/src/llm.ts` → `getRuntimeGateway()`) that lazy-imports `@agentic/llm-gateway`. This keeps the runtime package's surface area minimal.

### 8.3 Step engine surfaces provider + model

Now that `steps` has `provider` + `model` + `tokensIn` + `tokensOut` columns, the step engine writes them when it closes a step row.

---

## 9. Monitoring reuse

Code agents are first-class `agents` rows. The existing monitoring surface works unchanged:

- `GET /v1/agents` (filter `?kind=code`) → lists code agents with their run counts
- `GET /v1/agents/:kebab` → returns the agent detail + recent runs
- `GET /v1/runs/:runId` → run detail + steps array
- `GET /v1/runs/:runId/logs?follow=1` → SSE log tail from `data/logs/<tenant>/runs/<date>/<runId>.log`
- `GET /v1/deployments?target=code_agent` → audit trail of code agent registrations

No new monitoring surface is needed.

---

## 10. Error handling & retries

- Adapter-level: 1 retry on transient errors (`rate_limit`, `timeout`, `network`, `provider_error`) with 250ms → 1s backoff.
- Gateway-level (when `providers: [...]` is set): fall through to next provider on the same transient codes.
- `BaseAgent.run()` does **not** retry — that's the gateway's job. Run-level retries are an Inngest concern (the async path gets 3 retries via Inngest's default).
- Timeouts via `AbortSignal.timeout(timeoutMs)`. The adapter must respect the signal.

---

## 11. Observability

| Channel | Captures |
|---|---|
| `runs` row | aggregated tokens, model, status, duration, log_path |
| `steps` row | per-call provider, model, tokens, duration, error |
| `audit_log` row | `action='llm.call'`, meta = `{provider, model, status, tokens, latencyMs}` (no prompt/response) |
| File log | NDJSON-ish lines at `data/logs/<tenant>/runs/<date>/<runId>.log` |
| SSE | `GET /v1/runs/:runId/logs?follow=1` tails the file |
| Sidecar artifacts | `data/artifacts/<runId>/step-N-{input,output}.json` (prompts + responses for replay) |

---

## 12. Future work (v2)

| Feature | Notes |
|---|---|
| Streaming responses | `chat.stream()` returning `AsyncIterable<ChatChunk>`; SSE wrapper for portal |
| Tool/function calling loop | `BaseAgent` already has `maxSteps`; engine extension only |
| Multimodal | extend `ChatMessage.content` to `string \| Array<{type, ...}>` |
| Per-tenant BYOK | `tenant_provider_keys` table; gateway resolution chain |
| Rate limiting | per-tenant, per-provider buckets in front of adapter calls |
| Prompt caching | Anthropic cache_control headers; semantic cache wrapper |
| Cost ceilings | derive cost from tokens × price; budget enforcement |
| OTEL spans | `LLM_TELEMETRY_ENABLED` flag is planned; collector wiring deferred |
| Embeddings | separate gateway if needed |

---

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Real API calls during local dev burn tokens | Default `LLM_DEFAULT_PROVIDER=mock`; tests force mock |
| Leaked keys in `.env` (already happened — 4 keys) | Rotate before merge; gateway never logs keys; redaction helper |
| Provider-specific quirks break uniform contract | Each adapter wraps native errors in `LLMError`; native response shape stays in `raw` |
| `steps` schema changes break existing manifest runs | All deltas are additive (nullable columns); existing rows untouched |
| BaseAgent → Inngest path diverges from sync path | Sync route and Inngest function both call `agent.run()` — single implementation |
| Bedrock/Vertex stubs surface in `GET /v1/llm/providers` with `hasKey: false` | UI badges "not configured" — acceptable for v1 |

---

## 14. Done definition

1. All 5 vitest cases pass.
2. `GET /v1/llm/providers` returns every entry in `PROVIDER_IDS`.
3. `POST /v1/agents/testAgent/invoke` returns a non-empty `output`.
4. testAgent invocation persists: a `runs` row, a `steps` row with provider+model+tokens, a file log with `run.start`/`run.ok` markers, and a `deployments` row with `target='code_agent'`.
5. Frontend Settings → Models tab shows OpenRouter as an installed provider.
6. Documentation files exist at the four specified paths.
