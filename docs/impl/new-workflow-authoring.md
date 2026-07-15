# New Workflow implementation plan and verification

**Date:** 2026-07-16
**Source:** `docs/prd/new-workflow-authoring.md` and
`docs/design/new-workflow-architecture.md`

## Task breakdown

### A. Contracts and persistence

- Add shared schemas for workflow summaries/details, templates, create/save,
  validation, generation, document folders, and API tokens.
- Add list/detail/create/save/delete services over workflows and immutable
  workflow versions with optimistic concurrency.
- Parameterize DAG reads by workflow and return complete definitions.

### B. Templates, clone, and blank

- Implement and startup-validate six API-owned templates.
- Create blank/Hello World with selected model/runtime defaults.
- Clone an explicitly selected latest/version snapshot, preserving all fields.

### C. Generator and documents

- Implement tenant-rooted folder listing/extraction with limits/diagnostics.
- Implement deterministic mock blueprint and real structured LLM generation.
- Normalize registered tools/models, validate, lint, and score prompts.
- Compile catalog-backed tool schemas, safe per-tenant config references,
  direct-tool argument/result mappings, and runnable inter-agent bindings.
- Return sources, assumptions, warnings, and a draft-ready manifest.

### D. Safe publication

- Give manifest commit an explicit workflow slug/name.
- Load the actual tenant live workflow for diff/lint.
- Supersede only live workflow deployments.
- Publish selected draft revision through commit and hot reload.

### E. Web creation and management

- Replace the no-op modal with Generate, Blank, Template, Clone, and Import
  paths, live tenant/model/template/workflow data, progress, preview, and errors.
- Add workflow selector/status/delete and select a newly created draft.
- Keep import as the existing advanced wizard and remove fake repository data.

### F. Canvas

- Preserve complete definitions in draft helpers.
- Add/edit/remove agents and human tasks, connect/disconnect events, move/persist
  positions, auto-layout/fit, and expanded prompt/action/model/runtime editor.
- Wire Save draft, Validate, and Publish separately.

### G. API tokens

- Implement list/create/rotate/revoke API and audit.
- Wire Settings UI with one-time secret copy and destructive confirmations.

### H. Human-task execution

- Persist generated form schema, prepared context, and assigned role on the
  durable task.
- Render common JSON Schema fields in the Tasks portal and wire all declared
  decisions to the real resolve mutation.
- Validate submitted task payloads at the API boundary.
- Normalize approve/reject/supplement into a strict shared runtime output so
  final validation, artifacts, and emitted events use one shape.

### I. Import corrections and documentation

- Cancel pending validation lock when abandoning the import.
- Preview the imported manifest, not the live DAG; derive diff labels/counts.
- Update user guide and API examples.

## Test cases

### Workflow service/API

- Tenant-scoped list and detail; another tenant cannot read by slug.
- Create every source type; duplicate/invalid slug returns 409/400.
- Creation never inserts a live deployment.
- Clone preserves a full-fidelity v2 fixture semantically.
- Save preserves every unedited nested field and rejects stale base version.
- Delete succeeds for draft and refuses the live workflow.
- Validation catches schema errors, duplicate ids, graph issues, unknown tools,
  invalid concurrency, and unconfigured models.
- Publish writes a versioned file, hot-loads, supersedes only workflow lane, and
  retains simultaneous live tenant-code deployment.

### Generator/documents

- Empty/short/oversize purpose.
- Deterministic mock generation produces connected, schema-valid agents and
  rubric-complete unique prompts.
- Real-model valid JSON, fenced JSON, invalid JSON, bounded repair, timeout,
  authentication, and rate-limit errors.
- Empty folder, supported text, PDF/DOCX extractor unavailable, corrupt file,
  partial extraction, per-file/total limit, traversal, symlink, and cross-tenant
  attempts.
- Prompt-injection text remains quoted source data.
- Unknown model/tool in LLM output is rejected or normalized with an issue.
- Scheduled agents and every generated/template edge bind and validate the next
  agent's exact v2 inputs; direct tool config/mappings round-trip.
- Literal credentials and malformed secret references are rejected before any
  immutable draft/import row is written.
- Cross-tenant environment/named-secret references and unsafe credentialed
  endpoint overrides are rejected at create, save, and import boundaries.
- Compatibility live-write routes require workspace-writer access and run the
  same policy before any file, row, listener, deployment, or audit mutation.
- Explicit provider credential bindings fail closed when missing; custom
  provider hosts cannot inherit integration/global keys. `http.fetch` rejects
  missing host pins, absolute call overrides, private/link-local destinations,
  DNS changes, and unsafe redirects.
- Canonical generator output is regression-tested with custom input/output
  ports, alias configuration merging, full catalog argument schemas, preserved
  prompts/mappings, selected model controls, and real runtime binding/emission.
- New Workflow import validation creates no pending deployment; its normalized
  result is persisted only as an immutable editable draft.
- Generated Human definitions strictly validate approve, reject, and supplement
  through the same canonical resolution envelope and emit every authored event.
- Task resolution rejects form-schema violations before dispatch and persists
  the authored awaiting role and prepared decision context.

### Canvas/web

- Full-fidelity no-op and title-only round trips.
- Add/remove/restore automated and human nodes.
- Connect creates matching emit/trigger and deduplicates; disconnect persists.
- Move and auto-layout serialize positions.
- Dynamic bounds contain 100-agent vertical and chained layouts while retaining
  the hand-tuned RAAS minimum; hostile/non-finite coordinates are capped.
- Save/validate/publish call distinct endpoints and retain input on error.
- Generated preview can be edited before and after creating the draft.
- Changing any generation input invalidates the preview; full evidence,
  diagnostics, assumptions, prompts, actions, tools, events, and validation are
  reviewable before draft creation.
- Invalid typed I/O, action/tool JSON, or numeric values block every persistence
  and publication operation; restored drafts retain their original base id.
- Template counts match manifests; clone source/version is visible.
- Generated task forms render string, enum, boolean, numeric, object, and array
  fields; required/type errors block submission and decisions call the real
  resolve mutation.
- Keyboard focus/selection, responsive layout, loading/empty/error states.

### API tokens

- List never contains hash/plaintext.
- Create returns high-entropy plaintext once; DB stores matching hash only.
- Created bearer authenticates a real API request and updates last-used time.
- Rotate invalidates old token and returns one new plaintext value.
- Revoke invalidates immediately; cross-tenant ids return 404.
- Audit rows contain action/id/name but no token/hash.
- UI covers empty/loading/error, copy acknowledgement, rotate, and revoke.

## Required commands

Run with `source /Users/kenny/.nvm/nvm.sh && nvm use 26.5.0`:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @agentic/web exec vitest run
pnpm --filter @agentic/web exec playwright test
```

Targeted suites must run first for quick feedback, but completion requires the
full commands. Any unrelated pre-existing failure must be identified with a
baseline comparison; failures caused or exposed by this work are fixed before
commit.

## Definition of done

- Product, architecture, design-review, and test decisions are reflected in
  code and docs.
- All seven requested capabilities have working UI/API paths.
- No no-op or destructive placeholder remains in a visible creation/editor
  control.
- Actual test/build output is recorded in the final handoff.
- Only scoped files/hunks are staged in the dirty worktree, then committed and
  pushed to the current branch.
