/**
 * Drizzle schema for Agentic Operator.
 *
 * Conventions:
 *   - Primary keys are prefixed string IDs (run-, evt-, agt-, …) generated
 *     via @agentic/shared makeId().
 *   - Timestamps are unix-epoch milliseconds (integer mode timestamp_ms).
 *   - Payload/manifest blobs are stored as text in JSON mode for type safety.
 *   - Foreign keys are declared but cascade behavior is per-table.
 *   - Every user-visible table carries `tenant_id` — enforced at query time
 *     via with-tenant.ts helpers.
 */

import { relations, sql } from "drizzle-orm";
import {
  integer,
  primaryKey,
  sqliteTable,
  text,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;

// ─── Identity ────────────────────────────────────────────────────────────────

export const tenants = sqliteTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    subtitle: text("subtitle"),
    color: text("color"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    /** P5-TEN-01 — tenant lifecycle. Archived tenants are hidden from the
     * default list and have their Inngest functions de-registered, but rows
     * remain so audit trails and prior runs stay readable. Restore by setting
     * back to null. Hard-delete is a separate platform-admin operation. */
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    /** P5-TEN-01 — last time any tenant attribute (name/subtitle/color) or
     * lifecycle flag changed. Tracked separately from createdAt so the SPA
     * can show "Updated 3m ago" without inferring it from audit_log. */
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    slugUq: uniqueIndex("tenants_slug_uq").on(t.slug),
    archivedAtIdx: index("tenants_archived_at_idx").on(t.archivedAt),
  }),
);

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    emailUq: uniqueIndex("users_email_uq").on(t.email),
  }),
);

export const memberships = sqliteTable(
  "memberships",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["admin", "operator", "viewer"] }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.tenantId] }),
  }),
);

// ─── Workflow definitions ────────────────────────────────────────────────────

export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantSlugUq: uniqueIndex("workflows_tenant_slug_uq").on(
      t.tenantId,
      t.slug,
    ),
    tenantIdx: index("workflows_tenant_idx").on(t.tenantId),
  }),
);

export const workflowVersions = sqliteTable(
  "workflow_versions",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    manifestJson: text("manifest_json", { mode: "json" }).notNull(),
    actionsJson: text("actions_json", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    createdBy: text("created_by").references(() => users.id),
  },
  (t) => ({
    workflowVersionUq: uniqueIndex("wfv_workflow_version_uq").on(
      t.workflowId,
      t.version,
    ),
  }),
);

export const deployments = sqliteTable(
  "deployments",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    // SQLite stores the column as plain TEXT — the `enum` array is a
    // type-level constraint only, so widening it requires no SQL
    // migration. `tenant_code` was added in Phase 3 (V1.1 AR-GAP-02) to
    // distinguish tenant tarball uploads (see
    // `apps/api/src/routes/v1/tenant-code.ts`) from the pre-existing
    // `code_agent` (registry-based code agents under `packages/agents`).
    target: text("target", {
      enum: ["workflow", "agent", "runtime", "code_agent", "tenant_code"],
    }).notNull(),
    versionId: text("version_id").notNull(),
    status: text("status", {
      enum: ["live", "rolled_back", "pending"],
    }).notNull(),
    deployedBy: text("deployed_by").references(() => users.id),
    deployedAt: integer("deployed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    note: text("note"),
    /**
     * Expiry for `status='pending'` rows produced by the manifest-import
     * wizard. Set to `now + 1h` when validate inserts the pending row; nulled
     * out at commit. Boot-time `reconcileImports` drops expired rows along
     * with their `data/imports/<deployment_id>/` tmp dirs. Null for live
     * rows. (Per review A2: the deployment row's `id` IS the session token —
     * no separate `import_session_id` column.)
     */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
    /**
     * Path to the on-disk manifest backing this deployment. Between phases
     * 3 and 4 of the commit transaction this points at the tmp staging file
     * `data/imports/<deployment_id>/workflow.json`; after the atomic rename
     * in phase 4 it points at `models/<slug>-vN/workflow_v<N+1>.json`. The
     * boot-time reconciler queries this column to complete crashed renames
     * and detect missing on-disk files. Null for non-import deployments.
     */
    filePath: text("file_path"),
  },
  (t) => ({
    tenantStatusIdx: index("dpl_tenant_status_idx").on(t.tenantId, t.status),
    versionIdx: index("dpl_version_idx").on(t.versionId),
    expiresAtIdx: index("deployments_expires_at_idx").on(t.expiresAt),
    filePathIdx: index("deployments_file_path_idx").on(t.filePath),
  }),
);

export const agents = sqliteTable(
  "agents",
  {
    id: text("id").primaryKey(),
    /**
     * Direct tenant ownership for Studio lookups. Nullable at the Drizzle
     * boundary during the legacy transition: migration 0017 backfills it and
     * DB triggers derive it from workflow_id for old insert call sites.
     */
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    kebabId: text("kebab_id").notNull(),
    name: text("name").notNull(),
    title: text("title"),
    actor: text("actor", { enum: ["Agent", "Human"] }).notNull(),
    kind: text("kind", { enum: ["manifest", "code"] })
      .notNull()
      .default("manifest"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lifecycle: text("lifecycle", {
      enum: ["draft", "active", "archived"],
    })
      .notNull()
      .default("active"),
    // P0-DB-01: temporal columns (migration 0003_temporal_columns.sql).
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    workflowKebabUq: uniqueIndex("agents_workflow_kebab_uq").on(
      t.workflowId,
      t.kebabId,
    ),
    workflowIdx: index("agents_workflow_idx").on(t.workflowId),
    tenantIdx: index("agents_tenant_idx").on(t.tenantId),
    tenantLifecycleIdx: index("agents_tenant_lifecycle_idx").on(
      t.tenantId,
      t.lifecycle,
    ),
  }),
);

export const agentVersions = sqliteTable(
  "agent_versions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    manifestJson: text("manifest_json", { mode: "json" }).notNull(),
    definitionSchemaVersion: integer("definition_schema_version")
      .notNull()
      .default(1),
    contentHash: text("content_hash"),
    createdBy: text("created_by").references(() => users.id),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    changeNote: text("change_note"),
    // P0-DB-01 added these columns in SQL but the original Drizzle mapping
    // omitted them. 0017 repairs zero-valued rows and insert-time defaults.
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    agentWfvUq: uniqueIndex("agv_agent_wfv_uq").on(
      t.agentId,
      t.workflowVersionId,
    ),
  }),
);

// ─── Agent Studio drafts + immutable draft revisions ───────────────────────

export const agentDrafts = sqliteTable(
  "agent_drafts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    baseAgentVersionId: text("base_agent_version_id").references(
      () => agentVersions.id,
    ),
    baseWorkflowVersionId: text("base_workflow_version_id").references(
      () => workflowVersions.id,
    ),
    definitionJson: text("definition_json", { mode: "json" }).notNull(),
    schemaVersion: integer("schema_version").notNull().default(2),
    contentHash: text("content_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    validationStatus: text("validation_status", {
      enum: ["unvalidated", "valid", "invalid", "stale"],
    })
      .notNull()
      .default("unvalidated"),
    validationJson: text("validation_json", { mode: "json" }),
    validatedHash: text("validated_hash"),
    createdBy: text("created_by").references(() => users.id),
    updatedBy: text("updated_by").references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    tenantUpdatedIdx: index("agent_drafts_tenant_updated_idx").on(
      t.tenantId,
      t.updatedAt,
    ),
    agentUpdatedIdx: index("agent_drafts_agent_updated_idx").on(
      t.agentId,
      t.updatedAt,
    ),
    workflowIdx: index("agent_drafts_workflow_idx").on(t.workflowId),
    deletedAtIdx: index("agent_drafts_deleted_at_idx").on(t.deletedAt),
  }),
);

export const agentDraftRevisions = sqliteTable(
  "agent_draft_revisions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    draftId: text("draft_id")
      .notNull()
      .references(() => agentDrafts.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    definitionJson: text("definition_json", { mode: "json" }).notNull(),
    schemaVersion: integer("schema_version").notNull().default(2),
    contentHash: text("content_hash").notNull(),
    reason: text("reason", {
      enum: ["run", "checkpoint", "publish"],
    }).notNull(),
    createdBy: text("created_by").references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    draftRevisionUq: uniqueIndex("agent_draft_revisions_draft_revision_uq").on(
      t.draftId,
      t.revision,
    ),
    tenantCreatedIdx: index("agent_draft_revisions_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
  }),
);

// ─── Events ──────────────────────────────────────────────────────────────────

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category"),
    sourceAgentId: text("source_agent_id").references(() => agents.id),
    subject: text("subject"),
    receivedAt: integer("received_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    payloadRef: text("payload_ref"),
    /** P1-API-04b — soft-delete tombstone. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    tenantNameReceivedIdx: index("evt_tenant_name_received_idx").on(
      t.tenantId,
      t.name,
      t.receivedAt,
    ),
    deletedAtIdx: index("events_deleted_at_idx").on(t.deletedAt),
    // Event Tester SSE poll (GET /v1/events/stream without ?names=) uses
    // `WHERE tenantId = ? AND receivedAt > ?` — the (tenantId, name, ...)
    // index cannot serve that because `name` sits between the equality and
    // the range predicate. A covering (tenantId, receivedAt) index keeps
    // the 250ms poll query a B-tree seek even on tenants with 100k+ events.
    tenantReceivedIdx: index("evt_tenant_received_idx").on(
      t.tenantId,
      t.receivedAt,
    ),
    tenantSubjectIdx: index("evt_tenant_subject_idx").on(t.tenantId, t.subject),
  }),
);

export const eventListeners = sqliteTable(
  "event_listeners",
  {
    eventName: text("event_name").notNull(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventName, t.agentId] }),
    eventIdx: index("evtl_event_idx").on(t.eventName),
  }),
);

// ─── Agent Studio sessions + runs + steps ───────────────────────────────────

export const agentRunSessions = sqliteTable(
  "agent_run_sessions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    createdBy: text("created_by").references(() => users.id),
    title: text("title"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    lastRunAt: integer("last_run_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    tenantUpdatedIdx: index("agent_run_sessions_tenant_updated_idx").on(
      t.tenantId,
      t.updatedAt,
    ),
    agentUpdatedIdx: index("agent_run_sessions_agent_updated_idx").on(
      t.agentId,
      t.updatedAt,
    ),
  }),
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    agentVersionId: text("agent_version_id").references(() => agentVersions.id),
    draftRevisionId: text("draft_revision_id").references(
      () => agentDraftRevisions.id,
    ),
    sessionId: text("session_id").references(() => agentRunSessions.id, {
      onDelete: "set null",
    }),
    triggerEventId: text("trigger_event_id").references(() => events.id),
    /** P1-RT-04 — parent run id when this run was composed via `subflow`. */
    parentRunId: text("parent_run_id"),
    status: text("status", {
      enum: ["queued", "running", "ok", "failed", "waiting", "cancelled"],
    }).notNull(),
    queuedAt: integer("queued_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    durationMs: integer("duration_ms"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    provider: text("provider"),
    model: text("model"),
    emittedEventId: text("emitted_event_id"),
    errorMessage: text("error_message"),
    logPath: text("log_path"),
    correlationId: text("correlation_id").notNull(),
    subject: text("subject"),
    invocationSource: text("invocation_source", {
      enum: ["studio", "event", "api", "replay", "demo"],
    })
      .notNull()
      .default("event"),
    requestedBy: text("requested_by").references(() => users.id),
    requestId: text("request_id"),
    interactionId: text("interaction_id"),
    productSurface: text("product_surface"),
    productAction: text("product_action"),
    definitionHash: text("definition_hash"),
    outputValid: integer("output_valid", { mode: "boolean" }),
    sideEffectMode: text("side_effect_mode", {
      enum: ["suppressed", "safe", "live"],
    })
      .notNull()
      .default("live"),
    /** P1-API-04b — soft-delete tombstone. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    /**
     * Test-run marker. Set true when:
     *   • the synchronous code-agent invoke route accepts `testRun: true`, or
     *   • the manifest path sees `event.data.__test === true` (Event Tester
     *     publishes via `POST /v1/events` with `test: true`).
     * The column is indexed so dashboards can default to non-test traffic.
     */
    isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),
  },
  (t) => ({
    tenantStartedIdx: index("runs_tenant_started_idx").on(
      t.tenantId,
      t.startedAt,
    ),
    tenantQueuedIdx: index("runs_tenant_queued_idx").on(t.tenantId, t.queuedAt),
    tenantStatusIdx: index("runs_tenant_status_idx").on(t.tenantId, t.status),
    agentIdx: index("runs_agent_idx").on(t.agentId),
    correlationIdx: index("runs_correlation_idx").on(t.correlationId),
    interactionIdx: index("runs_interaction_idx").on(t.interactionId),
    subjectIdx: index("runs_subject_idx").on(t.subject),
    deletedAtIdx: index("runs_deleted_at_idx").on(t.deletedAt),
    isTestIdx: index("runs_is_test_idx").on(t.isTest),
    sessionIdx: index("runs_session_idx").on(t.sessionId),
    draftRevisionIdx: index("runs_draft_revision_idx").on(t.draftRevisionId),
    agentSourceStartedIdx: index("runs_agent_source_started_idx").on(
      t.agentId,
      t.invocationSource,
      t.startedAt,
    ),
  }),
);

export const steps = sqliteTable(
  "steps",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    ord: integer("ord").notNull(),
    name: text("name").notNull(),
    type: text("type", {
      enum: ["tool", "logic", "manual", "condition", "delay", "subflow"],
    }).notNull(),
    status: text("status", {
      enum: ["pending", "running", "ok", "failed", "skipped"],
    }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    durationMs: integer("duration_ms"),
    inputRef: text("input_ref"),
    outputRef: text("output_ref"),
    error: text("error"),
    provider: text("provider"),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
  },
  (t) => ({
    runOrdIdx: index("steps_run_ord_idx").on(t.runId, t.ord),
  }),
);

/**
 * One row per provider attempt, including retries and failover. Token and
 * cost fields are finalized only when the provider returned authoritative
 * usage; failed/ambiguous attempts remain visible without inventing spend.
 */
export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: text("id").primaryKey(),
    logicalCallId: text("logical_call_id").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    stepId: text("step_id").references(() => steps.id, {
      onDelete: "set null",
    }),
    purpose: text("purpose"),
    billingAccountId: text("billing_account_id"),
    providerAccountId: text("provider_account_id"),
    actorType: text("actor_type", {
      enum: ["user", "api_token", "system"],
    }),
    actorId: text("actor_id"),
    credentialId: text("credential_id"),
    providerCredentialId: text("provider_credential_id"),
    product: text("product"),
    productSurface: text("product_surface"),
    productAction: text("product_action"),
    interactionId: text("interaction_id"),
    functionName: text("function_name"),
    apiRoute: text("api_route"),
    httpMethod: text("http_method"),
    requestId: text("request_id"),
    correlationId: text("correlation_id"),
    invocationSource: text("invocation_source"),
    provider: text("provider").notNull(),
    requestedModel: text("requested_model").notNull(),
    requestedRoute: text("requested_route"),
    effectiveRoute: text("effective_route"),
    gatewayInstanceId: text("gateway_instance_id"),
    gatewayKind: text("gateway_kind"),
    modelFamily: text("model_family"),
    taskType: text("task_type"),
    matchedTaskType: text("matched_task_type"),
    routingProfileId: text("routing_profile_id"),
    routingRevision: integer("routing_revision"),
    resolutionReason: text("resolution_reason"),
    fallbackIndex: integer("fallback_index"),
    transport: text("transport"),
    effectiveTimeoutMs: integer("effective_timeout_ms"),
    overallDeadlineMs: integer("overall_deadline_ms"),
    controlsJson: text("controls_json", { mode: "json" }),
    retryReason: text("retry_reason"),
    reasoningMode: text("reasoning_mode", { enum: ["standard", "pro"] }),
    reasoningEffort: text("reasoning_effort", {
      enum: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    }),
    reasoningSummary: text("reasoning_summary", {
      enum: ["none", "auto", "concise", "detailed"],
    }),
    reasoningContext: text("reasoning_context", {
      enum: ["auto", "current_turn", "all_turns"],
    }),
    textVerbosity: text("text_verbosity", {
      enum: ["low", "medium", "high"],
    }),
    storeResponse: integer("store_response", { mode: "boolean" }),
    responseModel: text("response_model"),
    providerRequestId: text("provider_request_id"),
    attempt: integer("attempt").notNull(),
    status: text("status", { enum: ["started", "ok", "failed"] })
      .notNull()
      .default("started"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    cachedInputTokens: integer("cached_input_tokens"),
    cacheWriteInputTokens: integer("cache_write_input_tokens"),
    cacheWrite5mInputTokens: integer("cache_write_5m_input_tokens"),
    cacheWrite1hInputTokens: integer("cache_write_1h_input_tokens"),
    reasoningTokens: integer("reasoning_tokens"),
    inputAudioTokens: integer("input_audio_tokens"),
    outputAudioTokens: integer("output_audio_tokens"),
    costUsdNanos: integer("cost_usd_nanos"),
    inputUsdNanos: integer("input_usd_nanos"),
    cachedInputUsdNanos: integer("cached_input_usd_nanos"),
    cacheWriteUsdNanos: integer("cache_write_usd_nanos"),
    outputUsdNanos: integer("output_usd_nanos"),
    costSource: text("cost_source", {
      enum: ["provider", "catalog", "unpriced"],
    }),
    priceSource: text("price_source"),
    priceAsOf: text("price_as_of"),
    finishReason: text("finish_reason"),
    latencyMs: integer("latency_ms"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    usageJson: text("usage_json", { mode: "json" }),
    startedAt: integer("started_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    logicalAttemptUq: uniqueIndex("llm_calls_logical_attempt_uq").on(
      t.logicalCallId,
      t.attempt,
    ),
    tenantStartedIdx: index("llm_calls_tenant_started_idx").on(
      t.tenantId,
      t.startedAt,
    ),
    runIdx: index("llm_calls_run_idx").on(t.runId),
    stepIdx: index("llm_calls_step_idx").on(t.stepId),
    accountStartedIdx: index("llm_calls_account_started_idx").on(
      t.billingAccountId,
      t.startedAt,
    ),
    requestIdx: index("llm_calls_request_idx").on(t.requestId),
    interactionIdx: index("llm_calls_interaction_idx").on(t.interactionId),
    taskStartedIdx: index("llm_calls_task_started_idx").on(
      t.tenantId,
      t.taskType,
      t.startedAt,
    ),
    gatewayStartedIdx: index("llm_calls_gateway_started_idx").on(
      t.tenantId,
      t.gatewayInstanceId,
      t.startedAt,
    ),
  }),
);

/**
 * Canonical append-only billing events. `llm_calls` remains the detailed
 * provider-attempt projection; this table is the normalized, versioned
 * source used for portable NDJSON exports and future non-LLM usage events.
 */
export const usageEvents = sqliteTable(
  "usage_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    schemaVersion: integer("schema_version").notNull().default(1),
    eventType: text("event_type", {
      enum: ["llm.attempt", "api.call", "tool.call", "product.interaction"],
    }).notNull(),
    status: text("status", {
      enum: ["ok", "failed", "rejected", "unknown", "reconciled"],
    }).notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    billingAccountId: text("billing_account_id").notNull(),
    actorType: text("actor_type", {
      enum: ["user", "api_token", "system"],
    }).notNull(),
    actorId: text("actor_id"),
    credentialId: text("credential_id"),
    providerCredentialId: text("provider_credential_id"),
    providerAccountId: text("provider_account_id"),
    requestId: text("request_id"),
    correlationId: text("correlation_id"),
    interactionId: text("interaction_id"),
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    stepId: text("step_id").references(() => steps.id, {
      onDelete: "set null",
    }),
    product: text("product").notNull().default("agentic-operator"),
    productSurface: text("product_surface").notNull(),
    productAction: text("product_action").notNull(),
    functionName: text("function_name").notNull(),
    apiRoute: text("api_route"),
    httpMethod: text("http_method"),
    invocationSource: text("invocation_source"),
    llmCallId: text("llm_call_id").references(() => llmCalls.id, {
      onDelete: "set null",
    }),
    quantityJson: text("quantity_json", { mode: "json" }).notNull(),
    providerCostUsdNanos: integer("provider_cost_usd_nanos"),
    billableChargeUsdNanos: integer("billable_charge_usd_nanos"),
    costLiability: text("cost_liability", {
      enum: ["known", "unknown", "unpriced"],
    }).notNull(),
    currency: text("currency").notNull().default("USD"),
    rateCardVersion: text("rate_card_version")
      .notNull()
      .default("pass-through-v1"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }).notNull(),
    recordedAt: integer("recorded_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    exportedAt: integer("exported_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    callUq: uniqueIndex("usage_events_llm_call_uq").on(t.llmCallId),
    tenantSequenceIdx: index("usage_events_tenant_sequence_idx").on(
      t.tenantId,
      t.sequence,
    ),
    accountOccurredIdx: index("usage_events_account_occurred_idx").on(
      t.billingAccountId,
      t.occurredAt,
    ),
    exportIdx: index("usage_events_export_idx").on(t.exportedAt, t.sequence),
    interactionIdx: index("usage_events_interaction_idx").on(t.interactionId),
  }),
);

/**
 * Explicit Studio session messages. Runs default to isolated context and use
 * these rows only for chat/history presentation. A run that explicitly opts
 * into session context snapshots bounded prior user/assistant turns before it
 * appends its own user message; later mutations therefore cannot change the
 * prompt used by that run or one of its replays.
 */
export const runMessages = sqliteTable(
  "run_messages",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentRunSessions.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    ord: integer("ord").notNull(),
    role: text("role", {
      enum: ["system", "user", "assistant", "tool"],
    }).notNull(),
    contentJson: text("content_json", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    sessionOrdUq: uniqueIndex("run_messages_session_ord_uq").on(
      t.sessionId,
      t.ord,
    ),
    tenantCreatedIdx: index("run_messages_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
    runIdx: index("run_messages_run_idx").on(t.runId),
  }),
);

// ─── Tasks ───────────────────────────────────────────────────────────────────

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: text("run_id").references(() => runs.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    awaitingRole: text("awaiting_role"),
    awaitingUserId: text("awaiting_user_id").references(() => users.id),
    priority: text("priority", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("medium"),
    status: text("status", { enum: ["open", "resolved", "snoozed"] })
      .notNull()
      .default("open"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    resolvedBy: text("resolved_by").references(() => users.id),
    payloadJson: text("payload_json", { mode: "json" }),
    resolutionJson: text("resolution_json", { mode: "json" }),
    /** P1-API-04b — soft-delete tombstone. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    tenantStatusIdx: index("tasks_tenant_status_idx").on(t.tenantId, t.status),
    runIdx: index("tasks_run_idx").on(t.runId),
    deletedAtIdx: index("tasks_deleted_at_idx").on(t.deletedAt),
  }),
);

// ─── Artifacts ───────────────────────────────────────────────────────────────

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").references(() => steps.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    role: text("role", {
      enum: [
        "definition",
        "input",
        "output",
        "run_record",
        "raw_response",
        "step_input",
        "step_output",
        "trace",
        "attachment",
        "other",
      ],
    })
      .notNull()
      .default("other"),
    logicalName: text("logical_name"),
    contentType: text("content_type"),
    sha256: text("sha256"),
    schemaId: text("schema_id"),
    metadataJson: text("metadata_json", { mode: "json" }),
    redacted: integer("redacted", { mode: "boolean" }).notNull().default(false),
    retentionUntil: integer("retention_until", { mode: "timestamp_ms" }),
    path: text("path").notNull(),
    size: integer("size").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runIdx: index("art_run_idx").on(t.runId),
    runRoleIdx: index("art_run_role_idx").on(t.runId, t.role),
    stepIdx: index("art_step_idx").on(t.stepId),
    sha256Idx: index("art_sha256_idx").on(t.sha256),
    retentionIdx: index("art_retention_until_idx").on(t.retentionUntil),
  }),
);

/** Durable, append-only structured trace used by Studio history and SSE. */
export const runTraceEvents = sqliteTable(
  "run_trace_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    stepId: text("step_id").references(() => steps.id, {
      onDelete: "set null",
    }),
    /** Self-parent id is intentionally not an FK so trace ingestion can append
     * children before a delayed parent update without disabling FK checks. */
    parentId: text("parent_id"),
    seq: integer("seq").notNull(),
    kind: text("kind", {
      enum: [
        "run",
        "input",
        "prompt",
        "step",
        "llm",
        "tool",
        "output_validation",
        "artifact",
        "event",
      ],
    }).notNull(),
    level: text("level", {
      enum: ["minimal", "standard", "debug"],
    })
      .notNull()
      .default("standard"),
    name: text("name").notNull(),
    status: text("status", {
      enum: ["pending", "running", "ok", "failed", "skipped"],
    }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    durationMs: integer("duration_ms"),
    summary: text("summary"),
    dataJson: text("data_json", { mode: "json" }),
    artifactId: text("artifact_id").references(() => artifacts.id, {
      onDelete: "set null",
    }),
    visibility: text("visibility", {
      enum: ["user", "operator", "debug"],
    })
      .notNull()
      .default("user"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runSeqUq: uniqueIndex("run_trace_events_run_seq_uq").on(t.runId, t.seq),
    tenantCreatedIdx: index("run_trace_events_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
    stepIdx: index("run_trace_events_step_idx").on(t.stepId),
    parentIdx: index("run_trace_events_parent_idx").on(t.parentId),
  }),
);

/** One-to-many link from a run to every downstream event it emitted. */
export const runEmittedEvents = sqliteTable(
  "run_emitted_events",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    outputPortId: text("output_port_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runEventPortUq: uniqueIndex("run_emitted_events_run_event_port_uq").on(
      t.runId,
      t.eventId,
      t.outputPortId,
    ),
    tenantCreatedIdx: index("run_emitted_events_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
    eventIdx: index("run_emitted_events_event_idx").on(t.eventId),
  }),
);

// ─── Ops ─────────────────────────────────────────────────────────────────────

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    at: integer("at", { mode: "timestamp_ms" }).notNull().default(now),
    metaJson: text("meta_json", { mode: "json" }),
  },
  (t) => ({
    tenantAtIdx: index("audit_tenant_at_idx").on(t.tenantId, t.at),
    targetIdx: index("audit_target_idx").on(t.targetType, t.targetId),
  }),
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    hash: text("hash").notNull(),
    name: text("name").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    lastUsedAt: integer("last_used_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    hashUq: uniqueIndex("tok_hash_uq").on(t.hash),
    tenantIdx: index("tok_tenant_idx").on(t.tenantId),
  }),
);

// ─── Ontology (RF-1.4): per-tenant event + entity catalogs ──────────────────

export const eventTypes = sqliteTable(
  "event_types",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category"),
    color: text("color"),
    description: text("description"),
    payloadJson: text("payload_json", { mode: "json" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.name] }),
  }),
);

export const entityTypes = sqliteTable(
  "entity_types",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    entityId: text("entity_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    primaryKeyName: text("primary_key_name"),
    propertiesJson: text("properties_json", { mode: "json" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.entityId] }),
  }),
);

// ─── Budgets (P1-DB-01) ─────────────────────────────────────────────────────

export const tenantBudgets = sqliteTable("tenant_budgets", {
  tenantId: text("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  monthlyTokenCap: integer("monthly_token_cap"),
  monthlyUsdCap: integer("monthly_usd_cap"),
  usedTokensMonth: integer("used_tokens_month").notNull().default(0),
  usedUsdMonth: integer("used_usd_month").notNull().default(0),
  /** Exact accumulated spend; usedUsdMonth is retained as a cents projection. */
  usedUsdNanos: integer("used_usd_nanos").notNull().default(0),
  periodStart: integer("period_start", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});

// ─── Schema metadata (P1-DB-02) ─────────────────────────────────────────────

export const meta = sqliteTable("_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});

// ─── Webhook subscriptions (P3-RT-04) ───────────────────────────────────────

export const webhookSubscriptions = sqliteTable(
  "webhook_subscriptions",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    source: text("source").notNull(),
    secretEncrypted: text("secret_encrypted").notNull(),
    signingAlgo: text("signing_algo").notNull().default("hmac-sha256"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantSourceUq: uniqueIndex("webhook_sub_tenant_source_uq")
      .on(t.tenantId, t.source)
      .where(sql`${t.enabled} = 1`),
    sourceIdx: index("webhook_sub_source_idx")
      .on(t.source)
      .where(sql`${t.enabled} = 1`),
  }),
);

// ─── Agent memory (P3-DB-01) ────────────────────────────────────────────────

export const agentMemoryShort = sqliteTable(
  "agent_memory_short",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.runId, t.key] }),
    runIdx: index("agent_memory_short_run_idx").on(t.runId),
  }),
);

export const agentMemoryLong = sqliteTable(
  "agent_memory_long",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    agentName: text("agent_name").notNull(),
    subject: text("subject").notNull(),
    key: text("key").notNull(),
    valueJson: text("value_json").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.tenantId, t.agentName, t.subject, t.key],
    }),
    tenantAgentIdx: index("agent_memory_long_tenant_agent_idx").on(
      t.tenantId,
      t.agentName,
    ),
    subjectIdx: index("agent_memory_long_subject_idx").on(
      t.tenantId,
      t.subject,
    ),
  }),
);

/**
 * UC-V11-32 / PF-GAP-10 — persistent Idempotency-Key cache.
 *
 * The api routes that mutate state (`POST /v1/events`,
 * `POST /v1/agents/:name/invoke`, `POST /v1/tenants`, …) accept an
 * `Idempotency-Key` header. Before this table the only enforcement was a
 * per-process in-memory LRU in `apps/api/src/routes/v1/tenants.ts` —
 * restart the api or run >1 instance and the contract evaporated. This
 * table makes the cache durable + cross-instance:
 *
 *   - PK is (tenant_id, key) — each tenant gets a private keyspace.
 *   - response_json holds the response body verbatim (JSON-stringified),
 *     so a retry sees byte-identical output including any mint tokens.
 *   - status_code lets the route replay the original HTTP status.
 *   - TTL is 24h from insert; the retention sweep deletes expired rows in
 *     bulk via the `(expires_at)` index.
 */
export const idempotencyKeys = sqliteTable(
  "idempotency_keys",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    responseJson: text("response_json").notNull(),
    statusCode: integer("status_code").notNull().default(200),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.key] }),
    expiresAtIdx: index("idempotency_keys_expires_at_idx").on(t.expiresAt),
  }),
);

/**
 * External-service integrations configured per tenant in Settings →
 * Integrations (e.g. the GoHire ATS). One row per (tenant, provider).
 *
 * The API key is encrypted at rest with AES-256-GCM — only the ciphertext
 * (`key_cipher`), the 12-byte IV (`key_iv`), the 16-byte auth tag
 * (`key_tag`), and the per-row KDF salt (`key_salt`) are stored; the
 * plaintext never touches the DB. `key_masked` is a display-safe
 * `gh_ab…wxyz` fragment so the UI can show "a key is set" without
 * decrypting. The decrypt path lives in apps/api
 * (`services/integration-store.ts`); the GoHire tool family reads the
 * decrypted creds through the injected `resolveIntegrationCreds` seam.
 *
 * `base_url` + the key are both nullable so a row can exist half-configured
 * (e.g. base URL saved, key pending). `status` is the last connection-test
 * result so the Settings list can show a health pill without re-probing.
 */
export const integrations = sqliteTable(
  "integrations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** Stable provider key, e.g. "gohire". Matches the GoHire tools' lookup. */
    provider: text("provider").notNull(),
    /** Human-readable display name shown in the Settings list. */
    name: text("name").notNull(),
    /** Operator-configured base URL (no trailing slash). */
    baseUrl: text("base_url"),
    /** AES-256-GCM ciphertext of the API key (hex). Null when unset. */
    keyCipher: text("key_cipher"),
    /** 12-byte IV (hex). */
    keyIv: text("key_iv"),
    /** 16-byte GCM auth tag (hex). */
    keyTag: text("key_tag"),
    /** Per-row scrypt salt (hex) used to derive the encryption key. */
    keySalt: text("key_salt"),
    /** Display-safe masked key (e.g. "gh_ab…wxyz"); never the plaintext. */
    keyMasked: text("key_masked"),
    /** Last connection-test outcome: "unconfigured" | "ok" | "error". */
    status: text("status").notNull().default("unconfigured"),
    /** When the connection was last tested. */
    lastCheckedAt: integer("last_checked_at", { mode: "timestamp_ms" }),
    /** Last connection-test error message (null when ok). */
    lastError: text("last_error"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdBy: text("created_by"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantProviderUq: uniqueIndex("integration_tenant_provider_uq").on(
      t.tenantId,
      t.provider,
    ),
    tenantIdx: index("integration_tenant_idx").on(t.tenantId),
  }),
);

// ─── Relations (used by Drizzle's relational queries) ───────────────────────

export const tenantsRelations = relations(tenants, ({ many }) => ({
  workflows: many(workflows),
  agents: many(agents),
  agentDrafts: many(agentDrafts),
  agentRunSessions: many(agentRunSessions),
  events: many(events),
  runs: many(runs),
  tasks: many(tasks),
  memberships: many(memberships),
  usageEvents: many(usageEvents),
}));

export const workflowsRelations = relations(workflows, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [workflows.tenantId],
    references: [tenants.id],
  }),
  versions: many(workflowVersions),
  agents: many(agents),
  agentDrafts: many(agentDrafts),
}));

export const workflowVersionsRelations = relations(
  workflowVersions,
  ({ one, many }) => ({
    workflow: one(workflows, {
      fields: [workflowVersions.workflowId],
      references: [workflows.id],
    }),
    agentVersions: many(agentVersions),
  }),
);

export const agentsRelations = relations(agents, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [agents.tenantId],
    references: [tenants.id],
  }),
  workflow: one(workflows, {
    fields: [agents.workflowId],
    references: [workflows.id],
  }),
  versions: many(agentVersions),
  drafts: many(agentDrafts),
  runSessions: many(agentRunSessions),
  runs: many(runs),
}));

export const agentVersionsRelations = relations(
  agentVersions,
  ({ one, many }) => ({
    agent: one(agents, {
      fields: [agentVersions.agentId],
      references: [agents.id],
    }),
    workflowVersion: one(workflowVersions, {
      fields: [agentVersions.workflowVersionId],
      references: [workflowVersions.id],
    }),
    basedDrafts: many(agentDrafts),
    runs: many(runs),
  }),
);

export const agentDraftsRelations = relations(agentDrafts, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [agentDrafts.tenantId],
    references: [tenants.id],
  }),
  workflow: one(workflows, {
    fields: [agentDrafts.workflowId],
    references: [workflows.id],
  }),
  agent: one(agents, {
    fields: [agentDrafts.agentId],
    references: [agents.id],
  }),
  baseAgentVersion: one(agentVersions, {
    fields: [agentDrafts.baseAgentVersionId],
    references: [agentVersions.id],
  }),
  baseWorkflowVersion: one(workflowVersions, {
    fields: [agentDrafts.baseWorkflowVersionId],
    references: [workflowVersions.id],
  }),
  revisions: many(agentDraftRevisions),
}));

export const agentDraftRevisionsRelations = relations(
  agentDraftRevisions,
  ({ one, many }) => ({
    draft: one(agentDrafts, {
      fields: [agentDraftRevisions.draftId],
      references: [agentDrafts.id],
    }),
    runs: many(runs),
  }),
);

export const agentRunSessionsRelations = relations(
  agentRunSessions,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [agentRunSessions.tenantId],
      references: [tenants.id],
    }),
    agent: one(agents, {
      fields: [agentRunSessions.agentId],
      references: [agents.id],
    }),
    runs: many(runs),
    messages: many(runMessages),
  }),
);

export const runsRelations = relations(runs, ({ one, many }) => ({
  tenant: one(tenants, { fields: [runs.tenantId], references: [tenants.id] }),
  agent: one(agents, { fields: [runs.agentId], references: [agents.id] }),
  agentVersion: one(agentVersions, {
    fields: [runs.agentVersionId],
    references: [agentVersions.id],
  }),
  draftRevision: one(agentDraftRevisions, {
    fields: [runs.draftRevisionId],
    references: [agentDraftRevisions.id],
  }),
  session: one(agentRunSessions, {
    fields: [runs.sessionId],
    references: [agentRunSessions.id],
  }),
  triggerEvent: one(events, {
    fields: [runs.triggerEventId],
    references: [events.id],
  }),
  steps: many(steps),
  tasks: many(tasks),
  messages: many(runMessages),
  artifacts: many(artifacts),
  traceEvents: many(runTraceEvents),
  emittedEvents: many(runEmittedEvents),
  llmCalls: many(llmCalls),
}));

export const stepsRelations = relations(steps, ({ one }) => ({
  run: one(runs, { fields: [steps.runId], references: [runs.id] }),
}));

export const llmCallsRelations = relations(llmCalls, ({ one }) => ({
  tenant: one(tenants, {
    fields: [llmCalls.tenantId],
    references: [tenants.id],
  }),
  run: one(runs, { fields: [llmCalls.runId], references: [runs.id] }),
  step: one(steps, { fields: [llmCalls.stepId], references: [steps.id] }),
}));

export const usageEventsRelations = relations(usageEvents, ({ one }) => ({
  tenant: one(tenants, {
    fields: [usageEvents.tenantId],
    references: [tenants.id],
  }),
  run: one(runs, { fields: [usageEvents.runId], references: [runs.id] }),
  step: one(steps, { fields: [usageEvents.stepId], references: [steps.id] }),
  llmCall: one(llmCalls, {
    fields: [usageEvents.llmCallId],
    references: [llmCalls.id],
  }),
}));

export const runMessagesRelations = relations(runMessages, ({ one }) => ({
  session: one(agentRunSessions, {
    fields: [runMessages.sessionId],
    references: [agentRunSessions.id],
  }),
  run: one(runs, { fields: [runMessages.runId], references: [runs.id] }),
}));

export const artifactsRelations = relations(artifacts, ({ one, many }) => ({
  run: one(runs, { fields: [artifacts.runId], references: [runs.id] }),
  step: one(steps, { fields: [artifacts.stepId], references: [steps.id] }),
  traceEvents: many(runTraceEvents),
}));

export const runTraceEventsRelations = relations(runTraceEvents, ({ one }) => ({
  run: one(runs, {
    fields: [runTraceEvents.runId],
    references: [runs.id],
  }),
  step: one(steps, {
    fields: [runTraceEvents.stepId],
    references: [steps.id],
  }),
  artifact: one(artifacts, {
    fields: [runTraceEvents.artifactId],
    references: [artifacts.id],
  }),
}));

export const runEmittedEventsRelations = relations(
  runEmittedEvents,
  ({ one }) => ({
    run: one(runs, {
      fields: [runEmittedEvents.runId],
      references: [runs.id],
    }),
    event: one(events, {
      fields: [runEmittedEvents.eventId],
      references: [events.id],
    }),
  }),
);

export const tasksRelations = relations(tasks, ({ one }) => ({
  tenant: one(tenants, { fields: [tasks.tenantId], references: [tenants.id] }),
  run: one(runs, { fields: [tasks.runId], references: [runs.id] }),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  tenant: one(tenants, {
    fields: [events.tenantId],
    references: [tenants.id],
  }),
  sourceAgent: one(agents, {
    fields: [events.sourceAgentId],
    references: [agents.id],
  }),
}));

// ─── Helper: full schema export for drizzle() ───────────────────────────────

export const schema = {
  tenants,
  users,
  memberships,
  workflows,
  workflowVersions,
  deployments,
  agents,
  agentVersions,
  agentDrafts,
  agentDraftRevisions,
  events,
  eventListeners,
  agentRunSessions,
  runs,
  steps,
  llmCalls,
  usageEvents,
  runMessages,
  tasks,
  artifacts,
  runTraceEvents,
  runEmittedEvents,
  auditLog,
  apiTokens,
  eventTypes,
  entityTypes,
  tenantBudgets,
  meta,
  webhookSubscriptions,
  agentMemoryShort,
  agentMemoryLong,
  idempotencyKeys,
  integrations,
  tenantsRelations,
  workflowsRelations,
  workflowVersionsRelations,
  agentsRelations,
  agentVersionsRelations,
  agentDraftsRelations,
  agentDraftRevisionsRelations,
  agentRunSessionsRelations,
  runsRelations,
  stepsRelations,
  llmCallsRelations,
  usageEventsRelations,
  runMessagesRelations,
  artifactsRelations,
  runTraceEventsRelations,
  runEmittedEventsRelations,
  tasksRelations,
  eventsRelations,
};
