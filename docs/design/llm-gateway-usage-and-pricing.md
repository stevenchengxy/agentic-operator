# LLM gateway usage and pricing

Status: implemented July 15, 2026. The catalog is a dated operational
snapshot, not an assertion that model names or prices are permanent.

## Decision

Keep `@agentic/llm-gateway` as the platform boundary and adopt the strongest
patterns from Vercel AI SDK rather than replacing the runtime wholesale.

AI SDK provides a useful provider registry, a normalized usage vocabulary,
multi-step totals, provider metadata, and an OpenAI-compatible provider with
custom metadata extraction. Those ideas now appear here as normalized token
usage, provider-native metadata, and adapter-independent dispatch. AI SDK does
not own this platform's dated price snapshots, per-tenant budgets, per-attempt
ledger, run/step attribution, or Inngest durability contract. A migration now
would therefore add a second abstraction without removing the platform-specific
work. It remains a reasonable future implementation layer behind
`ProviderAdapter`, especially if streaming and broader multimodal support become
priorities.

References: [AI SDK provider management](https://ai-sdk.dev/docs/ai-sdk-core/provider-management),
[generateText usage](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text),
[OpenAI-compatible providers](https://ai-sdk.dev/providers/openai-compatible-providers),
and the [provider directory](https://ai-sdk.dev/providers/ai-sdk-providers).

## Verified primary catalog

Prices are USD per million tokens for standard synchronous API use. Cache
prices are recorded separately in `CatalogPricing`; the compact table shows
uncached input → output.

| Provider | Primary model IDs in the catalog | Input → output | Official source |
|---|---|---:|---|
| OpenAI | `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini` | 5 → 30; 2.5 → 15; 1 → 6; 0.75 → 4.5 | [models](https://developers.openai.com/api/docs/models), [pricing](https://developers.openai.com/api/docs/pricing) |
| Anthropic | `claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-5`, `claude-haiku-4-5` | 10 → 50; 5 → 25; 2 → 10; 1 → 5 | [models](https://platform.claude.com/docs/en/about-claude/models/overview), [pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Google Gemini | `gemini-3.5-flash`, `gemini-3.1-flash-lite`, `gemini-3.1-pro-preview`, `gemini-3-flash-preview` | 0.75 → 4.5; 0.25 → 1.5; 2 → 12; 0.5 → 3 | [models](https://ai.google.dev/gemini-api/docs/models), [pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| DeepSeek | `deepseek-v4-pro`, `deepseek-v4-flash` | 0.435 → 0.87; 0.14 → 0.28 | [models](https://api-docs.deepseek.com/api/list-models/), [pricing](https://api-docs.deepseek.com/quick_start/pricing) |
| Moonshot AI | `kimi-k2.6` | 0.95 → 4 | [models](https://platform.kimi.ai/docs/models), [pricing](https://platform.kimi.ai/docs/pricing/chat-k26) |
| Z.AI | `glm-5.1`, `glm-5`, `glm-5-turbo` | 1.4 → 4.4; 1 → 3.2; 1.2 → 4 | [models](https://docs.z.ai/guides/overview/overview), [pricing](https://docs.z.ai/guides/overview/pricing) |
| OpenRouter | `openai/gpt-oss-120b`, `google/gemini-3.1-pro-preview`, `anthropic/claude-sonnet-5`, `deepseek/deepseek-v4-pro`, `nvidia/nemotron-3-ultra-550b-a55b:free` | routed/dynamic; snapshot retained as fallback | [models API](https://openrouter.ai/docs/api/api-reference/models/get-models), [usage accounting](https://openrouter.ai/docs/api/reference/overview) |

Important dated/tiered rules are represented directly rather than flattened:

- GPT-5.6 requests above 272,000 input tokens use the official long-context
  input, cache, cache-write, and output tier for the whole request.
- Gemini 3.1 Pro Preview uses its above-200,000-token tier for the whole
  request.
- Claude Sonnet 5 uses the introductory 2 → 10 price through August 31, 2026,
  then the scheduled 3 → 15 price from September 1, 2026.
- Anthropic 5-minute and 1-hour cache writes are billed independently from
  cache reads.
- DeepSeek cache hits use the provider's cache-hit price, based on
  `prompt_cache_hit_tokens`.

The originally suggested `gemini-3.1-flash-preview` is not cataloged as a
regular text generation model in the current Gemini model/pricing pages. The
catalog uses the currently documented stable `gemini-3.5-flash` and
`gemini-3.1-flash-lite`; live/audio preview IDs should be added only to a
matching realtime adapter.

## Cost authority and normalization

Cost authority is deterministic:

1. A valid provider-reported total cost wins. OpenRouter returns `usage.cost`
   after routing, so this is more accurate than a static model price.
2. Otherwise, the dated catalog prices the exact response model and usage
   buckets.
3. If neither source is available, cost is `null` with source `unpriced`.
   Unknown cost is never coerced to zero.

The normalized usage object records total input/output plus cache reads,
generic cache writes, Anthropic 5-minute/1-hour writes, reasoning, and audio
subsets. Reasoning is not double-charged: OpenAI-compatible reasoning tokens
are a subset of output. Gemini `thoughtsTokenCount` is added to candidate
tokens because Gemini bills thinking as output; see [Gemini token usage](https://ai.google.dev/gemini-api/docs/generate-content/tokens).

All cost arithmetic uses integer USD nanodollars. The budget's legacy integer
cent field is a ceiling projection of the exact accumulated value, eliminating
the prior behavior that rounded every small call up to one cent.

## Reasoning and response controls

The gateway uses one normalized request vocabulary while the checked-in model
catalog advertises each model's exact supported subset:

- `reasoning.mode`: `standard | pro`
- `reasoning.effort`: `none | minimal | low | medium | high | xhigh | max`
- `reasoning.summary`: `none | auto | concise | detailed`
- `reasoning.context`: `auto | current_turn | all_turns`
- `verbosity`: `low | medium | high`
- `store`: optional provider-side response retention

OpenAI accepts both storage choices. OpenRouter's current OpenResponses
endpoint is stateless, so the normalized gateway accepts only `store: false`
there and rejects `true` before dispatch.

Catalog-known invalid combinations fail before budget checks and provider
dispatch. Unknown/live-discovered model IDs defer validation to the adapter so
new provider releases do not require a gateway release merely to be tried.

OpenAI calls use the Responses API so GPT-5.6 `standard`/`pro`, `max` effort,
reasoning context, summaries, verbosity, and storage are not lost. OpenRouter
uses its broad Chat Completions normalization for effort-only calls and its
Responses endpoint when richer controls are selected. Anthropic effort maps to
adaptive thinking plus `output_config.effort`. Gemini effort maps to
`thinkingConfig.thinkingLevel` through the current `@google/genai` SDK.

Only provider-generated reasoning summaries are exposed. Raw chain-of-thought
is never persisted or emitted as a user-facing trace; providers that require
reasoning state during a tool loop carry it only in the opaque, transient
`reasoningContent` replay field.
`llm.reasoning_summary` remains subject to the agent's existing
`observability.reasoning_summary` switch.

## Durable ledger

Migration `0018_llm_usage_ledger.sql` adds `llm_calls` and
`tenant_budgets.used_usd_nanos`; `0019_llm_reasoning_controls.sql` adds the
requested reasoning mode, effort, summary, context, verbosity, and storage
choice to every attempt row.

An `llm_calls` row is inserted before every attributed provider attempt and
finalized as `ok` or `failed`. Retries and provider failover share a
`logical_call_id` and have increasing attempt numbers. Successful rows record:

- tenant, run, step, purpose, requested/response model, provider request ID;
- all normalized token buckets and the raw provider usage object;
- nanodollar cost components, cost authority, price source, and snapshot date;
- finish reason and latency.

Failed attempts retain their error code/message. A timeout may have consumed
tokens upstream without returning usage; such an attempt remains cost-unknown
until provider-side reconciliation. Accounting failures are non-transient so a
provider call that already completed is never retried internally because a DB
write failed.

`GET /v1/usage` aggregates exact successful-call values by agent, model,
provider, reasoning-control tuple, and UTC day. `GET /v1/usage/calls` exposes tenant-scoped attempt rows
for reconciliation, including failures and unfinished `started` rows.

## Provider configuration

Moonshot and Z.AI use the shared OpenAI-compatible adapter:

- `MOONSHOT_API_KEY`, base URL `https://api.moonshot.ai/v1`
- `ZAI_API_KEY`, base URL `https://api.z.ai/api/paas/v4`

The endpoints follow the vendors' official compatibility guidance:
[Kimi API overview](https://platform.kimi.ai/docs/api/overview) and
[Z.AI API introduction](https://docs.z.ai/api-reference/introduction).

## Maintenance

Before changing prices, verify the official pages above, update `priceAsOf`,
add an effective-dated entry rather than mutating a historical tier, and add a
pricing regression test. OpenRouter's live model endpoint can refresh picker
metadata, but recorded routed cost should continue to come from the completion
response. Existing pre-migration run totals cannot be accurately backfilled
without provider invoices/logs and are intentionally not assigned estimated
costs.
