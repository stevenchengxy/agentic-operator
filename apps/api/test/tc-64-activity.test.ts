/**
 * TC-64 — GET /v1/activity (live-terminal backfill).
 *
 * Reconstructs the recent lifecycle (runs / steps / events / tasks) as a
 * chronological RunStreamEvent[] so the Logs → terminal can seed from history
 * instead of starting empty. Asserts shape, ordering, the limit clamp, and
 * that every record is a valid discriminated-union member.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { agents, getDb, runs, steps, tenants, workflows } from "@agentic/db";
import { buildTestEnv, type TestEnv } from "./harness";

interface OkEnvelope<T> {
  ok: true;
  data: T;
}

interface StreamEvent {
  type: string;
  at: number;
  tenantId: string;
  runId?: string;
  correlationId?: string;
  agentName?: string | null;
  message?: string;
  fields?: Record<string, unknown>;
}

const KNOWN_TYPES = new Set([
  "run.started",
  "run.step.started",
  "run.step.completed",
  "run.completed",
  "run.failed",
  "run.cancelled",
  "event.emitted",
  "task.created",
  "task.resolved",
  "deployment.created",
  "log.line",
  "audit.recorded",
  "llm.call.completed",
  "tool.call.completed",
]);

describe("TC-64: GET /v1/activity", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await buildTestEnv();
  });

  it("returns a chronological RunStreamEvent[] (ascending by at)", async () => {
    const res = await env.fetch("/v1/activity", {
      headers: { "x-agentic-tenant": "raas" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkEnvelope<StreamEvent[]>;
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);

    let prev = -Infinity;
    for (const ev of body.data) {
      expect(KNOWN_TYPES.has(ev.type)).toBe(true);
      expect(typeof ev.at).toBe("number");
      expect(typeof ev.tenantId).toBe("string");
      expect(ev.at).toBeGreaterThanOrEqual(prev); // ascending
      prev = ev.at;
    }
  });

  it("honours the limit clamp", async () => {
    const res = await env.fetch("/v1/activity?limit=5", {
      headers: { "x-agentic-tenant": "raas" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkEnvelope<StreamEvent[]>;
    expect(body.data.length).toBeLessThanOrEqual(5);
  });

  it("defaults gracefully on a bogus limit", async () => {
    const res = await env.fetch("/v1/activity?limit=notanumber", {
      headers: { "x-agentic-tenant": "raas" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkEnvelope<StreamEvent[]>;
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("backfills tool calls with their real agent and correlation id", async () => {
    const db = getDb();
    const tenant = db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "raas"))
      .all()[0];
    expect(tenant).toBeDefined();
    const agent = db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .innerJoin(workflows, eq(workflows.id, agents.workflowId))
      .where(eq(workflows.tenantId, tenant!.id))
      .all()[0];
    expect(agent).toBeDefined();

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runId = `run-activity-tool-${suffix}`;
    const stepId = `step-activity-tool-${suffix}`;
    const correlationId = `corr-activity-tool-${suffix}`;
    const now = new Date();

    db.insert(runs)
      .values({
        id: runId,
        tenantId: tenant!.id,
        agentId: agent!.id,
        status: "ok",
        startedAt: new Date(now.getTime() - 10),
        endedAt: now,
        durationMs: 10,
        correlationId,
        isTest: true,
      })
      .run();
    db.insert(steps)
      .values({
        id: stepId,
        runId,
        ord: 1,
        name: "records.lookup",
        type: "tool",
        status: "ok",
        startedAt: new Date(now.getTime() - 5),
        endedAt: now,
        durationMs: 5,
      })
      .run();

    try {
      const res = await env.fetch("/v1/activity?limit=50", {
        headers: { "x-agentic-tenant": "raas" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkEnvelope<StreamEvent[]>;
      const toolCall = body.data.find(
        (event) =>
          event.type === "tool.call.completed" && event.runId === runId,
      );
      expect(toolCall).toMatchObject({
        correlationId,
        agentName: agent!.name,
      });
    } finally {
      db.delete(runs).where(eq(runs.id, runId)).run();
    }
  });

  it("backfills exact persisted file log lines after a terminal refresh", async () => {
    const db = getDb();
    const tenant = db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "raas"))
      .all()[0];
    expect(tenant).toBeDefined();
    const agent = db
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(workflows, eq(workflows.id, agents.workflowId))
      .where(eq(workflows.tenantId, tenant!.id))
      .all()[0];
    expect(agent).toBeDefined();

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runId = `run-activity-log-${suffix}`;
    const correlationId = `corr-activity-log-${suffix}`;
    const now = new Date();
    const logPath = path.join(
      process.env.AGENTIC_LOGS_DIR!,
      "raas",
      "runs",
      `${runId}.log`,
    );
    const line = `${now.toISOString()}  INFO   run.start  run_id=${runId} correlation_id=${correlationId} agent=activity-test test_run=true`;
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, `${line}\n`, "utf8");
    db.insert(runs)
      .values({
        id: runId,
        tenantId: tenant!.id,
        agentId: agent!.id,
        status: "ok",
        startedAt: new Date(now.getTime() - 1),
        endedAt: now,
        durationMs: 1,
        correlationId,
        isTest: true,
        logPath,
      })
      .run();

    try {
      const res = await env.fetch("/v1/activity?limit=50", {
        headers: { "x-agentic-tenant": "raas" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkEnvelope<StreamEvent[]>;
      const persisted = body.data.find(
        (event) => event.type === "log.line" && event.runId === runId,
      );
      expect(persisted).toMatchObject({
        correlationId,
        message: line,
        fields: {
          run_id: runId,
          correlation_id: correlationId,
          persisted: true,
        },
      });
    } finally {
      db.delete(runs).where(eq(runs.id, runId)).run();
      await rm(logPath, { force: true });
    }
  });

  it("skips a retained log path outside the configured tenant root", async () => {
    const db = getDb();
    const tenant = db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "raas"))
      .all()[0];
    expect(tenant).toBeDefined();
    const agent = db
      .select({ id: agents.id })
      .from(agents)
      .innerJoin(workflows, eq(workflows.id, agents.workflowId))
      .where(eq(workflows.tenantId, tenant!.id))
      .all()[0];
    expect(agent).toBeDefined();

    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const runId = `run-activity-rejected-log-${suffix}`;
    const outsidePath = path.join(
      process.env.AGENTIC_DATA_ROOT!,
      `outside-tenant-log-${suffix}.log`,
    );
    const forbiddenLine = `${new Date().toISOString()}  INFO   forbidden.read  run_id=${runId}`;
    await writeFile(outsidePath, `${forbiddenLine}\n`, "utf8");
    db.insert(runs)
      .values({
        id: runId,
        tenantId: tenant!.id,
        agentId: agent!.id,
        status: "ok",
        startedAt: new Date(),
        endedAt: new Date(),
        durationMs: 1,
        correlationId: `corr-${suffix}`,
        isTest: true,
        logPath: outsidePath,
      })
      .run();

    try {
      const res = await env.fetch("/v1/activity?limit=5000", {
        headers: { "x-agentic-tenant": "raas" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as OkEnvelope<StreamEvent[]>;
      expect(body.data.some((event) => event.message === forbiddenLine)).toBe(
        false,
      );
    } finally {
      db.delete(runs).where(eq(runs.id, runId)).run();
      await rm(outsidePath, { force: true });
    }
  });
});
