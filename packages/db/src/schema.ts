/**
 * Drizzle schema for Agentic Operator — 16 tables per DESIGN.md §3.
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
    /**
     * P6-AUTH — scrypt password hash (`scrypt$<N>$<saltB64>$<hashB64>`, see
     * password.ts). Null for legacy users seeded before auth landed and for
     * not-yet-activated accounts; a null hash can never satisfy login.
     */
    passwordHash: text("password_hash"),
    /**
     * P6-AUTH — cross-tenant platform role. `superadmin` bypasses per-tenant
     * RBAC and may manage tenants + users platform-wide; `none` is an ordinary
     * user whose authority comes solely from `memberships`.
     */
    platformRole: text("platform_role", { enum: ["none", "superadmin"] })
      .notNull()
      .default("none"),
    /** P6-AUTH — account lifecycle. `suspended` blocks login + new sessions. */
    status: text("status", { enum: ["active", "suspended"] })
      .notNull()
      .default("active"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    /** P6-AUTH — last credential/profile/role change. */
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
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
    /** P6-AUTH — when this membership was granted (for the Access tab). */
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    /** P6-AUTH — user id of the admin/superadmin who granted this membership. */
    createdBy: text("created_by").references(() => users.id),
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
  },
  (t) => ({
    agentWfvUq: uniqueIndex("agv_agent_wfv_uq").on(
      t.agentId,
      t.workflowVersionId,
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

// ─── Runs + Steps ────────────────────────────────────────────────────────────

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
    triggerEventId: text("trigger_event_id").references(() => events.id),
    /** P1-RT-04 — parent run id when this run was composed via `subflow`. */
    parentRunId: text("parent_run_id"),
    status: text("status", {
      enum: ["queued", "running", "ok", "failed", "waiting", "cancelled"],
    }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    endedAt: integer("ended_at", { mode: "timestamp_ms" }),
    durationMs: integer("duration_ms"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    model: text("model"),
    emittedEventId: text("emitted_event_id"),
    /** Runtime receipt: the isolated generated handler completed successfully.
     * Null means no CodeAct receipt; false is a real preflight/worker failure. */
    codeRan: integer("code_ran", { mode: "boolean" }),
    /** Runtime receipt fields. Populated only from the structured CodeAct
     * isolation result, never from manifest `codeExecuted` configuration. */
    codeExecuted: integer("code_executed", { mode: "boolean" }),
    codeIsolation: text("code_isolation", { enum: ["worker_thread", "isolated_subprocess", "isolated_container"] }),
    codeSha256: text("code_sha256"),
    codeAttestation: text("code_attestation_status", {
      enum: [
        "production_verified",
        "sandbox_verified",
        "sandbox_not_required",
        "not_authorized",
        "missing",
        "mismatch",
        "not_checked",
      ],
    }),
    codeExecutionFailure: text("code_execution_failure"),
    errorMessage: text("error_message"),
    logPath: text("log_path"),
    correlationId: text("correlation_id").notNull(),
    subject: text("subject"),
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
    tenantStatusIdx: index("runs_tenant_status_idx").on(t.tenantId, t.status),
    agentIdx: index("runs_agent_idx").on(t.agentId),
    correlationIdx: index("runs_correlation_idx").on(t.correlationId),
    subjectIdx: index("runs_subject_idx").on(t.subject),
    deletedAtIdx: index("runs_deleted_at_idx").on(t.deletedAt),
    isTestIdx: index("runs_is_test_idx").on(t.isTest),
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
      enum: [
        "tool",
        "logic",
        "manual",
        "condition",
        "delay",
        "subflow",
        "invoke",
        "foreach",
        "emit",
        "decision",
      ],
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
    /** Exact per-step CodeAct runtime receipt; null for declarative steps. */
    codeRan: integer("code_ran", { mode: "boolean" }),
    codeExecuted: integer("code_executed", { mode: "boolean" }),
    codeIsolation: text("code_isolation", { enum: ["worker_thread", "isolated_subprocess", "isolated_container"] }),
    codeSha256: text("code_sha256"),
    codeAttestation: text("code_attestation_status", {
      enum: [
        "production_verified",
        "sandbox_verified",
        "sandbox_not_required",
        "not_authorized",
        "missing",
        "mismatch",
        "not_checked",
      ],
    }),
    codeExecutionFailure: text("code_execution_failure"),
    /**
     * Execution attempt count. Inngest retries a failed `step.run` body in
     * place; the runtime upserts by (run_id, ord) and bumps this so the run
     * viewer can show "attempt 2 of 3" instead of duplicate step rows.
     * Code-agent steps run synchronously and stay at 1.
     */
    attempts: integer("attempts").notNull().default(1),
  },
  (t) => ({
    runOrdIdx: index("steps_run_ord_idx").on(t.runId, t.ord),
  }),
);

// ─── LLM turns (W0) ──────────────────────────────────────────────────────────
// Raw per-turn capture of the deployed manifest agents' LLM tool-use loop: the
// model's response text, extracted reasoning/thinking, and the tools it
// requested — one row per loop iteration, keyed on run_id + step_id. This is
// what powers the run-detail reasoning surface and the 推理审计 page (production
// runs previously stored only token counts). Gated by AGENTIC_CAPTURE_LLM_TURNS
// with per-field size caps in the runtime. run_id FK cascade cleans these up on
// run delete/purge.
export const llmTurns = sqliteTable(
  "llm_turns",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    /** The step this turn belongs to. Plain column — the step row is written
     *  immediately before, so no FK ordering hazard; run cascade covers GC. */
    stepId: text("step_id"),
    /** Turn index within the step's tool-use loop (0-based). */
    ord: integer("ord").notNull(),
    /** Bounded snapshot of the rendered prompt — only on the first turn. */
    promptPreview: text("prompt_preview"),
    /** The assistant's text reply (bounded). */
    responseText: text("response_text"),
    /** Extracted thinking/reasoning when the provider surfaced it (bounded). */
    reasoning: text("reasoning"),
    /** [{ name, input }] of the tools the model requested this turn. */
    toolCallsJson: text("tool_calls_json", { mode: "json" }),
    provider: text("provider"),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    finishReason: text("finish_reason"),
    latencyMs: integer("latency_ms"),
    correlationId: text("correlation_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runIdx: index("llm_turns_run_idx").on(t.runId, t.ord),
    tenantCreatedIdx: index("llm_turns_tenant_created_idx").on(
      t.tenantId,
      t.createdAt,
    ),
  }),
);

// ─── Run summaries (W2) ──────────────────────────────────────────────────────
// Cached AI summary of a production run — a natural-language narrative + (on
// success) business details or (on failure) problem + likely-cause guesses.
// One row per run; generated lazily on first open and cached so re-opening
// doesn't re-spend tokens. run_id FK cascade cleans it up on run delete/purge.
export const runSummaries = sqliteTable(
  "run_summaries",
  {
    runId: text("run_id")
      .primaryKey()
      .references(() => runs.id, { onDelete: "cascade" }),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    /** The serialized RunSummary object (narrative/problem/causes/suggestions/digest). */
    summaryJson: text("summary_json", { mode: "json" }).notNull(),
    /** The model that produced the critique ("" when digest-only). */
    model: text("model"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantIdx: index("run_summaries_tenant_idx").on(t.tenantId, t.createdAt),
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
    /** Durable causal link to the business event that created the owning run. */
    originEventId: text("origin_event_id").references(() => events.id, {
      onDelete: "set null",
    }),
    /** Preserved even when an ingress path has no local events row. */
    originEventName: text("origin_event_name"),
    /** Exact manual step parked in Inngest's waitForEvent. */
    waitStepId: text("wait_step_id").references(() => steps.id, {
      onDelete: "set null",
    }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    awaitingRole: text("awaiting_role"),
    awaitingUserId: text("awaiting_user_id").references(() => users.id),
    priority: text("priority", { enum: ["low", "medium", "high"] })
      .notNull()
      .default("medium"),
    status: text("status", {
      enum: ["open", "resolving", "resolved", "snoozed", "failed"],
    })
      .notNull()
      .default("open"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    resolvedAt: integer("resolved_at", { mode: "timestamp_ms" }),
    resolvedBy: text("resolved_by").references(() => users.id),
    payloadJson: text("payload_json", { mode: "json" }),
    resolutionJson: text("resolution_json", { mode: "json" }),
    /** Stable across transport retries; duplicate resume events carry this marker. */
    resumeMarker: text("resume_marker"),
    resumeState: text("resume_state", {
      enum: ["pending", "dispatching", "dispatched", "acknowledged", "failed"],
    })
      .notNull()
      .default("pending"),
    resumeAttempts: integer("resume_attempts").notNull().default(0),
    resolutionRequestKey: text("resolution_request_key"),
    resolutionRequestedAt: integer("resolution_requested_at", {
      mode: "timestamp_ms",
    }),
    resumeDispatchedAt: integer("resume_dispatched_at", {
      mode: "timestamp_ms",
    }),
    resumeAcknowledgedAt: integer("resume_acknowledged_at", {
      mode: "timestamp_ms",
    }),
    resumeError: text("resume_error"),
    /** P1-API-04b — soft-delete tombstone. */
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
  },
  (t) => ({
    tenantStatusIdx: index("tasks_tenant_status_idx").on(t.tenantId, t.status),
    runIdx: index("tasks_run_idx").on(t.runId),
    resumeMarkerUq: uniqueIndex("tasks_resume_marker_uq").on(t.resumeMarker),
    resumeStateIdx: index("tasks_resume_state_idx").on(t.resumeState),
    waitStepIdx: index("tasks_wait_step_idx").on(t.waitStepId),
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
    kind: text("kind").notNull(),
    path: text("path").notNull(),
    size: integer("size").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runIdx: index("art_run_idx").on(t.runId),
  }),
);

// Durable business entities (candidate / resume / job_posting /
// candidate_match_result / candidate_identity_result / communication_log) — the new-arch-native replacement
// for the old AO's Neo4j / RAAS-Postgres instance write-back. Deliberately NOT
// under `artifacts` (whose run_id FK cascade-deletes with its run) nor
// `agent_memory_long` (a private per-agent KV): business entities must OUTLIVE
// the runs that produced them. Written by the `records.upsert` global tool.
export const businessRecords = sqliteTable(
  "business_records",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    recordType: text("record_type").notNull(),
    recordKey: text("record_key").notNull(),
    subject: text("subject"),
    candidateId: text("candidate_id"),
    correlationId: text("correlation_id"),
    // Plain column, NOT a FK to runs — records survive run GC / soft-delete.
    runId: text("run_id"),
    sourceAgent: text("source_agent"),
    dataJson: text("data_json", { mode: "json" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    identityUq: uniqueIndex("business_records_identity_uq").on(
      t.tenantId,
      t.recordType,
      t.recordKey,
    ),
    typeIdx: index("business_records_type_idx").on(
      t.tenantId,
      t.recordType,
      t.updatedAt,
    ),
    candidateIdx: index("business_records_candidate_idx").on(
      t.tenantId,
      t.candidateId,
    ),
    correlationIdx: index("business_records_correlation_idx").on(
      t.correlationId,
    ),
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
  periodStart: integer("period_start", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(now),
});

/** In-flight LLM budget reservations. Actual counters remain on
 * tenant_budgets; these rows make pre-call capacity checks atomic across
 * concurrent API processes and survive crashes until their lease expires. */
export const llmBudgetReservations = sqliteTable(
  "llm_budget_reservations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    reservedTokens: integer("reserved_tokens").notNull(),
    reservedUsdCents: integer("reserved_usd_cents").notNull(),
    status: text("status", {
      enum: ["active", "settled", "released", "expired"],
    })
      .notNull()
      .default("active"),
    actualTokens: integer("actual_tokens"),
    actualUsdCents: integer("actual_usd_cents"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    settledAt: integer("settled_at", { mode: "timestamp_ms" }),
    outcome: text("outcome"),
  },
  (t) => ({
    tenantStatusIdx: index("llm_budget_reservations_tenant_status_idx").on(
      t.tenantId,
      t.status,
    ),
    expiresIdx: index("llm_budget_reservations_expires_idx").on(t.expiresAt),
  }),
);

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
    /** Versioned AES-256-GCM envelope bound to tenantId + source. */
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
    /** #SCALE-MEM — pre-computed embedding (JSON float array), written at put() time so search never
     *  re-embeds static values. NULL = compute-on-demand (back-compat / embedder changed). */
    embeddingJson: text("embedding_json"),
    /** #SCALE-MEM — TTL: rows past expiresAt are excluded from reads + GC'd lazily. NULL = no expiry. */
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }),
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
 * Cross-process operation leases.
 *
 * A primary-keyed resource name is a real SQLite arbitration point shared by
 * every API process. Factory mutexes and tenant lifecycle transitions use a
 * fixed resource key; detached Factory work uses a unique key per job and is
 * queried by `(tenant_id, kind)`. `expires_at` makes crashed owners recoverable
 * while live owners renew their lease from the API process.
 */
export const operationLeases = sqliteTable(
  "operation_leases",
  {
    resourceKey: text("resource_key").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ownerToken: text("owner_token").notNull(),
    kind: text("kind").notNull(),
    workId: text("work_id"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    tenantKindIdx: index("operation_leases_tenant_kind_idx").on(
      t.tenantId,
      t.kind,
    ),
    expiresAtIdx: index("operation_leases_expires_at_idx").on(t.expiresAt),
  }),
);

// ─── Relations (used by Drizzle's relational queries) ───────────────────────

export const tenantsRelations = relations(tenants, ({ many }) => ({
  workflows: many(workflows),
  events: many(events),
  runs: many(runs),
  tasks: many(tasks),
  memberships: many(memberships),
}));

export const workflowsRelations = relations(workflows, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [workflows.tenantId],
    references: [tenants.id],
  }),
  versions: many(workflowVersions),
  agents: many(agents),
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
  workflow: one(workflows, {
    fields: [agents.workflowId],
    references: [workflows.id],
  }),
  versions: many(agentVersions),
  runs: many(runs),
}));

export const runsRelations = relations(runs, ({ one, many }) => ({
  tenant: one(tenants, { fields: [runs.tenantId], references: [tenants.id] }),
  agent: one(agents, { fields: [runs.agentId], references: [agents.id] }),
  triggerEvent: one(events, {
    fields: [runs.triggerEventId],
    references: [events.id],
  }),
  steps: many(steps),
  tasks: many(tasks),
}));

export const stepsRelations = relations(steps, ({ one }) => ({
  run: one(runs, { fields: [steps.runId], references: [runs.id] }),
}));

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

// ─── Agent Factory (brain conversations + failure reflections) ──────────────
// The factory's durable state: a streaming-brain conversation (so a follow-up
// message resumes mid-build) + per-domain failure/success reflections (so the next
// run starts wiser). Backs the ConversationStore + ReflectionWriter ports.

/** Authoritative runtime Domain (tenant) ↔ ontology Domain binding. */
export const factoryDomainBindings = sqliteTable(
  "factory_domain_bindings",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => tenants.id, { onDelete: "cascade" }),
    ontologyDomainId: text("ontology_domain_id").notNull(),
    ontologyDomainName: text("ontology_domain_name"),
    source: text("source", { enum: ["explicit", "auto", "upload"] })
      .notNull()
      .default("explicit"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    ontologyIdx: index("factory_domain_bindings_ontology_idx").on(
      t.ontologyDomainId,
    ),
  }),
);

export const factoryConversations = sqliteTable(
  "factory_conversations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    domain: text("domain").notNull(),
    messagesJson: text("messages_json", { mode: "json" }).notNull(),
    ctxJson: text("ctx_json", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    domainIdx: index("factory_conversations_domain_idx").on(t.domain),
    tenantDomainIdx: index("factory_conversations_tenant_domain_idx").on(
      t.tenantId,
      t.domain,
    ),
  }),
);

export const factoryReflections = sqliteTable(
  "factory_reflections",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    domain: text("domain").notNull(),
    kind: text("kind").notNull(), // failure | success | caveat
    summary: text("summary").notNull(),
    rootCause: text("root_cause"),
    lesson: text("lesson").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    domainIdx: index("factory_reflections_domain_idx").on(t.domain),
    tenantDomainIdx: index("factory_reflections_tenant_domain_idx").on(
      t.tenantId,
      t.domain,
    ),
  }),
);

/** Human-confirmed factory memory.  It is intentionally distinct from
 * `agent_memory_long`: the latter is maintained by an LLM consolidation
 * policy, while rows here retain provenance/pinning and may only be mutated
 * through an authenticated human path or a HITL gate carrying a human reply. */
export const factoryHumanMemories = sqliteTable(
  "factory_human_memories",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    questionKey: text("question_key").notNull(),
    kind: text("kind", {
      enum: ["clarify", "boundary", "test_approval", "directive"],
    }).notNull(),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    context: text("context"),
    source: text("source", { enum: ["human"] })
      .notNull()
      .default("human"),
    conversationId: text("conversation_id"),
    confirmed: integer("confirmed", { mode: "boolean" })
      .notNull()
      .default(true),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantDomainQuestionUq: uniqueIndex(
      "factory_human_memories_tenant_domain_question_uq",
    ).on(t.tenantId, t.domain, t.questionKey),
    tenantDomainIdx: index("factory_human_memories_tenant_domain_idx").on(
      t.tenantId,
      t.domain,
    ),
    conversationIdx: index("factory_human_memories_conversation_idx").on(
      t.conversationId,
    ),
  }),
);

// #P0-3 — raw LLM telemetry: one row per LLM call (the factory brain + its review/design tools).
// Closes the biggest observability gap from the architecture audit — per-call model / routing /
// latency / size were ephemeral (in-memory streaming only), so spend + regression + router validation
// weren't auditable. Also carries the model-routing decision (requested vs served + fallback) so a
// separate model_routing table isn't needed for single-instance.
export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id"),
    /** Durable runtime attribution. Null only for non-run calls and legacy
     * telemetry written before migration 0039. */
    runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
    domain: text("domain"),
    /** the brain conversation / run this call belongs to. */
    conversationId: text("conversation_id"),
    /** caller tag: understand | plan | critique | design | review | codegen | fast | … */
    purpose: text("purpose"),
    /** model requested (first of the fallback chain) vs the one that actually served. */
    requestedModel: text("requested_model"),
    servedModel: text("served_model"),
    provider: text("provider"),
    /** true when the served model differs from the requested (a fallback occurred). */
    fallback: integer("fallback", { mode: "boolean" }),
    promptChars: integer("prompt_chars"),
    completionChars: integer("completion_chars"),
    /** approx token counts (chars/4) when exact usage isn't returned by the streaming path. */
    approxTokensIn: integer("approx_tokens_in"),
    approxTokensOut: integer("approx_tokens_out"),
    /** How the token values were obtained. A null value means the historic
     * row predates explicit measurement provenance and must not be presented
     * as exact provider usage. */
    tokenSource: text("token_source", {
      enum: ["provider", "estimated_chars"],
    }),
    latencyMs: integer("latency_ms"),
    ok: integer("ok", { mode: "boolean" }),
    failureReason: text("failure_reason"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runIdx: index("llm_calls_run_idx").on(t.runId),
    domainIdx: index("llm_calls_domain_idx").on(t.domain),
    convIdx: index("llm_calls_conversation_idx").on(t.conversationId),
    modelIdx: index("llm_calls_served_model_idx").on(t.servedModel),
  }),
);

// #P1-1 — durable, queryable event store. The NDJSON ledger is per-instance/per-date and not
// queryable; this mirrors every emitted inter-agent event into a DB row with the FULL payload inline
// (small now thanks to content-addressed blob offload) + causation lineage (causationId), so
// cross-agent causality is queryable + replay-safe across restarts. Foundation for horizontal scale.
export const eventStore = sqliteTable(
  "event_store",
  {
    id: text("id").primaryKey(), // == the emitted event id (evt-…)
    tenantId: text("tenant_id"),
    name: text("name").notNull(),
    subject: text("subject"),
    sourceRunId: text("source_run_id"),
    sourceAgent: text("source_agent"),
    /** the event id that CAUSED this one (its trigger) — walk this to reconstruct a causality chain. */
    causationId: text("causation_id"),
    correlationId: text("correlation_id"),
    /** full assembled payload inline (blob offload keeps this small). */
    payloadJson: text("payload_json"),
    ts: integer("ts", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => ({
    subjectIdx: index("event_store_subject_idx").on(t.subject),
    causationIdx: index("event_store_causation_idx").on(t.causationId),
    corrIdx: index("event_store_correlation_idx").on(t.correlationId),
  }),
);

// #SCALE-TOOLS — per-tool sandbox effectiveness (invoked/succeeded). A score is
// owned by runtime tenant + ontology domain; otherwise one customer's failures
// silently demote the same tool for every other tenant/domain.
export const toolStats = sqliteTable(
  "tool_stats",
  {
    id: text("id").primaryKey(),
    scopeKey: text("scope_key").notNull(), // tenant id | shared | legacy quarantine
    domainKey: text("domain_key").notNull().default(""),
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    toolName: text("tool_name").notNull(),
    invoked: integer("invoked").notNull().default(0),
    succeeded: integer("succeeded").notNull().default(0),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    scopeDomainToolUq: uniqueIndex("tool_stats_scope_domain_tool_uq").on(
      t.scopeKey,
      t.domainKey,
      t.toolName,
    ),
    tenantDomainIdx: index("tool_stats_tenant_domain_idx").on(
      t.tenantId,
      t.domainKey,
    ),
  }),
);

// #P1-6 — denormalized acceptance verdicts, one row per criterion per run. Acceptance was computed
// on-demand from the transcript JSON (no table), so pass-rate trends required replaying transcripts.
export const acceptanceScores = sqliteTable(
  "acceptance_scores",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    tenantId: text("tenant_id"),
    domain: text("domain"),
    criterionKey: text("criterion_key").notNull(),
    label: text("label"),
    pass: integer("pass", { mode: "boolean" }).notNull(),
    detail: text("detail"),
    computedAt: integer("computed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    runIdx: index("acceptance_scores_run_idx").on(t.runId),
    domainIdx: index("acceptance_scores_domain_idx").on(t.domain),
  }),
);

// ─── Agent Factory run history + skills library ─────────────────────────────
// factory_runs backs the 历史运行 sidebar (one row per brain run, with the full
// transcript for read-only replay). factory_skills is the persistent skills library
// (create_skill/use_skill + effectiveness scoring), backing the SkillStore port.

export const factoryRuns = sqliteTable(
  "factory_runs",
  {
    id: text("id").primaryKey(),
    // tenant_id is NOT NULL + cascades (0021): factory runs are tenant-scoped like every other
    // user-visible table, so listing/deleting can filter by tenant and deleting a tenant GCs its
    // runs. (Was nullable + unfiltered, which leaked runs across tenants — see runs.ts/list).
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    goal: text("goal").notNull(),
    status: text("status").notNull(), // running | waiting_human | done | failed | error | aborted
    tokensUsed: integer("tokens_used").notNull().default(0),
    turns: integer("turns").notNull().default(0),
    agentsCount: integer("agents_count").notNull().default(0),
    reachedTerminal: integer("reached_terminal", { mode: "boolean" })
      .notNull()
      .default(false),
    errorMessage: text("error_message"),
    transcriptJson: text("transcript_json", { mode: "json" }),
    // Soft delete (0021): the 历史运行 trash/clear sets this; listRuns hides non-null rows and a
    // reconnect to a soft-deleted run replays a tombstone. Recoverable via restoreRun.
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    domainIdx: index("factory_runs_domain_idx").on(t.domain, t.createdAt),
    deletedAtIdx: index("factory_runs_deleted_at_idx").on(t.deletedAt),
  }),
);

export const factorySkills = sqliteTable(
  "factory_skills",
  {
    id: text("id").primaryKey(),
    scopeKey: text("scope_key").notNull(), // tenant id | shared | legacy quarantine
    /** Non-null conflict key for ontology identity. `domain` remains nullable so
     * null can keep its public meaning (tenant/global general); SQLite UNIQUE
     * treats NULL values as distinct, so it cannot safely be used directly. */
    domainKey: text("domain_key").notNull().default(""),
    slug: text("slug").notNull(),
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    promptFragment: text("prompt_fragment").notNull().default(""),
    tools: text("tools", { mode: "json" }).notNull(),
    decisionRule: text("decision_rule").notNull().default(""),
    domain: text("domain"), // null = cross-domain (general)
    useCount: integer("use_count").notNull().default(0),
    evalCount: integer("eval_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    scopeDomainSlugUq: uniqueIndex("factory_skills_scope_domain_slug_uq").on(
      t.scopeKey,
      t.domainKey,
      t.slug,
    ),
    domainIdx: index("factory_skills_domain_idx").on(t.domain),
    tenantDomainIdx: index("factory_skills_tenant_domain_idx").on(
      t.tenantId,
      t.domain,
    ),
  }),
);

// #KNOW-PACK (P1-A) — persisted domain analysis packs: understand_ontology's expensive deep read
// (the ontologyUnderstanding digest + coverage + perspective-lens account), keyed by
// (tenant, domain, ontology CONTENT hash) so a NEW session on an unchanged ontology reuses it
// instantly instead of re-burning a 1-3 minute deep read. Invalidation is implicit: a lookup by
// the current hash simply misses when the ontology changed. save() prunes to the newest N sigs
// per (tenant, domain). Deliberately NOT in db:wipe-runtime — accumulated knowledge, not traffic.
export const factoryDomainInsights = sqliteTable(
  "factory_domain_insights",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    /** ontologyContentHash of the POST-HEAL working ontology — must match the sig
     * understand_ontology stamps (curUnderstandSig), never read_ontology's pre-heal counts#hash. */
    ontologySig: text("ontology_sig").notNull(),
    mode: text("mode", { enum: ["shallow", "deep"] }).notNull(), // skeleton is never persisted
    /** ctx.ontologyUnderstanding verbatim (≤10k chars, same cap as the ctx field). */
    digest: text("digest").notNull(),
    coverageJson: text("coverage_json", { mode: "json" }),
    /** ctx.ontologyPerspectives verbatim — restored on load so the pack stays lens-aware
     * for the #PERSPECTIVES-FIDELITY cache gate. */
    perspectivesJson: text("perspectives_json", { mode: "json" }),
    ambiguityCount: integer("ambiguity_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    tenantDomainSigUq: uniqueIndex("factory_domain_insights_tenant_domain_sig_uq").on(
      t.tenantId,
      t.domain,
      t.ontologySig,
    ),
    tenantDomainIdx: index("factory_domain_insights_tenant_domain_idx").on(
      t.tenantId,
      t.domain,
    ),
  }),
);

export const factoryTools = sqliteTable(
  "factory_tools",
  {
    id: text("id").primaryKey(),
    scopeKey: text("scope_key").notNull(), // tenant id | shared | legacy quarantine
    /** See factorySkills.domainKey: prevents a rebind from overwriting the
     * previous ontology's same-named tool while keeping null-domain tools
     * explicitly general. */
    domainKey: text("domain_key").notNull().default(""),
    name: text("name").notNull(),
    tenantId: text("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    description: text("description").notNull().default(""),
    method: text("method").notNull().default("GET"),
    urlTemplate: text("url_template").notNull().default(""),
    headers: text("headers", { mode: "json" }),
    bodyTemplate: text("body_template"),
    // 0038: executable, AI-authored HTTP contracts. Keep these structured
    // manifests separate from the legacy body template so multipart encoding,
    // response normalization/assertions and grounded examples round-trip.
    requestSpec: text("request_spec", { mode: "json" }),
    responseSpec: text("response_spec", { mode: "json" }),
    examples: text("examples", { mode: "json" }),
    // No read default: omitted policy metadata must fail at insert/runtime
    // boundaries instead of silently upgrading an unknown tool to live-read.
    sideEffect: text("side_effect").notNull(),
    // 0048: precise reviewed execution policy. These remain nullable at the
    // storage layer solely to quarantine historical rows without inventing a
    // migration default. Every save/load/runtime boundary rejects null.
    operation: text("operation"),
    effectScope: text("effect_scope"),
    sandboxPolicy: text("sandbox_policy"),
    domain: text("domain"),
    // R6 (0022): typed I/O contracts — the tool's args + return shape (also the egress contract
    // for an external-platform handoff), so the step-engine can validate and agents agree on shapes.
    paramsSchema: text("params_schema", { mode: "json" }),
    returnsSchema: text("returns_schema", { mode: "json" }),
    capabilities: text("capabilities", { mode: "json" }),
    probeStatus: text("probe_status").notNull().default("required"),
    definitionHash: text("definition_hash"),
    probeEvidence: text("probe_evidence", { mode: "json" }),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    scopeDomainNameUq: uniqueIndex("factory_tools_scope_domain_name_uq").on(
      t.scopeKey,
      t.domainKey,
      t.name,
    ),
    domainIdx: index("factory_tools_domain_idx").on(t.domain),
    tenantDomainIdx: index("factory_tools_tenant_domain_idx").on(
      t.tenantId,
      t.domain,
    ),
  }),
);

/** Durable lifecycle ledger for one nonce-bearing Agent Factory sandbox app.
 * The row is inserted in the same local transaction as the ephemeral tenant,
 * before manifest commit can register anything remotely. Terminal rows remain
 * as audit evidence; only cloned tool rows are physically deleted. */
export const factorySandboxAttempts = sqliteTable(
  "factory_sandbox_attempts",
  {
    id: text("id").primaryKey(),
    ownerTenantId: text("owner_tenant_id").notNull(),
    ownerTenantSlug: text("owner_tenant_slug").notNull(),
    targetDomainId: text("target_domain_id").notNull(),
    candidateFingerprint: text("candidate_fingerprint").notNull(),
    sandboxTenantId: text("sandbox_tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    sandboxTenantSlug: text("sandbox_tenant_slug").notNull(),
    appId: text("app_id").notNull(),
    status: text("status", {
      enum: [
        "prepared",
        "registering",
        "active",
        "cleanup_pending",
        "cleanup_failed",
        "cleanup_verified",
      ],
    }).notNull(),
    remoteMayExist: integer("remote_may_exist", { mode: "boolean" })
      .notNull()
      .default(false),
    toolSnapshotHash: text("tool_snapshot_hash"),
    toolSnapshotCount: integer("tool_snapshot_count").notNull().default(0),
    leaseOwner: text("lease_owner").notNull(),
    /** Per-claim unguessable capability. Process identity alone is not enough:
     * a stale async continuation in the same process must also be fenced. */
    leaseToken: text("lease_token").notNull(),
    /** Monotonic fencing epoch. Cleanup claim increments this atomically, so
     * every earlier owner/token remains permanently unable to mutate state. */
    fenceGeneration: integer("fence_generation").notNull().default(1),
    leaseExpiresAt: integer("lease_expires_at", { mode: "timestamp_ms" }).notNull(),
    cleanupReceipt: text("cleanup_receipt", { mode: "json" }),
    cleanupError: text("cleanup_error"),
    runDrainStatus: text("run_drain_status", {
      enum: ["not_started", "cancelling", "verified", "failed"],
    }).notNull().default("not_started"),
    runDrainReceipt: text("run_drain_receipt", { mode: "json" }),
    runDrainError: text("run_drain_error"),
    runDrainStartedAt: integer("run_drain_started_at", { mode: "timestamp_ms" }),
    runDrainCompletedAt: integer("run_drain_completed_at", { mode: "timestamp_ms" }),
    cleanupStartedAt: integer("cleanup_started_at", { mode: "timestamp_ms" }),
    cleanedAt: integer("cleaned_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    appUq: uniqueIndex("factory_sandbox_attempts_app_uq").on(t.appId),
    slugUq: uniqueIndex("factory_sandbox_attempts_slug_uq").on(t.sandboxTenantSlug),
    statusLeaseIdx: index("factory_sandbox_attempts_status_lease_idx").on(t.status, t.leaseExpiresAt),
    ownerFenceIdx: index("factory_sandbox_attempts_owner_fence_idx").on(
      t.id,
      t.leaseOwner,
      t.leaseToken,
      t.fenceGeneration,
    ),
    ownerDomainIdx: index("factory_sandbox_attempts_owner_domain_idx").on(t.ownerTenantId, t.targetDomainId),
  }),
);

/** Content-addressed provenance for a temporary declarative-tool clone. The
 * clone itself is a tenant-owned factory_tools row, so runtime resolution can
 * use its normal path without reading the production/shared source row. Both
 * this row and the cloned factory_tools row are physically deleted at teardown. */
export const factorySandboxToolSnapshots = sqliteTable(
  "factory_sandbox_tool_snapshots",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => factorySandboxAttempts.id, { onDelete: "cascade" }),
    sandboxTenantId: text("sandbox_tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    sandboxToolId: text("sandbox_tool_id")
      .notNull()
      .references(() => factoryTools.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    sourceToolId: text("source_tool_id").notNull(),
    sourceScopeKey: text("source_scope_key").notNull(),
    sourceDefinitionHash: text("source_definition_hash").notNull(),
    configHash: text("config_hash").notNull(),
    domainHash: text("domain_hash").notNull(),
    snapshotHash: text("snapshot_hash").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    attemptToolUq: uniqueIndex("factory_sandbox_tool_snapshots_attempt_tool_uq").on(t.attemptId, t.toolName),
    sandboxToolUq: uniqueIndex("factory_sandbox_tool_snapshots_sandbox_tool_uq").on(t.sandboxToolId),
    snapshotIdx: index("factory_sandbox_tool_snapshots_hash_idx").on(t.snapshotHash),
  }),
);

/** Short-lived, cross-process authorization for semantic model calls made by
 * the trusted external sandbox workload. The workload presents only the
 * attempt/bundle identity plus a service token; provider credentials remain
 * in the primary API. Calls are atomically consumed and the grant is revoked
 * as soon as the remote job settles. */
export const factorySandboxModelGrants = sqliteTable(
  "factory_sandbox_model_grants",
  {
    attemptId: text("attempt_id").primaryKey(),
    bundleHash: text("bundle_hash").notNull(),
    tenantId: text("tenant_id").notNull(),
    tenantSlug: text("tenant_slug").notNull(),
    status: text("status", { enum: ["active", "revoked"] }).notNull().default("active"),
    maxCalls: integer("max_calls").notNull(),
    calls: integer("calls").notNull().default(0),
    /** Hard aggregate total-token envelope for this remote verification.
     * Each admitted call atomically reserves a conservative input-token upper
     * bound plus max output before the provider is contacted. Reservations
     * are deliberately not refunded so crashes cannot reopen spend capacity. */
    maxTotalTokens: integer("max_total_tokens").notNull(),
    reservedTotalTokens: integer("reserved_total_tokens").notNull().default(0),
    /** Provider-reported usage, retained separately from the conservative
     * reservation envelope for audit/attribution. */
    measuredInputTokens: integer("measured_input_tokens").notNull().default(0),
    measuredOutputTokens: integer("measured_output_tokens").notNull().default(0),
    unmeasuredUsageCalls: integer("unmeasured_usage_calls").notNull().default(0),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => ({
    activeExpiryIdx: index("factory_sandbox_model_grants_active_expiry_idx").on(t.status, t.expiresAt),
    tenantIdx: index("factory_sandbox_model_grants_tenant_idx").on(t.tenantId, t.tenantSlug),
  }),
);

/** Per-call, secret-free provider usage backing the aggregate evidence copied
 * into the signed sandbox result. Prompts, responses and provider raw payloads
 * are never stored here. */
export const factorySandboxModelCallUsage = sqliteTable(
  "factory_sandbox_model_call_usage",
  {
    id: text("id").primaryKey(),
    attemptId: text("attempt_id")
      .notNull()
      .references(() => factorySandboxModelGrants.attemptId, { onDelete: "cascade" }),
    bundleHash: text("bundle_hash").notNull(),
    callOrdinal: integer("call_ordinal"),
    status: text("status", { enum: ["succeeded", "failed", "rejected"] }).notNull(),
    agentRef: text("agent_ref").notNull(),
    reasonCode: text("reason_code"),
    provider: text("provider"),
    model: text("model"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    totalTokens: integer("total_tokens"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    attemptOrdinalUq: uniqueIndex("factory_sandbox_model_call_usage_attempt_ordinal_uq").on(
      t.attemptId,
      t.callOrdinal,
    ),
    attemptBundleIdx: index("factory_sandbox_model_call_usage_attempt_bundle_idx").on(
      t.attemptId,
      t.bundleHash,
    ),
  }),
);

/** Definition/config-bound probe receipts for global, tenant-native and
 * persisted declarative tools. factory_tools retains one representative row
 * for backwards-compatible display only; exact binding and promotion always
 * resolve evidence from this tenant+Ontology+tool+definition hash store. */
export const factoryToolProbes = sqliteTable(
  "factory_tool_probes",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domainKey: text("domain_key").notNull().default(""),
    toolName: text("tool_name").notNull(),
    status: text("status").notNull().default("required"),
    definitionHash: text("definition_hash").notNull(),
    schemaHash: text("schema_hash"),
    evidence: text("evidence", { mode: "json" }),
    verifiedAt: integer("verified_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    scopeToolDefinitionUq: uniqueIndex("factory_tool_probes_scope_tool_definition_uq").on(
      t.tenantId,
      t.domainKey,
      t.toolName,
      t.definitionHash,
    ),
    tenantDomainIdx: index("factory_tool_probes_tenant_domain_idx").on(
      t.tenantId,
      t.domainKey,
    ),
  }),
);

/** Human-confirmed, non-secret runtime integration config. Secret material is
 * never stored here: `*_env` values are environment variable names only. */
export const factoryIntegrationProfiles = sqliteTable(
  "factory_integration_profiles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domainKey: text("domain_key").notNull().default(""),
    toolName: text("tool_name").notNull(),
    profileKey: text("profile_key").notNull(),
    environment: text("environment", { enum: ["sandbox", "production"] }).notNull().default("production"),
    configJson: text("config_json", { mode: "json" }).notNull(),
    confirmedBy: text("confirmed_by").notNull(),
    toolDefinitionDigest: text("tool_definition_digest").notNull().default(""),
    configDigest: text("config_digest").notNull().default(""),
    authorizationProtocolVersion: integer("authorization_protocol_version").notNull().default(0),
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    scopeKeyUq: uniqueIndex("factory_integration_profiles_scope_key_uq").on(
      t.tenantId,
      t.domainKey,
      t.toolName,
      t.profileKey,
      t.environment,
    ),
    tenantDomainIdx: index("factory_integration_profiles_tenant_domain_idx").on(
      t.tenantId,
      t.domainKey,
    ),
  }),
);

/** Server-issued, exact and one-shot human authorization challenges. The raw
 * token is never persisted—only its digest. Consumption and actor attribution
 * occur in one DB transaction before any authorized I/O begins. */
export const factoryAuthorizationChallenges = sqliteTable(
  "factory_authorization_challenges",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    domainKey: text("domain_key").notNull(),
    kind: text("kind").notNull(),
    protocolVersion: integer("protocol_version").notNull(),
    digest: text("digest").notNull(),
    subjectDigest: text("subject_digest").notNull(),
    tokenDigest: text("token_digest").notNull(),
    question: text("question").notNull(),
    context: text("context").notNull(),
    optionsJson: text("options_json", { mode: "json" }).notNull(),
    runId: text("run_id").notNull(),
    conversationId: text("conversation_id").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    answeredBy: text("answered_by"),
    answeredAt: integer("answered_at", { mode: "timestamp_ms" }),
    consumedAt: integer("consumed_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => ({
    scopeDigestUq: uniqueIndex("factory_authorization_challenges_scope_digest_uq").on(
      t.tenantId,
      t.domainKey,
      t.kind,
      t.digest,
    ),
    conversationIdx: index("factory_authorization_challenges_conversation_idx").on(
      t.tenantId,
      t.domainKey,
      t.conversationId,
    ),
  }),
);

/** Durable authorization for one exact generated production Agent. The table
 * keeps its original CodeAct name for migration compatibility; declarative
 * rows store their exact agent-manifest hash in `codeSha256`, while CodeAct
 * rows store the exact handler hash. Rows are inserted only by Factory
 * promotion in the same transaction as the workflow deployment. */
export const factoryCodeActAuthorizations = sqliteTable(
  "factory_codeact_authorizations",
  {
    id: text("id").primaryKey(),
    promotionId: text("promotion_id").notNull(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    tenantSlug: text("tenant_slug").notNull(),
    domainId: text("domain_id").notNull(),
    agentSlug: text("agent_slug").notNull(),
    promotionVersionId: text("promotion_version_id").notNull(),
    regressionSuiteFingerprint: text("regression_suite_fingerprint").notNull(),
    codeSha256: text("code_sha256").notNull(),
    agentManifestSha256: text("agent_manifest_sha256").notNull(),
    workflowManifestSha256: text("workflow_manifest_sha256").notNull(),
    deploymentId: text("deployment_id")
      .notNull()
      .references(() => deployments.id, { onDelete: "cascade" }),
    workflowVersionId: text("workflow_version_id")
      .notNull()
      .references(() => workflowVersions.id, { onDelete: "cascade" }),
    reviewReceiptId: text("review_receipt_id").notNull(),
    reviewSelectionHash: text("review_selection_hash").notNull(),
    regressionArtifact: text("regression_artifact").notNull(),
    promotionRecordHash: text("promotion_record_hash").notNull(),
    activationPromotionId: text("activation_promotion_id").notNull(),
    activationDomainId: text("activation_domain_id").notNull(),
    activationVersionId: text("activation_version_id").notNull(),
    activationReviewReceiptId: text("activation_review_receipt_id").notNull(),
    activationReviewSelectionHash: text(
      "activation_review_selection_hash",
    ).notNull(),
    activationPromotionRecordHash: text(
      "activation_promotion_record_hash",
    ).notNull(),
    status: text("status", { enum: ["committed"] })
      .notNull()
      .default("committed"),
    committedAt: integer("committed_at", { mode: "timestamp_ms" })
      .notNull()
      .default(now),
  },
  (t) => ({
    deploymentAgentUq: uniqueIndex(
      "factory_codeact_authorizations_deployment_agent_uq",
    ).on(
      t.deploymentId,
      t.agentSlug,
    ),
    tenantAgentIdx: index(
      "factory_codeact_authorizations_tenant_agent_idx",
    ).on(t.tenantId, t.agentSlug),
    deploymentIdx: index("factory_codeact_authorizations_deployment_idx").on(
      t.deploymentId,
    ),
  }),
);

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
  events,
  eventListeners,
  runs,
  steps,
  tasks,
  artifacts,
  businessRecords,
  auditLog,
  apiTokens,
  eventTypes,
  entityTypes,
  tenantBudgets,
  llmBudgetReservations,
  meta,
  webhookSubscriptions,
  agentMemoryShort,
  agentMemoryLong,
  idempotencyKeys,
  operationLeases,
  factoryDomainBindings,
  factoryConversations,
  factoryReflections,
  factoryRuns,
  factorySkills,
  factoryTools,
  factorySandboxAttempts,
  factorySandboxToolSnapshots,
  factorySandboxModelGrants,
  factorySandboxModelCallUsage,
  factoryToolProbes,
  factoryIntegrationProfiles,
  factoryAuthorizationChallenges,
  factoryCodeActAuthorizations,
  tenantsRelations,
  workflowsRelations,
  workflowVersionsRelations,
  agentsRelations,
  runsRelations,
  stepsRelations,
  tasksRelations,
  eventsRelations,
};
