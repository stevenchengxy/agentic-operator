# LLM model controls and catalog snapshot

**Verified:** 2026-07-19
**Scope:** OpenAI, Anthropic, OpenRouter, Moonshot/Kimi, Z.AI/GLM, and DeepSeek

This document records the provider facts behind
`PROVIDER_MODEL_CATALOG` and the gateway's provider-neutral controls. Prices
are USD per million tokens. Concrete model IDs should be used for reproducible
evaluations; mutable `latest` aliases are intentionally not evaluation keys.
OpenAI's `gpt-5.6` alias currently resolves to `gpt-5.6-sol`; the catalog uses
the concrete Sol ID so evaluation results remain reproducible.

## Normalized request controls

```ts
interface ChatRequest {
  temperature?: number;
  reasoning?: {
    mode?: "standard" | "pro";
    effort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
    summary?: "none" | "auto" | "concise" | "detailed";
    context?: "auto" | "current_turn" | "all_turns";
  };
  verbosity?: "low" | "medium" | "high";
  store?: boolean;
}
```

Mode and effort are independent. `pro` is a model execution mode, not a
latency/service tier. The checked-in catalog advertises the exact normalized
subset supported by each provider/model pair, and the gateway rejects an
invalid catalog-known combination before dispatching a paid request.

Temperature is a capability, not a universal request default. Catalog entries
use `temperatureRange: {min,max}` when supported, `null` when the field must be
omitted, and no value when support is unknown. The gateway removes inherited
agent temperatures for known-unsupported models. For a newer/custom model, it
retries once without temperature only when the provider explicitly returns an
unsupported-temperature 400, then remembers that result for the gateway
process lifetime. Other bad requests are never retried.

| Provider   | Gateway mapping                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI     | Responses API `reasoning: {mode, effort, summary, context}`. GPT-5.6 Standard and Pro use the same direct model ID.                                                           |
| Anthropic  | Messages API `thinking: {type:"adaptive"}` plus `output_config.effort`. No Pro mode. `none` disables/omits thinking only on models that permit it; Fable/Mythos always think. |
| OpenRouter | Effort-only requests may use Chat Completions. Richer controls use OpenResponses. GPT-5.6 mode is normalized to OpenRouter's paired base/`-pro` model IDs.                    |
| Moonshot   | Kimi K3 is always reasoning at native `max`; other explicit effort values and sampling controls are rejected. K2.7/K2.6 retain their model-specific mappings.                 |
| Z.AI       | GLM-5.2 accepts the documented `none`, `high`, and `max` reasoning choices and defaults to `max`; older GLM entries retain their narrower mappings.                           |
| DeepSeek   | `none` disables thinking; `low`/`medium`/`high` map to native `high`; `xhigh`/`max` map to native `max`.                                                                      |

Current temperature constraints:

| Provider/model family                           | Gateway behavior                                                                                    |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| OpenAI GPT-5.6 Sol/Terra/Luna                   | Omit temperature.                                                                                   |
| Anthropic Fable 5, Mythos 5, Opus 4.8, Sonnet 5 | Omit temperature.                                                                                   |
| Direct Moonshot Kimi K3/K2.7/K2.6               | Omit temperature; sampling is fixed.                                                                |
| Direct Z.AI GLM-5.x                             | Accept `0..1`.                                                                                      |
| Direct DeepSeek V4                              | Accept `0..2`.                                                                                      |
| OpenRouter                                      | Overlay the dated catalog with live `supported_parameters`; absence of `temperature` means omit it. |

DeepSeek, Kimi, and GLM return opaque `reasoning_content` during tool calls.
The gateway carries it only as transport state and replays it verbatim on the
next assistant turn. It is never exposed as a reasoning summary or written to
the usage ledger.

## Direct-provider catalog

Input columns are cache-miss input / cache-hit input. Cache-write rates are
stored separately in the catalog where providers publish them.

| Provider  | Model ID                                 |  Context / max output |     Input / cached | Output |
| --------- | ---------------------------------------- | --------------------: | -----------------: | -----: |
| OpenAI    | `gpt-5.6-sol`                            |         1,050k / 128k |         $5 / $0.50 |    $30 |
| OpenAI    | `gpt-5.6-terra`                          |         1,050k / 128k |      $2.50 / $0.25 |    $15 |
| OpenAI    | `gpt-5.6-luna`                           |         1,050k / 128k |         $1 / $0.10 |     $6 |
| Anthropic | `claude-fable-5`                         |         1,000k / 128k |           $10 / $1 |    $50 |
| Anthropic | `claude-mythos-5` (limited availability) |         1,000k / 128k |           $10 / $1 |    $50 |
| Anthropic | `claude-opus-4-8`                        |         1,000k / 128k |         $5 / $0.50 |    $25 |
| Anthropic | `claude-sonnet-5`                        |         1,000k / 128k |         $2 / $0.20 |    $10 |
| Anthropic | `claude-haiku-4-5`                       |            200k / 64k |         $1 / $0.10 |     $5 |
| Moonshot  | `kimi-k3`                                | 1,048,576 / 1,048,576 |         $3 / $0.30 |    $15 |
| Moonshot  | `kimi-k2.7-code`                         |  262k / not published |      $0.95 / $0.19 |     $4 |
| Moonshot  | `kimi-k2.7-code-highspeed`               |  262k / not published |      $1.90 / $0.38 |     $8 |
| Moonshot  | `kimi-k2.6`                              |  262k / not published |      $0.95 / $0.16 |     $4 |
| Z.AI      | `glm-5.2`                                |         1,000k / 131k |      $1.40 / $0.26 |  $4.40 |
| Z.AI      | `glm-5.1`                                |           205k / 131k |      $1.40 / $0.26 |  $4.40 |
| Z.AI      | `glm-5-turbo`                            |           205k / 131k |      $1.20 / $0.24 |     $4 |
| Z.AI      | `glm-5`                                  |           205k / 131k |         $1 / $0.20 |  $3.20 |
| DeepSeek  | `deepseek-v4-pro`                        |         1,049k / 384k | $0.435 / $0.003625 |  $0.87 |
| DeepSeek  | `deepseek-v4-flash`                      |         1,049k / 384k |    $0.14 / $0.0028 |  $0.28 |

Claude Sonnet 5's listed direct price is promotional through 2026-08-31.
The catalog already schedules the 2026-09-01 price of $3 input, $0.30 cache
read, and $15 output. OpenAI GPT-5.6 requests above 272k input use the
provider's whole-request long-context schedule, which is also represented in
the catalog.

Context and output limits are route-specific. Moonshot describes Kimi K3 as a
1M-context model and separately documents an exact
`max_completion_tokens=1_048_576` ceiling; the catalog keeps that operational
maximum while the UI displays it as 1M. The pricing page's statement that
1M means 1,000,000 defines its billing unit, not a smaller API validator cap.
Direct Z.AI documents an exact 1,000,000-token GLM-5.2 context, while
OpenRouter advertises 1,048,576 for its own `z-ai/glm-5.2` route. A `null`
maximum output means the route did not publish a ceiling; it never means
unlimited output.

## Selected OpenRouter routes

OpenRouter prices are a dated snapshot of the lowest current route returned by
its live catalog and can differ from direct-provider prices.

| OpenRouter model ID              |     Input / cached |  Output |
| -------------------------------- | -----------------: | ------: |
| `openai/gpt-5.6-sol[-pro]`       |         $5 / $0.50 |     $30 |
| `openai/gpt-5.6-terra[-pro]`     |      $2.50 / $0.25 |     $15 |
| `openai/gpt-5.6-luna[-pro]`      |         $1 / $0.10 |      $6 |
| `anthropic/claude-fable-5`       |           $10 / $1 |     $50 |
| `anthropic/claude-opus-4.8`      |         $5 / $0.50 |     $25 |
| `anthropic/claude-opus-4.8-fast` |           $10 / $1 |     $50 |
| `anthropic/claude-sonnet-5`      |         $2 / $0.20 |     $10 |
| `moonshotai/kimi-k3`             |         $3 / $0.30 |     $15 |
| `moonshotai/kimi-k2.7-code`      |    $0.719 / $0.149 |   $3.49 |
| `moonshotai/kimi-k2.6`           |     $0.66 / $0.144 |   $3.41 |
| `z-ai/glm-5.2`                   | $0.2912 / $0.05408 | $0.9152 |
| `deepseek/deepseek-v4-pro`       | $0.435 / $0.003625 |   $0.87 |
| `deepseek/deepseek-v4-flash`     |     $0.098 / $0.02 |  $0.196 |

The live discovery parser also imports OpenRouter's reasoning and temperature
capability metadata. Dynamic price sentinel `"-1"` is treated as unknown,
never as a negative or zero price.

## Evaluation and accounting

Agent manifests, code-agent invocation, and Agent Studio Test Lab all pass the
normalized controls through to the gateway. Test Lab derives its selectors
from the checked-in model capabilities, making unsupported matrices difficult
to construct accidentally.

Each provider attempt stores the requested mode, effort, summary/context,
verbosity, and storage choice alongside normalized input, cached, output, and
reasoning tokens. Usage reports can therefore compare quality/latency/cost by
the actual evaluation configuration. Provider-generated reasoning summaries
may appear in traces; raw chain-of-thought does not.

An agent or one-off Studio override uses the same shape:

```json
{
  "provider": "openai",
  "model": "gpt-5.6-terra",
  "reasoning": {
    "mode": "pro",
    "effort": "max",
    "summary": "concise",
    "context": "all_turns"
  },
  "verbosity": "medium",
  "store": false
}
```

## Official sources

- OpenAI: [latest models](https://developers.openai.com/api/docs/guides/latest-model), [reasoning mode](https://developers.openai.com/api/docs/guides/reasoning#reasoning-mode), [pricing](https://developers.openai.com/api/docs/pricing)
- Anthropic: [model overview](https://platform.claude.com/docs/en/about-claude/models/overview), [effort](https://platform.claude.com/docs/en/build-with-claude/effort), [pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- OpenRouter: [live model catalog](https://openrouter.ai/api/v1/models), [reasoning controls](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens), [parameters](https://openrouter.ai/docs/api/reference/parameters)
- Moonshot: [models](https://platform.kimi.ai/docs/models), [Kimi K3 quickstart](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart), [K3 pricing](https://platform.kimi.ai/docs/pricing/chat-k3), [K2.7 pricing](https://platform.kimi.ai/docs/pricing/chat-k27-code), [K2.6 pricing](https://platform.kimi.ai/docs/pricing/chat-k26)
- Z.AI: [GLM-5.2](https://docs.z.ai/guides/llm/glm-5.2), [latest-model integration limits](https://docs.z.ai/devpack/latest-model), [thinking mode](https://docs.z.ai/guides/capabilities/thinking-mode), [pricing](https://docs.z.ai/guides/overview/pricing)
- DeepSeek: [models and pricing](https://api-docs.deepseek.com/quick_start/pricing), [thinking mode](https://api-docs.deepseek.com/guides/thinking_mode), [chat schema](https://api-docs.deepseek.com/api/create-chat-completion)
