import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { deployments, getDb, workflowVersions, workflows } from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  WorkflowManifestV2Schema,
  normalizeWorkflowManifest,
  type CreateWorkflowBody,
  type ProviderId,
  type SaveWorkflowBody,
  type WorkflowDetail,
  type WorkflowManifestV2,
  type WorkflowPromptScore,
  type WorkflowSummary,
  type WorkflowValidationIssue,
  type WorkflowValidationResponse,
  type WorkflowVersionSummary,
} from "@agentic/contracts";
import {
  WorkflowManifestSchema,
  lint,
  type WorkflowManifest,
} from "@agentic/runtime";
import { listGlobalTools } from "@agentic/tools";
import { getLLMGateway } from "./llm";
import { findWorkflowSecretPolicyIssues } from "./workflow-secret-policy";
import {
  getWorkflowTemplate,
  instantiateBlankWorkflow,
  instantiateWorkflowTemplate,
} from "./workflow-templates";

export interface WorkflowTenantContext {
  tenantId: string;
  tenantSlug: string;
}

export class WorkflowNotFoundError extends Error {
  constructor(public readonly slug: string) {
    super(`workflow not found: ${slug}`);
    this.name = "WorkflowNotFoundError";
  }
}

export class WorkflowTemplateNotFoundError extends Error {
  constructor(public readonly templateId: string) {
    super(`workflow template not found: ${templateId}`);
    this.name = "WorkflowTemplateNotFoundError";
  }
}

export class WorkflowAlreadyExistsError extends Error {
  constructor(public readonly slug: string) {
    super(`workflow already exists: ${slug}`);
    this.name = "WorkflowAlreadyExistsError";
  }
}

export class WorkflowVersionNotFoundError extends Error {
  constructor(
    public readonly slug: string,
    public readonly versionId: string,
  ) {
    super(`workflow version not found: ${slug}/${versionId}`);
    this.name = "WorkflowVersionNotFoundError";
  }
}

export class WorkflowVersionConflictError extends Error {
  constructor(
    public readonly expectedVersionId: string,
    public readonly currentVersionId: string,
  ) {
    super(
      `workflow version conflict: expected ${expectedVersionId}, current ${currentVersionId}`,
    );
    this.name = "WorkflowVersionConflictError";
  }
}

export class LiveWorkflowDeleteError extends Error {
  constructor(public readonly slug: string) {
    super(`live workflow cannot be deleted: ${slug}`);
    this.name = "LiveWorkflowDeleteError";
  }
}

export class WorkflowDeploymentHistoryDeleteError extends Error {
  constructor(public readonly slug: string) {
    super(`workflow with deployment history cannot be deleted: ${slug}`);
    this.name = "WorkflowDeploymentHistoryDeleteError";
  }
}

export class WorkflowManifestInputError extends Error {
  constructor(
    message: string,
    public readonly causeDetails?: unknown,
  ) {
    super(message);
    this.name = "WorkflowManifestInputError";
  }
}

function assertWorkflowPersistencePolicy(
  manifest: unknown,
  actions: unknown,
  tenantSlug: string,
): void {
  const issues = findWorkflowSecretPolicyIssues(manifest, actions, {
    tenantSlug,
  });
  if (issues.length > 0) {
    throw new WorkflowManifestInputError(
      "workflow contains forbidden literal credentials or invalid secret references",
      issues,
    );
  }
}

type WorkflowRow = typeof workflows.$inferSelect;
type WorkflowVersionRow = typeof workflowVersions.$inferSelect;

/**
 * Double-underscore workflow slugs belong to internal deployment lanes (for
 * example `__tenant_code__`). They share the workflow/version tables for
 * lifecycle bookkeeping, but they are not editable workflow manifests.
 */
function isReservedWorkflowSlug(slug: string): boolean {
  return slug.startsWith("__");
}

function timeMs(value: Date | number): number {
  return value instanceof Date ? value.getTime() : Number(value);
}

function sortObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObject);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortObject(child)]),
  );
}

export function workflowManifestHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(sortObject(value)))
    .digest("hex");
}

function manifestAgentCount(value: unknown): number {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") {
    const agents = (value as { agents?: unknown }).agents;
    return Array.isArray(agents) ? agents.length : 0;
  }
  return 0;
}

function normalizeStoredManifest(value: unknown): WorkflowManifestV2 {
  try {
    return normalizeWorkflowManifest(value);
  } catch (error) {
    throw new WorkflowManifestInputError(
      "stored workflow manifest is invalid",
      issueFromZod(error),
    );
  }
}

function normalizeAuthoredManifest(value: unknown): WorkflowManifestV2 {
  try {
    return normalizeWorkflowManifest(value);
  } catch (error) {
    throw new WorkflowManifestInputError(
      "workflow manifest is invalid",
      issueFromZod(error),
    );
  }
}

function workflowMetadata(manifest: WorkflowManifestV2): {
  description: string;
  lineage?: Record<string, unknown>;
} {
  const envelope = manifest as WorkflowManifestV2 & {
    extensions?: Record<string, unknown>;
  };
  const workflow = envelope.extensions?.workflow;
  if (!workflow || typeof workflow !== "object" || Array.isArray(workflow)) {
    return { description: "" };
  }
  const metadata = workflow as Record<string, unknown>;
  return {
    description:
      typeof metadata.description === "string" ? metadata.description : "",
    ...(metadata.lineage &&
    typeof metadata.lineage === "object" &&
    !Array.isArray(metadata.lineage)
      ? { lineage: metadata.lineage as Record<string, unknown> }
      : {}),
  };
}

function attachWorkflowMetadata(
  source: WorkflowManifestV2,
  input: {
    description: string;
    lineage?: Record<string, unknown>;
  },
): WorkflowManifestV2 {
  const manifest = structuredClone(source) as WorkflowManifestV2 & {
    extensions?: Record<string, unknown>;
  };
  const extensions =
    manifest.extensions && typeof manifest.extensions === "object"
      ? manifest.extensions
      : {};
  const existingWorkflow =
    extensions.workflow &&
    typeof extensions.workflow === "object" &&
    !Array.isArray(extensions.workflow)
      ? (extensions.workflow as Record<string, unknown>)
      : {};
  manifest.extensions = {
    ...extensions,
    workflow: {
      ...existingWorkflow,
      description: input.description,
      ...(input.lineage ? { lineage: input.lineage } : {}),
    },
  };
  return WorkflowManifestV2Schema.parse(manifest);
}

function applyModelSelection(
  source: WorkflowManifestV2,
  selection: { provider?: ProviderId; model?: string } | undefined,
): WorkflowManifestV2 {
  if (!selection?.provider && !selection?.model) return structuredClone(source);
  const manifest = structuredClone(source);
  for (const agent of manifest.agents) {
    if (!agent.actor.includes("Agent")) continue;
    if (selection.provider) agent.provider = selection.provider;
    if (selection.model) agent.model = selection.model;
  }
  return WorkflowManifestV2Schema.parse(manifest);
}

function defaultModelSelection(): { provider: ProviderId; model?: string } {
  const gateway = getLLMGateway();
  return {
    provider: gateway.defaultProvider,
    ...(gateway.defaultModel ? { model: gateway.defaultModel } : {}),
  };
}

function latestVersionForWorkflow(
  workflowId: string,
): WorkflowVersionRow | null {
  return (
    getDb()
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, workflowId))
      .orderBy(desc(workflowVersions.createdAt), desc(workflowVersions.id))
      .all()[0] ?? null
  );
}

function allVersionsForWorkflow(workflowId: string): WorkflowVersionRow[] {
  return getDb()
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.workflowId, workflowId))
    .orderBy(desc(workflowVersions.createdAt), desc(workflowVersions.id))
    .all();
}

function workflowRow(
  slug: string,
  ctx: WorkflowTenantContext,
): WorkflowRow | null {
  if (isReservedWorkflowSlug(slug)) return null;
  return (
    getDb()
      .select()
      .from(workflows)
      .where(
        and(eq(workflows.tenantId, ctx.tenantId), eq(workflows.slug, slug)),
      )
      .all()[0] ?? null
  );
}

function liveVersionIds(ctx: WorkflowTenantContext): Set<string> {
  return new Set(
    getDb()
      .select({ versionId: deployments.versionId })
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, ctx.tenantId),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .all()
      .map((row) => row.versionId),
  );
}

function previouslyDeployedVersionIds(ctx: WorkflowTenantContext): Set<string> {
  return new Set(
    getDb()
      .select({ versionId: deployments.versionId })
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, ctx.tenantId),
          eq(deployments.target, "workflow"),
        ),
      )
      .all()
      .map((row) => row.versionId),
  );
}

function summarizeWorkflow(
  workflow: WorkflowRow,
  versions: WorkflowVersionRow[],
  liveIds: Set<string>,
  deployedIds: Set<string>,
): WorkflowSummary {
  const latest = versions[0];
  if (!latest) {
    throw new Error(`workflow ${workflow.slug} has no versions`);
  }
  const manifest = normalizeStoredManifest(latest.manifestJson);
  const liveVersion = versions.find((version) => liveIds.has(version.id));
  const wasDeployed = versions.some((version) => deployedIds.has(version.id));
  return {
    id: workflow.id,
    slug: workflow.slug,
    name: workflow.name,
    description: workflowMetadata(manifest).description,
    status: liveVersion ? "live" : wasDeployed ? "superseded" : "draft",
    latestVersionId: latest.id,
    latestVersion: latest.version,
    liveVersionId: liveVersion?.id ?? null,
    hasUnpublishedChanges: Boolean(liveVersion && liveVersion.id !== latest.id),
    agentCount: manifest.agents.length,
    createdAt: timeMs(workflow.createdAt),
    updatedAt: timeMs(latest.createdAt),
  };
}

export function listWorkflowDrafts(
  ctx: WorkflowTenantContext,
): WorkflowSummary[] {
  const rows = getDb()
    .select()
    .from(workflows)
    .where(eq(workflows.tenantId, ctx.tenantId))
    .orderBy(desc(workflows.createdAt))
    .all();
  const liveIds = liveVersionIds(ctx);
  const deployedIds = previouslyDeployedVersionIds(ctx);
  return rows
    .filter((row) => !isReservedWorkflowSlug(row.slug))
    .map((row) =>
      summarizeWorkflow(
        row,
        allVersionsForWorkflow(row.id),
        liveIds,
        deployedIds,
      ),
    )
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function versionStatus(
  version: WorkflowVersionRow,
  latestId: string,
  liveIds: Set<string>,
  deployedIds: Set<string>,
): "draft" | "live" | "superseded" {
  if (liveIds.has(version.id)) return "live";
  if (deployedIds.has(version.id)) return "superseded";
  return version.id === latestId ? "draft" : "superseded";
}

export function getWorkflowDraft(
  slug: string,
  ctx: WorkflowTenantContext,
): WorkflowDetail {
  const workflow = workflowRow(slug, ctx);
  if (!workflow) throw new WorkflowNotFoundError(slug);
  const versions = allVersionsForWorkflow(workflow.id);
  if (versions.length === 0) throw new WorkflowNotFoundError(slug);
  const latest = versions[0]!;
  const liveIds = liveVersionIds(ctx);
  const deployedIds = previouslyDeployedVersionIds(ctx);
  const summary = summarizeWorkflow(workflow, versions, liveIds, deployedIds);
  return {
    ...summary,
    manifest: normalizeStoredManifest(latest.manifestJson),
    actions: Array.isArray(latest.actionsJson)
      ? structuredClone(latest.actionsJson)
      : null,
    versions: versions.map(
      (version): WorkflowVersionSummary => ({
        id: version.id,
        version: version.version,
        status: versionStatus(version, latest.id, liveIds, deployedIds),
        agentCount: manifestAgentCount(version.manifestJson),
        createdAt: timeMs(version.createdAt),
        createdBy: version.createdBy ?? null,
      }),
    ),
  };
}

export interface WorkflowPublishSnapshot {
  workflowId: string;
  workflowName: string;
  workflowSlug: string;
  versionId: string;
  manifest: WorkflowManifestV2;
  actions: unknown[] | null;
}

/** Load one immutable, tenant-owned version for server-side publish. */
export function getWorkflowPublishSnapshot(
  slug: string,
  versionId: string | undefined,
  ctx: WorkflowTenantContext,
): WorkflowPublishSnapshot {
  const workflow = workflowRow(slug, ctx);
  if (!workflow) throw new WorkflowNotFoundError(slug);
  const version = versionId
    ? getDb()
        .select()
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.workflowId, workflow.id),
            eq(workflowVersions.id, versionId),
          ),
        )
        .all()[0]
    : latestVersionForWorkflow(workflow.id);
  if (!version) {
    throw new WorkflowVersionNotFoundError(slug, versionId ?? "latest");
  }
  return {
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflowSlug: workflow.slug,
    versionId: version.id,
    manifest: normalizeStoredManifest(version.manifestJson),
    actions: Array.isArray(version.actionsJson)
      ? structuredClone(version.actionsJson)
      : null,
  };
}

interface SourceSnapshot {
  manifest: WorkflowManifestV2;
  actions: unknown[] | null;
  lineage: Record<string, unknown>;
}

function cloneSourceSnapshot(
  sourceSlug: string,
  versionId: string | undefined,
  ctx: WorkflowTenantContext,
): SourceSnapshot {
  const sourceWorkflow = workflowRow(sourceSlug, ctx);
  if (!sourceWorkflow) throw new WorkflowNotFoundError(sourceSlug);
  const sourceVersion = versionId
    ? getDb()
        .select()
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.workflowId, sourceWorkflow.id),
            eq(workflowVersions.id, versionId),
          ),
        )
        .all()[0]
    : latestVersionForWorkflow(sourceWorkflow.id);
  if (!sourceVersion) {
    throw new WorkflowVersionNotFoundError(sourceSlug, versionId ?? "latest");
  }
  return {
    manifest: normalizeStoredManifest(sourceVersion.manifestJson),
    actions: Array.isArray(sourceVersion.actionsJson)
      ? structuredClone(sourceVersion.actionsJson)
      : null,
    lineage: {
      source: "clone",
      sourceWorkflowId: sourceWorkflow.id,
      sourceWorkflowSlug: sourceWorkflow.slug,
      sourceVersionId: sourceVersion.id,
      sourceVersion: sourceVersion.version,
    },
  };
}

function resolveCreateSource(
  input: CreateWorkflowBody,
  ctx: WorkflowTenantContext,
): SourceSnapshot {
  const explicitSelection = input.model;
  switch (input.source.type) {
    case "blank": {
      const selection = explicitSelection ?? defaultModelSelection();
      return {
        manifest: instantiateBlankWorkflow(selection),
        actions: null,
        lineage: { source: "blank" },
      };
    }
    case "template": {
      const template = getWorkflowTemplate(input.source.templateId);
      if (!template) {
        throw new WorkflowTemplateNotFoundError(input.source.templateId);
      }
      const selection = explicitSelection ?? defaultModelSelection();
      return {
        manifest: instantiateWorkflowTemplate(template.id, selection)!,
        actions: null,
        lineage: {
          source: "template",
          templateId: template.id,
          templateVersion: template.version,
        },
      };
    }
    case "clone": {
      const snapshot = cloneSourceSnapshot(
        input.source.workflowSlug,
        input.source.versionId,
        ctx,
      );
      return {
        ...snapshot,
        manifest: applyModelSelection(snapshot.manifest, explicitSelection),
      };
    }
    case "manifest":
      return {
        manifest: applyModelSelection(
          normalizeAuthoredManifest(input.source.manifest),
          explicitSelection,
        ),
        actions: input.source.actions
          ? structuredClone(input.source.actions)
          : null,
        lineage: { source: "manifest" },
      };
  }
}

function draftIdentity(manifest: WorkflowManifestV2): {
  id: string;
  version: string;
} {
  const id = makeId("wfv");
  const hash = workflowManifestHash(manifest).slice(0, 8);
  return {
    id,
    version: `draft-${Date.now().toString(36)}-${hash}-${id.slice(-4)}`,
  };
}

export function createWorkflowDraft(
  input: CreateWorkflowBody,
  ctx: WorkflowTenantContext,
): WorkflowDetail {
  if (workflowRow(input.slug, ctx)) {
    throw new WorkflowAlreadyExistsError(input.slug);
  }
  const snapshot = resolveCreateSource(input, ctx);
  const manifest = attachWorkflowMetadata(snapshot.manifest, {
    description: input.description,
    lineage: snapshot.lineage,
  });
  assertWorkflowPersistencePolicy(manifest, snapshot.actions, ctx.tenantSlug);
  const workflowId = makeId("wf");
  const draft = draftIdentity(manifest);
  const now = new Date();
  try {
    getDb().transaction((tx) => {
      tx.insert(workflows)
        .values({
          id: workflowId,
          tenantId: ctx.tenantId,
          slug: input.slug,
          name: input.name,
          createdAt: now,
        })
        .run();
      tx.insert(workflowVersions)
        .values({
          id: draft.id,
          workflowId,
          version: draft.version,
          manifestJson: manifest as never,
          actionsJson: snapshot.actions as never,
          createdAt: now,
        })
        .run();
    });
  } catch (error) {
    if (String((error as Error).message).includes("UNIQUE constraint failed")) {
      throw new WorkflowAlreadyExistsError(input.slug);
    }
    throw error;
  }
  return getWorkflowDraft(input.slug, ctx);
}

export function saveWorkflowDraft(
  slug: string,
  input: SaveWorkflowBody,
  ctx: WorkflowTenantContext,
): WorkflowDetail {
  const workflow = workflowRow(slug, ctx);
  if (!workflow) throw new WorkflowNotFoundError(slug);
  const current = latestVersionForWorkflow(workflow.id);
  if (!current) throw new WorkflowNotFoundError(slug);
  if (current.id !== input.baseVersionId) {
    throw new WorkflowVersionConflictError(input.baseVersionId, current.id);
  }
  const currentManifest = normalizeStoredManifest(current.manifestJson);
  // The canvas currently submits a bare agent array for compatibility with
  // the DAG editor. Preserve the immutable version's complete v2 envelope
  // and replace only agents, so unrelated workflow extensions survive edits.
  const parsed = Array.isArray(input.manifest)
    ? WorkflowManifestV2Schema.parse({
        ...structuredClone(currentManifest),
        agents: normalizeAuthoredManifest(input.manifest).agents,
      })
    : normalizeAuthoredManifest(input.manifest);
  const currentMetadata = workflowMetadata(currentManifest);
  const manifest = attachWorkflowMetadata(parsed, {
    description: input.description ?? currentMetadata.description,
    lineage: currentMetadata.lineage,
  });
  const next = draftIdentity(manifest);
  const actions =
    input.actions === undefined
      ? current.actionsJson
      : input.actions === null
        ? null
        : structuredClone(input.actions);
  assertWorkflowPersistencePolicy(manifest, actions, ctx.tenantSlug);
  const now = new Date(Math.max(Date.now(), timeMs(current.createdAt) + 1));

  getDb().transaction((tx) => {
    const latest = tx
      .select({ id: workflowVersions.id })
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, workflow.id))
      .orderBy(desc(workflowVersions.createdAt), desc(workflowVersions.id))
      .all()[0];
    if (!latest || latest.id !== input.baseVersionId) {
      throw new WorkflowVersionConflictError(
        input.baseVersionId,
        latest?.id ?? "missing",
      );
    }
    if (input.name && input.name !== workflow.name) {
      tx.update(workflows)
        .set({ name: input.name })
        .where(
          and(
            eq(workflows.id, workflow.id),
            eq(workflows.tenantId, ctx.tenantId),
          ),
        )
        .run();
    }
    tx.insert(workflowVersions)
      .values({
        id: next.id,
        workflowId: workflow.id,
        version: next.version,
        manifestJson: manifest as never,
        actionsJson: actions as never,
        createdAt: now,
      })
      .run();
  });
  return getWorkflowDraft(slug, ctx);
}

export function deleteWorkflowDraft(
  slug: string,
  ctx: WorkflowTenantContext,
): void {
  const workflow = workflowRow(slug, ctx);
  if (!workflow) throw new WorkflowNotFoundError(slug);
  const deploymentRows = getDb()
    .select({ id: deployments.id, status: deployments.status })
    .from(deployments)
    .innerJoin(workflowVersions, eq(workflowVersions.id, deployments.versionId))
    .where(
      and(
        eq(deployments.tenantId, ctx.tenantId),
        eq(deployments.target, "workflow"),
        eq(workflowVersions.workflowId, workflow.id),
      ),
    )
    .all();
  if (deploymentRows.some((row) => row.status === "live")) {
    throw new LiveWorkflowDeleteError(slug);
  }
  // deployment.version_id has no FK. Hard-deleting a pending/superseded
  // workflow would orphan operational history and can invalidate an active
  // import session, so only never-deployed drafts are deletable.
  if (deploymentRows.length > 0) {
    throw new WorkflowDeploymentHistoryDeleteError(slug);
  }
  getDb()
    .delete(workflows)
    .where(
      and(eq(workflows.id, workflow.id), eq(workflows.tenantId, ctx.tenantId)),
    )
    .run();
}

const PROMPT_RUBRIC = [
  ["role", /\brole\b/i],
  ["mission", /\bmission\b/i],
  ["inputs", /\binputs?\b/i],
  ["procedure", /\bprocedure\b|step[- ]by[- ]step/i],
  ["tool policy", /tool policy|available tools|no tools/i],
  ["output contract", /output contract|schema-valid/i],
  ["completion criteria", /completion criteria|done when/i],
  ["safety/privacy", /safety|privacy|tenant isolation/i],
  [
    "non-fabrication",
    /non-fabrication|do not (?:invent|fabricate)|never (?:invent|fabricate)/i,
  ],
  ["error recovery", /error recovery|malformed|retry/i],
  ["human escalation", /human escalation|operator review|escalat/i],
] as const;

export function scoreWorkflowPrompt(
  agentId: string,
  prompt: string,
): WorkflowPromptScore {
  const missing = PROMPT_RUBRIC.filter(
    ([, pattern]) => !pattern.test(prompt),
  ).map(([label]) => label);
  return {
    agentId,
    score: PROMPT_RUBRIC.length - missing.length,
    required: PROMPT_RUBRIC.length,
    missing,
  };
}

function issueFromZod(error: unknown): WorkflowValidationIssue[] {
  if (
    error &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray((error as { issues: unknown[] }).issues)
  ) {
    return (
      error as {
        issues: Array<{
          path?: PropertyKey[];
          message?: string;
          code?: string;
        }>;
      }
    ).issues.map((item) => ({
      path: item.path?.map(String).join(".") ?? "manifest",
      code: item.code ?? "invalid_manifest",
      severity: "error" as const,
      message: item.message ?? "invalid workflow manifest",
    }));
  }
  return [
    {
      path: "manifest",
      code: "invalid_manifest",
      severity: "error",
      message: error instanceof Error ? error.message : String(error),
    },
  ];
}

export function validateWorkflowManifest(
  value: unknown,
  options: { versionId?: string | null; tenantSlug?: string } = {},
): WorkflowValidationResponse {
  const rawHash = workflowManifestHash(value);
  let manifest: WorkflowManifestV2;
  try {
    manifest = normalizeWorkflowManifest(value);
  } catch (error) {
    return {
      valid: false,
      versionId: options.versionId ?? null,
      manifestHash: rawHash,
      issues: issueFromZod(error),
      promptScores: [],
    };
  }

  const issues: WorkflowValidationIssue[] = [];
  const promptScores: WorkflowPromptScore[] = [];
  issues.push(
    ...findWorkflowSecretPolicyIssues(
      manifest,
      undefined,
      options.tenantSlug ? { tenantSlug: options.tenantSlug } : undefined,
    ),
  );
  if (manifest.agents.length > 100) {
    issues.push({
      path: "agents",
      code: "agent_limit_exceeded",
      severity: "error",
      message: "workflow authoring is capped at 100 agents",
    });
  }

  const runtimeManifestResult = WorkflowManifestSchema.safeParse(
    manifest.agents,
  );
  if (!runtimeManifestResult.success) {
    issues.push(...issueFromZod(runtimeManifestResult.error));
  } else {
    const configuredProviders = getLLMGateway()
      .listProviders()
      .filter((provider) => provider.hasKey || provider.id === "mock")
      .map((provider) => provider.id);
    const result = lint(runtimeManifestResult.data as WorkflowManifest, {
      llmProviders: configuredProviders,
      concurrencyMax: Number(process.env.RUNTIME_CONCURRENCY_MAX ?? "8"),
    });
    issues.push(
      ...result.issues.map((item) => ({
        path: item.path,
        code: item.code,
        severity: item.severity,
        message: item.message,
      })),
      ...result.conflicts.map((item) => ({
        path: item.path,
        code: item.type,
        severity:
          item.severity === "block" ? ("error" as const) : ("warning" as const),
        message: item.detail,
      })),
    );
  }

  const toolNames = new Set<string>();
  for (const tool of listGlobalTools()) {
    toolNames.add(tool.name);
    tool.aliases?.forEach((alias) => toolNames.add(alias));
  }
  const agentNames = new Set<string>();
  const configuredProviderIds = new Set(
    getLLMGateway()
      .listProviders()
      .filter((provider) => provider.hasKey || provider.id === "mock")
      .map((provider) => provider.id),
  );
  manifest.agents.forEach((agent, agentIndex) => {
    if (agentNames.has(agent.name)) {
      issues.push({
        path: `agents[${agentIndex}].name`,
        code: "duplicate_agent_name",
        severity: "error",
        message: `duplicate agent name: ${agent.name}`,
      });
    }
    agentNames.add(agent.name);
    for (let toolIndex = 0; toolIndex < agent.tool_use.length; toolIndex += 1) {
      const tool = agent.tool_use[toolIndex]!;
      if (!toolNames.has(tool.name)) {
        issues.push({
          path: `agents[${agentIndex}].tool_use[${toolIndex}].name`,
          code: "unknown_tool",
          severity: "error",
          message: `tool is not registered: ${tool.name}`,
        });
      }
    }
    if (agent.provider && !configuredProviderIds.has(agent.provider)) {
      issues.push({
        path: `agents[${agentIndex}].provider`,
        code: "provider_not_configured",
        severity: "error",
        message: `provider is not configured for execution: ${agent.provider}`,
      });
    }
    if (agent.actor.includes("Agent")) {
      const prompt = agent.ontology_instructions?.trim() ?? "";
      const score = scoreWorkflowPrompt(agent.id, prompt);
      promptScores.push(score);
      if (!prompt) {
        issues.push({
          path: `agents[${agentIndex}].ontology_instructions`,
          code: "missing_system_prompt",
          severity: "error",
          message: "automated agents require a complete system prompt",
        });
      } else if (score.missing.length > 0) {
        issues.push({
          path: `agents[${agentIndex}].ontology_instructions`,
          code: "prompt_rubric_incomplete",
          severity: "warning",
          message: `prompt is missing rubric sections: ${score.missing.join(", ")}`,
        });
      }
    }
  });

  const deduplicated = Array.from(
    new Map(
      issues.map((item) => [
        `${item.path}\u0000${item.code}\u0000${item.message}`,
        item,
      ]),
    ).values(),
  );
  return {
    valid: !deduplicated.some((item) => item.severity === "error"),
    versionId: options.versionId ?? null,
    manifestHash: workflowManifestHash(manifest),
    issues: deduplicated,
    promptScores,
  };
}

export function validateWorkflowDraft(
  slug: string,
  input: { manifest?: unknown; versionId?: string },
  ctx: WorkflowTenantContext,
): WorkflowValidationResponse {
  const workflow = workflowRow(slug, ctx);
  if (!workflow) throw new WorkflowNotFoundError(slug);
  const requestedVersion = input.versionId
    ? getDb()
        .select()
        .from(workflowVersions)
        .where(
          and(
            eq(workflowVersions.workflowId, workflow.id),
            eq(workflowVersions.id, input.versionId),
          ),
        )
        .all()[0]
    : null;
  if (input.versionId && !requestedVersion) {
    throw new WorkflowVersionNotFoundError(slug, input.versionId);
  }
  if (input.manifest !== undefined) {
    return validateWorkflowManifest(input.manifest, {
      versionId: requestedVersion?.id ?? null,
      tenantSlug: ctx.tenantSlug,
    });
  }
  const version = requestedVersion ?? latestVersionForWorkflow(workflow.id);
  if (!version) {
    throw new WorkflowVersionNotFoundError(slug, input.versionId ?? "latest");
  }
  return validateWorkflowManifest(version.manifestJson, {
    versionId: version.id,
    tenantSlug: ctx.tenantSlug,
  });
}
