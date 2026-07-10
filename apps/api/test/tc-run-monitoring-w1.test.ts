/**
 * W1 — production run monitoring: server-side pagination + user-controlled
 * delete + recycle bin + permanent retention.
 *
 * Covers (route + query layer, hand-seeded rows so no live Inngest/LLM):
 *   - GET /v1/runs?page=&pageSize= → PaginatedRuns envelope, desc(startedAt),
 *     correct `total`, and the legacy bare-array shape still returned w/o page.
 *   - Soft-deleted runs are hidden from the list/detail (the latent
 *     `listRecentRuns` deleted_at bug this fixes) and reappear under ?deleted=1.
 *   - DELETE /v1/runs/:id soft-deletes (recoverable), refuses an in-flight run
 *     (409), is idempotent, and is cross-tenant safe (404).
 *   - POST /v1/runs/:id/restore un-tombstones.
 *   - DELETE /v1/runs?scope=oldest&n= / scope=all bulk soft-delete finished
 *     runs only; scope=purge empties the recycle bin.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { agents, getDb, runs, tenants, workflows } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

interface EnvelopeOk<T> {
  ok: true;
  data: T;
}

interface RunListRow {
  id: string;
  status: string;
  startedAt: string | null;
}
interface Paginated {
  rows: RunListRow[];
  total: number;
  page: number;
  pageSize: number;
}

const SUFFIX = `w1${Date.now().toString(36)}`.toLowerCase().slice(-8);
const TENANT_A = `w1a-${SUFFIX}`;
const TENANT_B = `w1b-${SUFFIX}`;

describe("W1: run monitoring pagination + delete + recycle bin", () => {
  let env: TestEnv;
  let tenantAId: string;
  let tenantBId: string;
  let agentAId: string;
  let agentBId: string;
  let savedDevTenant: string | undefined;

  // 5 finished runs (oldest→newest r0..r4) + 1 in-flight, all tenant A.
  const finishedIds: string[] = [];
  let runningId = "";
  let tenantBRunId = "";
  const base = Date.now() - 1_000_000;

  function seedRun(args: {
    tenantId: string;
    agentId: string;
    status: string;
    startedAt: number;
  }): string {
    const db = getDb();
    const id = makeId("run");
    db.insert(runs)
      .values({
        id,
        tenantId: args.tenantId,
        agentId: args.agentId,
        triggerEventId: null,
        status: args.status as never,
        startedAt: new Date(args.startedAt),
        endedAt: args.status === "running" ? null : new Date(args.startedAt + 1000),
        correlationId: makeId("cor"),
        subject: `subj-${SUFFIX}-${id.slice(-4)}`,
      })
      .run();
    return id;
  }

  beforeAll(async () => {
    env = await buildTestEnv();
    const db = getDb();

    tenantAId = makeId("ten");
    tenantBId = makeId("ten");
    db.insert(tenants)
      .values([
        { id: tenantAId, slug: TENANT_A, name: "W1 tenant A" },
        { id: tenantBId, slug: TENANT_B, name: "W1 tenant B" },
      ])
      .run();

    const mkAgent = (tenantId: string, kebab: string): string => {
      const wfId = makeId("wf");
      db.insert(workflows)
        .values({ id: wfId, tenantId, slug: `${kebab}-wf`, name: `${kebab} wf` })
        .run();
      const id = makeId("agt");
      db.insert(agents)
        .values({
          id,
          workflowId: wfId,
          kebabId: `${kebab}-${SUFFIX}`,
          name: `${kebab}Agent`,
          actor: "Agent",
          kind: "manifest",
          enabled: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
      return id;
    };
    agentAId = mkAgent(tenantAId, "w1a");
    agentBId = mkAgent(tenantBId, "w1b");

    for (let i = 0; i < 5; i++) {
      finishedIds.push(
        seedRun({ tenantId: tenantAId, agentId: agentAId, status: "ok", startedAt: base + i * 1000 }),
      );
    }
    runningId = seedRun({
      tenantId: tenantAId,
      agentId: agentAId,
      status: "running",
      startedAt: base + 9_000,
    });
    tenantBRunId = seedRun({
      tenantId: tenantBId,
      agentId: agentBId,
      status: "ok",
      startedAt: base + 500,
    });

    savedDevTenant = process.env.AGENTIC_DEV_TENANT;
    process.env.AGENTIC_DEV_TENANT = TENANT_A;
  });

  afterAll(() => {
    if (savedDevTenant === undefined) delete process.env.AGENTIC_DEV_TENANT;
    else process.env.AGENTIC_DEV_TENANT = savedDevTenant;
    getDb().delete(tenants).where(like(tenants.slug, `w1%-${SUFFIX}`)).run();
  });

  async function list(qs: string): Promise<Paginated> {
    const res = await env.fetch(`/v1/runs${qs}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnvelopeOk<Paginated>;
    return body.data;
  }

  it("paginates desc by startedAt with a correct total (6 live runs)", async () => {
    const p1 = await list("?page=1&pageSize=2");
    expect(p1.total).toBe(6); // 5 finished + 1 running
    expect(p1.page).toBe(1);
    expect(p1.pageSize).toBe(2);
    expect(p1.rows).toHaveLength(2);
    // newest first: the running run (base+9000) then finished r4 (base+4000).
    expect(p1.rows[0]!.id).toBe(runningId);
    expect(p1.rows[1]!.id).toBe(finishedIds[4]);

    const p3 = await list("?page=3&pageSize=2");
    expect(p3.rows).toHaveLength(2);
    expect(p3.rows.map((r) => r.id)).toEqual([finishedIds[1], finishedIds[0]]);
  });

  it("legacy bare-array shape is preserved when no page param", async () => {
    const res = await env.fetch(`/v1/runs?limit=50`);
    const body = (await res.json()) as EnvelopeOk<unknown>;
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("does not leak tenant B runs into tenant A", async () => {
    const p = await list("?page=1&pageSize=50");
    expect(p.rows.map((r) => r.id)).not.toContain(tenantBRunId);
  });

  it("soft-deletes a finished run: hidden from list, visible in recycle bin, restorable", async () => {
    const target = finishedIds[2]!;
    const del = await env.fetch(`/v1/runs/${target}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(((await del.json()) as EnvelopeOk<{ deleted: boolean }>).data.deleted).toBe(true);

    const live = await list("?page=1&pageSize=50");
    expect(live.total).toBe(5);
    expect(live.rows.map((r) => r.id)).not.toContain(target);

    // Detail 404s for a tombstoned run.
    expect((await env.fetch(`/v1/runs/${target}`)).status).toBe(404);

    // Recycle-bin lens surfaces it.
    const bin = await list("?deleted=1&page=1&pageSize=50");
    expect(bin.rows.map((r) => r.id)).toContain(target);

    // Restore.
    const res = await env.fetch(`/v1/runs/${target}/restore`, { method: "POST" });
    expect(((await res.json()) as EnvelopeOk<{ restored: boolean }>).data.restored).toBe(true);
    const back = await list("?page=1&pageSize=50");
    expect(back.total).toBe(6);
    expect(back.rows.map((r) => r.id)).toContain(target);
  });

  it("refuses to delete an in-flight run (409)", async () => {
    const res = await env.fetch(`/v1/runs/${runningId}`, { method: "DELETE" });
    expect(res.status).toBe(409);
    const db = getDb();
    const row = db.select().from(runs).where(eq(runs.id, runningId)).all()[0];
    expect(row?.deletedAt).toBeFalsy();
  });

  it("404s a cross-tenant delete without leaking existence", async () => {
    const res = await env.fetch(`/v1/runs/${tenantBRunId}`, { method: "DELETE" });
    expect(res.status).toBe(404);
    const db = getDb();
    const row = db.select().from(runs).where(eq(runs.id, tenantBRunId)).all()[0];
    expect(row?.deletedAt).toBeFalsy();
  });

  it("bulk scope=oldest tombstones exactly the N oldest finished runs", async () => {
    const res = await env.fetch(`/v1/runs?scope=oldest&n=2`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as EnvelopeOk<{ scope: string; deleted: number }>;
    expect(body.data.scope).toBe("oldest");
    expect(body.data.deleted).toBe(2);
    // The two oldest finished (r0, r1) are gone; the running one is untouched.
    const live = await list("?page=1&pageSize=50");
    const ids = live.rows.map((r) => r.id);
    expect(ids).not.toContain(finishedIds[0]);
    expect(ids).not.toContain(finishedIds[1]);
    expect(ids).toContain(runningId);
  });

  it("bulk scope=all tombstones remaining finished runs but never the in-flight one", async () => {
    const res = await env.fetch(`/v1/runs?scope=all`, { method: "DELETE" });
    const body = (await res.json()) as EnvelopeOk<{ deleted: number }>;
    expect(res.status).toBe(200);
    // 3 finished remained (r2,r3,r4 after oldest-2 removed).
    expect(body.data.deleted).toBe(3);
    const live = await list("?page=1&pageSize=50");
    expect(live.total).toBe(1);
    expect(live.rows[0]!.id).toBe(runningId);
  });

  it("purge empties the recycle bin (hard delete)", async () => {
    const before = await list("?deleted=1&page=1&pageSize=50");
    expect(before.total).toBe(5); // 2 oldest + 3 all
    const res = await env.fetch(`/v1/runs?scope=purge`, { method: "DELETE" });
    const body = (await res.json()) as EnvelopeOk<{ deleted: number }>;
    expect(body.data.deleted).toBe(5);
    const after = await list("?deleted=1&page=1&pageSize=50");
    expect(after.total).toBe(0);
    // Hard-deleted rows are really gone.
    const db = getDb();
    const gone = db.select().from(runs).where(and(eq(runs.tenantId, tenantAId), eq(runs.status, "ok"))).all();
    expect(gone).toHaveLength(0);
  });
});
