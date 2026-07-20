# LLM model governance and usage billing

Status: implemented foundation, with the limitations below

Policy date: 2026-07-18

## Decision summary

The platform keeps one complete provider/model catalog for capability lookup,
historical cost explanation, and replay, while exposing a filtered view for new
model selection. A model becoming ineligible does not delete its historical
record. Managed task routing skips it, explicit/raw gateway use rejects it,
settings updates cannot save it, and catalog-derived defaults exclude it.
Existing model-fleet inventory rows remain visible for historical evaluation,
but the fleet is not a runtime dispatcher.

Every provider attempt is recorded in `llm_calls`. Its terminal accounting fact
is also written to the versioned `usage_events` ledger and exported as private,
deterministically named NDJSON. SQLite remains the source of truth; the file is
a portable billing/reconciliation feed, not a second mutable ledger.

## Model lifecycle policy

### Exact rolling window

At evaluation time `T`:

1. Normalize `T` to the start of its UTC calendar day.
2. Compute `cutoff = UTC-day(T) - 365 calendar days`.
3. A model dated exactly on `cutoff` is current for the entire boundary day.
4. A model with usable age evidence before `cutoff` is `legacy` and is not
   selectable for new configuration.
5. `restricted`, reached `deprecatedAt`, reached `sunsetAt`, and reached
   `expiresAt` override the age result and make a model non-selectable.

For example, as of any time on 2026-07-18, 2025-07-18 is current and
2025-07-17 is legacy. This rule is centralized in `catalogModelPolicy`; callers
must not reproduce it with elapsed milliseconds or a hard-coded date.

Retired records remain in `PROVIDER_MODEL_CATALOG`. Keeping them is necessary
to resolve saved agent/fleet configuration, explain historical usage against
the correct provider/model, retain dated pricing schedules, and replay old
runs. `selectableModelsForProvider` is the view for new selection. Existing
fleet inventory rows are intentionally retained rather than silently mutated;
they cannot make a retired model executable through managed routing.

### Date provenance

Lifecycle dates have three distinct meanings:

- `releaseDate` is the upstream release date. `releaseDateSource` and
  `releaseDateConfidence` (`verified`, `corroborated`, or `unverified`) retain
  its provenance.
- `providerCatalogCreatedAt` is when a provider or gateway catalog listed the
  model. It is never relabeled as an upstream release date. An old catalog
  timestamp is conservative proof that the model is outside the window; a
  recent timestamp proves availability, not model recency, so the result stays
  `unverified`.
- A model with no usable date evidence is `unverified`. It remains selectable
  but is visibly marked for operator review. This avoids breaking provider-only
  or newly discovered IDs on the basis of missing metadata.

Live discovery preserves provider catalog timestamps and advertised expiry.
The lifecycle fields remain separate when the live row is merged with curated
catalog data.

### Quality and free groupings

The comparison groups are `Top-Tier`, `Mid-Tier`, `Low-Tier`, and `Free-Tier`.
Top/mid/low are curated product groupings for evaluation and routing; they are
not a universal benchmark score. Free is stricter: a model qualifies only when
it has an explicit free tier and both input and output prices are zero. Trial
credits, consumer subscriptions, and temporary account promotions are not
free-model evidence.

OpenRouter free inventory is dynamic. The live `/models` response is the
availability authority for newly discovered rows, including zero prices,
catalog creation time, and `expiration_date`. `openrouter/free` is the stable
free-router choice; individual `:free` routes may appear, disappear, or expire.
The UI therefore groups current zero-price rows for convenience but does not
promise that a specific free route is durable. An advertised expiry makes a
row non-selectable as soon as it is reached.

### Pricing provenance

The checked-in `CatalogModel` record is the canonical fallback rate card for a
provider/model pair. It stores:

- official `priceSource` and snapshot `priceAsOf`;
- one or more `pricing` windows with optional `effectiveFrom`/`effectiveTo`;
- input, cached-input, cache-write, and output USD per million tokens;
- optional long-context thresholds and alternate rates.

Cost resolution prefers a valid provider-reported request cost. Otherwise it
uses authoritative normalized token usage and the active dated catalog price.
An unknown model, missing price window, or unavailable authoritative usage is
`unpriced`; it is never guessed to be free. Exact results are stored in USD
nanodollars so repeated sub-cent calls do not disappear through rounding. Each
call retains `costSource`, `priceSource`, and `priceAsOf` for later explanation.
Live prices are useful discovery/display data, but they do not become a
historical rate card until curated or reported by the provider for the call.

## Usage and billing flow

1. Authentication establishes tenant/account, user or API-token principal,
   and caller credential identity. Safe frontend headers may add a product
   surface, stable action code, and interaction ID; they cannot override the
   billed account or authenticated principal.
2. The API installs those dimensions in async request context. Long-lived runs
   copy request, interaction, surface, and action IDs onto the run so work that
   continues outside the HTTP stack keeps its origin.
3. The gateway merges tenant defaults, explicit trusted call attribution, and
   authenticated request context. In production it requires a tenant identity
   before provider dispatch when usage attribution is enabled.
4. A stable routing gateway selects a credential-bound concrete gateway by
   `tenantId`. Tenant credentials override workspace credentials, which
   override environment credentials. Each provider attempt resolves and
   records the public-safe ID of the exact provider credential it will use.
5. Before each provider attempt, the gateway inserts an `llm_calls` row with a
   logical-call ID, attempt number, provider/model, reasoning controls, and all
   available dimensions. Retries and failovers are separate attempt rows under
   one logical call.
6. Success normalizes input, output, cache-read, cache-write, reasoning, and
   audio token counters. In one SQLite transaction it finalizes `llm_calls`,
   appends one `llm.attempt` usage event, and charges the actual monthly budget.
   Failure transactionally finalizes the attempt and appends an event with
   unknown cost liability; it does not charge a successful-usage budget.
7. After the database commit, pending events for the tenant are exported. An
   export failure cannot erase the committed fact; it remains pending for a
   later export attempt.

`llm_calls` is the detailed provider-attempt projection used for operational
inspection and aggregation. `usage_events` is the normalized, versioned feed
for billing and future usage types. Its accounting fields are append-only; the
delivery marker `exported_at` is the only field updated by the exporter. The
schema already reserves event types for API calls, tool calls, and product
interactions, although only `llm.attempt` has a production emitter today.
`GET /v1/usage` aggregates successful usage and all provider attempts across
account, provider/model, task, gateway, route, actor, product, function, API
call, reasoning configuration, routing profile, agent, and day. It exposes
logical calls, attempts, failures, timeouts, retries, fallbacks, unpriced
calls, and p50/p95 latency. The detailed `/v1/usage/calls` reconciliation
surface is tenant-admin-only.

### Attribution dimensions

The ledger can answer usage by:

- tenant and billing account;
- actor type (`user`, `api_token`, `system`), actor ID, and caller credential
  ID;
- provider account and provider credential ID;
- request, correlation, interaction, run, and step IDs;
- product, surface, action, function name, API route/method, and invocation
  source;
- logical call, provider attempt, requested/response model, and provider
  request ID.

The current account default is the authenticated tenant. Stable provider-key
records have public-safe credential IDs, but the secret value is never an
accounting dimension.

### Privacy boundary

Attribution accepts bounded identifiers and stable operation codes, not an
open metadata object. Values are trimmed, control characters are removed, and
identifier syntax/length is constrained. Client-supplied account and principal
claims are ignored in favor of server authentication.

The `agentic.usage.v1` export contains IDs, normalized counters, model/provider
metadata, error codes, and cost components. It intentionally excludes prompts,
model output, raw provider usage, raw error messages, HTTP headers, API keys,
and reasoning content. Directories are created with mode `0700`; files use
`0600`.

The operational `llm_calls` projection follows the same privacy boundary. It
stores only allow-listed normalized usage counters and safe categorical error
data; arbitrary provider usage objects and raw provider error prose are not
persisted. Database access and retention must still be governed as financial
and operational records.

Files are grouped by tenant and UTC occurrence day and named from their first
and last monotonically increasing ledger sequence:

```text
<root>/<tenant>/<YYYY-MM-DD>/<first-sequence>-<last-sequence>.ndjson
```

Writes use a temporary file, `fsync`, and atomic rename. Repeating an export
for an existing sequence range succeeds only when its bytes match, making
crash recovery deterministic and collision-visible.

## Provider cost, customer charge, and budgets

`provider_cost_usd_nanos` is the provider-reported cost when available or the
dated catalog estimate identified by `costSource`. `costLiability` distinguishes
`known`, `unpriced`, and `unknown` facts.

The v1 customer charge is deliberately pass-through:

```text
billable_charge_usd_nanos = provider_cost_usd_nanos
rate_card_version = pass-through-v1
```

There is no hidden markup, discount, tax, minimum charge, or currency
conversion. Keeping provider cost and billable charge as separate columns
allows a later versioned customer rate card without rewriting provider facts.

Budgets are tenant-scoped UTC calendar-month counters. At preflight, spend, or
budget read, a stale `period_start` is advanced to the first day of the current
UTC month and token/nanodollar/cents projections are reset. Successful attempt
finalization, usage-event append, and actual budget increment share one SQLite
transaction. Unpriced successful calls increment authoritative tokens but not
USD. The preflight is intentionally not a reservation, which is a known
concurrency limitation below.

## Operations and migration

Apply `packages/db/drizzle/0020_usage_attribution_events.sql` with:

```bash
pnpm db:migrate
```

The migration adds run and call attribution columns and indexes, backfills safe
defaults on existing `llm_calls`, and creates `usage_events`. It does not invent
canonical usage events for pre-migration calls.

Relevant environment variables:

- `LLM_REQUIRE_USAGE_ATTRIBUTION`: requires `tenantId` before a provider call;
  defaults to enabled in production and disabled outside production unless
  explicitly set.
- `AGENTIC_USAGE_EXPORT_ROOT`: private export root. When unset, the exporter
  uses `<AGENTIC_DATA_ROOT>/usage`; otherwise it discovers the pnpm workspace
  and uses `<workspace>/data/usage` (falling back to `<cwd>/data/usage`).
- `LLM_USAGE_EXPORT_REQUIRED`: when `true`, an export error is returned as an
  accounting error after the durable database transaction. When `false`, it is
  logged and the event remains pending.
- `AGENTIC_KEY_VAULT_SECRET`: required in production to protect persisted
  provider credentials; exports contain only credential IDs.
- `LLM_GATEWAY_ALLOWED_HOSTS`: comma-separated `host[:port]` exceptions for
  explicitly trusted NewAPI/compatible endpoints that do not resolve to a
  public address. Keep this list as narrow as possible.
- `LLM_ALLOW_INSECURE_GATEWAYS`: permits HTTP gateway URLs when `true`. This is
  an explicit risk acceptance for a trusted private network; production
  deployments should use HTTPS whenever possible.

Runtime-data wiping includes `usage_events` and `llm_calls` and resets budget
usage counters. Operators must archive required billing exports before using a
runtime wipe in an environment with financial retention obligations.

## Verification strategy

Automated coverage should keep these invariants executable:

- lifecycle boundary-day behavior, timestamp provenance, unknown dates,
  restrictions, expiry, retired-row retention, and selectable defaults;
- genuine zero-price grouping and live OpenRouter creation/expiry parsing;
- fleet admission rejects a non-selectable model without invalidating existing
  fleet rows;
- provider-reported, catalog-priced, long-context, cached/write, and unpriced
  cost paths;
- every retry/failover becomes one attempt and one terminal usage event, while
  only successful authoritative usage charges the budget;
- account, principal, credential, request, product, function, and API
  dimensions survive through the ledger and export;
- UTC month rollover and atomic success accounting;
- deterministic NDJSON schema, permissions, sequence ordering, retry behavior,
  and absence of prompts, output, raw errors, and raw provider fields.

Production readiness also requires migration rehearsal on a copy of the
largest database, forced export-failure recovery, process-loss tests between
provider response and finalization, and reconciliation against real provider
invoices.

## Remaining limitations

1. **Provider account reconciliation:** tenant-aware provider routing and
   provider-credential IDs are implemented, including per-attempt failover
   attribution. The upstream provider organization/project/account ID is not
   automatically discoverable from most API keys, so `providerAccountId`
   remains optional until administrators configure or an invoice importer
   reconciles that metadata.
2. **Budget reservations and concurrency:** preflight checks current totals and
   charges actual usage after success. Concurrent calls can collectively cross
   a cap. Add transactional reservations with expiry/release semantics before
   treating the cap as a strict real-time authorization boundary.
3. **Fleet enforcement:** fleet roles and `dailyCapUsd` are stored and displayed,
   but the gateway does not yet derive its provider cascade from the tenant
   fleet or enforce daily model caps.
4. **Non-LLM metering:** `usage_events` defines API, tool, and product event
   types, but generic emitters are not implemented. Current product-click IDs
   correlate a click/request to a resulting LLM attempt; they are not a
   complete clickstream or standalone API-call billing feed.
5. **Invoice reconciliation and rate cards:** there is no provider-invoice
   importer, FX/tax treatment, customer pricing engine, or reconciliation state
   machine. Provider-reported/catalog cost can differ from a later invoice.
   Dynamic live model prices are not versioned rate cards by themselves.
6. **Crash and historical reconciliation:** a process loss can leave a
   `started` call without a terminal event, and migration does not backfill old
   calls into `usage_events`. A reconciler must classify abandoned attempts and
   import authoritative provider outcomes without double charging.
7. **Export operations:** export retry is opportunistic on later tenant usage;
   there is no dedicated background sweeper, object-store sink, retention
   policy, signing, or delivery manifest yet.
