import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { agents, auditLog, getDb, runs, tenants, workflows } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { reconcileOrphanedRuns } from "../src/services/reconcile-runs";

const suffix = Date.now().toString(36);
const tenantId = makeId("ten");
const runStatuses = ["queued", "waiting", "running"] as const;
const runIds = new Map<(typeof runStatuses)[number], string>();
let previousTimeout: string | undefined;

describe("orphan reconciliation audit truth", () => {
  beforeAll(() => {
    previousTimeout = process.env.AGENTIC_RUN_TIMEOUT_MS;
    // Make the fixture the only plausible orphan in the shared test snapshot.
    // Its 1970 start still exceeds this ten-year timeout.
    process.env.AGENTIC_RUN_TIMEOUT_MS = "315360000000";

    const db = getDb();
    db.insert(tenants)
      .values({
        id: tenantId,
        slug: `reconcile-truth-${suffix}`,
        name: "Reconcile truth",
      })
      .run();

    const workflowId = makeId("wf");
    db.insert(workflows)
      .values({
        id: workflowId,
        tenantId,
        slug: "reconcile-truth",
        name: "Reconcile truth",
      })
      .run();

    const agentId = makeId("agt");
    const now = new Date();
    db.insert(agents)
      .values({
        id: agentId,
        workflowId,
        kebabId: "reconcile-truth",
        name: "reconcileTruth",
        actor: "Agent",
        kind: "manifest",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    for (const status of runStatuses) {
      const id = makeId("run");
      runIds.set(status, id);
      db.insert(runs)
        .values({
          id,
          tenantId,
          agentId,
          status,
          startedAt: new Date(1),
          correlationId: makeId("cor"),
        })
        .run();
    }
  });

  afterAll(() => {
    if (previousTimeout === undefined)
      delete process.env.AGENTIC_RUN_TIMEOUT_MS;
    else process.env.AGENTIC_RUN_TIMEOUT_MS = previousTimeout;
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("records each run's actual pre-transition status", async () => {
    const expectedIds = [...runIds.values()];
    const result = await reconcileOrphanedRuns();

    expect(result.reaped).toBe(runStatuses.length);
    expect(new Set(result.ids)).toEqual(new Set(expectedIds));

    const db = getDb();
    const transitioned = db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(inArray(runs.id, expectedIds))
      .all();
    expect(transitioned).toHaveLength(runStatuses.length);
    expect(transitioned.every((row) => row.status === "failed")).toBe(true);

    const audits = db
      .select({ targetId: auditLog.targetId, meta: auditLog.metaJson })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.action, "run.reconcile.timeout"),
          inArray(auditLog.targetId, expectedIds),
        ),
      )
      .all();
    expect(audits).toHaveLength(runStatuses.length);

    const previousByRun = new Map(
      audits.map((row) => [
        row.targetId,
        (row.meta as { previousStatus?: unknown } | null)?.previousStatus,
      ]),
    );
    for (const [status, id] of runIds) {
      expect(previousByRun.get(id)).toBe(status);
    }
  });
});
