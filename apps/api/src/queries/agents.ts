import { and, desc, eq, isNull, sql } from "drizzle-orm";
import {
  agents,
  agentVersions,
  deployments,
  getDb,
  runs,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import type { ListAgentRow, AgentDetail } from "@agentic/contracts";

async function resolveTenantId(slug: string): Promise<string | null> {
  const db = getDb();
  return db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0]?.id ?? null;
}

interface AgentVersionRef {
  agentId: string;
  agentVersionId: string;
  workflowVersionId: string;
  workflowVersion: string;
  manifestJson: unknown;
  createdAt: Date;
}

interface LiveDeploymentRef {
  id: string;
  target: typeof deployments.$inferSelect.target;
  versionId: string;
  deployedAt: Date;
}

function listLiveDeploymentRefs(tenantId: string): LiveDeploymentRef[] {
  return getDb()
    .select({
      id: deployments.id,
      target: deployments.target,
      versionId: deployments.versionId,
      deployedAt: deployments.deployedAt,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.tenantId, tenantId),
        eq(deployments.status, "live"),
      ),
    )
    .orderBy(desc(deployments.deployedAt), desc(deployments.id))
    .all();
}

function listAgentVersionRefs(agentId: string): AgentVersionRef[] {
  return getDb()
    .select({
      agentId: agentVersions.agentId,
      agentVersionId: agentVersions.id,
      workflowVersionId: workflowVersions.id,
      workflowVersion: workflowVersions.version,
      manifestJson: agentVersions.manifestJson,
      createdAt: workflowVersions.createdAt,
    })
    .from(agentVersions)
    .innerJoin(
      workflowVersions,
      eq(workflowVersions.id, agentVersions.workflowVersionId),
    )
    .where(eq(agentVersions.agentId, agentId))
    .orderBy(desc(workflowVersions.createdAt))
    .all();
}

function deploymentReferencesVersion(
  deployment: LiveDeploymentRef,
  version: AgentVersionRef,
): boolean {
  if (deployment.target === "workflow") {
    return deployment.versionId === version.workflowVersionId;
  }
  if (deployment.target === "agent" || deployment.target === "code_agent") {
    return deployment.versionId === version.agentVersionId;
  }
  return false;
}

function resolveDeployedVersion(
  agentId: string,
  versions: AgentVersionRef[],
  liveDeployments: LiveDeploymentRef[],
): { deployment: LiveDeploymentRef; version: AgentVersionRef } | null {
  for (const deployment of liveDeployments) {
    const version = versions.find(
      (candidate) =>
        candidate.agentId === agentId &&
        deploymentReferencesVersion(deployment, candidate),
    );
    if (version) return { deployment, version };
  }
  return null;
}

export async function listAgents(
  tenantSlug: string,
  opts: { kind?: "manifest" | "code" | "all" } = {},
): Promise<ListAgentRow[]> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return [];

  const kindFilter = opts.kind ?? "all";
  const whereClause =
    kindFilter === "all"
      ? eq(workflows.tenantId, tenantId)
      : and(eq(workflows.tenantId, tenantId), eq(agents.kind, kindFilter));

  const rows = db
    .select({
      id: agents.id,
      kebabId: agents.kebabId,
      name: agents.name,
      title: agents.title,
      actor: agents.actor,
      kind: agents.kind,
      enabled: agents.enabled,
      runCount: sql<number>`count(${runs.id})`,
      errorCount: sql<number>`sum(case when ${runs.status} = 'failed' then 1 else 0 end)`,
      lastRunAt: sql<number | null>`max(${runs.startedAt})`,
    })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .leftJoin(
      runs,
      and(eq(runs.agentId, agents.id), isNull(runs.deletedAt)),
    )
    .where(whereClause)
    .groupBy(agents.id)
    .all();

  // Pull descriptions only from an agent version referenced by a live
  // deployment. "Newest row" is not equivalent to "running version" and can
  // otherwise leak an undeployed draft into the Agents list.
  const versionRows: AgentVersionRef[] = db
    .select({
      agentId: agentVersions.agentId,
      agentVersionId: agentVersions.id,
      workflowVersionId: workflowVersions.id,
      workflowVersion: workflowVersions.version,
      manifestJson: agentVersions.manifestJson,
      createdAt: workflowVersions.createdAt,
    })
    .from(agentVersions)
    .innerJoin(agents, eq(agents.id, agentVersions.agentId))
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .innerJoin(
      workflowVersions,
      eq(workflowVersions.id, agentVersions.workflowVersionId),
    )
    .where(eq(workflows.tenantId, tenantId))
    .orderBy(desc(workflowVersions.createdAt))
    .all();
  const liveDeployments = listLiveDeploymentRefs(tenantId);
  const descByAgent = new Map<string, string>();
  for (const row of rows) {
    const deployed = resolveDeployedVersion(
      row.id,
      versionRows,
      liveDeployments,
    );
    const manifest = deployed && isRecord(deployed.version.manifestJson)
      ? deployed.version.manifestJson
      : null;
    const description = manifest?.description;
    if (typeof description === "string") {
      descByAgent.set(row.id, description);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    kebabId: r.kebabId,
    name: r.name,
    title: r.title,
    description: descByAgent.get(r.id) ?? null,
    actor: r.actor,
    kind: r.kind,
    enabled: r.enabled,
    runCount: Number(r.runCount),
    errorCount: Number(r.errorCount ?? 0),
    lastRunAt: r.lastRunAt ? new Date(r.lastRunAt) : null,
  }));
}

interface ManifestShape {
  description?: unknown;
  trigger?: string[];
  triggered_event?: string[];
  actions?: AgentDetail["actions"];
  input_data?: unknown;
  ontology_instructions?: unknown;
  tool_use?: unknown;
  typescript_code?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * Lookup the most recent manifest version of a named agent in the given tenant,
 * returning its first trigger event so `/v1/agents/:name/invoke` can emit it.
 *
 * Used by the invoke route to extend Test-Run support to manifest agents
 * (Option B from the use-case verification: route falls back to a DB lookup
 * + Inngest event emit when the agent isn't in the code registry).
 */
export async function findManifestAgentTrigger(
  tenantSlug: string,
  agentName: string,
): Promise<{
  agentId: string;
  name: string;
  actor: "Agent" | "Human";
  enabled: boolean;
  triggers: string[];
  sourceUnavailable: boolean;
} | null> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return null;

  const row = db
    .select({
      id: agents.id,
      name: agents.name,
      actor: agents.actor,
      kind: agents.kind,
      enabled: agents.enabled,
    })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .where(
      and(
        eq(workflows.tenantId, tenantId),
        eq(agents.name, agentName),
        eq(agents.kind, "manifest"),
      ),
    )
    .limit(1)
    .all()[0];

  if (!row) return null;
  const deployed = resolveDeployedVersion(
    row.id,
    listAgentVersionRefs(row.id),
    listLiveDeploymentRefs(tenantId),
  );
  const manifest = deployed && isRecord(deployed.version.manifestJson)
    ? (deployed.version.manifestJson as ManifestShape)
    : null;
  const triggers = manifest?.trigger ?? [];
  return {
    agentId: row.id,
    name: row.name,
    actor: row.actor === "Human" ? "Human" : "Agent",
    enabled: row.enabled,
    triggers: stringArray(triggers),
    sourceUnavailable: manifest === null,
  };
}

export async function getAgentDetail(
  tenantSlug: string,
  kebabId: string,
): Promise<AgentDetail | null> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return null;

  // Resolve the stable agent identity first. An agent can legitimately have
  // no deployed version (for example after a rollback or an interrupted
  // import); that is still a real agent and must be reported as unavailable,
  // not converted into a 404 by an inner join on agent_versions.
  const row = db
    .select({
      id: agents.id,
      kebabId: agents.kebabId,
      name: agents.name,
      title: agents.title,
      actor: agents.actor,
      kind: agents.kind,
      enabled: agents.enabled,
      workflowSlug: workflows.slug,
    })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .where(and(eq(workflows.tenantId, tenantId), eq(agents.kebabId, kebabId)))
    .all()[0];
  if (!row) return null;

  // A workflow deployment points at workflow_versions.id; an agent/code
  // deployment points at agent_versions.id. Only one of those live references
  // is allowed to choose the visible manifest. Falling back to the newest
  // undeployed version would make the Code and Agent tabs lie about runtime.
  const deployed = resolveDeployedVersion(
    row.id,
    listAgentVersionRefs(row.id),
    listLiveDeploymentRefs(tenantId),
  );

  const m = deployed && isRecord(deployed.version.manifestJson)
    ? (deployed.version.manifestJson as ManifestShape)
    : null;
  const toolUse = Array.isArray(m?.tool_use)
    ? (m.tool_use.filter(isRecord) as AgentDetail["tool_use"])
    : null;

  return {
    id: row.id,
    kebabId: row.kebabId,
    name: row.name,
    title: row.title,
    description: typeof m?.description === "string" ? m.description : null,
    actor: row.actor,
    kind: row.kind,
    enabled: row.enabled,
    triggers: stringArray(m?.trigger),
    triggeredEvents: stringArray(m?.triggered_event),
    actions: Array.isArray(m?.actions) ? m.actions : [],
    workflowSlug: row.workflowSlug,
    workflowVersion: deployed?.version.workflowVersion ?? null,
    input_data: isRecord(m?.input_data) ? m.input_data : null,
    ontology_instructions:
      typeof m?.ontology_instructions === "string"
        ? m.ontology_instructions
        : null,
    tool_use: toolUse,
    typescript_code:
      typeof m?.typescript_code === "string" ? m.typescript_code : null,
    sourceUnavailable: m === null,
    deployedSource: deployed
      ? {
          deploymentId: deployed.deployment.id,
          deploymentTarget: deployed.deployment.target as
            | "workflow"
            | "agent"
            | "code_agent",
          deployedAt: deployed.deployment.deployedAt,
          agentVersionId: deployed.version.agentVersionId,
          workflowVersionId: deployed.version.workflowVersionId,
          storage: "agent_versions.manifest_json",
        }
      : null,
  };
}

export async function listAgentRuns(
  tenantSlug: string,
  agentDbId: string,
  limit = 30,
) {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return [];
  return db
    .select({
      id: runs.id,
      status: runs.status,
      subject: runs.subject,
      startedAt: runs.startedAt,
      durationMs: runs.durationMs,
    })
    .from(runs)
    .where(
      and(
        eq(runs.tenantId, tenantId),
        eq(runs.agentId, agentDbId),
        isNull(runs.deletedAt),
      ),
    )
    .orderBy(desc(runs.startedAt))
    .limit(limit)
    .all();
}
