# Workflow authoring

The Workflows page is the tenant's authoring workspace. A tenant can keep
multiple named workflow drafts, while one workflow version is live at a time.
Creating or saving a draft never changes live runs. Publishing is always a
separate, explicit action.

## Create a workflow

Open **Workflows → New workflow** and choose one of these sources:

- **Generate with AI** — describe the business purpose, optionally select a
  tenant process-document folder and public-web research, then review the
  proposed agents, prompts, tools, model, assumptions, risks, and validation.
- **Blank canvas** — start from one runnable starter agent.
- **Template** — choose a maintained, server-validated pattern such as Hello
  World, support triage, scheduled reporting, document approval, webhook
  summarization, or data enrichment.
- **Existing workflow** — clone the latest immutable version of another
  workflow in the same tenant. The source is not changed.
- **Import manifest** — upload or paste JSON, or fetch an HTTPS JSON document,
  then validate, diff, resolve conflicts, preview, and create an editable
  draft. This creation path never replaces the live workflow.

Enter a display name and lowercase kebab-case workflow ID. The model picker is
initialized from the tenant's configured model fleet. Every successful path
creates a server-backed draft and opens it on the canvas; publishing is always
a separate canvas action.

## Generate from a purpose or documents

A useful purpose states the outcome, trigger, decisions, approvals, systems,
constraints, and expected deliverables. For example:

> When a priority support ticket arrives, classify its topic and urgency,
> retrieve only approved account context, draft a response, and require an
> operator decision before sending anything to the customer.

Process documents are read only from the tenant namespace beneath
`AGENTIC_WORKFLOW_DOCUMENTS_DIR`. When that variable is omitted, the root is
`$AGENTIC_DATA_ROOT/workflow-documents`. Put tenant files under:

```text
data/workflow-documents/<tenant-slug>/<folder>/
```

The folder picker sends a relative folder name, never an arbitrary host path.
Text, Markdown, JSON, YAML, CSV, HTML, and XML are supported directly. PDF
requires `pdftotext`; DOCX requires `unzip`. Extraction is bounded and reports
included, skipped, truncated, and failed files in the generation result.

Document and research content is treated as untrusted evidence. It cannot
override the generator's schema, tenant-isolation, tool, or safety rules.

Public-web research is optional and runs only when a supported provider has a
credential. Select the provider with `AGENTIC_WORKFLOW_RESEARCH_PROVIDER`
(`tavily`, `brave`, or `serper`) and configure either a shared key or a
tenant-specific key:

```text
TAVILY_API_KEY / BRAVE_API_KEY / SERPER_API_KEY
AGENTIC_TENANT_<TENANT_SLUG>_TAVILY_API_KEY
AGENTIC_TENANT_<TENANT_SLUG>_BRAVE_API_KEY
AGENTIC_TENANT_<TENANT_SLUG>_SERPER_API_KEY
```

For tenant-specific variables, uppercase the slug and replace non-alphanumeric
characters with underscores. Tenant credentials take precedence. If research
is requested without a configured credential, generation continues with a
visible diagnostic and does not invent citations.

Persisted tool credentials must be references, never literal values. An
environment reference must belong to the tenant—for example
`TENANT_RAAS_VENDOR_KEY` for tenant `raas`. Named vault/secret references must begin
with a tenant namespace such as `raas/` or `tenant/raas/`. Operators can expose
an exact shared reference with `AGENTIC_WORKFLOW_SHARED_ENV_ALLOWLIST`.
Credentialed custom endpoints also require explicit operator approval through
`AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST`; generic `http.fetch` configurations
must use an approved HTTPS `base_url` and pin `allow_host` to that exact host.
Custom RoboHire/GoHire endpoints require a populated tenant-owned
`api_key_env`; a missing value fails instead of falling back to a shared key.

Generation returns a preview; it does not save or publish. Every automated
agent prompt is scored for role, mission, inputs, procedure, tool policy,
output contract, completion criteria, privacy/safety, non-fabrication, error
recovery, and human escalation. Review warnings and assumptions, then select
**Create draft** to persist the proposal.

## Edit on the canvas

Choose a workflow from the selector, then select **Edit workflow**.

- Add an automated node or human approval task from the draft palette.
- Choose Connect, then select a source and destination node. The editor adds a
  matching emitted event and trigger.
- Drag nodes to persist canvas positions in
  `extensions.canvas.position`.
- Use Auto-layout to arrange the graph, and Fit to bring authored nodes into
  view.
- Large workflows expand the scrollable canvas automatically; the editor is
  tested through the 100-agent authoring limit.
- Select a node to edit its identity, stage, description, trigger and emitted
  events, system and user prompts, actions, tools, provider/model,
  temperature, token limit, retries, timeout, and concurrency settings.
- Remove a node from its inspector. Event references are visible for manual
  cleanup before validation.

The canvas patches the complete manifest definition. Fields that are not shown
in a compact inspector—including typed I/O and tenant extensions—are preserved
through a read/edit/save round trip. If a complete definition was not loaded,
the editor refuses to save instead of reconstructing a lossy placeholder.

Browser storage provides crash recovery per tenant and workflow. The latest
server draft remains the shared source of truth.

## Resolve generated human tasks

A published Human node creates a tenant-scoped task with the preceding step's
decision context, assigned role, and authored JSON Schema form. Open **Human
tasks**, review the context, complete the generated fields, then choose
**Approve**, **Reject**, or **Request supplement** when that option is declared.
The portal validates required and typed fields, and the API validates the same
form again before emitting `task.resolved`.

Every outcome becomes one canonical resolution envelope containing the task
id, decision, outcome, and submitted form payload. Rejection is a valid domain
outcome rather than a runtime failure, so the workflow can persist its artifact
and emit its authored resolution event consistently.

## Save, validate, and publish

These actions have different effects:

1. **Save draft** creates a new immutable draft version. It uses the version
   originally loaded by the editor as an optimistic-concurrency guard; a stale
   editor receives a conflict instead of overwriting newer work.
2. **Validate** checks the current canvas manifest without publishing. It runs
   canonical schema parsing, graph/runtime lint, tool/model checks, secret
   checks, and prompt-quality scoring.
3. **Publish** validates and promotes the selected saved version through the
   atomic manifest-commit path. New runs use it after the runtime hot reload;
   active runs remain pinned to the version on which they started.

There is no isolated staging runtime in this release, so the UI does not claim
that a saved draft has been deployed to staging. Keep non-live drafts for
review and publish only after validation.

Live workflows cannot be deleted. Publish another workflow first, or retain
the live workflow for rollback and audit history.

## Tenant API tokens

Open **Settings → API tokens** to create a workspace bearer token. The
plaintext appears only once. Copy it into a secrets manager and acknowledge
secure storage before closing the reveal dialog. The server stores only its
SHA-256 hash.

Use the token as an HTTP bearer credential:

```bash
export AGENTIC_API_TOKEN='ao_live_...'

curl http://localhost:3501/v1/agents \
  -H "Authorization: Bearer $AGENTIC_API_TOKEN"

curl http://localhost:3501/v1/events \
  -H "Authorization: Bearer $AGENTIC_API_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"name":"HELLO_WORLD","subject":"example-1","data":{"prompt":"Hello"}}'
```

This release issues the accurately enforced `workspace:all` scope. Rotate a
token to invalidate its existing secret and receive a new one, or revoke it to
stop authentication immediately. Create, rotate, and revoke operations are
written to the audit log without plaintext or hashes.

## Authoring API

The portal uses the same tenant-authenticated endpoints available to API
clients:

```text
GET    /v1/workflow-templates
GET    /v1/workflows
POST   /v1/workflows
GET    /v1/workflows/:slug
PUT    /v1/workflows/:slug
DELETE /v1/workflows/:slug
POST   /v1/workflows/:slug/validate
POST   /v1/workflows/:slug/publish
POST   /v1/workflows/generate
GET    /v1/workflow-document-folders
GET    /v1/workflows/dag?workflow=:slug
```

All tenant identity comes from the authenticated session or bearer token. A
request cannot select another tenant by putting a tenant ID in its body.
