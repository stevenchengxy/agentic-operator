# Agent Builder runtime and retrieval specification

Status: implemented backend contract (2026-07-16)

## Product invariant

An authored agent is an independently deployable event consumer/producer. A
workflow canvas stage is presentation metadata, not an execution dependency.
New identities are therefore stable kebab-case slugs derived only from the
agent name. Every publish request declares at least one trigger and at least
one emitted event; v2 agents may emit more than one event.

Publishing still uses the existing atomic manifest-import path. It creates an
immutable workflow/agent version, flips the live deployment, persists missing
event catalog entries, and verifies that the Inngest function is hot-loaded.

## Six archetypes

The API owns the archetype catalog at `GET /v1/agents/archetypes`. The UI
should render this response instead of maintaining a second template spec.

| Template id | Product name    | Default graph                    | Typed result                               | Default model profile |
| ----------- | --------------- | -------------------------------- | ------------------------------------------ | --------------------- |
| `blank`     | Blank agent     | complete                         | Customizable result                        | balanced              |
| `classify`  | Classifier      | classify                         | label, confidence, rationale, review flag  | fast                  |
| `extract`   | Extractor       | extract                          | data, extracted/missing fields, confidence | structured            |
| `rag`       | Deep Search     | plan, gather, synthesize, verify | cited report with limitations              | research              |
| `loop`      | Tool-loop agent | plan, execute/verify             | completion, tool outcomes, next actions    | tool use              |
| `human`     | Human approval  | durable operator decision        | operator resolution payload                | human                 |

All six definitions have explicit v2 input/output ports and output artifact
policies. Classifier and Extractor use low-temperature strict JSON plus one
repair turn. Deep Search uses strict cited JSON, two repair turns, and retains
the raw response. Blank and Human Approval intentionally allow a customizable
domain payload.

If a Human Approval definition includes a model preparation step followed by a
manual step, its actor list is `["Human", "Agent"]` and `generated=true` so
operator-facing summaries retain Human as the primary actor.
The prepared model/tool result, decision form schema, and awaiting role are
copied into the durable task payload before the runtime waits for
`task.resolved`.

## Deep Search modes

`searchMode` controls bounded effort without changing the legacy template id:

| Mode                      | Graph                               | Tool-loop cap |
| ------------------------- | ----------------------------------- | ------------: |
| `answer`                  | gather → synthesize                 |             8 |
| `investigate`             | plan → gather → synthesize          |            12 |
| `deep_research` (default) | plan → gather → synthesize → verify |            20 |

Gathering can call `search.web` repeatedly with diversified queries and can
combine public evidence with the tenant's `ontology.query` results. Synthesis
must map material claims to real retrieved URLs. Verification audits
claim-to-source coverage, citation mismatches, contradictions, inference, and
known gaps before returning the final report.

`search.web` is a real read-only global tool. It supports Tavily by default,
Brave Search, Serper, or a compatible configured endpoint and normalizes each
result to title, URL, snippet, publication date, and score. Credentials are
environment references, never LLM arguments or literal manifest secrets.

## Model selection

The author may set an agent-level `provider` and `model`, and every authored
step may independently override:

```json
{
  "name": "synthesizeResearch",
  "type": "logic",
  "provider": "anthropic",
  "model": "claude-sonnet-5",
  "reasoning": { "effort": "high" },
  "verbosity": "high",
  "store": false,
  "temperature": 0.1,
  "maxTokens": 12000,
  "timeoutS": 300
}
```

The manifest uses canonical snake-case action fields (`max_tokens`,
`timeout_s`). Execution precedence is action, then tenant prompt (model only),
then agent, then gateway default. Provider and all other controls are action
then agent.

When model is omitted, the server selects from the configured provider's
catalog using the archetype profile. Blank agents additionally infer research,
structured extraction, classification, or tool-use intent from the description.
The prompt and deploy responses return `modelSelection` with provider, model,
profile, source, and a human-readable reason. Providers without a curated
catalog require either an explicit model or a default that belongs to that same
provider.

## Ontology SDK

Every newly authored agent automatically allow-lists `ontology.query`. The
tool uses Neo4j's Query API v2:

```text
POST https://<host>/db/<database>/query/v2
body.accessMode = "Read"
```

The model cannot submit Cypher. It chooses one bounded operation:

- `search_nodes`
- `get_node`
- `neighbors`
- `find_paths` (depth 1-4)
- `schema`

The SDK generates parameterized Cypher. User strings remain parameters, limits
are clamped, execution time is bounded, and every node predicate uses the
authenticated `ToolContext.tenantSlug`. Neighbor queries scope both endpoints;
path queries require every node in `nodes(path)` to match the tenant; schema
queries scope both relationship endpoints. The Neo4j account should also be
read-only because Query API access mode controls routing, not authorization.

The endpoint, database, tenant property, returned-property allow-list, and
response-byte cap are server policy. An endpoint override must match the
server-pinned URL or an explicit host allow-list and must bind tenant-prefixed
credential env names, so an authored URL can never inherit global credentials.
Returned maps are projected to server-allowed properties and sensitive-looking
nested keys are redacted. Network timeouts and Query API execution time (sent
in seconds) are independently bounded.

## Authoring API summary

Both prompt generation and publish accept required `triggers` and `emits`,
optional agent `provider`/`model`, optional `steps`, and optional Deep Search
`searchMode`. `stage` remains tolerated temporarily for old clients but is
ignored and never persisted.

`DeployAuthoredAgentBody.steps[]` supports `id`, `name`, `description`, `type`,
`actionPrompt`, `tool`, `provider`, `model`, `reasoning`, `verbosity`, `store`,
`temperature`, `maxTokens`, `retries`, and `timeoutS`. A custom manual step is
completed with safe approval defaults (operator role and approve/reject/
supplement decision form).

## Security and failure behavior

- Manifest `tool_use` is the runtime allow-list; global registration alone is
  not authority to execute a tool.
- Literal credential fields and credential-bearing default headers are rejected.
- Tenant-specific `*_env` bindings must use the tenant prefix.
- Search and ontology endpoint overrides are server-allowlisted and cannot
  inherit global credentials.
- Web search and ontology calls are read-only and bounded by timeout/result or
  response-size caps.
- Deep Search reports retrieval gaps rather than manufacturing citations.
- A model/tool output is not considered complete until local JSON-schema
  validation succeeds or the authored repair budget is exhausted.
