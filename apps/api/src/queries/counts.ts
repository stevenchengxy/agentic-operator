import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  agents,
  events,
  getDb,
  runs,
  tasks,
  tenants,
  workflows,
} from "@agentic/db";
import type { TenantCounts } from "@agentic/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

export async function getTenantCounts(tenantSlug: string): Promise<TenantCounts> {
  const db = getDb();
  const tenant = db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .all()[0];
  if (!tenant) return zero();
  const tenantId = tenant.id;
  const since = new Date(Date.now() - DAY_MS);

  const agentRows = db
    .select({ id: agents.id })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .where(eq(workflows.tenantId, tenantId))
    .all();

  const allRuns = db
    .select({
      status: runs.status,
      startedAt: runs.startedAt,
    })
    .from(runs)
    .where(and(eq(runs.tenantId, tenantId), isNull(runs.deletedAt)))
    .all();

  let runningRuns = 0;
  let okRuns24h = 0;
  let failedRuns24h = 0;
  for (const r of allRuns) {
    if (
      r.status === "running" ||
      r.status === "queued" ||
      r.status === "waiting"
    )
      runningRuns++;
    if (r.startedAt && r.startedAt >= since) {
      if (r.status === "ok") okRuns24h++;
      if (r.status === "failed") failedRuns24h++;
    }
  }

  const eventRows = db
    .select({ receivedAt: events.receivedAt })
    .from(events)
    .where(and(eq(events.tenantId, tenantId), isNull(events.deletedAt)))
    .all();
  const events24h = eventRows.filter(
    (e) => e.receivedAt && e.receivedAt >= since,
  ).length;

  const taskRows = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.tenantId, tenantId),
        inArray(tasks.status, ["open", "resolving"]),
        isNull(tasks.deletedAt),
      ),
    )
    .all();

  return {
    agents: agentRows.length,
    runningRuns,
    okRuns24h,
    failedRuns24h,
    events24h,
    openTasks: taskRows.length,
    totalRuns: allRuns.length,
  };
}

function zero(): TenantCounts {
  return {
    agents: 0,
    runningRuns: 0,
    okRuns24h: 0,
    failedRuns24h: 0,
    events24h: 0,
    openTasks: 0,
    totalRuns: 0,
  };
}
