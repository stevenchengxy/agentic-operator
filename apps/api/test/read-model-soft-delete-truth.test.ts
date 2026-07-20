import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  agents,
  events,
  getDb,
  llmTurns,
  runs,
  tasks,
  tenants,
  workflows,
} from "@agentic/db";
import { getRecentActivity } from "../src/queries/activity";
import { listAgentRuns, listAgents } from "../src/queries/agents";
import { getTenantCounts } from "../src/queries/counts";
import { fetchCausality, getEventDetail } from "../src/queries/events";
import { listRecentTurns } from "../src/queries/reasoning-feed";
import { getTask, listAllTasks, listOpenTasks } from "../src/queries/tasks";
import { getThroughput } from "../src/queries/throughput";
import { getDag } from "../src/queries/workflows";

function fixture() {
  const db = getDb();
  const tenant = db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, "raas"))
    .all()[0];
  if (!tenant) throw new Error("raas test tenant is missing");
  const agent = db
    .select({ id: agents.id, kebabId: agents.kebabId })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .where(eq(workflows.tenantId, tenant.id))
    .all()[0];
  if (!agent) throw new Error("raas test agent is missing");
  return {
    db,
    tenantId: tenant.id,
    agentId: agent.id,
    agentKebabId: agent.kebabId,
  };
}

function suffix(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

describe("soft-delete truth across read models", () => {
  it("keeps tombstoned runs, events, and tasks out of operational telemetry", async () => {
    const { db, tenantId, agentId, agentKebabId } = fixture();
    const id = suffix();
    const runId = `run-soft-read-${id}`;
    const eventId = `evt-soft-read-${id}`;
    const taskId = `tsk-soft-read-${id}`;
    const now = new Date();

    const countsBefore = await getTenantCounts("raas");
    const agentBefore = (await listAgents("raas")).find(
      (row) => row.id === agentId,
    );
    expect(agentBefore).toBeDefined();
    const throughputBefore = (await getThroughput("raas", "24h")).agents.find(
      (row) => row.kebabId === agentKebabId,
    );
    const dagBefore = (await getDag("raas")).agents.find(
      (row) => row.id === agentId,
    );

    db.insert(runs)
      .values({
        id: runId,
        tenantId,
        agentId,
        status: "failed",
        startedAt: now,
        endedAt: now,
        correlationId: `corr-${id}`,
        subject: `deleted-subject-${id}`,
        errorMessage: "intentional tombstone fixture",
        deletedAt: now,
        isTest: false,
      })
      .run();
    db.insert(events)
      .values({
        id: eventId,
        tenantId,
        name: `SOFT_DELETED_EVENT_${id}`,
        receivedAt: now,
        deletedAt: now,
      })
      .run();
    db.insert(tasks)
      .values({
        id: taskId,
        tenantId,
        type: "soft-delete-test",
        title: `soft deleted task ${id}`,
        status: "open",
        createdAt: now,
        deletedAt: now,
      })
      .run();

    try {
      expect(await getTenantCounts("raas")).toEqual(countsBefore);

      const agentAfter = (await listAgents("raas")).find(
        (row) => row.id === agentId,
      );
      expect(agentAfter?.runCount).toBe(agentBefore!.runCount);
      expect(agentAfter?.errorCount).toBe(agentBefore!.errorCount);
      expect((await listAgentRuns("raas", agentId, 200)).some((r) => r.id === runId)).toBe(false);

      const throughputAfter = (await getThroughput("raas", "24h")).agents.find(
        (row) => row.kebabId === agentKebabId,
      );
      expect(throughputAfter).toEqual(throughputBefore);
      const dagAfter = (await getDag("raas")).agents.find(
        (row) => row.id === agentId,
      );
      expect(dagAfter?.recentRunCount).toBe(dagBefore?.recentRunCount);
      expect(dagAfter?.isLive).toBe(dagBefore?.isLive);

      const activity = await getRecentActivity("raas", 5000, {
        includeAudit: true,
        includeFileLogs: true,
      });
      expect(activity.some((row) => "runId" in row && row.runId === runId)).toBe(false);
      expect(activity.some((row) => "eventId" in row && row.eventId === eventId)).toBe(false);
      expect(activity.some((row) => "taskId" in row && row.taskId === taskId)).toBe(false);

      expect((await listOpenTasks("raas", { limit: 500 })).some((t) => t.id === taskId)).toBe(false);
      expect((await listAllTasks("raas", { limit: 500 })).some((t) => t.id === taskId)).toBe(false);
      expect(await getTask("raas", taskId)).toBeNull();
    } finally {
      db.delete(tasks).where(eq(tasks.id, taskId)).run();
      db.delete(runs).where(eq(runs.id, runId)).run();
      db.delete(events).where(eq(events.id, eventId)).run();
    }
  });

  it("does not resurrect tombstoned events or consumers through detail and causality", async () => {
    const { db, tenantId, agentId } = fixture();
    const id = suffix();
    const deletedEventId = `evt-soft-seed-${id}`;
    const visibleEventId = `evt-visible-seed-${id}`;
    const deletedRunId = `run-soft-consumer-${id}`;
    const now = new Date();

    db.insert(events)
      .values([
        {
          id: deletedEventId,
          tenantId,
          name: `SOFT_DELETED_SEED_${id}`,
          receivedAt: now,
          deletedAt: now,
        },
        {
          id: visibleEventId,
          tenantId,
          name: `VISIBLE_SEED_${id}`,
          receivedAt: now,
        },
      ])
      .run();
    db.insert(runs)
      .values({
        id: deletedRunId,
        tenantId,
        agentId,
        triggerEventId: visibleEventId,
        status: "ok",
        startedAt: now,
        endedAt: now,
        correlationId: `corr-consumer-${id}`,
        deletedAt: now,
        isTest: true,
      })
      .run();

    try {
      expect(await getEventDetail("raas", deletedEventId)).toBeNull();
      expect((await fetchCausality("raas", deletedEventId)).events).toEqual([]);

      const detail = await getEventDetail("raas", visibleEventId);
      expect(detail).not.toBeNull();
      expect(detail?.consumers).toEqual([]);
      expect((await fetchCausality("raas", visibleEventId)).runs).toEqual([]);
    } finally {
      db.delete(runs).where(eq(runs.id, deletedRunId)).run();
      db.delete(events)
        .where(and(eq(events.tenantId, tenantId), eq(events.id, deletedEventId)))
        .run();
      db.delete(events)
        .where(and(eq(events.tenantId, tenantId), eq(events.id, visibleEventId)))
        .run();
    }
  });

  it("excludes LLM turns whose owning run is in the recycle bin", () => {
    const { db, tenantId, agentId } = fixture();
    const id = suffix();
    const runId = `run-soft-turn-${id}`;
    const turnId = `turn-soft-${id}`;
    const now = new Date();

    db.insert(runs)
      .values({
        id: runId,
        tenantId,
        agentId,
        status: "ok",
        startedAt: now,
        endedAt: now,
        correlationId: `corr-turn-${id}`,
        deletedAt: now,
        isTest: true,
      })
      .run();
    db.insert(llmTurns)
      .values({
        id: turnId,
        tenantId,
        runId,
        ord: 0,
        responseText: "tombstoned reasoning fixture",
        createdAt: now,
      })
      .run();

    try {
      expect(listRecentTurns("raas", { limit: 200 }).some((row) => row.id === turnId)).toBe(false);
    } finally {
      db.delete(runs).where(eq(runs.id, runId)).run();
    }
  });
});
