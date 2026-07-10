/**
 * Manifest import service — the 6-step wizard's backend.
 *
 * Two modes share one pipeline:
 *
 *   validate — runtime migrate → Zod parse → lint → diff vs live. Inserts a
 *              `deployments(status='pending', expires_at=now+1h)` lock row
 *              whose `id` IS the import session token (per review A2). A
 *              second validate for the same tenant finds the lock and the
 *              route returns 423. The DB row holds the manifest in
 *              `workflow_versions.manifest_json` so resume-after-refresh
 *              works without disk staging.
 *
 *   commit   — same pipeline, then four atomic phases per review C1
 *              (see docs/design/import-workflow-manifest.md §"Commit
 *              transaction sequence"):
 *                PHASE 1 — preflight (no IO): migrate + parse + lint + diff
 *                          + apply resolutions + overwrite-guard.
 *                PHASE 2 — write `data/imports/<deployment_id>/workflow.json`
 *                          (and actions.json if present) + fsync.
 *                PHASE 3 — atomic SQLite tx: demote live, upsert
 *                          workflow_versions + deployment (file_path
 *                          pointing at the tmp file), upsert agents +
 *                          agent_versions, replace event_listeners, write
 *                          audit_log row.
 *                PHASE 4 — atomic `fs.rename()` into
 *                          `models/<slug>-vN/workflow_v<N+1>.json`, update
 *                          `deployments.file_path` to the final location,
 *                          re-register Inngest functions.
 *
 *              The order is load-bearing: `bootstrap.ts` rebuilds the
 *              Inngest function set from disk via `composeTenantRegistries`,
 *              so a crash between DB commit and disk rename used to leave
 *              the runtime stale forever (the DB said "new live" while the
 *              file_path pointed at a tmp file the loader never visited).
 *              `reconcileImports` (boot-time) now repairs that case.
 *
 * Observability:
 *   - Every validate / commit / cancel emits an `audit_log` row via the
 *     existing `writeAudit()` helper (per review O1). The `events` table is
 *     the Inngest event ledger and is no longer abused for audit traffic —
 *     a `WORKFLOW_DEPLOYED` row there would route through `event_listeners`
 *     and trigger any agent listening on the name.
 *   - Hot-swap and rename failures emit `manifest.import.fail_swap` /
 *     `.fail_rename` audit rows and `req.log.error` lines (per review O2).
 *
 * better-sqlite3 transactions are *synchronous*. Do not `await` DB calls;
 * wrap any multi-statement work in `db.transaction(() => { ... })()`.
 */

import { mkdir, readdir, readFile, stat, writeFile, rm, rename } from "node:fs/promises";
import { openSync, fsyncSync, closeSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  agents,
  agentVersions,
  deployments,
  eventListeners,
  getDb,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { eq, and, lt } from "drizzle-orm";
import { makeId } from "@agentic/shared";
import type {
  ManifestImportBody,
  ManifestImportPreview,
  ManifestImportCommit,
  ManifestImportOverwriteRequired,
  ManifestDiff,
  ConflictResolution,
  Conflict,
  Issue,
} from "@agentic/contracts";
import {
  WorkflowManifestSchema,
  ActionsManifestSchema,
  migrate,
  tenantSlugFromFolder,
  lint,
  publishStreamEvent,
  type LintConflict,
  type LintIssue,
  type LiveWorkflowSnapshot,
  type AgentSpec,
  type WorkflowManifest,
} from "@agentic/runtime";
import { getLLMGateway } from "./llm";
import { reregisterInngest } from "./inngest-registry";
import { writeAudit } from "../plugins/audit";

// Overwrite-guard knobs. The compound rule (per review C2 + PRD §"Overwrite
// guard") replaces the single-ratio "≥30% modified" check that under-fired
// on tiny manifests and over-fired on 1-agent flows. Tunable for fleet-wide
// experiments but the defaults match the PRD's worked-example table:
//   priorN=1   → mod≥1 or churn≥3
//   priorN=3   → mod≥1 or churn≥3
//   priorN=10  → mod≥3 or churn≥5
//   priorN=100 → mod≥30 or churn≥50
const OVERWRITE_MOD_RATIO = Number(process.env.AGENTIC_OVERWRITE_MOD_RATIO ?? "0.30");
const OVERWRITE_CHURN_RATIO = Number(
  process.env.AGENTIC_OVERWRITE_CHURN_RATIO ?? "0.50",
);
const OVERWRITE_MOD_FLOOR = Number(process.env.AGENTIC_OVERWRITE_MOD_FLOOR ?? "1");
const OVERWRITE_CHURN_FLOOR = Number(
  process.env.AGENTIC_OVERWRITE_CHURN_FLOOR ?? "3",
);

/**
 * Stable per-manifest hash matching the runtime bootstrap's convention. We
 * keep the format identical so a follow-on `bootstrapTenant()` call (which
 * runs on every `reregisterInngest()`) finds our just-inserted workflow
 * version by name and won't insert a duplicate `auto-<hash>` deployment
 * that would demote our import row.
 */
function manifestHash(m: unknown): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(m))
    .digest("hex")
    .slice(0, 8);
}
const PENDING_TTL_MS = Number(
  process.env.AGENTIC_IMPORT_PENDING_TTL_MS ?? String(60 * 60 * 1000),
);
const CONCURRENCY_MAX = Number(
  process.env.RUNTIME_CONCURRENCY_MAX ?? "8",
);

/**
 * Best-effort fsync helper. The async `writeFile` resolves once the kernel
 * has accepted the bytes; a crash before fsync can lose them. Open the path
 * synchronously (we just wrote it), fsync, close. Swallow EBADF so this is
 * safe on filesystems that don't support fsync on regular files.
 */
function fsyncBestEffort(filePath: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, "r");
    fsyncSync(fd);
  } catch {
    /* ignore */
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export class OverwriteRequiredError extends Error {
  constructor(public readonly payload: ManifestImportOverwriteRequired) {
    super("overwrite_required");
    this.name = "OverwriteRequiredError";
  }
}

export class BlockingIssuesError extends Error {
  constructor(public readonly issues: Issue[]) {
    super("blocking_issues");
    this.name = "BlockingIssuesError";
  }
}

/**
 * Thrown when a second `validate` collides with an existing pending lock.
 * The route maps this to HTTP 423 with the in-flight `deployment_id`.
 * Per review A2 the in-flight identifier is the `dpl-` id — there is no
 * separate `imp-` session prefix.
 */
export class PendingImportConflictError extends Error {
  constructor(public readonly deploymentId: string) {
    super("pending_import_in_flight");
    this.name = "PendingImportConflictError";
  }
}

export interface TenantCtx {
  /** Internal tenants.id PK (e.g. `ten-…`). */
  tenantId: string;
  /** Tenant slug used in event namespacing, models folder, paths. */
  tenantSlug: string;
}

/**
 * Optional audit context — when present the service emits structured error
 * logs via the route's pino logger so the SRE pipeline can correlate
 * disk-write / hot-swap failures with the audit_log row. Untyped because
 * services should not depend on `FastifyBaseLogger`.
 */
export interface AuditCtx {
  log?: {
    error: (obj: Record<string, unknown>, msg?: string) => void;
    info?: (obj: Record<string, unknown>, msg?: string) => void;
  };
  actorUserId?: string;
}

/**
 * `writeAudit` may throw if the DB is closed (test teardown). Audit is
 * best-effort so we never want a logging failure to mask the real error.
 */
function writeAuditSafely(
  auditCtx: AuditCtx | undefined,
  entry: Parameters<typeof writeAudit>[0],
): void {
  try {
    writeAudit({
      ...entry,
      actorUserId: entry.actorUserId ?? auditCtx?.actorUserId,
    });
  } catch (err) {
    auditCtx?.log?.error?.(
      { err: (err as Error).message, action: entry.action },
      "audit write failed",
    );
  }
}

/** Resolve repo data dir for staging files. */
function importsRoot(): string {
  return process.env.AGENTIC_IMPORTS_DIR
    ? process.env.AGENTIC_IMPORTS_DIR
    : path.join(process.env.AGENTIC_DATA_DIR ?? "./data", "imports");
}

function modelsRoot(): string {
  const env = process.env.AGENTIC_MODELS_DIR;
  if (!env) {
    throw new Error(
      "AGENTIC_MODELS_DIR is not set — the api process must point at a models directory.",
    );
  }
  return path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
}

// (Per review O4: the NDJSON import log under
// `data/logs/<tenant>/imports/<date>.ndjson` was the v0 observability
// surface. It's removed in favour of `audit_log` rows with
// `action LIKE 'manifest.import.%'`. `GET /v1/audit-log?action=…` is the
// canonical read path; operators don't need shell access to inspect
// import history.)

/** Find tenant model dirs (mirrors workflowRoutes#findTenantDirs). */
async function findTenantDirs(
  slug: string,
): Promise<Array<{ folder: string; version: number; absDir: string }>> {
  const root = modelsRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const matches: Array<{ folder: string; version: number; absDir: string }> = [];
  for (const folder of entries) {
    if (folder.startsWith(".")) continue;
    const abs = path.join(root, folder);
    let isDir = false;
    try {
      isDir = (await stat(abs)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (tenantSlugFromFolder(folder) !== slug) continue;
    const m = folder.match(/-v(\d+)$/i);
    const version = m ? Number(m[1]) : 1;
    matches.push({ folder, version, absDir: abs });
  }
  matches.sort((a, b) => b.version - a.version);
  return matches;
}

async function pickNextVersion(
  dir: string,
  prefix: "workflow" | "actions",
): Promise<{ filename: string; nextVersion: number }> {
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    files = [];
  }
  let max = 0;
  const re = new RegExp(`^${prefix}(?:_v(\\d+))?\\.json$`, "i");
  for (const f of files) {
    const m = f.match(re);
    if (!m) continue;
    const v = m[1] ? Number(m[1]) : 1;
    if (v > max) max = v;
  }
  const next = max + 1;
  return { filename: `${prefix}_v${next}.json`, nextVersion: next };
}

// ---- Diff -----------------------------------------------------------------

/**
 * Compare two manifests by `id`. JSON-stringify equality for "modified".
 * Order-insensitive; doesn't diff actions.json.
 */
export function diffManifests(
  prior: ReadonlyArray<AgentSpec> | ReadonlyArray<{ id: string }>,
  next: ReadonlyArray<AgentSpec> | ReadonlyArray<{ id: string }>,
  priorVersionString: string | null,
): ManifestDiff {
  const priorMap = new Map<string, string>();
  const nextMap = new Map<string, string>();
  for (const a of prior) priorMap.set(a.id, JSON.stringify(a));
  for (const a of next) nextMap.set(a.id, JSON.stringify(a));
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [id, json] of nextMap) {
    const oldJson = priorMap.get(id);
    if (!oldJson) added.push(id);
    else if (oldJson !== json) modified.push(id);
  }
  for (const id of priorMap.keys()) {
    if (!nextMap.has(id)) removed.push(id);
  }
  return {
    added: added.sort(),
    removed: removed.sort(),
    modified: modified.sort(),
    prior_version: priorVersionString,
  };
}

// ---- Lint adapter ---------------------------------------------------------

/**
 * Convert runtime LintIssue/Conflict (plain TS shape) to the contract
 * Zod-validated shape. Identity copy; the divergence is purely at the type
 * boundary — runtime can't import @agentic/contracts.
 */
function adaptIssues(issues: ReadonlyArray<LintIssue>): Issue[] {
  return issues.map((i) => ({
    path: i.path,
    message: i.message,
    severity: i.severity,
    code: i.code,
  }));
}
function adaptConflicts(conflicts: ReadonlyArray<LintConflict>): Conflict[] {
  return conflicts.map((c) => ({
    path: c.path,
    type: c.type,
    severity: c.severity,
    detail: c.detail,
    suggestion: c.suggestion,
    auto_fix: c.auto_fix
      ? {
          path: c.auto_fix.path,
          action: c.auto_fix.action,
          override_value: c.auto_fix.override_value,
        }
      : undefined,
  }));
}

// ---- Resolutions ----------------------------------------------------------

/**
 * Walk a JSON pointer of the form `agents[3].trigger[0]` against the bare
 * manifest array. Returns `{ obj, key }` for the *parent* of the leaf so
 * the caller can mutate `obj[key]`. Returns null for unresolvable paths.
 */
function resolveJsonPath(
  manifest: WorkflowManifest,
  pointer: string,
): { obj: Record<string, unknown> | unknown[]; key: string | number } | null {
  // Tokens: agents[N], <name>, <name>[N]
  const tokens = pointer.match(/[^.[\]]+|\[\d+\]/g);
  if (!tokens || tokens.length === 0) return null;
  let cur: unknown = { agents: manifest };
  let parent: unknown = null;
  let parentKey: string | number = "";
  for (const raw of tokens) {
    parent = cur;
    if (raw.startsWith("[")) {
      const idx = Number(raw.slice(1, -1));
      parentKey = idx;
      if (!Array.isArray(cur)) return null;
      cur = (cur as unknown[])[idx];
    } else {
      parentKey = raw;
      if (!cur || typeof cur !== "object") return null;
      cur = (cur as Record<string, unknown>)[raw];
    }
    if (cur === undefined && tokens.indexOf(raw) < tokens.length - 1) return null;
  }
  if (!parent || typeof parent !== "object") return null;
  return {
    obj: parent as Record<string, unknown> | unknown[],
    key: parentKey,
  };
}

/**
 * Mutate manifest in place per the operator's resolutions.
 *
 *   - `accept_suggestion` with `override_value=null` ⇒ drop the leaf (or
 *      delete the array element). The auto-fix encodes the intent.
 *   - `accept_suggestion` with a non-null `override_value` ⇒ set the leaf.
 *   - `skip` ⇒ drop the entire agent at the path's `agents[N]` prefix
 *      (matches the wizard's "Skip agent · don't import" label). For
 *      structural blockers like `orphan_actor` there is no per-field fix —
 *      skipping the conflict only makes sense if the agent is removed
 *      from the import, otherwise the re-lint at commit time reproduces
 *      the same blocker and the deploy is refused. Resolutions whose path
 *      doesn't start with `agents[N]` are ignored on skip (no agent to
 *      drop).
 *   - `override` ⇒ set the leaf to `override_value` (operator-chosen).
 *
 * Non-skip mutations are applied first against the cloned manifest so the
 * `agents[N]` indices in their paths still resolve. Skipped agents are
 * removed in a second pass, highest-index-first, so the splice doesn't
 * shift indices the first pass relied on.
 */
export function applyResolutions(
  manifest: WorkflowManifest,
  resolutions: ReadonlyArray<ConflictResolution>,
): { manifest: WorkflowManifest; appliedPaths: string[] } {
  // Copy first to keep the original input pristine. Deep-clone via JSON
  // is fine here: manifest is plain JSON.
  const cloned = JSON.parse(JSON.stringify(manifest)) as WorkflowManifest;
  const applied: string[] = [];

  // Pass 1 — apply accept_suggestion / override. Skip resolutions are
  // deferred so the per-field mutations below all see the original
  // `agents[N]` index space.
  const skipAgentIndices = new Set<number>();
  for (const r of resolutions) {
    if (r.action === "skip") {
      const m = r.path.match(/^agents\[(\d+)\]/);
      if (m) {
        skipAgentIndices.add(Number(m[1]));
        applied.push(r.path);
      }
      continue;
    }
    const target = resolveJsonPath(cloned, r.path);
    if (!target) continue;
    const value =
      r.action === "accept_suggestion" || r.action === "override"
        ? r.override_value
        : undefined;
    if (Array.isArray(target.obj)) {
      const idx = Number(target.key);
      if (value === null || value === undefined) {
        target.obj.splice(idx, 1);
      } else {
        target.obj[idx] = value;
      }
    } else {
      const key = String(target.key);
      if (value === null || value === undefined) {
        delete (target.obj as Record<string, unknown>)[key];
      } else {
        (target.obj as Record<string, unknown>)[key] = value;
      }
    }
    applied.push(r.path);
  }

  // Pass 2 — drop skipped agents. High-to-low so earlier splices don't
  // shift the indices later splices rely on.
  const sortedDrops = Array.from(skipAgentIndices).sort((a, b) => b - a);
  for (const idx of sortedDrops) {
    if (idx >= 0 && idx < cloned.length) {
      cloned.splice(idx, 1);
    }
  }

  return { manifest: cloned, appliedPaths: applied };
}

// ---- Live snapshot --------------------------------------------------------

interface LiveSnapshot {
  versionString: string | null;
  agents: AgentSpec[];
  liveDeploymentId: string | null;
  workflowId: string;
  workflowVersionId: string | null;
}

function loadLiveSnapshot(ctx: TenantCtx): LiveSnapshot {
  const db = getDb();
  // The bootstrap path uses a per-tenant workflow slug `${tenantSlug}-default`.
  // Look it up here; an absent workflow means a first-time tenant (no prior live).
  const workflowSlug = `${ctx.tenantSlug}-default`;
  const wf = db
    .select()
    .from(workflows)
    .where(
      and(eq(workflows.tenantId, ctx.tenantId), eq(workflows.slug, workflowSlug)),
    )
    .all()[0];
  if (!wf) {
    return {
      versionString: null,
      agents: [],
      liveDeploymentId: null,
      workflowId: "",
      workflowVersionId: null,
    };
  }
  const liveRow = db
    .select({
      depId: deployments.id,
      versionId: deployments.versionId,
      version: workflowVersions.version,
      manifestJson: workflowVersions.manifestJson,
    })
    .from(deployments)
    .innerJoin(workflowVersions, eq(workflowVersions.id, deployments.versionId))
    .where(
      and(
        eq(deployments.tenantId, ctx.tenantId),
        eq(deployments.target, "workflow"),
        eq(deployments.status, "live"),
      ),
    )
    .all()[0];
  return {
    versionString: liveRow?.version ?? null,
    agents: (liveRow?.manifestJson as AgentSpec[] | null) ?? [],
    liveDeploymentId: liveRow?.depId ?? null,
    workflowId: wf.id,
    workflowVersionId: liveRow?.versionId ?? null,
  };
}

/** The tenant's current LIVE workflow agents (the raw committed manifest array). Exported
 *  for the factory's draft-promotion merge: promoting agents must be ADDITIVE — keep all of
 *  the tenant's existing agents and only add/replace by id — never clobber the live workflow
 *  the way a throwaway sandbox tenant can be replaced. Empty array for a first-time tenant. */
export function loadLiveManifest(ctx: TenantCtx): unknown[] {
  return loadLiveSnapshot(ctx).agents as unknown[];
}

function liveSnapshotForLint(live: LiveSnapshot): LiveWorkflowSnapshot {
  const events = new Set<string>();
  for (const a of live.agents) {
    for (const ev of a.triggered_event ?? []) events.add(ev);
  }
  return {
    agents: live.agents.map((a) => ({
      id: a.id,
      name: a.name,
      trigger: a.trigger ?? [],
      triggered_event: a.triggered_event ?? [],
    })),
    events: [...events],
  };
}

// ---- Pipeline -------------------------------------------------------------

interface PipelineResult {
  /**
   * Canonical (Zod-parsed + strip-unknown) form of the manifest. This is
   * what gets persisted into `workflow_versions.manifest_json` and written
   * to disk; the runtime bootstrap rehydrates from exactly this shape, so
   * hashing this is what produces the `auto-<hash>` version string that
   * matches subsequent bootstrap passes.
   */
  migrated: WorkflowManifest;
  /**
   * Enriched form: parsed manifest + any non-canonical extra fields the
   * fixture carried (e.g. `model`, `concurrency`, `tool_use`). The linter
   * inspects this so it can flag `model_not_configured` etc., even though
   * the canonical form drops those fields.
   */
  forLint: WorkflowManifest;
  actions: unknown[] | undefined;
  issues: Issue[];
  conflicts: Conflict[];
  diff: ManifestDiff;
  prior: LiveSnapshot;
  schemaVersion: number;
}

async function runPipeline(
  input: ManifestImportBody,
  ctx: TenantCtx,
): Promise<PipelineResult> {
  // 1. migrate raw → bare array
  const migration = migrate(input.workflow);
  // 2. Zod-parse the migrated manifest
  const parsed = WorkflowManifestSchema.safeParse(migration.payload);
  if (!parsed.success) {
    const issues: Issue[] = parsed.error.issues.slice(0, 50).map((i) => ({
      path: "agents." + i.path.join("."),
      message: i.message,
      severity: "error" as const,
      code: i.code ?? "zod_invalid",
    }));
    // Even on parse failure we want to return a structured response with
    // every issue so the SPA can render them in step 2. Construct a best-
    // effort empty pipeline result.
    const live = loadLiveSnapshot(ctx);
    return {
      migrated: [],
      forLint: [],
      actions: undefined,
      issues,
      conflicts: [],
      diff: { added: [], removed: [], modified: [], prior_version: live.versionString },
      prior: live,
      schemaVersion: migration.toVersion,
    };
  }
  const manifestRaw = parsed.data as unknown as WorkflowManifest;
  // For lint, we keep the raw migrated payload alongside the parsed one. The
  // AgentSchema in this codebase strips unknown fields by default, so a
  // strict parse drops `model`, `concurrency`, `tool_use`, `cron`, etc — but
  // the linter needs to see them to flag `model_not_configured`,
  // `concurrency_excess`, and `orphan_actor`. Merge field-by-field.
  const rawArray = Array.isArray(migration.payload)
    ? (migration.payload as Array<Record<string, unknown>>)
    : [];
  const enriched: WorkflowManifest = (manifestRaw as unknown as Array<Record<string, unknown>>).map(
    (a, i) => {
      const rawAgent = rawArray[i];
      if (!rawAgent || typeof rawAgent !== "object") return a as unknown as AgentSpec;
      return { ...rawAgent, ...a } as unknown as AgentSpec;
    },
  ) as unknown as WorkflowManifest;

  // 3. Apply operator resolutions BEFORE diff/lint so the displayed counts
  //    match what will be committed. We apply to both views so the canonical
  //    form stays in lockstep with the enriched lint view.
  const { manifest: canonical } = applyResolutions(
    manifestRaw,
    input.conflict_resolutions ?? [],
  );
  const { manifest } = applyResolutions(enriched, input.conflict_resolutions ?? []);

  // 4. Validate actions (loose schema is intentional — actions.json is
  //    documentation-ish; only the workflow.json carries runtime contracts).
  let actions: unknown[] | undefined;
  if (input.actions !== undefined) {
    const ap = ActionsManifestSchema.safeParse(input.actions);
    if (!ap.success) {
      const live = loadLiveSnapshot(ctx);
      return {
        migrated: canonical,
        forLint: manifest,
        actions: input.actions,
        issues: ap.error.issues.slice(0, 50).map((i) => ({
          path: "actions." + i.path.join("."),
          message: i.message,
          severity: "error" as const,
          code: i.code ?? "actions_invalid",
        })),
        conflicts: [],
        diff: { added: [], removed: [], modified: [], prior_version: live.versionString },
        prior: live,
        schemaVersion: migration.toVersion,
      };
    }
    actions = ap.data as unknown[];
  }

  // 5. Diff against live FIRST so the linter knows which kebab_ids are about
  //    to be removed (used by `broken_subflow`).
  const live = loadLiveSnapshot(ctx);
  const diff = diffManifests(live.agents, canonical, live.versionString);
  const removedKebabIds = new Set(diff.removed);
  // Lint context: providers, concurrency cap, removedKebabIds, live id map.
  const gateway = (() => {
    try {
      return getLLMGateway();
    } catch {
      return null;
    }
  })();
  const providerIds = gateway
    ? gateway.listProviders().map((p) => p.id as string)
    : ["mock"];
  // Build live kebab → id map (for silent_rename detection). Pre-review the
  // lint never saw the live `id` field so renames slipped through.
  const liveAgentIds = new Map<string, string>();
  for (const la of live.agents) liveAgentIds.set(la.id, la.id);
  // 6. Lint with the full context.
  const lintRes = lint(manifest, {
    liveWorkflow: live.agents.length > 0 ? liveSnapshotForLint(live) : undefined,
    llmProviders: providerIds,
    concurrencyMax: CONCURRENCY_MAX,
    removedKebabIds,
    liveAgentIds,
  });

  return {
    migrated: canonical,
    forLint: manifest,
    actions,
    issues: adaptIssues(lintRes.issues),
    conflicts: adaptConflicts(lintRes.conflicts),
    diff,
    prior: live,
    schemaVersion: migration.toVersion,
  };
}

function eventsFromManifest(manifest: WorkflowManifest): Set<string> {
  const set = new Set<string>();
  for (const a of manifest) {
    for (const ev of a.trigger) set.add(ev);
    for (const ev of a.triggered_event) set.add(ev);
  }
  return set;
}

// ---- Overwrite guard ------------------------------------------------------

/**
 * Compound overwrite rule (per PRD §"Overwrite guard" + review C2):
 *   trip := removed ≥ 1
 *        || modified ≥ max(OVERWRITE_MOD_FLOOR, ceil(0.30 * priorN))
 *        || added + removed + modified
 *             ≥ max(OVERWRITE_CHURN_FLOOR, ceil(0.50 * priorN))
 *
 * The single-ratio "≥30% modified" check from the v0 draft fell apart on
 * small manifests: at priorN=1 the ratio rounds to 1 (any change trips),
 * at priorN=3 it trips on a single modification, but at priorN=100 it
 * silently let 29 modifications through. The compound rule layers absolute
 * floors on top of ratios so the guard fires sensibly across the size
 * spectrum. See PRD worked examples for n=1,3,10,100.
 */
export function overwriteGuard(
  diff: ManifestDiff,
  priorAgentCount: number,
  conflicts: Conflict[],
  opts: { confirmOverwrite: boolean },
): ManifestImportOverwriteRequired | null {
  if (opts.confirmOverwrite) return null;
  if (priorAgentCount === 0) return null; // first deploy — never trips
  // (1) Any removal trips, regardless of manifest size.
  if (diff.removed.length >= 1) {
    return {
      ok: false,
      requires_confirmation: true,
      reason: "removes_agents",
      diff,
      conflicts,
    };
  }
  // (2) Modification ratio with absolute floor.
  const modThreshold = Math.max(
    OVERWRITE_MOD_FLOOR,
    Math.ceil(OVERWRITE_MOD_RATIO * priorAgentCount),
  );
  if (diff.modified.length >= modThreshold) {
    return {
      ok: false,
      requires_confirmation: true,
      reason: "modifies_threshold",
      diff,
      conflicts,
    };
  }
  // (3) Total churn ratio with absolute floor.
  const churn = diff.added.length + diff.removed.length + diff.modified.length;
  const churnThreshold = Math.max(
    OVERWRITE_CHURN_FLOOR,
    Math.ceil(OVERWRITE_CHURN_RATIO * priorAgentCount),
  );
  if (churn >= churnThreshold) {
    return {
      ok: false,
      requires_confirmation: true,
      reason: "modifies_threshold",
      diff,
      conflicts,
    };
  }
  return null;
}

// ---- Public API: validate -------------------------------------------------

/**
 * Look up the in-flight pending deployment for a tenant, if any. Used by the
 * validate path to enforce the one-pending-per-tenant invariant (the
 * import-session lock) and by the route's 423 LOCKED response. A row past
 * its expires_at is treated as released — boot-time `reconcileImports`
 * sweeps stale rows but we don't want to wait for that.
 */
function findActivePendingImport(
  ctx: TenantCtx,
): { deploymentId: string; workflowVersionId: string } | null {
  const db = getDb();
  const pending = db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.tenantId, ctx.tenantId),
        eq(deployments.target, "workflow"),
        eq(deployments.status, "pending"),
      ),
    )
    .all()[0];
  if (!pending) return null;
  if (pending.expiresAt && pending.expiresAt.getTime() < Date.now()) {
    // Past TTL — drop in line and let the new validate take over.
    db.delete(deployments).where(eq(deployments.id, pending.id)).run();
    return null;
  }
  return {
    deploymentId: pending.id,
    workflowVersionId: pending.versionId,
  };
}

/**
 * validate(): run the pipeline, then upsert a `deployments(status='pending')`
 * lock row whose id IS the import session token (per review A2). The route
 * returns 423 LOCKED if a parallel validate finds an existing pending row.
 *
 * The pending row holds the canonical manifest in
 * `workflow_versions.manifest_json` so the SPA can survive a refresh by
 * re-fetching the deployment_id — no separate disk staging is needed.
 *
 * `validate` itself never writes to disk and never demotes the live row.
 */
export async function validate(
  input: ManifestImportBody,
  ctx: TenantCtx,
  auditCtx?: AuditCtx,
): Promise<ManifestImportPreview> {
  const started = Date.now();

  // One-pending-per-tenant lock policy:
  //   - No body.deployment_id + no pending row → fresh lock (new dpl- id)
  //   - No body.deployment_id + pending row    → auto-reuse the pending row
  //     (single-operator-iterating-in-wizard case; the SPA may have lost the
  //     id across a refresh, or this is the v0 client that doesn't thread it).
  //   - body.deployment_id matches pending row → resume (refresh content)
  //   - body.deployment_id ≠ pending row id     → 423 LOCKED (another operator)
  //
  // The 423 case is the only one that surfaces the in-flight id to the SPA
  // so it can offer a Resume/Cancel banner — see review C5 + design.md
  // §"Wizard back-navigation".
  const existingPending = findActivePendingImport(ctx);
  let reuseDeploymentId: string | null = null;
  if (existingPending) {
    if (!input.deployment_id || input.deployment_id === existingPending.deploymentId) {
      reuseDeploymentId = existingPending.deploymentId;
    } else {
      throw new PendingImportConflictError(existingPending.deploymentId);
    }
  }

  const result = await runPipeline(input, ctx);
  const ok = result.issues.every((i) => i.severity !== "error");

  // Persist the pending lock row. Even when `ok=false` we keep the row —
  // the SPA may show the issues to the operator and they may correct them
  // in place by passing fresh conflict_resolutions to a subsequent validate.
  const deploymentId = reuseDeploymentId ?? makeId("dpl");
  const workflowVersionId = makeId("wfv");
  const db = getDb();
  db.transaction(() => {
    // Lazy-create the tenant workflow row (same shape as bootstrap).
    const workflowSlug = `${ctx.tenantSlug}-default`;
    let wf = db
      .select()
      .from(workflows)
      .where(
        and(eq(workflows.tenantId, ctx.tenantId), eq(workflows.slug, workflowSlug)),
      )
      .all()[0];
    if (!wf) {
      const wfId = makeId("wf");
      db.insert(workflows)
        .values({
          id: wfId,
          tenantId: ctx.tenantId,
          slug: workflowSlug,
          name: workflowSlug,
        })
        .run();
      wf = db.select().from(workflows).where(eq(workflows.id, wfId)).all()[0]!;
    }
    if (reuseDeploymentId) {
      // Refresh the pending row's workflow_version manifest in place.
      const oldRow = db
        .select()
        .from(deployments)
        .where(eq(deployments.id, reuseDeploymentId))
        .all()[0];
      if (oldRow) {
        db.update(workflowVersions)
          .set({
            manifestJson: result.migrated as unknown as object,
            actionsJson: (result.actions ?? null) as unknown as object,
          })
          .where(eq(workflowVersions.id, oldRow.versionId))
          .run();
        db.update(deployments)
          .set({
            expiresAt: new Date(Date.now() + PENDING_TTL_MS),
          })
          .where(eq(deployments.id, reuseDeploymentId))
          .run();
      }
    } else {
      // Fresh pending row.
      db.insert(workflowVersions)
        .values({
          id: workflowVersionId,
          workflowId: wf.id,
          version: `pending-${deploymentId}`,
          manifestJson: result.migrated as unknown as object,
          actionsJson: (result.actions ?? null) as unknown as object,
        })
        .run();
      db.insert(deployments)
        .values({
          id: deploymentId,
          tenantId: ctx.tenantId,
          target: "workflow",
          versionId: workflowVersionId,
          status: "pending",
          note: input.note ?? null,
          expiresAt: new Date(Date.now() + PENDING_TTL_MS),
        })
        .run();
    }
  });

  // Resolve the workflow_version id we actually used (for the response).
  const actualWfvId = reuseDeploymentId
    ? db
        .select({ versionId: deployments.versionId })
        .from(deployments)
        .where(eq(deployments.id, reuseDeploymentId))
        .all()[0]?.versionId ?? workflowVersionId
    : workflowVersionId;

  const elapsedMs = Date.now() - started;
  const preview: ManifestImportPreview = {
    ok,
    schema_version: result.schemaVersion,
    parsed: {
      agents: result.migrated.length,
      events: eventsFromManifest(result.migrated).size,
      actions: result.actions?.length ?? 0,
    },
    issues: result.issues,
    conflicts: result.conflicts,
    diff: result.diff,
    prior: {
      version: result.prior.versionString,
      agents: result.prior.agents.length,
      live_deployment_id: result.prior.liveDeploymentId,
    },
    deployment_id: deploymentId,
    workflow_version_id: actualWfvId,
    elapsed_ms: elapsedMs,
  };

  // Audit row (per review O1) — smaller meta than commit.
  writeAuditSafely(auditCtx, {
    tenantId: ctx.tenantId,
    action: "manifest.import.validate",
    targetType: "deployment",
    targetId: deploymentId,
    meta: {
      ok,
      agents: result.migrated.length,
      issues: result.issues.length,
      conflicts: result.conflicts.length,
      schema_version: result.schemaVersion,
      reused_pending: Boolean(reuseDeploymentId),
      elapsed_ms: elapsedMs,
    },
  });

  return preview;
}

/**
 * cancel(): manually release a pending lock + remove the tmp staging dir.
 * Powers `DELETE /v1/tenants/:slug/manifest-import/:deployment_id` (review
 * C5). Refuses on rows that are not `status='pending'`.
 */
export async function cancel(
  deploymentId: string,
  ctx: TenantCtx,
  auditCtx?: AuditCtx,
): Promise<{ ok: true }> {
  const db = getDb();
  const row = db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .all()[0];
  if (!row) {
    throw new Error("not_found");
  }
  if (row.tenantId !== ctx.tenantId) {
    throw new Error("forbidden");
  }
  if (row.status !== "pending") {
    throw new Error("not_pending");
  }
  db.transaction(() => {
    // Delete the pending row + its workflow_versions row (the version was
    // created for this pending lock specifically — it isn't pointed at by
    // any agent_versions because we never inserted those).
    db.delete(deployments).where(eq(deployments.id, deploymentId)).run();
    db.delete(workflowVersions)
      .where(eq(workflowVersions.id, row.versionId))
      .run();
  });
  // Best-effort tmp dir cleanup.
  try {
    await rm(path.join(importsRoot(), deploymentId), {
      recursive: true,
      force: true,
    });
  } catch {
    /* ignore */
  }
  writeAuditSafely(auditCtx, {
    tenantId: ctx.tenantId,
    action: "manifest.import.cancel",
    targetType: "deployment",
    targetId: deploymentId,
    meta: { tenant_slug: ctx.tenantSlug },
  });
  return { ok: true };
}

// ---- Public API: commit ---------------------------------------------------

/**
 * Pick the next workflow_v<N+1> filename in the tenant's models folder.
 * Atomic O_CREAT|O_EXCL retry on EEXIST per design.md (handles the race
 * where two near-simultaneous commits both pick the same N+1). The handle
 * is closed immediately — the actual content lands via `rename()` later.
 */
async function pickAndReserveNextFilename(
  slug: string,
): Promise<{
  targetDir: string;
  workflowPath: string;
  actionsPath: string;
  nextVersion: number;
}> {
  let targetDir: string;
  const dirs = await findTenantDirs(slug);
  if (dirs.length === 0) {
    targetDir = path.join(modelsRoot(), `${slug}-v1`);
    await mkdir(targetDir, { recursive: true });
  } else {
    targetDir = dirs[0]!.absDir;
  }
  // Atomic reservation: try `workflow_v<N+1>.json` and bump N on EEXIST.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const picked = await pickNextVersion(targetDir, "workflow");
    const wfPath = path.join(targetDir, picked.filename);
    try {
      const fd = openSync(wfPath, "ax"); // O_CREAT|O_EXCL|O_WRONLY
      closeSync(fd);
      return {
        targetDir,
        workflowPath: wfPath,
        actionsPath: path.join(targetDir, `actions_v${picked.nextVersion}.json`),
        nextVersion: picked.nextVersion,
      };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw err;
      // Someone else just claimed N+1; loop and bump.
    }
  }
  throw new Error("could not reserve a unique workflow filename after 8 attempts");
}

export async function commit(
  input: ManifestImportBody,
  ctx: TenantCtx,
  auditCtx?: AuditCtx,
): Promise<ManifestImportCommit> {
  const started = Date.now();
  const result = await runPipeline(input, ctx);

  // PHASE 1 — preflight (no IO)
  // ─────────────────────────────────────────────────────────────────────
  // Hard-stop on parse/struct errors: nothing else will succeed.
  const blocking = result.issues.filter((i) => i.severity === "error");
  if (blocking.length > 0) {
    throw new BlockingIssuesError(blocking);
  }
  // Hard-stop on un-resolved `severity='block'` conflicts.
  const unresolvedBlocking = result.conflicts.filter((c) => c.severity === "block");
  if (unresolvedBlocking.length > 0) {
    throw new BlockingIssuesError(
      unresolvedBlocking.map((c) => ({
        path: c.path,
        message: c.detail,
        severity: "error" as const,
        code: c.type,
      })),
    );
  }
  // Overwrite guard. Returns the 409 envelope when tripped.
  const overwrite = overwriteGuard(
    result.diff,
    result.prior.agents.length,
    result.conflicts,
    { confirmOverwrite: input.confirm_overwrite },
  );
  if (overwrite) {
    throw new OverwriteRequiredError(overwrite);
  }

  const db = getDb();
  // Find the pending lock row for the supplied deployment_id, if any. The
  // wizard path always provides this (validate returned it); the legacy
  // `POST /v1/agents` path runs cold (no deployment_id) and still commits.
  const pendingLockRow = input.deployment_id
    ? db
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.tenantId, ctx.tenantId),
            eq(deployments.id, input.deployment_id),
            eq(deployments.status, "pending"),
          ),
        )
        .all()[0]
    : undefined;
  const deploymentId = pendingLockRow?.id ?? makeId("dpl");
  const desiredVersion = `auto-${manifestHash(result.migrated)}`;

  // PHASE 2 — write tmp staging file + fsync
  // ─────────────────────────────────────────────────────────────────────
  // Per review C1: write the disk artifact BEFORE committing the DB so a
  // crash in phase 3 leaves no observable state mismatch — the new
  // workflow_version row points at `file_path` which is a tmp file the
  // reconciler can finish renaming. Failing in phase 2 leaves only an
  // orphan tmp dir (reconciler GCs it on next boot).
  const tmpDir = path.join(importsRoot(), deploymentId);
  const tmpWorkflowPath = path.join(tmpDir, "workflow.json");
  const tmpActionsPath = path.join(tmpDir, "actions.json");
  try {
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      tmpWorkflowPath,
      JSON.stringify(result.migrated, null, 2) + "\n",
      "utf8",
    );
    fsyncBestEffort(tmpWorkflowPath);
    if (result.actions) {
      await writeFile(
        tmpActionsPath,
        JSON.stringify(result.actions, null, 2) + "\n",
        "utf8",
      );
      fsyncBestEffort(tmpActionsPath);
    }
  } catch (err) {
    // Disk write failed BEFORE any DB change — return 500. Audit + clean up.
    auditCtx?.log?.error?.(
      { err: (err as Error).message, deployment_id: deploymentId, phase: "tmp_write" },
      "manifest-import: tmp file write failed",
    );
    writeAuditSafely(auditCtx, {
      tenantId: ctx.tenantId,
      action: "manifest.import.fail_swap",
      targetType: "deployment",
      targetId: deploymentId,
      meta: {
        phase: "tmp_write",
        error: (err as Error).message,
        tenant_slug: ctx.tenantSlug,
      },
    });
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    throw err;
  }

  // PHASE 3 — atomic SQLite tx
  // ─────────────────────────────────────────────────────────────────────
  const txOut: {
    workflowVersionId: string;
    deploymentId: string;
    workflowId: string;
    priorDeploymentId: string | null;
    isPromotion: boolean;
  } = (() => {
    let workflowVersionId = "";
    let workflowId = "";
    let priorDeploymentId: string | null = null;
    let isPromotion = false;
    db.transaction(() => {
      // (a) ensure tenant workflow row
      const workflowSlug = `${ctx.tenantSlug}-default`;
      let wf = db
        .select()
        .from(workflows)
        .where(and(eq(workflows.tenantId, ctx.tenantId), eq(workflows.slug, workflowSlug)))
        .all()[0];
      if (!wf) {
        const wfId = makeId("wf");
        db.insert(workflows)
          .values({
            id: wfId,
            tenantId: ctx.tenantId,
            slug: workflowSlug,
            name: workflowSlug,
          })
          .run();
        wf = db.select().from(workflows).where(eq(workflows.id, wfId)).all()[0]!;
      }
      workflowId = wf.id;

      // (b) demote prior live
      const liveRows = db
        .select()
        .from(deployments)
        .where(
          and(
            eq(deployments.tenantId, ctx.tenantId),
            eq(deployments.target, "workflow"),
            eq(deployments.status, "live"),
          ),
        )
        .all();
      if (liveRows[0]) priorDeploymentId = liveRows[0].id;
      for (const r of liveRows) {
        db.update(deployments)
          .set({
            status: "rolled_back",
            note: (r.note ? r.note + "; " : "") + "auto: superseded by import",
          })
          .where(eq(deployments.id, r.id))
          .run();
      }

      // (c) Promote the pending lock or insert a fresh deployment row.
      if (pendingLockRow) {
        isPromotion = true;
        // If a prior commit already produced a workflow_version with the
        // same content hash, (workflow_id, desiredVersion) is already
        // taken by that row. A naive UPDATE on the pending wfv would
        // fail the `wfv_workflow_version_uq` index. Redirect the pending
        // deployment at the existing row instead — this mirrors the
        // cold-commit branch below.
        const collidingExisting = db
          .select()
          .from(workflowVersions)
          .where(
            and(
              eq(workflowVersions.workflowId, wf.id),
              eq(workflowVersions.version, desiredVersion),
            ),
          )
          .all()[0];
        if (collidingExisting && collidingExisting.id !== pendingLockRow.versionId) {
          // Refresh the existing row's content (actionsJson can drift
          // even when the agent-array hash matches).
          db.update(workflowVersions)
            .set({
              manifestJson: result.migrated as unknown as object,
              actionsJson: (result.actions ?? null) as unknown as object,
            })
            .where(eq(workflowVersions.id, collidingExisting.id))
            .run();
          // Redirect the pending deployment at the existing wfv before
          // dropping the orphan, so nothing observable points at a
          // soon-to-be-deleted id even mid-transaction.
          db.update(deployments)
            .set({
              status: "live",
              deployedAt: new Date(),
              expiresAt: null,
              note: input.note ?? pendingLockRow.note ?? null,
              filePath: tmpWorkflowPath, // updated to final path in phase 4
              versionId: collidingExisting.id,
            })
            .where(eq(deployments.id, pendingLockRow.id))
            .run();
          // The pending wfv has no agent_versions referencing it yet
          // (those land in phase 3d below, after this branch). Safe to
          // drop. The wfv_workflow_version_uq index is freed first so
          // anything that might reference `pending-<dpl>` no longer can.
          db.delete(workflowVersions)
            .where(eq(workflowVersions.id, pendingLockRow.versionId))
            .run();
          workflowVersionId = collidingExisting.id;
        } else {
          // No collision — realign the pending row's version string to
          // auto-<hash> so the bootstrap dedup keys cleanly across
          // restarts.
          db.update(workflowVersions)
            .set({
              version: desiredVersion,
              manifestJson: result.migrated as unknown as object,
              actionsJson: (result.actions ?? null) as unknown as object,
            })
            .where(eq(workflowVersions.id, pendingLockRow.versionId))
            .run();
          db.update(deployments)
            .set({
              status: "live",
              deployedAt: new Date(),
              expiresAt: null,
              note: input.note ?? pendingLockRow.note ?? null,
              filePath: tmpWorkflowPath, // updated to final path in phase 4
            })
            .where(eq(deployments.id, pendingLockRow.id))
            .run();
          workflowVersionId = pendingLockRow.versionId;
        }
      } else {
        // Cold commit — reuse an existing workflow_version with the same
        // hash if present (bootstrap-style idempotency).
        const existing = db
          .select()
          .from(workflowVersions)
          .where(
            and(
              eq(workflowVersions.workflowId, wf.id),
              eq(workflowVersions.version, desiredVersion),
            ),
          )
          .all()[0];
        if (existing) {
          workflowVersionId = existing.id;
          db.update(workflowVersions)
            .set({
              manifestJson: result.migrated as unknown as object,
              actionsJson: (result.actions ?? null) as unknown as object,
            })
            .where(eq(workflowVersions.id, existing.id))
            .run();
        } else {
          workflowVersionId = makeId("wfv");
          db.insert(workflowVersions)
            .values({
              id: workflowVersionId,
              workflowId: wf.id,
              version: desiredVersion,
              manifestJson: result.migrated as unknown as object,
              actionsJson: (result.actions ?? null) as unknown as object,
            })
            .run();
        }
        db.insert(deployments)
          .values({
            id: deploymentId,
            tenantId: ctx.tenantId,
            target: "workflow",
            versionId: workflowVersionId,
            status: "live",
            note: input.note ?? null,
            filePath: tmpWorkflowPath, // updated to final path in phase 4
          })
          .run();
      }

      // (d) Upsert agents + agent_versions, replace event_listeners.
      for (const a of result.migrated) {
        let agentRow = db
          .select()
          .from(agents)
          .where(and(eq(agents.workflowId, wf.id), eq(agents.kebabId, a.id)))
          .all()[0];
        if (!agentRow) {
          const aid = makeId("agt");
          const now = new Date();
          db.insert(agents)
            .values({
              id: aid,
              workflowId: wf.id,
              kebabId: a.id,
              name: a.name,
              title: a.title ?? a.name,
              actor: a.actor[0] === "Human" ? "Human" : "Agent",
              enabled: true,
              createdAt: now,
              updatedAt: now,
            })
            .run();
          agentRow = db.select().from(agents).where(eq(agents.id, aid)).all()[0]!;
        } else {
          db.update(agents)
            .set({
              name: a.name,
              title: a.title ?? a.name,
              actor: a.actor[0] === "Human" ? "Human" : "Agent",
              updatedAt: new Date(),
              enabled: true,
            })
            .where(eq(agents.id, agentRow.id))
            .run();
        }
        const existingAv = db
          .select()
          .from(agentVersions)
          .where(
            and(
              eq(agentVersions.agentId, agentRow.id),
              eq(agentVersions.workflowVersionId, workflowVersionId),
            ),
          )
          .all()[0];
        if (!existingAv) {
          db.insert(agentVersions)
            .values({
              id: makeId("agv"),
              agentId: agentRow.id,
              workflowVersionId,
              manifestJson: a as unknown as object,
            })
            .run();
        }
        db.delete(eventListeners).where(eq(eventListeners.agentId, agentRow.id)).run();
        for (const trig of a.trigger) {
          db.insert(eventListeners)
            .values({ eventName: trig, agentId: agentRow.id })
            .run();
        }
      }
      // Disable agents removed by this import (preserve runs FK).
      for (const removedId of result.diff.removed) {
        db.update(agents)
          .set({ enabled: false })
          .where(and(eq(agents.workflowId, wf.id), eq(agents.kebabId, removedId)))
          .run();
      }

      // (e) Audit row — review O1. The events table is the Inngest event
      //     ledger and would route through `event_listeners`, so the v0
      //     `WORKFLOW_DEPLOYED` row there is gone. We write to `audit_log`
      //     instead, mirroring the rollback pattern at deployments.ts:78.
      try {
        writeAudit({
          tenantId: ctx.tenantId,
          action: "manifest.import.commit",
          targetType: "workflow_version",
          targetId: workflowVersionId,
          actorUserId: auditCtx?.actorUserId,
          meta: {
            deployment_id: deploymentId,
            prior_deployment_id: priorDeploymentId,
            prior_version: result.prior.versionString,
            new_version: desiredVersion,
            diff: result.diff,
            conflicts_resolved: input.conflict_resolutions ?? [],
            file_path: tmpWorkflowPath,
            target: input.target,
            agents_count: result.migrated.length,
            schema_version: result.schemaVersion,
            tenant_slug: ctx.tenantSlug,
            promotion_of_pending: isPromotion,
            // inngest_fns_registered + final file_path + elapsed_ms are
            // appended after phase 4 via an audit follow-up row.
          },
        });
      } catch {
        /* audit best-effort */
      }
    });
    return {
      workflowVersionId,
      deploymentId,
      workflowId,
      priorDeploymentId,
      isPromotion,
    };
  })();

  // PHASE 4 — atomic rename + hot-swap
  // ─────────────────────────────────────────────────────────────────────
  // Reserve a target filename + rename from tmp. Atomic on POSIX. On failure
  // the DB is still consistent — the deployment row's `file_path` still
  // points at the tmp file under data/imports/, and `reconcileImports` will
  // finish the rename on next boot.
  let fileWritten = "";
  let renameOk = false;
  try {
    const picked = await pickAndReserveNextFilename(ctx.tenantSlug);
    // The pick reserved an empty target file via O_CREAT|O_EXCL; rename
    // overwrites it atomically.
    await rename(tmpWorkflowPath, picked.workflowPath);
    fileWritten = picked.workflowPath;
    if (result.actions) {
      await rename(tmpActionsPath, picked.actionsPath);
    }
    renameOk = true;
    db.update(deployments)
      .set({ filePath: fileWritten })
      .where(eq(deployments.id, txOut.deploymentId))
      .run();
    // Best-effort: drop the now-empty tmp dir.
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  } catch (err) {
    auditCtx?.log?.error?.(
      {
        err: (err as Error).message,
        deployment_id: txOut.deploymentId,
        phase: "rename",
      },
      "manifest-import: atomic rename failed; reconcileImports will retry on boot",
    );
    writeAuditSafely(auditCtx, {
      tenantId: ctx.tenantId,
      action: "manifest.import.fail_rename",
      targetType: "deployment",
      targetId: txOut.deploymentId,
      meta: {
        phase: "rename",
        error: (err as Error).message,
        file_path: tmpWorkflowPath,
        tenant_slug: ctx.tenantSlug,
      },
    });
    fileWritten = `(failed: rename — ${(err as Error).message}; tmp at ${tmpWorkflowPath})`;
  }

  // Hot-swap Inngest. Per inngest-registry semantics, this re-reads tenants
  // from DB so the new manifest takes effect. Per review P3: the scope is
  // already 'tenant' and `_reregisterImpl` rebuilds the full tenant set;
  // future work can scope the rebuild to a single slug.
  let inngestCount = -1;
  try {
    const r = await reregisterInngest({
      tenantSlug: ctx.tenantSlug,
      scope: "tenant",
    });
    // #INNGEST-FIX(B1) — report THIS tenant's own app fn count, not the whole-fleet total. A scoped
    // reregister sets appFnCount = the tenant app's fns; using fnCount (all apps summed) made
    // inngest_fns_registered ~60+ instead of ~5, which broke the sandbox's waitForAppReady (its
    // per-app probe could never reach a fleet-wide expected count → appReady always false → real
    // agent failures misattributed as "environment problem, don't refine the agent"). No-slug full
    // rebuilds leave appFnCount undefined → falls back to fnCount (unchanged).
    inngestCount = r.appFnCount ?? r.fnCount;
  } catch (err) {
    // Re-register failure is recoverable but observable. Audit + log; the
    // next process boot reads from disk and re-registers.
    auditCtx?.log?.error?.(
      {
        err: (err as Error).message,
        deployment_id: txOut.deploymentId,
        phase: "hot_swap",
      },
      "manifest-import: hot-swap failed; next boot will re-register",
    );
    writeAuditSafely(auditCtx, {
      tenantId: ctx.tenantId,
      action: "manifest.import.fail_swap",
      targetType: "deployment",
      targetId: txOut.deploymentId,
      meta: {
        phase: "hot_swap",
        error: (err as Error).message,
        tenant_slug: ctx.tenantSlug,
      },
    });
  }

  // UC-V11-06 — emit `deployment.created` so connected portal sessions
  // refresh the deployments table without a manual reload. Manifest deploys
  // already get an explicit "Manifest deployed" toast at save time, so the
  // chrome only fires a hot-reload toast for `kind: 'tenant_code'`; this
  // event is mainly here for the TanStack query invalidation in
  // `apps/web/lib/hooks/useStream.ts`. Best-effort: a publish failure does
  // not roll back the commit.
  try {
    publishStreamEvent({
      type: "deployment.created",
      tenantId: ctx.tenantId,
      at: Date.now(),
      deploymentId: txOut.deploymentId,
      kind: "manifest",
      version: desiredVersion,
      workflowSlug: ctx.tenantSlug,
    });
  } catch (err) {
    auditCtx?.log?.info?.(
      { err: (err as Error).message, deployment_id: txOut.deploymentId },
      "manifest-import: deployment.created publish failed (non-fatal)",
    );
  }

  const elapsedMs = Date.now() - started;
  const out: ManifestImportCommit = {
    ok: true,
    workflow_version_id: txOut.workflowVersionId,
    version: desiredVersion,
    deployment_id: txOut.deploymentId,
    target: input.target,
    inngest_fns_registered: inngestCount,
    file_written: fileWritten,
    prior_deployment_id: txOut.priorDeploymentId,
    note: txOut.isPromotion
      ? "promoted from pending import; runtime hot-swapped"
      : "manifest imported and deployed; runtime hot-swapped",
    elapsed_ms: elapsedMs,
  };
  void renameOk; // tracked for audit clarity; not part of response shape

  return out;
}

// ---- Boot-time GC ---------------------------------------------------------

/**
 * Drop pending deployments past their TTL and remove their `data/imports/
 * <deployment_id>/` staging dirs. Idempotent. Called from
 * `reconcileImports(...)` on api boot.
 *
 * (Naming preserved for the `bootstrap.ts` import; the heavy lifting
 * including crashed-rename recovery lives in `reconcile-imports.ts`.)
 */
export async function pruneExpiredImports(): Promise<{
  pruned: number;
  failures: number;
}> {
  const db = getDb();
  const cutoff = new Date(Date.now());
  const expired = db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.status, "pending"),
        lt(deployments.expiresAt, cutoff),
      ),
    )
    .all();
  if (expired.length === 0) return { pruned: 0, failures: 0 };
  let failures = 0;
  for (const row of expired) {
    try {
      db.transaction(() => {
        db.delete(deployments).where(eq(deployments.id, row.id)).run();
        // Best-effort: drop the pending workflow_version row too. It's not
        // referenced by any deployment after the delete above, and no
        // agent_versions rows point at it (validate doesn't create them).
        db.delete(workflowVersions)
          .where(eq(workflowVersions.id, row.versionId))
          .run();
      });
      // Per review A2 the staging dir is keyed by deployment_id.
      await rm(path.join(importsRoot(), row.id), {
        recursive: true,
        force: true,
      });
    } catch {
      failures += 1;
    }
  }
  return { pruned: expired.length - failures, failures };
}

// Re-export the helpers the route + tests + the agents.ts refactor need.
export const __test = {
  diffManifests,
  applyResolutions,
  overwriteGuard,
  importsRoot,
  pickNextVersion,
};
