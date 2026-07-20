import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, tasks, tenants } from "@agentic/db";
import type { TaskRow } from "@agentic/contracts";

async function resolveTenantId(slug: string): Promise<string | null> {
  const db = getDb();
  return db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0]?.id ?? null;
}

const TASK_COLS = {
  id: tasks.id,
  type: tasks.type,
  title: tasks.title,
  priority: tasks.priority,
  status: tasks.status,
  createdAt: tasks.createdAt,
  resolvedAt: tasks.resolvedAt,
  runId: tasks.runId,
  originEventId: tasks.originEventId,
  originEventName: tasks.originEventName,
  waitStepId: tasks.waitStepId,
  awaitingRole: tasks.awaitingRole,
  payloadJson: tasks.payloadJson,
  resolutionJson: tasks.resolutionJson,
  resumeMarker: tasks.resumeMarker,
  resumeState: tasks.resumeState,
  resumeAttempts: tasks.resumeAttempts,
  resolutionRequestedAt: tasks.resolutionRequestedAt,
  resumeDispatchedAt: tasks.resumeDispatchedAt,
  resumeAcknowledgedAt: tasks.resumeAcknowledgedAt,
  resumeError: tasks.resumeError,
};

export async function listOpenTasks(
  tenantSlug: string,
  opts: { limit?: number } = {},
): Promise<TaskRow[]> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return [];
  return db
    .select(TASK_COLS)
    .from(tasks)
    .where(
      and(
        eq(tasks.tenantId, tenantId),
        inArray(tasks.status, ["open", "resolving"]),
        isNull(tasks.deletedAt),
      ),
    )
    .orderBy(desc(tasks.createdAt))
    .limit(opts.limit ?? 20)
    .all();
}

export async function listAllTasks(
  tenantSlug: string,
  opts: { limit?: number } = {},
): Promise<TaskRow[]> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return [];
  return db
    .select(TASK_COLS)
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), isNull(tasks.deletedAt)))
    .orderBy(desc(tasks.createdAt))
    .limit(opts.limit ?? 100)
    .all();
}

export async function getTask(
  tenantSlug: string,
  taskId: string,
): Promise<TaskRow | null> {
  const db = getDb();
  const tenantId = await resolveTenantId(tenantSlug);
  if (!tenantId) return null;
  const row = db
    .select(TASK_COLS)
    .from(tasks)
    .where(
      and(
        eq(tasks.tenantId, tenantId),
        eq(tasks.id, taskId),
        isNull(tasks.deletedAt),
      ),
    )
    .all()[0];
  return row ?? null;
}
