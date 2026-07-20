import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMemoryHandle,
  getMemoryDriver,
  setMemoryDriver,
} from "@agentic/runtime";
import type { MemoryDriver } from "@agentic/agent-sdk";
import { agentMemoryLong, getDb, tenants } from "@agentic/db";
import { and, eq } from "drizzle-orm";
import { makeId } from "@agentic/shared";
import {
  createPgVectorMemoryDriver,
  PgVectorOperationError,
  type PgPoolLike,
} from "../src/services/memory-pgvector";
import { buildTestEnv } from "./harness";

class InjectedOutagePool implements PgPoolLike {
  calls = 0;

  async query(): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.calls += 1;
    throw new Error("injected pgvector outage");
  }

  async end(): Promise<void> {}
}

describe("configured pgvector fails closed", () => {
  let originalDriver: MemoryDriver | null | undefined;
  let tenantId: string | undefined;
  const pool = new InjectedOutagePool();

  beforeAll(async () => {
    await buildTestEnv();
    originalDriver = getMemoryDriver();
    tenantId = makeId("ten");
    getDb().insert(tenants).values({
      id: tenantId,
      slug: `pgvector-failure-${tenantId}`,
      name: "pgvector failure injection",
    }).run();
    setMemoryDriver(createPgVectorMemoryDriver(pool));
  });

  afterAll(() => {
    setMemoryDriver(originalDriver ?? null);
    if (tenantId) {
      getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
    }
  });

  it("propagates search outage instead of returning local or empty results", async () => {
    const handle = createMemoryHandle({
      tenantId: tenantId!,
      agentName: "strict-memory",
      subject: "subject-1",
      runId: "run-pgvector-failure",
    });

    await expect(handle.search("真实召回", 5)).rejects.toMatchObject({
      name: "PgVectorOperationError",
      code: "pgvector_operation_failed",
      operation: "search",
    });
    expect(pool.calls).toBe(1);
  });

  it("propagates mirror outage so a write is never reported as fully indexed", async () => {
    const handle = createMemoryHandle({
      tenantId: tenantId!,
      agentName: "strict-memory",
      subject: "subject-1",
      runId: "run-pgvector-failure",
    });

    const error = await handle.put("candidate", { score: 91 }, "subject")
      .then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(PgVectorOperationError);
    expect(error).toMatchObject({
      code: "pgvector_operation_failed",
      operation: "mirror",
    });

    // SQLite is still the authoritative, retryable KV record, but the caller
    // received a failure and therefore cannot mistake it for indexed success.
    const row = getDb().select().from(agentMemoryLong).where(and(
      eq(agentMemoryLong.tenantId, tenantId!),
      eq(agentMemoryLong.agentName, "strict-memory"),
      eq(agentMemoryLong.subject, "subject-1"),
      eq(agentMemoryLong.key, "candidate"),
    )).all()[0];
    expect(row?.valueJson).toBe(JSON.stringify({ score: 91 }));
  });

  it("propagates delete-index outage instead of reporting synchronized deletion", async () => {
    const handle = createMemoryHandle({
      tenantId: tenantId!,
      agentName: "strict-memory",
      subject: "subject-1",
      runId: "run-pgvector-failure",
    });

    await expect(handle.delete("candidate", "subject")).rejects.toMatchObject({
      code: "pgvector_operation_failed",
      operation: "delete",
    });
  });
});
