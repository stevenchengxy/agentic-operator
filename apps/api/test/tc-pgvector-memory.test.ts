import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { createMemoryHandle, setMemoryDriver, createLocalVectorDriver, getMemoryDriver } from "@agentic/runtime";
import { getDb, tenants } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { wirePgVectorMemory, stopPgVectorMemory, memoryDriverStatus } from "../src/services/memory-pgvector";

// #SCALE-PGVECTOR — REAL integration test against the `agentic-pgvector` docker container
// (pgvector/pgvector:pg17 on :5434). Skips cleanly when the container isn't running, so CI/dev
// without docker stays green. SQLite remains system of record; pg carries the HNSW vector index.

const URL = process.env.AGENTIC_PGVECTOR_URL ?? "postgres://agentic:agentic_local_pw@localhost:5434/agentic";

async function probe(): Promise<boolean> {
  const p = new Pool({ connectionString: URL, connectionTimeoutMillis: 1_500, max: 1 });
  try {
    await p.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await p.end().catch(() => {});
  }
}
const available = await probe();

describe.runIf(available)("pgvector memory driver (live container)", () => {
  const sql = new Pool({ connectionString: URL, max: 2 });
  const T = "agent_memory_vectors";

  beforeAll(async () => {
    process.env.AGENTIC_PGVECTOR_URL = URL;
    expect(await wirePgVectorMemory()).toBe(true);
    expect(memoryDriverStatus()).toBe("pgvector");
    await sql.query(`TRUNCATE ${T}`);
  });

  afterAll(async () => {
    await sql.query(`TRUNCATE ${T}`).catch(() => {});
    await sql.end();
    await stopPgVectorMemory();
    setMemoryDriver(createLocalVectorDriver()); // leave the process on the local driver
    delete process.env.AGENTIC_PGVECTOR_URL;
  });

  it("mirrors rows and ranks semantic matches (HNSW cosine)", async () => {
    const drv = getMemoryDriver()!;
    await drv.mirror!({ tenantId: "tA", agentName: "matcher", subject: "s1", key: "match-note", valueJson: JSON.stringify({ note: "候选人简历匹配评分 87 分,通过匹配规则" }) });
    await drv.mirror!({ tenantId: "tA", agentName: "matcher", subject: "s2", key: "jd-note", valueJson: JSON.stringify({ note: "JD 岗位描述模板已生成" }) });
    await drv.mirror!({ tenantId: "tA", agentName: "matcher", subject: "s3", key: "misc", valueJson: JSON.stringify({ note: "today weather sunny" }) });

    const hits = await drv.search("简历匹配评分", 3, { tenantId: "tA", agentName: "matcher" });
    expect(hits.length).toBe(3);
    expect((hits[0]!.meta as { key: string }).key).toBe("match-note"); // semantic top-1
    expect(hits[0]!.score).toBeGreaterThan(hits[2]!.score);
    // cross-subject recall within (tenant, agent): s1/s2/s3 all visible
    const subjects = hits.map((h) => (h.meta as { subject: string }).subject).sort();
    expect(subjects).toEqual(["s1", "s2", "s3"]);
  });

  it("isolates tenants and filters expired rows", async () => {
    const drv = getMemoryDriver()!;
    await drv.mirror!({ tenantId: "tB", agentName: "matcher", subject: "s1", key: "b-secret", valueJson: JSON.stringify({ note: "tenant B 简历匹配秘密" }) });
    await drv.mirror!({ tenantId: "tA", agentName: "matcher", subject: "s1", key: "expired", valueJson: JSON.stringify({ note: "过期的简历匹配记录" }), expiresAt: new Date(Date.now() - 60_000) });

    const hits = await drv.search("简历匹配", 10, { tenantId: "tA", agentName: "matcher" });
    const keys = hits.map((h) => (h.meta as { key: string }).key);
    expect(keys).not.toContain("b-secret"); // tenant isolation
    expect(keys).not.toContain("expired"); // TTL honored at query time
  });

  it("deleteMirror keeps the index in sync", async () => {
    const drv = getMemoryDriver()!;
    await drv.deleteMirror!({ tenantId: "tA", agentName: "matcher", subject: "s3", key: "misc" });
    const { rows } = await sql.query(`SELECT count(*)::int AS n FROM ${T} WHERE key='misc'`);
    expect(rows[0]!.n).toBe(0);
  });

  it("full path: ctx.memory.put() write-through-mirrors into pg, search() serves from pg", async () => {
    // SQLite (system of record) enforces the tenant FK — bind the handle to a REAL tenant row.
    const tenantId = makeId("ten");
    getDb().insert(tenants).values({ id: tenantId, slug: `pgvec-${tenantId.slice(-6)}`, name: "pgvec e2e" }).run();
    const handle = createMemoryHandle({ tenantId, agentName: "pgvec-e2e", subject: "cand-1", runId: "run-pgvec-e2e" });
    await handle.put("interview-pref", { note: "候选人偏好下午面试,时区 UTC+8" }, "subject");
    // put() only resolves after the pgvector mirror acknowledges the row.
    const { rows } = await sql.query(`SELECT count(*)::int AS n FROM ${T} WHERE key='interview-pref'`);
    expect(rows[0]!.n).toBe(1);

    const hits = await handle.search("面试时间偏好", 3);
    expect(hits.some((h) => (h.meta as { key: string }).key === "interview-pref")).toBe(true);

    await handle.delete("interview-pref", "subject");
    const after = await sql.query(`SELECT count(*)::int AS n FROM ${T} WHERE key='interview-pref'`);
    expect(after.rows[0]!.n).toBe(0);
  });
});

describe.runIf(!available)("pgvector container unavailable", () => {
  it.skip("skipped — start it with: docker start agentic-pgvector", () => {});
});
