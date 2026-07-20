# AI settings and task-aware model routing

**Status:** implemented (v1)  
**Policy date:** 2026-07-19  
**Scope:** workspace AI settings, task routing, direct providers, OpenRouter,
NewAPI-compatible gateways, diagnostics, and usage observability

This design is the control plane for choosing an LLM. It complements the
provider/model capability catalog and the usage/billing ledger; it does not
replace either one.

## Decisions

1. A configured gateway is a named instance, not a closed provider enum.
   `newapi`, `newapi-csi`, and `newapi2` can therefore coexist with independent
   endpoints and credentials.
2. A canonical route is
   `<gateway-instance>/<provider-native-model-id>`. Parsing splits only the
   first slash, so `openrouter/openai/gpt-5.6-sol` keeps
   `openai/gpt-5.6-sol` intact for the upstream request.
3. Tasks use a validated taxonomy and deterministic resolution. Selection is
   explicit route, exact profile, alias, nearest configured parent, then the
   workspace default. Every result includes its reason and resolution trace.
4. Omitted generation parameters mean "use the provider/model default." In
   particular, the service does not invent a temperature, reasoning effort,
   or verbosity. Response persistence is the deliberate exception: the
   platform keeps OpenAI-style Responses storage off unless explicitly enabled.
5. Settings are revisioned and secret-free. The JSON file is authoritative;
   a complete non-secret copy is mirrored into a managed `.env.local` block.
   API keys remain in the encrypted credential vault.
6. One logical call can have multiple gateway attempts. Each attempt is
   recorded separately, while reports also expose logical-call, retry,
   fallback, timeout, latency, token, and cost totals.

## Route grammar and gateway instances

Examples:

| Route                           | Connection used         | Model ID sent upstream |
| ------------------------------- | ----------------------- | ---------------------- |
| `openai/gpt-5.6-sol`            | direct OpenAI           | `gpt-5.6-sol`          |
| `openrouter/openai/gpt-5.6-sol` | OpenRouter              | `openai/gpt-5.6-sol`   |
| `newapi/kimi-k3`                | configured `newapi`     | `kimi-k3`              |
| `newapi-csi/moonshotai/kimi-k3` | configured `newapi-csi` | `moonshotai/kimi-k3`   |

Gateway IDs are lowercase kebab-case. The public configuration supports:

- `direct`: a built-in native or compatible adapter selected by `providerId`;
- `openrouter`: the managed OpenRouter connection;
- `newapi`: an independently configured NewAPI deployment;
- `openai-compatible`: another compatible endpoint such as vLLM;
- `mock`: deterministic local testing without network traffic.

Each instance can declare its base URL, opaque credential reference, API mode
(`auto`, Chat Completions, or Responses), wire dialect, advertised endpoint
capabilities, timeout policy, and retry policy. A model-family hint is allowed
on a route candidate only to choose wire behavior/capabilities. It must never
be interpreted as the upstream provider account or as a billing rate.
Family aliases such as `moonshot.kimi` and `zhipu.glm`, plus recognizable
namespaced model IDs, are resolved by one shared behavioral resolver used by
validation, dispatch, catalog lookup, and the UI. This inference affects wire
translation only; the configured gateway instance remains the billing and
credential boundary.

NewAPI exposes OpenAI-compatible model, Chat Completions, and, depending on the
deployment and channel conversion, Responses surfaces. Channel names, model
mapping, routing, pricing, and supported conversions are instance-defined.
Consequently the platform does not infer the real provider, price, or feature
support from a slash-prefixed model ID. Provider-reported request cost wins;
otherwise the call is catalog-priced only when the exact gateway/provider
model is authoritative, and remains `unpriced` when it is not.

## Task taxonomy and routing

The core taxonomy includes the requested product workloads:

- ontology and OntoGene generation;
- evaluation and classification;
- chat and AI suggestions;
- Graph Engine and ontology queries;
- file parsing and structured extraction;
- workflow generation, agent authoring, output repair, research, and tool
  loops.

Product code supplies a stable task class such as `workflow.generate` or
`agent.author`. A workspace can define one profile per task class and a
mandatory default profile. Profiles contain an ordered candidate list and may
specify workload/capability intent, model controls, fallback conditions, and
per-candidate overrides.

Shared profile and ordinary agent defaults are normalized independently for
each catalog-known fallback: controls the fallback cannot accept are omitted
so its provider default applies. Candidate overrides and Test Lab request
controls remain strict, deliberate provider-specific choices and surface a
validation error when invalid.

Resolution is deterministic:

```text
explicit route
  -> exact task profile
  -> canonical task reached from an alias
  -> nearest configured parent profile
  -> workspace default profile
```

Unknown but syntactically valid dotted task classes walk their dotted parent
chain before defaulting. A saved taxonomy can also define explicit parent
relationships, so a new specialized feature can inherit the closest policy
without a gateway code change. Disabled candidates are skipped. Fallback only
continues for conditions allowed by that candidate; all candidates share one
logical call ID and overall deadline.

Catalog-known models that are older than the rolling 365-day window,
restricted, deprecated, sunset, or expired are skipped in task routing and
rejected for explicit or raw gateway calls. Unknown compatible model IDs remain
allowed because a private/NewAPI deployment may legitimately be newer than the
checked-in catalog.

An explicit route intentionally bypasses the task profile's candidate and
parameter defaults. This keeps routing preview and execution identical and
lets Test Lab exercise exactly the request controls entered by the operator;
omitted controls still use the selected provider/model defaults.

## Model controls

Normalized, optional controls are:

- reasoning mode: `standard` or `pro`;
- reasoning effort: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, or
  `max`;
- safe provider-generated reasoning summary and context reuse policy;
- answer verbosity;
- temperature, maximum output tokens, JSON mode, and provider storage;
- per-request timeout and overall routing deadline.

The precedence for routed product calls is candidate override, task-profile
default, then provider/model default. Test Lab calls explicitly opt into
request-over-policy precedence so an administrator can probe a single control.
Provider response storage follows the platform's privacy-safe `false` default
where the transport otherwise stores responses.

The catalog is the preflight authority for known models. Unsupported
combinations are rejected before a paid call. Known models without temperature
support never receive a temperature field. For an unknown compatible model,
an explicit provider response saying temperature is unsupported triggers one
safe retry without that field and a process-local capability memory entry;
unrelated bad requests are not retried.

Provider mappings are kept in adapters rather than in feature code:

| Family           | Current mapping                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI GPT-5.6   | Responses controls for mode, effort, summary, context, verbosity, and storage; temperature omitted.                                             |
| Anthropic Claude | Adaptive thinking plus `output_config.effort`; no Pro mode; temperature omitted for current frontier models.                                    |
| OpenRouter       | Chat Completions for compatible effort-only calls or OpenResponses for richer controls; live `supported_parameters` refines capability display. |
| Moonshot Kimi K3 | Always-reasoning `max`; fixed sampling fields omitted; `max_completion_tokens`; extended timeout allowance.                                     |
| Z.AI GLM-5.2     | Native enabled/disabled thinking with documented `none`, `high`, and `max` effort contract.                                                     |
| DeepSeek         | Compatible thinking controls and opaque `reasoning_content` replay during tool loops.                                                           |

Opaque reasoning state is transport-only. It is never surfaced as a summary,
prompt log, or usage metadata.

## Persistence and security

The default authoritative path is `data/llm-settings.json`, containing a
versioned map of workspace settings. Writes validate the complete strict
schema, require the current revision, increment the revision, write a private
temporary file, `fsync`, and atomically rename. Stale updates receive a
conflict instead of overwriting another administrator.

The managed block in `apps/api/.env.local` contains:

- the JSON path;
- a SHA-256 checksum;
- a base64 copy of the complete non-secret JSON.

Unrelated `.env.local` content is preserved. Drift is visible in the API/UI and
can be repaired with an explicit resync. Strict contracts have no API-key or
arbitrary-header field, so a settings save cannot serialize credentials.
Credentials use opaque references resolved by tenant/workspace scope in the
encrypted provider-key vault. For every operator-configured NewAPI or other
compatible endpoint, the private vault slot is derived from the authenticated
tenant, gateway instance, and public credential reference. A reference such as
`openai` therefore cannot alias the built-in OpenAI key, another tenant's
gateway key, or any shared environment credential. Direct-provider endpoints
remain fixed in code and use their provider-owned key slots.

`AGENTIC_KEY_VAULT_SECRET` is mandatory in production; vault-backed reads
become unavailable and credential writes fail closed instead of deriving a
predictable fallback key. Vault directories/files are created with private
permissions (`0700`/`0600`), and an overly broad restored file is repaired to
`0600` before its contents are read. The vault file must remain untracked
because Git does not preserve secret-file permissions.

Dynamic base URLs accept only HTTP(S), reject embedded credentials, query
strings, and fragments, and require HTTPS in production unless explicitly
allowed. Resolution rejects loopback, private, link-local, multicast, and
other non-public addresses unless development mode or an explicit host
allow-list permits the host. Diagnostic requests reject redirects. A draft
connection test can use only the API key included in that draft request; it
cannot attach an existing stored credential to a changed endpoint.
`LLM_GATEWAY_ALLOWED_HOSTS` is the comma-separated `host[:port]` exception
list. `LLM_ALLOW_INSECURE_GATEWAYS=true` additionally permits HTTP and is
intended only for explicitly trusted private NewAPI deployments; production
operators should prefer HTTPS and the narrowest host allow-list possible.

## API and UI

The admin control surface provides:

- `GET/PUT /v1/llm/settings` — read or revision-safe save;
- `POST /v1/llm/settings/resync` — repair the `.env.local` mirror;
- `POST /v1/llm/routing/resolve` — preview the selected profile and trace;
- `POST /v1/llm/gateways/:id/key` — rotate a vault credential;
- `POST /v1/llm/gateways/:id/test-connection` — non-generating model-list
  probe;
- `GET /v1/llm/gateways/:id/models` — live model discovery;
- `POST /v1/llm/test-call` — explicit, billable prompt test with routing,
  timing, normalized usage, and cost result.

Settings mutations and diagnostics are tenant-admin operations. The unified
AI Settings page separates task routing, gateways, model fleet, a test lab, and
usage, while preserving provider defaults as blank/inherited controls. The
connection probe is labeled non-generating; the LLM test is labeled billable.

## Observability, usage, and privacy

Every provider attempt records:

- logical call ID, attempt, retry/fallback reason, and terminal status;
- requested/effective route, gateway instance/kind, safe family hint, task,
  matched task, profile, settings revision, and resolution reason;
- transport, effective controls, request timeout, and overall deadline;
- account, actor, provider credential, request, interaction, product, API,
  function, agent, run, and step attribution;
- provider/model/request ID, latency, normalized token classes, pricing
  provenance, provider cost, and billable charge.

Usage reports aggregate both successful usage and operational attempts by
task, gateway, route, actor, routing profile, provider/model, product,
function, API call, agent, reasoning configuration, and day. They expose
logical calls, attempts, successes, failures, in-flight calls, timeouts,
retries, fallbacks, unpriced calls, tokens, cost, and p50/p95 latency.

The durable database and portable `agentic.usage.v1` NDJSON deliberately omit
prompts, outputs, raw chain-of-thought, raw provider bodies, raw arbitrary
usage objects, headers, API keys, and raw provider error prose. Only normalized
counters, bounded identifiers, safe categorical error data, and cost facts are
retained.

## Verification

Automated coverage includes:

- secret-free route/settings schemas and first-slash parsing;
- explicit, exact, alias, parent, and default resolution;
- atomic JSON plus `.env.local` mirroring, revision conflicts, and resync;
- three independent NewAPI aliases, including concurrent URL/key isolation;
- network/redirect safety and draft-credential isolation;
- OpenAI, Anthropic, OpenRouter, Moonshot, Z.AI, and DeepSeek reasoning and
  temperature contracts;
- provider/catalog and provider-reported pricing, cached tokens,
  long-context pricing, and honest `unpriced` outcomes;
- per-attempt retry/fallback accounting, export privacy, and usage dimensions;
- current/legacy model governance and Top/Mid/Low/Free grouping.

Live connection and prompt tests are administrator-triggered because they use
real credentials, may create provider usage, and depend on deployment-specific
network access. Unit/integration tests use mocked transports and assert the
exact request envelope without spending provider funds.

## Operational notes and limits

- Apply migrations `0020` and `0021` before using the usage and routing views.
- A NewAPI operator must verify that the configured deployment/channel supports
  the chosen endpoint and controls; compatibility is not universal.
- Application checks resolve and reject non-public gateway addresses before
  dispatch and reject redirects, but the HTTP stack does not yet pin the
  approved DNS answer to the socket. Production deployments should enforce an
  outbound firewall/proxy policy as the DNS-rebinding defense in depth.
- Live model lists and prices are discovery snapshots. Persisted historical
  billing uses provider-reported cost or a dated authoritative catalog rate,
  never an inferred NewAPI channel price.
- Provider invoices remain the final reconciliation authority. Invoice import,
  strict concurrent budget reservations, and a dedicated export retry worker
  remain separate production-hardening work.

## Primary references

- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/model-guidance?model=gpt-5.6)
  and [pricing](https://developers.openai.com/api/docs/pricing)
- [Anthropic model overview](https://platform.claude.com/docs/en/about-claude/models/overview),
  [effort](https://platform.claude.com/docs/en/build-with-claude/effort), and
  [pricing](https://platform.claude.com/docs/en/about-claude/pricing)
- [OpenRouter model API](https://openrouter.ai/docs/api/api-reference/models/get-models),
  [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection),
  and [parameters](https://openrouter.ai/docs/api/reference/parameters)
- [Moonshot models](https://platform.kimi.ai/docs/models),
  [Kimi K3 guide](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart), and
  [K3 pricing](https://platform.kimi.ai/docs/pricing/chat-k3)
- [Z.AI GLM-5.2](https://docs.z.ai/guides/llm/glm-5.2) and
  [pricing](https://docs.z.ai/guides/overview/pricing)
- [DeepSeek API documentation](https://api-docs.deepseek.com/)
- [QuantumNous/new-api](https://github.com/QuantumNous/new-api), its
  [Chat Completions](https://docs.newapi.pro/en/docs/api/ai-model/chat/openai/createchatcompletion),
  [Responses](https://docs.newapi.pro/en/docs/api/ai-model/chat/openai/createresponse),
  [channel](https://docs.newapi.pro/en/docs/guide/feature-guide/admin/channel),
  and [pricing](https://docs.newapi.pro/en/docs/guide/feature-guide/user/pricing)
