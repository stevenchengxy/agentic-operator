# Workflow Run Console and Enterprise Authoring

Status: implemented design target
Surface: `/portal/<tenant>/workflows`

## Product intent

The workflow canvas is an authoring surface and an operations surface. It must
let an operator prove an unpublished workflow, deliberately start a published
workflow, inspect evidence at agent and action granularity, and change the full
runtime configuration without leaving the workflow context.

The design separates two execution targets because they have different safety
and durability contracts:

1. **Current draft test**
   - Executes the exact in-memory canvas manifest, including unsaved edits.
   - Is bounded by event, depth, and agent-run budgets.
   - Simulates durable waits and delays.
   - Defaults to test-approved tools and requires explicit confirmation before
     tools with live effects can run.
   - Returns a complete request-scoped evidence report with agent inputs,
     action results, branches, emitted events, outputs, model selection, token
     counts, timings, and failures.
2. **Published live run**
   - Reads entry points from the immutable live workflow version.
   - Publishes through the existing event-ingest and Inngest durability path.
   - Tracks the exact seed event through the event/run causality graph.
   - Links every durable run to the existing Runs investigation surface.

This split prevents an unpublished canvas from being mistaken for production
and avoids weakening the existing Inngest replay and persistence guarantees.

## Run Console

The Run button opens a full operational workbench rather than a consumer-style
confirmation dialog.

### Setup

- Execution target: current draft test or published live version.
- Entry event: every declared trigger is available; externally reachable
  triggers are recommended and internal events are marked advanced.
- Subject/correlation key.
- Typed input controls generated from the listening agents' input ports.
- Raw event payload editor for trigger bindings and uncommon schemas.
- Draft-test policies:
  - safe/test-approved, read-only, or live tool effects;
  - continue independent branches or fail fast;
  - simulated human decision;
  - maximum agent runs, events, and graph depth.
- A destructive-effects acknowledgement is mandatory for live tool effects.

### Evidence

- Run summary and deterministic status.
- Per-agent timeline with triggering event, validated inputs, every action,
  branch decision, output, errors, provider/model, tokens, and duration.
- Event ledger showing fan-out, depth, source agent, consumers, and terminal
  events.
- Terminal outputs.
- Raw report copy/export.
- For live runs, exact event-to-run causality and links to durable run records.

## Test harness architecture

The API test runner reuses the production runtime primitives:

- `prepareAgentExecution` for trigger binding, defaults, input validation, and
  prompt compilation.
- `runAction` for logic, tool, condition, delay, and subflow behavior.
- `buildManualTaskResolution` for deterministic human-step simulation.
- `finalizeAgentExecution` for output validation and event binding.

The harness owns only orchestration around those primitives:

1. Normalize and validate the supplied manifest.
2. Seed a bounded FIFO event queue.
3. Execute every listener for each event in stable manifest order.
4. Follow forward-only action branches.
5. Enqueue resolved emissions.
6. Stop at explicit budgets and report partial evidence rather than looping.

Draft tests do not create production `runs` rows. Their report is intentionally
request-scoped. Published runs continue to use the durable event/Inngest path.

## Prompt generation

Prompt generation is proposal-based:

1. The current complete agent definition and current ontology instructions are
   redacted for likely secrets.
2. The selected provider/model generates a comprehensive system prompt while
   preserving safety, privacy, output, tool, and human-review constraints.
3. The editor shows the proposal separately.
4. The operator may edit, apply, or discard it.
5. Apply updates `ontology_instructions` and records prompt provenance.

An asynchronous response is never applied automatically, and a proposal is
marked stale if the source instructions changed while generation was running.

## Complete agent settings

Guided mode exposes the frequently operated controls, including catalog-backed
provider/model selection, reasoning, verbosity, storage, retries, timeout,
concurrency, tool-loop limits, schedules, and observability. Complete JSON
remains the lossless editor for every canonical and extension field. Both views
write the same in-memory definition and are validated by the shared contract.

## Acceptance criteria

- A current multi-agent draft can be run without saving or publishing.
- A published workflow can be started through the durable event path.
- Required typed inputs block submission until supplied.
- Unsafe tool execution is denied by default.
- Cycles and excessive fan-out terminate at authored test budgets.
- Results identify every agent/action and include output and failure evidence.
- Generated prompts require an explicit Apply action.
- Provider and model are selectable from the supported provider catalog and
  discovered model list, with a custom model-ID escape hatch.
- Complete JSON can still edit and preserve every additive definition field.
- API, web, unit, integration, typecheck, and production build gates pass.
