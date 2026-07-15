# New Workflow authoring and generation

**Status:** Approved for implementation
**Date:** 2026-07-16
**Owners:** Product, Design, AI Architecture, Runtime, API, Web, Security, QA

## 1. Outcome

An operator can create a complete, editable workflow in minutes from a purpose,
tenant-owned process documents, a maintained template, a blank Hello World
starter, an existing workflow version, or an imported manifest. Creation always
produces a draft. Validation is explicit. Only a separate publish action can
replace the tenant's live workflow.

The generator is an authoring assistant, not an authority. It proposes agents,
events, actions, tools, models, parameters, and detailed prompts; the operator
can inspect and change every generated value before publication.

## 2. Users and jobs

- A business operator describes an outcome without knowing the manifest schema.
- A process owner points the generator at approved operating procedures and
  receives a traceable workflow proposal.
- An agent architect reviews prompts, actions, model choices, tools, limits, and
  event contracts before publishing.
- A developer starts from Hello World, a template, a clone, or raw JSON.
- A tenant administrator issues a bearer API token for programmatic calls.

## 3. Creation paths

### Generate with AI

Required input is a purpose of 20–12,000 characters. Optional inputs are a
tenant document folder, web research, a preferred provider/model, constraints,
and expected outputs. Generation returns a preview and never persists or
publishes by itself.

The preview must include:

- a concise workflow summary and design rationale;
- ordered agents and human tasks;
- triggers and emitted events with a connected graph;
- actions and permitted tools per agent;
- selected provider/model and conservative runtime limits;
- a complete system prompt for every automated agent;
- assumptions, risks, research sources, and document sources;
- structural validation results.

Prompt quality is measured by a rubric, not the subjective word “perfect.” Every
automated agent prompt must state its role, mission, inputs, procedure, tool
policy, output contract, completion criteria, safety/tenant/privacy rules,
non-fabrication policy, error recovery, and human-escalation conditions.

### Generate from documents

Folders are tenant-scoped under the configured workflow-document root. The web
client selects a relative folder; it never submits an arbitrary server path.
Supported sources are UTF-8 text/Markdown/JSON/YAML/CSV/HTML/XML and, when the
host extractors are installed, PDF and DOCX. Extraction reports every included,
skipped, truncated, or failed file. Document content is untrusted evidence and
cannot override generator instructions.

The same AI generation, prompt rubric, validation, preview, and draft-creation
flow is used after extraction. There is no separate low-quality document path.

### Blank and Hello World

- **Blank canvas** creates one safe starter agent with an editable trigger.
- **Hello World** creates a runnable one-agent example with a useful prompt,
  typed input/output, one logic action, and a completion event.

Both are ordinary full-fidelity manifests after creation.

### Template

Templates come from an API-owned versioned catalog. The UI never invents counts
or manifests. Initial templates are Hello World, webhook summarizer, scheduled
report, support triage, document approval, and data enrichment. Counts are
derived from the manifest. Instantiation deep-copies the selected template and
applies the tenant's selected/default model without mutating the catalog.

### Existing workflow

The user selects an immutable source workflow version in the same tenant. Clone
preserves prompts, actions, tools, typed I/O, model controls, unknown extensions,
and external actions JSON. It creates new workflow/version identities and a
draft; it never changes or deploys the source.

### Import manifest

Upload, paste, and HTTPS URL sources use the existing validate/diff/resolve/
preview/publish pipeline. Unsupported repository integration must be visibly
disabled rather than represented by fake connected repositories. Closing a
validated import releases its pending lock.

## 4. Workflow management

A tenant can own multiple workflows but has at most one live workflow deployment.
The Workflows surface provides a workflow selector, name/status/version metadata,
create, clone, edit, validate, publish, and delete for non-live workflows.

Lifecycle:

1. **Draft** — server-persisted immutable revision; safe to edit.
2. **Validated** — the current draft passed schema and semantic checks.
3. **Live** — explicitly published through the atomic manifest commit path.
4. **Superseded** — a prior live deployment retained for rollback/audit.

The current database/runtime does not provide an isolated staging execution
lane. The product therefore does not claim that a draft is “deployed to
staging.” A real staging lane requires a separate runtime environment and is
outside this release.

## 5. Canvas requirements

- Load and save the complete canonical agent definition; a no-op round trip is
  semantically identical.
- Add automated agents and valid human tasks.
- Move nodes and persist positions in manifest extensions.
- Connect nodes by creating a named emitted-event/trigger pair; disconnect by
  editing either side.
- Edit identity, description, stage, triggers, emitted events, system/user
  prompts, actions, tools, model/provider, temperature, token/retry/timeout/
  concurrency controls, and preserved extensions.
- Open the full Agent Studio for typed I/O, test runs, artifacts, and version
  history without creating a second definition.
- Auto-layout, zoom-to-fit, keyboard selection, visible focus, empty/loading/
  error states, and a usable responsive inspector.
- Save a server draft, validate it, and publish it as distinct operations.
- Reject stale saves with an optimistic-concurrency conflict rather than
  silently overwriting a newer revision.

## 6. Tenant API tokens

Tenant administrators can list, create, rotate, and revoke workspace bearer
tokens. Plaintext is returned once on create/rotate, only a SHA-256 hash is
stored, and list responses never expose plaintext or hashes. This release
issues the existing `workspace:all` scope; narrower scopes must not be shown as
enforced until route-level authorization exists. Every mutation is audited
without secret material.

## 7. Non-functional requirements

- Tenant isolation on every read and mutation.
- No arbitrary filesystem paths, symlink escapes, embedded credentials, or
  cross-tenant document access.
- Bounded purpose/document/research sizes and LLM timeouts.
- Generator output parsed through the canonical manifest schema and semantic
  linter; unknown tools/models are rejected or removed with an explicit issue.
- Generated canonical manifests must bind their declared ports end-to-end,
  inherit the selected model at every action, and preserve safe alias config,
  prompts, mappings, and catalog argument schemas.
- All workflow write surfaces enforce workspace-writer authorization plus the
  same tenant-secret and endpoint policy; network tools fail closed on missing
  credential bindings and SSRF-relevant destination changes.
- Audit generation, draft creation, validation, publish, delete, and token
  mutations.
- Provider failures retain user input and never create a partial workflow.
- 100-node workflows remain usable; generation is capped to a documented
  maximum unless explicitly overridden in a later release.

## 8. Acceptance criteria

1. Every creation path creates a reloadable server draft and nothing live.
2. Purpose-only and document-assisted generation return an editable, validated
   full manifest with rubric-complete prompts for all automated agents.
3. Hello World publishes and completes against the mock provider.
4. Clone passes a full-fidelity semantic equality test apart from lineage and
   workflow/version identity.
5. A title-only canvas edit preserves prompts, actions, tools, models, I/O,
   runtime parameters, and unknown extensions byte-for-byte semantically.
6. Save, Validate, and Publish have separate controls and observable results.
7. Publication never rolls back a live `tenant_code` deployment and hot-loads
   through the authoritative manifest commit service.
8. Created API tokens authenticate an actual `/v1` call; revoked tokens do not.
9. Targeted tests, full test suites, lint, typecheck, and build run under Node
   26.5.0 before completion.
