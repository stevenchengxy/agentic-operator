import { z } from "zod";
import { ActorEnum } from "./agents";
import { ManifestDiff } from "./agents";

export const DagAgent = z.object({
  id: z.string(),
  kebabId: z.string(),
  name: z.string(),
  title: z.string(),
  actor: ActorEnum,
  triggers: z.array(z.string()),
  emits: z.array(z.string()),
  stage: z.number(),
  recentRunCount: z.number(),
  isLive: z.boolean(),
});
export type DagAgent = z.infer<typeof DagAgent>;

export const DagEdge = z.object({
  fromAgent: z.string(),
  toAgent: z.string(),
  event: z.string(),
  active: z.boolean(),
});
export type DagEdge = z.infer<typeof DagEdge>;

export const DagResponse = z.object({
  agents: z.array(DagAgent),
  edges: z.array(DagEdge),
  workflowVersion: z.string(),
});

/**
 * Import-workflow-manifest types — power the 6-step wizard at
 * `/v1/tenants/:slug/manifest-import`. Two modes share one body:
 *   - validate: dry-run + inserts the pending `deployments` lock row.
 *                The deployment row's `id` IS the session token — the SPA
 *                threads it through to the eventual commit via
 *                `body.deployment_id`. No separate `imp-` prefix exists.
 *   - commit:   promotes to live, hot-swaps Inngest. The `stage` mode from
 *                an earlier draft was dropped per principal-engineer review
 *                C3 (the staging file added no durability above what the DB
 *                already provides).
 *
 * See docs/design/import-workflow-manifest.md for the full contract.
 */

// Conflict resolution — declared first so Conflict.auto_fix can reference it.
export const ConflictResolution = z.object({
  path: z.string(),
  action: z.enum(["accept_suggestion", "skip", "override"]),
  override_value: z.unknown().optional(),
});
export type ConflictResolution = z.infer<typeof ConflictResolution>;

export const Issue = z.object({
  /** JSON pointer into the migrated manifest (e.g. `agents[3].trigger[0]`). */
  path: z.string(),
  message: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  /** Machine-readable: `duplicate_kebab_id`, `unknown_subflow`, `trigger_cycle`, … */
  code: z.string(),
});
export type Issue = z.infer<typeof Issue>;

/**
 * Conflict type codes. The six v0 codes plus five added per principal-engineer
 * review C4: `invalid_cron`, `dangling_emitter`, `silent_rename`,
 * `broken_subflow`, `prompt_injection_smell`. See
 * `docs/design/import-workflow-manifest.md` §"Validation pipeline".
 */
export const ConflictType = z.enum([
  "kebab_id_collision",
  "dangling_trigger",
  "dangling_emitter",
  "orphan_actor",
  "model_not_configured",
  "concurrency_excess",
  "schema_version_downgrade",
  "invalid_cron",
  "silent_rename",
  "broken_subflow",
  "prompt_injection_smell",
]);
export type ConflictType = z.infer<typeof ConflictType>;

export const Conflict = z.object({
  path: z.string(),
  type: ConflictType,
  /** `block` = commit refuses unless resolved; `warn` = informational. */
  severity: z.enum(["block", "warn"]),
  detail: z.string(),
  suggestion: z.string().optional(),
  auto_fix: ConflictResolution.optional(),
});
export type Conflict = z.infer<typeof Conflict>;

export const ManifestImportBody = z.object({
  mode: z.enum(["validate", "commit"]),
  /** Raw manifest input — may be a bare array (v1) or `{ $schemaVersion, agents }` (v2). */
  workflow: z.unknown(),
  actions: z.array(z.unknown()).optional(),
  target: z.enum(["staging", "production"]).default("production"),
  /**
   * Required on commit when the overwrite guard would otherwise trip 409.
   * Per review A4 the canonical surface is `?confirm=1` on the query string,
   * but the body field is preserved as a fallback for v1 callers.
   */
  confirm_overwrite: z.boolean().default(false),
  /**
   * Links a `validate` call to its eventual `commit`. Per review A2 this is
   * the `dpl-` id of the pending deployment row — no separate `imp-` prefix.
   * Optional; commit can run cold (without a prior validate).
   */
  deployment_id: z.string().optional(),
  note: z.string().max(500).optional(),
  conflict_resolutions: z.array(ConflictResolution).default([]),
});
export type ManifestImportBody = z.infer<typeof ManifestImportBody>;

export const ManifestImportPreview = z.object({
  ok: z.boolean(),
  schema_version: z.number(),
  parsed: z.object({
    agents: z.number(),
    events: z.number(),
    actions: z.number(),
  }),
  issues: z.array(Issue),
  conflicts: z.array(Conflict),
  diff: ManifestDiff,
  prior: z.object({
    version: z.string().nullable(),
    agents: z.number(),
    live_deployment_id: z.string().nullable(),
  }),
  /**
   * Pending `deployments.id` (the `dpl-` session token). The SPA passes this
   * back as `body.deployment_id` on the commit call. Per review A2.
   */
  deployment_id: z.string(),
  workflow_version_id: z.string().optional(),
  /** Elapsed wall-clock ms for the validate pipeline (per review O5). */
  elapsed_ms: z.number(),
});
export type ManifestImportPreview = z.infer<typeof ManifestImportPreview>;

export const ManifestImportCommit = z.object({
  ok: z.literal(true),
  workflow_version_id: z.string(),
  /**
   * Stable workflow_versions.version string (e.g. `auto-<8char-hash>`).
   * Preserved per review M1 so the legacy `POST /v1/agents` thin wrapper
   * keeps its response shape and any existing agents-sdk client still
   * parses cleanly.
   */
  version: z.string(),
  deployment_id: z.string(),
  target: z.enum(["staging", "production"]),
  inngest_fns_registered: z.number(),
  inngest_activation: z.object({
    verified: z.literal(true),
    app_id: z.string(),
    expected_function_count: z.number().int().nonnegative(),
    observed_function_count: z.number().int().nonnegative(),
    evidence: z.enum(["dev_graphql", "cloud_sync_acceptance", "test_only_bypass"]),
    checked_at: z.string(),
  }),
  file_written: z.string(),
  prior_deployment_id: z.string().nullable(),
  /** Exact live-vs-new diff used by the overwrite guard and legacy editor. */
  diff: ManifestDiff,
  note: z.string(),
  /** Elapsed wall-clock ms for the commit pipeline (per review O5). */
  elapsed_ms: z.number(),
});
export type ManifestImportCommit = z.infer<typeof ManifestImportCommit>;

/**
 * 409 error envelope when the overwrite guard fires. The SPA renders an
 * `OverwriteConfirmModal` with the diff + conflicts and re-submits with
 * `?confirm=1` (or body `confirm_overwrite: true` as a fallback).
 */
export const ManifestImportOverwriteRequired = z.object({
  ok: z.literal(false),
  requires_confirmation: z.literal(true),
  reason: z.enum(["removes_agents", "modifies_threshold"]),
  diff: ManifestDiff,
  conflicts: z.array(Conflict),
});
export type ManifestImportOverwriteRequired = z.infer<
  typeof ManifestImportOverwriteRequired
>;
