# Agent Builder product and technical specification

Status: implementation specification  
Research date: 2026-07-16  
Owners: AI product, agent architecture, platform runtime, ontology, and portal

## 1. Outcome

The portal must let an operator create, publish, and run an event-driven agent
without writing a manifest or assigning the agent to a workflow stage.

The builder has six compatible template IDs. The names shown to users are:

1. Custom agent (`blank`)
2. Classifier (`classify`)
3. Extractor (`extract`)
4. Deep Search (`rag`, retained as the wire-format ID for compatibility)
5. Tool-loop agent (`loop`)
6. Human approval (`human`)

Each template is an executable blueprint with distinct actions, input and
output contracts, tools, model requirements, guardrails, and evaluation gates.
Templates are not prompt presets that all compile to the same logic action.

The primary UI language is **New Agent**. The terminal action is **Publish
agent**. A successful publish makes the live agent available to **Open & run**.

## 2. Locked product decisions

- Agent identity is stable and slug-based. A stage never participates in the
  authored ID.
- Authoring requires at least one trigger event and one emitted event. Both
  support multiple values.
- Stage remains optional compatibility/display metadata for imported legacy
  manifests. The workflow canvas may derive layout from event dependencies.
- Every builder-created agent explicitly allow-lists the read-only Ontology
  tool. This preserves the manifest trust boundary while making ontology access
  universal for new agents.
- Model policy is `auto` by default. The builder explains its recommendation
  and lets the user pin an agent model or override any LLM-backed action.
- Action model selection resolves in this order:
  `action override -> agent default -> auto recommendation -> tenant primary`.
- Tool and manual actions do not require an LLM. The UI must not imply that a
  model is used where none is invoked.
- Deep Research is the deepest execution mode of Deep Search, not a seventh
  template. The compatible depths are `answer`, `investigate`, and
  `deep_research`.

## 3. Research synthesis

### 3.1 Agent architecture patterns

Anthropic distinguishes predictable workflows from autonomous agents and
documents prompt chaining, routing, parallel work, orchestrator/worker, and
evaluator/optimizer as composable patterns. It recommends using the simplest
pattern that fits the task and adding autonomy only when the path cannot be
known in advance. That maps directly to the six templates: Classifier and
Extractor are constrained workflows; Tool-loop and Deep Search are bounded
agents; Human Approval is a durable workflow checkpoint.

Source: [Anthropic, Building effective agents (2024-12-19)](https://www.anthropic.com/research/building-effective-agents).

Structured output is necessary for routing and extraction but is not, by
itself, proof that the content is correct. The runtime therefore performs JSON
Schema validation and bounded repair, while template-specific evals measure
semantic accuracy and provenance.

Sources: [OpenAI, Structured Outputs (2024-08-06)](https://openai.com/index/introducing-structured-outputs-in-the-api/),
[Gemini structured output documentation](https://ai.google.dev/gemini-api/docs/structured-output).

### 3.2 Deep-research systems

Leading systems converge on this lifecycle:

```text
clarify -> reviewable plan -> adaptive search/read loop -> evidence ledger
        -> gap check -> synthesis -> citation verification -> report
```

OpenAI's API separates clarification/prompt enrichment from the research model,
runs long research in the background, exposes web/file/MCP/code tools, and
returns tool trajectories plus inline citations. Its security guidance
recommends separating public-web and sensitive private-data phases to reduce
prompt-injection and exfiltration risk.

Source: [OpenAI Deep research API guide](https://developers.openai.com/api/docs/guides/deep-research).

Google's Deep Research agent plans, searches, reads, reasons, and synthesizes
asynchronously. Its current API supports collaborative plan review, MCP,
documents, code execution, visualizations, progress streaming, follow-ups, and
bounded research time. This establishes plan review, background execution, and
observable progress as product requirements rather than optional polish.

Source: [Gemini Deep Research Agent](https://ai.google.dev/gemini-api/docs/deep-research).

Anthropic describes an orchestrator/worker implementation in which a lead
researcher persists its plan, launches parallel search agents, reassesses gaps,
and hands the result to a dedicated citation agent. Anthropic also reports a
large token premium for multi-agent research, so parallel workers are reserved
for valuable breadth-first questions with genuinely independent workstreams.

Source: [Anthropic, How we built our multi-agent research system (2025-06-13)](https://www.anthropic.com/engineering/multi-agent-research-system).

Microsoft Researcher combines a deep-research model with workplace data,
connectors, citations, permission-aware access, and enterprise compliance.
This reinforces that private retrieval must preserve source permissions rather
than flattening all data into an unrestricted model context.

Sources: [Microsoft 365 Researcher launch](https://www.microsoft.com/en-us/microsoft-365/blog/2025/03/25/introducing-researcher-and-analyst-in-microsoft-365-copilot/),
[Microsoft Researcher guide](https://support.microsoft.com/en-us/microsoft-365-copilot/get-started-with-researcher-in-microsoft-365-copilot).

Perplexity's current Advanced Deep Research adds clarifying questions, steering
while work is running, visible sources and key findings, code and document
analysis, and editable/shareable reports. The builder should therefore treat a
research result as an inspectable artifact, not only a final text blob.

Source: [Perplexity Advanced Deep Research](https://www.perplexity.ai/help-center/en/articles/13600190-what-s-new-in-advanced-deep-research).

### 3.3 Neo4j access

Runtime agents use a global tool, not a Codex Skill. The global tool registry is
already the platform's configuration-driven, tenant-aware execution surface and
its manifest allow-list is the trust boundary.

The SDK uses Neo4j's Query API v2 with read access mode, parameterized values,
explicit database selection, bounded results, and a read-only service account.
Arbitrary model-authored Cypher is not exposed. The server generates a small
set of tenant-scoped operations and pins endpoint, credentials, identifiers,
properties, timeouts, and response limits as policy.

Sources: [Neo4j Query API](https://neo4j.com/docs/query-api/current/query/),
[Neo4j Query API routing](https://neo4j.com/docs/query-api/current/routing/),
[Neo4j fine-grained access control](https://neo4j.com/docs/operations-manual/current/tutorial/access-control/).

## 4. Template specifications

### 4.1 Custom agent

Use cases:

- Novel domain workflows and copilots
- Content transformation and drafting
- Small event-driven automations that do not match another archetype

Compiled behavior:

- Validate the incoming event and named input contract.
- Understand and plan within explicit completion criteria.
- Execute using only allow-listed tools and ontology data.
- Verify the result and emit schema-valid output.

Default model profile: balanced general model with tool calling. A planning
action may use a stronger reasoning model and deterministic tool actions use no
model.

Release gates: goal completion, output validity, event correctness, tool-policy
compliance, latency/cost, and tenant isolation.

### 4.2 Classifier

Use cases:

- Intent and request routing
- Risk, priority, or policy triage
- Taxonomy and queue assignment

Contract:

- Closed labels with descriptions and examples
- Explicit `unknown`/`abstain` path
- Output contains label(s), evidence, taxonomy version, and confidence
- Confidence is described as model confidence unless a real calibration layer
  is configured; the product must not claim statistical calibration by default
- No external side effects

Default model profile: the cheapest eligible low-latency model that supports
reliable structured output. Temperature is zero/low; reasoning is minimal/low.
An optional ambiguity adjudicator may use a stronger model.

Release gates: macro/micro F1, per-label precision/recall, confusion matrix,
abstention utility, schema validity, injection robustness, latency, and cost.

### 4.3 Extractor

Use cases:

- Text, document, email, invoice, resume, and form ingestion
- Entity and relationship extraction
- Data-entry automation

Contract:

- User-editable JSON Schema and field semantics
- Normalization and null rules
- `data` is separated from field-level provenance (`source`, `page`, `span`)
- Missing evidence produces `null` or an explicit issue; it never produces an
  invented value
- Runtime schema validation with a bounded evidence-preserving repair pass

Default model profile: the cheapest model satisfying schema, context, and
media/vision requirements. Validation is deterministic. Difficult-document
retry may use a stronger long-context or vision model.

Release gates: field exact match/F1, numeric/date tolerance, schema validity,
provenance entailment, hallucinated-field/null rate, and multi-page/OCR cases.

### 4.4 Deep Search

Use cases:

- Internal policy, entity, relationship, and precedent discovery
- Evidence-backed enterprise Q&A
- Public/private investigations, due diligence, literature reviews, and market
  research

Depths:

- `answer`: one bounded iterative search/synthesis action for low latency.
- `investigate`: plan, search/follow leads, gap check, and cited synthesis.
- `deep_research`: reviewable plan, durable/background execution, independent
  parallel workers only where useful, evidence artifacts, and citation
  verification.

Core actions:

1. Clarify or enrich the request without inventing constraints.
2. Plan queries and identify entities/source classes.
3. Search ontology and approved sources iteratively.
4. Normalize results into an evidence ledger and close material gaps.
5. Synthesize, distinguish evidence from inference, and reconcile conflicts.
6. Verify claim-level citations and report unresolved uncertainty.

Evidence records contain source ID/URI, access time, content hash when
available, access scope, relevant spans, and supported claim IDs. Final
citations reference evidence records rather than model-invented URLs.

Default model profile: medium/high reasoning planner, no-LLM retrieval actions,
fast query rewrite/rerank, strongest eligible long-context synthesizer, and an
independent citation verifier. Deep mode may use a strong lead plus economical
workers.

Security: public web retrieval and sensitive Neo4j retrieval run in separate
phases. Only sanitized findings are combined for synthesis. Tool-call and
source budgets bound cost, latency, and attack surface.

Release gates: Recall@k/nDCG, answer correctness, citation precision/recall and
entailment, source quality/freshness, claim coverage, ACL leakage, duplicate
sources, latency, and budget.

### 4.5 Tool-loop agent

Use cases:

- API and operational orchestration
- Support resolution and investigations
- Open-ended tasks where the exact sequence cannot be predetermined

Contract:

- Typed tool allow-list and unambiguous tool descriptions
- Bounded plan-act-observe loop with maximum iterations, time, tokens, and cost
- Durable checkpoint per side-effecting call
- Idempotency keys and result validation
- Explicit stop criteria and human approval before consequential actions
- Final verification from tool/environment evidence

Default model profile: a reliable tool-calling reasoning model. A strong
planner, cheaper executor, and independent verifier may be assigned per action.
Fallback must preserve required capabilities.

Release gates: end-state success, tool and argument correctness, exactly-once
effects, recovery, termination, approval enforcement, authorization, and
prompt/tool-result injection resistance.

### 4.6 Human approval

Use cases:

- Approve, reject, or request changes
- Legal, policy, editorial, and quality gates
- High-impact actions that require accountable authority

Contract:

- An optional LLM prepares a grounded decision packet containing evidence,
  policy constraints, options, uncertainty, recommendation, and proposed diff
- A durable task captures role, form schema, SLA, escalation, and immutable
  audit context
- The human chooses approve, reject, changes requested, or timed out
- The LLM is advisory and cannot approve or bypass the checkpoint
- Resume correlates exactly to the task and run

Default model profile: no model for the decision step. The optional preparation
step uses a fast grounded summarizer or a balanced reasoning model for higher
risk. The UI labels that recommendation as advisory.

Release gates: no bypass/auto-approval, task/run correlation, role and tenant
authorization, exactly-once resume, timeout/escalation, immutable audit, and
faithful evidence presentation.

## 5. Model policy

### 5.1 Authoring contract

An agent stores:

- model policy: automatic or pinned
- provider/model and reasoning controls for the agent default
- a recommendation rationale and the fleet snapshot used to make it
- optional provider/model controls on every LLM-backed action

Automatic selection evaluates:

- template and natural-language purpose
- tool calling and structured-output needs
- media/vision and context-window needs
- reasoning depth
- expected latency and budget
- configured tenant fleet role and availability

The selector first filters out incapable models, then scores quality fit,
reliability, context headroom, role, cost, and latency. It returns the selected
model and a plain-language rationale. While automatic mode remains unpinned,
the recommendation updates when purpose, tools, inputs, or actions change.

### 5.2 Runtime precedence

For an LLM action, the runtime overlays action controls on the agent controls.
Provider and model recorded on step traces are the actual gateway-returned
values. A missing or incapable fallback fails explicitly; it must not silently
drop tool, schema, vision, or context requirements.

## 6. Ontology SDK/tool contract

The first-party read-only tool family supports:

- schema/ontology description
- entity search with type filters and bounded result count
- entity fetch by stable domain ID
- bounded relationship traversal with direction, relationship allow-list,
  maximum depth, and record limit
- saved, operator-owned queries with validated parameters

Implementation constraints:

- one bounded Query API v2 request per call with `accessMode: "Read"`
- explicit database, encrypted tenant integration credentials, TLS policy,
  transaction timeout, and record/byte/depth caps
- tenant scope enforced in generated Cypher and, in production, Neo4j
  RBAC/subgraph controls or a tenant-isolated database/credential
- parameterized values and validated identifiers
- no arbitrary model-authored Cypher in v1
- JSON-safe output with graph version, query ID, entity/source IDs, and tracing
- schema metadata may be cached; tenant result rows are not shared across
  tenants
- errors are returned to the tool loop without exposing credentials

Every builder-created definition includes the ontology tool in `tool_use`.
This explicit allow-list is intentional: registering a global tool alone must
never grant an existing agent new authority.

## 7. Event and publish lifecycle

1. Choose a template and describe the purpose.
2. Confirm identity; no workflow stage is shown or required.
3. Select or create one or more trigger and emitted events.
4. Review generated inputs, outputs, actions, tools, ontology access, and model
   recommendations.
5. Edit the generated system instructions and per-action model policy.
6. Validate the canonical definition and run a sample test when available.
7. Publish a new workflow version and hot-register the runtime function.
8. Offer Open & run. Invocation sends a selected trigger event through the
   event path; it does not bypass the event-driven runtime.

The runtime persists every write inside a durable step and emits downstream
events with the idempotent event primitive. Human approval creates a task in a
durable step and resumes only on the correlated resolution event.

## 8. Compatibility

- Keep template ID `rag`; only the operator-facing name changes to Deep Search.
- Continue accepting legacy numeric `stage`, but do not default, display, or
  use it for newly authored identity.
- Continue parsing bare-array/v1 manifests.
- Publish new builder definitions with the canonical v2 fields needed for
  typed inputs/outputs and multi-event emission.
- Preserve old route names as API aliases if clients use them; UI language is
  New Agent/Publish.

## 9. Security and governance

- Tool access is least-privilege and manifest allow-listed.
- Neo4j uses read-only credentials, tenant enforcement, query caps, and no raw
  Cypher surface.
- Public and sensitive retrieval contexts are separated.
- External content is untrusted data, never higher-priority instructions.
- Consequential writes require an explicit policy and, where configured,
  human approval.
- Traces record prompts according to retention policy, selected models, tool
  calls, citations, and validation results without secrets.
- Cancellation, retry, timeout, and maximum-loop behavior are explicit.

## 10. Verification matrix

Required automated coverage:

- Contract parsing without stage, with multiple triggers/emits, and with action
  model overrides
- Six template compiler snapshots proving distinct action and output graphs
- Action model precedence over agent model, including recorded trace values
- Multi-event resolution and exactly-once downstream delivery
- Ontology tenant isolation, read-only enforcement, injection resistance,
  identifier validation, result/depth/time caps, and unavailable integration
- Prompt/tool-result injection cases for autonomous templates
- Human task authorization, correlation, timeout, and no-auto-approval
- Portal tests for New Agent copy, Deep Search naming, stage absence, event
  requirements, automatic/fixed model selection, per-step overrides, and
  publish/run handoff
- Workspace typecheck, lint, focused Vitest suites, and production build under
  the pinned Node 26.5.0 runtime

## 11. Delivery plan

1. Add compatible contracts for event-first authoring, template configuration,
   multiple emissions, and action model controls.
2. Implement and unit-test the six server-owned template compilers.
3. Add the tenant-safe Ontology SDK/global tool and automatically bind it to
   builder-created agents.
4. Honor action-level model overrides in the runtime and trace actual routing.
5. Replace deployment-oriented portal copy/fields with the New Agent product
   flow and operational model recommendations.
6. Add focused backend/runtime/frontend tests, then run the pinned full
   verification sequence.
7. Follow with durable parallel Deep Research workers, live progress steering,
   persistent evidence-ledger UI, and template-specific production eval gates
   where they require infrastructure beyond the first builder release.
