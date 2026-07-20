import { and, desc, eq, isNull } from "drizzle-orm";
import {
  agents,
  agentVersions,
  deployments,
  events,
  getDb,
  runs,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import type { DagAgent, DagEdge } from "@agentic/contracts";

const STAGE_PREFIX_REGEX = /^(\d+)/;
const HOT_WINDOW_MS = 60_000;

interface ManifestShape {
  trigger?: string[];
  triggered_event?: string[];
}

export async function getDag(tenantSlug: string): Promise<{
  agents: DagAgent[];
  edges: DagEdge[];
  workflowVersion: string;
}> {
  const db = getDb();
  const tenant = db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .all()[0];
  if (!tenant) return { agents: [], edges: [], workflowVersion: "—" };

  // Prefer the LIVE deployment's workflow_version (correct for daily ops).
  // Fall back to most-recently-created workflow_version if no live deployment.
  //
  // CRITICAL: filter to `target='workflow'`. A tenant can have multiple live
  // deployments in different lanes (e.g. raas has one `target=workflow` for
  // the manifest DAG AND one `target=tenant_code` for the code-agent
  // tarball, see deployments schema enum in packages/db/src/schema.ts:145).
  // Without this filter the ORDER BY deployedAt picks whichever was deployed
  // last, which may point at a workflow row with zero agents in the graph
  // (e.g. wf-aaab4b328451 for raas tenant_code) — leaving the Workflows
  // canvas blank even though the manifest workflow has 26 agents.
  const liveRow = db
    .select({
      workflowId: workflows.id,
      versionId: workflowVersions.id,
      version: workflowVersions.version,
    })
    .from(deployments)
    .innerJoin(
      workflowVersions,
      eq(workflowVersions.id, deployments.versionId),
    )
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(
      and(
        eq(deployments.tenantId, tenant.id),
        eq(deployments.status, "live"),
        eq(deployments.target, "workflow"),
      ),
    )
    .orderBy(desc(deployments.deployedAt))
    .all()[0];

  let wfId: string | null = liveRow?.workflowId ?? null;
  let wfvId: string | null = liveRow?.versionId ?? null;
  let versionStr: string | null = liveRow?.version ?? null;
  if (!wfId) {
    const wf = db
      .select()
      .from(workflows)
      .where(eq(workflows.tenantId, tenant.id))
      .all()[0];
    if (!wf) return { agents: [], edges: [], workflowVersion: "—" };
    wfId = wf.id;
    const wfv = db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.workflowId, wf.id))
      .orderBy(desc(workflowVersions.createdAt))
      .all()[0];
    if (!wfv) return { agents: [], edges: [], workflowVersion: "—" };
    wfvId = wfv.id;
    versionStr = wfv.version;
  }

  const rows = db
    .select({
      id: agents.id,
      kebabId: agents.kebabId,
      name: agents.name,
      title: agents.title,
      actor: agents.actor,
      manifestJson: agentVersions.manifestJson,
    })
    .from(agents)
    .innerJoin(
      agentVersions,
      and(
        eq(agentVersions.agentId, agents.id),
        eq(agentVersions.workflowVersionId, wfvId!),
      ),
    )
    .where(eq(agents.workflowId, wfId!))
    .all();

  const since = new Date(Date.now() - HOT_WINDOW_MS);
  const hotAgents = new Set<string>();
  const runCounts = new Map<string, number>();
  for (const r of db
    .select({ agentId: runs.agentId, startedAt: runs.startedAt })
    .from(runs)
    .where(and(eq(runs.tenantId, tenant.id), isNull(runs.deletedAt)))
    .all()) {
    if (r.startedAt && r.startedAt >= since) hotAgents.add(r.agentId);
    runCounts.set(r.agentId, (runCounts.get(r.agentId) ?? 0) + 1);
  }
  const hotEventNames = new Set<string>();
  for (const e of db
    .select({ name: events.name, receivedAt: events.receivedAt })
    .from(events)
    .where(and(eq(events.tenantId, tenant.id), isNull(events.deletedAt)))
    .all()) {
    if (e.receivedAt && e.receivedAt >= since) hotEventNames.add(e.name);
  }

  const dagAgents: DagAgent[] = rows.map((r) => {
    const m = (r.manifestJson ?? {}) as ManifestShape;
    const stageMatch = r.kebabId.match(STAGE_PREFIX_REGEX);
    const stage = stageMatch ? parseInt(stageMatch[1]!, 10) : 99;
    return {
      id: r.id,
      kebabId: r.kebabId,
      name: r.name,
      title: r.title ?? r.name,
      actor: r.actor,
      triggers: m.trigger ?? [],
      emits: m.triggered_event ?? [],
      stage,
      recentRunCount: runCounts.get(r.id) ?? 0,
      isLive: hotAgents.has(r.id),
    };
  });

  const byEventListener = new Map<string, DagAgent[]>();
  for (const a of dagAgents) {
    for (const t of a.triggers) {
      const arr = byEventListener.get(t) ?? [];
      arr.push(a);
      byEventListener.set(t, arr);
    }
  }
  const edges: DagEdge[] = [];
  const seen = new Set<string>();
  for (const a of dagAgents) {
    for (const e of a.emits) {
      for (const b of byEventListener.get(e) ?? []) {
        const key = `${a.name}→${b.name}|${e}`;
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({
          fromAgent: a.name,
          toAgent: b.name,
          event: e,
          active: hotEventNames.has(e),
        });
      }
    }
  }

  return {
    agents: dagAgents.sort(
      (a, b) => a.stage - b.stage || a.kebabId.localeCompare(b.kebabId),
    ),
    edges,
    workflowVersion: versionStr ?? "—",
  };
}
