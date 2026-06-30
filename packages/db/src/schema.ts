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
    tenantSlugUq: uniqueIndex("workflows_tenant_slug_uq").on(t.tenantId, t.slug),
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
    enabled: integer("enabled", { mode: "boolean" })
      .notNull()
      .default(true),
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

export const factoryConversations = sqliteTable(
  "factory_conversations",
  {
    id: text("id").primaryKey(),
    domain: text("domain").notNull(),
    messagesJson: text("messages_json", { mode: "json" }).notNull(),
    ctxJson: text("ctx_json", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => ({
    domainIdx: index("factory_conversations_domain_idx").on(t.domain),
  }),
);

export const factoryReflections = sqliteTable(
  "factory_reflections",
  {
    id: text("id").primaryKey(),
    domain: text("domain").notNull(),
    kind: text("kind").notNull(), // failure | success | caveat
    summary: text("summary").notNull(),
    rootCause: text("root_cause"),
    lesson: text("lesson").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => ({
    domainIdx: index("factory_reflections_domain_idx").on(t.domain),
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
    status: text("status").notNull(), // finished | budget_exhausted | turns_exhausted | errored | incomplete | running
    tokensUsed: integer("tokens_used").notNull().default(0),
    turns: integer("turns").notNull().default(0),
    agentsCount: integer("agents_count").notNull().default(0),
    reachedTerminal: integer("reached_terminal", { mode: "boolean" }).notNull().default(false),
    errorMessage: text("error_message"),
    transcriptJson: text("transcript_json", { mode: "json" }),
    // Soft delete (0021): the 历史运行 trash/clear sets this; listRuns hides non-null rows and a
    // reconnect to a soft-deleted run replays a tombstone. Recoverable via restoreRun.
    deletedAt: integer("deleted_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => ({
    domainIdx: index("factory_runs_domain_idx").on(t.domain, t.createdAt),
    deletedAtIdx: index("factory_runs_deleted_at_idx").on(t.deletedAt),
  }),
);

export const factorySkills = sqliteTable(
  "factory_skills",
  {
    slug: text("slug").primaryKey(),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    promptFragment: text("prompt_fragment").notNull().default(""),
    tools: text("tools", { mode: "json" }).notNull(),
    decisionRule: text("decision_rule").notNull().default(""),
    domain: text("domain"), // null = cross-domain (general)
    useCount: integer("use_count").notNull().default(0),
    evalCount: integer("eval_count").notNull().default(0),
    successCount: integer("success_count").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => ({
    domainIdx: index("factory_skills_domain_idx").on(t.domain),
  }),
);

export const factoryTools = sqliteTable(
  "factory_tools",
  {
    name: text("name").primaryKey(),
    description: text("description").notNull().default(""),
    method: text("method").notNull().default("GET"),
    urlTemplate: text("url_template").notNull().default(""),
    headers: text("headers", { mode: "json" }),
    bodyTemplate: text("body_template"),
    sideEffect: text("side_effect").notNull().default("read"),
    domain: text("domain"),
    // R6 (0022): typed I/O contracts — the tool's args + return shape (also the egress contract
    // for an external-platform handoff), so the step-engine can validate and agents agree on shapes.
    paramsSchema: text("params_schema", { mode: "json" }),
    returnsSchema: text("returns_schema", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => ({
    domainIdx: index("factory_tools_domain_idx").on(t.domain),
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
  factoryConversations,
  factoryReflections,
  factoryRuns,
  factorySkills,
  factoryTools,
  tenantsRelations,
  workflowsRelations,
  workflowVersionsRelations,
  agentsRelations,
  runsRelations,
  stepsRelations,
  tasksRelations,
  eventsRelations,
};
