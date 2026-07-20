import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  agents,
  getDb,
  memberships,
  runs,
  tenants,
  users,
  workflows,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

describe("per-run log stream truth and confinement", () => {
  let env: TestEnv;
  let root: string;
  const originalRoot = process.env.AGENTIC_LOGS_DIR;
  const tenantId = makeId("ten");
  const tenantSlug = `run-log-${makeId("tag").slice(-8)}`;
  const agentId = makeId("agt");
  const safeRunId = makeId("run");
  const missingRunId = makeId("run");
  const poisonedRunId = makeId("run");

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "agentic-api-run-log-"));
    process.env.AGENTIC_LOGS_DIR = root;
    env = await buildTestEnv();
    const db = getDb();
    const operator = db
      .select({ id: users.id })
      .from(users)
      .where(
        eq(
          users.email,
          process.env.AGENTIC_DEV_USER_EMAIL ?? "test-platform-admin@agentic.invalid",
        ),
      )
      .all()[0]!;
    const workflowId = makeId("wf");
    const now = new Date();
    db.insert(tenants)
      .values({ id: tenantId, slug: tenantSlug, name: tenantSlug })
      .run();
    db.insert(memberships)
      .values({ userId: operator.id, tenantId, role: "admin" })
      .run();
    db.insert(workflows)
      .values({
        id: workflowId,
        tenantId,
        slug: "run-log-test",
        name: "Run log test",
      })
      .run();
    db.insert(agents)
      .values({
        id: agentId,
        workflowId,
        kebabId: "runLogAgent",
        name: "runLogAgent",
        title: "Run Log Agent",
        actor: "Agent",
        kind: "code",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const safePath = path.join(
      root,
      tenantSlug,
      "runs",
      "2026-07-13",
      `${safeRunId}.log`,
    );
    await mkdir(path.dirname(safePath), { recursive: true });
    await writeFile(safePath, "alpha\nbeta\n", "utf8");
    const common = {
      tenantId,
      agentId,
      status: "ok" as const,
      startedAt: new Date("2026-07-13T00:00:00.000Z"),
      endedAt: new Date("2026-07-13T00:00:01.000Z"),
      durationMs: 1_000,
      correlationId: makeId("cor"),
    };
    db.insert(runs)
      .values([
        { ...common, id: safeRunId, logPath: safePath },
        {
          ...common,
          id: missingRunId,
          logPath: path.join(
            root,
            tenantSlug,
            "runs",
            "2026-07-13",
            `${missingRunId}.log`,
          ),
        },
        {
          ...common,
          id: poisonedRunId,
          logPath: path.join(root, "another-tenant", "secret.log"),
        },
      ])
      .run();
  });

  afterAll(async () => {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
    if (originalRoot == null) delete process.env.AGENTIC_LOGS_DIR;
    else process.env.AGENTIC_LOGS_DIR = originalRoot;
    await rm(root, { recursive: true, force: true });
  });

  it("returns 404 for a missing one-shot log instead of fake empty success", async () => {
    const res = await env.fetch(`/v1/runs/${missingRunId}/logs`, {
      headers: { "x-agentic-tenant": tenantSlug },
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "log_not_found" },
    });
  });

  it("rejects a persisted log path outside the authenticated tenant root", async () => {
    const res = await env.fetch(`/v1/runs/${poisonedRunId}/logs`, {
      headers: { "x-agentic-tenant": tenantSlug },
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_log_path" },
    });
  });

  it("uses exact byte cursors and does not replay already acknowledged lines", async () => {
    const res = await env.fetch(`/v1/runs/${safeRunId}/logs?cursor=6`, {
      headers: { "x-agentic-tenant": tenantSlug },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("data: alpha");
    expect(body).toContain("data: beta");
    expect(body).toContain("id: 11");
    expect(body).toContain("event: end");
  });
});
